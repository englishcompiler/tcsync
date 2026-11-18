import type { TcsyncSettings } from "./types";

/**
 * Settings for "Make this computer the hub". An old server address is forgotten: otherwise
 * stopping the hub later would point this vault's LiveSync back at that server with new secrets.
 */
export function enterHubMode(s: TcsyncSettings): TcsyncSettings {
  const n: TcsyncSettings = { ...s, mode: "hub", addr: "", advanced: false };
  delete n.hubName;
  return n;
}

/** True when the hub's database was rebuilt since this device last synced (epoch changed). */
export function hubWasRebuilt(s: TcsyncSettings, epoch: string | undefined): boolean {
  return Boolean(s.hubEpoch && epoch && s.hubEpoch !== epoch);
}

/** A phone or tablet never runs the hub, even if hub settings reached it somehow. */
export function shouldStartHub(s: TcsyncSettings, isMobile: boolean): boolean {
  return s.mode === "hub" && !isMobile;
}

/**
 * Whether to answer LiveSync's initialisation dialogs on this start: during a pairing/hub-setup
 * session, or on a paired device that has a fetch scheduled (LiveSync's own recovery after the
 * hub's database was rebuilt).
 */
export function autopilotRole(s: TcsyncSettings, fetchScheduled: boolean): "hub" | "device" | null {
  if (s.autopilot && Date.now() <= s.autopilot.until) return s.autopilot.role;
  if (s.mode === "tunnel" && !s.advanced && s.addr && s.hubName && fetchScheduled) return "device";
  return null;
}
