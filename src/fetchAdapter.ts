import type { BridgeRequest, BridgeResponse } from "./types";

const ORDINARY_TIMEOUT_MS = 30_000;
const LONGPOLL_TIMEOUT_MS = 60_000;
const CONTINUOUS_TIMEOUT_MS = 300_000;
/** Longest a rewritten longpoll may stay open on the server. */
export const LONGPOLL_SERVER_TIMEOUT_MS = 25_000;

/** Normalises fetch-style arguments into a bridge request. */
export async function toBridgeRequest(req: RequestInfo | URL, init?: RequestInit): Promise<BridgeRequest> {
  const r = new Request(req, init);
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  let body: Uint8Array | undefined;
  if (r.method !== "GET" && r.method !== "HEAD") {
    const ab = await r.arrayBuffer();
    if (ab.byteLength > 0) body = new Uint8Array(ab);
  }
  return { method: r.method, url: r.url, headers, body };
}

/** Builds a fetch Response from a bridge response. */
export function toResponse(r: BridgeResponse, method: string): Response {
  const noBody = method.toUpperCase() === "HEAD" || r.status === 204 || r.status === 205 || r.status === 304;
  return new Response(noBody ? null : (r.body as BodyInit), { status: r.status, headers: r.headers });
}

/** Rejects with TypeError(msg) — what fetch callers treat as "offline" — after ms. */
export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TypeError(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function feedOf(url: string): { u: URL; feed: string | null } | null {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith("/_changes")) return null;
    return { u, feed: u.searchParams.get("feed") };
  } catch {
    return null;
  }
}

/** How long a request may take before the tunnel is considered dead. */
export function requestTimeoutMs(url: string): number {
  const f = feedOf(url);
  if (f?.feed === "longpoll") return LONGPOLL_TIMEOUT_MS;
  if (f?.feed === "continuous") return CONTINUOUS_TIMEOUT_MS;
  return ORDINARY_TIMEOUT_MS;
}

/**
 * LiveSync's live feed is a longpoll with `heartbeat`, which (per CouchDB)
 * overrides `timeout`: the response only ends when a change happens. The
 * bridge buffers whole responses, so heartbeats can't prove the tunnel is
 * alive. Replace heartbeat with a short server-side timeout: CouchDB answers
 * with an empty result within 25 s, PouchDB simply polls again, and a dead
 * tunnel is noticed within one ordinary request timeout.
 */
export function rewriteFeedUrl(url: string): string {
  const f = feedOf(url);
  if (!f || f.feed !== "longpoll") return url;
  const { u } = f;
  u.searchParams.delete("heartbeat");
  const t = Number(u.searchParams.get("timeout"));
  if (!t || t > LONGPOLL_SERVER_TIMEOUT_MS) u.searchParams.set("timeout", String(LONGPOLL_SERVER_TIMEOUT_MS));
  return u.href;
}
