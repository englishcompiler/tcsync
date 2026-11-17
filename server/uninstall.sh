#!/usr/bin/env bash
# Removes the tcsync service and CouchDB container.
#   uninstall.sh          keep notes data, key, allowlist and secrets
#   uninstall.sh --purge  also delete the CouchDB volumes, key, config and secrets
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_macos

launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
rm -f "$LAUNCHD_PLIST"
ok "service removed"
compose down >/dev/null 2>&1 || docker rm -f tcsync-couchdb >/dev/null 2>&1 || true
ok "CouchDB container removed"

if [[ "${1:-}" == "--purge" ]]; then
  docker volume rm tcsync-couchdb-data tcsync-couchdb-config >/dev/null 2>&1 || true
  "$TAILCAT_BIN" genkey --delete --key="$TAILCAT_KEY" >/dev/null 2>&1 || true
  rm -rf "$TCSYNC_CONFIG" "$TCSYNC_SHARE"
  for s in couchdb-password e2ee-passphrase id-recovery-code; do
    security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$s" >/dev/null 2>&1 || true
  done
  ok "purged data volumes, key, config and Keychain secrets"
else
  echo "    kept: Docker volumes tcsync-couchdb-*, key \"$TAILCAT_KEY\", $TCSYNC_CONFIG, Keychain secrets"
fi
