/**
 * A router returns a Response promise for requests tcsync handles, or null to
 * let the original function handle the request. `original` is the function
 * that was replaced, so direct mode can reuse it.
 */
export type Router = (req: RequestInfo | URL, init: RequestInit | undefined, original: typeof fetch) => Promise<Response> | null;

type FetchLike = (req: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const LIVESYNC_FETCHERS = ["webCompatFetch", "nativeFetch"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

/**
 * Wraps Self-hosted LiveSync's two HTTP entry points. Returns a restore
 * function, or null when LiveSync (or the expected internals) is not present.
 */
export function hookLiveSync(app: AnyApp, route: Router): (() => void) | null {
  const api = app?.plugins?.plugins?.["obsidian-livesync"]?.core?.services?.API;
  if (!api) return null;
  const restores: (() => void)[] = [];
  for (const name of LIVESYNC_FETCHERS) {
    const original = api[name] as FetchLike | undefined;
    if (typeof original !== "function") continue;
    const bound = original.bind(api) as typeof fetch;
    api[name] = function (this: unknown, req: RequestInfo | URL, init?: RequestInit) {
      return route(req, init, bound) ?? original.call(this, req, init);
    };
    restores.push(() => (api[name] = original));
  }
  if (restores.length === 0) return null;
  return () => restores.forEach((r) => r());
}

/** Wraps `target.fetch` (globalThis by default). Returns a restore function. */
export function patchGlobalFetch(route: Router, target: { fetch: typeof fetch } = globalThis): () => void {
  const original = target.fetch;
  const bound = original.bind(target) as typeof fetch;
  target.fetch = function (this: unknown, req: RequestInfo | URL, init?: RequestInit) {
    return route(req, init, bound) ?? original.call(this, req, init);
  } as typeof fetch;
  return () => {
    target.fetch = original;
  };
}
