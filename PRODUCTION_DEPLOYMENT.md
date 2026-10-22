# BuildStart - Production Deployment Guide

This guide explains everything you need to consider when moving BuildStart from a local environment (like your laptop) to a production server (like AWS, DigitalOcean, or Hetzner).

## 1. Server Requirements
BuildStart runs multiple services (Supabase Database, Edge Functions, MinIO Storage, WAHA WhatsApp Engine, and a Frontend). These require a decent amount of resources:
* **Minimum Recommendation:** 4GB RAM, 2 CPU Cores.
* **Ideal Recommendation:** 8GB RAM, 4 CPU Cores (Highly recommended so the database and WhatsApp engine don't crash under load).
* **OS:** Ubuntu 22.04 or 24.04 LTS is standard and easiest to work with.

## 2. Setting up a Domain & SSL (HTTPS)
You cannot use tunnels like `trycloudflare` or `localhost.run` for a real business. You need a proper domain name (e.g., `app.yourdomain.com`).
* **Buy a Domain:** Point it to your server's Public IP address.
* **Reverse Proxy:** Install **Nginx** or **Caddy** on your server. 
  * Caddy is recommended because it automatically gives you free SSL certificates (HTTPS) without any manual configuration.
* **Frontend:** Your React frontend should ideally be hosted on Vercel, Netlify, or Cloudflare Pages for maximum speed, rather than running `npm run dev` on your server. Point the frontend to your backend domain.

## 3. Securing Your Environment Variables (`.env`)
The `.env` file on your laptop currently has default passwords. **You must change these in production!**
* **Database Passwords:** Change `POSTGRES_PASSWORD`.
* **JWT Secret:** Change the `JWT_SECRET` (used for user logins). If you don't change this, anyone can forge a login token and hack your dashboard.
* **API Keys:** Change `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to match your new JWT secret. (You can generate these online using a JWT generator).
* **MinIO Passwords:** Change `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY` so people can't access your file storage.

## 4. WhatsApp Webhook Configuration
Currently, your WhatsApp webhook relies on a temporary tunnel (`WEBHOOK_URL_OVERRIDE`).
* In production, remove the override entirely or point it to your actual domain:
  `WEBHOOK_URL_OVERRIDE="https://api.yourdomain.com/functions/v1/webhook-wsender_via_cloth"`
* Ensure the WAHA server can reach this URL without being blocked by firewalls.

## 5. Hide Supabase Studio
Supabase Studio (the database dashboard on port `3000`) has **no login page** in the self-hosted Docker version. Anyone with the URL can see and edit your database.
* **Action:** Either remove the `studio` container from `docker-compose.yml` in production, or use Nginx/Caddy to put a "Basic Auth" username and password in front of it. 

## 6. Edge Functions
The edge functions run on a separate port (`8000`). 
* Make sure your reverse proxy (Nginx/Caddy) correctly routes requests like `https://api.yourdomain.com/functions/v1/...` to the internal port `8000`.

## 7. Backups
If your server crashes, you don't want to lose all your business accounts, products, and chat histories.
* Set up a daily **Cron Job** to run `pg_dump` and back up your Postgres database.
* Store these backups externally (e.g., in AWS S3 or a separate backup server). 
* Back up the Docker volumes (specifically the MinIO storage volume so you don't lose product images).

## 8. Process Manager (Staying Online)
You don't want the app to go down if the server reboots.
* Use `docker compose up -d` to run the backend in the background so it restarts automatically on boot.
* If you host the frontend on the server (using Node), run it using `pm2` so it stays alive permanently, rather than using `npm run dev`.

---
### Summary Checklist before Launch:
- [ ] Bought a domain name and linked it to the server IP.
- [ ] Set up HTTPS/SSL (using Caddy or Nginx).
- [ ] Changed ALL passwords and secrets in `.env`.
- [ ] Updated WAHA webhook to use the real domain.
- [ ] Secured or disabled Supabase Studio.
- [ ] Configured daily database backups.
- [ ] Hosted Frontend on Vercel/Netlify (Recommended).
