#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
out_dir="${2:-}"

if [[ -z "$mode" || -z "$out_dir" ]]; then
  echo "Usage: $0 <proof-backed-real|hybrid-real|input-real> <output-dir>" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"
cd "$project_root"

export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
export FHEBC_OPERATION_ZK_SECRET="${FHEBC_OPERATION_ZK_SECRET:-12345}"
export FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT="${FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT:-0x096f56a93ef8bcf4f5efc79d0967649f93d08eff0af7dca5a4f9aa8db1a434b6}"
export FHEBC_BESU_GAS_PRICE_WEI="${FHEBC_BESU_GAS_PRICE_WEI:-1000}"
export FHEBC_TX_GAS_LIMIT="${FHEBC_TX_GAS_LIMIT:-30000000}"

case "$mode" in
  proof-backed-real)
    export FHEBC_BENCHMARK_RUNS="${FHEBC_BENCHMARK_RUNS:-10}"
    export FHEBC_BENCHMARK_OPERATION_PROOF_MODE=groth16
    export FHEBC_BENCHMARK_INPUT_PROOF_MODE=mock
    export FHEBC_BENCHMARK_ALL_PROOF_BACKED=1
    export FHEBC_BENCHMARK_OUT_DIR="$out_dir"
    npm run benchmark:besu
    ;;
  hybrid-real)
    export FHEBC_BENCHMARK_RUNS="${FHEBC_BENCHMARK_RUNS:-10}"
    export FHEBC_BENCHMARK_OPERATION_PROOF_MODE=groth16
    export FHEBC_BENCHMARK_INPUT_PROOF_MODE=mock
    export FHEBC_BENCHMARK_ALL_PROOF_BACKED=0
    export FHEBC_BENCHMARK_OUT_DIR="$out_dir"
    npm run benchmark:besu
    ;;
  input-real)
    export FHEBC_RUN_DIR="$out_dir"
    export FHEBC_FREEZE_INPUT_PROOF_CONFIG="${FHEBC_FREEZE_INPUT_PROOF_CONFIG:-1}"
    export FHEBC_FREEZE_OPERATION_PROOF_CONFIG="${FHEBC_FREEZE_OPERATION_PROOF_CONFIG:-1}"
    npm run interact:besu
    ;;
  *)
    echo "Unknown mode: $mode" >&2
    exit 2
    ;;
esac
