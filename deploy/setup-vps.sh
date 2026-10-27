#!/usr/bin/env bash
# =========================================================
# Magzest — install or update the site on an Ubuntu/Debian VPS
#
#   First install:  sudo bash deploy/setup-vps.sh
#   Update later:   upload + unzip a new bundle, run the same command
#
# Layout on the server:
#   /opt/magzest/app            the code (replaced on every update)
#   /var/lib/magzest            database, uploads, backups (kept)
#   /etc/magzest/magzest.env    settings and secrets (kept)
# =========================================================
set -euo pipefail

APP_USER=magzest
APP_DIR=/opt/magzest/app
DATA_DIR=/var/lib/magzest
ENV_DIR=/etc/magzest
ENV_FILE=$ENV_DIR/magzest.env
PORT=3000
DOMAIN=magzest.tech
NODE_MAJOR=24

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0"
[ -f "$BUNDLE_DIR/server/package.json" ] || die "Can't find server/package.json next to this script. Unzip the whole bundle first."
command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian (apt). Pick an Ubuntu template for the VPS."

# ---------- System packages ----------
say "Installing system packages (nginx, certbot)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates unzip nginx certbot python3-certbot-nginx >/dev/null

# ---------- Node.js ----------
node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  say "Installing Node.js $NODE_MAJOR…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "Node.js 22.13+ is required; found $(node -v 2>/dev/null || echo none)."
echo "Node $(node -v)"

