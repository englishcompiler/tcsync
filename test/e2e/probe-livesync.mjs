// Probe: which dialogs does Self-hosted LiveSync show when tcsync applies settings and schedules
// a rebuild (hub) or a fetch (device)? Prints each dialog's title and buttons, answering with a
// fixed policy. Needs a running hub (HUB_ADDR) and LIVESYNC_DIR/TCSYNC_DIR plugin folders.
//   node test/e2e/probe-livesync.mjs <rebuild|fetch> <workdir> <port>
import { makeVault, launch, sleep } from "./lib/obsidian.mjs";

const [mode, root, port] = process.argv.slice(2);
const LS = process.env.LIVESYNC_DIR, TC = process.env.TCSYNC_DIR, ADDR = process.env.HUB_ADDR;
const secrets = { passphrase: "probe-e2ee-passphrase", idKey: "a".repeat(64) };
const PARTIAL = {
  couchDB_URI: "http://couch.tailcat:5984", couchDB_USER: "tcsync", couchDB_PASSWORD: "tcsync", couchDB_DBNAME: "obsidian",
  remoteConfigurations: { "remote-tcsync-hub": { id: "remote-tcsync-hub", name: "tcsync hub",
    uri: "sls+http://tcsync:tcsync@couch.tailcat:5984/?db=obsidian", isEncrypted: false } },
  activeConfigurationId: "remote-tcsync-hub",
  encrypt: true, passphrase: secrets.passphrase, usePathObfuscation: true,
  idDerivationVersion: 1, idDerivationKey: secrets.idKey,
  concurrencyOfReadChunksOnline: 30, minimumIntervalOfReadChunksOnline: 25, isConfigured: true,
};
const POLICY = [
  "Compare time and take newer", "Keep local files even if deleted on remote", "Continue with these choices",
  "OK", "Yes", "I Understand, Overwrite Server", "Use this device",
];

const v = makeVault(root, `probe-${mode}`, {
  plugins: { tcsync: TC, "obsidian-livesync": LS },
  data: { tcsync: { addr: ADDR } },
  files: mode === "rebuild" ? { "Hub note.md": "# from hub\n" } : { "Device note.md": "# already on device\n" },
});
const page = await launch(v, Number(port));
console.log("plugins:", await page.enablePlugins(["tcsync", "obsidian-livesync"], v.id));
await sleep(5000);
for (const m of await page.modals()) { console.log("startup dialog:", JSON.stringify(m)); await page.click(m.buttons.at(-1)); }

const services = `const c=app.plugins.plugins['obsidian-livesync'].core;`;
console.log("apply:", await page.eval(`${services} await c.services.setting.applyPartial(${JSON.stringify(PARTIAL)}, true); return 'ok'`));
console.log("schedule:", await page.eval(`${services} setTimeout(()=>c.serviceModules.rebuilder.${mode === "rebuild" ? "scheduleRebuild" : "scheduleFetch"}(), 10); return 'scheduled'`));
await page.waitReady();

const seen = [];
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const ms = await page.modals().catch(() => []);
  for (const m of ms) {
    const pick = POLICY.find((p) => m.buttons.includes(p));
    seen.push({ title: m.title, buttons: m.buttons, checks: m.checks, pick: pick ?? null });
    console.log("DIALOG", JSON.stringify(seen.at(-1)));
    if (m.checks.length) await page.eval(`const m=[...document.querySelectorAll('.modal')].pop(); m.querySelectorAll('input[type=checkbox]').forEach(i=>{ if(!i.checked) i.click(); }); return 1`);
    if (pick) await page.click(pick); else { console.log("UNKNOWN dialog, stopping"); process.exit(2); }
    await sleep(1500);
  }
  const state = await page.eval(`${services} const fl=await app.vault.adapter.exists('flag_fetch.md')||await app.vault.adapter.exists('flag_rebuild.md'); const s=c.services.setting.currentSettings(); return {flag:fl, ready: !!c.services.appLifecycle.isReady?.(), live:s.liveSync, periodic:s.periodicReplication, files: app.vault.getFiles().map(f=>f.path)}`).catch(() => null);
  if (state && !state.flag && state.ready && ms.length === 0) { console.log("DONE", JSON.stringify(state)); break; }
}
