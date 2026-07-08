#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$FORK_DIR/.." && pwd)"

BESU_DIR="${BESU_DIR:-$FORK_DIR/wrapped-besu}"
LOCAL_SUITE_BESU_NETWORK="${LOCAL_SUITE_BESU_NETWORK:-$FORK_DIR/network}"
NATIVE_RELEASE_DIR="${NATIVE_RELEASE_DIR:-$PROJECT_DIR/runtime/native}"
FHEBC_TFHE_SERVER_KEY_PATH="${FHEBC_TFHE_SERVER_KEY_PATH:-$PROJECT_DIR/runtime/keys/server.key}"

if [ ! -x "$BESU_DIR/bin/besu" ]; then
  echo "Forked Besu binary not found: $BESU_DIR/bin/besu" >&2
  echo "Build the real forked distribution first:" >&2
  echo "  bash $FORK_DIR/scripts/build-fork.sh" >&2
  exit 1
fi

if [ ! -f "$NATIVE_RELEASE_DIR/libbesu_fhe_native.so" ]; then
  echo "Native library not found: $NATIVE_RELEASE_DIR/libbesu_fhe_native.so" >&2
  exit 1
fi

if [ ! -f "$FHEBC_TFHE_SERVER_KEY_PATH" ]; then
  echo "TFHE server key not found: $FHEBC_TFHE_SERVER_KEY_PATH" >&2
  echo "Generate one with runtime/native/tfhe_tool keygen runtime/keys/client.key runtime/keys/server.key" >&2
  exit 1
fi

if [ ! -f "$LOCAL_SUITE_BESU_NETWORK/start-nodes.sh" ]; then
  echo "BesuFHE network not found: $LOCAL_SUITE_BESU_NETWORK" >&2
  exit 1
fi

export BESU_DIR
export FHEBC_TFHE_SERVER_KEY_PATH
export LD_LIBRARY_PATH="$NATIVE_RELEASE_DIR:${LD_LIBRARY_PATH:-}"
if [ -z "${JAVA_OPTS:-}" ]; then
  export JAVA_OPTS="-XX:TieredStopAtLevel=1 -Djava.library.path=$NATIVE_RELEASE_DIR"
else
  export JAVA_OPTS="$JAVA_OPTS -Djava.library.path=$NATIVE_RELEASE_DIR"
fi

echo "=============================================================================="
echo "Starting BesuFHE local network with FHEBC Besu fork"
echo "=============================================================================="
echo "BESU_DIR                 : $BESU_DIR"
echo "Native library dir       : $NATIVE_RELEASE_DIR"
echo "FHEBC_TFHE_SERVER_KEY_PATH: $FHEBC_TFHE_SERVER_KEY_PATH"
echo "Network dir              : $LOCAL_SUITE_BESU_NETWORK"
echo

cd "$LOCAL_SUITE_BESU_NETWORK"
./start-nodes.sh start
