import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const wahaBase = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const wahaKey = Deno.env.get("WAHA_API_KEY") || "";

/** digits-only contact key */
function normalizeKey(raw: string): string {
  return String(raw || "").split("@")[0].replace(/\D/g, "");
}

/** Robust PostgreSQL / ISO-8601 timestamp parser that handles timezone offsets like +00 */
function parsePgTimestamp(raw: string | number | null | undefined): number {
  if (!raw) return NaN;
  let s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  s = s.replace(" ", "T");
  // Normalize "+00" or "+05" timezone offsets to "+00:00" or "+05:00"
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  const t = new Date(s).getTime();
  if (!isNaN(t)) return t;
  const fallback = Date.parse(String(raw));
  return isNaN(fallback) ? NaN : fallback;
}

/** Quickly probe WAHA to see if session is WORKING before processing contacts */
async function isSessionWorking(sessionName: string): Promise<boolean> {
  if (!wahaBase || !wahaKey || !sessionName) return true;
  try {
    const res = await fetch(`${wahaBase}/api/sessions/${sessionName}`, {
      headers: { "X-Api-Key": wahaKey },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) {
      console.warn(`[send-followups] Session ${sessionName} status probe returned HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    const status = String(data?.status || "").toUpperCase();
    const isWorking = status === "WORKING";
    if (!isWorking) {
      console.warn(`[send-followups] Session ${sessionName} is not WORKING (current status: ${data?.status})`);
    }
    return isWorking;
  } catch (e) {
    console.warn(`[send-followups] Session probe error for ${sessionName}:`, (e as Error).message);
    return true; // fail-open to let send-whatsapp try if probe had a transient network glitch
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const schema = Deno.env.get("SUPABASE_SCHEMA") || "via_clothing";
  const supabase = createClient(supabaseUrl, serviceKey, { db: { schema } });

  const summary: Record<string, unknown>[] = [];

  try {
    // 1. Users that have the inactivity follow-up configured
    const { data: settingsRows, error: sErr } = await supabase
      .from("settings")
      .select("user_id, value, updated_at")
      .eq("key", "inactivity_followup");

    if (sErr) throw sErr;

    for (const row of settingsRows || []) {
      const cfg = (row.value || {}) as { enabled?: boolean; text?: string; hours?: number; enabled_at?: string };
      if (!cfg.enabled || !cfg.text?.trim()) continue;
      const hours = Number(cfg.hours);
      if (!Number.isFinite(hours) || hours <= 0) continue;

      const userId = row.user_id as string;
      const cfgEnabledAt = cfg.enabled_at;
      const rawEnabledAt = cfgEnabledAt || row.updated_at;
      const enabledAtTime = rawEnabledAt ? parsePgTimestamp(rawEnabledAt) : 0;
      const safeEnabledAtTime = isNaN(enabledAtTime) ? 0 : enabledAtTime;

      // 2. Growth plan only
      const { data: profile } = await supabase
        .from("profiles")
        .select("plan_tier, is_paused, is_active")
        .eq("user_id", userId)
        .maybeSingle();
      if (!profile || profile.plan_tier !== "enterprise" || profile.is_paused || profile.is_active === false) continue;

      // 3. Session to send from
      const { data: session } = await supabase
        .from("user_wsender_sessions")
        .select("session_api_key")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const sessionApiKey = session?.session_api_key;
      if (!sessionApiKey) continue;

      // 4. Probe session health before doing heavy conversation aggregation
      const sessionReady = await isSessionWorking(sessionApiKey);
      if (!sessionReady) {
        console.warn(`[send-followups] Skipping user ${userId} because session ${sessionApiKey} is not working.`);
        continue;
      }

      // 1. Calculate active inactivity window with an expiry grace buffer
      // Customers who stopped talking between [now - (hours + graceHours)] and [now - hours] are eligible.
      // Anyone older than (hours + graceHours) has EXPIRED their inactivity window (e.g. chats from yesterday or days ago).
      // This strictly prevents backlog bursts and ensures stale customers are NEVER messaged.
      const graceHours = Math.min(Math.max(hours * 0.5, 1), 2);
      const maxIdleCutoff = Date.now() - hours * 3600 * 1000; // customer must have been idle at least `hours`
      const minIdleCutoff = Date.now() - (hours + graceHours) * 3600 * 1000; // customer cannot have been idle longer than `hours + graceHours`

      // Bound query strictly to the active window (or enabledAtTime, whichever is newer)
      const effectiveWindowStartMs = safeEnabledAtTime > 0
        ? Math.max(minIdleCutoff, safeEnabledAtTime)
        : minIdleCutoff;
      const windowStart = new Date(effectiveWindowStartMs).toISOString();

      const { data: convs } = await supabase
        .from("conversations")
        .select("phone_number, direction, created_at, metadata")
        .eq("user_id", userId)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: false }) // NEWEST FIRST
        .limit(3000);

      if (!convs?.length) continue;

      // Aggregate per contact
      const perContact = new Map<string, { phone: string; lastInbound: string | null; followupAfter: boolean }>();
      for (const c of convs) {
        const key = normalizeKey(c.phone_number);
        if (!key) continue;
        let entry = perContact.get(key);
        if (!entry) {
          entry = { phone: c.phone_number, lastInbound: null, followupAfter: false };
          perContact.set(key, entry);
        }

        // Processing newest first:
        if (c.direction === "inbound") {
          // The first inbound we see is the most recent one.
          if (!entry.lastInbound) {
            entry.lastInbound = c.created_at;
            entry.phone = c.phone_number;
          }
        } else if ((c.metadata as any)?.type === "inactivity_followup") {
          // If we see a follow-up BEFORE we've seen an inbound (since we're going backwards in time),
          // it means the follow-up was sent AFTER their last message.
          if (!entry.lastInbound) {
            entry.followupAfter = true;
          }
        }
      }

      // Pre-filter eligible contacts before checking orders/takeovers to save DB queries
      const eligibleEntries = [];
      for (const [key, entry] of perContact) {
        if (!entry.lastInbound) continue;
        if (entry.followupAfter) continue; // already followed up since their last message
        const lastInboundTime = parsePgTimestamp(entry.lastInbound);
        if (isNaN(lastInboundTime)) continue;
        if (lastInboundTime > maxIdleCutoff) continue; // not idle long enough yet
        if (lastInboundTime < minIdleCutoff) continue; // inactivity window expired (stale chat)
        if (safeEnabledAtTime > 0 && lastInboundTime < safeEnabledAtTime) continue; // ignore backlog from before the feature was enabled
        eligibleEntries.push({ key, entry });
      }

      if (!eligibleEntries.length) continue;

      // Check if any eligible contacts have placed an order
      const allPhoneVariants = new Set<string>();
      for (const { key, entry } of eligibleEntries) {
        allPhoneVariants.add(entry.phone);
        allPhoneVariants.add(key);
        if (key.startsWith("94") && key.length === 11) {
          allPhoneVariants.add("0" + key.slice(2));
        }
      }
      const phoneList = Array.from(allPhoneVariants);
      const orderKeys = new Set<string>();

      // Fetch in chunks of 100 to avoid huge URL strings
      for (let i = 0; i < phoneList.length; i += 100) {
        const chunk = phoneList.slice(i, i + 100);
        const { data: oData1 } = await supabase.from("orders").select("customer_phone").eq("user_id", userId).in("customer_phone", chunk);
        const { data: oData2 } = await supabase.from("orders").select("whatsapp_phone").eq("user_id", userId).in("whatsapp_phone", chunk);

        for (const o of oData1 || []) if (o.customer_phone) orderKeys.add(normalizeKey(o.customer_phone));
        for (const o of oData2 || []) if (o.whatsapp_phone) orderKeys.add(normalizeKey(o.whatsapp_phone));
      }

      // Maximum follow-up messages dispatched per user per cron execution
      const MAX_PER_RUN = 5;
      let sentForUser = 0;

      for (const { key, entry } of eligibleEntries) {
        if (sentForUser >= MAX_PER_RUN) {
          console.log(`[send-followups] User ${userId} reached safety cap of ${MAX_PER_RUN} follow-ups in this run.`);
          break;
        }

        if (orderKeys.has(key)) continue; // customer already ordered — never send

        // Skip if the chat has been taken over by a human
        const { data: takeover } = await supabase
          .from("chat_takeovers")
          .select("is_taken_over")
          .eq("user_id", userId)
          .in("phone_number", [entry.phone, key])
          .eq("is_taken_over", true)
          .limit(1)
          .maybeSingle();
        if (takeover?.is_taken_over) continue;

        // Verify this contact did NOT have any conversation prior to the feature being enabled
        // (prevents sending to past customers whose chat started before the toggle was turned on)
        if (safeEnabledAtTime > 0) {
          const { data: pastChat } = await supabase
            .from("conversations")
            .select("id")
            .eq("user_id", userId)
            .eq("phone_number", entry.phone)
            .lt("created_at", new Date(safeEnabledAtTime).toISOString())
            .limit(1)
            .maybeSingle();

          if (pastChat) {
            console.log(`[send-followups] Skipping ${entry.phone}: conversation originated before feature was enabled.`);
            continue;
          }
        }

        try {
          const res = await fetch(`${supabaseUrl}/functions/v1/send-whatsapp_via_cloth`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ to: entry.phone, message: cfg.text.trim(), sessionApiKey }),
            signal: AbortSignal.timeout(12000),
          });
          if (!res.ok) {
            const errText = await res.text();
            console.error(`follow-up send failed for ${entry.phone}:`, errText.substring(0, 200));
            const lowerErr = errText.toLowerCase();
            // Circuit-breaker: If session is disconnected/failed, break immediately
            if (
              res.status === 422 ||
              res.status === 401 ||
              lowerErr.includes("session") ||
              lowerErr.includes("not as expected")
            ) {
              console.warn(`[send-followups] Session issue for user ${userId} (${sessionApiKey}). Skipping remaining contacts.`);
              break;
            }
            continue;
          }
          await supabase.from("conversations").insert({
            user_id: userId,
            phone_number: entry.phone,
            message: cfg.text.trim(),
            direction: "outbound",
            message_type: "text",
            metadata: { type: "inactivity_followup" },
          });
          summary.push({ userId, phone: entry.phone });
          sentForUser++;

          // Pacing delay between WhatsApp dispatches to maintain healthy session behavior
          await new Promise((r) => setTimeout(r, 1500));
        } catch (e) {
          console.error(`follow-up error for ${entry.phone}:`, (e as Error).message);
          const msg = (e as Error).message?.toLowerCase() || "";
          if (msg.includes("timed out") || msg.includes("aborted")) {
            console.warn(`[send-followups] Request timed out for session ${sessionApiKey}. Skipping remaining contacts for user ${userId}.`);
            break;
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true, sent: summary.length, details: summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-followups error:", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
