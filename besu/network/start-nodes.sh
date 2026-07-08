#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NET_DIR="$SCRIPT_DIR"
PROJECT_DIR="$(cd "$NET_DIR/../.." && pwd)"
FORK_DIR="$PROJECT_DIR/besu"

if [ -n "${BESU_DIR:-}" ]; then
  BESU="$BESU_DIR/bin/besu"
elif [ -x "$FORK_DIR/wrapped-besu/bin/besu" ]; then
  BESU="$FORK_DIR/wrapped-besu/bin/besu"
elif [ -x "$PROJECT_DIR/runtime/besu/bin/besu" ]; then
  BESU="$PROJECT_DIR/runtime/besu/bin/besu"
else
  BESU="$(command -v besu 2>/dev/null || true)"
fi

if [ -z "$BESU" ] || [ ! -x "$BESU" ]; then
  echo "Besu binary not found."
  echo "Set BESU_DIR=/path/to/besu or build the fork with:"
  echo "  npm run build:besu"
  exit 1
fi

if [ -z "${JAVA_OPTS:-}" ]; then
  export JAVA_OPTS="-XX:TieredStopAtLevel=1"
elif ! printf '%s' "$JAVA_OPTS" | grep -q 'TieredStopAtLevel'; then
  export JAVA_OPTS="$JAVA_OPTS -XX:TieredStopAtLevel=1"
fi

GENESIS="$NET_DIR/genesis.json"
PIDS_FILE="$NET_DIR/.besu-pids"
LOGS_DIR="$NET_DIR/logs"
POA_BLOCK_TXS_SELECTION_MAX_TIME="${FHEBC_BESU_POA_BLOCK_TXS_SELECTION_MAX_TIME:-5000}"

declare -A NODE_RPC_PORT=( [1]=8545 [2]=8547 [3]=8548 [4]=8549 )
declare -A NODE_WS_PORT=(  [1]=8555 [2]=8557 [3]=8558 [4]=8559 )
declare -A NODE_P2P_PORT=( [1]=30303 [2]=30304 [3]=30305 [4]=30306 )

NODE_ENODE=(
  ""
  "enode://1aa78e11650a6fd4ccd64017056a5687bbfb21b47abbbeb5f9070f8d94c73f0aa8ce06eb09b19499857e442b94e36d45fe34a4ea30c7675703428ddd02ca2969@127.0.0.1:30303"
  "enode://d0d6b073be598b6be25337d4829534dd97c8812487fee8c79fc0f8491b13a7a34df1fcc376e36be7f0ae83e551606d7fe9dd8d6560d5ba670590526378ef8a58@127.0.0.1:30304"
  "enode://1bbcc726f96b84bf9d48c3d55424f857830b7b53a69eaf909d469989b5b27011c0b58aa5d6df05880522c2620460e4aa3febe848227954e7984981da8149aa92@127.0.0.1:30305"
  "enode://b9eda2c04a1fdc3028d5171013b9c5d35b751d4aa602c3dd59765fdf437dea4456eb24ed0185d4ead24e672fbba6196e154584e2ab570e478ab7cc41ebc2b9ee@127.0.0.1:30306"
)

BESU_COMMON_ARGS=(
  "--genesis-file=$GENESIS"
  "--sync-mode=FULL"
  "--data-storage-format=FOREST"
  "--permissions-accounts-config-file-enabled"
  "--rpc-http-enabled"
  "--rpc-http-host=0.0.0.0"
  "--rpc-http-api=ADMIN,ETH,NET,PERM,QBFT,DEBUG,TXPOOL"
  "--rpc-http-cors-origins=*"
  "--rpc-ws-enabled"
  "--rpc-ws-host=0.0.0.0"
  "--rpc-ws-api=ADMIN,ETH,NET,PERM,QBFT,DEBUG,TXPOOL"
  "--host-allowlist=*"
  "--min-block-occupancy-ratio=0.0"
  "--poa-block-txs-selection-max-time=$POA_BLOCK_TXS_SELECTION_MAX_TIME"
  "--discovery-enabled=false"
  "--logging=INFO"
)

json_rpc() {
  local port="$1"
  local payload="$2"
  curl -sf -X POST "http://localhost:${port}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || true
}

hex_to_dec() {
  python3 - "$1" <<'PY'
import sys
print(int(sys.argv[1], 16))
PY
}

read_json_result() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result','0x0'))" 2>/dev/null || echo "0x0"
}

