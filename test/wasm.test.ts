import { describe, it, expect } from "vitest";
import { adaptBridge } from "../src/wasm";

describe("adaptBridge", () => {
  it("an older bridge still running after an update (no tcsyncServe) asks for one restart", async () => {
    const b = adaptBridge({} as Record<string, unknown>);
    await expect(b.serve({ keyJSON: "", allowed: [], onRequest: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) }))
      .rejects.toThrow("tcsync was updated. Please restart Obsidian once.");
  });
});
