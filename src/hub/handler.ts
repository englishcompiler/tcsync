import type { Database } from "./pouch";
import type { HubStore } from "./store";

/** An HTTP request as it arrives through the tunnel (or in-process on the hub). */
export interface HubRequest {
  method: string;
  /** Path plus query, e.g. "/obsidian/_changes?feed=longpoll". */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** The sending device's node key ("nodekey:…"), when it came through the tunnel. */
  peer?: string;
}

export interface HubResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export const LONGPOLL_DEFAULT_MS = 25_000;
export const LONGPOLL_MAX_MS = 60_000;

const te = new TextEncoder();
const td = new TextDecoder();

class HttpError extends Error {
  constructor(public status: number, public error: string, public reason: string) { super(reason); }
}
const notFound = (reason = "missing") => new HttpError(404, "not_found", reason);
const NO_DB = () => notFound("Database does not exist.");

function reply(status: number, value: unknown): HubResponse {
  return { status, headers: { "content-type": "application/json" }, body: te.encode(JSON.stringify(value)) };
}
function text(status: number, s: string): HubResponse {
  return { status, headers: { "content-type": "application/json" }, body: te.encode(s) };
}

/** Maps a PouchDB error to CouchDB's status and {error, reason}. */
function fromPouch(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const x = e as { status?: number; name?: string; reason?: string; message?: string };
  if (x?.status === 409) return new HttpError(409, "conflict", "Document update conflict.");
  if (x?.status && x.name) return new HttpError(x.status, x.name, x.reason ?? x.message ?? "");
  return new HttpError(500, "unknown_error", String((e as Error)?.message ?? e));
}

/** CouchDB passes most _all_docs/_changes parameters as JSON in the query string. */
function jsonParam(q: URLSearchParams, k: string): unknown {
  const v = q.get(k);
  if (v === null) return undefined;
  try { return JSON.parse(v); } catch { return v; }
}
const boolParam = (q: URLSearchParams, k: string) => q.get(k) === "true";
const numParam = (q: URLSearchParams, k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
/** PouchDB compares sequences numerically: "4" (string) would replay changes after 4. */
const seq = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);

export function createHandler(store: HubStore) {
  return async function handle(req: HubRequest, signal?: AbortSignal): Promise<HubResponse> {
    try {
      const u = new URL(req.url, "http://hub");
      const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = req.method.toUpperCase();
      const body = () => (req.body.length ? JSON.parse(td.decode(req.body)) : {});
      const q = u.searchParams;

      if (parts.length === 0) {
        if (method === "GET" || method === "HEAD") return reply(200, { couchdb: "Welcome", version: "3.4.3", vendor: { name: "tcsync hub" } });
        throw notFound();
      }
      const [dbName, ...rest] = parts;
      if (dbName.startsWith("_")) throw notFound();

      if (rest.length === 0) {
        if (method === "PUT") {
          if (!(await store.create(dbName))) return reply(412, { error: "file_exists", reason: "The database could not be created, the file already exists." });
          return reply(201, { ok: true });
        }
        if (method === "DELETE") {
          if (!(await store.destroy(dbName))) throw NO_DB();
          return reply(200, { ok: true });
        }
        if (!(await store.exists(dbName))) throw NO_DB();
        const db = store.open(dbName);
        if (method === "GET" || method === "HEAD") {
          const i = await db.info();
          return reply(200, { db_name: dbName, doc_count: i.doc_count, update_seq: i.update_seq, doc_del_count: 0,
            sizes: { file: 0, external: 0, active: 0 }, instance_start_time: "0", purge_seq: 0 });
        }
        if (method === "POST") {
          const r = await db.post(body());
          return reply(201, { ok: true, id: r.id, rev: r.rev });
        }
        throw notFound();
      }

      if (!(await store.exists(dbName))) throw NO_DB();
      const db = store.open(dbName);
      const [first, ...more] = rest;

      switch (first) {
        case "_all_docs": {
          const b = method === "POST" ? body() : {};
          const opts: Record<string, unknown> = {
            include_docs: boolParam(q, "include_docs") || b.include_docs === true,
            conflicts: boolParam(q, "conflicts") || undefined,
            descending: boolParam(q, "descending") || undefined,
            limit: numParam(q, "limit") ?? b.limit,
            skip: numParam(q, "skip"),
          };
          const keys = (b.keys ?? jsonParam(q, "keys")) as string[] | undefined;
          if (keys) opts.keys = keys;
          const sk = jsonParam(q, "startkey") ?? jsonParam(q, "start_key");
          const ek = jsonParam(q, "endkey") ?? jsonParam(q, "end_key");
          if (sk !== undefined) opts.startkey = sk;
          if (ek !== undefined) opts.endkey = ek;
          if (q.get("inclusive_end") === "false") opts.inclusive_end = false;
          for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
          return reply(200, await db.allDocs(opts as never));
        }
        case "_bulk_docs": {
          const b = body();
          const r = await db.bulkDocs(b.docs, { new_edits: b.new_edits !== false } as never);
          return reply(201, r);
        }
        case "_bulk_get": {
          const b = body();
          return reply(200, await db.bulkGet({ docs: b.docs, revs: boolParam(q, "revs") || b.revs === true, latest: boolParam(q, "latest") } as never));
        }
        case "_revs_diff":
          return reply(200, await db.revsDiff(body()));
        case "_changes":
          return await changes(db, q, method === "POST" ? body() : {}, signal);
        case "_find":
          return reply(200, await (db as unknown as { find(b: unknown): Promise<unknown> }).find(body()));
        case "_index":
          if (method === "POST") return reply(200, await (db as unknown as { createIndex(b: unknown): Promise<unknown> }).createIndex(body()));
          return reply(200, await (db as unknown as { getIndexes(): Promise<unknown> }).getIndexes());
        case "_compact":
          await db.compact();
          return reply(202, { ok: true });
        case "_ensure_full_commit":
          return reply(201, { ok: true, instance_start_time: "0" });
        case "_local":
          if (more.length !== 1) throw notFound();
          return await docRoute(db, `_local/${more[0]}`, method, q, body);
        default:
          if (first.startsWith("_") || more.length > 0) throw notFound();
          return await docRoute(db, first, method, q, body);
      }
    } catch (e) {
      const h = fromPouch(e);
      return reply(h.status, { error: h.error, reason: h.reason });
    }
  };
}

