import type { Bridge, DeviceRecord, HubState } from "../types";
import { createHandler, type HubRequest, type HubResponse } from "./handler";
import type { HubStore } from "./store";

/** A pairing code (and its device key) is valid this long until the device first connects. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** lastSeen is written at most this often per device (it lives in plugin data). */
const LAST_SEEN_SAVE_MS = 60 * 1000;
/** A device trades the one-time key from its pairing code for its own key here. */
export const CLAIM_PATH = "/_tcsync/claim";
/** Devices read the hub epoch here (it changes when the hub database is rebuilt). */
export const EPOCH_PATH = "/_tcsync/epoch";
const newEpochId = () => [...randomBytes(8)].map((x) => x.toString(16).padStart(2, "0")).join("");
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
const NODEKEY = /^nodekey:[0-9a-f]{64}$/;

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
    epoch: newEpochId(),
  };
}

/** The hub: tunnel listener + CouchDB handler + paired-device bookkeeping. */
export class Hub {
  private readonly handler: ReturnType<typeof createHandler>;
  private timers = new Map<string, () => void>();
  /** True while the tunnel listener is up. */
  serving = false;
  /** Why the listener is down ("" when serving). */
  lastError = "";
  private stopped = false;
  private retries = 0;
  private cancelRetry: (() => void) | null = null;
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
    this.stopped = false;
    for (const x of this.devices()) if (x.state === "pending") this.armExpiry(x, x.addedAt + PENDING_TTL_MS - now);
    await this.restart();
    if (!this.serving) throw new Error(this.lastError);
    return this.d.state().addr;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelRetry?.();
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    await this.restarting;
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
    if (req.url === CLAIM_PATH && req.method.toUpperCase() === "POST") return this.claim(req);
    if (req.url === EPOCH_PATH) return this.json(200, { epoch: this.d.state().epoch });
    if (req.peer) await this.seen(req.peer);
    return this.handler(req, signal);
  }

  /**
   * Pairing step 2: a device connected with the one-time key from its code and now registers its
   * own key. The one-time key is dropped (listener restart), so the code can't be used again.
   */
  private async claim(req: HubRequest): Promise<HubResponse> {
    const reply = (status: number, v: unknown): HubResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) });
    const s = this.d.state();
    const dev = s.devices.find((x) => x.publicKey === req.peer);
    if (!req.peer || !dev || dev.state !== "pending") return reply(403, { error: "forbidden", reason: "This pairing code was already used or has expired." });
    let pub: unknown;
    try { pub = JSON.parse(new TextDecoder().decode(req.body)).publicKey; } catch { pub = undefined; }
    if (typeof pub !== "string" || !NODEKEY.test(pub) || s.devices.some((x) => x.publicKey === pub)) return reply(400, { error: "bad_request", reason: "invalid device key" });
    this.timers.get(dev.publicKey)?.();
    this.timers.delete(dev.publicKey);
    await this.d.save({ ...s, devices: s.devices.map((x) => (x === dev ? { ...x, publicKey: pub as string, state: "paired", lastSeen: this.d.now() } : x)) });
    this.d.onChange?.();
    // Answer first: restarting the listener closes this connection.
    setTimeout(() => void this.restart(), 250);
    return reply(200, { ok: true, epoch: this.d.state().epoch });
  }

  /** Marks the hub database as rebuilt: devices notice the new epoch and re-fetch. */
  async newEpoch(): Promise<void> {
    await this.d.save({ ...this.d.state(), epoch: newEpochId() });
  }

  private json(status: number, v: unknown): HubResponse {
    return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) };
  }

  async markInitialised(): Promise<void> {
    await this.d.save({ ...this.d.state(), initialised: true });
  }

  /** True when this hub was initialised before but its database is now empty (storage cleared). */
  async storeWasLost(): Promise<boolean> {
    if (!this.d.state().initialised) return false;
    try {
      return await this.d.store.isEmpty();
    } catch (e) {
      // Can't tell: never trigger a rebuild (it overwrites the hub) on an unreadable store.
      console.warn("[tcsync] could not read the hub database", e);
      return false;
    }
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

  /**
   * (Re)starts the listener with the current device list. A failure (e.g. no network at login)
   * never blocks later restarts: the hub reports it and keeps retrying with backoff.
   */
  restart(): Promise<void> {
    this.restarting = this.restarting.catch(() => {}).then(async () => {
      if (this.stopped) return;
      this.cancelRetry?.();
      this.cancelRetry = null;
      try {
        if (this.serving) await this.d.bridge.serveClose();
        this.serving = false;
        await this.serveNow();
        this.lastError = "";
        this.retries = 0;
      } catch (e) {
        this.serving = false;
        this.lastError = e instanceof Error ? e.message : String(e);
        const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
        this.cancelRetry = this.d.setTimer(() => void this.restart(), wait);
      }
      this.d.onChange?.();
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
    if (!x || x.state !== "paired") return;
    const now = this.d.now();
    if (x.lastSeen !== undefined && now - x.lastSeen < LAST_SEEN_SAVE_MS) return;
    await this.d.save({ ...s, devices: s.devices.map((y) => (y.publicKey === peer ? { ...y, lastSeen: now } : y)) });
    this.d.onChange?.();
  }
}
