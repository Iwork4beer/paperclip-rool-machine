#!/bin/sh
set -eu
[ "$#" -eq 1 ] || { echo "Usage: $0 /paperclip/backups/rool-machine-<timestamp>" >&2; exit 2; }
BACKUP=$1
PAPERCLIP_ROOT=${PAPERCLIP_ROOT:-/paperclip}
ADAPTER_TARGET="$PAPERCLIP_ROOT/external-adapters/rool-machine"
BRIDGE_TARGET="$PAPERCLIP_ROOT/rool-bridge/bridge.mjs"

[ -d "$BACKUP" ] || { echo "Backup not found: $BACKUP" >&2; exit 1; }

if [ -d "$BACKUP/adapter" ]; then
  rm -rf "$ADAPTER_TARGET"
  mkdir -p "$(dirname "$ADAPTER_TARGET")"
  cp -a "$BACKUP/adapter" "$ADAPTER_TARGET"
fi
if [ -f "$BACKUP/bridge.mjs" ]; then
  mkdir -p "$(dirname "$BRIDGE_TARGET")"
  cp -a "$BACKUP/bridge.mjs" "$BRIDGE_TARGET"
fi

echo "Rollback restored from $BACKUP. Restart Paperclip to reload it."
