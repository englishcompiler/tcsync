import { describe, it, expect, vi } from "vitest";
import { toBridgeRequest, toResponse, withTimeout, requestTimeoutMs, rewriteFeedUrl } from "../src/fetchAdapter";

describe("toBridgeRequest", () => {
  it("carries method, lower-cased headers and a string body", async () => {
    const r = await toBridgeRequest("http://couch.tailcat:5984/db", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Basic eA==" }, body: '{"a":1}' });
    expect(r.method).toBe("PUT");
    expect(r.url).toBe("http://couch.tailcat:5984/db");
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["authorization"]).toBe("Basic eA==");
    expect(new TextDecoder().decode(r.body)).toBe('{"a":1}');
  });
  it("carries a Uint8Array body byte-for-byte", async () => {
    const r = await toBridgeRequest("http://couch.tailcat:5984/b", { method: "POST", body: new Uint8Array([0, 255, 7]) });
    expect(Array.from(r.body!)).toEqual([0, 255, 7]);
  });
  it("reads method, headers and body from a Request object", async () => {
    const req = new Request("http://couch.tailcat:5984/q", { method: "POST", headers: { "X-A": "1" }, body: "hi" });
    const r = await toBridgeRequest(req);
    expect(r.method).toBe("POST");
    expect(r.headers["x-a"]).toBe("1");
    expect(new TextDecoder().decode(r.body)).toBe("hi");
  });
  it("omits the body for GET", async () => {
    const r = await toBridgeRequest("http://couch.tailcat:5984/");
    expect(r.method).toBe("GET");
    expect(r.body).toBeUndefined();
  });
});

describe("toResponse", () => {
  it("maps status, headers and body", async () => {
    const res = toResponse({ status: 201, headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"ok":true}') }, "PUT");
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });
  it("returns a null body for 204 and HEAD", () => {
    expect(toResponse({ status: 204, headers: {}, body: new Uint8Array() }, "DELETE").body).toBeNull();
    expect(toResponse({ status: 200, headers: {}, body: new Uint8Array() }, "HEAD").body).toBeNull();
  });
});

describe("withTimeout", () => {
  it("rejects with a TypeError carrying the message after ms", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 30000, "too slow");
    const assertion = expect(p).rejects.toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    vi.useRealTimers();
  });
  it("resolves with the value when fast enough", async () => {
    await expect(withTimeout(Promise.resolve(5), 1000, "x")).resolves.toBe(5);
  });
});

describe("requestTimeoutMs", () => {
  it("is 30 s for ordinary requests", () => {
    expect(requestTimeoutMs("http://couch.tailcat:5984/db/doc")).toBe(30000);
  });
  it("is 60 s for longpoll feeds (they are rewritten to answer within 25 s)", () => {
    expect(requestTimeoutMs("http://couch.tailcat:5984/db/_changes?feed=longpoll&since=3")).toBe(60000);
  });
  it("is 5 min for continuous feeds", () => {
    expect(requestTimeoutMs("http://couch.tailcat:5984/db/_changes?style=all_docs&feed=continuous")).toBe(300000);
  });
});

describe("rewriteFeedUrl", () => {
  it("replaces heartbeat with a 25 s timeout on longpoll change feeds", () => {
    const u = new URL(rewriteFeedUrl("http://couch.tailcat:5984/db/_changes?style=all_docs&feed=longpoll&heartbeat=30000&since=5"));
    expect(u.searchParams.get("heartbeat")).toBeNull();
    expect(u.searchParams.get("timeout")).toBe("25000");
    expect(u.searchParams.get("since")).toBe("5");
    expect(u.searchParams.get("feed")).toBe("longpoll");
  });
  it("caps a longer timeout at 25 s and keeps a shorter one", () => {
    expect(new URL(rewriteFeedUrl("http://h:1/db/_changes?feed=longpoll&timeout=60000")).searchParams.get("timeout")).toBe("25000");
    expect(new URL(rewriteFeedUrl("http://h:1/db/_changes?feed=longpoll&timeout=10000")).searchParams.get("timeout")).toBe("10000");
  });
  it("leaves other URLs untouched", () => {
    const u = "http://couch.tailcat:5984/db/doc?rev=1";
    expect(rewriteFeedUrl(u)).toBe(u);
    const n = "http://couch.tailcat:5984/db/_changes?since=0&limit=100";
    expect(rewriteFeedUrl(n)).toBe(n);
  });
});
