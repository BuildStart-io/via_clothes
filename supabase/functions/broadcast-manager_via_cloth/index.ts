import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const WAHA_BASE = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_KEY = Deno.env.get("WAHA_API_KEY") || "";
const WAHA_DEFAULT_SESSION = Deno.env.get("WAHA_DEFAULT_SESSION") || "default";

function cleanPhoneNumber(raw: string): string | null {
  if (!raw) return null;
  let phone = String(raw).trim();
  if (phone.endsWith("@c.us") || phone.endsWith("@s.whatsapp.net")) {
    phone = phone.split("@")[0];
  }
  const digits = phone.replace(/\D/g, "");
  if (!digits || digits.length < 7) return null;

  // Sri Lanka local numbers starting with 0 (e.g., 077..., 071...) -> 9477...
  if (digits.length === 10 && digits.startsWith("0")) {
    return "94" + digits.slice(1);
  }
  // Sri Lanka numbers missing leading 0 or country code (e.g., 77..., 71...)
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) {
    return "94" + digits;
  }
  return digits;
}

function toChatId(phone: string): string {
  if (!phone) return "";
  if (phone.includes("@")) return phone;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 15) return `${digits}@lid`;
  return `${digits}@c.us`;
}

function detectMediaType(url: string): "image" | "video" | "audio" | "document" | null {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/.test(lower)) return "image";
  if (/\.(mp4|mov|avi|webm|3gp|3gpp)(\?|$)/.test(lower)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|amr|opus)(\?|$)/.test(lower)) return "audio";
  if (/\.(pdf|docx?|xlsx?|pptx?|csv|txt)(\?|$)/.test(lower)) return "document";
  return "image";
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "file";
    return last.split("?")[0];
  } catch {
    return "file";
  }
}

async function sendWhatsAppViaWaha(chatId: string, message: string, mediaUrl?: string, mediaType?: string, sessionName?: string) {
  if (!WAHA_BASE) throw new Error("WAHA_BASE_URL is not configured in environment");

  const activeSession = sessionName || WAHA_DEFAULT_SESSION || "default";
  const url = mediaUrl?.trim();
  const detectedType = mediaType || (url ? detectMediaType(url) : null);

  if (url) {
    try {
      const fileName = filenameFromUrl(url);
      let wahaFileUrl = url;
      if (wahaFileUrl.startsWith("http://localhost:9000/")) {
        wahaFileUrl = wahaFileUrl.replace("http://localhost:9000/", "http://minio:9000/");
      } else if (wahaFileUrl.startsWith("http://127.0.0.1:9000/")) {
        wahaFileUrl = wahaFileUrl.replace("http://127.0.0.1:9000/", "http://minio:9000/");
      }
      const file = { url: wahaFileUrl, filename: fileName };
      const caption = message || "";

      let endpoint = "/api/sendImage";
      let body: any = { session: activeSession, chatId, file, caption };

      switch (detectedType) {
        case "video":
          endpoint = "/api/sendVideo";
          body = { session: activeSession, chatId, file, caption };
          break;
        case "audio":
          endpoint = "/api/sendVoice";
          body = { session: activeSession, chatId, file };
          break;
        case "document":
          endpoint = "/api/sendFile";
          body = { session: activeSession, chatId, file, caption };
          break;
        case "image":
        default:
          endpoint = "/api/sendImage";
          body = { session: activeSession, chatId, file, caption };
          break;
      }

      const res = await fetch(`${WAHA_BASE}${endpoint}`, {
        method: "POST",
        headers: {
          "X-Api-Key": WAHA_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(body),
      });

      const responseText = await res.text();
      if (!res.ok) {
        let parsed: any = null;
        try { parsed = JSON.parse(responseText); } catch { /* ignore */ }
        throw new Error(parsed?.message || parsed?.error || `WAHA error (${res.status}): ${responseText.slice(0, 150)}`);
      }

      let data: any = null;
      try { data = JSON.parse(responseText); } catch { /* ignore */ }
      return data;
    } catch (mediaErr: any) {
      console.warn(`[WAHA] Native media send failed (${mediaErr.message}). Falling back to text dispatch with media URL:`, url);
      const fallbackText = message ? `${message}\n\n${url}` : url;
      return await sendWhatsAppViaWaha(chatId, fallbackText, undefined, undefined, activeSession);
    }
  }

  const res = await fetch(`${WAHA_BASE}/api/sendText`, {
    method: "POST",
    headers: {
      "X-Api-Key": WAHA_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ session: activeSession, chatId, text: message }),
  });

  const responseText = await res.text();
  if (!res.ok) {
    let parsed: any = null;
    try { parsed = JSON.parse(responseText); } catch { /* ignore */ }
    throw new Error(parsed?.message || parsed?.error || `WAHA error (${res.status}): ${responseText.slice(0, 150)}`);
  }

  let data: any = null;
  try { data = JSON.parse(responseText); } catch { /* ignore */ }
  return data;
}

