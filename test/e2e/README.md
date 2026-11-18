# End-to-end tests (not run in CI)

They drive real, isolated Obsidian desktop instances (macOS) over the Chrome DevTools Protocol.
Your own Obsidian and vaults are never touched: each instance gets its own `--user-data-dir`
and a fresh vault under the work directory.

```sh
npm run build
LIVESYNC_DIR=/path/to/.obsidian/plugins/obsidian-livesync node test/e2e/hub-e2e.mjs /tmp/tcsync-e2e
```

Scenarios: make-hub, pair-desktop, live-both-ways (hub window minimised for 6.5 minutes),
large-file, concurrent-edit, hub-restart, expired-link, remove, store-lost. Pass scenario names to
run a subset (make-hub and pair-desktop always run). `KEEP=1` leaves the instances running.

`probe-livesync.mjs` lists the dialogs Self-hosted LiveSync shows during initialisation; use it
when a new LiveSync release changes them (the answers live in `src/livesync/configure.ts`).

Android was checked by hand with an emulator: open the pairing link with
`adb shell "am start -a android.intent.action.VIEW -d '<link>' md.obsidian"`.
