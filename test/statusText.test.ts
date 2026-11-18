import { describe, it, expect } from "vitest";
import { statusText, statusLabel } from "../src/ui/statusText";

describe("statusText (full sentence: settings screen and tooltip)", () => {
  it("hub on, with device count", () => {
    expect(statusText("hub", "hub-on", { devices: 2 })).toBe("Hub on · 2 devices");
    expect(statusText("hub", "hub-on", { devices: 1 })).toBe("Hub on · 1 device");
    expect(statusText("hub", "hub-on", { devices: 0 })).toBe("Hub on · 0 devices");
  });
  it("hub problem", () => {
    expect(statusText("hub", "error", { detail: "storage full" })).toBe("Hub problem: storage full");
  });
  it("device synced / offline / not paired yet / connecting", () => {
    expect(statusText("tunnel", "up", {})).toBe("Synced");
    expect(statusText("tunnel", "unreachable", {})).toBe("Hub is offline. Changes are saved and will sync when your computer is back.");
    expect(statusText("tunnel", "idle", {})).toBe("Not paired yet. On your computer, open tcsync and choose Add a device.");
    expect(statusText("tunnel", "connecting", {})).toBe("Connecting to your hub…");
  });
  it("not paired any more (offline for a long time)", () => {
    expect(statusText("tunnel", "unreachable", { longOffline: true }))
      .toBe("Hub is offline. Changes are saved and will sync when your computer is back. If your computer is on and Obsidian is open there, this device isn't paired any more. Scan a new code from your computer.");
  });
  it("advanced/direct keeps technical wording", () => {
    expect(statusText("direct", "direct", {})).toBe("Direct: using the database on this computer");
  });
});

describe("statusLabel (short: status bar)", () => {
  it("is short", () => {
    expect(statusLabel("hub", "hub-on", { devices: 2 })).toBe("tcsync: hub on · 2");
    expect(statusLabel("tunnel", "up", {})).toBe("tcsync: synced");
    expect(statusLabel("tunnel", "unreachable", {})).toBe("tcsync: hub offline");
    expect(statusLabel("tunnel", "idle", {})).toBe("tcsync: not paired");
    expect(statusLabel("hub", "error", {})).toBe("tcsync: hub problem");
  });
});
