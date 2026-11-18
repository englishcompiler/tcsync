import { describe, it, expect, beforeEach } from "vitest";
import memory from "pouchdb-adapter-memory";
import { PouchDB } from "../src/hub/pouch";
import { createStore } from "../src/hub/store";
import { Hub, newHubState, PENDING_TTL_MS, CLAIM_PATH, EPOCH_PATH, type HubBridge } from "../src/hub/hub";
import { hubStorePrefix } from "../src/hub/store";
import type { HubState } from "../src/types";
import type { HubRequest } from "../src/hub/handler";

PouchDB.plugin(memory);
const te = new TextEncoder();

function fakeBridge() {
  let n = 0;
  const log: string[] = [];
  const b: HubBridge & { log: string[]; allowed: string[]; onRequest?: (r: HubRequest) => unknown } = {
    log, allowed: [],
    serve: async (o) => { log.push(`serve(${o.allowed.length})`); b.allowed = [...o.allowed]; b.onRequest = o.onRequest; return { addr: "tcHUB", keyJSON: o.keyJSON || '{"k":1}' }; },
    serveAllow: async (k) => { log.push(`allow(${k})`); b.allowed.push(k); },
    serveClose: async () => { log.push("close"); },
    newKey: () => { n++; return { privateKey: `privkey:${n}`, publicKey: `nodekey:${n}` }; },
  };
  return b;
}

function setup(state?: HubState, storeOver?: Partial<ReturnType<typeof createStore>>) {
  let s: HubState = state ?? newHubState("My vault");
  const bridge = fakeBridge();
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const hub = new Hub({
    bridge, store: { ...createStore("memory", `h${Math.random().toString(36).slice(2)}-`), ...storeOver },
    state: () => s, save: async (x) => { s = x; }, now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return () => timers.splice(timers.indexOf(t), 1); },
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    await new Promise((r) => setTimeout(r, 10));
  };
  return { hub, bridge, state: () => s, advance };
}
const OWN = "nodekey:" + "a".repeat(64), THIEF = "nodekey:" + "b".repeat(64), OTHER = "nodekey:" + "c".repeat(64);
const settle = () => new Promise((r) => setTimeout(r, 400));
const req = (url: string, peer?: string): HubRequest => ({ method: "GET", url, headers: {}, body: new Uint8Array(), peer });

describe("newHubState", () => {
  it("generates secrets and no devices; keep-awake on by default", () => {
    const s = newHubState("V");
    expect(s.secrets.e2ee).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s.secrets.idKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s).toMatchObject({ vaultName: "V", devices: [], keepAwake: true, keyJSON: "", addr: "" });
    expect(s.epoch).toMatch(/^[0-9a-f]{16}$/);
    expect(newHubState("V").secrets.e2ee).not.toBe(s.secrets.e2ee);
  });
});

