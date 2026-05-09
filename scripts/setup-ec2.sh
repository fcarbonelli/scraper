#!/usr/bin/env bash
# =============================================================================
# One-shot bootstrap for a fresh Ubuntu 24.04 EC2 instance.
#
# Installs everything the scraper needs to run in production:
#   - Node.js 22 + npm
#   - PM2 (process manager)
#   - Redis 7 (BullMQ backend, bound to localhost only)
#   - Caddy (reverse proxy + automatic HTTPS via Let's Encrypt)
#   - Git, build tools
#   - UFW firewall configured (22, 80, 443 open)
#
# Run once on a fresh server as the `ubuntu` user:
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/scripts/setup-ec2.sh | bash
# Or after cloning the repo:
#   bash scripts/setup-ec2.sh
#
# Idempotent — safe to re-run if something fails partway.
# =============================================================================

set -euo pipefail

# Colors for readability (only when stdout is a tty)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' RED='' NC=''
fi

step()  { echo -e "\n${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}warning:${NC} $*" >&2; }
fail()  { echo -e "${RED}error:${NC} $*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Sanity checks
# -----------------------------------------------------------------------------
if [[ "$(id -u)" == "0" ]]; then
  fail "Don't run this as root. Run as the 'ubuntu' user; the script uses sudo where needed."
fi
if ! command -v sudo >/dev/null; then
  fail "sudo is required."
fi
if ! grep -qi 'ubuntu' /etc/os-release; then
  warn "This script targets Ubuntu 24.04. You're on something else — proceed at your own risk."
fi

step "Updating apt package lists"
sudo apt-get update -y

step "Installing base packages (curl, git, build tools)"
sudo apt-get install -y \
  curl \
  git \
  build-essential \
  ca-certificates \
  gnupg \
  ufw \
  debian-keyring \
  debian-archive-keyring \
  apt-transport-https

# -----------------------------------------------------------------------------
# Node.js 22 via NodeSource
# -----------------------------------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node --version)" != v22.* ]]; then
  step "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  step "Node.js 22 already installed ($(node --version))"
fi

# -----------------------------------------------------------------------------
# PM2 (global)
# -----------------------------------------------------------------------------
if ! command -v pm2 >/dev/null; then
  step "Installing PM2"
  sudo npm install -g pm2
else
  step "PM2 already installed ($(pm2 --version))"
fi

# -----------------------------------------------------------------------------
# Redis (apt; bound to 127.0.0.1 by default, no password required for local-only)
# -----------------------------------------------------------------------------
if ! command -v redis-server >/dev/null; then
  step "Installing Redis"
  sudo apt-get install -y redis-server
  sudo systemctl enable redis-server
  sudo systemctl start redis-server
else
  step "Redis already installed ($(redis-server --version | awk '{print $3}'))"
fi

# Verify Redis is up and responsive
if ! redis-cli ping >/dev/null 2>&1; then
  warn "redis-cli ping failed; attempting to start the service"
  sudo systemctl start redis-server
  sleep 2
  redis-cli ping >/dev/null || fail "Redis is not responding to ping. Check 'sudo systemctl status redis-server'."
fi

# -----------------------------------------------------------------------------
# Caddy (official Cloudsmith repo)
# -----------------------------------------------------------------------------
if ! command -v caddy >/dev/null; then
  step "Installing Caddy (official repo)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
else
  step "Caddy already installed ($(caddy version | head -n1))"
fi

# -----------------------------------------------------------------------------
# Firewall (UFW)
# -----------------------------------------------------------------------------
step "Configuring firewall (UFW)"
sudo ufw allow OpenSSH       >/dev/null
sudo ufw allow 80/tcp        >/dev/null     # HTTP (Let's Encrypt challenge)
sudo ufw allow 443/tcp       >/dev/null     # HTTPS
# Don't open 6379 (Redis) or 3000 (Node API) — they bind to localhost only.
echo "y" | sudo ufw enable >/dev/null || true
sudo ufw status verbose

# -----------------------------------------------------------------------------
# App directory
# -----------------------------------------------------------------------------
APP_DIR="/home/ubuntu/scraper"
if [[ ! -d "$APP_DIR" ]]; then
  step "Creating app directory at $APP_DIR (you'll git clone into it next)"
  mkdir -p "$APP_DIR"
fi

# -----------------------------------------------------------------------------
# PM2 startup hook — make PM2 start on every boot
# -----------------------------------------------------------------------------
step "Configuring PM2 to start on boot"
# `pm2 startup` prints a sudo command we then need to execute. Capture & run it.
PM2_STARTUP_CMD=$(pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -n1)
if [[ "$PM2_STARTUP_CMD" == sudo* ]]; then
  echo "Running: $PM2_STARTUP_CMD"
  eval "$PM2_STARTUP_CMD"
else
  warn "PM2 startup command not detected automatically. Run 'pm2 startup' manually after this script."
fi

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
cat <<EOF

${GREEN}===========================================================${NC}
${GREEN}EC2 bootstrap complete.${NC}

Installed:
  - Node $(node --version), npm $(npm --version)
  - PM2 $(pm2 --version)
  - Redis $(redis-server --version | awk '{print $3}' | sed 's/v=//')
  - Caddy $(caddy version | head -n1 | awk '{print $1}')

Next steps (see DEPLOY.md "Phase D: First deploy"):

  1. Clone the repo into ${APP_DIR}:
       cd ${APP_DIR}
       git clone https://github.com/<you>/<repo>.git .

  2. Create the production .env (copy .env.example, fill in values):
       cp .env.example .env
       nano .env

  3. Install deps & build:
       npm ci
       npm run build

  4. Apply DB migration in Supabase (one-time, web SQL editor)
     and seed supermarkets:
       npm run db:setup

  5. Configure Caddy with your domain:
       sudo cp Caddyfile /etc/caddy/Caddyfile
       sudo nano /etc/caddy/Caddyfile          # replace api.example.com
       sudo systemctl reload caddy

  6. Start the apps:
       pm2 start ecosystem.config.cjs
       pm2 save

  7. Generate an API key for the frontend:
       npm run apikey:create -- frontend

  8. Smoke test:
       curl https://api.<your-domain>/v1/health
${GREEN}===========================================================${NC}
EOF
