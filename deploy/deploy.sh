#!/usr/bin/env bash
#
# deploy.sh - push this working copy to the box and restart. Run from a laptop.
#
#   ./deploy/deploy.sh root@your.box --setup    first time
#   ./deploy/deploy.sh root@your.box            every time after
#   MW_HOST=root@your.box ./deploy/deploy.sh    if you tire of typing it
#
# The repository is private, so this ships the working copy over ssh rather
# than cloning - no deploy key on the box, and no need to push before trying
# something. The cost is that the box can drift from git, so it says so when
# what you are sending is not what is committed.
#
#   --setup      run setup.sh on the box first (idempotent)
#   --no-deps    skip the venv and npm install, when only code changed
#   --dry-run    show what rsync would send, change nothing

set -euo pipefail

APP=/opt/mackenziewalk
HOST=""
SETUP=0; DEPS=1; DRY=0

for a in "$@"; do
  case "$a" in
    --setup) SETUP=1 ;;
    --no-deps) DEPS=0 ;;
    --dry-run|-n) DRY=1 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) HOST="$a" ;;
  esac
done
HOST=${HOST:-${MW_HOST:-}}

say () { printf '\n  \033[1m%s\033[0m\n' "$*"; }
note () { printf '    %s\n' "$*"; }
die () { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }

[ -n "$HOST" ] || die "no host. ./deploy/deploy.sh root@your.box"
command -v rsync >/dev/null || die "rsync is not installed here"

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# --- what is actually being sent -------------------------------------------
if git rev-parse --git-dir >/dev/null 2>&1; then
  head=$(git log --oneline -1 2>/dev/null || echo 'no commits')
  dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  say "Sending"
  note "$head"
  [ "$dirty" -gt 0 ] && note "with $dirty uncommitted change(s) - the box will not match git"
fi

# state, .env and logs live on the box and must survive a deploy. They are
# excluded rather than deleted: rsync --delete leaves excluded paths alone.
RSYNC_ARGS=(-az --delete --human-readable
  --exclude '.git/'
  --exclude '.env'
  --exclude 'node_modules/'
  --exclude '.venv/'
  --exclude '__pycache__/'
  --exclude '*.pyc'
  --exclude 'state/'
  --exclude 'backups/'
  --exclude 'events.jsonl*'
  --exclude 'bot.log'
  --exclude '.selftest-state/'
  --exclude '.DS_Store')
[ "$DRY" -eq 1 ] && RSYNC_ARGS+=(--dry-run --itemize-changes)

say "Copying to $HOST:$APP"
# rsync has to exist at both ends, and this runs before setup.sh has had a
# chance to install anything. Most images have it; the ones that do not would
# otherwise fail here with a confusing "command not found" from the far side.
ssh "$HOST" "command -v rsync >/dev/null || {
    echo '    installing rsync on the box'
    DEBIAN_FRONTEND=noninteractive apt-get update -qq &&
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync; }" \
  || die "could not get rsync onto $HOST"
ssh "$HOST" "mkdir -p $APP"
rsync "${RSYNC_ARGS[@]}" ./ "$HOST:$APP/"

if [ "$DRY" -eq 1 ]; then
  say "Dry run - nothing changed"
  exit 0
fi

if [ "$SETUP" -eq 1 ]; then
  say "Provisioning"
  ssh "$HOST" "chmod +x $APP/deploy/*.sh && $APP/deploy/setup.sh"
fi

if [ "$DEPS" -eq 1 ]; then
  say "Dependencies"
  # Both installs are idempotent and quiet when there is nothing to do. The
  # python one reaches GitHub: pairwise-tomography installs from a git URL.
  ssh "$HOST" "set -e
    cd $APP
    [ -d model/.venv ] || python3 -m venv model/.venv
    model/.venv/bin/pip install -q --upgrade pip
    model/.venv/bin/pip install -q -r model/requirements.txt
    cd server && npm ci --omit=dev --silent
    chown -R mw:mw $APP"
  note "ok"
fi

say "Restarting"
# One poller per token: stop before start, never overlap.
ssh "$HOST" "systemctl restart mackenziewalk && sleep 6 && systemctl is-active mackenziewalk" \
  || die "the service did not come up. ssh $HOST journalctl -u mackenziewalk -n 40"

say "Status"
ssh "$HOST" "systemctl status mackenziewalk --no-pager -n 12 | tail -n 16"
printf '\n'
