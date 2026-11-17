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
