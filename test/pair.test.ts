import { describe, it, expect } from "vitest";
import { pairingLink, readPairing, type PairingPayload } from "../src/pair";

const p: PairingPayload = {
  v: 1, hub: "tc" + "A".repeat(150), key: "privkey:" + "1".repeat(64), vault: "My notes",
  e2ee: "x".repeat(32), idKey: "ab".repeat(32), db: "obsidian", exp: 2_000_000,
};
const param = (link: string) => new URL(link).searchParams.get("pair")!;

describe("pairing link", () => {
  it("round-trips a payload through pairingLink/readPairing", () => {
    const link = pairingLink(p);
    expect(link.startsWith("obsidian://tcsync?pair=")).toBe(true);
    expect(readPairing(param(link), 1_000_000)).toEqual({ ok: true, payload: p });
  });
  it("rejects an expired link with reason 'expired'", () => {
    expect(readPairing(param(pairingLink(p)), 2_000_001)).toEqual({ ok: false, reason: "expired" });
  });
  it("rejects garbage / missing fields with 'invalid'", () => {
    expect(readPairing("%%%not-base64", 0)).toEqual({ ok: false, reason: "invalid" });
    const { hub: _h, ...noHub } = p;
    expect(readPairing(param(pairingLink(noHub as PairingPayload)), 0)).toEqual({ ok: false, reason: "invalid" });
  });
  it("rejects v:2 with 'version'", () => {
    expect(readPairing(param(pairingLink({ ...p, v: 2 as 1 })), 0)).toEqual({ ok: false, reason: "version" });
  });
  it("opening the same link again on an already-paired vault → 'already-paired'", () => {
    expect(readPairing(param(pairingLink(p)), 1_000_000, p.key)).toEqual({ ok: false, reason: "already-paired" });
  });
  it("link fits a QR code: length < 2000 chars", () => {
    expect(pairingLink(p).length).toBeLessThan(2000);
  });
  it("accepts the raw parameter as Obsidian hands it over (already URL-decoded)", () => {
    const raw = decodeURIComponent(param(pairingLink(p)));
    expect(readPairing(raw, 0).ok).toBe(true);
  });
});
