#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PAPERCLIP_ROOT=${PAPERCLIP_ROOT:-/paperclip}
ADAPTER_TARGET="$PAPERCLIP_ROOT/external-adapters/rool-machine"
BRIDGE_DIR="$PAPERCLIP_ROOT/rool-bridge"
BRIDGE_TARGET="$BRIDGE_DIR/bridge.mjs"
BACKUP_ROOT="$PAPERCLIP_ROOT/backups"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$BACKUP_ROOT/rool-machine-$STAMP"

[ -f "$ROOT/RUNTIME.sha256" ] || { echo "ERROR: RUNTIME.sha256 missing" >&2; exit 1; }
(
  cd "$ROOT"
  sha256sum -c RUNTIME.sha256
)

mkdir -p "$BACKUP_ROOT" "$BRIDGE_DIR"

HAS_OLD=0
if [ -e "$ADAPTER_TARGET" ] || [ -e "$BRIDGE_TARGET" ]; then
  mkdir -p "$BACKUP_DIR"
  if [ -d "$ADAPTER_TARGET" ]; then cp -a "$ADAPTER_TARGET" "$BACKUP_DIR/adapter"; HAS_OLD=1; fi
  if [ -f "$BRIDGE_TARGET" ]; then cp -a "$BRIDGE_TARGET" "$BACKUP_DIR/bridge.mjs"; HAS_OLD=1; fi
fi

rm -rf "$ADAPTER_TARGET"
mkdir -p "$ADAPTER_TARGET"
cp -a "$ROOT/adapter/." "$ADAPTER_TARGET/"
cp "$ROOT/bridge/bridge.mjs" "$BRIDGE_TARGET"

find "$ADAPTER_TARGET" -type d -exec chmod 755 {} \;
find "$ADAPTER_TARGET" -type f -exec chmod 644 {} \;
chmod 644 "$BRIDGE_TARGET"

PAPERCLIP_ROOT="$PAPERCLIP_ROOT" "$ROOT/verify-install.sh"

echo
echo "Installed Paperclip Rool adapter 0.2.0 / bridge 0.4.0."
if [ "$HAS_OLD" -eq 1 ]; then echo "Backup: $BACKUP_DIR"; fi
echo "Restart Paperclip to reload the external adapter and UI parser."
