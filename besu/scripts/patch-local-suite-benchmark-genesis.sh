#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$FORK_DIR/.." && pwd)"

LOCAL_SUITE_BESU_NETWORK="${LOCAL_SUITE_BESU_NETWORK:-$FORK_DIR/network}"
GENESIS="$LOCAL_SUITE_BESU_NETWORK/genesis.json"
BACKUP="$GENESIS.fhebc-benchmark-backup"

GAS_LIMIT_HEX="${FHEBC_BESU_BLOCK_GAS_LIMIT:-0x3b9aca00}"
BLOCK_PERIOD_SECONDS="${FHEBC_BESU_BLOCK_PERIOD_SECONDS:-1}"
REQUEST_TIMEOUT_SECONDS="${FHEBC_BESU_REQUEST_TIMEOUT_SECONDS:-3}"

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

python3 - "$GENESIS" "$GAS_LIMIT_HEX" "$BLOCK_PERIOD_SECONDS" "$REQUEST_TIMEOUT_SECONDS" <<'PY'
import json
import sys

path, gas_limit, block_period, request_timeout = sys.argv[1:5]
block_period = int(block_period)
request_timeout = int(request_timeout)
if block_period < 1:
    raise SystemExit("block period must be >= 1")
if request_timeout < 1:
    raise SystemExit("request timeout must be >= 1")

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

config = data.setdefault("config", {})
qbft = config.setdefault("qbft", {})

old_gas = data.get("gasLimit")
old_block_period = qbft.get("blockperiodseconds")
old_request_timeout = qbft.get("requesttimeoutseconds")

data["gasLimit"] = gas_limit
qbft["blockperiodseconds"] = block_period
qbft["requesttimeoutseconds"] = request_timeout

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"gasLimit: {old_gas} -> {gas_limit}")
print(f"qbft.blockperiodseconds: {old_block_period} -> {block_period}")
print(f"qbft.requesttimeoutseconds: {old_request_timeout} -> {request_timeout}")
PY

echo
echo "Genesis patched for BesuFHE local benchmarks."
echo "Reset Besu node databases before restart:"
echo "  cd $LOCAL_SUITE_BESU_NETWORK"
echo "  ./start-nodes.sh reset"
