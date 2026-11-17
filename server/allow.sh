#!/usr/bin/env bash
# Manage the devices allowed through the tunnel.
#   allow.sh add <nodekey:…> [label]
#   allow.sh remove <nodekey:…>
#   allow.sh list
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_macos

usage() { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
valid() { [[ "$1" =~ ^nodekey:[0-9a-f]{64}$ ]] || die "not a device key: $1 (expected nodekey: followed by 64 hex characters)"; }

mkdir -p "$TCSYNC_CONFIG"
touch "$ALLOWLIST"
chmod 600 "$ALLOWLIST"

case "${1:-}" in
  add)
    [[ $# -ge 2 ]] || usage
    valid "$2"
    if grep -q "^$2" "$ALLOWLIST"; then
      ok "already allowed"
      exit 0
    fi
    printf '%s  # %s, added %s\n' "$2" "${3:-device}" "$(date +%F)" >> "$ALLOWLIST"
    restart_agent
    ok "allowed ${3:-device}; tunnel restarted"
    ;;
  remove)
    [[ $# -ge 2 ]] || usage
    valid "$2"
    grep -q "^$2" "$ALLOWLIST" || die "not in the allowlist"
    tmp="$(mktemp)"
    grep -v "^$2" "$ALLOWLIST" > "$tmp" || true
    cat "$tmp" > "$ALLOWLIST"
    rm -f "$tmp"
    restart_agent
    ok "removed; tunnel restarted"
    ;;
  list)
    if grep -q '^nodekey:' "$ALLOWLIST"; then grep '^nodekey:' "$ALLOWLIST"; else echo "(no devices allowed yet)"; fi
    ;;
  *) usage ;;
esac
