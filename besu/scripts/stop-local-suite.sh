#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCAL_SUITE_BESU_NETWORK="${LOCAL_SUITE_BESU_NETWORK:-$PROJECT_DIR/besu/network}"

cd "$LOCAL_SUITE_BESU_NETWORK"
./start-nodes.sh stop
