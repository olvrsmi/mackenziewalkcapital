#!/usr/bin/env bash
#
# deploy.sh - move the box to a commit and restart. Run from a laptop.
#
#   ./deploy/deploy.sh root@your.box              current branch, latest
#   ./deploy/deploy.sh root@your.box --ref v0.2    a tag or commit
#   MW_HOST=root@your.box ./deploy/deploy.sh       if you tire of typing it
#
# The box pulls from GitHub rather than being pushed to, so what runs there is
# always a commit you can name. The cost is that unpushed work cannot be
# deployed - which is checked here rather than discovered afterwards.
#
#   --ref X      deploy a tag, branch or commit instead of the current branch
#   --no-deps    skip the installs, when only code changed
#   --dry-run    say what would happen, change nothing

set -euo pipefail

ROOT_DIR=/opt/mackenziewalk
APP="$ROOT_DIR/app"
HOST=""; REF=""; DEPS=1; DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=${2:-}; shift 2 ;;
    --no-deps) DEPS=0; shift ;;
    --dry-run|-n) DRY=1; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) HOST="$1"; shift ;;
  esac
done
HOST=${HOST:-${MW_HOST:-}}

say () { printf '\n  \033[1m%s\033[0m\n' "$*"; }
note () { printf '    %s\n' "$*"; }
die () { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }

[ -n "$HOST" ] || die "no host. ./deploy/deploy.sh root@your.box"

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
REF=${REF:-$BRANCH}

# --- is what you mean to deploy actually on GitHub? -------------------------
say "Checking"
dirty=$(git status --porcelain | wc -l | tr -d ' ')
[ "$dirty" -gt 0 ] && note "$dirty uncommitted change(s) - these will NOT be deployed"

if git rev-parse --verify --quiet "$REF" >/dev/null; then
  local_sha=$(git rev-parse "$REF")
  git fetch --quiet origin 2>/dev/null || note "could not reach origin to compare"
  if git rev-parse --verify --quiet "origin/$REF" >/dev/null; then
    remote_sha=$(git rev-parse "origin/$REF")
    if [ "$local_sha" != "$remote_sha" ]; then
      ahead=$(git rev-list --count "origin/$REF..$REF" 2>/dev/null || echo '?')
      die "origin/$REF is not what you have locally ($ahead commit(s) ahead).
         The box pulls from GitHub, so push first:  git push origin $REF"
    fi
  fi
  note "$REF is $(git log --oneline -1 "$REF")"
else
  note "$REF is not a local ref - trusting the box to find it"
fi

if [ "$DRY" -eq 1 ]; then
  say "Dry run"
  note "would move $HOST to $REF, ${DEPS:+re}install dependencies, and restart"
  exit 0
fi

# --- move the box -----------------------------------------------------------
say "Updating $HOST"
ssh "$HOST" "set -e
  cd $APP
  git fetch --quiet --tags origin
  git reset --quiet --hard '$REF' 2>/dev/null || git reset --quiet --hard 'origin/$REF'
  git log --oneline -1" | sed 's/^/    /'

if [ "$DEPS" -eq 1 ]; then
  say "Dependencies"
  # Both are quiet when there is nothing to do. The python one reaches GitHub:
  # pairwise-tomography installs from a git URL.
  ssh "$HOST" "set -e
    cd $ROOT_DIR
    # the private engine clones are outside the app, so a deploy has to move
    # them too or the game runs new code against an old engine
    for name in qdrive-api QDrive; do
      [ -d vendor/\$name/.git ] || continue
      git -C vendor/\$name fetch --quiet origin
      git -C vendor/\$name reset --quiet --hard origin/HEAD 2>/dev/null || true
    done
    cd $APP
    model/.venv/bin/pip install -q \$(grep -vE '^[[:space:]]*(#|\$)|^qdrive @' model/requirements.txt)
    model/.venv/bin/pip install -q -e $ROOT_DIR/vendor/QDrive
    model/.venv/bin/python3 -m compileall -q model >/dev/null 2>&1 || true
    cd server && npm ci --omit=dev --silent
    chown -R root:root $APP" || die "dependency install failed"
  note "ok"
fi

# --- does the model still answer? -------------------------------------------
# Cheap, and it catches a broken install before players do rather than after.
say "Smoke test"
# Runs the model exactly as the service will, engine location and all. On a
# warm cache this reads the specifications without loading qiskit at all, so it
# is nearly free; on a cold one it is the thing that proves the engine works.
n=$(ssh "$HOST" "cd $APP/model && MW_QDRIVE_API_SRC=$ROOT_DIR/vendor/qdrive-api/src \
      sh -c 'echo {\"op\":\"worlds\"} | .venv/bin/python3 engine.py'" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const j=JSON.parse(s);process.stdout.write(String(j.ok?j.worlds.length:0))}
        catch{process.stdout.write("0")}})')
[ "${n:-0}" -gt 0 ] || die "the model did not answer on the box. ssh $HOST $APP/deploy/preflight.sh"
note "$n worlds playable"

say "Restarting"
# One poller per token: stop before start, never overlap.
ssh "$HOST" "systemctl restart mackenziewalk && sleep 6 && systemctl is-active mackenziewalk" \
  >/dev/null || die "the service did not come up. ssh $HOST journalctl -u mackenziewalk -n 40"

say "Status"
ssh "$HOST" "systemctl status mackenziewalk --no-pager -n 10 | tail -n 14"
printf '\n'
