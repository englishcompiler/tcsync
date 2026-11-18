/**
 * Pairing link: `obsidian://tcsync?pair=<base64url JSON>`, shown on the hub as a QR code.
 * It carries everything a device needs: the hub address, a device key the hub already admitted,
 * and the vault's LiveSync secrets. Valid until `exp` (10 minutes) or first use.
 */
export interface PairingPayload {
  v: 1;
  /** Hub address (tc…). */
  hub: string;
  /** This device's tailcat key (privkey:…), minted and admitted by the hub. */
  key: string;
  /** Hub vault name, for "Pair this vault with <vault>?". */
  vault: string;
  /** LiveSync end-to-end encryption passphrase. */
  e2ee: string;
  /** LiveSync ID-derivation key. */
  idKey: string;
  db: "obsidian";
  /** Expiry, ms since epoch. */
  exp: number;
}

export type PairingResult =
  | { ok: true; payload: PairingPayload }
  | { ok: false; reason: "expired" | "invalid" | "version" | "already-paired" };

function toBase64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function pairingLink(p: PairingPayload): string {
  return `obsidian://tcsync?pair=${toBase64url(JSON.stringify(p))}`;
}

const str = (v: unknown) => typeof v === "string" && v.length > 0;

/** Validates the `pair` parameter. `currentKey` is this vault's device key, if already paired. */
export function readPairing(pairParam: string, now: number, currentKey?: string): PairingResult {
  let p: Partial<PairingPayload> & { v?: unknown };
  try {
    p = JSON.parse(fromBase64url(pairParam.trim()));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!p || typeof p !== "object") return { ok: false, reason: "invalid" };
  if (p.v !== 1) return { ok: false, reason: typeof p.v === "number" ? "version" : "invalid" };
  if (!str(p.hub) || !str(p.key) || !str(p.e2ee) || !str(p.idKey) || typeof p.vault !== "string"
    || p.db !== "obsidian" || typeof p.exp !== "number") return { ok: false, reason: "invalid" };
  if (currentKey && currentKey === p.key) return { ok: false, reason: "already-paired" };
  if (now > p.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload: p as PairingPayload };
}
