import { describe, it, expect } from "vitest";
import { createRouter } from "../src/router";

const orig = (async () => new Response("orig")) as unknown as typeof fetch;

describe("createRouter", () => {
  const base = { host: () => "couch.tailcat", ready: Promise.resolve(), verbose: () => false };
  it("routes tunnel-host requests once settings are loaded", async () => {
    const r = createRouter({ ...base, unloaded: () => false, request: async () => new Response("routed") });
    expect(await (await r("http://couch.tailcat:5984/db", undefined, orig)!).text()).toBe("routed");
  });
  it("returns null for other hosts", () => {
    const r = createRouter({ ...base, unloaded: () => false, request: async () => new Response("routed") });
    expect(r("https://example.com/", undefined, orig)).toBeNull();
  });
  it("returns null after the plugin is unloaded, so captured fetch copies fall through", () => {
    let unloaded = false;
    const r = createRouter({ ...base, unloaded: () => unloaded, request: async () => new Response("routed") });
    unloaded = true;
    expect(r("http://couch.tailcat:5984/db", undefined, orig)).toBeNull();
  });
});
