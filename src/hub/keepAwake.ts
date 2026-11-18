/** The parts of Electron (desktop Obsidian, via `require("electron")`) the hub uses. */
export interface ElectronLike {
  remote?: {
    getCurrentWebContents(): { setBackgroundThrottling(b: boolean): void };
    powerSaveBlocker: { start(type: string): number; stop(id: number): void };
  };
}

/**
 * Keeps the hub working while Obsidian is minimised or behind other windows: Chromium throttles
 * timers in background windows, which stalls the tunnel and live sync. Optionally also stops the
 * computer from idle-sleeping (and macOS App Nap) while Obsidian is open. Returns a release function.
 */
export function keepHubAlive(electron: ElectronLike | null, o: { preventSleep: boolean }): () => void {
  const remote = electron?.remote;
  if (!remote) return () => {};
  let wc: ReturnType<NonNullable<ElectronLike["remote"]>["getCurrentWebContents"]> | null = null;
  let blocker: number | null = null;
  try {
    wc = remote.getCurrentWebContents();
    wc.setBackgroundThrottling(false);
  } catch (e) {
    console.warn("[tcsync] could not disable background throttling", e);
  }
  if (o.preventSleep) {
    try {
      blocker = remote.powerSaveBlocker.start("prevent-app-suspension");
    } catch (e) {
      console.warn("[tcsync] could not keep the computer awake", e);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { wc?.setBackgroundThrottling(true); } catch { /* window gone */ }
    if (blocker !== null) try { remote.powerSaveBlocker.stop(blocker); } catch { /* already stopped */ }
  };
}
