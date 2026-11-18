import type { HubRequest, HubResponse } from "./hub/handler";
import type { LiveSyncSecrets } from "./livesync/configure";
import type { PairingPayload } from "./pair";

export interface BridgeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface BridgeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The WASM bridge as seen by the plugin (adapted from the tcsync* globals). */
export interface Bridge {
  init(o: { addr: string; privateKey: string; dialTimeoutMs?: number }): Promise<void>;
  fetch(r: BridgeRequest): Promise<BridgeResponse>;
  close(): void;
  publicKey(privateKey: string): string;
  newKey(): { privateKey: string; publicKey: string };
  /** Opens and closes a TCP connection to `port` through the tunnel; rejects if the server doesn't answer. */
  ping(timeoutMs: number, port: number): Promise<void>;
  /** Hub mode: listen on the tunnel; `allowed` are device node keys (never empty in effect: the bridge guards). */
  serve(o: { keyJSON: string; allowed: string[]; onRequest(r: HubRequest): Promise<HubResponse> }): Promise<{ addr: string; keyJSON: string }>;
  serveAllow(nodekey: string): Promise<void>;
  serveClose(): Promise<void>;
}

/** hub: this computer is the hub · tunnel: this device syncs with a hub/server · direct: advanced, own CouchDB on this machine. */
export type Mode = "hub" | "tunnel" | "direct";

export interface DeviceRecord {
  name: string;
  /** "nodekey:…" */
  publicKey: string;
  addedAt: number;
  lastSeen?: number;
  /** pending until the device first connects; pending devices expire after 10 minutes. */
  state: "pending" | "paired";
}

export interface HubState {
  /** tailcat server identity (PrivateKey JSON); empty until first started. */
  keyJSON: string;
  addr: string;
  secrets: LiveSyncSecrets;
  vaultName: string;
  devices: DeviceRecord[];
  keepAwake: boolean;
  /** Set once LiveSync initialised the hub store from this vault. */
  initialised: boolean;
}

export interface TcsyncSettings {
  mode: Mode;
  /** tailcat server address (tc…), tunnel mode. */
  addr: string;
  /** Requests to this hostname are routed by tcsync. */
  host: string;
  /** Base URL used instead of the tunnel in direct mode. */
  directUrl: string;
  /** This device's tailcat client key (privkey:…). Generated on first run. */
  privateKey: string;
  verbose: boolean;
  /** Hub mode state (this computer is the hub). */
  hub?: HubState;
  /** Show the advanced (own server) fields instead of pairing. */
  advanced: boolean;
  /** Device: name of the hub vault this vault is paired with. */
  hubName?: string;
  /** LiveSync initialisation in progress: answer its known dialogs until `until` (survives restarts). */
  autopilot?: { role: "hub" | "device"; until: number };
  /** Pairing accepted but not finished yet (e.g. LiveSync not installed or not loaded yet). */
  pendingPair?: PairingPayload;
}

export const DEFAULT_SETTINGS: TcsyncSettings = {
  mode: "tunnel",
  addr: "",
  host: "couch.tailcat",
  directUrl: "http://127.0.0.1:5984",
  privateKey: "",
  verbose: false,
  advanced: false,
};

export type ConnState = "idle" | "connecting" | "up" | "unreachable" | "direct" | "error";
