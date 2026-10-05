#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PAPERCLIP_ROOT=${PAPERCLIP_ROOT:-/paperclip}
ADAPTER_TARGET="$PAPERCLIP_ROOT/external-adapters/rool-machine"
BRIDGE_TARGET="$PAPERCLIP_ROOT/rool-bridge/bridge.mjs"

check_same() {
  src="$1"; dst="$2"
  [ -f "$dst" ] || { echo "FAIL missing $dst" >&2; exit 1; }
  [ "$(sha256sum "$src" | awk '{print $1}')" = "$(sha256sum "$dst" | awk '{print $1}')" ] || {
    echo "FAIL checksum mismatch: $dst" >&2; exit 1;
  }
  echo "PASS $dst"
}

check_same "$ROOT/adapter/index.js" "$ADAPTER_TARGET/index.js"
check_same "$ROOT/adapter/ui-parser.js" "$ADAPTER_TARGET/ui-parser.js"
check_same "$ROOT/adapter/package.json" "$ADAPTER_TARGET/package.json"
check_same "$ROOT/bridge/bridge.mjs" "$BRIDGE_TARGET"
echo "PASS installation verification"
