# tcsync

### Sync your Obsidian notes between your devices — through your own computer. No account, no cloud, no server to run.

tcsync turns **Obsidian on your computer (the hub computer) into a private sync hub**. Your phone, tablet and other computers sync with it from anywhere — home Wi-Fi, mobile data, a café — through an encrypted tunnel. Your notes are never stored on anyone else's machine.

Setting it up is **one switch on your hub computer and one QR code per phone**. You never type a password, copy a key or open a terminal.

![Your phone, tablet and laptop each connect, encrypted, to a public relay that passes on locked boxes it cannot open. The relay connects, encrypted, to Obsidian plus tcsync on your hub computer at home, which keeps every device in step. Only devices you added with a QR code get in.](https://raw.githubusercontent.com/englishcompiler/tcsync/main/docs/img/overview.png)

**In one sentence:** your devices send their changes, locked with your own key, through a public relay to Obsidian on your hub computer, which passes them on to your other devices.

---

## ✅ Before you start

This guide talks about exactly two kinds of device. Every step says which one to use.

| Name in this guide | What it is |
|---|---|
| **🖥️ HUB COMPUTER** | **One** computer (Mac, Windows or Linux) that keeps everything together. Pick the one that is switched on most often. Your devices can only sync while it is **on, with Obsidian open**. |
| **📱 NEW DEVICE** | A phone, tablet or second computer that you want to sync with the hub computer. You can add as many as you like, one at a time. |

You need [Obsidian](https://obsidian.md) installed on both, and about 10 minutes. (Android and computers are tested; iPhone/iPad is untested.)

> 💾 **Make a copy of your notes folder on the 🖥️ HUB COMPUTER first.** tcsync never deletes notes, but a backup costs nothing.

**The plan:**

| Part | Where | When |
|---|---|---|
| **Part 1 — Set up the hub** | 🖥️ HUB COMPUTER only | Once |
| **Part 2 — Prepare the new device** | 📱 NEW DEVICE only | Once per new device |
| **Part 3 — Pair them** | Both: 🖥️ shows a QR code, 📱 scans it | Once per new device |

---

## Part 1 — Set up the hub

> **Every step in Part 1 is done on the 🖥️ HUB COMPUTER.** You don't need the new device yet.

1. 🖥️ **Open Obsidian** and open the vault (notes folder) you want to sync.
2. 🖥️ **Turn on community plugins:** ⚙️ **Settings** → **Community plugins** → **Turn on community plugins**.
3. 🖥️ **Install BRAT** (it installs plugins that aren't in Obsidian's store yet): **Community plugins** → **Browse** → search **BRAT** → **Install** → **Enable**.
4. 🖥️ **Install tcsync:** ⚙️ **Settings** → **BRAT** → **Add beta plugin** → paste `englishcompiler/tcsync` → **Add plugin**. Then ⚙️ **Settings** → **Community plugins** → make sure **tcsync** is switched **on**.
5. 🖥️ **Install Self-hosted LiveSync** (tcsync uses it to do the actual syncing): ⚙️ **Settings** → **tcsync** → **Install Self-hosted LiveSync** → **Install** → **Enable**.
6. 🖥️ **Make it the hub:** ⚙️ **Settings** → **tcsync** → **This device is…** → choose **The hub (this computer)** → **Make this computer the hub**.
7. 🖥️ **Wait about a minute and don't click anything.** Obsidian restarts by itself and shows *"tcsync: setting up the hub…"*, then ***"the hub is ready"***.

✅ **Part 1 is done when** the bottom-right corner of the 🖥️ HUB COMPUTER's Obsidian window says **`tcsync: hub on · 0`**.

---

## Part 2 — Prepare the new device

> **Every step in Part 2 is done on the 📱 NEW DEVICE.** Leave the hub computer alone for now.
>
> On a phone or tablet, ⚙️ **Settings** is the gear icon: open the left sidebar (☰ or swipe right), then tap ⚙️.

1. 📱 **Install Obsidian** from the App Store / Play Store (on a computer: [obsidian.md](https://obsidian.md)) and open it.
2. 📱 **Create a new, empty vault.** Tap **Create new vault**, give it any name (e.g. *My notes*), tap **Create**. It stays empty — your notes arrive in Part 3.
3. 📱 **Turn on community plugins:** ⚙️ **Settings** → **Community plugins** → **Turn on community plugins**.
4. 📱 **Install BRAT:** **Community plugins** → **Browse** → search **BRAT** → **Install** → **Enable**.
5. 📱 **Install tcsync:** ⚙️ **Settings** → **BRAT** → **Add beta plugin** → type `englishcompiler/tcsync` → **Add plugin**. Then ⚙️ **Settings** → **Community plugins** → make sure **tcsync** is switched **on**.
6. 📱 **Install Self-hosted LiveSync:** ⚙️ **Settings** → **tcsync** → **Install Self-hosted LiveSync** → **Install** → **Enable**.

✅ **Part 2 is done when** ⚙️ **Settings** → **tcsync** on the 📱 NEW DEVICE says *"Not paired yet…"*.

---

## Part 3 — Pair them

> **Have both devices in front of you.** Each step starts with the device to use.

1. 🖥️ **HUB COMPUTER:** ⚙️ **Settings** → **tcsync** → **Add a device** → type a name for the new device (e.g. *My phone*) → **Show code**. A QR code appears. **Leave this window open.**
2. 📱 **NEW DEVICE (phone or tablet):** open the **camera app**, point it at the QR code on the hub computer's screen, and **tap the link** that appears. Obsidian opens and asks *"Pair this vault with …?"* → tap **Pair**.
   - 📱 **NEW DEVICE is a computer (no camera)?** Instead: on the 🖥️ HUB COMPUTER press **Copy link** and send the link to yourself (e.g. by email). Then on the 📱 NEW DEVICE: ⚙️ **Settings** → **tcsync** → **Paste pairing link** → paste → **Pair**.
3. 📱 **NEW DEVICE: wait and don't click anything.** Obsidian restarts by itself, shows *"downloading your notes from the hub…"*, then ***"paired. Your notes now sync with your hub."***
4. 🖥️ **HUB COMPUTER:** the QR window now says **✅ Paired**. Press **Done**.

✅ **Part 3 is done when** a note you write on the 📱 NEW DEVICE appears on the 🖥️ HUB COMPUTER within a few seconds — and the other way round.

> 💡 **Each QR code works once, for 10 minutes.** To add another device, do **Part 2** on it, then **Part 3** again (with a new code).

---

## 👀 What to expect

- **Sync is live.** Changes usually arrive on your other devices in **5–10 seconds**.
- **The 🖥️ hub computer is the meeting point.** When it's off, asleep, or Obsidian is closed there, your devices show *"Hub is offline. Changes are saved and will sync when your computer is back."* Keep writing — everything catches up automatically later.
- **tcsync keeps the hub awake** while Obsidian is open (you can turn this off in ⚙️ **Settings** → **tcsync**). It does **not** keep the computer on when you close the lid or shut it down.
- **First sync of a big vault** (lots of images or PDFs) can take a while. Do it on Wi-Fi.
- **Notes already on a device are never thrown away.** When a device pairs, its existing notes are merged with the hub's, and a backup zip (`tcsync-backup-….zip`) is saved in that vault first. If the same note was changed in two places, both versions are kept.

## 🧭 Where to see what's going on

- **🖥️ Hub computer:** bottom-right corner of the Obsidian window — `tcsync: hub on · 2` means two devices are paired.
- **📱 Phone or tablet:** ⚙️ **Settings** → **tcsync** shows the status in plain words (phones have no status bar).
- **📱 Other computers:** bottom-right corner — `tcsync: synced` or `tcsync: hub offline`.

## 🛠️ If something isn't working

| You see | Where | What it means | What to do |
|---|---|---|---|
| *Hub is offline…* | 📱 new device | The 🖥️ hub computer is off or asleep, or Obsidian isn't open on it. | 🖥️ Turn the hub computer on and open Obsidian. Sync resumes by itself. |
| *…this device isn't paired any more* | 📱 new device | It was removed on the hub computer, or the hub was reset. | Do **Part 3** again (🖥️ **Add a device**, 📱 scan the new code). |
| *This code has expired* | 📱 new device | The QR code is older than 10 minutes, or was already used. | 🖥️ Close the QR window and press **Add a device** again; 📱 scan the new code. |
| *Install Self-hosted LiveSync* | 📱 new device | Part 2, step 6 was skipped. | 📱 Press the button → **Install** → **Enable**. Pairing continues by itself. |
| Nothing happens after scanning | 📱 new device | The camera didn't open the link in Obsidian. | 🖥️ Press **Copy link** and send it to yourself; 📱 tap the link there (or paste it in ⚙️ **Settings** → **tcsync** → **Paste pairing link**). |
| *Hub problem: …* | 🖥️ hub computer | The hub couldn't start (e.g. no internet). | 🖥️ Check the internet connection, then restart Obsidian. |

**Please don't** change Self-hosted LiveSync's own settings or run its setup wizard on any device — tcsync configures it for you, and changing it can stop syncing.

## 📋 Everyday tasks

- **Add another device:** 📱 do **Part 2** on it, then **Part 3** (🖥️ **Add a device** → 📱 scan).
- **Remove a lost or old device:** 🖥️ ⚙️ **Settings** → **tcsync** → find the device under **Devices** → **Remove**. It stops syncing immediately; its notes stay on it.
- **Stop using this computer as the hub:** 🖥️ ⚙️ **Settings** → **tcsync** → **This device is…** → **Syncing with a hub**. Nothing is deleted; your devices pause until a hub is back.

---

## 🔐 Why it's private

- **Locked before it leaves.** Every note and file name is encrypted on your device with a key that only your devices have. tcsync creates that key for you and passes it to each device inside the QR code.
- **A sealed tunnel.** Devices talk to your hub computer through a WireGuard® tunnel. Only devices you added with a QR code get in — everyone else is ignored, even if they knew your hub's address.
- **No open doors.** Nothing is exposed on your hub computer or router; no port forwarding.
- **The relay can't read anything.** Phones can't connect directly to your hub computer, so the encrypted traffic passes through a public relay run by the tailcat project. It only ever sees locked boxes.
- **No account, no subscription, no third party holding your notes.**

## 🤓 How it works (for the curious)

tcsync combines two open-source projects:

- **[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)** does the actual syncing, with end-to-end encryption. It normally needs a CouchDB server; **tcsync's hub replaces that server** with a small CouchDB-compatible database (PouchDB) running inside Obsidian on your hub computer.
- **[tailcat](https://github.com/tailscale/tailcat)** — Tailscale's encrypted tunnel without accounts — compiled to WebAssembly so it runs **inside the plugin**, on desktop and on Android, with no VPN app.

![Step 1: on your phone, LiveSync hands its changes to tcsync. Step 2: tcsync sends them encrypted to the relay, which cannot read them. Step 3: the relay passes them to the tcsync hub on the hub computer, which checks the sender is a device added by QR code and ignores anyone else. Step 4: the hub stores them in the hub database, still end-to-end encrypted. Step 5: other devices' changes come back the same way.](https://raw.githubusercontent.com/englishcompiler/tcsync/main/docs/img/how-it-works.png)

The full technical picture — request flow, security model, where everything is stored — is in **[docs/architecture.md](docs/architecture.md)**.

## 🧰 Advanced: your own always-on server

If you'd rather run a separate, always-on CouchDB server (a Raspberry Pi, NAS or VM) so devices can sync even when your hub computer is off, tcsync supports that too: choose **Advanced: my own server** and follow **[docs/setup.md](docs/setup.md)**. Most people don't need this.

## Building from source

Requires Go 1.27.4+ (fetched automatically through `GOTOOLCHAIN`) and Node 20+.

```sh
npm ci
npm test                 # unit tests
npm run build            # builds bridge/dist/tcsync.wasm, then main.js
TAILCAT_BIN=/path/to/tailcat bridge/test/run.sh                         # tunnel integration tests (needs network)
LIVESYNC_DIR=/path/to/obsidian-livesync node test/e2e/hub-e2e.mjs /tmp/e2e   # end-to-end in real Obsidian (macOS)
```

Releases are built by GitHub Actions when a version tag (`x.y.z`) is pushed.

## License

MIT. `main.js` embeds tailcat and Tailscale code (BSD-3-Clause), PouchDB (Apache-2.0) and fflate/qrcode-generator (MIT); `server/setup-uri.mjs` is adapted from Self-hosted LiveSync (MIT). See [LICENSE](LICENSE). WireGuard is a registered trademark of Jason A. Donenfeld.
