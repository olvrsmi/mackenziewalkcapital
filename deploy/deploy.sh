#!/usr/bin/env bash
#
# deploy.sh - move the box to a commit and restart. Run from a laptop.
#
#   ./deploy/deploy.sh root@your.box                     current branch, latest
#   ./deploy/deploy.sh -i ~/.ssh/key root@your.box       with an ssh key
#   MW_HOST=root@your.box MW_SSH_KEY=~/.ssh/key \
#     ./deploy/deploy.sh                                 if you tire of typing them
#
# The box pulls from GitHub rather than being pushed to, so what runs there is
# always a commit you can name. The cost is that unpushed work cannot be
# deployed - which is checked here rather than discovered afterwards.
#
# The QDrive engine is the exception. It lives in two private repositories that
# cannot be cloned on the box - that would need deploy keys on repositories we do
# not administer - and cannot be vendored here, because this repository is
# public. So it is sent from this machine, which already has both, and is pinned
# to whatever is checked out locally. MW_VENDOR_SRC says where they are.
#
#   -i PATH      ssh identity file, as `ssh -i` (or set MW_SSH_KEY)
#   --ref X      deploy a tag, branch or commit instead of the current branch
#   --no-deps    skip the installs, when only code changed
#   --no-engine  skip sending the engine, when only game code changed
#   --dry-run    say what would happen, change nothing

set -euo pipefail

ROOT_DIR=/opt/mackenziewalk
APP="$ROOT_DIR/app"
HOST=""; REF=""; DEPS=1; DRY=0; ENGINE=1
IDENTITY=${MW_SSH_KEY:-}
VENDOR_SRC=${MW_VENDOR_SRC:-}

ARGV="$*"; ARGC=$#
while [ $# -gt 0 ]; do
  case "$1" in
    -i|--identity) IDENTITY=${2:-}; shift 2 ;;
    --ref) REF=${2:-}; shift 2 ;;
    --no-deps) DEPS=0; shift ;;
    --no-engine) ENGINE=0; shift ;;
    --dry-run|-n) DRY=1; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) HOST="$1"; shift ;;
  esac
done
HOST=${HOST:-${MW_HOST:-}}

say () { printf '\n  \033[1m%s\033[0m\n' "$*"; }
note () { printf '    %s\n' "$*"; }
die () { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }



# One transport, shared by ssh and rsync, so a key given here reaches both. With
# IdentitiesOnly the agent cannot quietly offer a different key and leave you
# wondering which one actually authenticated.
SSH=(ssh)
if [ -n "$IDENTITY" ]; then
  IDENTITY=${IDENTITY/#\~/$HOME}
  [ -f "$IDENTITY" ] || die "no such key: $IDENTITY"
  perms=$(stat -f '%Lp' "$IDENTITY" 2>/dev/null || stat -c '%a' "$IDENTITY" 2>/dev/null)
  case "$perms" in
    600|400) ;;
    *) die "$IDENTITY is mode $perms; ssh will refuse it. chmod 600 $IDENTITY" ;;
  esac
  # rsync's -e is split on whitespace by rsync itself, so a path with a space in
  # it would arrive as two arguments and fail somewhere much less obvious.
  case "$IDENTITY" in
    *[[:space:]]*) die "$IDENTITY has a space in it; rsync cannot carry that
         through -e. Move the key somewhere without one." ;;
  esac
  SSH+=(-i "$IDENTITY" -o IdentitiesOnly=yes)
fi
RSH="${SSH[*]}"

if [ -z "$HOST" ]; then
  die "no host.
         ./deploy/deploy.sh [-i ~/.ssh/key] root@your.box
         Saw $ARGC argument(s): $ARGV. A host is anything not
         starting with -, so an option that swallowed it (-i without a path,
         --ref without a value) leaves none. MW_HOST=${MW_HOST:-<unset>}."
fi

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
  note "would move $HOST to $REF, $([ "$ENGINE" -eq 1 ] && echo "send the engine, ")$([ "$DEPS" -eq 1 ] && echo "install dependencies, ")and restart"
  exit 0
fi

# --- move the box -----------------------------------------------------------
say "Updating $HOST"
"${SSH[@]}" "$HOST" "set -e
  cd $APP
  git fetch --quiet --tags origin
  git reset --quiet --hard '$REF' 2>/dev/null || git reset --quiet --hard 'origin/$REF'
  git log --oneline -1" | sed 's/^/    /'

if [ "$ENGINE" -eq 1 ]; then
  say "Engine"
  # Both clones sit next to this repository by default. Only src/ and the
  # packaging travel: not .git - which on these clones holds a GitHub token in
  # its remote URL - and not the notebooks, tests or virtualenvs.
  SRC=${VENDOR_SRC:-$(cd .. && pwd)/coupling-playground}
  for name in QDrive qdrive-api; do
    [ -d "$SRC/$name/src" ] || die "no $name at $SRC/$name.
         Set MW_VENDOR_SRC to the directory holding QDrive/ and qdrive-api/."
  done
  "${SSH[@]}" "$HOST" "mkdir -p $ROOT_DIR/vendor"
  for name in QDrive qdrive-api; do
    rsync -az --delete -e "$RSH" \
      --exclude '.git/' --exclude '.venv/' --exclude '__pycache__/' \
      --exclude '*.pyc' --exclude 'tests/' --exclude 'notebooks/' \
      --exclude 'scratchbook/' --exclude 'showcase/' --exclude '.DS_Store' \
      "$SRC/$name/" "$HOST:$ROOT_DIR/vendor/$name/"
    note "$name sent ($(git -C "$SRC/$name" log --oneline -1 2>/dev/null || echo 'not a checkout'))"
  done
  # belt and braces: the token must not reach the box even if an exclude changes
  "${SSH[@]}" "$HOST" "! find $ROOT_DIR/vendor -name '.git' -maxdepth 3 | grep -q . " \
    || die "a .git directory reached the box - it carries a credential, remove it"
fi

if [ "$DEPS" -eq 1 ]; then
  say "Dependencies"
  # Both are quiet when there is nothing to do. The python one reaches GitHub:
  # pairwise-tomography installs from a git URL.
  "${SSH[@]}" "$HOST" "set -e
    cd $APP
    model/.venv/bin/pip install -q -r model/requirements.txt
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
n=$("${SSH[@]}" "$HOST" "cd $APP/model && MW_QDRIVE_API_SRC=$ROOT_DIR/vendor/qdrive-api/src \
      sh -c 'echo {\"op\":\"worlds\"} | .venv/bin/python3 engine.py'" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const j=JSON.parse(s);process.stdout.write(String(j.ok?j.worlds.length:0))}
        catch{process.stdout.write("0")}})')
[ "${n:-0}" -gt 0 ] || die "the model did not answer on the box. ssh $HOST $APP/deploy/preflight.sh"
note "$n worlds playable"

say "Restarting"
# One poller per token: stop before start, never overlap.
"${SSH[@]}" "$HOST" "systemctl restart mackenziewalk && sleep 6 && systemctl is-active mackenziewalk" \
  >/dev/null || die "the service did not come up. ssh $HOST journalctl -u mackenziewalk -n 40"

say "Status"
"${SSH[@]}" "$HOST" "systemctl status mackenziewalk --no-pager -n 10 | tail -n 14"
printf '\n'
