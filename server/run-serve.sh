#!/usr/bin/env bash
# Started by launchd. Serves CouchDB's port through tailcat, admitting only
# the device keys in the allowlist (none when the list is empty).
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

keys=""
if [[ -f "$ALLOWLIST" ]]; then
  keys="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$ALLOWLIST" | grep -E '^nodekey:[0-9a-f]{64}$' | paste -sd, - || true)"
fi
allow="${keys:-none}"
count=0
if [[ "$allow" != none ]]; then count="$(tr ',' '\n' <<<"$allow" | wc -l | tr -d ' ')"; fi
echo "$(date '+%F %T') starting tailcat serve, $count allowed device(s)"
exec "$TAILCAT_BIN" --key="$TAILCAT_KEY" serve --allow="$allow" "$COUCH_PORT"
