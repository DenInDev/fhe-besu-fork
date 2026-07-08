#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$NATIVE_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/runtime/native"

cd "$NATIVE_DIR"
cargo build --release

mkdir -p "$RUNTIME_DIR"
cp target/release/libbesu_fhe_native.so "$RUNTIME_DIR/libbesu_fhe_native.so"
cp target/release/tfhe_tool "$RUNTIME_DIR/tfhe_tool"

echo "Native runtime updated:"
echo "  $RUNTIME_DIR/libbesu_fhe_native.so"
echo "  $RUNTIME_DIR/tfhe_tool"
