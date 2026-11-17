#!/usr/bin/env bash
# Builds dist/tcsync.wasm and dist/tcsync.wasm.gz.b64 (embedded into main.js).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
export GOTOOLCHAIN="${GOTOOLCHAIN:-go1.27.4}"
GOOS=js GOARCH=wasm go build -trimpath -tags "$(cat build-tags.txt)" -ldflags "-s -w" -o dist/tcsync.wasm .
gzip -9n -c dist/tcsync.wasm | base64 | tr -d '\n' > dist/tcsync.wasm.gz.b64
install -m 644 "$(go env GOROOT)/lib/wasm/wasm_exec.js" dist/wasm_exec.js
printf 'wasm %s bytes, embedded %s bytes\n' "$(wc -c < dist/tcsync.wasm | tr -d ' ')" "$(wc -c < dist/tcsync.wasm.gz.b64 | tr -d ' ')"