# ---------- User and folders ----------
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home /opt/magzest --shell /usr/sbin/nologin "$APP_USER"
mkdir -p /opt/magzest "$DATA_DIR" "$ENV_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------- Settings (first install only) ----------
if [ ! -f "$ENV_FILE" ]; then
  say "First install — a few questions (press Enter for the default)"
  read -rp "Admin email [hameed@magzest.tech]: " ADMIN_EMAIL
  ADMIN_EMAIL=${ADMIN_EMAIL:-hameed@magzest.tech}
  read -rsp "Admin password (10+ characters, leave empty to generate one): " ADMIN_PASSWORD; echo
  GENERATED=""
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD=$(node -e 'const a="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";const b=require("crypto").randomBytes(16);let s="";for(const x of b)s+=a[x%a.length];console.log(s.match(/.{4}/g).join("-"))')
    GENERATED=1
  fi
  [ ${#ADMIN_PASSWORD} -ge 10 ] || die "Password must be at least 10 characters."

  umask 077
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$PORT
SITE_URL=https://www.$DOMAIN
TRUST_PROXY=1
DATA_DIR=$DATA_DIR
SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
SESSION_IDLE_MINUTES=120
SESSION_HOURS=168

# Used only to create the first admin; safe to delete after the first start.
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD

# Email (fill in later, then: sudo systemctl restart magzest)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=Magzest <contact@$DOMAIN>
NOTIFY_EMAIL=contact@$DOMAIN
# Contact-form and booking alerts (comma-separated)
LEADS_EMAIL=ranjithkumar@magzest.in,nithin@magzest.tech,hameed@magzest.tech,srilatha@magzest.tech,harini@magzest.tech
AUTO_REPLY=true

# Bigin CRM: website leads are forwarded to the Bigin "Contact us" web form
# (bigin.zoho.in). Keys come from the hidden xnQsjsdp / xmIwtLD inputs in the
# form's source code. Leave empty to turn the sync off (e.g. for local testing).
BIGIN_FORM_XNQSJSDP=0f1973ac752a5fda9ba5c0722cb0c68456a08d5de2c26a3cc9adee4f6de250f4
BIGIN_FORM_XMIWTLD=1285e445112b8d9f854d6e3d70003655577adbe3544a5544801849d029d7fe759c025d416a1c97eeaa559d56a06a155a
EOF
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  umask 022
else
  say "Keeping existing settings in $ENV_FILE"
fi

# Encryption key for personal data at rest. Added once, never replaced:
# changing it would make the existing data unreadable.
if ! grep -q '^DATA_ENCRYPTION_KEY=..*' "$ENV_FILE"; then
  sed -i '/^DATA_ENCRYPTION_KEY=/d' "$ENV_FILE"
  printf '\n# Encrypts personal data at rest. BACK THIS UP: without it the data is unreadable.\nDATA_ENCRYPTION_KEY=%s\n' \
    "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >>"$ENV_FILE"
  warn "Generated DATA_ENCRYPTION_KEY in $ENV_FILE. Copy it somewhere safe (password manager)."
fi

# ---------- Code ----------
say "Installing the app code…"
NEW_DIR=/opt/magzest/app.new
rm -rf "$NEW_DIR"
mkdir -p "$NEW_DIR"
# Copy everything from the bundle except stray local data/secrets.
tar -C "$BUNDLE_DIR" --exclude='./server/node_modules' --exclude='./server/data' --exclude='./server/.env' -cf - . | tar -C "$NEW_DIR" -xf -
(cd "$NEW_DIR/server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$NEW_DIR"
chmod -R a+rX "$NEW_DIR"
rm -rf /opt/magzest/app.old
[ -d "$APP_DIR" ] && mv "$APP_DIR" /opt/magzest/app.old
mv "$NEW_DIR" "$APP_DIR"

# ---------- Service ----------
say "Setting up the background service…"
cat >/etc/systemd/system/magzest.service <<EOF
[Unit]
Description=Magzest website
After=network.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
# Extra sandboxing: no devices, kernel or cgroup changes, no new
# namespaces or setuid files, network limited to IP and local sockets,
# and files it creates aren't readable by other users.
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable magzest >/dev/null 2>&1
systemctl restart magzest

for i in $(seq 1 20); do
  curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 1
done
if ! curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  journalctl -u magzest -n 40 --no-pager
  if [ -d /opt/magzest/app.old ]; then
    warn "New version didn't start — rolling back to the previous one."
    rm -rf "$APP_DIR" && mv /opt/magzest/app.old "$APP_DIR" && systemctl restart magzest
  fi
  die "The app didn't start. See the log above."
fi
echo "App is running on port $PORT."

# ---------- Nginx ----------
say "Configuring Nginx…"
NGINX_SITE=/etc/nginx/sites-available/magzest
if [ ! -f "$NGINX_SITE" ]; then
  cat >"$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    client_max_body_size 6m;   # resume uploads are up to 5 MB

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # Vlog video uploads (admin only): the app allows up to 500 MB, so
    # this one route gets a larger body limit, a longer timeout and is
    # streamed straight through instead of buffered to nginx's disk.
    location = /api/admin/videos {
        client_max_body_size 510m;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
  ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/magzest
  rm -f /etc/nginx/sites-enabled/default
fi
# Don't reveal the Nginx version in headers and error pages.
echo "server_tokens off;" >/etc/nginx/conf.d/magzest-hardening.conf
nginx -t >/dev/null 2>&1 || { nginx -t; die "Nginx config test failed."; }
systemctl reload nginx

# ---------- Server hardening ----------
say "Hardening the server (firewall, fail2ban, automatic security updates)…"
apt-get install -y -qq ufw fail2ban unattended-upgrades >/dev/null

# Firewall: only SSH (on whatever port sshd really uses) and the website.
SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')
SSH_PORT=${SSH_PORT:-22}
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
echo "Firewall on: SSH (port $SSH_PORT), HTTP and HTTPS."

# Ban addresses that keep failing to log in over SSH.
cat >/etc/fail2ban/jail.d/magzest.conf <<EOF
[sshd]
enabled  = true
port     = $SSH_PORT
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban || warn "fail2ban didn't start; check: sudo journalctl -u fail2ban -n 30"

# Install security updates automatically every day.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# SSH: allow key logins only, but only when the account running this
# script already has a key, so nobody is locked out. Skip with
# SSH_KEYS_ONLY=no sudo bash deploy/setup-vps.sh
SSH_CONF=/etc/ssh/sshd_config.d/01-magzest.conf
LOGIN_USER=${SUDO_USER:-root}
LOGIN_HOME=$(getent passwd "$LOGIN_USER" | cut -d: -f6)
if [ "${SSH_KEYS_ONLY:-yes}" = "no" ]; then
  rm -f "$SSH_CONF"
  warn "SSH password logins left on (SSH_KEYS_ONLY=no)."
elif [ -s "$LOGIN_HOME/.ssh/authorized_keys" ] && [ -d /etc/ssh/sshd_config.d ]; then
  # 01- sorts before cloud-init's 50- file; for sshd the first value wins.
  cat >"$SSH_CONF" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    echo "SSH now accepts keys only (password logins are off)."
  else
    rm -f "$SSH_CONF"
    warn "SSH config check failed, so password logins were left on."
  fi
else
  warn "No SSH key found for $LOGIN_USER, so SSH password logins are still on."
  warn "Add a key (ssh-copy-id $LOGIN_USER@<server>) and run this script again to turn them off."
fi

# ---------- HTTPS ----------
SERVER_IP=$(curl -fs4 https://api.ipify.org || hostname -I | awk '{print $1}')
# getent fails while DNS isn't set up yet; that's expected, not fatal.
DNS_IP=$( (getent ahostsv4 "$DOMAIN" || true) | awk 'NR==1{print $1}')
WWW_IP=$( (getent ahostsv4 "www.$DOMAIN" || true) | awk 'NR==1{print $1}')
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  say "HTTPS certificate already installed (renews automatically)."
elif [ "$DNS_IP" = "$SERVER_IP" ] && [ "$WWW_IP" = "$SERVER_IP" ]; then
  say "Getting a free HTTPS certificate…"
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --agree-tos --register-unsafely-without-email --non-interactive \
    || warn "Certbot failed — run it again later: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
else
  warn "The domain doesn't point to this server yet (magzest.tech → ${DNS_IP:-none}, www → ${WWW_IP:-none}, this server → $SERVER_IP)."
  warn "Update the DNS records, wait for them to update, then run this script again to switch on HTTPS."
fi

# ---------- Done ----------
say "Done!"
echo "  Website:  http://$SERVER_IP   (https://www.$DOMAIN once DNS + HTTPS are set)"
echo "  Admin:    https://www.$DOMAIN/adminn/   (admin login only works over HTTPS)"
echo "  Logs:     sudo journalctl -u magzest -f"
echo "  Settings: sudo nano $ENV_FILE   then   sudo systemctl restart magzest"
if [ -n "${GENERATED:-}" ]; then
  echo
  echo "  Admin login: $ADMIN_EMAIL"
  echo "  Password:    $ADMIN_PASSWORD   <- save this now, it won't be shown again"
fi
