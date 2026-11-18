import { describe, it, expect } from "vitest";
import { enterHubMode, shouldStartHub, autopilotRole, hubWasRebuilt } from "../src/modes";
import { DEFAULT_SETTINGS, type TcsyncSettings } from "../src/types";

const s = (o: Partial<TcsyncSettings>): TcsyncSettings => ({ ...DEFAULT_SETTINGS, ...o });

describe("modes", () => {
  it("entering hub mode forgets an old server address, so stopping the hub never syncs into it", () => {
    const n = enterHubMode(s({ mode: "tunnel", addr: "tcOLDSERVER", hubName: "x", advanced: true }));
    expect(n).toMatchObject({ mode: "hub", addr: "", advanced: false });
    expect(n.hubName).toBeUndefined();
  });
  it("a device notices a rebuilt hub by its epoch (not on first sight, not without a known epoch)", () => {
    expect(hubWasRebuilt(s({ hubEpoch: "aaaa" }), "aaaa")).toBe(false);
    expect(hubWasRebuilt(s({ hubEpoch: "aaaa" }), "bbbb")).toBe(true);
    expect(hubWasRebuilt(s({}), "bbbb")).toBe(false);
    expect(hubWasRebuilt(s({ hubEpoch: "aaaa" }), undefined)).toBe(false);
  });
  it("a phone never runs the hub, even if hub settings reached it", () => {
    expect(shouldStartHub(s({ mode: "hub" }), true)).toBe(false);
    expect(shouldStartHub(s({ mode: "hub" }), false)).toBe(true);
    expect(shouldStartHub(s({ mode: "tunnel" }), false)).toBe(false);
  });
  it("a paired device answers a scheduled fetch even without a session (recovery after the hub was rebuilt)", () => {
    expect(autopilotRole(s({ mode: "tunnel", addr: "tcHUB", hubName: "V" }), true)).toBe("device");
    expect(autopilotRole(s({ mode: "tunnel", addr: "tcHUB", hubName: "V" }), false)).toBeNull();
    expect(autopilotRole(s({ mode: "tunnel", addr: "tcX", advanced: true }), true)).toBeNull();
    expect(autopilotRole(s({ autopilot: { role: "hub", until: Date.now() + 1000 } }), false)).toBe("hub");
    expect(autopilotRole(s({ autopilot: { role: "hub", until: Date.now() - 1 } }), false)).toBeNull();
  });
});
