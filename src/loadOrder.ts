/**
 * Returns `list` with `self` moved (or, on first enable, inserted) directly
 * ahead of `other`, or null when no change is needed (self already ahead, or
 * `other` not enabled).
 *
 * Obsidian loads community plugins in the order of community-plugins.json.
 * tcsync must load before Self-hosted LiveSync: LiveSync binds a private copy
 * of the global fetch when its code is evaluated (used by its Fast Fetch), so
 * only a fetch patched before that moment can route those requests.
 */
export function orderBefore(list: readonly string[], self: string, other: string): string[] | null {
  const si = list.indexOf(self);
  const oi = list.indexOf(other);
  if (oi < 0 || (si >= 0 && si < oi)) return null;
  const rest = list.filter((id) => id !== self);
  rest.splice(rest.indexOf(other), 0, self);
  return rest;
}