// Fetch all distinct contacts categorized by segment
async function getAudienceMap(supabase: any, userId: string) {
  // 1. Fetch from orders - include whatsapp_phone and status
  const { data: orders, error: ordersErr } = await supabase
    .from("orders")
    .select("whatsapp_phone, customer_phone, customer_name, is_preorder, status")
    .eq("user_id", userId);

  if (ordersErr) console.warn("Error fetching orders for audience:", ordersErr);

  // 2. Fetch from leads
  const { data: leads, error: leadsErr } = await supabase
    .from("leads")
    .select("phone_number, customer_name")
    .eq("user_id", userId);

  if (leadsErr) console.warn("Error fetching leads for audience:", leadsErr);

  // 3. Fetch from conversations
  const { data: conversations, error: convsErr } = await supabase
    .from("conversations")
    .select("phone_number, metadata")
    .eq("user_id", userId);

  if (convsErr) console.warn("Error fetching conversations for audience:", convsErr);

  const ordersMap = new Map<string, { phone: string; name: string }>();
  const pendingMap = new Map<string, { phone: string; name: string }>();
  const preordersMap = new Map<string, { phone: string; name: string }>();
  const queriesMap = new Map<string, { phone: string; name: string }>();
  const allMap = new Map<string, { phone: string; name: string; segment: string }>();

  // Populate orders, pending orders, and preorders
  // IMPORTANT: Prioritize whatsapp_phone (the actual chat number on WhatsApp) over delivery customer_phone
  (orders || []).forEach((o: any) => {
    const rawPhone = o.whatsapp_phone?.trim() || o.customer_phone?.trim();
    const cleaned = cleanPhoneNumber(rawPhone);
    if (!cleaned) return;
    const name = o.customer_name?.trim() || "";

    if (o.is_preorder) {
      if (!preordersMap.has(cleaned)) preordersMap.set(cleaned, { phone: cleaned, name });
      if (!allMap.has(cleaned)) allMap.set(cleaned, { phone: cleaned, name, segment: "preorders" });
    } else if (o.status === "pending") {
      if (!pendingMap.has(cleaned)) pendingMap.set(cleaned, { phone: cleaned, name });
      if (!allMap.has(cleaned)) allMap.set(cleaned, { phone: cleaned, name, segment: "pending" });
    } else {
      if (!ordersMap.has(cleaned)) ordersMap.set(cleaned, { phone: cleaned, name });
      if (!allMap.has(cleaned)) allMap.set(cleaned, { phone: cleaned, name, segment: "orders" });
    }
  });

  const hasOrderSet = new Set([...ordersMap.keys(), ...pendingMap.keys(), ...preordersMap.keys()]);

  // Populate leads (only if they have not placed an order)
  (leads || []).forEach((l: any) => {
    const cleaned = cleanPhoneNumber(l.phone_number);
    if (!cleaned) return;
    const name = l.customer_name?.trim() || "";
    if (!hasOrderSet.has(cleaned)) {
      if (!queriesMap.has(cleaned)) queriesMap.set(cleaned, { phone: cleaned, name });
      if (!allMap.has(cleaned)) allMap.set(cleaned, { phone: cleaned, name, segment: "queries" });
    }
  });

  // Populate conversations (only if they have not placed an order)
  (conversations || []).forEach((c: any) => {
    const cleaned = cleanPhoneNumber(c.phone_number);
    if (!cleaned) return;
    const senderName = c.metadata?.sender_name || c.metadata?.name || "";
    if (!hasOrderSet.has(cleaned)) {
      if (!queriesMap.has(cleaned)) queriesMap.set(cleaned, { phone: cleaned, name: senderName });
      if (!allMap.has(cleaned)) allMap.set(cleaned, { phone: cleaned, name: senderName, segment: "queries" });
    }
  });

  return { ordersMap, pendingMap, preordersMap, queriesMap, allMap };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      db: { schema: "via_clothing" },
    });

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id || null;
    }

    const payload = await req.json();
    const action = payload.action;

    // Allow user_id from payload if authenticated user matches or in local dev
    if (!userId && payload.user_id) {
      userId = payload.user_id;
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized: Missing user authentication" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: get_audience_counts
    if (action === "get_audience_counts") {
      const { ordersMap, pendingMap, preordersMap, queriesMap, allMap } = await getAudienceMap(supabase, userId);

      const counts = {
        all: allMap.size,
        orders: ordersMap.size,
        pending: pendingMap.size,
        preorders: preordersMap.size,
        queries: queriesMap.size,
      };

      // Preview 5 sample contacts for current requested segment
      const targetSegment = payload.segment || "all";
      let targetMap = allMap;
      if (targetSegment === "orders") targetMap = ordersMap as any;
      else if (targetSegment === "pending") targetMap = pendingMap as any;
      else if (targetSegment === "preorders") targetMap = preordersMap as any;
      else if (targetSegment === "queries") targetMap = queriesMap as any;

      const sample: Array<{ phone: string; name: string }> = [];
      let i = 0;
      for (const [_, item] of targetMap.entries()) {
        if (i++ >= 5) break;
        sample.push({ phone: item.phone, name: item.name || "Customer" });
      }

      return new Response(JSON.stringify({ success: true, counts, sample }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: create_campaign
    if (action === "create_campaign") {
      const {
        name,
        segment = "all",
        message_template,
        media_url,
        media_type,
        delay_seconds_min = 8,
        delay_seconds_max = 15,
        batch_size = 30,
        batch_cooldown_seconds = 120,
      } = payload;

      if (!message_template && !media_url) {
        return new Response(JSON.stringify({ error: "Message text or media is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const campaignName = name?.trim() || `Broadcast - ${new Date().toLocaleDateString()}`;

      // Get target audience
      const { ordersMap, pendingMap, preordersMap, queriesMap, allMap } = await getAudienceMap(supabase, userId);
      let targetMap = allMap;
      if (segment === "orders") targetMap = ordersMap as any;
      else if (segment === "pending") targetMap = pendingMap as any;
      else if (segment === "preorders") targetMap = preordersMap as any;
      else if (segment === "queries") targetMap = queriesMap as any;

      const contacts = Array.from(targetMap.values());
      if (contacts.length === 0) {
        return new Response(JSON.stringify({ error: "No eligible contacts found for selected segment" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Create Campaign Record
      const { data: campaign, error: campErr } = await supabase
        .from("broadcast_campaigns")
        .insert({
          user_id: userId,
          name: campaignName,
          title: campaignName,
          segment,
          audience_filter: segment,
          message_template: message_template || "",
          message: message_template || "",
          media_url: media_url || null,
          media_type: media_type || (media_url ? detectMediaType(media_url) : null),
          total_recipients: contacts.length,
          total_count: contacts.length,
          sent_count: 0,
          failed_count: 0,
          delay_seconds: Number(delay_seconds_min) || 8,
          delay_seconds_min: Number(delay_seconds_min) || 8,
          delay_seconds_max: Number(delay_seconds_max) || 15,
          batch_size: Number(batch_size) || 30,
          batch_cooldown_seconds: Number(batch_cooldown_seconds) || 120,
          status: "draft",
        })
        .select()
        .single();

      if (campErr) throw campErr;

      // Populate Queue in chunks of 500
      const queueItems = contacts.map((c) => ({
        campaign_id: campaign.id,
        user_id: userId,
        phone_number: c.phone,
        recipient_name: c.name?.trim() || null,
        customer_name: c.name?.trim() || null,
        status: "pending",
        retry_count: 0,
      }));

      const CHUNK_SIZE = 500;
      for (let i = 0; i < queueItems.length; i += CHUNK_SIZE) {
        const slice = queueItems.slice(i, i + CHUNK_SIZE);
        const { error: qErr } = await supabase.from("broadcast_queue").insert(slice);
        if (qErr) {
          console.error("Error inserting queue items:", qErr);
          throw qErr;
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          campaign,
          total_recipients: contacts.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: process_batch
    // Sends up to `batch_limit` (default 3-5) messages from the queue with anti-ban delay
    if (action === "process_batch") {
      const { campaign_id, batch_limit = 3 } = payload;
      if (!campaign_id) throw new Error("Missing campaign_id");

      // 1. Check campaign status
      const { data: campaign, error: campErr } = await supabase
        .from("broadcast_campaigns")
        .select("*")
        .eq("id", campaign_id)
        .eq("user_id", userId)
        .single();

      if (campErr || !campaign) throw new Error("Campaign not found");

      if (campaign.status === "paused" || campaign.status === "cancelled") {
        return new Response(
          JSON.stringify({
            success: true,
            status: campaign.status,
            paused: true,
            sent_count: campaign.sent_count,
            failed_count: campaign.failed_count,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // If draft, mark as sending
      if (campaign.status === "draft") {
        await supabase
          .from("broadcast_campaigns")
          .update({ status: "sending", started_at: new Date().toISOString() })
          .eq("id", campaign_id);
      }

      // 2. Fetch pending queue items
      const { data: queueItems, error: qErr } = await supabase
        .from("broadcast_queue")
        .select("*")
        .eq("campaign_id", campaign_id)
        .eq("status", "pending")
        .order("id", { ascending: true })
        .limit(Math.min(batch_limit, 10));

      if (qErr) throw qErr;

      if (!queueItems || queueItems.length === 0) {
        // Complete campaign
        await supabase
          .from("broadcast_campaigns")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", campaign_id);

        return new Response(
          JSON.stringify({
            success: true,
            status: "completed",
            remaining: 0,
            sent_count: campaign.sent_count,
            failed_count: campaign.failed_count,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let sentCount = campaign.sent_count;
      let failedCount = campaign.failed_count;
      const minDelay = campaign.delay_seconds_min || 8;
      const maxDelay = campaign.delay_seconds_max || 15;

      // Look up user's active WAHA session name
      const { data: sessionData } = await supabase
        .from("user_wsender_sessions")
        .select("session_api_key")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();

      const userSessionName = sessionData?.session_api_key || `u_${userId.replace(/-/g, "").substring(0, 20)}`;

      for (let i = 0; i < queueItems.length; i++) {
        const item = queueItems[i];

        // Double check campaign wasn't paused in DB
        const { data: checkCamp } = await supabase
          .from("broadcast_campaigns")
          .select("status")
          .eq("id", campaign_id)
          .single();

        if (checkCamp?.status === "paused" || checkCamp?.status === "cancelled") {
          return new Response(
            JSON.stringify({
              success: true,
              status: checkCamp.status,
              paused: true,
              sent_count: sentCount,
              failed_count: failedCount,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Format message: replace {name} with recipient_name
        const customerName = item.recipient_name || item.customer_name || "Customer";
        const messageText = (campaign.message_template || campaign.message || "").replace(/{name}/gi, customerName);
        const chatId = toChatId(item.phone_number);

        try {
          await sendWhatsAppViaWaha(chatId, messageText, campaign.media_url, campaign.media_type, userSessionName);

          // Update queue item to sent
          await supabase
            .from("broadcast_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", item.id);

          // Record in conversations so it appears in the user's chat tab
          await supabase.from("conversations").insert({
            user_id: userId,
            phone_number: item.phone_number,
            direction: "outbound",
            message: messageText || (campaign.media_url ? "[Media Broadcast]" : ""),
            message_type: campaign.media_url ? "media" : "text",
            metadata: {
              broadcast_campaign_id: campaign.id,
              broadcast_campaign_name: campaign.name,
              media_url: campaign.media_url,
            },
          });

          sentCount++;
        } catch (sendErr: any) {
          console.error(`Failed to send broadcast to ${item.phone_number}:`, sendErr);
          await supabase
            .from("broadcast_queue")
            .update({
              status: "failed",
              error_message: sendErr?.message || "Unknown error",
              retry_count: (item.retry_count || 0) + 1,
            })
            .eq("id", item.id);

          failedCount++;
        }

        // Anti-ban jitter delay before sending the next message
        if (i < queueItems.length - 1) {
          const delaySeconds = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);
          console.log(`Waiting anti-ban delay ${delaySeconds}s before next recipient...`);
          await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
        }
      }

      // Update campaign counters
      await supabase
        .from("broadcast_campaigns")
        .update({ sent_count: sentCount, failed_count: failedCount })
        .eq("id", campaign_id);

      // Check remaining
      const { count: remainingCount } = await supabase
        .from("broadcast_queue")
        .select("*", { count: "exact", head: true })
        .eq("campaign_id", campaign_id)
        .eq("status", "pending");

      const isCompleted = (remainingCount || 0) === 0;
      if (isCompleted) {
        await supabase
          .from("broadcast_campaigns")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", campaign_id);
      }

      return new Response(
        JSON.stringify({
          success: true,
          status: isCompleted ? "completed" : "sending",
          processed_in_batch: queueItems.length,
          remaining: remainingCount || 0,
          sent_count: sentCount,
          failed_count: failedCount,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ACTION: pause_campaign
    if (action === "pause_campaign") {
      const { campaign_id } = payload;
      await supabase
        .from("broadcast_campaigns")
        .update({ status: "paused" })
        .eq("id", campaign_id)
        .eq("user_id", userId);

      return new Response(JSON.stringify({ success: true, status: "paused" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: resume_campaign
    if (action === "resume_campaign") {
      const { campaign_id } = payload;
      await supabase
        .from("broadcast_campaigns")
        .update({ status: "sending" })
        .eq("id", campaign_id)
        .eq("user_id", userId);

      return new Response(JSON.stringify({ success: true, status: "sending" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: cancel_campaign
    if (action === "cancel_campaign") {
      const { campaign_id } = payload;
      await supabase
        .from("broadcast_campaigns")
        .update({ status: "cancelled" })
        .eq("id", campaign_id)
        .eq("user_id", userId);

      return new Response(JSON.stringify({ success: true, status: "cancelled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: list_campaigns
    if (action === "list_campaigns") {
      const { data: campaigns, error: listErr } = await supabase
        .from("broadcast_campaigns")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (listErr) throw listErr;

      return new Response(JSON.stringify({ success: true, campaigns }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACTION: get_campaign_status
    if (action === "get_campaign_status") {
      const { campaign_id } = payload;
      const { data: campaign, error: campErr } = await supabase
        .from("broadcast_campaigns")
        .select("*")
        .eq("id", campaign_id)
        .eq("user_id", userId)
        .single();

      if (campErr) throw campErr;

      const { data: recentQueue } = await supabase
        .from("broadcast_queue")
        .select("id, phone_number, recipient_name, status, sent_at, error_message")
        .eq("campaign_id", campaign_id)
        .order("id", { ascending: false })
        .limit(20);

      const { count: pendingCount } = await supabase
        .from("broadcast_queue")
        .select("*", { count: "exact", head: true })
        .eq("campaign_id", campaign_id)
        .eq("status", "pending");

      return new Response(
        JSON.stringify({
          success: true,
          campaign,
          pending_count: pendingCount || 0,
          recent_logs: recentQueue || [],
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Broadcast manager error:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
