// End-to-end helpers: launch isolated desktop Obsidian instances and drive them over CDP.
// Not part of `npm test`. See test/e2e/README.md.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OBSIDIAN = process.env.OBSIDIAN_BIN || "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Creates a vault with the given plugins copied in (dirs), and an isolated user-data dir. */
export function makeVault(root, name, { plugins = {}, files = {}, data = {} } = {}) {
  const vault = path.join(root, name);
  const ud = path.join(root, `${name}-ud`);
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(path.join(vault, ".obsidian", "plugins"), { recursive: true });
  fs.mkdirSync(ud, { recursive: true });
  for (const [id, src] of Object.entries(plugins)) {
    const dst = path.join(vault, ".obsidian", "plugins", id);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ["main.js", "manifest.json", "styles.css"]) {
      if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    if (data[id]) fs.writeFileSync(path.join(dst, "data.json"), JSON.stringify(data[id]));
  }
  fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), "[]");
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, p)), { recursive: true });
    fs.writeFileSync(path.join(vault, p), c);
  }
  const id = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  fs.writeFileSync(path.join(ud, "obsidian.json"),
    JSON.stringify({ cli: true, updateDisabled: true, vaults: { [id]: { path: vault, ts: Date.now(), open: true } } }));
  return { vault, ud, id };
}

/** Launches Obsidian on the vault with remote debugging; resolves once the app page answers. */
export async function launch(v, port) {
  const url = `obsidian://open?path=${encodeURIComponent(v.vault)}`;
  const p = spawn(OBSIDIAN, [`--user-data-dir=${v.ud}`, `--remote-debugging-port=${port}`, url],
    { detached: true, stdio: ["ignore", fs.openSync(`${v.ud}.log`, "a"), fs.openSync(`${v.ud}.log`, "a")] });
  p.unref();
  const page = new Page(port);
  for (let i = 0; i < 60; i++) {
    try { if ((await page.eval("return typeof app !== 'undefined' && !!app.workspace")) === true) return page; } catch { /* starting */ }
    await sleep(1000);
  }
  throw new Error(`Obsidian on :${port} did not start`);
}

export function killAll(root) {
  try { execFileSync("pkill", ["-f", `--user-data-dir=${root}`]); } catch { /* none */ }
}

export class Page {
  constructor(port) { this.port = port; }
  async #ws() {
    const targets = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
    const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://"));
    if (!page) throw new Error("no app page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    return ws;
  }
  /** Evaluates an async function body in the page; returns its value (JSON-serialisable). */
  async eval(body, timeoutMs = 120000) {
    const ws = await this.#ws();
    try {
      const res = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`eval timeout: ${body.slice(0, 60)}`)), timeoutMs);
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); resolve(d); } };
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
          params: { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true } }));
      });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
      return res.result?.result?.value;
    } finally { ws.close(); }
  }
  /** Waits until the page answers again (after an app reload). */
  async waitReady(timeoutMs = 90000) {
    const t0 = Date.now();
    await sleep(2000);
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval("return !!(app?.workspace?.layoutReady)", 5000)) return; } catch { /* reloading */ }
      await sleep(1000);
    }
    throw new Error("page did not come back");
  }
  modals() {
    return this.eval(`return [...document.querySelectorAll('.modal')].map(m => ({
      title: m.querySelector('.modal-title')?.innerText ?? '',
      text: m.innerText.slice(0, 400),
      buttons: [...m.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean),
      checks: [...m.querySelectorAll('label')].filter(l => l.querySelector('input[type=checkbox]')).map(l => l.innerText.trim().slice(0, 80)) }))`);
  }
  click(buttonText) {
    return this.eval(`const m=[...document.querySelectorAll('.modal')].pop(); const b=m&&[...m.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(buttonText)}); if(!b) return false; b.click(); return true;`);
  }
  enablePlugins(ids, vaultId) {
    return this.eval(`localStorage.setItem('enable-plugin-${vaultId}','true'); await app.plugins.setEnable(true); await app.plugins.loadManifests();
      for (const id of ${JSON.stringify(ids)}) await app.plugins.enablePluginAndSave(id);
      await new Promise(r=>setTimeout(r,5000)); return Object.keys(app.plugins.plugins);`);
  }
}
