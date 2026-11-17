# tcsync

**Sync Obsidian between your computer and your phone through [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), with CouchDB running on your own computer. You don't need a VPS, open ports, a VPN app or Termux.**

tcsync is an Obsidian plugin that carries LiveSync's CouchDB traffic through a [tailcat](https://github.com/tailscale/tailcat) tunnel: WireGuard, relayed by Tailscale's DERP servers over WebSockets. The tunnel runs *inside Obsidian* as WebAssembly, so it works in the stock Obsidian app on Android as well as on desktop.

```
 Phone: Obsidian ─ LiveSync ─ tcsync (WireGuard in WASM) ──DERP relay──┐
                                                                       ▼
 Your computer:  tailcat serve (allowlisted devices only) ─► CouchDB on 127.0.0.1:5984
                 Obsidian ─ LiveSync ─ tcsync (direct mode) ─────────────┘
```

## Features

- **Private by default.** CouchDB listens on localhost only, and the tunnel admits only device keys you have approved.
- **End-to-end encrypted.** LiveSync encrypts notes and file names before they leave each device. The relay sees only WireGuard packets.
- **One plugin, every device.** Use *tunnel mode* on phones and laptops, and *direct mode* on the computer that runs CouchDB.
- **Reboot-proof server.** On macOS, CouchDB runs in Docker and the tunnel runs as a login service. Setup is one script.
- **Self-contained.** The tunnel ships inside `main.js` (about 8 MB), so nothing is downloaded at runtime.

## Limits (read these first)

- **The server computer must be awake and online for devices to sync.** Edits made meanwhile wait on each device and sync later.
- **Browsers can't send raw UDP, so in-app traffic is always relayed.** Expect about 300 ms per request and roughly 0.5 MB/s. Day-to-day note syncing is fine. Do the *first* sync of a large vault on Wi-Fi and be patient.
- tcsync uses tailcat's free public DERP relays, which are rate-limited. You can [run your own relay](https://github.com/tailscale/tailscale/tree/main/cmd/derper#derp).
- Tested with Self-hosted LiveSync **1.0.50** and Obsidian **1.15** on macOS and Android. iOS is untested.
- tcsync hooks LiveSync's internal HTTP functions and must load **before** LiveSync. On first start it moves itself ahead of LiveSync and asks you to restart Obsidian once. A future LiveSync release could need a tcsync update.

## Quick start

1. **Server (macOS):** clone this repo, then run `server/setup.sh`. It prints your server address. ([Linux and manual steps](docs/setup.md#2-server-manual-linux-or-any-docker-host))
2. **Each device:** install **Self-hosted LiveSync** from Community plugins and **tcsync** with [BRAT](https://github.com/TfTHacker/obsidian42-brat) (`englishcompiler/tcsync`).
3. **Phone:** in tcsync's settings, paste the server address and copy the device key. On the server, run `server/allow.sh add <device key> "my phone"`.
4. **Server computer's own Obsidian:** set tcsync to **Direct** mode.
5. Run `server/setup-uri.sh` and open the printed link on each device. LiveSync configures itself, with encryption on.

The full guide is in **[docs/setup.md](docs/setup.md)**: it covers everything from scratch, including configuring LiveSync by hand, troubleshooting, backup and uninstall. How it works and the security model are in **[docs/architecture.md](docs/architecture.md)**.

## Building from source

Requires Go 1.27.4+ (fetched automatically through `GOTOOLCHAIN`) and Node 20+.

```sh
npm ci
npm test                 # plugin unit tests
npm run build            # builds bridge/dist/tcsync.wasm, then main.js
TAILCAT_BIN=$(command -v tailcat) bridge/test/run.sh   # bridge integration tests (needs network)
```

Releases are built by GitHub Actions when a version tag (`x.y.z`) is pushed. The release assets are `main.js`, `manifest.json` and `styles.css`.

## License

MIT. `main.js` embeds tailcat and Tailscale code (BSD-3-Clause), and `server/setup-uri.mjs` is adapted from Self-hosted LiveSync (MIT). See [LICENSE](LICENSE).
