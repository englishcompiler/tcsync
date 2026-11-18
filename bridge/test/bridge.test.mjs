// Integration tests for the tcsync WASM bridge against a real `tailcat serve`.
// Run via test/run.sh (needs TAILCAT_BIN and a built dist/tcsync.wasm).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TAILCAT = process.env.TAILCAT_BIN;
if (!TAILCAT) throw new Error("TAILCAT_BIN is required");

let echo, port, servers = [];
const stored = new Map();

function startServe(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(TAILCAT, ["serve", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    servers.push(p);
    let buf = "";
    const t = setTimeout(() => reject(new Error("serve did not print address: " + buf)), 30000);
    p.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/(tc[A-Za-z0-9_-]{40,})/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
  });
}

let addr, deniedAddr, instance;
before(async () => {
  echo = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method === "PUT") { stored.set(req.url, body); res.writeHead(201); return res.end("ok"); }
      if (stored.has(req.url)) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(stored.get(req.url)); }
      res.writeHead(200, { "content-type": "text/plain", "x-echo": "1" });
      res.end("path=" + req.url);
    });
  });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  port = echo.address().port;
  addr = await startServe([String(port)]);
  deniedAddr = await startServe(["--allow=none", String(port)]);
  require(path.join(here, "../dist/wasm_exec.js"));
  const go = new globalThis.Go();
  const ready = new Promise((r) => (globalThis.onTcsyncReady = r));
  ({ instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(here, "../dist/tcsync.wasm")), go.importObject));
  go.run(instance);
  await ready;
});

after(() => { for (const s of servers) s.kill(); echo.close(); globalThis.tcsyncClose?.(); setTimeout(() => process.exit(0), 100); });

test("newKey returns privkey:/nodekey: pair and publicKey(priv) matches", { timeout: 60000 }, () => {
  const k = globalThis.tcsyncNewKey();
  assert.match(k.privateKey, /^privkey:[0-9a-f]{64}$/);
  assert.match(k.publicKey, /^nodekey:[0-9a-f]{64}$/);
  assert.equal(globalThis.tcsyncPublicKey(k.privateKey), k.publicKey);
});

test("init rejects within dialTimeoutMs=8000 when the server address is wrong", { timeout: 60000 }, async () => {
  const k = globalThis.tcsyncNewKey();
  const bad = addr.slice(0, -6) + (addr.endsWith("AAAAAA") ? "BBBBBB" : "AAAAAA");
  const t0 = Date.now();
  await assert.rejects(globalThis.tcsyncInit({ addr: bad, privateKey: k.privateKey, dialTimeoutMs: 8000 }));
  assert.ok(Date.now() - t0 < 15000, "took " + (Date.now() - t0));
});

test("init rejects when serve --allow excludes this key", { timeout: 60000 }, async () => {
  const k = globalThis.tcsyncNewKey();
  await assert.rejects(globalThis.tcsyncInit({ addr: deniedAddr, privateKey: k.privateKey, dialTimeoutMs: 8000 }));
});

