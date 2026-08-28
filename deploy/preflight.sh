#!/usr/bin/env bash
#
# preflight.sh - prove the stack works, on the box, before trusting it.
#
#   ssh root@your.box /opt/mackenziewalk/deploy/preflight.sh
#
# Every check here stands for something that has actually gone wrong or is
# likely to: a Python that qiskit will not import on, a native module with no
# binary for the architecture, a token that Telegram rejects, a state
# directory the service user cannot write to.
#
# MW_APP points it at a different checkout, which is how it gets tested
# somewhere other than the box.

set -uo pipefail

APP=${MW_APP:-/opt/mackenziewalk}
USER_NAME=${MW_USER:-mw}
SERVER="$APP/server"
MODEL="$APP/model"
VENV="$MODEL/.venv/bin/python3"

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
[ "$APP" = /opt/mackenziewalk ] || printf '  %s\n' \
  "(not the deploy path - the .env checks below describe a box, not a laptop)"
printf '\n'

# --- runtimes ---------------------------------------------------------------
if command -v node >/dev/null; then
  major=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [ "$major" -ge 18 ]; then ok "node $(node --version)"
  else bad "node $(node --version) is below the required 18"; fi
else bad "node is not installed"; fi

if [ -x "$VENV" ]; then
  ok "model venv  $("$VENV" --version 2>&1)"
  # 3.10.7 raises inside qiskit.passmanager on import; 3.10.13 is fine. The
  # only way to know is to import it.
  if err=$("$VENV" -c 'import qiskit' 2>&1); then
    ok "qiskit imports ($("$VENV" -c 'import qiskit;print(qiskit.__version__)' 2>/dev/null))"
  else
    bad "qiskit will not import: $(printf '%s' "$err" | tail -1)"
  fi
else
  bad "no venv at $VENV - run deploy.sh without --no-deps"
fi

# --- the model actually answering -------------------------------------------
if [ -x "$VENV" ] && [ -f "$MODEL/engine.py" ]; then
  out=$(cd "$MODEL" && echo '{"op":"worlds","readouts":8}' \
        | limited 180 "$VENV" engine.py 2>/dev/null)
  n=$(printf '%s' "$out" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);process.stdout.write(String(j.ok?j.worlds.length:0))}
      catch{process.stdout.write("0")}})' 2>/dev/null)
  if [ "${n:-0}" -gt 0 ]; then ok "model answers - $n circuits playable"
  else bad "the model returned nothing usable"; fi
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
ENV_FILE="$SERVER/.env"
if [ -f "$ENV_FILE" ]; then
  perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null)
  [ "$perms" = "600" ] && ok ".env is 600" || bad ".env is $perms, should be 600"
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
  if runuser -u "$USER_NAME" -- test -w "$SERVER/state" 2>/dev/null; then
    ok "$USER_NAME can write saved games"
  else
    bad "$USER_NAME cannot write $SERVER/state - chown -R $USER_NAME:$USER_NAME $APP"
  fi
else
  [ -w "$SERVER/state" ] && ok "state directory is writable" \
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

printf '\n  %d ok, %d failed, %d skipped\n\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
