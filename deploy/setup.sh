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

# Git, with everything that could authenticate out of the way.
#
# The repository is public and needs no credential. A box that sends one anyway
# gets a 401: GitHub rejects a bad credential rather than falling back to
# anonymous access. Credentials reach git from three places, and each needs its
# own answer:
#
#   global and system config   nulled by the environment below
#   the ambient environment    prompts, askpass and injected -c all disabled
#   the clone's own config     read and stripped, because -c cannot name them
#
# That last one is why this failed for so long. A token is carried by keys whose
# names are URL-scoped - `http.https://github.com/.extraheader`, or an
# `insteadOf` rewrite - so there is no fixed name to override with -c, and a
# clone's own config is not what GIT_CONFIG_GLOBAL covers. Overriding the names
# we can think of is a losing game; reading the names the clone actually has is
# not.
clean_git () {
  # and never hang: a credential helper waiting on something can block a fetch
  # indefinitely, which on a box looks like a deploy that simply stopped
  local guard=() quiet
  if command -v timeout >/dev/null 2>&1; then guard=(timeout 300); fi
  # An askpass that exists on both: /bin/true on a box, /usr/bin/true on a
  # laptop. This script is meant to run against a scratch tree - that is how it
  # gets tested anywhere other than a box - and a path present on only one of
  # them turns every git call into "cannot run /bin/true", which is how a git
  # bug goes unnoticed here and only shows up over ssh.
  quiet=$(command -v true)
  # ${a[@]+...} because an empty array under `set -u` is an error in the bash a
  # laptop ships, though not in the one a box does.
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=0 \
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$quiet" \
    ${guard[@]+"${guard[@]}"} git -c credential.helper= -c http.extraheader= "$@"
}

# Config keys that can make git send a credential, matched by shape rather than
# by name - each of them can appear URL-scoped, so `http.extraheader` and
# `http.https://github.com/.extraheader` are one key wearing two names. include
# is here because a file we did not write can hold any of the others, and a
# clone this script created has no reason to include one.
GIT_AUTH_KEYS='(^credential\.|^include\.|^includeif\.|\.insteadof$|\.pushinsteadof$|\.extraheader$|^http\.cookiefile$)'
MASK='s#(https?://)[^@/[:space:]]+@#\1***@#g'

# Take them out of a clone's own config, saying which. Only --local: global and
# system are already nulled above, and are not ours to rewrite.
strip_repo_auth () {
  local dir=$1 keys key
  # Collected first, and `|| true`, because a clean clone matches nothing and
  # grep says so with exit 1 - which under `set -o pipefail` is the pipeline's
  # status and under `set -e` is the end of the deploy. The failure mode is a
  # script that stops dead after printing "Code", on exactly the boxes where
  # there is nothing wrong.
  keys=$(clean_git -C "$dir" config --local --list --name-only 2>/dev/null \
           | grep -Ei "$GIT_AUTH_KEYS" || true)
  [ -n "$keys" ] || return 0
  while read -r key; do
    [ -n "$key" ] || continue
    clean_git -C "$dir" config --local --unset-all "$key" 2>/dev/null || true
    note "removed $(printf '%s' "$key" | sed -E "$MASK") from the clone's config"
  done <<<"$keys"
}

# Whether this box can reach the repository with no clone in play. Run from a
# directory that is not a repository, so only global and system config could
# apply - and clean_git nulls both. It tells "the clone is poisoned" apart from
# "this box cannot reach GitHub", which look identical from inside a failed
# fetch.
reaches_github () {
  local tmp; tmp=$(mktemp -d); local ok=1
  if ( cd "$tmp" && clean_git ls-remote --heads "$REPO" >/dev/null 2>&1 ); then ok=0; fi
  rmdir "$tmp" 2>/dev/null || true
  return $ok
}

# What could still be authenticating: key names, never values. A name is enough
# to find the culprit and a value is the token itself - though a name can carry
# one too, in an insteadOf url, so names are masked as well.
git_auth_sources () {
  local dir=${1:-} found=''
  found=$( { if [ -n "$dir" ]; then
               clean_git -C "$dir" config --local --list --name-only 2>/dev/null \
                 | sed 's#^#the clone:  #' || true
             fi
             git config --global --list --name-only 2>/dev/null | sed 's#^#global:     #' || true
             git config --system --list --name-only 2>/dev/null | sed 's#^#system:     #' || true
           } | grep -Ei "$GIT_AUTH_KEYS" || true )
  if [ -f "$HOME/.git-credentials" ]; then found="$found
file:       ~/.git-credentials"; fi
  if [ -f "$HOME/.netrc" ]; then found="$found
file:       ~/.netrc"; fi
  printf '%s\n' "${found:-nothing this script knows how to look for}" \
    | sed -E "$MASK" | sed 's/^/         /'
}

# Why the fetch failed, in the terms that tell you what to do about it.
fetch_diagnosis () {
  if reaches_github; then
    printf 'This box reaches the repository fine from outside the clone, so what
       authenticates is in %s/.git/config. Everything there that
       could, which this run has already tried to remove:
%s' "$APP" "$(git_auth_sources "$APP")"
  else
    printf 'This box cannot reach the repository from outside the clone either,
       so the clone is not the cause. Either the network blocks it, or the
       environment authenticates:
%s' "$(git_auth_sources)"
  fi
}

say "Code"
# The clone stays owned by root and the game runs as an unprivileged user, so
# the process cannot rewrite the code it is running. Data lives outside the
# working tree entirely, which also keeps `git reset --hard` from ever being
# near a saved game.
if [ -d "$APP/.git" ]; then
  clean_git -C "$APP" remote set-url origin "$REPO"
  strip_repo_auth "$APP"
  if ! err=$(clean_git -C "$APP" fetch --quiet origin "$BRANCH" 2>&1); then
    die "could not fetch $REPO
         git said: ${err:-nothing}
       $(fetch_diagnosis)"
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
       (a clone cannot be stripped before it exists, so this one is on the box)
       If it mentions resolving or connecting, it is the network."
  fi
  strip_repo_auth "$APP"
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
