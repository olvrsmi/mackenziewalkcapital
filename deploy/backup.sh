#!/usr/bin/env bash
#
# backup.sh - tar the saved games. Run daily by mackenziewalk-backup.timer.
#
# There is no database; a player's whole history is one small JSON file. The
# thing worth protecting is that they do not have to start again.

set -euo pipefail

APP=${MW_APP:-/opt/mackenziewalk}
STATE="$APP/server/state"
DEST="$APP/backups"
KEEP=${MW_BACKUP_KEEP:-14}

[ -d "$STATE" ] || { echo "no state directory at $STATE"; exit 0; }
mkdir -p "$DEST"

stamp=$(date -u +%Y%m%d-%H%M%S)
out="$DEST/state-$stamp.tar.gz"
tar czf "$out" -C "$APP/server" state
echo "$(du -h "$out" | cut -f1)  $out"

# keep the most recent KEEP, drop the rest
ls -1t "$DEST"/state-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "removed $old"
done
