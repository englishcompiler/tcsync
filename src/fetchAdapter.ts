import type { BridgeRequest, BridgeResponse } from "./types";

const ORDINARY_TIMEOUT_MS = 30_000;
const FEED_TIMEOUT_MS = 300_000;

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

/** CouchDB change feeds may legitimately hold a response open; everything else must answer quickly. */
export function requestTimeoutMs(url: string): number {
  try {
    const u = new URL(url);
    const feed = u.searchParams.get("feed");
    if (u.pathname.endsWith("/_changes") && (feed === "longpoll" || feed === "continuous")) return FEED_TIMEOUT_MS;
  } catch {
    /* fall through */
  }
  return ORDINARY_TIMEOUT_MS;
}
