# BuildStart - Developer Onboarding & AI Setup Guide

Welcome to the BuildStart self-hosted repository! 

If you have just cloned this project on a fresh machine or server, there are several environment-specific setups required (like generating `.env` files, setting up Docker, handling missing database triggers, and configuring webhook tunnels).

To make this completely frictionless, we have designed a **ready-to-use prompt** for Antigravity (or any advanced AI coding assistant). 

**Instructions for the Junior Developer:**
1. Open this repository in your IDE.
2. Open Antigravity (or your AI assistant).
3. Copy the entire prompt block below and paste it into the AI chat.
4. Sit back and let the AI fully configure and start the environment for you!

---

### Copy & Paste this Prompt into Antigravity:

```text
Hello Antigravity! I have just cloned the BuildStart self-hosted project on a fresh machine. Your goal is to configure the environment, fix common clone issues, and get the entire stack running perfectly. 

Please perform the following steps sequentially. Use your bash/terminal tools to execute them:

1. **Environment Variables Setup:**
   - Look for `docker/.env.example` and copy it to `docker/.env`.
   - Look for `frontend/.env.example` and copy it to `frontend/.env`.
   - Ensure you replace any placeholder dummy passwords in `docker/.env` with random secure strings (specifically POSTGRES_PASSWORD and JWT_SECRET) so the database initializes securely.

2. **Start the Backend (Docker):**
   - Navigate to the `docker/` directory.
   - Run `docker compose -f docker-compose.yml -f docker-compose.override.yml up -d` to spin up Supabase, MinIO, and Edge Functions.
   - Wait for the containers to become healthy.

3. **Database Fixes & Setup:**
   - There is a known issue where `auth.users` triggers are missing on fresh databases migrated from Lovable.
   - Please connect to the database container (`docker exec -i supabase-db psql -U postgres -d postgres`) and execute SQL to CREATE the following triggers on `auth.users` FOR EACH ROW:
     - `on_auth_user_created` executing `public.handle_new_user()`
     - `on_auth_user_created_role` executing `public.handle_new_user_role()`
     - `on_auth_user_created_settings` executing `public.handle_new_user_settings()`
   - Execute the SQL file located at `db/03_cron.sql` (fill in the API gateway URLs if necessary) directly into the Supabase database.

4. **WhatsApp Webhook Configuration:**
   - Since I am running this locally/freshly, the WhatsApp webhook URL in `docker/.env` (`WEBHOOK_URL_OVERRIDE`) needs a public URL.
   - Install `cloudflared` (Cloudflare Quick Tunnels) on this machine if it doesn't exist.
   - Start a background cloudflared tunnel pointing to `http://localhost:8000`.
   - Extract the `trycloudflare.com` URL from the tunnel logs.
   - Update `WEBHOOK_URL_OVERRIDE` in `docker/docker-compose.override.yml` to point to `https://<your-cloudflare-url>/functions/v1/webhook-wsender_via_cloth`.
   - Restart the `supabase-edge-functions` container to apply the new environment variable.

5. **Frontend Setup:**
   - Navigate to the `frontend/` directory.
   - Run `npm install` to install all dependencies.
   - Start the frontend development server in the background using `npm run dev`.

6. **Verification:**
   - Verify that all Docker containers are running smoothly.
   - Verify that the frontend is accessible on `http://localhost:8080` (or whatever Vite port is used).
   - Summarize the current state, provide me with the Cloudflare Tunnel URL, and let me know the stack is ready for development!
```
