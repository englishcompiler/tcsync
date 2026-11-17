#!/usr/bin/env bash
# Shows whether CouchDB and the tunnel are running, and the server address.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_macos

health="$(docker inspect -f '{{.State.Health.Status}}' tcsync-couchdb 2>/dev/null || echo missing)"
up="$(couch GET /_up 2>/dev/null || true)"
if [[ "$up" == *'"ok"'* ]]; then ok "CouchDB: up ($health) on $COUCH_URL"; else warn "CouchDB: not answering ($health)"; fi

if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -q 'state = running'; then
  ok "tunnel: running ($LAUNCHD_LABEL)"
else
  warn "tunnel: not running — see $TCSYNC_LOGS/serve.log"
fi

count="$(grep -c '^nodekey:' "$ALLOWLIST" 2>/dev/null || true)"
ok "allowlist: ${count:-0} device(s)"
if [[ -s "$ADDRESS_FILE" ]]; then
  echo "    server address: $(cat "$ADDRESS_FILE")"
fi
