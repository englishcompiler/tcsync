#!/usr/bin/env bash
# One-time (and re-runnable) server setup for tcsync on macOS:
# CouchDB in Docker, provisioned for Self-hosted LiveSync, plus a tailcat
# server started at login that admits only allowlisted devices.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_macos

info "Checking prerequisites"
command -v docker >/dev/null || die "Docker is required (Docker Desktop or OrbStack)"
docker info >/dev/null 2>&1 || die "Docker is installed but not running — start it and re-run"
command -v curl >/dev/null || die "curl is required"
command -v openssl >/dev/null || die "openssl is required"
ok "docker, curl, openssl"

mkdir -p "$TCSYNC_CONFIG" "$TCSYNC_SHARE/bin" "$TCSYNC_LOGS"
chmod 700 "$TCSYNC_CONFIG"

info "Secrets (stored in your login Keychain, service \"$KEYCHAIN_SERVICE\")"
secret_ensure couchdb-password >/dev/null
ok "CouchDB password ready (account couchdb-password)"

info "Starting CouchDB"
compose up -d --quiet-pull >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(couch GET /_up 2>/dev/null)" == *'"ok"'* ]]; then break; fi
  sleep 1
done
[[ "$(couch GET /_up)" == *'"ok"'* ]] || die "CouchDB did not become ready; check: docker logs tcsync-couchdb"
ok "CouchDB is up on $COUCH_URL (localhost only)"

info "Provisioning CouchDB for Self-hosted LiveSync"
pw="$(secret_get couchdb-password)"
couch POST /_cluster_setup "{\"action\":\"enable_single_node\",\"username\":\"$COUCH_USER\",\"password\":\"$pw\",\"bind_address\":\"0.0.0.0\",\"port\":5984,\"singlenode\":true}" >/dev/null || true
node="_local"
while IFS='|' read -r key value; do
  out="$(couch PUT "/_node/$node/_config/$key" "$value")"
  [[ "$out" != *'"error"'* ]] || die "setting $key failed: $out"
done <<'CONF'
chttpd/require_valid_user|"true"
chttpd_auth/require_valid_user|"true"
httpd/WWW-Authenticate|"Basic realm=\"couchdb\""
httpd/enable_cors|"true"
chttpd/enable_cors|"true"
chttpd/max_http_request_size|"4294967296"
couchdb/max_document_size|"50000000"
cors/credentials|"true"
cors/origins|"app://obsidian.md,capacitor://localhost,http://localhost"
CONF
out="$(couch PUT "/$COUCH_DB")"
[[ "$out" == *'"ok"'* || "$out" == *file_exists* ]] || die "creating database $COUCH_DB failed: $out"
ok "single node, login required, CORS for Obsidian, database \"$COUCH_DB\""

info "Installing tailcat $TAILCAT_VERSION"
if [[ -x "$TAILCAT_BIN" ]] && "$TAILCAT_BIN" version 2>/dev/null | grep -q "$TAILCAT_VERSION"; then
  ok "already installed: $TAILCAT_BIN"
else
  command -v go >/dev/null || die "Go is required to build tailcat (brew install go), or set TAILCAT_BIN to an existing tailcat $TAILCAT_VERSION"
  GOTOOLCHAIN=auto GOBIN="$(dirname "$TAILCAT_BIN")" go install "github.com/tailscale/tailcat/cmd/tailcat@$TAILCAT_VERSION"
  ok "built $TAILCAT_BIN"
fi

info "Server identity"
if "$TAILCAT_BIN" genkey --list 2>/dev/null | grep -qx "$TAILCAT_KEY"; then
  ok "key \"$TAILCAT_KEY\" exists"
else
  # --fixed-region bakes the relay region into the address so it never changes.
  "$TAILCAT_BIN" genkey --key="$TAILCAT_KEY" --fixed-region 2>&1 | grep -Eo 'tc[A-Za-z0-9_-]{40,}' | tail -1 > "$ADDRESS_FILE"
  ok "created key \"$TAILCAT_KEY\""
fi
touch "$ALLOWLIST"
chmod 600 "$ALLOWLIST"

info "Installing the background service ($LAUNCHD_LABEL)"
mkdir -p "$(dirname "$LAUNCHD_PLIST")"
sed -e "s#@SERVER_DIR@#$TCSYNC_SERVER_DIR#g" -e "s#@TAILCAT_BIN@#$TAILCAT_BIN#g" \
    -e "s#@TCSYNC_CONFIG@#$TCSYNC_CONFIG#g" -e "s#@TCSYNC_LOGS@#$TCSYNC_LOGS#g" \
    "$TCSYNC_SERVER_DIR/launchd/$LAUNCHD_LABEL.plist.tmpl" > "$LAUNCHD_PLIST.new"
if [[ -f "$LAUNCHD_PLIST" ]] && cmp -s "$LAUNCHD_PLIST" "$LAUNCHD_PLIST.new"; then
  rm "$LAUNCHD_PLIST.new"
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST"
  ok "service unchanged"
else
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  mv "$LAUNCHD_PLIST.new" "$LAUNCHD_PLIST"
  launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST"
  ok "service installed and started"
fi

for _ in $(seq 1 30); do
  addr="$(grep -Eo 'tc[A-Za-z0-9_-]{40,}' "$TCSYNC_LOGS/serve.log" 2>/dev/null | tail -1 || true)"
  [[ -n "$addr" ]] && break
  sleep 1
done
[[ -n "${addr:-}" ]] || die "tailcat serve did not start; see $TCSYNC_LOGS/serve.log"
printf '%s\n' "$addr" > "$ADDRESS_FILE"

echo
ok "Server ready."
cat <<NEXT

  Server address (paste into tcsync → Server address on each device):
    $addr

  Next:
    1. Install tcsync on each device (BRAT → englishcompiler/tcsync).
    2. Copy the device key from tcsync's settings, then on this computer:
         $TCSYNC_SERVER_DIR/allow.sh add <nodekey:…> "my phone"
    3. Create the LiveSync setup link:
         $TCSYNC_SERVER_DIR/setup-uri.sh
NEXT