test("GET returns 200 and echoed path", { timeout: 60000 }, async () => {
  const k = globalThis.tcsyncNewKey();
  await globalThis.tcsyncInit({ addr, privateKey: k.privateKey });
  const r = await globalThis.tcsyncFetch({ method: "GET", url: `http://couch.tailcat:${port}/db/_changes?since=0`, headers: { accept: "text/plain" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-echo"], "1");
  assert.deepEqual(Object.keys(r.headers).filter((k) => k !== k.toLowerCase()), [], "headers must be lower-case only");
  assert.equal(new TextDecoder().decode(r.body), "path=/db/_changes?since=0");
});

test("5 MB PUT body round-trips byte-identical (sha256 equal)", { timeout: 60000 }, async () => {
  const big = crypto.randomBytes(5 * 1024 * 1024);
  const put = await globalThis.tcsyncFetch({ method: "PUT", url: `http://couch.tailcat:${port}/blob`, headers: {}, body: new Uint8Array(big) });
  assert.equal(put.status, 201);
  const get = await globalThis.tcsyncFetch({ method: "GET", url: `http://couch.tailcat:${port}/blob`, headers: {} });
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  assert.equal(sha(Buffer.from(get.body)), sha(big));
});

test("WASM memory stays bounded across many large uploads (request bodies are released)", { timeout: 600000 }, async () => {
  await globalThis.tcsyncInit({ addr, privateKey: globalThis.tcsyncNewKey().privateKey });
  const body = new Uint8Array(crypto.randomBytes(2 * 1024 * 1024));
  const put = () => globalThis.tcsyncFetch({ method: "PUT", url: `http://couch.tailcat:${port}/mem`, headers: {}, body });
  for (let i = 0; i < 3; i++) await put(); // warm up allocator
  const before = instance.exports.mem.buffer.byteLength;
  for (let i = 0; i < 12; i++) await put();
  const grownMB = (instance.exports.mem.buffer.byteLength - before) / 1048576;
  assert.ok(grownMB < 12, `WASM memory grew ${grownMB.toFixed(1)} MB over 24 MB of uploads`);
});

test("ping resolves on a live tunnel and rejects when the server is gone", { timeout: 60000 }, async () => {
  await globalThis.tcsyncInit({ addr, privateKey: globalThis.tcsyncNewKey().privateKey });
  await globalThis.tcsyncPing(10000, port);
  for (const s of servers) s.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 3000));
  await assert.rejects(globalThis.tcsyncPing(5000, port));
});

// --- hub mode: the bridge as the listening end ------------------------------------------------
const te = new TextEncoder(), td = new TextDecoder();
async function hubServe(o) {
  const seen = [];
  const r = await globalThis.tcsyncServe({ keyJSON: o.keyJSON ?? "", allowed: o.allowed,
    onRequest: async (req) => { seen.push(req); return { status: 200, headers: { "content-type": "text/plain" }, body: te.encode("hub:" + req.url) }; } });
  return { ...r, seen };
}
async function canReach(addr, privateKey) {
  try { await globalThis.tcsyncInit({ addr, privateKey, dialTimeoutMs: 10000 }); return true; } catch { return false; }
}

test("serve + dial round trip: handler sees the request and the peer key", { timeout: 120000 }, async () => {
  const c = globalThis.tcsyncNewKey();
  const hub = await hubServe({ allowed: [c.publicKey] });
  assert.match(hub.addr, /^tc/);
  assert.ok(await canReach(hub.addr, c.privateKey));
  const r = await globalThis.tcsyncFetch({ method: "GET", url: "http://couch.tailcat:5984/x?y=1", headers: {} });
  assert.equal(r.status, 200);
  assert.equal(td.decode(r.body), "hub:/x?y=1");
  assert.equal(hub.seen.at(-1).peer, c.publicKey);
  await globalThis.tcsyncServeClose();
});

test("serve with an empty allowlist admits nobody", { timeout: 120000 }, async () => {
  const c = globalThis.tcsyncNewKey();
  const hub = await hubServe({ allowed: [] });
  assert.equal(await canReach(hub.addr, c.privateKey), false);
  await globalThis.tcsyncServeClose();
});

test("serveAllow and serveClose return promises (blocking in a JS callback deadlocks Go/wasm)", { timeout: 60000 }, async () => {
  const c = globalThis.tcsyncNewKey();
  await hubServe({ allowed: [] });
  const p = globalThis.tcsyncServeAllow(c.publicKey);
  assert.ok(p instanceof Promise);
  await p;
  const q = globalThis.tcsyncServeClose();
  assert.ok(q instanceof Promise);
  await q;
});

test("serveAllow admits a new key at runtime", { timeout: 120000 }, async () => {
  const a = globalThis.tcsyncNewKey(), b = globalThis.tcsyncNewKey();
  const hub = await hubServe({ allowed: [a.publicKey] });
  assert.equal(await canReach(hub.addr, b.privateKey), false);
  await globalThis.tcsyncServeAllow(b.publicKey);
  assert.ok(await canReach(hub.addr, b.privateKey));
  await globalThis.tcsyncServeClose();
});

test("close + serve again keeps the same address and drops a removed key", { timeout: 180000 }, async () => {
  const a = globalThis.tcsyncNewKey(), b = globalThis.tcsyncNewKey();
  const first = await hubServe({ allowed: [a.publicKey, b.publicKey] });
  assert.ok(await canReach(first.addr, b.privateKey));
  await globalThis.tcsyncServeClose();
  const second = await hubServe({ keyJSON: first.keyJSON, allowed: [a.publicKey] });
  assert.equal(second.addr, first.addr);
  assert.equal(await canReach(second.addr, b.privateKey), false);
  assert.ok(await canReach(second.addr, a.privateKey));
  await globalThis.tcsyncServeClose();
});
