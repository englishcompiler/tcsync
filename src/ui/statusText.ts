import type { ConnState, Mode } from "../types";

export type Shown = ConnState | "hub-on";
export interface StatusOpts {
  devices?: number;
  detail?: string;
  /** Unreachable for a long time: hint that the device may have been removed on the hub. */
  longOffline?: boolean;
}

const OFFLINE = "Hub is offline. Changes are saved and will sync when your computer is back.";
const NOT_PAIRED = "If your computer is on and Obsidian is open there, this device isn't paired any more. Scan a new code from your computer.";

/** Plain-language status for the settings screen and the status bar tooltip. */
export function statusText(role: Mode, s: Shown, o: StatusOpts): string {
  if (role === "hub") {
    if (s === "error") return `Hub problem: ${o.detail ?? "unknown error"}`;
    if (s === "hub-on") { const n = o.devices ?? 0; return `Hub on · ${n} device${n === 1 ? "" : "s"}`; }
    return "Starting the hub…";
  }
  if (role === "direct") {
    if (s === "error") return `Problem: ${o.detail ?? "unknown error"}`;
    return "Direct: using the database on this computer";
  }
  switch (s) {
    case "up": return "Synced";
    case "unreachable": return o.longOffline ? `${OFFLINE} ${NOT_PAIRED}` : OFFLINE;
    case "connecting": return "Connecting to your hub…";
    case "idle": return "Not paired yet. On your computer, open tcsync and choose Add a device.";
    case "error": return `Problem: ${o.detail ?? "unknown error"}`;
    default: return "Synced";
  }
}

/** Short status-bar label. */
export function statusLabel(role: Mode, s: Shown, o: StatusOpts): string {
  if (role === "hub") return s === "error" ? "tcsync: hub problem" : s === "hub-on" ? `tcsync: hub on · ${o.devices ?? 0}` : "tcsync: starting hub";
  if (role === "direct") return s === "error" ? "tcsync: problem" : "tcsync: direct";
  const short: Partial<Record<Shown, string>> = { up: "synced", unreachable: "hub offline", connecting: "connecting…", idle: "not paired", error: "problem" };
  return `tcsync: ${short[s] ?? "synced"}`;
}
