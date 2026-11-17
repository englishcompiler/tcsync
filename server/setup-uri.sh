#!/usr/bin/env bash
# Prints a Self-hosted LiveSync setup link for this server, with end-to-end
# encryption. Open the link on each device (Mac and phone) to configure LiveSync.
#   setup-uri.sh               link valid for a limited time (recommended)
#   setup-uri.sh --persistent  link without expiry
# The encryption passphrase and vault ID code are created once and kept in the
# Keychain, so every link you generate configures the same vault.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_macos

mode="ephemeral"
[[ "${1:-}" == "--persistent" ]] && mode="persistent"
command -v node >/dev/null || die "Node.js 18+ is required (brew install node)"
[[ -n "$(secret_get couchdb-password)" ]] || die "run setup.sh first"

if [[ ! -d "$TCSYNC_SERVER_DIR/node_modules/@vrtmrz/livesync-commonlib" ]]; then
  info "Installing generator dependency"
  (cd "$TCSYNC_SERVER_DIR" && npm install --silent --no-audit --no-fund)
fi

e2ee="$(secret_ensure e2ee-passphrase)"
idcode="$(secret_get id-recovery-code)"

out="$(LIVESYNC_HOST="http://couch.tailcat:$COUCH_PORT" LIVESYNC_USER="$COUCH_USER" \
  LIVESYNC_PASS="$(secret_get couchdb-password)" LIVESYNC_DB="$COUCH_DB" \
  LIVESYNC_PASSPHRASE="$e2ee" id_recovery_code="$idcode" uri_mode="$mode" \
  node "$TCSYNC_SERVER_DIR/setup-uri.mjs")"

if [[ -z "$idcode" ]]; then
  secret_set id-recovery-code "$(sed -n 's/^ID recovery code: //p' <<<"$out")"
fi

cat <<MSG
$(sed -n '1p' <<<"$out")

Setup link (open it on each device, with tcsync and Self-hosted LiveSync installed):
$(tail -1 <<<"$out")

$(sed -n 's/^Setup URI passphrase: /Passphrase for this link: /p' <<<"$out")
  LiveSync asks for it when you open the link. It is shown only now.

Your notes are end-to-end encrypted. The encryption passphrase is in your
Keychain: security find-generic-password -s $KEYCHAIN_SERVICE -a e2ee-passphrase -w
MSG
