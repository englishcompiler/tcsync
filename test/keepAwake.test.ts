import { describe, it, expect } from "vitest";
import { keepHubAlive, type ElectronLike } from "../src/hub/keepAwake";

function fakeElectron() {
  const log: string[] = [];
  const e: ElectronLike & { log: string[] } = {
    log,
    remote: {
      getCurrentWebContents: () => ({ setBackgroundThrottling: (b: boolean) => { log.push(`throttling=${b}`); } }),
      powerSaveBlocker: { start: (t: string) => { log.push(`start:${t}`); return 7; }, stop: (id: number) => { log.push(`stop:${id}`); } },
    },
  };
  return e;
}

describe("keepHubAlive", () => {
  it("disables throttling and starts prevent-app-suspension when preventSleep", () => {
    const e = fakeElectron();
    keepHubAlive(e, { preventSleep: true });
    expect(e.log).toEqual(["throttling=false", "start:prevent-app-suspension"]);
  });
  it("only disables throttling when !preventSleep", () => {
    const e = fakeElectron();
    keepHubAlive(e, { preventSleep: false });
    expect(e.log).toEqual(["throttling=false"]);
  });
  it("release restores throttling and stops the blocker", () => {
    const e = fakeElectron();
    const release = keepHubAlive(e, { preventSleep: true });
    release();
    expect(e.log.slice(2)).toEqual(["throttling=true", "stop:7"]);
    release();
    expect(e.log.length).toBe(4);
  });
  it("null electron (mobile) is a no-op", () => {
    expect(() => keepHubAlive(null, { preventSleep: true })()).not.toThrow();
  });
  it("a missing electron.remote (future Obsidian) is a no-op, not a crash", () => {
    expect(() => keepHubAlive({} as ElectronLike, { preventSleep: true })()).not.toThrow();
  });
});
