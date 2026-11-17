import "../bridge/dist/wasm_exec.js";
import TCSYNC_WASM_GZ_B64 from "tcsync:wasm";
import type { Bridge, BridgeRequest, BridgeResponse } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
let loading: Promise<Bridge> | null = null;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function adapt(): Bridge {
  return {
    init: (o) => g.tcsyncInit(o) as Promise<void>,
    fetch: (r: BridgeRequest) => g.tcsyncFetch(r) as Promise<BridgeResponse>,
    close: () => g.tcsyncClose(),
    publicKey: (p) => g.tcsyncPublicKey(p) as string,
    newKey: () => g.tcsyncNewKey() as { privateKey: string; publicKey: string },
    ping: (timeoutMs, port) => g.tcsyncPing(timeoutMs, port) as Promise<void>,
  };
}

/**
 * Decompresses and starts the embedded Go WASM bridge once per app session
 * (the Go program keeps running across plugin reloads, so it is reused).
 */
export function loadBridge(): Promise<Bridge> {
  if (typeof g.tcsyncFetch === "function") return Promise.resolve(adapt());
  if (loading) return loading;
  loading = (async () => {
    const gz = base64ToBytes(TCSYNC_WASM_GZ_B64);
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    const wasm = await new Response(stream).arrayBuffer();
    const go = new g.Go();
    const ready = new Promise<void>((resolve) => (g.onTcsyncReady = resolve));
    const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
    void go.run(instance);
    await ready;
    return adapt();
  })();
  loading.catch(() => (loading = null));
  return loading;
}
