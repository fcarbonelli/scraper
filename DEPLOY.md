# Deployment Guide

End-to-end instructions for getting the scraper running on AWS EC2 with HTTPS, push-to-deploy, and notifications.

> Plan to set aside about **45–60 minutes** the first time. After this, deploys take ~30 seconds via `git push`.

## Table of contents

- [What you'll end up with](#what-youll-end-up-with)
- [Prerequisites](#prerequisites)
- [Phase A — Set up AWS](#phase-a--set-up-aws)
- [Phase B — Point your domain at the server](#phase-b--point-your-domain-at-the-server)
- [Phase C — Bootstrap the server](#phase-c--bootstrap-the-server)
- [Phase D — First deploy (manual)](#phase-d--first-deploy-manual)
- [Phase E — Smoke test](#phase-e--smoke-test)
- [Phase F — Wire up GitHub Actions (push-to-deploy)](#phase-f--wire-up-github-actions-push-to-deploy)
- [Day-2 operations](#day-2-operations)
- [Troubleshooting](#troubleshooting)

---

## What you'll end up with

```
                               https://api.megaanalytics.com
                                          │
                   ┌──────────────────────▼──────────────────────┐
                   │  EC2 t3.medium (Ubuntu 24.04)               │
                   │                                             │
                   │   Caddy ──► Express API   (PM2)             │
                   │             Orchestrator  (PM2, cron 6 AM)  │
                   │             Worker        (PM2, BullMQ)     │
                   │             Redis         (localhost only)  │
                   │                                             │
                   └──────────────────┬──────────────────────────┘
                                      │
                              ┌───────▼────────┐
                              │   Supabase     │
                              │   (Postgres)   │
                              └────────────────┘

git push origin main  ───►  GitHub Actions  ───►  SSH + pm2 reload
                                   │
                                   ▼
                              Telegram alert
```

---

## Prerequisites

Before you start, have these ready:

1. **AWS account** — sign up at [aws.amazon.com](https://aws.amazon.com). Requires a credit card. The first 12 months get a generous free tier (a `t2.micro` is free), but we're using `t3.medium` (~$30/mo) for comfortable headroom.
2. **A domain you control** — e.g. `megaanalytics.com`. You'll create a subdomain like `api.megaanalytics.com`.
3. **A Telegram bot + chat ID** already set up (you did this in Phase 2).
4. **A Supabase project** with the migration applied (already done).
5. **The `.env` values** you've been using locally — you'll copy them to the server.

You don't need anything installed locally except Git and an SSH client. **Windows 10/11 PowerShell has SSH built in** — no PuTTY needed.

---

## Phase A — Set up AWS

### A.1 — Launch an EC2 instance

1. Sign in to the [AWS Console](https://console.aws.amazon.com).
2. In the **top-right region selector**, pick **South America (São Paulo) `sa-east-1`**. Closest region to Argentina, lowest latency to the supermarket sites.
3. Search for **EC2** in the top search bar. Click EC2.
4. Click **Launch instance**.
5. Fill in:
  - **Name**: `scraper-prod`
  - **Application and OS Images**: Ubuntu → **Ubuntu Server 24.04 LTS (HVM), SSD Volume Type** → architecture **64-bit (x86)**
  - **Instance type**: `t3.medium` (2 vCPU, 4 GB RAM). Comfortable for fetch-based scrapers and leaves headroom for any future Playwright-based adapter without needing to resize. (You can downgrade to `t3.small` later if you want to save ~$15/mo and you never add browser-based scraping.)
  - **Key pair (login)**: click **Create new key pair**.
    - Name: `scraper-prod-key`
    - Type: RSA
    - Format: `.pem` (use `.ppk` only if you specifically need PuTTY)
    - Click **Create key pair** — your browser downloads `scraper-prod-key.pem`. **Save this file somewhere safe** (e.g. `C:\Users\fran-\.ssh\scraper-prod-key.pem`). You can never re-download it; if you lose it, you lose access to the server.
  - **Network settings** → **Edit**:
    - **Allow SSH traffic from**: `Anywhere (0.0.0.0/0)` — *or* "My IP" if your home IP is static. We need to allow from anywhere because GitHub Actions deploys from many different IPs. SSH key auth (no passwords) keeps this safe.
    - **Allow HTTPS traffic from the internet**: ✓ check
    - **Allow HTTP traffic from the internet**: ✓ check (Caddy needs port 80 open for Let's Encrypt cert challenges)
  - **Configure storage**: 20 GB gp3 (default 8 GB is too small once npm modules + logs accumulate)
6. Click **Launch instance**. Wait for the green "Successfully initiated launch" banner.
7. Click **View all instances**. Wait until **Instance state = Running** and **Status check = 2/2 passed** (~1–2 minutes).

### A.2 — Allocate an Elastic IP (a stable public IP)

By default, EC2 instances get a new public IP every time they reboot. We want a fixed one.

1. In the EC2 console left sidebar, click **Elastic IPs** (under "Network & Security").
2. Click **Allocate Elastic IP address** → **Allocate**.
3. Select the new IP → **Actions → Associate Elastic IP address**.
4. Instance: pick `scraper-prod` → **Associate**.
5. **Copy this IP address** — you'll need it twice (DNS + GitHub Actions).

> Elastic IPs are **free while attached to a running instance**. If you stop the instance for an extended time, AWS charges a small fee. Don't release it unless you're tearing down the deployment.

### A.3 — Test SSH from your laptop

Open **PowerShell** on Windows (Start → type `PowerShell`). Don't use cmd.exe — the variable syntax below is PowerShell-only.

```powershell
# One-time: lock down the .pem file's permissions (Windows-specific).
# Two-step form so the username variable expands cleanly regardless of
# how the line gets pasted.
$me = $env:USERNAME
icacls C:\Users\fran-\.ssh\scraper-prod-key.pem /inheritance:r /grant:r "${me}:(R)"

# Connect (replace 1.2.3.4 with your Elastic IP)
ssh -i C:\Users\fran-\.ssh\scraper-prod-key.pem ubuntu@1.2.3.4
```

> If `icacls` errors with `Invalid parameter "${me}:(R)"`, the variable didn't expand — you're probably in cmd.exe, or the quotes got pasted as smart quotes. Either re-open in PowerShell, or hardcode your username, e.g. `"fran-:(R)"`.

You should see something like `Welcome to Ubuntu 24.04 LTS`. If you do, great — type `exit` to disconnect.

If it times out or refuses, see [Troubleshooting → Can't SSH in](#cant-ssh-in).

---

## Phase B — Point your domain at the server

You need a DNS **A record** mapping `api.megaanalytics.com` → your Elastic IP.

The exact UI depends on where your domain is registered (Namecheap, GoDaddy, Cloudflare, NIC.ar, Route 53, etc.). The general steps:

1. Log into your domain registrar.
2. Find DNS settings for `megaanalytics.com`.
3. Add a record:
  - **Type**: A
  - **Name / Host**: `api` (just the subdomain part)
  - **Value / Points to**: your Elastic IP (e.g. `1.2.3.4`)
  - **TTL**: 300 seconds (5 min) — short while you're setting up; you can raise it later
4. Save.

Verify it's propagated (PowerShell):

```powershell
nslookup api.megaanalytics.com
```

You should see your Elastic IP. If it returns the wrong IP or nothing, wait a few minutes and try again.

---

## Phase C — Bootstrap the server

SSH back into the server:

```powershell
ssh -i C:\Users\fran-\.ssh\scraper-prod-key.pem ubuntu@1.2.3.4
```

From this point on, all commands are run **on the server** (in the SSH session) unless noted.

### C.1 — Run the bootstrap script

```bash
# Download the setup script directly from your repo
curl -fsSL https://raw.githubusercontent.com/<YOUR_GH_USERNAME>/<YOUR_REPO>/main/scripts/setup-ec2.sh -o setup-ec2.sh
bash setup-ec2.sh
```

> If the repo is **private**, the curl above will 404. Either temporarily make the repo public, or just clone the repo first and run `bash scripts/setup-ec2.sh` from inside it.

This installs:

- Node.js 22, npm
- PM2 (with auto-start-on-reboot configured)
- Redis 7 (bound to `localhost` only — not internet-accessible)
- Caddy (with the official repo)
- UFW firewall (opens 22, 80, 443; everything else closed)

Takes 2–3 minutes. Should print a green "EC2 bootstrap complete" message at the end.

### C.2 — Verify everything is installed

```bash
node --version              # v22.x.x
npm --version               # 10.x.x
pm2 --version               # 5.x.x
redis-cli ping              # PONG
caddy version               # v2.x.x
```

If any of these fail, see [Troubleshooting → Bootstrap failed](#bootstrap-failed).

---

## Phase D — First deploy (manual)

Just for the first deploy. After this, GitHub Actions handles it.

### D.1 — Clone the repo

```bash
cd /home/ubuntu/scraper
git clone https://github.com/<YOUR_GH_USERNAME>/<YOUR_REPO>.git .
```

> Note the `.` at the end — clones into the current directory instead of a subfolder.

For a **private repo**, you'll need a Personal Access Token (PAT). Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic). Scope: `repo`. Then:

```bash
git clone https://<YOUR_GH_USERNAME>:<YOUR_PAT>@github.com/<YOUR_GH_USERNAME>/<YOUR_REPO>.git .
```

GitHub also accepts deploy keys (SSH key per repo); use whichever you prefer.

### D.2 — Create the production `.env`

```bash
cp .env.example .env
nano .env
```

Fill in the values. Same as your local `.env` but with one tweak:

```bash
NODE_ENV=production
LOG_LEVEL=info
LOG_PRETTY=false                         # JSON logs in production (Pino default)

# Supabase (same as local)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=ey...

# Redis is local on this server
REDIS_URL=redis://127.0.0.1:6379

# API
API_PORT=3000

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_MIN_SEVERITY=warning

# Optional: Sentry DSN for unhandled exception tracking
SENTRY_DSN=
```

Save with `Ctrl+O`, `Enter`, then `Ctrl+X` to exit nano.

### D.3 — Install + build

```bash
npm ci
npm run build
```

If `npm run build` succeeds without errors, you're good.

### D.4 — Seed the supermarkets

```bash
npm run db:setup
```

Should print "upserted supermarket coto" / "upserted supermarket carrefour".

> If you've already run this against the same Supabase from your laptop, this is idempotent — it'll just confirm the rows exist.

### D.5 — Configure Caddy (HTTPS reverse proxy)

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
```

Replace the placeholder `api.example.com` on the first non-comment line with your real domain (e.g. `api.megaanalytics.com`). Save.

```bash
sudo systemctl reload caddy
sudo systemctl status caddy        # should say "active (running)"
```

Caddy will obtain a Let's Encrypt cert automatically the first time someone hits the domain. You can pre-warm it:

```bash
curl -I https://api.megaanalytics.com
# First request takes 5–15s while Caddy gets the cert. After that it's instant.
```

If you get a TLS error here, see [Troubleshooting → Caddy can't get a certificate](#caddy-cant-get-a-certificate).

### D.6 — Start the apps with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

Verify:

```bash
pm2 status
```

You should see three processes — `orchestrator`, `worker`, `api` — all with status `online`.

Tail the logs for 30 seconds to make sure they're not crash-looping:

```bash
pm2 logs --lines 50
# Ctrl+C to stop tailing
```

You should see:

- `orchestrator`: "starting orchestrator", "scheduled daily scrape with cron …"
- `worker`: "starting worker for supermarket coto", "starting worker for supermarket carrefour"
- `api`: "API listening on port 3000"

If something is crash-looping, see [Troubleshooting → A PM2 process keeps restarting](#a-pm2-process-keeps-restarting).

---

## Phase E — Smoke test

### E.1 — Hit the public health endpoint

From your laptop (or anywhere with internet):

```powershell
curl https://api.megaanalytics.com/v1/health
```

Expected:

```json
{
  "data": { "status": "ok", "uptimeSeconds": 42, "services": { "db": true } },
  "meta": { "ts": "..." }
}
```

If you see this with HTTPS — your TLS cert is working, Caddy is proxying correctly, and the API is alive. The hardest part is over.

### E.2 — Generate a production API key

On the server:

```bash
npm run apikey:create -- frontend
```

This prints a key like `693385619c033a55f022b6932b30b709db1b0c7388e57cc3a09ec1c6da73cbd6` **once**. Save it somewhere safe (your password manager). Never logged again.

### E.3 — Test an authenticated endpoint

From your laptop (replace `<KEY>`):

```powershell
curl -H "X-API-Key: <KEY>" https://api.megaanalytics.com/v1/products?limit=5
```

You should get back a JSON envelope with the products you've already scraped locally.

### E.4 — Trigger a manual scrape (optional but recommended)

On the server:

```bash
npm run orchestrator:run-now
```

This enqueues a real scrape immediately instead of waiting for the daily cron. Watch the worker logs:

```bash
pm2 logs worker --lines 100
```

You should see jobs being processed for each product. Then check the API:

```powershell
curl -H "X-API-Key: <KEY>" https://api.megaanalytics.com/v1/runs?limit=3
```

Should show your fresh run with `status: "completed"`.

---

## Phase F — Wire up GitHub Actions (push-to-deploy)

This is the magic — every `git push origin main` will redeploy automatically.

### F.1 — Add secrets to your GitHub repository

Go to your repo on GitHub → **Settings → Secrets and variables → Actions → New repository secret**. Add four secrets:


| Name                 | Value                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EC2_HOST`           | Your Elastic IP (e.g. `1.2.3.4`)                                                                                                                                                                                     |
| `EC2_SSH_KEY`        | The **full contents** of your `.pem` file. Open `scraper-prod-key.pem` in a text editor, copy everything including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`, paste as the secret value. |
| `TELEGRAM_BOT_TOKEN` | Same as your `.env`'s `TELEGRAM_BOT_TOKEN`                                                                                                                                                                           |
| `TELEGRAM_CHAT_ID`   | Same as your `.env`'s `TELEGRAM_CHAT_ID`                                                                                                                                                                             |


### F.2 — Test the deploy workflow

The workflow file `.github/workflows/deploy.yml` is already in your repo. To test it:

**Option 1 (recommended): manually trigger it.**

Go to your repo → **Actions** tab → **Deploy to EC2** workflow (left sidebar) → **Run workflow** button → **Run workflow**.

Watch it run. It should:

1. Typecheck (~30s)
2. SSH in and pull/build/reload (~1–2 min)
3. Send a Telegram message: "Deploy succeeded"

**Option 2: push a trivial commit.**

```powershell
# On your laptop
git commit --allow-empty -m "test deploy"
git push origin main
```

Same effect — Actions runs on push.

### F.3 — Verify

After a successful deploy:

- Telegram chat shows the success message
- `curl https://api.megaanalytics.com/v1/health` still works
- On the server, `pm2 status` shows uptime reset (recent)

If the workflow fails, check the Actions log on GitHub. Common issues are in [Troubleshooting → GitHub Actions deploy fails](#github-actions-deploy-fails).

---

## Day-2 operations

Common things you'll do once it's live.

### View logs

```bash
# All processes
pm2 logs

# One process
pm2 logs worker --lines 200

# Save current logs to a file (useful for debugging)
pm2 logs --nostream --lines 1000 > /tmp/logs.txt
```

### Trigger a manual scrape

```bash
ssh ubuntu@<your-ip>
cd /home/ubuntu/scraper
npm run orchestrator:run-now
```

### Add a new supermarket

1. Locally: write the adapter, register it in `src/adapters/registry.ts`, add a row to `SUPERMARKETS` in `scripts/setup-db.ts`, smoke-test with `npm run test:adapter -- <a-product-url>`.
2. Push to main. That's it on the deploy side — GitHub Actions runs `npm run db:setup` automatically before `pm2 reload`, so the new row is upserted into the DB and the worker re-reads the active supermarkets list when it restarts. No SSH required.
3. To start scraping products for it, ingest URLs:
   - One-off: `npm run scrape:url -- <a-product-url>` (locally is fine — it writes to the same Supabase).
   - Bulk: put URLs in a text file and run `npm run scrape:bulk -- urls.txt`.
4. The next daily orchestrator run picks them up. To trigger immediately: `npm run orchestrator:run-now` (locally or on the server — orchestrator only enqueues; the production worker still does the work).

### Issue a new API key

```bash
ssh ubuntu@<your-ip>
cd /home/ubuntu/scraper
npm run apikey:create -- "consumer-name"
# copy the printed key, hand it to the consumer
```

### Revoke an API key

In Supabase SQL editor:

```sql
UPDATE api_keys SET is_active = false WHERE name = 'consumer-name';
```

The in-memory cache in the API expires every 5 minutes, so revocation takes effect within 5 min. Or restart the API: `pm2 restart api`.

### Update the Caddyfile

```bash
ssh ubuntu@<your-ip>
sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Restart everything

```bash
pm2 restart all                # restarts all processes (brief downtime)
pm2 reload ecosystem.config.cjs --update-env   # zero-downtime, picks up .env changes
```

### Update environment variables

```bash
ssh ubuntu@<your-ip>
cd /home/ubuntu/scraper
nano .env
pm2 reload ecosystem.config.cjs --update-env   # forces processes to reload .env
```

---

## Troubleshooting

### Can't SSH in

- `**Permission denied (publickey)**`: Double-check the path to your `.pem` file and that you used `ubuntu@` not `ec2-user@` or `root@`.
- `**Connection timed out**`: Security group is blocking. EC2 console → Instance → Security tab → click the security group → Edit inbound rules → make sure port 22 is open.
- `**Permissions for '...pem' are too open**` (on macOS/Linux laptops): `chmod 400 scraper-prod-key.pem`. On Windows, run the `icacls` command from [Phase A.3](#a3--test-ssh-from-your-laptop).

### Bootstrap failed

Re-run it — the script is idempotent. If it consistently fails on a specific step, copy the error and:

- Check `apt update` works: `sudo apt-get update`
- Check `curl` works: `curl https://google.com`
- Disk space: `df -h /`. If `/` is >90% full, your storage is too small. Re-create the instance with 20+ GB.

### Caddy can't get a certificate

Symptoms: `https://api.megaanalytics.com` returns a TLS error like `unable to verify the first certificate`.

Causes:

1. **DNS not propagated** — `nslookup api.megaanalytics.com` doesn't return your Elastic IP yet. Wait 5–15 minutes.
2. **Port 80 not open** — Let's Encrypt needs port 80 reachable for the HTTP-01 challenge. Check the security group AND `sudo ufw status` (should show 80 ALLOW).
3. **Wrong domain in Caddyfile** — `sudo cat /etc/caddy/Caddyfile` and verify the first line is your real domain, not `api.example.com`.
4. **Caddy logs**: `sudo journalctl -u caddy -n 100 --no-pager` — Caddy's own error messages are usually clear about what's wrong.

### A PM2 process keeps restarting

```bash
pm2 logs <process-name> --lines 100
```

Most common causes:

- **Missing env var** — Zod will print exactly which one is missing.
- **Can't connect to Redis** — `redis-cli ping`. If no response, `sudo systemctl restart redis-server`.
- **Can't connect to Supabase** — wrong `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Edit and `pm2 reload ecosystem.config.cjs --update-env`.
- **Out of memory** — `pm2 status` shows the memory column. If a process is at the `max_memory_restart` ceiling, raise it in `ecosystem.config.cjs`. If the whole instance is memory-pressured, upgrade to `t3.large`.

To fully reset PM2 (if it gets into a weird state):

```bash
pm2 delete all
pm2 start ecosystem.config.cjs
pm2 save
```

### GitHub Actions deploy fails

Open the failed run in the Actions tab on GitHub.

- `**Permission denied (publickey)**` → `EC2_SSH_KEY` secret is wrong or missing the BEGIN/END lines. Re-paste the entire `.pem` file contents.
- `**ssh: connect to host ... port 22: Connection timed out**` → `EC2_HOST` secret has wrong IP, or the security group blocks port 22.
- `**npm ci` fails** → likely a lockfile mismatch. Pull main locally, run `npm install`, commit the lockfile, push again.
- `**npm run build` fails** → typecheck error introduced. The CI should catch this in the typecheck job before deploy. If it slipped through, fix locally and push.
- **Telegram notification didn't fire** → `TELEGRAM_`* secrets not set, or bot was kicked from the chat.

### "I broke production, how do I roll back?"

```bash
ssh ubuntu@<your-ip>
cd /home/ubuntu/scraper
git log --oneline -10                           # find the last good commit hash
git reset --hard <good-commit-hash>
npm ci && npm run build
pm2 reload ecosystem.config.cjs --update-env
```

Then on your laptop, push a fix-forward commit so subsequent auto-deploys don't re-deploy the broken commit.

### "I want to nuke and start over"

On the EC2 instance:

```bash
pm2 delete all
pm2 unstartup systemd
sudo systemctl stop caddy redis-server
rm -rf /home/ubuntu/scraper
```

Then re-run the bootstrap script and Phase D.

If you want to fully start over including the EC2 instance: terminate the instance in the AWS console (Instance state → Terminate). Release the Elastic IP if you don't intend to recreate. Start over from Phase A.

---

## Cost summary


| Item                      | Monthly     | Notes                                                                                                                                                    |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC2 t3.medium (sa-east-1) | ~$30        | 2 vCPU, 4 GB RAM. Comfortable headroom; future-proof for Playwright. Drop to `t3.small` (~$15) if you want to save and never add browser-based scraping. |
| EBS gp3 20 GB             | ~$2         | Boot volume                                                                                                                                              |
| Elastic IP                | $0          | Free while attached to a running instance                                                                                                                |
| Data transfer out         | ~$0–2       | Tiny for our use case (mostly inbound scraping)                                                                                                          |
| Domain                    | ~$1         | Amortized from yearly cost                                                                                                                               |
| **Total**                 | **~$18/mo** |                                                                                                                                                          |


If costs become a concern later, options include:

- Move to `t2.micro` (free tier) — viable but you'll OOM occasionally
- Run on a $5/mo Hetzner/DigitalOcean VM instead of EC2 — same setup script works
- Schedule the worker only during scraping hours (saves a tiny amount, not really worth the complexity)

