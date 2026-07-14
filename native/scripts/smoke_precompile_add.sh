#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/runtime"
SMOKE_DIR="$RUNTIME_DIR/smoke"

RPC_URL="${FHEBC_BESU_RPC_URL:-http://127.0.0.1:8545}"
TFHE_TOOL="${FHEBC_TFHE_TOOL:-$RUNTIME_DIR/native/tfhe_tool}"
CLIENT_KEY="${FHEBC_TFHE_CLIENT_KEY_PATH:-$RUNTIME_DIR/keys/client.key}"
SERVER_KEY="${FHEBC_TFHE_SERVER_KEY_PATH:-$RUNTIME_DIR/keys/server.key}"
GAS_HEX="${FHEBC_PRECOMPILE_SMOKE_GAS_HEX:-0x1e8480}"

mkdir -p "$SMOKE_DIR" "$(dirname "$CLIENT_KEY")"

if [[ ! -x "$TFHE_TOOL" ]]; then
  echo "tfhe_tool not executable: $TFHE_TOOL" >&2
  exit 1
fi

if [[ ! -f "$CLIENT_KEY" || ! -f "$SERVER_KEY" ]]; then
  "$TFHE_TOOL" keygen "$CLIENT_KEY" "$SERVER_KEY"
fi

LEFT_CT="$SMOKE_DIR/precompile-add-left.ct"
RIGHT_CT="$SMOKE_DIR/precompile-add-right.ct"
OUT_CT="$SMOKE_DIR/precompile-add-result.ct"

"$TFHE_TOOL" encrypt-u32-compressed "$CLIENT_KEY" 10 "$LEFT_CT"
"$TFHE_TOOL" encrypt-u32-compressed "$CLIENT_KEY" 32 "$RIGHT_CT"
python3 "$SCRIPT_DIR/call_besu_precompile_add.py" "$RPC_URL" "$LEFT_CT" "$RIGHT_CT" "$OUT_CT" "$GAS_HEX"

clear_value="$(FHEBC_TFHE_SERVER_KEY_PATH="$SERVER_KEY" "$TFHE_TOOL" decrypt-u32 "$CLIENT_KEY" "$OUT_CT" | tail -n 1)"
echo "clear_value=$clear_value"

if [[ "$clear_value" != "42" ]]; then
  echo "Unexpected precompile add result: $clear_value" >&2
  exit 1
fi
