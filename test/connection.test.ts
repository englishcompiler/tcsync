import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Connection } from "../src/connection";
import type { Bridge, BridgeRequest, ConnState, TcsyncSettings } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/types";

const PRIV = "privkey:" + "1".repeat(64);
const PUB = "nodekey:" + "a".repeat(64);

function fakeBridge(over: Partial<Bridge> = {}): Bridge & { inits: number } {
  const b = {
    inits: 0,
    async init() { b.inits++; },
    async fetch(_r: BridgeRequest) { return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("ok") }; },
    close() {},
    publicKey() { return PUB; },
    newKey() { return { privateKey: PRIV, publicKey: PUB }; },
    ...over,
  };
  return b;
}

const settings = (o: Partial<TcsyncSettings> = {}): TcsyncSettings => ({ ...DEFAULT_SETTINGS, addr: "tcSERVER", privateKey: PRIV, ...o });

describe("Connection", () => {
  let states: ConnState[];
  let clock: number;
  beforeEach(() => { states = []; clock = 1_000_000; });
  afterEach(() => vi.useRealTimers());
  const mk = (b: Bridge, s = settings(), direct?: typeof fetch) =>
    new Connection(b, () => s, (st) => states.push(st), () => clock, direct);

  it("initialises the bridge only once for concurrent ensureUp calls", async () => {
    const b = fakeBridge();
    const c = mk(b);
    await Promise.all([c.ensureUp(), c.ensureUp(), c.ensureUp()]);
    expect(b.inits).toBe(1);
    expect(states).toEqual(["connecting", "up"]);
  });

  it("reports unreachable with the device key and backs off 1s, 2s, … capped at 60s", async () => {
    const b = fakeBridge({ async init() { throw new Error("server unreachable"); } });
    const c = mk(b);
    await expect(c.ensureUp()).rejects.toThrow(/server offline or this device isn't allowlisted\. Device key: nodekey:a{64}/);
    expect(c.state).toBe("unreachable");
    expect(c.nextAttemptInMs()).toBe(1000);
    clock += 1000; await expect(c.ensureUp()).rejects.toThrow(TypeError);
    expect(c.nextAttemptInMs()).toBe(2000);
    for (let i = 0; i < 10; i++) { clock += 60_000; await c.ensureUp().catch(() => {}); }
    expect(c.nextAttemptInMs()).toBe(60_000);
  });

  it("does not call init again while backing off", async () => {
    let n = 0;
    const b = fakeBridge({ async init() { n++; throw new Error("x"); } });
    const c = mk(b);
    await c.ensureUp().catch(() => {});
    await c.ensureUp().catch(() => {});
    expect(n).toBe(1);
  });

  it("resets the backoff after a success", async () => {
    let fail = true;
    const b = fakeBridge({ async init() { if (fail) throw new Error("x"); } });
    const c = mk(b);
    await c.ensureUp().catch(() => {});
    fail = false; clock += 1000;
    await c.ensureUp();
    expect(c.state).toBe("up");
    expect(c.nextAttemptInMs()).toBe(0);
  });

  it("onResume retries immediately when unreachable", async () => {
    let fail = true; let n = 0;
    const b = fakeBridge({ async init() { n++; if (fail) throw new Error("x"); } });
    const c = mk(b);
    await c.ensureUp().catch(() => {});
    fail = false;
    await c.onResume();
    expect(n).toBe(2);
    expect(c.state).toBe("up");
  });

  it("routes a request through the bridge and returns a Response", async () => {
    const seen: BridgeRequest[] = [];
    const b = fakeBridge({ async fetch(r) { seen.push(r); return { status: 200, headers: {}, body: new TextEncoder().encode("hi") }; } });
    const res = await mk(b).request("http://couch.tailcat:5984/db", { method: "GET" });
    expect(await res.text()).toBe("hi");
    expect(seen[0].url).toBe("http://couch.tailcat:5984/db");
  });

  it("rejects with a TypeError within 30s when the bridge hangs, then marks unreachable", async () => {
    vi.useFakeTimers();
    const b = fakeBridge({ fetch: () => new Promise(() => {}) });
    const c = mk(b);
    await c.ensureUp();
    const p = c.request("http://couch.tailcat:5984/db/doc");
    const assertion = expect(p).rejects.toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(c.state).toBe("unreachable");
  });

  it("passes HTTP error statuses through without marking unreachable", async () => {
    const b = fakeBridge({ async fetch() { return { status: 401, headers: {}, body: new Uint8Array() }; } });
    const c = mk(b);
    const res = await c.request("http://couch.tailcat:5984/db");
    expect(res.status).toBe(401);
    expect(c.state).toBe("up");
  });

  it("in direct mode rewrites to the direct URL and never touches the bridge", async () => {
    const b = fakeBridge();
    const direct = vi.fn(async (u: RequestInfo | URL) => new Response("direct:" + String(u)));
    const c = mk(b, settings({ mode: "direct", directUrl: "http://127.0.0.1:5984" }), direct as unknown as typeof fetch);
    const res = await c.request("http://couch.tailcat:5984/db/x?y=1");
    expect(await res.text()).toBe("direct:http://127.0.0.1:5984/db/x?y=1");
    expect(b.inits).toBe(0);
    expect(c.state).toBe("direct");
  });
});
