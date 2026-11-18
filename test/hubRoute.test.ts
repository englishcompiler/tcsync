import { describe, it, expect } from "vitest";
import { toHubRequest, fromHubResponse } from "../src/hub/route";

describe("in-process hub route", () => {
  it("turns a fetch into a HubRequest with path+query and body", async () => {
    const r = await toHubRequest("http://couch.tailcat:5984/obsidian/_bulk_docs?x=1", { method: "POST", body: '{"docs":[]}', headers: { "Content-Type": "application/json" } });
    expect(r).toMatchObject({ method: "POST", url: "/obsidian/_bulk_docs?x=1", headers: { "content-type": "application/json" } });
    expect(new TextDecoder().decode(r.body)).toBe('{"docs":[]}');
  });
  it("GET has an empty body", async () => {
    expect((await toHubRequest(new Request("http://couch.tailcat:5984/"))).body.length).toBe(0);
  });
  it("turns a HubResponse into a Response (no body for HEAD)", async () => {
    const res = fromHubResponse({ status: 201, headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"ok":true}') }, "PUT");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(await fromHubResponse({ status: 200, headers: {}, body: new Uint8Array([1]) }, "HEAD").text()).toBe("");
  });
});
