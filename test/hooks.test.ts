import { describe, it, expect } from "vitest";
import { hookLiveSync, patchGlobalFetch, type Router } from "../src/hooks";

const route: Router = (req, _init, _orig) => {
  const u = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
  return u.includes("couch.tailcat") ? Promise.resolve(new Response("routed")) : null;
};

function fakeApp(withCore = true) {
  const calls: string[] = [];
  const api = {
    webCompatFetch: async (r: string) => { calls.push("web:" + r); return new Response("orig-web"); },
    nativeFetch: async (r: string) => { calls.push("native:" + r); return new Response("orig-native"); },
  };
  const app = { plugins: { plugins: withCore ? { "obsidian-livesync": { core: { services: { API: api } } } } : {} } };
  return { app, api, calls };
}

describe("hookLiveSync", () => {
  it("returns null without throwing when LiveSync is not loaded", () => {
    expect(hookLiveSync({ plugins: { plugins: {} } }, route)).toBeNull();
  });
  it("returns null when LiveSync has no core services", () => {
    expect(hookLiveSync({ plugins: { plugins: { "obsidian-livesync": {} } } }, route)).toBeNull();
  });
  it("routes tunnel-host URLs and passes other URLs to the original", async () => {
    const { app, api, calls } = fakeApp();
    hookLiveSync(app, route);
    expect(await (await api.webCompatFetch("http://couch.tailcat:5984/db")).text()).toBe("routed");
    expect(await (await api.nativeFetch("http://couch.tailcat:5984/db")).text()).toBe("routed");
    expect(await (await api.webCompatFetch("https://example.com/")).text()).toBe("orig-web");
    expect(calls).toEqual(["web:https://example.com/"]);
  });
  it("restore puts the original functions back", () => {
    const { app, api } = fakeApp();
    const before = [api.webCompatFetch, api.nativeFetch];
    const restore = hookLiveSync(app, route)!;
    expect(api.webCompatFetch).not.toBe(before[0]);
    restore();
    expect([api.webCompatFetch, api.nativeFetch]).toEqual(before);
  });
});

describe("patchGlobalFetch", () => {
  it("routes matching URLs, passes others through, and restores", async () => {
    const target = { fetch: async (_r: RequestInfo | URL) => new Response("orig") } as { fetch: typeof fetch };
    const orig = target.fetch;
    const restore = patchGlobalFetch(route, target);
    expect(await (await target.fetch("http://couch.tailcat:5984/")).text()).toBe("routed");
    expect(await (await target.fetch("https://example.com/")).text()).toBe("orig");
    restore();
    expect(target.fetch).toBe(orig);
  });
});

import { installLiveSyncHook } from "../src/hooks";

describe("installLiveSyncHook", () => {
  it("hooks synchronously when LiveSync is already loaded (before any timer runs)", () => {
    const { app, api } = fakeApp();
    const orig = api.webCompatFetch;
    const timers: (() => void)[] = [];
    const handle = installLiveSyncHook(app, route, { schedule: (fn) => { timers.push(fn); }, intervalMs: 100, limit: 10 });
    expect(api.webCompatFetch).not.toBe(orig);
    expect(timers.length).toBe(0);
    handle.restore();
    expect(api.webCompatFetch).toBe(orig);
  });

  it("keeps retrying until LiveSync appears, then hooks it", () => {
    const { app } = fakeApp(false);
    const timers: (() => void)[] = [];
    const handle = installLiveSyncHook(app, route, { schedule: (fn) => { timers.push(fn); }, intervalMs: 100, limit: 10 });
    expect(handle.hooked()).toBe(false);
    const later = fakeApp();
    app.plugins.plugins = later.app.plugins.plugins as typeof app.plugins.plugins;
    timers.shift()!();
    expect(handle.hooked()).toBe(true);
    expect(later.api.webCompatFetch.name).not.toBe("webCompatFetch");
  });

  it("gives up after the retry limit and reports not hooked", () => {
    const { app } = fakeApp(false);
    const timers: (() => void)[] = [];
    let gaveUp = false;
    const handle = installLiveSyncHook(app, route, { schedule: (fn) => { timers.push(fn); }, intervalMs: 100, limit: 3, onGiveUp: () => (gaveUp = true) });
    while (timers.length) timers.shift()!();
    expect(handle.hooked()).toBe(false);
    expect(gaveUp).toBe(true);
  });
});
