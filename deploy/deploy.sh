#!/usr/bin/env bash
#
# deploy.sh - move the box to a commit and restart. Run from a laptop.
#
#   ./deploy/deploy.sh root@your.box                     current branch, latest
#   ./deploy/deploy.sh -i ~/.ssh/key root@your.box       with an ssh key
#   MW_HOST=root@your.box MW_SSH_KEY=~/.ssh/key \
#     ./deploy/deploy.sh                                 if you tire of typing them
#
# This half runs here: it checks what you are about to deploy is actually on
# GitHub, sends the QDrive engine, and hands the rest to deploy/remote.sh on the
# box. Everything the box does is in that one file, in plain bash, so it can be
# read - and run against a scratch tree - without unpicking ssh quoting.
#
# The engine travels from this machine because it lives in two private
# repositories that cannot be cloned on the box (no deploy keys on repositories
# we do not administer) and cannot be vendored here (this repository is public).
# It is pinned to whatever is checked out locally; MW_VENDOR_SRC says where.
#
#   -i PATH      ssh identity file, as `ssh -i` (or set MW_SSH_KEY)
#   --ref X      deploy a tag, branch or commit instead of the current branch
#   --no-deps    skip the installs, when only code changed
#   --no-engine  skip sending the engine, when only game code changed
#   --dry-run    say what would happen, change nothing

set -euo pipefail

ROOT_DIR=/opt/mackenziewalk
REPO=${MW_REPO:-https://github.com/olvrsmi/mackenziewalkcapital.git}
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

say ()  { printf '\n  \033[1m%s\033[0m\n' "$*"; }
note () { printf '    %s\n' "$*"; }
die ()  { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }

# --- transport: one for ssh and rsync alike, so a key reaches both -----------
SSH=(ssh)
if [ -n "$IDENTITY" ]; then
  IDENTITY=${IDENTITY/#\~/$HOME}
  [ -f "$IDENTITY" ] || die "no such key: $IDENTITY"
  perms=$(stat -f '%Lp' "$IDENTITY" 2>/dev/null || stat -c '%a' "$IDENTITY" 2>/dev/null)
  case "$perms" in
    600|400) ;;
    *) die "$IDENTITY is mode $perms; ssh will refuse it. chmod 600 $IDENTITY" ;;
  esac
  case "$IDENTITY" in
    *[[:space:]]*) die "$IDENTITY has a space in it; rsync cannot carry that through -e." ;;
  esac
  # IdentitiesOnly: an agent holding several keys cannot quietly use another
  SSH+=(-i "$IDENTITY" -o IdentitiesOnly=yes)
fi
RSH="${SSH[*]}"

if [ -z "$HOST" ]; then
  die "no host.
         ./deploy/deploy.sh [-i ~/.ssh/key] root@your.box
         Saw $ARGC argument(s): $ARGV. A host is anything not starting with -,
         so an option that swallowed it (-i without a path) leaves none.
         MW_HOST=${MW_HOST:-<unset>}."
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout"
[ -f deploy/remote.sh ] || die "deploy/remote.sh is missing"

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
  # Send the commit, not the name. A name has to be resolved again on the box,
  # against a clone whose branches are its own; a sha means one thing there and
  # here, and this one has just been checked against origin - so the box cannot
  # land anywhere except the commit named above.
  SEND=$local_sha
else
  note "$REF is not a local ref - trusting the box to find it"
  SEND=$REF
fi

# the engine source has to exist here before anything is touched on the box
SRC=""
if [ "$ENGINE" -eq 1 ]; then
  SRC=${VENDOR_SRC:-$(cd .. && pwd)/coupling-playground}
  for name in QDrive qdrive-api; do
    [ -d "$SRC/$name/src" ] || die "no $name at $SRC/$name.
         Set MW_VENDOR_SRC to the directory holding QDrive/ and qdrive-api/."
  done
fi

if [ "$DRY" -eq 1 ]; then
  say "Dry run"
  note "would move $HOST to $REF, $([ "$ENGINE" -eq 1 ] && echo "send the engine from $SRC, ")$([ "$DEPS" -eq 1 ] && echo "install dependencies, ")and restart"
  exit 0
fi

# --- the box must have been set up --------------------------------------------
"${SSH[@]}" "$HOST" "test -d $ROOT_DIR/app/.git" \
  || die "no clone at $ROOT_DIR/app on $HOST. Run setup.sh there first:
         ssh ${IDENTITY:+-i $IDENTITY }$HOST 'bash -s' < deploy/setup.sh"

# --- send the engine --------------------------------------------------------
if [ "$ENGINE" -eq 1 ]; then
  say "Engine"
  # Only src/ and the packaging travel. Not .git - which on these clones holds a
  # GitHub token in its remote url - and not notebooks, tests or virtualenvs.
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
  "${SSH[@]}" "$HOST" "! find $ROOT_DIR/vendor -maxdepth 3 -name .git | grep -q ." \
    || die "a .git directory reached the box - it carries a credential, remove it"
fi

# --- the rest happens on the box ---------------------------------------------
say "On $HOST"
"${SSH[@]}" "$HOST" "MW_ROOT=$ROOT_DIR MW_REPO='$REPO' MW_REF='$SEND' MW_DEPS=$DEPS MW_RESTART=1 bash -s" \
  < deploy/remote.sh
