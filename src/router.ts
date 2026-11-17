import type { Router } from "./hooks";
import { matchesHost } from "./route";

export interface RouterOptions {
  host: () => string;
  unloaded: () => boolean;
  /** Resolves once settings are loaded. */
  ready: Promise<void>;
  verbose: () => boolean;
  request: (req: RequestInfo | URL, init: RequestInit | undefined, original: typeof fetch) => Promise<Response>;
}

/**
 * Decides which requests tcsync handles. Returns null (pass through) for other
 * hosts and after unload: LiveSync keeps a copy of the fetch it found at load
 * time, which is tcsync's wrapper, so an unloaded instance must step aside.
 */
export function createRouter(o: RouterOptions): Router {
  return (req, init, original) => {
    if (o.unloaded()) return null;
    const url = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    if (!matchesHost(url, o.host())) return null;
    return o.ready.then(() => {
      if (o.verbose()) console.debug("[tcsync]", init?.method ?? (req instanceof Request ? req.method : "GET"), url);
      return o.request(req, init, original);
    });
  };
}
