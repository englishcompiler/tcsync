import type { Bridge, DeviceRecord, HubState } from "../types";
import { createHandler, type HubRequest, type HubResponse } from "./handler";
import type { HubStore } from "./store";

/** A pairing code (and its device key) is valid this long until the device first connects. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** lastSeen is written at most this often per device (it lives in plugin data). */
const LAST_SEEN_SAVE_MS = 60 * 1000;

export type HubBridge = Pick<Bridge, "serve" | "serveAllow" | "serveClose" | "newKey">;

export interface HubDeps {
  bridge: HubBridge;
  store: HubStore;
  state(): HubState;
  save(s: HubState): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  /** Called after devices change (settings screen refresh). */
  onChange?(): void;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
function base64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh hub: new end-to-end passphrase and ID key, no devices, keep-awake on. */
export function newHubState(vaultName: string): HubState {
  return {
    keyJSON: "",
    addr: "",
    secrets: {
      e2ee: base64url(randomBytes(24)),
      idKey: [...randomBytes(32)].map((x) => x.toString(16).padStart(2, "0")).join(""),
    },
    vaultName,
    devices: [],
    keepAwake: true,
    initialised: false,
  };
}

/** The hub: tunnel listener + CouchDB handler + paired-device bookkeeping. */
export class Hub {
  private readonly handler: ReturnType<typeof createHandler>;
  private timers = new Map<string, () => void>();
  private serving = false;
  private restarting: Promise<void> = Promise.resolve();

  constructor(private readonly d: HubDeps) {
    this.handler = createHandler(d.store);
  }

  devices(): DeviceRecord[] {
    return this.d.state().devices;
  }

  /** Starts listening (dropping pending devices that expired meanwhile); resolves to the hub address. */
  async start(): Promise<string> {
    const now = this.d.now();
    const s = this.d.state();
    const devices = s.devices.filter((x) => x.state === "paired" || now - x.addedAt < PENDING_TTL_MS);
    if (devices.length !== s.devices.length) await this.d.save({ ...s, devices });
    await this.serveNow();
    for (const x of this.devices()) if (x.state === "pending") this.armExpiry(x, x.addedAt + PENDING_TTL_MS - now);
    return this.d.state().addr;
  }

  async stop(): Promise<void> {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.serving = false;
    await this.d.bridge.serveClose();
  }

  /** Mints a device key on the hub and admits it as pending. */
  async addDevice(name: string): Promise<{ privateKey: string; record: DeviceRecord }> {
    const k = this.d.bridge.newKey();
    const record: DeviceRecord = { name, publicKey: k.publicKey, addedAt: this.d.now(), state: "pending" };
    const s = this.d.state();
    await this.d.save({ ...s, devices: [...s.devices, record] });
    if (this.serving) await this.d.bridge.serveAllow(k.publicKey);
    this.armExpiry(record, PENDING_TTL_MS);
    this.d.onChange?.();
    return { privateKey: k.privateKey, record };
  }

  /** Forgets a device; tailcat can't un-allow a key, so the listener restarts (same address). */
  async removeDevice(publicKey: string): Promise<void> {
    this.timers.get(publicKey)?.();
    this.timers.delete(publicKey);
    const s = this.d.state();
    await this.d.save({ ...s, devices: s.devices.filter((x) => x.publicKey !== publicKey) });
    if (this.serving) await this.restart();
    this.d.onChange?.();
  }

  /** Serves one request: from the tunnel (with peer) or in-process from this computer's LiveSync. */
  async handle(req: HubRequest, signal?: AbortSignal): Promise<HubResponse> {
    if (req.peer) await this.seen(req.peer);
    return this.handler(req, signal);
  }

  async markInitialised(): Promise<void> {
    await this.d.save({ ...this.d.state(), initialised: true });
  }

  /** True when this hub was initialised before but its database is now empty (storage cleared). */
  async storeWasLost(): Promise<boolean> {
    return this.d.state().initialised && (await this.d.store.isEmpty());
  }

  private async serveNow(): Promise<void> {
    const s = this.d.state();
    const r = await this.d.bridge.serve({
      keyJSON: s.keyJSON,
      allowed: s.devices.map((x) => x.publicKey),
      onRequest: (req) => this.handle(req),
    });
    this.serving = true;
    if (r.addr !== s.addr || r.keyJSON !== s.keyJSON) await this.d.save({ ...this.d.state(), addr: r.addr, keyJSON: r.keyJSON });
  }

  private restart(): Promise<void> {
    this.restarting = this.restarting.then(async () => {
      await this.d.bridge.serveClose();
      await this.serveNow();
    });
    return this.restarting;
  }

  private armExpiry(x: DeviceRecord, ms: number): void {
    this.timers.get(x.publicKey)?.();
    this.timers.set(x.publicKey, this.d.setTimer(() => {
      this.timers.delete(x.publicKey);
      const cur = this.devices().find((y) => y.publicKey === x.publicKey);
      if (cur?.state === "pending") void this.removeDevice(x.publicKey);
    }, Math.max(0, ms)));
  }

  private async seen(peer: string): Promise<void> {
    const s = this.d.state();
    const x = s.devices.find((y) => y.publicKey === peer);
    if (!x) return;
    const now = this.d.now();
    if (x.state === "paired" && x.lastSeen !== undefined && now - x.lastSeen < LAST_SEEN_SAVE_MS) return;
    if (x.state === "pending") {
      this.timers.get(peer)?.();
      this.timers.delete(peer);
    }
    await this.d.save({ ...s, devices: s.devices.map((y) => (y.publicKey === peer ? { ...y, state: "paired", lastSeen: now } : y)) });
    this.d.onChange?.();
  }
}
