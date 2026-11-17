import { describe, it, expect } from "vitest";
import { orderBefore } from "../src/loadOrder";

describe("orderBefore", () => {
  it("moves self directly ahead of the other plugin", () => {
    expect(orderBefore(["a", "obsidian-livesync", "b", "tcsync"], "tcsync", "obsidian-livesync")).toEqual(["a", "tcsync", "obsidian-livesync", "b"]);
  });
  it("returns null when self already loads first", () => {
    expect(orderBefore(["tcsync", "x", "obsidian-livesync"], "tcsync", "obsidian-livesync")).toBeNull();
  });
  it("returns null when the other plugin is not enabled", () => {
    expect(orderBefore(["a", "tcsync"], "tcsync", "obsidian-livesync")).toBeNull();
  });
  it("inserts self ahead of the other plugin when self is not in the list yet (first enable)", () => {
    expect(orderBefore(["a", "obsidian-livesync"], "tcsync", "obsidian-livesync")).toEqual(["a", "tcsync", "obsidian-livesync"]);
  });
});
