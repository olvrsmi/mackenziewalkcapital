#!/usr/bin/env bash
#
# setup.sh - prepare the box. Run once, as root, ON the server.
#
# deploy.sh --setup does this for you. To run it by hand, after the code is in
# place:  ssh root@box /opt/mackenziewalk/deploy/setup.sh
#
# Installs the runtimes, makes an unprivileged user to run the game as, writes
# an .env for you to fill in, and registers the services. Safe to re-run: it
# will not overwrite an .env that already exists.

set -euo pipefail

APP=${MW_APP:-/opt/mackenziewalk}
USER_NAME=${MW_USER:-mw}
NODE_MAJOR=${NODE_MAJOR:-22}
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

say () { printf '\n  \033[1m%s\033[0m\n' "$*"; }
note () { printf '    %s\n' "$*"; }
die () { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root"
command -v apt-get >/dev/null || die "this expects Debian or Ubuntu"

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# git is not optional: one model dependency installs straight from a git URL.
# build-essential is insurance - the wheels we need are prebuilt for x86_64,
# but if pip ever falls back to a source build, no compiler fails obscurely.
apt-get install -y -qq \
  curl ca-certificates gnupg git rsync tar \
  python3 python3-venv python3-dev build-essential ufw >/dev/null
note "$(python3 --version)"

say "Node"
have=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)
if [ -n "${have:-}" ] && [ "$have" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  note "node $(node --version) already installed"
else
  # Ubuntu ships a Node that is past end of life, so take the LTS from
  # NodeSource. NODE_MAJOR pins a different one.
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  note "installed node $(node --version)"
fi

say "User and directories"
if id "$USER_NAME" >/dev/null 2>&1; then
  note "user $USER_NAME exists"
else
  adduser --system --group --home "$APP" --shell /usr/sbin/nologin "$USER_NAME"
  note "created $USER_NAME"
fi
mkdir -p "$APP"/{server/state,backups}
chown -R "$USER_NAME:$USER_NAME" "$APP"

say "Configuration"
ENV_FILE="$APP/server/.env"
if [ -f "$ENV_FILE" ]; then
  note ".env already present, left alone"
else
  cat > "$ENV_FILE" <<'ENVEOF'
# The deployed bot, from @BotFather. Keep the development bot's token OUT of
# this file: two pollers on one token evict each other and the game goes dead.
TELEGRAM_BOT_TOKEN=

# 24 = a game day per real hour. A round runs ~18 minutes, so someone who drops
# in for an hour sees three of them and a day close. Posting follows from this;
# there is nothing else to set.
MW_TIME_SCALE=24

# While the prototype is private. Forward a message to @userinfobot for an id.
MW_ALLOW=
ENVEOF
  chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  note "wrote $ENV_FILE - fill in the token before starting"
fi

say "Services"
for unit in mackenziewalk.service mackenziewalk-backup.service mackenziewalk-backup.timer; do
  [ -f "$HERE/$unit" ] || die "$unit missing from $HERE - deploy the code first"
  install -m 644 "$HERE/$unit" "/etc/systemd/system/$unit"
  note "$unit"
done
chmod +x "$HERE/backup.sh" "$HERE/preflight.sh" 2>/dev/null || true
systemctl daemon-reload
systemctl enable mackenziewalk.service >/dev/null 2>&1 || true
systemctl enable --now mackenziewalk-backup.timer >/dev/null 2>&1 || true

say "Firewall"
# The bot polls outward and listens for nothing, so SSH is the only way in.
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
note "$(ufw status | head -1)"

say "Ready"
if grep -q '^TELEGRAM_BOT_TOKEN=$' "$ENV_FILE" 2>/dev/null; then
  note "put the bot token in $ENV_FILE, then: systemctl start mackenziewalk"
else
  note "systemctl start mackenziewalk"
fi
printf '\n'
