import type { Bridge, BridgeRequest, BridgeResponse } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const RESTART = "tcsync was updated. Please restart Obsidian once.";

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

