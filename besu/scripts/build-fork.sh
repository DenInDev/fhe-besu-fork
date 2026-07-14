#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$FORK_DIR/.." && pwd)"
BESU_SRC="$FORK_DIR/source"
NATIVE_DIR="$PROJECT_DIR/native"
NATIVE_LIB="$PROJECT_DIR/runtime/native/libbesu_fhe_native.so"
RUNTIME_BESU="$PROJECT_DIR/runtime/besu"

if [ ! -x "$BESU_SRC/gradlew" ]; then
  echo "Besu source checkout not found or gradlew missing: $BESU_SRC" >&2
  exit 1
fi

if [ ! -f "$NATIVE_LIB" ]; then
  echo "Native TFHE library not found: $NATIVE_LIB" >&2
  echo "Build it first:" >&2
  echo "  cd $NATIVE_DIR" >&2
  echo "  bash $NATIVE_DIR/scripts/build.sh" >&2
  exit 1
fi

echo "=============================================================================="
echo "Building FHEBC Besu fork"
echo "=============================================================================="
echo "Besu source : $BESU_SRC"
echo "Native lib  : $NATIVE_LIB"
echo

cd "$BESU_SRC"
if [ -x "$RUNTIME_BESU/bin/besu" ]; then
  ./gradlew --no-daemon --console=plain :evm:jar -x test
  cp -f "$BESU_SRC/evm/build/libs/besu-evm-24.2.0-SNAPSHOT.jar" \
    "$RUNTIME_BESU/lib/besu-evm-24.2.0-SNAPSHOT.jar"
else
  ./gradlew --no-daemon --console=plain installDist -x test
  rm -rf "$RUNTIME_BESU"
  mkdir -p "$RUNTIME_BESU"
  cp -a "$BESU_SRC/build/install/besu/." "$RUNTIME_BESU/"
fi

echo
echo "Forked Besu distribution:"
echo "  $RUNTIME_BESU"
echo
echo "Version:"
"$RUNTIME_BESU/bin/besu" --version