async function docRoute(db: Database, id: string, method: string, q: URLSearchParams, body: () => Record<string, unknown>): Promise<HubResponse> {
  if (method === "GET" || method === "HEAD") {
    const opts: Record<string, unknown> = {};
    if (q.has("rev")) opts.rev = q.get("rev");
    for (const k of ["revs", "revs_info", "conflicts", "latest", "attachments"]) if (boolParam(q, k)) opts[k] = true;
    const or = jsonParam(q, "open_revs");
    if (or !== undefined) opts.open_revs = or;
    return reply(200, await db.get(id, opts as never));
  }
  if (method === "PUT") {
    const doc: Record<string, unknown> = { ...body(), _id: id };
    if (q.has("rev") && !doc._rev) doc._rev = q.get("rev");
    const r = await db.put(doc as never, (q.get("new_edits") === "false" ? { new_edits: false } : {}) as never);
    return reply(201, { ok: true, id: r.id, rev: r.rev });
  }
  if (method === "DELETE") {
    const rev = q.get("rev");
    if (!rev) throw new HttpError(409, "conflict", "Document update conflict.");
    const r = await db.remove(id, rev);
    return reply(200, { ok: true, id: r.id, rev: r.rev });
  }
  throw notFound();
}

/**
 * CouchDB `_changes`. normal: answers now. longpoll: answers at the first matching change, or empty
 * at `timeout` (default 25 s, max 60 s). continuous: same waiting, answered as newline-delimited
 * rows plus a {last_seq,pending} line (LiveSync/PouchDB use it bounded, with limit and timeout).
 * `pending` (changes left after this page) is always present: LiveSync's Fast Fetch requires it.
 * Waiting is event-driven (PouchDB live changes), not timer polling: background windows throttle timers.
 */
async function changes(db: Database, q: URLSearchParams, b: Record<string, unknown>, signal?: AbortSignal): Promise<HubResponse> {
  const feed = q.get("feed") ?? "normal";
  const opts: Record<string, unknown> = { style: q.get("style") ?? "main_only", return_docs: true };
  if (boolParam(q, "include_docs")) opts.include_docs = true;
  if (boolParam(q, "conflicts")) opts.conflicts = true;
  const limit = numParam(q, "limit");
  const filter = q.get("filter");
  if (filter === "_selector") opts.selector = b.selector;
  else if (filter === "_doc_ids") opts.doc_ids = b.doc_ids ?? jsonParam(q, "doc_ids");
  else if (filter) throw new HttpError(400, "bad_request", `unsupported filter ${filter}`);

  let since = seq(q.get("since") ?? 0);
  if (since === "now") since = seq((await db.info()).update_seq);
  const timeout = Math.min(numParam(q, "timeout") ?? LONGPOLL_DEFAULT_MS, LONGPOLL_MAX_MS);

  const page = () => db.changes({ ...opts, since, ...(limit !== undefined ? { limit } : {}) } as never) as unknown as Promise<{ results: Record<string, unknown>[]; last_seq: unknown }>;
  let res = await page();
  if ((feed === "longpoll" || feed === "continuous") && res.results.length === 0 && !signal?.aborted) {
    await waitForChange(db, { ...opts, since: seq(res.last_seq) }, timeout, signal);
    if (!signal?.aborted) res = await page();
  }
  // `pending` like CouchDB's (an estimate): unfiltered, it's the sequence distance to the end, which
  // is O(1); recounting every page would make a large first fetch O(n²). Filtered feeds are
  // small (live sync), so they are counted exactly.
  let pending = 0;
  if (limit !== undefined && res.results.length > 0) {
    if (opts.selector === undefined && opts.doc_ids === undefined && typeof res.last_seq === "number") {
      const end = Number((await db.info()).update_seq);
      pending = Number.isFinite(end) ? Math.max(0, end - res.last_seq) : 0;
    } else {
      const rest = (await db.changes({ ...opts, include_docs: false, since: seq(res.last_seq) } as never)) as unknown as { results: unknown[] };
      pending = rest.results.length;
    }
  }
  const results = res.results.map((c) => {
    const { doc, ...row } = c;
    return opts.include_docs ? { ...row, doc } : row;
  });
  if (feed === "continuous") {
    return text(200, results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : "") + JSON.stringify({ last_seq: res.last_seq, pending }) + "\n");
  }
  return reply(200, { results, last_seq: res.last_seq, pending });
}

function waitForChange(db: Database, opts: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const feed = db.changes({ ...opts, live: true, include_docs: false, return_docs: false } as never) as unknown as {
      on(e: string, f: () => void): void; cancel(): void;
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      signal?.removeEventListener("abort", finish);
      feed.cancel();
      resolve();
    };
    const t = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish);
    feed.on("change", finish);
    feed.on("error", finish);
  });
}
