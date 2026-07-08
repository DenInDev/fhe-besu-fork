#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$FORK_DIR/.." && pwd)"

LOCAL_SUITE_BESU_NETWORK="${LOCAL_SUITE_BESU_NETWORK:-$FORK_DIR/network}"
GENESIS="$LOCAL_SUITE_BESU_NETWORK/genesis.json"
GAS_LIMIT_HEX="${FHEBC_BESU_BLOCK_GAS_LIMIT:-0x3b9aca00}"
BACKUP="$GENESIS.fhebc-backup"

if [ ! -f "$GENESIS" ]; then
  echo "genesis.json not found: $GENESIS" >&2
  exit 1
fi

if [ ! -f "$BACKUP" ]; then
  cp "$GENESIS" "$BACKUP"
  echo "Backup created: $BACKUP"
else
  echo "Backup already exists: $BACKUP"
fi

python3 - "$GENESIS" "$GAS_LIMIT_HEX" <<'PY'
import json
import sys

path, gas_limit = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
old = data.get("gasLimit")
data["gasLimit"] = gas_limit
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"gasLimit: {old} -> {gas_limit}")
PY

echo
echo "Important: the BesuFHE genesis changed. Reset node databases before restart:"
echo "  cd $LOCAL_SUITE_BESU_NETWORK"
echo "  ./start-nodes.sh reset"
