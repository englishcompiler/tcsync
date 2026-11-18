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

const RESTART = "tcsync was updated. Please restart Obsidian once.";

/**
 * The bridge as the plugin uses it. The Go program keeps running across plugin reloads, so after an
 * update the previous version's bridge may still be the one installed: hub functions then ask for
 * one restart instead of failing obscurely.
 */
export function adaptBridge(gl: Record<string, any>): Bridge {
  const need = (name: string) => {
    if (typeof gl[name] !== "function") throw new Error(RESTART);
    return gl[name];
  };
  const later = <T>(f: () => T): Promise<Awaited<T>> => {
    try { return Promise.resolve(f()) as Promise<Awaited<T>>; } catch (e) { return Promise.reject(e); }
  };
  return {
    init: (o) => gl.tcsyncInit(o) as Promise<void>,
    fetch: (r: BridgeRequest) => gl.tcsyncFetch(r) as Promise<BridgeResponse>,
    close: () => gl.tcsyncClose(),
    publicKey: (p) => gl.tcsyncPublicKey(p) as string,
    newKey: () => gl.tcsyncNewKey() as { privateKey: string; publicKey: string },
    ping: (timeoutMs, port) => gl.tcsyncPing(timeoutMs, port) as Promise<void>,
    serve: (o) => later(() => need("tcsyncServe")(o) as Promise<{ addr: string; keyJSON: string }>),
    serveAllow: (k) => later(() => need("tcsyncServeAllow")(k) as Promise<void>),
    serveClose: () => (typeof gl.tcsyncServeClose === "function" ? (gl.tcsyncServeClose() as Promise<void>) : Promise.resolve()),
  };
}

const adapt = (): Bridge => adaptBridge(g);

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
