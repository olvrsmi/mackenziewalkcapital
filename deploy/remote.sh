#!/usr/bin/env bash
#
# remote.sh - the box's half of a deploy. Runs ON the box, as root.
#
# deploy.sh feeds it over ssh; setup.sh runs it for the shared install steps.
# Everything the box does lives here, in plain bash, so it reads without
# unpicking three layers of quoting - and so it can be run against a scratch
# tree with MW_ROOT, which is how it gets tested somewhere other than a box.
#
#   MW_ROOT      /opt/mackenziewalk          where everything lives
#   MW_REPO      the clone's origin           pinned on every run
#   MW_REF       commit, tag or branch        move the clone here; empty leaves it
#   MW_DEPS      1                            install or refresh dependencies
#   MW_RESTART   1                            restart the service at the end
#   MW_USER      mw                           the service user
#   MW_PYTHON    python3                      interpreter for a new venv

set -euo pipefail

ROOT=${MW_ROOT:-/opt/mackenziewalk}
APP=$ROOT/app
VENDOR=$ROOT/vendor
REPO=${MW_REPO:-https://github.com/olvrsmi/mackenziewalkcapital.git}
REF=${MW_REF:-}
DEPS=${MW_DEPS:-1}
RESTART=${MW_RESTART:-1}
USER_NAME=${MW_USER:-mw}
PY=${MW_PYTHON:-python3}
ENV_FILE=$APP/server/.env
VENV=$APP/model/.venv

say ()  { printf '\n  \033[1m%s\033[0m\n' "$*"; }
note () { printf '    %s\n' "$*"; }
die ()  { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }

# What this host can do. A scratch tree on a laptop has neither a service user
# nor systemd; the steps that need them say so and carry on, so the rest still
# gets exercised.
IS_ROOT=0;      [ "$(id -u)" -eq 0 ] && IS_ROOT=1
HAVE_USER=0;    id "$USER_NAME" >/dev/null 2>&1 && HAVE_USER=1
HAVE_SYSTEMD=0; command -v systemctl >/dev/null && [ -d /run/systemd/system ] && HAVE_SYSTEMD=1
as_service_user () {
  if [ "$IS_ROOT" -eq 1 ] && [ "$HAVE_USER" -eq 1 ]; then runuser -u "$USER_NAME" -- "$@"
  else "$@"; fi
}

[ -d "$APP/.git" ] || die "no clone at $APP. Run setup.sh on this box first."

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

# --- code -------------------------------------------------------------------
if [ -n "$REF" ]; then
  say "Code"
  clean_git -C "$APP" remote set-url origin "$REPO"
  strip_repo_auth "$APP"
  if ! err=$(clean_git -C "$APP" fetch --quiet --tags origin 2>&1); then
    die "could not fetch $REPO
         git said: ${err:-nothing}
       $(fetch_diagnosis)"
  fi
  # Where the box is meant to end up. origin/<ref> first, the bare name second.
  # The other order is why this box sat on its clone commit through every
  # deploy: a fetch moves origin/main and never the local branch of the same
  # name, so `reset --hard main` resets to the commit the box already had. It
  # succeeds - which is the whole trouble, because the fallback never ran and
  # the tree never moved, while the line below reported that stale commit as
  # though it had just arrived. A tag or a bare sha has no origin/ form, which
  # is the only reason the bare name is still tried at all.
  want=''
  for cand in "origin/$REF" "$REF"; do
    if want=$(clean_git -C "$APP" rev-parse --verify --quiet "$cand^{commit}"); then break; fi
    want=''
  done
  [ -n "$want" ] || die "the box cannot resolve $REF, even after fetching origin."
  clean_git -C "$APP" reset --quiet --hard "$want"
  # Say what the tree IS, having checked it is what was asked for, so a reset
  # that moves nothing can never again be reported as a deploy that landed.
  have=$(git -C "$APP" rev-parse HEAD)
  [ "$have" = "$want" ] || die "asked for $want but the tree is at $have."
  note "$(git -C "$APP" log --oneline -1)"
fi

# --- dependencies -----------------------------------------------------------
if [ "$DEPS" = 1 ]; then
  say "Dependencies"
  if [ ! -d "$VENV" ]; then
    "$PY" -m venv "$VENV"
    note "venv created with $("$VENV/bin/python3" --version)"
  fi
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$APP/model/requirements.txt"
  if [ -d "$VENDOR/QDrive/src" ]; then
    "$VENV/bin/pip" install -q -e "$VENDOR/QDrive"
    note "QDrive installed from $VENDOR/QDrive"
  else
    note "no engine in $VENDOR yet - deploy.sh sends it"
  fi
  # Compiled now, as root, so the read-only runtime never wants to write bytecode
  "$VENV/bin/python3" -m compileall -q "$APP/model" "$VENDOR" >/dev/null 2>&1 || true
  ( cd "$APP/server" && npm ci --omit=dev --silent )
  note "python and node dependencies installed"
fi

# --- permissions ------------------------------------------------------------
# Always, because the dependency step above (and any chown -R) undoes them.
say "Permissions"
if [ "$IS_ROOT" -eq 1 ]; then
  # the clone is root's, so the game cannot rewrite the code it is running
  chown -R root:root "$APP"
  # ...and so is the directory holding it, or the service user could rename it
  chown root:root "$ROOT"; chmod 755 "$ROOT"
  if [ "$HAVE_USER" -eq 1 ]; then
    # root owns .env so the game cannot rewrite its own token; the group is the
    # only reason the service can read it at all, and chown -R just took it away
    [ -f "$ENV_FILE" ] && { chown "root:$USER_NAME" "$ENV_FILE"; chmod 640 "$ENV_FILE"; }
    for d in state logs backups; do
      mkdir -p "$ROOT/$d"; chown "$USER_NAME:$USER_NAME" "$ROOT/$d"; chmod 750 "$ROOT/$d"
    done
    note "code read-only to $USER_NAME; state, logs, backups writable"
  else
    note "no user $USER_NAME on this host - ownership left as is"
  fi
else
  note "not root - ownership left as is"
fi

[ -f "$ENV_FILE" ] || die "no $ENV_FILE - setup.sh writes it"

# --- can the service actually start? ----------------------------------------
# These run as the service user, because that is who has to succeed. The .env
# was once unreadable to it with the mode looking correct, and the engine was
# once looked for in a directory nothing wrote to. Neither showed up in checks
# that ran as root.
say "As $USER_NAME"
as_service_user test -r "$ENV_FILE" \
  || die "$USER_NAME cannot read $ENV_FILE - the service dies at import.
         chown root:$USER_NAME $ENV_FILE && chmod 640 $ENV_FILE"
note ".env readable"

state_dir=$(cd "$APP/server" && as_service_user node -e '
  import("./env.mjs").then(() => process.stdout.write(process.env.MW_STATE_DIR || ""))' 2>/dev/null || true)
[ -n "$state_dir" ] || die "env.mjs did not load .env as $USER_NAME"
as_service_user test -w "$state_dir" \
  || die "$USER_NAME cannot write $state_dir (MW_STATE_DIR) - saved games would be lost"
note ".env loads; saved games go to $state_dir"

if [ -d "$VENDOR/qdrive-api/src" ]; then
  # scout, not worlds: worlds answers from the committed cache without starting
  # the engine, so it passes on a box where no world can be played
  spec=$(cd "$APP/model/specs" && ls *.json | grep -v '^_' | head -1); spec=${spec%.json}
  out=$(cd "$APP/model" && printf '{"op":"scout","circuit":"%s","readouts":2}' "$spec" \
        | as_service_user env MW_QDRIVE_API_SRC="$VENDOR/qdrive-api/src" PYTHONDONTWRITEBYTECODE=1 \
            "$VENV/bin/python3" engine.py 2>/dev/null || true)
  if printf '%s' "$out" | "$VENV/bin/python3" -c '
import sys, json
d = json.loads(sys.stdin.read() or "{}")
sys.exit(0 if d.get("ok") and len(d.get("z", [])) == 2 else 1)' 2>/dev/null; then
    note "engine runs - $spec stepped twice"
  else
    err=$(printf '%s' "$out" | "$VENV/bin/python3" -c 'import sys,json
try: print(json.loads(sys.stdin.read()).get("error","no output"))
except Exception: print("no output")' 2>/dev/null)
    die "the engine did not run as $USER_NAME: ${err:-no output}"
  fi
else
  note "no engine at $VENDOR yet - deploy.sh sends it (skipping the engine check)"
fi

# --- the service ------------------------------------------------------------
if [ "$RESTART" = 1 ]; then
  say "Service"
  if [ "$HAVE_SYSTEMD" -eq 0 ]; then
    note "no systemd on this host - not restarting"
  elif ! grep -qE '^TELEGRAM_BOT_TOKEN=.+' "$ENV_FILE"; then
    note "TELEGRAM_BOT_TOKEN is empty in $ENV_FILE - not starting."
    note "Fill it in, then:  systemctl start mackenziewalk"
  else
    # a unit that tripped its start limit refuses to restart until reset, so a
    # box brought down by a bug could not be recovered by deploying the fix
    systemctl reset-failed mackenziewalk 2>/dev/null || true
    systemctl restart mackenziewalk
    sleep 6
    if systemctl is-active --quiet mackenziewalk; then
      who=$(journalctl -u mackenziewalk -n 20 --no-pager 2>/dev/null | grep -o 'connected as @[A-Za-z0-9_]*' | tail -1)
      note "running${who:+ - $who}"
    else
      journalctl -u mackenziewalk -n 25 --no-pager 2>/dev/null | sed 's/^/    /'
      die "the service did not come up - the journal above says why"
    fi
  fi
fi
printf '\n'
