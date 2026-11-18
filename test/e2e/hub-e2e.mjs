// End-to-end: hub mode with real Obsidian + Self-hosted LiveSync, isolated instances.
//   LIVESYNC_DIR=<installed obsidian-livesync folder> node test/e2e/hub-e2e.mjs <workdir> [scenario…]
// Uses the built plugin in the repo root (npm run build). Prints PASS/FAIL per scenario.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeVault, launch, killAll, sleep } from "./lib/obsidian.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [root, ...only] = process.argv.slice(2);
const LS = process.env.LIVESYNC_DIR;
if (!root || !LS) throw new Error("usage: LIVESYNC_DIR=… node test/e2e/hub-e2e.mjs <workdir> [scenario…]");
fs.mkdirSync(root, { recursive: true });
const TC = repo;
const want = (s) => only.length === 0 || only.includes(s);
const results = [];
const pass = (n, d = "") => { results.push(`PASS ${n}${d ? ` (${d})` : ""}`); console.log(results.at(-1)); };
const fail = (n, d) => { results.push(`FAIL ${n}: ${d}`); console.log(results.at(-1)); };
const log = (...a) => console.log("  ·", ...a);

const tc = "app.plugins.plugins.tcsync";
const lsCore = "app.plugins.plugins['obsidian-livesync']?.core";
const data = (v) => JSON.parse(fs.readFileSync(path.join(v.vault, ".obsidian/plugins/tcsync/data.json"), "utf8"));