add_peers() {
  echo "Connecting static peers..."
  for i in 1 2 3 4; do
    local rpc_port="${NODE_RPC_PORT[$i]}"
    for j in 1 2 3 4; do
      [ "$i" -eq "$j" ] && continue
      json_rpc "$rpc_port" "{\"jsonrpc\":\"2.0\",\"method\":\"admin_addPeer\",\"params\":[\"${NODE_ENODE[$j]}\"],\"id\":1}" >/dev/null
    done
  done

  echo "Waiting for QBFT consensus..."
  local attempt=0
  while [ "$attempt" -lt 40 ]; do
    local peers_hex peers_dec block_hex block_dec
    peers_hex="$(json_rpc 8545 '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}' | read_json_result)"
    peers_dec="$(hex_to_dec "$peers_hex" 2>/dev/null || echo 0)"
    block_hex="$(json_rpc 8545 '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | read_json_result)"
    block_dec="$(hex_to_dec "$block_hex" 2>/dev/null || echo 0)"

    if [ "$peers_dec" -ge 2 ] && [ "$block_dec" -gt 0 ]; then
      echo "Network active: $peers_dec peers, block #$block_dec"
      return 0
    fi

    echo "  peers=$peers_dec block=$block_dec attempt=$((attempt + 1))/40"
    attempt=$((attempt + 1))
    sleep 3
  done

  echo "QBFT consensus was not reached. Check $LOGS_DIR/node-1.log"
  return 1
}

start_nodes() {
  if [ ! -f "$GENESIS" ]; then
    echo "genesis.json not found: $GENESIS"
    exit 1
  fi

  mkdir -p "$LOGS_DIR"
  : > "$PIDS_FILE"

  echo "Starting BesuFHE local QBFT network"
  echo "Besu binary : $BESU"
  echo "Genesis     : $GENESIS"
  echo "Chain RPC   : http://localhost:8545"
  echo "POA tx time : ${POA_BLOCK_TXS_SELECTION_MAX_TIME} ms"
  echo

  for i in 1 2 3 4; do
    local data_dir="$NET_DIR/Node-$i/data"
    local rpc_port="${NODE_RPC_PORT[$i]}"
    local ws_port="${NODE_WS_PORT[$i]}"
    local p2p_port="${NODE_P2P_PORT[$i]}"
    local log_file="$LOGS_DIR/node-$i.log"

    if [ ! -d "$data_dir" ]; then
      echo "Missing data directory: $data_dir"
      exit 1
    fi

    echo "Node-$i HTTP:$rpc_port WS:$ws_port P2P:$p2p_port -> $log_file"
    nohup "$BESU" \
      --data-path="$data_dir" \
      --rpc-http-port="$rpc_port" \
      --rpc-ws-port="$ws_port" \
      --p2p-port="$p2p_port" \
      "${BESU_COMMON_ARGS[@]}" \
      > "$log_file" 2>&1 &
    echo $! >> "$PIDS_FILE"
    sleep 1
  done

  sleep 4
  add_peers
}

stop_nodes() {
  echo "Stopping BesuFHE local network..."
  if [ -f "$PIDS_FILE" ]; then
    while IFS= read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        echo "Killed PID $pid"
      fi
    done < "$PIDS_FILE"
    rm -f "$PIDS_FILE"
  else
    for port in 8545 8547 8548 8549 8555 8557 8558 8559; do
      pid="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
      if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        echo "Killed PID $pid on port $port"
      fi
    done
  fi
  echo "BesuFHE local network stopped."
}

status_nodes() {
  echo "BesuFHE local network status:"
  for i in 1 2 3 4; do
    local rpc_port="${NODE_RPC_PORT[$i]}"
    local block_hex block_dec
    block_hex="$(json_rpc "$rpc_port" '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | read_json_result)"
    if [ -n "$block_hex" ] && [ "$block_hex" != "0x0" ]; then
      block_dec="$(hex_to_dec "$block_hex" 2>/dev/null || echo 0)"
      echo "Node-$i HTTP:$rpc_port UP block #$block_dec"
    else
      echo "Node-$i HTTP:$rpc_port DOWN"
    fi
  done
}

reset_nodes() {
  echo "Resetting BesuFHE local node databases. Validator keys are kept."
  stop_nodes >/dev/null 2>&1 || true
  for i in 1 2 3 4; do
    local data_dir="$NET_DIR/Node-$i/data"
    echo "Node-$i cleanup..."
    rm -rf "$data_dir/database" "$data_dir/caches" "$data_dir/fastsync" "$data_dir/uploads"
    rm -f "$data_dir/besu.networks" "$data_dir/besu.ports" "$data_dir/DATABASE_METADATA.json" "$data_dir/VERSION_METADATA.json"
  done
  rm -f "$PIDS_FILE"
  echo "Reset complete."
}

show_peers() {
  json_rpc 8545 '{"jsonrpc":"2.0","method":"admin_peers","params":[],"id":1}'
  echo
}

case "${1:-start}" in
  start) start_nodes ;;
  stop) stop_nodes ;;
  status) status_nodes ;;
  reset) reset_nodes ;;
  peers) show_peers ;;
  *)
    echo "Usage: $0 [start|stop|status|reset|peers]"
    exit 1
    ;;
esac
