/** True when `url` is an absolute URL whose hostname equals `host`. */
export function matchesHost(url: string, host: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Replaces the origin of `url` with `directUrl`, keeping path and query. */
export function rewriteToDirect(url: string, directUrl: string): string {
  const u = new URL(url);
  const base = directUrl.replace(/\/+$/, "");
  return base + u.pathname + u.search;
}