async function until(page, what, body, timeoutMs, everyMs = 2000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await page.eval(body, 15000); if (last) return { ok: true, secs: (Date.now() - t0) / 1000, value: last }; } catch (e) { last = e.message; }
    await sleep(everyMs);
  }
  return { ok: false, last: JSON.stringify(last)?.slice(0, 300), what };
}
async function clickWhenShown(page, text, timeoutMs = 30000) {
  return until(page, `button ${text}`, `const b=[...document.querySelectorAll('.modal button')].find(b=>b.innerText.trim()===${JSON.stringify(text)}); if(!b) return false; b.click(); return true;`, timeoutMs, 500);
}
const unthrottle = (page) => page.eval("require('electron').remote.getCurrentWebContents().setBackgroundThrottling(false); return 1").catch(() => 0);
const files = (page) => page.eval("return app.vault.getFiles().map(f=>f.path).sort()");
const write = (page, p, text) => page.eval(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(p)}); if(f) await app.vault.modify(f, ${JSON.stringify(text)}); else await app.vault.create(${JSON.stringify(p)}, ${JSON.stringify(text)}); return 1`);
const arrives = (page, p, needle, timeoutMs) => until(page, `${p} contains ${needle}`, `const f=app.vault.getAbstractFileByPath(${JSON.stringify(p)}); return !!f && (await app.vault.read(f)).includes(${JSON.stringify(needle)})`, timeoutMs, 500);
const liveIdle = (page) => until(page, "live sync running", `const s=${lsCore}?.services?.replicator?.getActiveReplicator()?.syncStatus; return s==='LIVE'||s==='PAUSED' ? s : false`, 120000);
async function setupDone(page, v, timeoutMs = 240000) {
  // Obsidian restarts during setup; wait for tcsync to clear its autopilot session, then for live sync.
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    try { if (!data(v).autopilot && (await page.eval("return !!app.workspace.layoutReady", 5000))) break; } catch { /* restarting */ }
  }
  if (data(v).autopilot) return { ok: false, last: "autopilot still active" };
  await sleep(5000); // enableLiveSync restarts LiveSync once
  await page.waitReady();
  await unthrottle(page);
  return liveIdle(page);
}

killAll(root);
let A, B, pa, pb, link;
try {
  // 1. make-hub ------------------------------------------------------------------------------
  A = makeVault(root, "hubA", { plugins: { tcsync: TC, "obsidian-livesync": LS }, files: { "Hub note 1.md": "# one\n", "Folder/Hub note 2.md": "# two\n" } });
  pa = await launch(A, 9371);
  log("A plugins", await pa.enablePlugins(["tcsync", "obsidian-livesync"], A.id));
  await pa.eval("document.querySelectorAll('.modal .modal-close-button').forEach(b=>b.click()); return 1");
  await unthrottle(pa);
  await pa.eval(`void ${tc}.makeHub(); return 1`);
  const confirm = await clickWhenShown(pa, "Make this computer the hub");
  if (!confirm.ok) throw new Error("no make-hub confirmation");
  const hubDone = await setupDone(pa, A);
  const docs = hubDone.ok ? await pa.eval(`const r=await ${tc}.hub.handle({method:'GET',url:'/obsidian',headers:{},body:new Uint8Array()}); return JSON.parse(new TextDecoder().decode(r.body)).doc_count`) : 0;
  const st = await pa.eval(`return ${tc}.status().text`).catch(() => "?");
  if (hubDone.ok && docs > 0 && data(A).hub?.initialised && st.startsWith("Hub on")) pass("make-hub", `${docs} docs, "${st}"`);
  else fail("make-hub", JSON.stringify({ hubDone, docs, initialised: data(A).hub?.initialised, st }));

  // 2. pair-desktop -----------------------------------------------------------------------------
  B = makeVault(root, "devB", { plugins: { tcsync: TC, "obsidian-livesync": LS }, files: { "B own note.md": "# written on B before pairing\n" } });
  pb = await launch(B, 9372);
  log("B plugins", await pb.enablePlugins(["tcsync", "obsidian-livesync"], B.id));
  await pb.eval("document.querySelectorAll('.modal .modal-close-button').forEach(b=>b.click()); return 1");
  await unthrottle(pb);
  link = await pa.eval(`return await ${tc}.addDevice('Desktop B')`);
  await pa.eval("document.querySelectorAll('.modal .modal-close-button').forEach(b=>b.click()); return 1");
  await pb.eval(`void ${tc}.onPairingLink(new URL(${JSON.stringify(link)}).searchParams.get('pair')); return 1`);
  if (!(await clickWhenShown(pb, "Pair")).ok) throw new Error("no Pair confirmation on B");
  const devDone = await setupDone(pb, B);
  const fb = await files(pb).catch(() => []);
  const backup = fs.readdirSync(B.vault).some((f) => /^tcsync-backup-\d{8}-\d{6}\.zip$/.test(f));
  const paired = data(A).hub.devices.find((d) => d.name === "Desktop B")?.state;
  await write(pb, "After pairing B.md", "probe");
  await arrives(pa, "After pairing B.md", "probe", 60000);
  const zipsOnHub = (await files(pa)).filter((f) => f.startsWith("tcsync-backup-"));
  if (devDone.ok && fb.includes("Hub note 1.md") && fb.includes("Folder/Hub note 2.md") && fb.includes("B own note.md") && backup && paired === "paired" && zipsOnHub.length === 0) pass("pair-desktop", `files ${fb.length}, backup zip stays on B, A sees B ${paired}`);
  else fail("pair-desktop", JSON.stringify({ devDone, fb, backup, paired, zipsOnHub }));

  // 3. live-both-ways (hub minimised for 6+ minutes first) --------------------------------------
  if (want("live-both-ways")) {
    await pa.eval("require('electron').remote.getCurrentWindow().minimize(); return 1");
    log("hub minimised; waiting 6.5 min");
    await sleep(390_000);
    await write(pa, "Live from A.md", "typed on the hub " + Date.now());
    const ab = await arrives(pb, "Live from A.md", "typed on the hub", 60000);
    await write(pb, "Live from B.md", "typed on B " + Date.now());
    const ba = await arrives(pa, "Live from B.md", "typed on B", 60000);
    if (ab.ok && ab.secs < 15 && ba.ok && ba.secs < 15) pass("live-both-ways", `A→B ${ab.secs}s, B→A ${ba.secs}s, hub minimised 6.5 min`);
    else fail("live-both-ways", JSON.stringify({ ab, ba }));
    await pa.eval("require('electron').remote.getCurrentWindow().restore(); return 1");
  }

  // 4. large file -------------------------------------------------------------------------------
  if (want("large-file")) {
    await pa.eval("const b=new Uint8Array(5*1024*1024); for(let i=0;i<b.length;i++) b[i]=(i*31)&255; await app.vault.createBinary('big.bin', b.buffer); return 1");
    const big = await until(pb, "big.bin on B", "const f=app.vault.getAbstractFileByPath('big.bin'); return !!f && f.stat.size===5*1024*1024", 180000, 2000);
    big.ok ? pass("large-file", `5 MB in ${big.secs}s`) : fail("large-file", big.last);
  }

  // 5. concurrent edit ---------------------------------------------------------------------------
  if (want("concurrent-edit")) {
    await write(pa, "Shared.md", "base\n");
    await arrives(pb, "Shared.md", "base", 60000);
    await pb.eval(`${tc}.conn.reset(); ${tc}.settings.addr='tcOFFLINE'; return 1`); // B offline
    await write(pa, "Shared.md", "base\nedit from A\n");
    await write(pb, "Shared.md", "base\nedit from B\n");
    await sleep(5000);
    await pb.eval(`${tc}.settings.addr=${JSON.stringify(data(B).addr)}; await ${tc}.reconnect(); return 1`);
    const c = await until(pa, "both edits kept", `const f=app.vault.getAbstractFileByPath('Shared.md'); const t=await app.vault.read(f); const conflicted = (await ${lsCore}.services.database?.localDatabase?.getDBEntry?.('Shared.md', undefined, false, false, true))?._conflicts?.length; return (t.includes('edit from A') && t.includes('edit from B')) || conflicted>0 ? (conflicted ? 'conflict' : 'merged') : false`, 120000);
    c.ok ? pass("concurrent-edit", c.value) : fail("concurrent-edit", c.last);
  }

  // 6. hub restart -------------------------------------------------------------------------------
  if (want("hub-restart")) {
    await pa.eval("app.commands.executeCommandById('app:reload'); return 1").catch(() => 0);
    await pa.waitReady();
    await unthrottle(pa);
    await write(pb, "After hub restart.md", "sent after the hub restarted");
    const r = await arrives(pa, "After hub restart.md", "sent after", 90000);
    r.ok ? pass("hub-restart", `${r.secs}s`) : fail("hub-restart", r.last);
  }

  // 7. expired link -----------------------------------------------------------------------------
  if (want("expired-link")) {
    const q = new URL(link).searchParams.get("pair");
    const p = JSON.parse(Buffer.from(q, "base64url").toString());
    const old = Buffer.from(JSON.stringify({ ...p, key: "privkey:" + "9".repeat(64), exp: Date.now() - 1000 })).toString("base64url");
    await pb.eval(`void ${tc}.onPairingLink(${JSON.stringify(old)}); return 1`);
    const n = await until(pb, "expired notice", "return [...document.querySelectorAll('.notice')].some(n=>n.innerText.includes('This code has expired. Make a new one on your computer.'))", 10000, 300);
    n.ok ? pass("expired-link") : fail("expired-link", n.last);
  }

  // 8. store lost (device must recover by itself) --------------------------------------------------------------------------------
  if (want("store-lost")) {
    await pa.eval(`await ${tc}.hub.stop(); const dbs=await indexedDB.databases(); for (const d of dbs) if (d.name && d.name.includes('tcsync-hub-')) indexedDB.deleteDatabase(d.name); setTimeout(()=>app.commands.executeCommandById('app:reload'),500); return dbs.map(d=>d.name).filter(n=>n?.includes('tcsync-hub-')).length`);
    const done = await setupDone(pa, A, 300000);
    const docs2 = await pa.eval(`const r=await ${tc}.hub.handle({method:'GET',url:'/obsidian',headers:{},body:new Uint8Array()}); return JSON.parse(new TextDecoder().decode(r.body)).doc_count`).catch(() => 0);
    const fa = await files(pa);
    await write(pa, "After rebuild.md", "written after the hub rebuilt");
    const rec = await arrives(pb, "After rebuild.md", "after the hub rebuilt", 300000);
    const fbb = await files(pb).catch(() => []);
    done.ok && docs2 > 0 && fa.includes("Hub note 1.md") && rec.ok && fbb.includes("B own note.md")
      ? pass("store-lost", `rebuilt with ${docs2} docs, notes intact; device recovered by itself in ${rec.secs}s`)
      : fail("store-lost", JSON.stringify({ done, docs2, rec, fbb }));
  }
  // 9. remove -----------------------------------------------------------------------------------
  if (want("remove")) {
    const pub = data(A).hub.devices.find((d) => d.name === "Desktop B").publicKey;
    await pa.eval(`void ${tc}.removeDevice(${JSON.stringify(pub)}, 'Desktop B'); return 1`);
    await clickWhenShown(pa, "Remove");
    await sleep(8000);
    await write(pb, "After removal.md", "should not arrive");
    const r = await arrives(pa, "After removal.md", "should not", 45000);
    const gone = !data(A).hub.devices.some((d) => d.publicKey === pub);
    !r.ok && gone ? pass("remove", "edit from removed device did not arrive") : fail("remove", JSON.stringify({ arrived: r.ok, gone }));
  }

} catch (e) {
  fail("harness", e.stack ?? String(e));
} finally {
  console.log("\n" + results.join("\n"));
  if (!process.env.KEEP) killAll(root);
}
