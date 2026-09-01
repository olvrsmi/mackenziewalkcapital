#!/usr/bin/env bash
#
# preflight.sh - prove the stack works, on the box, before trusting it.
#
#   ssh root@your.box /opt/mackenziewalk/app/deploy/preflight.sh
#
# Every check here stands for something that has actually gone wrong or is
# likely to: a Python that qiskit will not import on, a native module with no
# binary for the architecture, a token that Telegram rejects, a state
# directory the service user cannot write to.
#
# MW_APP points it at a different checkout, which is how it gets tested
# somewhere other than the box.

set -uo pipefail

ROOT=${MW_ROOT:-/opt/mackenziewalk}
# On the box the clone sits in app/ with data beside it; pointed at a plain
# checkout it uses that directly, which is how this gets tested off the box.
if [ -n "${MW_APP:-}" ]; then APP=$MW_APP
elif [ -d "$ROOT/app" ]; then APP=$ROOT/app
else APP=$ROOT; fi
USER_NAME=${MW_USER:-mw}
SERVER="$APP/server"
MODEL="$APP/model"
VENV="$MODEL/.venv/bin/python3"
ENV_FILE="$SERVER/.env"

# Read the paths the service will actually use rather than assuming them.
from_env () { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
STATE=$(from_env MW_STATE_DIR); STATE=${STATE:-$SERVER/state}
LOGF=$(from_env MW_LOG_FILE);   LOGF=${LOGF:-$SERVER/events.jsonl}

# `timeout` is GNU and not on every host (macOS has none by default), but its
# absence must not read as a broken model.
if command -v timeout >/dev/null; then TIMEOUT_BIN=timeout
elif command -v gtimeout >/dev/null; then TIMEOUT_BIN=gtimeout
else TIMEOUT_BIN=""; fi
limited () { local s=$1; shift; if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$s" "$@"; else "$@"; fi; }

pass=0; fail=0; skip=0
ok ()   { printf '  \033[32mok\033[0m    %s\n' "$*"; pass=$((pass+1)); }
bad ()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }
skipf () { printf '  --    %s\n' "$*"; skip=$((skip+1)); }

printf '\n  %s\n' "$APP"
[ "$APP" = /opt/mackenziewalk/app ] || printf '  %s\n' \
  "(not the deploy path - the .env checks below describe a box, not a laptop)"
printf '\n'

# --- runtimes ---------------------------------------------------------------
if command -v node >/dev/null; then
  major=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [ "$major" -ge 18 ]; then ok "node $(node --version)"
  else bad "node $(node --version) is below the required 18"; fi
else bad "node is not installed"; fi

# --- is the box running the code you think it is? ---------------------------
# A setup that quietly stopped updating the clone leaves the box on old code
# with new scripts driving it, which surfaces as errors from files nobody is
# looking at any more.
if [ -d "$APP/.git" ]; then
  head=$(git -C "$APP" log --oneline -1 2>/dev/null || echo unknown)
  ok "app at $head"
  if ! git -C "$APP" diff --quiet 2>/dev/null; then
    bad "the clone has local modifications - a deploy will discard them"
  fi
else
  skipf "app is not a git checkout"
fi

if [ -x "$VENV" ]; then
  pyver=$("$VENV" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)
  # the QDrive engine declares >=3.12, and 3.10.7 additionally raises inside
  # qiskit.passmanager on import. Both are only knowable by trying.
  if [ "$(printf '%s\n3.12\n' "$pyver" | sort -V | head -1)" = "3.12" ]; then
    ok "model venv  $("$VENV" --version 2>&1)"
  else
    bad "model venv is $pyver; the QDrive engine needs 3.12 or newer"
  fi
  for mod in qiskit qiskit_aer qdrive qiskit_qasm3_import; do
    if err=$("$VENV" -c "import $mod" 2>&1); then
      ok "$mod imports"
    else
      bad "$mod will not import: $(printf '%s' "$err" | tail -1)"
    fi
  done
else
  bad "no venv at $VENV - run deploy.sh without --no-deps"
fi

# The engine source is cloned, not vendored, so a deploy that lost its GitHub
# access leaves the venv fine and this directory missing.
SRC=$(from_env MW_QDRIVE_API_SRC); SRC=${SRC:-$ROOT/vendor/qdrive-api/src}
if [ -f "$SRC/engine.py" ] && [ -f "$SRC/backend.py" ]; then
  ok "QDrive engine source at $SRC"
else
  bad "no QDrive engine at $SRC - deploy.sh sends it; run a deploy without --no-engine"
fi

# --- the model actually answering -------------------------------------------
if [ -x "$VENV" ] && [ -f "$MODEL/engine.py" ]; then
  # Deliberately not `worlds`: that answers from the committed character cache
  # without ever starting the engine, so it passes on a box where no world can
  # actually be played. Scout runs it.
  spec=$(cd "$MODEL" && ls specs/*.json 2>/dev/null | grep -v '_stats' | head -1)
  spec=$(basename "${spec:-none.json}" .json)
  out=$(cd "$MODEL" && MW_QDRIVE_API_SRC="$SRC" \
        printf '{"op":"scout","circuit":"%s","readouts":2}' "$spec" \
        | (cd "$MODEL" && MW_QDRIVE_API_SRC="$SRC" limited 300 "$VENV" engine.py 2>/dev/null))
  n=$(printf '%s' "$out" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);process.stdout.write(String(j.ok?j.z.length:0))}
      catch{process.stdout.write("0")}})' 2>/dev/null)
  if [ "${n:-0}" -gt 0 ]; then ok "the engine runs - $spec stepped $n times"
  else bad "the engine did not run - a world cannot be played"; fi
else
  skipf "model call (no venv)"
fi

# --- native modules ---------------------------------------------------------
# @napi-rs/canvas ships prebuilt binaries per platform. A missing one for this
# architecture is the failure that would only show when a player asks for an
# image, which is every round.
if [ -d "$SERVER/node_modules" ]; then
  if (cd "$SERVER" && node -e '
      const {createCanvas}=require("@napi-rs/canvas")
      const c=createCanvas(64,64); const x=c.getContext("2d")
      x.fillStyle="#fff"; x.fillRect(0,0,64,64)
      if(!c.toBuffer("image/png").length) process.exit(1)' 2>/dev/null); then
    ok "canvas renders on this architecture"
  else
    bad "@napi-rs/canvas will not render - no prebuilt binary for this platform?"
  fi
  (cd "$SERVER" && node -e 'require("grammy")' 2>/dev/null) \
    && ok "grammy loads" || bad "grammy will not load"
else
  bad "no node_modules in $SERVER"
fi

# --- configuration ----------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null)
  case "$perms" in
    600|640) ok ".env is $perms" ;;
    *) bad ".env is $perms - should be 640 on the box, 600 on a laptop" ;;
  esac
  # presence only - the value is never printed or logged
  if grep -qE '^TELEGRAM_BOT_TOKEN=.+' "$ENV_FILE"; then ok "a deployed token is set"
  else bad "TELEGRAM_BOT_TOKEN is empty in $ENV_FILE"; fi
  if grep -qE '^TELEGRAM_BOT_TOKEN_LOCAL=.+' "$ENV_FILE"; then
    bad "the development token is in the box's .env - two pollers evict each other"
  else ok "no development token on the box"; fi
  scale=$(grep -E '^MW_TIME_SCALE=' "$ENV_FILE" | cut -d= -f2)
  [ -n "${scale:-}" ] && ok "time scale ${scale}x (a game day per $((86400/scale/60)) real min)" \
    || skipf "MW_TIME_SCALE unset, defaulting to 1"
else
  bad "no .env at $ENV_FILE"
fi

# --- writable state ---------------------------------------------------------
if id "$USER_NAME" >/dev/null 2>&1 && command -v runuser >/dev/null && [ "$(id -u)" -eq 0 ]; then
  for d in "$STATE" "$(dirname "$LOGF")"; do
    if runuser -u "$USER_NAME" -- test -w "$d" 2>/dev/null; then
      ok "$USER_NAME can write $d"
    else
      bad "$USER_NAME cannot write $d - chown $USER_NAME:$USER_NAME $d"
    fi
  done
  # the flip side: the service must NOT be able to rewrite its own code
  if runuser -u "$USER_NAME" -- test -w "$SERVER/bot.mjs" 2>/dev/null; then
    bad "$USER_NAME can write the code it runs - chown -R root:root $APP"
  else
    ok "the code is read-only to $USER_NAME"
  fi
else
  [ -w "$STATE" ] && ok "state directory is writable" \
    || skipf "state directory ownership (not root, or no such user)"
fi

# --- the service ------------------------------------------------------------
if command -v systemctl >/dev/null; then
  if systemctl list-unit-files mackenziewalk.service >/dev/null 2>&1 &&
     systemctl cat mackenziewalk.service >/dev/null 2>&1; then
    ok "mackenziewalk.service installed"
    state=$(systemctl is-active mackenziewalk 2>/dev/null || true)
    [ "$state" = "active" ] && ok "service is running" \
      || skipf "service is $state (start it once the checks pass)"
    systemctl is-enabled mackenziewalk-backup.timer >/dev/null 2>&1 \
      && ok "daily backup timer enabled" || bad "backup timer is not enabled"
  else
    bad "mackenziewalk.service is not installed - run setup.sh"
  fi
else
  skipf "systemd checks (not a systemd host)"
fi

# --- the game's own tests ---------------------------------------------------
if [ -f "$SERVER/selftest.mjs" ] && [ -d "$SERVER/node_modules" ]; then
  if (cd "$SERVER" && MW_STATE_DIR=/tmp/mw-preflight limited 600 node selftest.mjs \
        >/tmp/mw-selftest.log 2>&1); then
    ok "selftest passes ($(grep -c '^  pass' /tmp/mw-selftest.log) checks)"
  else
    bad "selftest failed - see /tmp/mw-selftest.log"
    sed -n 's/^  FAIL/        FAIL/p' /tmp/mw-selftest.log | head -5
  fi
  rm -rf /tmp/mw-preflight
else
  skipf "selftest"
fi

# --- the model's own assumptions -------------------------------------------
if [ -f "$MODEL/selftest.py" ] && [ -x "$VENV" ] && [ -f "$SRC/engine.py" ]; then
  if out=$(cd "$MODEL" && MW_QDRIVE_API_SRC="$SRC" limited 600 "$VENV" selftest.py 2>&1); then
    ok "model selftest passes ($(printf '%s' "$out" | grep -c '^  pass') checks)"
  else
    bad "model selftest failed"
    printf '%s\n' "$out" | sed -n 's/^  FAIL/        FAIL/p' | head -5
  fi
else
  skipf "model selftest"
fi

printf '\n  %d ok, %d failed, %d skipped\n\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
