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
}

export type Mode = "tunnel" | "direct";

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
}

export const DEFAULT_SETTINGS: TcsyncSettings = {
  mode: "tunnel",
  addr: "",
  host: "couch.tailcat",
  directUrl: "http://127.0.0.1:5984",
  privateKey: "",
  verbose: false,
};

export type ConnState = "idle" | "connecting" | "up" | "unreachable" | "direct" | "error";