describe("Hub", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it("start serves and saves the address and identity; zero devices still serves a list (bridge guards empties)", async () => {
    expect(await t.hub.start()).toBe("tcHUB");
    expect(t.bridge.log).toEqual(["serve(0)"]);
    expect(t.state()).toMatchObject({ addr: "tcHUB", keyJSON: '{"k":1}' });
  });

  it("addDevice mints a key, allows it at runtime and records it as pending", async () => {
    await t.hub.start();
    const { privateKey, record } = await t.hub.addDevice("Phone");
    expect(privateKey).toBe("privkey:1");
    expect(record).toMatchObject({ name: "Phone", publicKey: "nodekey:1", state: "pending" });
    expect(t.bridge.log).toContain("allow(nodekey:1)");
    expect(t.state().devices).toHaveLength(1);
  });

  it("a pending device's ordinary requests don't pair it (only a claim does); a paired device's set lastSeen", async () => {
    await t.hub.start();
    await t.hub.addDevice("Phone");
    await t.bridge.onRequest!(req("/", "nodekey:1"));
    expect(t.state().devices[0].state).toBe("pending");
    await t.bridge.onRequest!({ method: "POST", url: CLAIM_PATH, headers: {}, body: te.encode(JSON.stringify({ publicKey: OWN })), peer: "nodekey:1" });
    await settle();
    await t.advance(120_000);
    await t.bridge.onRequest!(req("/", OWN));
    expect(t.state().devices[0]).toMatchObject({ state: "paired", lastSeen: 1_120_000 });
  });

  it("expires pending devices after 10 minutes via a listener restart", async () => {
    await t.hub.start();
    await t.hub.addDevice("Phone");
    await t.advance(PENDING_TTL_MS + 1);
    expect(t.state().devices).toEqual([]);
    expect(t.bridge.log.slice(-2)).toEqual(["close", "serve(0)"]);
  });

  it("a paired device does not expire", async () => {
    await t.hub.start();
    await t.hub.addDevice("Phone");
    await t.bridge.onRequest!({ method: "POST", url: CLAIM_PATH, headers: {}, body: te.encode(JSON.stringify({ publicKey: OWN })), peer: "nodekey:1" });
    await settle();
    await t.advance(PENDING_TTL_MS + 1);
    expect(t.state().devices).toHaveLength(1);
  });

  it("start drops pending devices that expired while Obsidian was closed", async () => {
    const s = newHubState("V");
    s.devices = [
      { name: "old", publicKey: "nodekey:old", addedAt: 0, state: "pending" },
      { name: "ok", publicKey: "nodekey:ok", addedAt: 0, state: "paired" },
    ];
    const u = setup(s);
    await u.hub.start();
    expect(u.state().devices.map((d) => d.name)).toEqual(["ok"]);
    expect(u.bridge.allowed).toEqual(["nodekey:ok"]);
  });

  it("removeDevice restarts the listener without the key; address unchanged", async () => {
    await t.hub.start();
    await t.hub.addDevice("A");
    await t.hub.addDevice("B");
    await t.hub.removeDevice("nodekey:1");
    expect(t.bridge.log.slice(-2)).toEqual(["close", "serve(1)"]);
    expect(t.bridge.allowed).toEqual(["nodekey:2"]);
    expect(t.state().addr).toBe("tcHUB");
  });

  it("storeWasLost is true when the hub was set up before but its store is empty", async () => {
    expect(await t.hub.storeWasLost()).toBe(false); // never initialised
    await t.hub.markInitialised();
    expect(await t.hub.storeWasLost()).toBe(true);
    await t.hub.handle({ ...req("/obsidian"), method: "PUT" });
    await t.hub.handle({ method: "PUT", url: "/obsidian/a", headers: {}, body: te.encode("{}") });
    expect(await t.hub.storeWasLost()).toBe(false);
  });

  it("a failed restart doesn't block later restarts, and the hub retries until it serves again", async () => {
    await t.hub.start();
    await t.hub.addDevice("A");
    let failures = 1;
    const serve = t.bridge.serve;
    t.bridge.serve = async (o) => { if (failures-- > 0) throw new Error("relay unreachable"); return serve(o); };
    await t.hub.removeDevice("nodekey:1").catch(() => {});
    expect(t.hub.serving).toBe(false);
    expect(t.hub.lastError).toMatch(/relay unreachable/);
    await t.advance(60_000);
    expect(t.hub.serving).toBe(true);
    expect(t.hub.lastError).toBe("");
    await t.hub.addDevice("B");
    await t.hub.removeDevice("nodekey:2");
    expect(t.bridge.log.at(-1)).toBe("serve(0)");
  });

  it("a failed first start is retried too", async () => {
    let failures = 1;
    const serve = t.bridge.serve;
    t.bridge.serve = async (o) => { if (failures-- > 0) throw new Error("offline"); return serve(o); };
    await expect(t.hub.start()).rejects.toThrow("offline");
    await t.advance(60_000);
    expect(t.hub.serving).toBe(true);
  });

  it("storeWasLost is false (not a destructive rebuild) when the store can't be read", async () => {
    const u = setup(undefined, { isEmpty: async () => { throw new Error("connection is closing"); } });
    await u.hub.markInitialised();
    expect(await u.hub.storeWasLost()).toBe(false);
  });

  it("claim: a pending device swaps the minted key for its own; the link can't be used again", async () => {
    await t.hub.start();
    await t.hub.addDevice("Phone");
    const claim = (peer: string, pub: string) => t.bridge.onRequest!({ method: "POST", url: CLAIM_PATH, headers: {}, body: te.encode(JSON.stringify({ publicKey: pub })), peer }) as Promise<{ status: number }>;
    expect((await claim("nodekey:1", OWN)).status).toBe(200);
    await settle();
    expect(t.state().devices[0]).toMatchObject({ publicKey: OWN, state: "paired" });
    expect(t.bridge.allowed).toEqual([OWN]);
    expect((await claim("nodekey:1", THIEF)).status).toBe(403);
    expect((await claim(OWN, OTHER)).status).toBe(403);
    expect(t.state().devices.map((d) => d.publicKey)).toEqual([OWN]);
  });

  it("claim rejects a malformed key", async () => {
    await t.hub.start();
    await t.hub.addDevice("Phone");
    const r = (await t.bridge.onRequest!({ method: "POST", url: CLAIM_PATH, headers: {}, body: te.encode('{"publicKey":"nope"}'), peer: "nodekey:1" })) as { status: number };
    expect(r.status).toBe(400);
  });

  it("the store prefix is per app/vault, so two vaults on one computer never share a hub database", () => {
    expect(hubStorePrefix("abc123")).toBe("tcsync-hub-abc123-");
    expect(hubStorePrefix("abc123")).not.toBe(hubStorePrefix("def456"));
  });

  it("serves the hub epoch to devices, and a claim's answer carries it", async () => {
    const r = await t.hub.handle(req(EPOCH_PATH, "nodekey:x"));
    expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ epoch: t.state().epoch });
    await t.hub.start();
    await t.hub.addDevice("Phone");
    const c = (await t.bridge.onRequest!({ method: "POST", url: CLAIM_PATH, headers: {}, body: te.encode(JSON.stringify({ publicKey: OWN })), peer: "nodekey:1" })) as { body: Uint8Array };
    expect(JSON.parse(new TextDecoder().decode(c.body))).toEqual({ ok: true, epoch: t.state().epoch });
  });

  it("newEpoch changes the epoch (after the hub database is rebuilt)", async () => {
    const before = t.state().epoch;
    await t.hub.newEpoch();
    expect(t.state().epoch).not.toBe(before);
    expect(t.state().epoch).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handle() serves the in-process path through the same handler", async () => {
    const r = await t.hub.handle(req("/"));
    expect(r.status).toBe(200);
  });

  it("devices() lists names, states and last seen for the settings screen", async () => {
    await t.hub.start();
    await t.hub.addDevice("Phone");
    expect(t.hub.devices().map((d) => [d.name, d.state])).toEqual([["Phone", "pending"]]);
  });
});
