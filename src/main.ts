import { Notice, Plugin } from "obsidian";
import { Connection } from "./connection";
import { hookLiveSync, patchGlobalFetch, type Router } from "./hooks";
import { matchesHost } from "./route";
import { TcsyncSettingTab } from "./settingsTab";
import { StatusBar } from "./statusBar";
import { DEFAULT_SETTINGS, type Bridge, type ConnState, type TcsyncSettings } from "./types";
import { loadBridge } from "./wasm";

const HOOK_RETRY_MS = 500;
const HOOK_RETRY_LIMIT = 60; // 30 s

export default class TcsyncPlugin extends Plugin {
  settings!: TcsyncSettings;
  conn!: Connection;
  lastDetail = "";
  private bridge: Bridge | null = null;
  private statusBar!: StatusBar;
  private unhookLiveSync: (() => void) | null = null;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<TcsyncSettings> | null) };
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.conn = new Connection(this.lazyBridge(), () => this.settings, (s, d) => this.onState(s, d));
    this.addSettingTab(new TcsyncSettingTab(this.app, this));
    this.addCommands();

    const router: Router = (req, init, original) => {
      const url = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
      if (!matchesHost(url, this.settings.host)) return null;
      if (this.settings.verbose) console.debug("[tcsync]", init?.method ?? (req instanceof Request ? req.method : "GET"), url);
      return this.conn.request(req, init, original);
    };
    this.register(patchGlobalFetch(router));
    this.app.workspace.onLayoutReady(() => {
      this.hookWithRetry(router, 0);
      void this.prepare();
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.conn.onResume();
    });
  }

  onunload(): void {
    this.unhookLiveSync?.();
    this.conn?.reset();
  }

  /** A Bridge whose async methods load the WASM on first use. */
  private lazyBridge(): Bridge {
    return {
      init: async (o) => (await this.getBridge()).init(o),
      fetch: async (r) => (await this.getBridge()).fetch(r),
      close: () => this.bridge?.close(),
      publicKey: (p) => {
        if (!this.bridge) throw new Error("bridge not loaded");
        return this.bridge.publicKey(p);
      },
      newKey: () => {
        if (!this.bridge) throw new Error("bridge not loaded");
        return this.bridge.newKey();
      },
    };
  }

  private async getBridge(): Promise<Bridge> {
    if (!this.bridge) this.bridge = await loadBridge();
    return this.bridge;
  }

  private hookWithRetry(router: Router, attempt: number): void {
    const restore = hookLiveSync(this.app, router);
    if (restore) {
      this.unhookLiveSync = restore;
      return;
    }
    if (attempt < HOOK_RETRY_LIMIT) {
      window.setTimeout(() => this.hookWithRetry(router, attempt + 1), HOOK_RETRY_MS);
    } else {
      console.warn("[tcsync] Self-hosted LiveSync not found; only the global fetch is routed.");
    }
  }

  /** Loads the bridge and device key in tunnel mode, then connects if configured. */
  private async prepare(): Promise<void> {
    try {
      if (this.settings.mode === "tunnel") {
        await this.ensureDeviceKey();
        if (this.settings.addr) await this.conn.ensureUp().catch(() => {});
        else this.onState("error", "set the server address in tcsync settings");
      } else {
        await this.conn.ensureUp();
      }
    } catch (e) {
      this.onState("error", e instanceof Error ? e.message : String(e));
    }
  }

  private async ensureDeviceKey(): Promise<void> {
    const b = await this.getBridge();
    if (!this.settings.privateKey) {
      this.settings.privateKey = b.newKey().privateKey;
      await this.saveSettings();
    }
  }

  async devicePublicKey(): Promise<string> {
    await this.ensureDeviceKey();
    return (await this.getBridge()).publicKey(this.settings.privateKey);
  }

  async copyDeviceKey(): Promise<void> {
    const key = await this.devicePublicKey();
    await navigator.clipboard.writeText(key);
    new Notice(`tcsync: device key copied\n${key}`);
  }

  private onState(s: ConnState, detail?: string): void {
    this.lastDetail = detail ?? "";
    this.statusBar.set(s, detail);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSettingsAndReconnect(): Promise<void> {
    await this.saveSettings();
    await this.reconnect();
  }

  async reconnect(): Promise<void> {
    this.conn.reset();
    await this.prepare();
  }

  /** The URL LiveSync uses, when it points at our hostname; else a default. */
  private probeUrl(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ls = (this.app as any).plugins?.plugins?.["obsidian-livesync"];
    let uri: string | undefined;
    try {
      uri = ls?.core?.services?.setting?.currentSettings?.()?.couchDB_URI;
    } catch {
      uri = undefined;
    }
    if (uri && matchesHost(uri, this.settings.host)) return new URL("/", uri).href;
    return `http://${this.settings.host}:5984/`;
  }

  async testConnection(): Promise<void> {
    const url = this.probeUrl();
    new Notice("tcsync: testing…");
    try {
      const res = await this.conn.request(url, { method: "GET" });
      let msg = `HTTP ${res.status}`;
      if (res.ok) {
        const j = (await res.json()) as { couchdb?: string; version?: string };
        if (j.couchdb) msg = `CouchDB ${j.version ?? ""} answered`;
      } else if (res.status === 401) {
        msg = "CouchDB answered (login required — LiveSync supplies it)";
      }
      new Notice(`tcsync: connected. ${msg}`, 8000);
    } catch (e) {
      new Notice(`tcsync: ${e instanceof Error ? e.message : String(e)}`, 12000);
    }
  }

  private addCommands(): void {
    this.addCommand({ id: "reconnect", name: "Reconnect tunnel", callback: () => void this.reconnect() });
    this.addCommand({ id: "test-connection", name: "Test connection", callback: () => void this.testConnection() });
    this.addCommand({ id: "copy-device-key", name: "Copy device key", callback: () => void this.copyDeviceKey() });
    this.addCommand({
      id: "status",
      name: "Show status",
      callback: () => new Notice(`tcsync: ${this.conn.state}${this.lastDetail ? `\n${this.lastDetail}` : ""}`, 8000),
    });
  }
}
