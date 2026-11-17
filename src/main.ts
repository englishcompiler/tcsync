import { Notice, Plugin } from "obsidian";
import { Connection } from "./connection";
import { installLiveSyncHook, patchGlobalFetch, type HookHandle } from "./hooks";
import { orderBefore } from "./loadOrder";
import { matchesHost } from "./route";
import { createRouter } from "./router";
import { TcsyncSettingTab } from "./settingsTab";
import { StatusBar } from "./statusBar";
import { DEFAULT_SETTINGS, type Bridge, type ConnState, type TcsyncSettings } from "./types";
import { loadBridge } from "./wasm";

const LIVESYNC_ID = "obsidian-livesync";
const HOOK_RETRY_MS = 100;
const HOOK_RETRY_LIMIT = 300; // 30 s

export default class TcsyncPlugin extends Plugin {
  settings!: TcsyncSettings;
  conn!: Connection;
  lastDetail = "";
  private bridge: Bridge | null = null;
  private statusBar!: StatusBar;
  private liveSyncHook: HookHandle | null = null;

  private settingsLoaded!: Promise<void>;
  private unloaded = false;

  async onload(): Promise<void> {
    // Everything up to the first await runs before the next plugin is loaded.
    // Self-hosted LiveSync must find our fetch patch in place when its code is
    // evaluated (it binds a private copy of fetch), so patch first, load later.
    this.settings = { ...DEFAULT_SETTINGS };
    const liveSyncLoadedFirst = Boolean(this.liveSyncPlugin());
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.conn = new Connection(this.lazyBridge(), () => this.settings, (s, d) => this.onState(s, d));
    this.settingsLoaded = this.loadData().then((d) => {
      this.settings = { ...DEFAULT_SETTINGS, ...((d as Partial<TcsyncSettings> | null) ?? {}) };
    });

    const router = createRouter({
      host: () => this.settings.host,
      unloaded: () => this.unloaded,
      ready: this.settingsLoaded,
      verbose: () => this.settings.verbose,
      request: (req, init, original) => this.conn.request(req, init, original),
    });
    this.register(patchGlobalFetch(router));
    this.liveSyncHook = installLiveSyncHook(this.app, router, {
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      intervalMs: HOOK_RETRY_MS,
      limit: HOOK_RETRY_LIMIT,
      onGiveUp: () => console.warn("[tcsync] Self-hosted LiveSync not found; only the global fetch is routed."),
    });

    await this.settingsLoaded;
    this.addSettingTab(new TcsyncSettingTab(this.app, this));
    this.addCommands();
    this.app.workspace.onLayoutReady(() => void this.prepare());
    let hiddenAt = 0;
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else void this.conn.onResume(hiddenAt ? Date.now() - hiddenAt : 0);
    });
    await this.ensureLoadOrder(liveSyncLoadedFirst);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private liveSyncPlugin(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.app as any).plugins?.plugins?.[LIVESYNC_ID];
  }

  onunload(): void {
    // LiveSync keeps the fetch wrapper it bound at load time; make it pass through.
    this.unloaded = true;
    this.liveSyncHook?.restore();
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
      ping: async (ms, port) => (await this.getBridge()).ping(ms, port),
    };
  }

  private async getBridge(): Promise<Bridge> {
    if (!this.bridge) this.bridge = await loadBridge();
    return this.bridge;
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

  /**
   * Makes tcsync load before LiveSync from the next start on (see loadOrder.ts).
   * Obsidian's in-memory set of enabled plugins is the source of truth: the
   * file on disk is written later by a debounced save (and may not list
   * LiveSync yet), and that save writes the set in its current order.
   */
  private async ensureLoadOrder(liveSyncLoadedFirst: boolean): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mgr = (this.app as any).plugins;
      const enabled: Set<string> | undefined = mgr?.enabledPlugins;
      if (enabled instanceof Set) {
        const next = orderBefore([...enabled], this.manifest.id, LIVESYNC_ID);
        if (next) {
          // On first enable tcsync isn't in the set yet; Obsidian adds it after
          // onload resolves, which is then a no-op.
          enabled.clear();
          for (const id of next) enabled.add(id);
          const path = `${this.app.vault.configDir}/community-plugins.json`;
          await this.app.vault.adapter.write(path, JSON.stringify(next, null, 2));
        }
      }
      if (liveSyncLoadedFirst) {
        new Notice(
          "tcsync: please restart Obsidian once. tcsync now loads before Self-hosted LiveSync, which LiveSync's fast fetch needs to go through the tunnel.",
          15000,
        );
      }
    } catch (e) {
      console.warn("[tcsync] could not check plugin load order", e);
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
