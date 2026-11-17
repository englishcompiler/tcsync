# tcsync: complete setup guide

This guide starts from nothing. By the end you will have:

- CouchDB running on one computer (the **server**). It is reachable only from that computer, plus devices you approve.
- A tailcat tunnel on the server that starts automatically.
- Obsidian on every device syncing through **Self-hosted LiveSync** with **end-to-end encryption**, using **tcsync** to reach the server.

| Term | Meaning |
|---|---|
| **Server** | The computer that runs CouchDB. It must be awake for devices to sync. |
| **Device** | Any Obsidian install that syncs: phone, tablet, laptop, and the server's own Obsidian. |
| **Server address** | A long `tc…` string. Devices use it to find the server through the tunnel. Treat it like a password. |
| **Device key** | A `nodekey:…` string that tcsync generates on each device. The server admits only keys on its allowlist. |
| **Tunnel hostname** | `couch.tailcat`. This is not a real domain: LiveSync is pointed at `http://couch.tailcat:5984`, and tcsync intercepts that name. |

Contents:
1. [Server on macOS (scripted)](#1-server-on-macos-scripted)
2. [Server, manual (Linux or any Docker host)](#2-server-manual-linux-or-any-docker-host)
3. [Install the plugins on each device](#3-install-the-plugins-on-each-device)
4. [Connect a device to the tunnel](#4-connect-a-device-to-the-tunnel)
5. [Configure LiveSync with a setup link](#5-configure-livesync-with-a-setup-link)
6. [Configure LiveSync by hand (alternative to 5)](#6-configure-livesync-by-hand-alternative-to-5)
7. [First sync and checking it works](#7-first-sync-and-checking-it-works)
8. [Troubleshooting](#8-troubleshooting)
9. [Keeping the server awake](#9-keeping-the-server-awake)
10. [Backup, moving, uninstalling](#10-backup-moving-uninstalling)

---

## 1. Server on macOS (scripted)

**You need:**
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [OrbStack](https://orbstack.dev), running.
- Go, to build tailcat once: `brew install go`.
- Node.js 18+, for the setup link: `brew install node`.

```sh
git clone https://github.com/englishcompiler/tcsync.git ~/tcsync
~/tcsync/server/setup.sh
```

The script is safe to re-run. It:
- creates a random CouchDB password and stores it in your login **Keychain** (service `tcsync`, account `couchdb-password`);
- starts CouchDB 3.4 in Docker as container `tcsync-couchdb`, bound to `127.0.0.1:5984` only, with data in the Docker volume `tcsync-couchdb-data`;
- configures CouchDB the way Self-hosted LiveSync expects (single node, login required, CORS for Obsidian, large request and document limits) and creates the database `obsidian`;
- builds tailcat v0.7.0 into `~/.local/share/tcsync/bin/tailcat`;
- creates the server identity `tcsync` with a fixed relay region, so **the server address never changes**;
- installs a login service, `in.englishcompiler.tcsync.serve`, that runs the tunnel and restarts it if it stops. Logs go to `~/Library/Logs/tcsync/serve.log`;
- prints the **server address**.

Useful commands afterwards:

```sh
~/tcsync/server/status.sh                       # is everything running? shows the server address
~/tcsync/server/allow.sh list                   # approved devices
~/tcsync/server/allow.sh add <nodekey:…> "name" # approve a device
~/tcsync/server/allow.sh remove <nodekey:…>     # revoke a device
~/tcsync/server/setup-uri.sh                    # make a LiveSync setup link
```

The service runs the scripts from where you cloned the repo. If you move the folder, re-run `setup.sh` from the new location.

Continue with [section 3](#3-install-the-plugins-on-each-device).

## 2. Server, manual (Linux or any Docker host)

These are the same steps the macOS script performs, done by hand. Pick your own values for the placeholders.

### 2.1 CouchDB

```sh
export COUCH_USER=tcsync
export COUCH_PASSWORD="$(openssl rand -base64 24)"   # keep this; you'll need it for LiveSync
echo "$COUCH_PASSWORD"

docker run -d --name tcsync-couchdb --restart unless-stopped \
  -p 127.0.0.1:5984:5984 \
  -e COUCHDB_USER="$COUCH_USER" -e COUCHDB_PASSWORD="$COUCH_PASSWORD" \
  -v tcsync-couchdb-data:/opt/couchdb/data \
  -v tcsync-couchdb-config:/opt/couchdb/etc/local.d \
  couchdb:3.4.3
```

Wait until `curl -u "$COUCH_USER:$COUCH_PASSWORD" http://127.0.0.1:5984/_up` prints `{"status":"ok"…}`. Then configure it for LiveSync:

```sh
C="curl -sS -u $COUCH_USER:$COUCH_PASSWORD -H Content-Type:application/json"
$C -X POST http://127.0.0.1:5984/_cluster_setup \
  -d "{\"action\":\"enable_single_node\",\"username\":\"$COUCH_USER\",\"password\":\"$COUCH_PASSWORD\",\"bind_address\":\"0.0.0.0\",\"port\":5984,\"singlenode\":true}"
for kv in \
  'chttpd/require_valid_user|"true"' \
  'chttpd_auth/require_valid_user|"true"' \
  'httpd/WWW-Authenticate|"Basic realm=\"couchdb\""' \
  'httpd/enable_cors|"true"' \
  'chttpd/enable_cors|"true"' \
  'chttpd/max_http_request_size|"4294967296"' \
  'couchdb/max_document_size|"50000000"' \
  'cors/credentials|"true"' \
  'cors/origins|"app://obsidian.md,capacitor://localhost,http://localhost"'; do
  $C -X PUT "http://127.0.0.1:5984/_node/_local/_config/${kv%%|*}" -d "${kv#*|}"
done
$C -X PUT http://127.0.0.1:5984/obsidian
```

Check it: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5984/obsidian` should print **401** (login required).

### 2.2 tailcat server

Install tailcat v0.7.0 using a [release binary or package](https://github.com/tailscale/tailcat/blob/main/INSTALL.md), or with Go:

```sh
GOTOOLCHAIN=auto GOBIN=$HOME/.local/bin go install github.com/tailscale/tailcat/cmd/tailcat@v0.7.0
```

Create a permanent server identity. `--fixed-region` keeps the address stable across restarts. The command prints your **server address**:

```sh
tailcat genkey --key=tcsync --fixed-region
mkdir -p ~/.config/tcsync && touch ~/.config/tcsync/allowlist
```

Run the tunnel as a systemd user service. It admits only keys in `~/.config/tcsync/allowlist`, one `nodekey:…` per line; an empty list admits no one.

```ini
# ~/.config/systemd/user/tcsync-serve.service
[Unit]
Description=tcsync tunnel (tailcat serve for CouchDB)
After=network-online.target

[Service]
ExecStart=/bin/sh -c 'allow=$(grep -Eo "^nodekey:[0-9a-f]{64}" %h/.config/tcsync/allowlist | paste -sd, -); exec %h/.local/bin/tailcat --key=tcsync serve --allow="${allow:-none}" 5984'
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now tcsync-serve
loginctl enable-linger "$USER"     # keep it running when you're logged out
journalctl --user -u tcsync-serve -f
```

To approve a device later, append its key to `~/.config/tcsync/allowlist` and run `systemctl --user restart tcsync-serve`.

### 2.3 Setup link without the macOS script

```sh
cd tcsync/server && npm install
LIVESYNC_HOST=http://couch.tailcat:5984 LIVESYNC_USER=tcsync LIVESYNC_PASS="$COUCH_PASSWORD" \
LIVESYNC_DB=obsidian LIVESYNC_PASSPHRASE="<choose a long encryption passphrase>" \
node setup-uri.mjs
```

It prints a link, the link's one-time passphrase, and an **ID recovery code**. If you generate more links later for the same vault, pass that code as `id_recovery_code=…` and use the same encryption passphrase.

## 3. Install the plugins on each device

Do this on every device, including the server's own Obsidian if you take notes there too.

1. **Settings → Community plugins.** Turn off *Restricted mode* if it's on.
2. **Browse** → search **Self-hosted LiveSync** → *Install* → *Enable*. LiveSync may open a welcome dialog; close it for now.
3. **Browse** → search **BRAT** (*Obsidian42 - BRAT*) → *Install* → *Enable*.
4. Open BRAT's settings → **Add beta plugin** → enter `englishcompiler/tcsync` → **Add plugin**.
5. Back in **Community plugins**, enable **tcsync**. A `tcsync: …` item appears in the status bar. On phones, it's in the bottom toolbar's status area.
6. If tcsync shows *"please restart Obsidian once"*, do so: fully close Obsidian (on phones, swipe it away) and reopen it. tcsync has to load before LiveSync, and it fixes the order itself; the restart applies it.

BRAT keeps tcsync updated from this repository's releases.

## 4. Connect a device to the tunnel

### Phones, tablets and other computers (tunnel mode)

1. Open **Settings → tcsync**. Leave *Mode* on **Tunnel**.
2. Paste the **server address** (the `tc…` string from `status.sh`, or from `genkey` on Linux).
3. Under **Device key**, tap **Copy**. Send the key to the server any way you like; it is not secret.
4. On the server, run:
   ```sh
   ~/tcsync/server/allow.sh add nodekey:… "my phone"
   ```
5. Back on the device, tap **Test connection**. You should see *"tcsync: connected. CouchDB answered (login required — LiveSync supplies it)"*. The status bar shows `tcsync: up`.

### The server's own Obsidian (direct mode)

Open **Settings → tcsync** and set *Mode* to **Direct**. The direct URL `http://127.0.0.1:5984` is already filled in. **Test connection** should succeed straight away, with no allowlist needed. In direct mode tcsync never loads the tunnel; it only rewrites `couch.tailcat` to the local CouchDB. That's why every device can share one LiveSync configuration.

## 5. Configure LiveSync with a setup link

On the server:

```sh
~/tcsync/server/setup-uri.sh            # link valid for a limited time
~/tcsync/server/setup-uri.sh --persistent
```

It prints an `obsidian://setuplivesync?settings=…` link and a **passphrase for the link**.

- **Desktop:** click the link, or copy it and run the command **Self-hosted LiveSync: Use the copied setup URI (Formerly Open setup URI)**.
- **Phone:** send yourself the link (for example in a notes-to-self chat) and tap it, or copy it and run the same command from the command palette.

Enter the link's passphrase when asked, then follow LiveSync's prompts.

- **First device (one that already has your notes):** choose to set it up as a new or main device, so your notes are uploaded to CouchDB.
- **Every other device:** choose to set it up as an *additional* device, so it downloads what is already on the server.

The link turns on **end-to-end encryption** and **path obfuscation**. The encryption passphrase is created once and kept in the server's Keychain:

```sh
security find-generic-password -s tcsync -a e2ee-passphrase -w
```

Keep a copy somewhere safe. Without it, the data in CouchDB can't be decrypted.

## 6. Configure LiveSync by hand (alternative to 5)

Use these values in **Settings → Self-hosted LiveSync**. Labels are from LiveSync 1.0.x.

| Where | Setting | Value |
|---|---|---|
| Remote Configuration | Remote Type | CouchDB |
| | Server URI | `http://couch.tailcat:5984` |
| | Username | `tcsync`, or your `COUCH_USER` |
| | Password | the CouchDB password (macOS: `security find-generic-password -s tcsync -a couchdb-password -w`) |
| | Database Name | `obsidian` |
| | | Press **Test Database Connection**: it should succeed |
| End-to-End Encryption | End-to-End Encryption | on |
| | Passphrase | a long passphrase, **the same on every device** |
| | Path Obfuscation | on |
| Sync settings | Sync Mode | LiveSync (real-time) or Periodic |

Then press **Apply** and let LiveSync rebuild or fetch as it suggests: rebuild on the first device, fetch on the others.

## 7. First sync and checking it works

1. Create a note on one device and wait a few seconds. LiveSync's status shows `↑` counts.
2. The note appears on the other device. In LiveSync mode, changes arrive within seconds while both sides are online.
3. On the server, `curl -su tcsync:"$(security find-generic-password -s tcsync -a couchdb-password -w)" http://127.0.0.1:5984/obsidian | head -c 200` shows a growing `doc_count`. The documents are encrypted: open one and you won't find your note text.

The first sync of a big vault is slow, because every request goes through the relay (see [Limits](../README.md#limits-read-these-first)). Do it on Wi-Fi.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Status `tcsync: unreachable` with *"server offline or this device isn't allowlisted. Device key: nodekey:…"* | The server is asleep or off, the tunnel isn't running, or this key isn't approved. The two can't be told apart from the device, by design. | On the server: `status.sh`, then `allow.sh list`. Add the key shown in the message. tcsync retries on its own (1 s, then doubling up to 60 s), immediately when you return to Obsidian, or when you press **Reconnect**. |
| Status `tcsync: error`, *"set the server address"* | Tunnel mode without an address. | Paste the `tc…` address in **Settings → tcsync**. |
| LiveSync says it can't reach the server, but tcsync says `up` | LiveSync's Server URI doesn't use the tunnel hostname. | Server URI must be `http://couch.tailcat:5984` (or whatever *Tunnel hostname* is set to in tcsync). |
| LiveSync log says *"Fast Fetch could not check remote feature requirements: Failed to fetch"*, or setup ends with *"Error during vault initialisation process"* | tcsync loaded after LiveSync, so LiveSync's fast fetch bypassed the tunnel. | Restart Obsidian once (tcsync has already fixed the load order), then run the setup link again, or run LiveSync's fetch again. |
| LiveSync shows **Config Doctor** on first start | LiveSync suggests changes after an install or update. | Accepting the suggestions is safe. *"No, and do not ask again until the next release"* is also fine. |
| First sync takes very long | All in-app traffic is relayed (about 300 ms per request, about 0.5 MB/s). | Let it finish on Wi-Fi. Later syncs only send changes. |
| Worked yesterday, `unreachable` today, server is on | Tunnel service stopped, or Docker isn't running. | `status.sh`; `launchctl kickstart -k gui/$(id -u)/in.englishcompiler.tcsync.serve`; start Docker. Logs: `~/Library/Logs/tcsync/serve.log`. |
| tcsync status bar stays `connecting…` on a phone | No internet, or relays blocked on this network. | Try another network. Corporate proxies that block WebSockets also block tcsync. |
| Want to see every request | | Turn on **Verbose log** in tcsync settings, then open the developer console (desktop: Ctrl/Cmd+Shift+I). |

## 9. Keeping the server awake

Devices sync only while the server is reachable. Options on macOS:

- **On power, never sleep:** `sudo pmset -c sleep 0`. This reverts with `sudo pmset -c sleep 1` or your previous value.
- **Only while working:** `caffeinate -s` in a terminal, or an app like Amphetamine.
- **Laptop lid closed:** macOS still sleeps unless an external display and power are connected (clamshell mode).

Edits made while the server sleeps are kept on each device and sync when it wakes.

## 10. Backup, moving, uninstalling

**What to back up:**
- Each device's vault folder holds your real notes. Back it up the usual way (Time Machine, etc.).
- CouchDB is the sync hub. If you lose it, re-run setup and do a rebuild from one device.

To snapshot CouchDB anyway:

```sh
docker run --rm -v tcsync-couchdb-data:/data -v "$PWD":/backup alpine tar czf /backup/tcsync-couchdb.tgz -C /data .
```

**Secrets (macOS Keychain, service `tcsync`):**
- `couchdb-password`
- `e2ee-passphrase`
- `id-recovery-code`

The server identity lives in `~/Library/Application Support/tailcat/keys/tcsync.private.json`. Keep it to keep the same server address.

**Moving to a new server computer:**
1. Copy the identity file and the Keychain items.
2. Run `setup.sh`.
3. Rebuild from one device.

**Uninstall:**

```sh
~/tcsync/server/uninstall.sh          # removes the service and container; keeps data, key, secrets
~/tcsync/server/uninstall.sh --purge  # also deletes CouchDB data, the server key, config and Keychain secrets
```

On devices, disable and remove tcsync and Self-hosted LiveSync under Community plugins. Your notes stay in the vault.
