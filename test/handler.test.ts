import { describe, it, expect, beforeEach } from "vitest";
import { createHandler, type HubRequest } from "../src/hub/handler";
import { createStore, type HubStore } from "../src/hub/store";
import memory from "pouchdb-adapter-memory";
import { PouchDB } from "../src/hub/pouch";

PouchDB.plugin(memory);

const te = new TextEncoder(), td = new TextDecoder();
let store: HubStore;
let handle: ReturnType<typeof createHandler>;

beforeEach(() => {
  store = createStore("memory", `t${Math.random().toString(36).slice(2)}-`);
  handle = createHandler(store);
});

async function call(method: string, url: string, body?: unknown, signal?: AbortSignal) {
  const req: HubRequest = { method, url, headers: { "content-type": "application/json" },
    body: body === undefined ? new Uint8Array() : te.encode(JSON.stringify(body)) };
  const r = await handle(req, signal);
  return { status: r.status, text: td.decode(r.body), json: () => JSON.parse(td.decode(r.body)) };
}
const mkdb = async () => expect((await call("PUT", "/obsidian")).status).toBe(201);

describe("hub handler", () => {
  it("GET / is a CouchDB welcome", async () => {
    const r = await call("GET", "/");
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ couchdb: "Welcome" });
  });

  it("db lifecycle: GET 404 → PUT 201 → PUT 412 → GET info → DELETE 200 → GET 404", async () => {
    expect((await call("GET", "/obsidian/")).json()).toEqual({ error: "not_found", reason: "Database does not exist." });
    expect((await call("PUT", "/obsidian/")).status).toBe(201);
    expect((await call("PUT", "/obsidian")).status).toBe(412);
    const info = await call("GET", "/obsidian");
    expect(info.status).toBe(200);
    expect(info.json()).toMatchObject({ db_name: "obsidian", doc_count: 0 });
    expect((await call("DELETE", "/obsidian/")).status).toBe(200);
    expect((await call("GET", "/obsidian")).status).toBe(404);
    expect(await store.exists("obsidian")).toBe(false);
  });

  it("doc PUT/GET/DELETE incl _local and ?rev=, ignores _livesync_epoch; stale rev → 409", async () => {
    await mkdb();
    const put = await call("PUT", "/obsidian/f%3Aabc?_livesync_epoch=xyz", { a: 1 });
    expect(put.status).toBe(201);
    const { rev } = put.json();
    expect((await call("GET", "/obsidian/f%3Aabc?_livesync_epoch=xyz")).json()).toMatchObject({ _id: "f:abc", a: 1 });
    expect((await call("PUT", "/obsidian/f%3Aabc", { a: 2 })).json()).toEqual({ error: "conflict", reason: "Document update conflict." });
    expect((await call("PUT", "/obsidian/f%3Aabc", { a: 2, _rev: rev })).status).toBe(201);
    const loc = await call("PUT", "/obsidian/_local/obsydian_livesync_milestone", { m: 1 });
    expect(loc.status).toBe(201);
    expect((await call("GET", "/obsidian/_local/obsydian_livesync_milestone")).json()).toMatchObject({ m: 1 });
    expect((await call("GET", "/obsidian/missing")).json()).toEqual({ error: "not_found", reason: "missing" });
    const cur = (await call("GET", "/obsidian/f%3Aabc")).json();
    expect((await call("DELETE", `/obsidian/f%3Aabc?rev=${cur._rev}`)).status).toBe(200);
    expect((await call("GET", "/obsidian/f%3Aabc")).status).toBe(404);
  });

  it("_all_docs keys / startkey+endkey+limit / include_docs (GET and POST)", async () => {
    await mkdb();
    for (const id of ["f:1", "f:2", "h:1", "i:f:1"]) await call("PUT", `/obsidian/${encodeURIComponent(id)}`, { id });
    const q = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && k !== "limit" && k !== "include_docs" ? JSON.stringify(v) : String(v)]));
    const range = (await call("GET", `/obsidian/_all_docs?${q({ startkey: "f:", endkey: "f:\ufff0", limit: 2 })}`)).json();
    expect(range.rows.map((r: { id: string }) => r.id)).toEqual(["f:1", "f:2"]);
    const keys = (await call("GET", `/obsidian/_all_docs?keys=${encodeURIComponent(JSON.stringify(["h:1"]))}&include_docs=true`)).json();
    expect(keys.rows[0].doc).toMatchObject({ id: "h:1" });
    const post = (await call("POST", "/obsidian/_all_docs", { keys: ["f:2", "nope"] })).json();
    expect(post.rows[0].id).toBe("f:2");
    expect(post.rows[1]).toMatchObject({ key: "nope", error: "not_found" });
  });

  it("_bulk_docs new_edits:false then _revs_diff reports nothing missing", async () => {
    await mkdb();
    const doc = { _id: "x", _rev: "1-abc", v: 1, _revisions: { start: 1, ids: ["abc"] } };
    expect((await call("POST", "/obsidian/_bulk_docs", { docs: [doc], new_edits: false })).status).toBe(201);
    expect((await call("POST", "/obsidian/_revs_diff", { x: ["1-abc", "2-def"] })).json()).toEqual({ x: { missing: ["2-def"] } });
  });

  it("_bulk_get revs=true latest=true returns {results:[{id,docs:[{ok}]}]}", async () => {
    await mkdb();
    const { rev } = (await call("PUT", "/obsidian/a", { v: 1 })).json();
    const r = (await call("POST", "/obsidian/_bulk_get?revs=true&latest=true", { docs: [{ id: "a", rev }] })).json();
    expect(r.results[0].id).toBe("a");
    expect(r.results[0].docs[0].ok).toMatchObject({ _id: "a", v: 1, _revisions: { start: 1 } });
  });

  it("_changes normal: since as string '2' behaves like number 2 (no repeated rows)", async () => {
    await mkdb();
    for (const id of ["a", "b", "c"]) await call("PUT", `/obsidian/${id}`, {});
    const r = (await call("GET", "/obsidian/_changes?since=2&style=all_docs")).json();
    expect(r.results.map((c: { id: string }) => c.id)).toEqual(["c"]);
    expect((await call("GET", `/obsidian/_changes?since=${r.last_seq}`)).json().results).toEqual([]);
  });

  it("_changes limit=1 includes pending = remaining count", async () => {
    await mkdb();
    for (const id of ["a", "b", "c"]) await call("PUT", `/obsidian/${id}`, {});
    const r = (await call("GET", "/obsidian/_changes?feed=normal&since=0&limit=1")).json();
    expect(r.results.length).toBe(1);
    expect(r.pending).toBe(2);
    expect((await call("GET", "/obsidian/_changes?since=0")).json().pending).toBe(0);
  });

  it("_changes filter=_selector via POST body", async () => {
    await mkdb();
    await call("PUT", "/obsidian/leaf1", { type: "leaf" });
    await call("PUT", "/obsidian/note1", { type: "plain" });
    const r = (await call("POST", "/obsidian/_changes?filter=_selector&since=0", { selector: { type: "leaf" } })).json();
    expect(r.results.map((c: { id: string }) => c.id)).toEqual(["leaf1"]);
  });

  it("_changes longpoll returns as soon as a doc is written", async () => {
    await mkdb();
    const t0 = Date.now();
    const p = call("GET", "/obsidian/_changes?feed=longpoll&since=now&timeout=10000");
    setTimeout(() => void call("PUT", "/obsidian/late", { v: 1 }), 200);
    const r = (await p).json();
    expect(r.results.map((c: { id: string }) => c.id)).toEqual(["late"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("_changes longpoll returns empty at timeout=300", async () => {
    await mkdb();
    const t0 = Date.now();
    const r = (await call("GET", "/obsidian/_changes?feed=longpoll&since=now&timeout=300")).json();
    expect(r).toMatchObject({ results: [], pending: 0 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("_changes longpoll filtered by selector ignores non-matching writes until timeout", async () => {
    await mkdb();
    const p = call("POST", "/obsidian/_changes?feed=longpoll&filter=_selector&since=now&timeout=600", { selector: { type: "leaf" } });
    setTimeout(() => void call("PUT", "/obsidian/plain", { type: "plain" }), 100);
    expect((await p).json().results).toEqual([]);
  });

  it("_changes continuous: ndjson rows then {last_seq,pending} line", async () => {
    await mkdb();
    for (const id of ["a", "b"]) await call("PUT", `/obsidian/${id}`, {});
    const r = await call("GET", "/obsidian/_changes?feed=continuous&since=0&limit=1&timeout=100&include_docs=true");
    const lines = r.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ id: "a", doc: { _id: "a" } });
    expect(lines[1]).toMatchObject({ pending: 1 });
    expect(lines[1].last_seq).toBeDefined();
  });

  it("_changes since=now starts at update_seq", async () => {
    await mkdb();
    await call("PUT", "/obsidian/a", {});
    expect((await call("GET", "/obsidian/_changes?since=now")).json().results).toEqual([]);
  });

  it("_find returns docs for a selector", async () => {
    await mkdb();
    await call("PUT", "/obsidian/l1", { type: "leaf" });
    await call("PUT", "/obsidian/n1", { type: "plain" });
    const r = (await call("POST", "/obsidian/_find", { selector: { type: "leaf" } })).json();
    expect(r.docs.map((d: { _id: string }) => d._id)).toEqual(["l1"]);
  });

  it("unknown route → 404 not_found", async () => {
    await mkdb();
    expect((await call("GET", "/obsidian/_design/x/_view/y")).status).toBe(404);
    expect((await call("GET", "/_config")).json()).toMatchObject({ error: "not_found" });
  });

  it("round-trips a 20 MB attachment doc via _bulk_docs/_bulk_get", async () => {
    await mkdb();
    const data = "x".repeat(20 * 1024 * 1024);
    const doc = { _id: "h:big", _rev: "1-big", data, _revisions: { start: 1, ids: ["big"] } };
    expect((await call("POST", "/obsidian/_bulk_docs", { docs: [doc], new_edits: false })).status).toBe(201);
    const r = (await call("POST", "/obsidian/_bulk_get?revs=true", { docs: [{ id: "h:big", rev: "1-big" }] })).json();
    expect(r.results[0].docs[0].ok.data.length).toBe(data.length);
  });

  it("aborting a longpoll via signal ends it promptly and releases its listener", async () => {
    await mkdb();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = call("GET", "/obsidian/_changes?feed=longpoll&since=now&timeout=30000", undefined, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    const db = store.open("obsidian") as unknown as { listenerCount(e: string): number };
    expect(db.listenerCount("change")).toBe(0);
  });

  it("isEmpty is true until a db has documents", async () => {
    expect(await store.isEmpty()).toBe(true);
    await mkdb();
    expect(await store.isEmpty()).toBe(true);
    await call("PUT", "/obsidian/a", {});
    expect(await store.isEmpty()).toBe(false);
  });
});
