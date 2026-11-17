#!/usr/bin/env bash
# Shared settings and helpers for the tcsync server scripts (macOS).
# shellcheck disable=SC2034  # variables are used by the scripts that source this file

set -euo pipefail

TCSYNC_SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TCSYNC_CONFIG="${TCSYNC_CONFIG:-$HOME/.config/tcsync}"
TCSYNC_SHARE="${TCSYNC_SHARE:-$HOME/.local/share/tcsync}"
TCSYNC_LOGS="${TCSYNC_LOGS:-$HOME/Library/Logs/tcsync}"
TAILCAT_VERSION="v0.7.0"
TAILCAT_BIN="${TAILCAT_BIN:-$TCSYNC_SHARE/bin/tailcat}"
TAILCAT_KEY="tcsync"
LAUNCHD_LABEL="in.englishcompiler.tcsync.serve"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
COUCH_URL="http://127.0.0.1:5984"
COUCH_USER="tcsync"
COUCH_DB="${TCSYNC_DB:-obsidian}"
COUCH_PORT=5984
ALLOWLIST="$TCSYNC_CONFIG/allowlist"
ADDRESS_FILE="$TCSYNC_CONFIG/address"
KEYCHAIN_SERVICE="tcsync"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "these scripts are for macOS; see docs/setup.md for the manual Linux steps"
}

# secret_get NAME — prints the secret or nothing.
secret_get() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null || true
}

# secret_set NAME VALUE
secret_set() {
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$1" -w "$2" >/dev/null
}

# secret_ensure NAME — prints the secret, creating a random one first if missing.
secret_ensure() {
  local v
  v="$(secret_get "$1")"
  if [[ -z "$v" ]]; then
    v="$(openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-32)"
    secret_set "$1" "$v"
  fi
  printf '%s' "$v"
}

couch() {
  # couch METHOD PATH [BODY] — authenticated request to the local CouchDB.
  local method="$1" path="$2" body="${3:-}"
  local pw
  pw="$(secret_get couchdb-password)"
  if [[ -n "$body" ]]; then
    curl -sS -u "$COUCH_USER:$pw" -X "$method" -H 'Content-Type: application/json' --data "$body" "$COUCH_URL$path"
  else
    curl -sS -u "$COUCH_USER:$pw" -X "$method" "$COUCH_URL$path"
  fi
}

compose() {
  COUCHDB_PASSWORD="$(secret_get couchdb-password)" docker compose -f "$TCSYNC_SERVER_DIR/docker-compose.yml" "$@"
}

restart_agent() {
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}
