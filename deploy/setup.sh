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
# build-essential is insurance: the wheels we need are prebuilt for x86_64, but
# a fallback source build with no compiler fails obscurely.
apt-get install -y -qq \
  curl ca-certificates gnupg git tar \
  python3 python3-venv python3-dev build-essential ufw >/dev/null
note "$(python3 --version)"

say "Network"
# Everything after this needs GitHub. On a fresh Hetzner box the usual failure
# is IPv6 configured but not routing: github.com resolves to an AAAA record
# first and the connection dies, while IPv4 would have worked. Say which.
if curl -fsS -o /dev/null --max-time 20 https://github.com 2>/dev/null; then
  note "github.com reachable"
elif curl -4 -fsS -o /dev/null --max-time 20 https://github.com 2>/dev/null; then
  # Prefer IPv4 in the resolver so git, curl, pip and npm all stop trying the
  # broken route first. One line in gai.conf; the standard fix for this host.
  if ! grep -q '^precedence ::ffff:0:0/96  *100' /etc/gai.conf 2>/dev/null; then
    printf '\n# added by mackenziewalk setup.sh: IPv6 does not route from this box\nprecedence ::ffff:0:0/96  100\n' >> /etc/gai.conf
  fi
  note "github.com reachable over IPv4 only - IPv6 is configured but does not route"
  note "set /etc/gai.conf to prefer IPv4 so git, pip and npm stop trying it first"
  curl -fsS -o /dev/null --max-time 20 https://github.com 2>/dev/null \
    || die "still cannot reach github.com after preferring IPv4"
else
  die "cannot reach https://github.com at all:
         $(curl -sS -o /dev/null --max-time 20 https://github.com 2>&1 | tail -1)
       Check DNS (resolvectl status) and the default route (ip route)."
fi

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
# QDrive and qdrive-api are private, and this repository is public, so neither is
# vendored here. They are not cloned on the box either: that would need a deploy
# key on repositories we do not administer. deploy.sh ships them from a machine
# that already has them instead, which needs no permission anywhere.
VENDOR="$ROOT/vendor"
mkdir -p "$VENDOR"
if [ -d "$VENDOR/QDrive/src" ]; then
  note "engine already present"
else
  note "no engine yet - deploy.sh sends it"
fi

# Git, with the box's own configuration out of the way. A credential helper, a
# stored ~/.git-credentials, or an insteadOf rule that rewrites github.com urls
# to carry a token all make git present a credential this repository does not
# need - and GitHub answers a rejected credential with 401 even for a public
# repository. The remote url alone does not fix that. Ignoring global and system
# config does; the repository's own config is all that is left, and we set it.
clean_git () {
  # and never hang: a credential helper waiting on something can block a fetch
  # indefinitely, which on a box looks like a deploy that simply stopped
  local guard=(); command -v timeout >/dev/null && guard=(timeout 300)
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
    "${guard[@]}" git -c credential.helper= -c http.extraheader= "$@"
}
# What would have made git authenticate, with any secret masked.
git_auth_sources () {
  { git config --show-origin --get-regexp '^(url\..*\.insteadof|credential\.|http\.extraheader)' 2>/dev/null
    [ -f ~/.git-credentials ] && echo "file:~/.git-credentials  (exists)"
  } | sed -E 's#(https?://)[^@/[:space:]]+@#\1***@#g' | sed 's/^/         /'
}

say "Code"
# The clone stays owned by root and the game runs as an unprivileged user, so
# the process cannot rewrite the code it is running. Data lives outside the
# working tree entirely, which also keeps `git reset --hard` from ever being
# near a saved game.
if [ -d "$APP/.git" ]; then
  clean_git -C "$APP" remote set-url origin "$REPO"
  if ! err=$(clean_git -C "$APP" fetch --quiet origin "$BRANCH" 2>&1); then
    die "could not fetch $REPO
         git said: ${err:-nothing}
       The repository is public, so a 401 means this box presented a credential
       GitHub rejected. Where it might come from:
$(git_auth_sources)"
  fi
  clean_git -C "$APP" reset --quiet --hard "origin/$BRANCH"
  note "updated to $(git -C "$APP" log --oneline -1)"
else
  mkdir -p "$ROOT"
  if ! err=$(clean_git clone --quiet --branch "$BRANCH" "$REPO" "$APP" 2>&1); then
    die "could not clone $REPO
         git said: ${err:-nothing}
       If that mentions a username, authentication or 401, this box is
       presenting a credential GitHub rejected. Where it might come from:
$(git_auth_sources)
       If it mentions resolving or connecting, it is the network."
  fi
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
  # ...except for settings it predates. An .env written before a setting existed
  # leaves the service running on the default, and the default for where the
  # engine lives was wrong in a way nothing noticed until a world was entered.
  # Only ever appends; an existing value is never touched.
  ensure () {
    grep -qE "^[[:space:]]*$1=" "$ENV_FILE" && return 0
    printf '\n# added by setup.sh\n%s=%s\n' "$1" "$2" >> "$ENV_FILE"
    note "added $1"
  }
  ensure MW_QDRIVE_API_SRC "$ROOT/vendor/qdrive-api/src"
  ensure MW_STATE_DIR "$ROOT/state"
  ensure MW_LOG_FILE "$ROOT/logs/events.jsonl"
  ensure MW_STEPS 10
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

# qdrive-api's src/, sent by deploy.sh. Its modules are flat and one of them is
# also called engine.py, so it is loaded by path rather than pip-installed.
MW_QDRIVE_API_SRC=$ROOT/vendor/qdrive-api/src

# How many times a world is stepped before the round ends.
MW_STEPS=10

# While the prototype is private. Forward a message to @userinfobot for an id.
MW_ALLOW=
ENVEOF
  note "wrote $ENV_FILE - fill in the token"
fi

# Outside the branch above, because it has to hold for an .env that already
# existed too. `chown -R root:root` on the clone resets the group, and the
# service then cannot read its own configuration - which fails at import, before
# anything gets as far as saying why. root owns it so the game cannot rewrite its
# own token; the group membership is what lets it read at all.
chown "root:$USER_NAME" "$ENV_FILE"
chmod 640 "$ENV_FILE"

say "Dependencies"
# The install itself lives in remote.sh, which deploy.sh runs on every deploy -
# one implementation, exercised the same way each time. No engine yet on a fresh
# box, so it installs everything else and skips the engine check; no token yet,
# so it does not start the service.
MW_ROOT="$ROOT" MW_USER="$USER_NAME" MW_DEPS=1 MW_RESTART=0 bash "$APP/deploy/remote.sh"

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
