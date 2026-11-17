#!/usr/bin/env bash
# Go's js/wasm net/http disables the Fetch API when argv0 starts with "node";
# run node under a different argv0 so the bridge behaves as it does in Obsidian.
set -euo pipefail
cd "$(dirname "$0")"
exec -a tcsync-test node --test --test-concurrency=1 bridge.test.mjs
