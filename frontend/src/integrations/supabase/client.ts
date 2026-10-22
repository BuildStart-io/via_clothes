import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// Self-hosted Supabase. Values come from frontend/.env (see .env.example).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const SUPABASE_SCHEMA = (import.meta.env.VITE_SUPABASE_SCHEMA as string) || "via_clothing";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — copy .env.example to .env"
  );
}

export const supabase = createClient<Database, "via_clothing">(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: {
    schema: (SUPABASE_SCHEMA as "via_clothing") || "via_clothing",
  },
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
