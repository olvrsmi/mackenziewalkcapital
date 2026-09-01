#!/usr/bin/env bash
#
# setup.sh - build the box from nothing. Run once, as root:
#
#   ssh root@your.box 'bash -s' < deploy/setup.sh
#
# Self-contained on purpose: it clones the repository itself, so there is no
# chicken-and-egg about getting the code there first. Safe to re-run - it will
# not overwrite an .env that already exists, and it updates the clone rather
# than replacing it.
#
#   MW_REPO     which repository to clone
#   MW_BRANCH   which branch to track          (default main)
#   NODE_MAJOR  which Node to install          (default 22)

set -euo pipefail

REPO=${MW_REPO:-https://github.com/olvrsmi/mackenziewalkcapital.git}
BRANCH=${MW_BRANCH:-main}
ROOT=${MW_ROOT:-/opt/mackenziewalk}
APP="$ROOT/app"
USER_NAME=${MW_USER:-mw}
NODE_MAJOR=${NODE_MAJOR:-22}

say () { printf '\n  \033[1m%s\033[0m\n' "$*"; }
note () { printf '    %s\n' "$*"; }
die () { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root"
command -v apt-get >/dev/null || die "this expects Debian or Ubuntu"

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# git is needed twice over: to clone this, and because one model dependency
# installs straight from a git URL. build-essential is insurance - the wheels
# we need are prebuilt for x86_64, but a fallback source build with no
# compiler fails obscurely.
apt-get install -y -qq \
  curl ca-certificates gnupg git tar \
  python3 python3-venv python3-dev build-essential ufw >/dev/null
note "$(python3 --version)"

say "Node"
have=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)
if [ -n "${have:-}" ] && [ "$have" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  note "node $(node --version) already installed"
else
  # Ubuntu ships a Node past end of life, so take the LTS from NodeSource.
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  note "installed node $(node --version)"
fi

say "User"
if id "$USER_NAME" >/dev/null 2>&1; then
  note "$USER_NAME exists"
else
  adduser --system --group --home "$ROOT" --shell /usr/sbin/nologin "$USER_NAME"
  note "created $USER_NAME"
fi

say "Private dependencies"
# The QDrive engine lives in two private repositories, and this one is public,
# so neither can be vendored. GitHub refuses to reuse a deploy key across repos,
# so each gets its own key plus an ssh alias to select it. Keys are generated
# here and printed once; the clone below fails until they are registered.
VENDOR="$ROOT/vendor"
mkdir -p "$VENDOR" /root/.ssh
chmod 700 /root/.ssh
declare -A REPOS=( [qdrive-api]=moth-quantum/qdrive-api [QDrive]=moth-quantum/QDrive )
missing=0
for name in "${!REPOS[@]}"; do
  key="/root/.ssh/deploy_${name}"
  alias_host="gh-${name}"
  if [ ! -f "$key" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "mackenziewalk box -> ${REPOS[$name]}" -f "$key"
    missing=1
  fi
  if ! grep -q "^Host $alias_host\$" /root/.ssh/config 2>/dev/null; then
    printf 'Host %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n\n' \
      "$alias_host" "$key" >> /root/.ssh/config
  fi
  ssh-keyscan -t ed25519 github.com 2>/dev/null | grep -q . && \
    ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
done
sort -u -o /root/.ssh/known_hosts /root/.ssh/known_hosts 2>/dev/null || true
chmod 600 /root/.ssh/config 2>/dev/null || true

for name in "${!REPOS[@]}"; do
  if ! ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
       -T "git@gh-${name}" 2>&1 | grep -q "successfully authenticated"; then
    note "deploy key for ${REPOS[$name]} is not registered yet. Add this as a"
    note "read-only deploy key at https://github.com/${REPOS[$name]}/settings/keys :"
    printf '\n'
    cat "/root/.ssh/deploy_${name}.pub"
    printf '\n'
    missing=1
  fi
done
if [ "$missing" -eq 1 ]; then
  die "register the deploy key(s) above, then run this again"
fi

for name in "${!REPOS[@]}"; do
  if [ -d "$VENDOR/$name/.git" ]; then
    git -C "$VENDOR/$name" fetch --quiet origin && \
      git -C "$VENDOR/$name" reset --quiet --hard origin/HEAD 2>/dev/null || true
    note "$name updated"
  else
    git clone --quiet "git@gh-${name}:${REPOS[$name]}.git" "$VENDOR/$name" \
      || die "could not clone ${REPOS[$name]} - is the deploy key registered?"
    note "$name cloned"
  fi
done

say "Code"
# The clone stays owned by root and the game runs as an unprivileged user, so
# the process cannot rewrite the code it is running. Data lives outside the
# working tree entirely, which also keeps `git reset --hard` from ever being
# near a saved game.
if [ -d "$APP/.git" ]; then
  git -C "$APP" remote set-url origin "$REPO"
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" reset --quiet --hard "origin/$BRANCH"
  note "updated to $(git -C "$APP" log --oneline -1)"
else
  mkdir -p "$ROOT"
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP" \
    || die "could not clone $REPO - is it public, or does this box need a key?"
  note "cloned $(git -C "$APP" log --oneline -1)"
fi
chown -R root:root "$APP"

say "Data"
for d in state logs backups; do
  mkdir -p "$ROOT/$d"
  chown "$USER_NAME:$USER_NAME" "$ROOT/$d"
  chmod 750 "$ROOT/$d"
done
note "state, logs and backups under $ROOT, writable only by $USER_NAME"

say "Configuration"
ENV_FILE="$APP/server/.env"
if [ -f "$ENV_FILE" ]; then
  note ".env already present, left alone"
else
  cat > "$ENV_FILE" <<ENVEOF
# The deployed bot, from @BotFather. Keep the development bot's token OUT of
# this file: two pollers on one token evict each other and the game goes dead.
TELEGRAM_BOT_TOKEN=

# 24 = a game day per real hour. A round runs ~18 minutes, so someone who drops
# in for an hour sees three of them and a day close. Posting follows from this;
# there is nothing else to set.
MW_TIME_SCALE=24

# Outside the working tree, and the only places the service can write.
MW_STATE_DIR=$ROOT/state
MW_LOG_FILE=$ROOT/logs/events.jsonl

# qdrive-api's src/, cloned by setup.sh. Its modules are flat and one of them is
# also called engine.py, so it is loaded by path rather than pip-installed.
MW_QDRIVE_API_SRC=$ROOT/vendor/qdrive-api/src

# How many times a world is stepped before the round ends.
MW_STEPS=10

# While the prototype is private. Forward a message to @userinfobot for an id.
MW_ALLOW=
ENVEOF
  # readable by the service, writable by nobody but root
  chown "root:$USER_NAME" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  note "wrote $ENV_FILE - fill in the token"
fi

say "Dependencies"
[ -d "$APP/model/.venv" ] || python3 -m venv "$APP/model/.venv"
"$APP/model/.venv/bin/pip" install -q --upgrade pip
# QDrive comes from the clone rather than being fetched again over ssh, so the
# box needs GitHub access only in the step above.
"$APP/model/.venv/bin/pip" install -q \
  $(grep -vE '^\s*(#|$)|^qdrive @' "$APP/model/requirements.txt")
"$APP/model/.venv/bin/pip" install -q -e "$VENDOR/QDrive"
# Compile now, as root, so the read-only runtime never tries to write bytecode.
"$APP/model/.venv/bin/python3" -m compileall -q "$APP/model" >/dev/null 2>&1 || true
( cd "$APP/server" && npm ci --omit=dev --silent )
note "python and node dependencies installed"

say "Services"
for unit in mackenziewalk.service mackenziewalk-backup.service mackenziewalk-backup.timer; do
  [ -f "$APP/deploy/$unit" ] || die "$unit missing from the clone"
  install -m 644 "$APP/deploy/$unit" "/etc/systemd/system/$unit"
  note "$unit"
done
chmod +x "$APP"/deploy/*.sh
systemctl daemon-reload
systemctl enable mackenziewalk.service >/dev/null 2>&1 || true
systemctl enable --now mackenziewalk-backup.timer >/dev/null 2>&1 || true

say "Firewall"
# The bot polls outward and listens on nothing, so SSH is the only way in.
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
note "$(ufw status | head -1)"

say "Ready"
if grep -q '^TELEGRAM_BOT_TOKEN=$' "$ENV_FILE" 2>/dev/null; then
  note "1. put the token in $ENV_FILE"
  note "2. $APP/deploy/preflight.sh"
  note "3. systemctl start mackenziewalk"
else
  note "$APP/deploy/preflight.sh && systemctl start mackenziewalk"
fi
printf '\n'
