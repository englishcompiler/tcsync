import { Notice, Platform, Plugin } from "obsidian";
import { backupNotes, type BackupFs } from "./backup";
import { Connection } from "./connection";
import { installLiveSyncHook, patchGlobalFetch, type HookHandle } from "./hooks";
import { Hub, newHubState } from "./hub/hub";
import { keepHubAlive, type ElectronLike } from "./hub/keepAwake";
import { fromHubResponse, toHubRequest } from "./hub/route";
import { createStore, type HubStore } from "./hub/store";
import {
  configureLiveSync, enableLiveSync, INIT_FLAGS, LIVESYNC_ID, LIVESYNC_PAGE, liveSyncConfigured, liveSyncOf, liveSyncVersionWarning,
  startAutopilot,
} from "./livesync/configure";
import { orderBefore } from "./loadOrder";
import { pairingLink, readPairing, type PairingPayload } from "./pair";
import { matchesHost } from "./route";
import { createRouter } from "./router";
import { TcsyncSettingTab } from "./settingsTab";
import { StatusBar } from "./statusBar";
import { DEFAULT_SETTINGS, type Bridge, type ConnState, type TcsyncSettings } from "./types";
import { ask, PairModal } from "./ui/modals";
import { statusLabel, statusText, type Shown } from "./ui/statusText";
import { loadBridge } from "./wasm";

const HOOK_RETRY_MS = 100;
const HOOK_RETRY_LIMIT = 300; // 30 s
const AUTOPILOT_MS = 30 * 60 * 1000;
const LONG_OFFLINE_MS = 10 * 60 * 1000;
const PAIR_TTL_MS = 10 * 60 * 1000;

export default class TcsyncPlugin extends Plugin {
  settings!: TcsyncSettings;
  conn!: Connection;
  hub: Hub | null = null;
  hubError = "";
  lastDetail = "";
  private bridge: Bridge | null = null;
  private statusBar!: StatusBar;
  private liveSyncHook: HookHandle | null = null;
  private hubStore: HubStore | null = null;
  private releaseKeepAlive: (() => void) | null = null;
  private stopAutopilot: (() => void) | null = null;
  private unreachableSince = 0;
  private settingsLoaded!: Promise<void>;
  private unloaded = false;
  private hubReady: Promise<Hub> | null = null;
  private hubReadyResolve: ((h: Hub) => void) | null = null;
  /** Refreshes the settings screen if it's open. */
  onRefresh: (() => void) | null = null;

  async onload(): Promise<void> {
    // Everything up to the first await runs before the next plugin is loaded.
    // Self-hosted LiveSync must find our fetch patch in place when its code is
    // evaluated (it binds a private copy of fetch), so patch first, load later.
    this.settings = { ...DEFAULT_SETTINGS };
    const liveSyncLoadedFirst = Boolean(this.liveSyncPlugin());
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.conn = new Connection(this.lazyBridge(), () => this.settings, (s, d) => this.onState(s, d));
    this.settingsLoaded = this.loadData().then((d) => {
      const raw = (d as Partial<TcsyncSettings> | null) ?? {};
      this.settings = { ...DEFAULT_SETTINGS, ...raw };
      // 0.1.x installs (own server) keep their screen: advanced unless paired with a hub.
      if (raw.advanced === undefined && (raw.mode === "direct" || (raw.addr && !raw.hubName))) this.settings.advanced = true;
    });

    const router = createRouter({
      host: () => this.settings.host,
      unloaded: () => this.unloaded,
      ready: this.settingsLoaded,
      verbose: () => this.settings.verbose,
      request: (req, init, original) => this.route(req, init, original),
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
    this.registerObsidianProtocolHandler("tcsync", (params) => void this.onPairingLink(params.pair ?? ""));
    this.app.workspace.onLayoutReady(() => void this.afterLayout());
    let hiddenAt = 0;
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (this.settings.mode !== "hub") void this.conn.onResume(hiddenAt ? Date.now() - hiddenAt : 0);
    });
    await this.ensureLoadOrder(liveSyncLoadedFirst);
  }

  onunload(): void {
    // LiveSync keeps the fetch wrapper it bound at load time; make it pass through.
    this.unloaded = true;
    this.liveSyncHook?.restore();
    this.conn?.reset();
    this.stopAutopilot?.();
    this.releaseKeepAlive?.();
    void this.hub?.stop();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private liveSyncPlugin(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.app as any).plugins?.plugins?.[LIVESYNC_ID];
  }

  /** Requests for the tunnel hostname: in-process on the hub, through the tunnel elsewhere. */
  private async route(req: RequestInfo | URL, init: RequestInit | undefined, original: typeof fetch): Promise<Response> {
    if (this.settings.mode === "hub") {
      const hub = await this.waitForHub();
      const r = await toHubRequest(req, init);
      return fromHubResponse(await hub.handle(r, init?.signal ?? undefined), r.method);
    }
    return this.conn.request(req, init, original);
  }

  private waitForHub(): Promise<Hub> {
    if (this.hub) return Promise.resolve(this.hub);
    if (!this.hubReady) this.hubReady = new Promise((r) => (this.hubReadyResolve = r));
    return this.hubReady;
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
      serve: async (o) => (await this.getBridge()).serve(o),
      serveAllow: async (k) => (await this.getBridge()).serveAllow(k),
      serveClose: async () => { await this.bridge?.serveClose(); },
    };
  }

  private async getBridge(): Promise<Bridge> {
    if (!this.bridge) this.bridge = await loadBridge();
    return this.bridge;
  }

  private async afterLayout(): Promise<void> {
    if (this.settings.autopilot) this.resumeAutopilot();
    await this.prepare();
    if (this.settings.pendingPair && !this.settings.autopilot) void this.resumePendingPair();
    const ls = liveSyncOf(this.app);
    const warn = ls && liveSyncVersionWarning(ls.version);
    if (warn) new Notice(`tcsync: ${warn}`, 10000);
  }

  /** Starts whatever this vault's role needs: the hub, or the tunnel to the hub/server. */
  private async prepare(): Promise<void> {
    try {
      if (this.settings.mode === "hub") {
        await this.startHub();
      } else if (this.settings.mode === "tunnel") {
        await this.ensureDeviceKey();
        if (this.settings.addr) await this.conn.ensureUp().catch(() => {});
        else this.onState("idle");
      } else {
        await this.conn.ensureUp();
      }
    } catch (e) {
      this.onState("error", e instanceof Error ? e.message : String(e));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Hub mode

  private async startHub(): Promise<void> {
    if (!this.settings.hub) return;
    try {
      await this.getBridge();
      this.hubStore ??= createStore("idb");
      this.hub = new Hub({
        bridge: this.lazyBridge(),
        store: this.hubStore,
        state: () => this.settings.hub!,
        save: async (s) => { this.settings.hub = s; await this.saveSettings(); },
        now: () => Date.now(),
        setTimer: (fn, ms) => { const t = window.setTimeout(fn, ms); return () => window.clearTimeout(t); },
        onChange: () => this.refresh(),
      });
      await this.hub.start();
      this.hubError = "";
      this.hubReadyResolve?.(this.hub);
      this.applyKeepAlive();
      this.refresh();
      if (!this.settings.autopilot && (await this.hub.storeWasLost())) {
        console.warn("[tcsync] the hub database is empty although this hub was set up before; rebuilding it from this vault");
        new Notice("tcsync: the hub's database was empty, so it is being rebuilt from this vault. Your devices will catch up by themselves.", 15000);
        await this.initialiseLiveSync("hub", true);
      }
    } catch (e) {
      this.hubError = e instanceof Error ? e.message : String(e);
      this.refresh();
    }
  }

  applyKeepAlive(): void {
    this.releaseKeepAlive?.();
    let electron: ElectronLike | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      electron = require("electron") as ElectronLike;
    } catch {
      electron = null;
    }
    this.releaseKeepAlive = keepHubAlive(electron, { preventSleep: this.settings.hub?.keepAwake ?? true });
  }

  /** "Make this computer the hub". */
  async makeHub(): Promise<void> {
    if (Platform.isMobile) {
      new Notice("tcsync: a phone or tablet can't be the hub. Use Obsidian on your computer.");
      return;
    }
    const ls = liveSyncOf(this.app);
    if (!ls) {
      new Notice("tcsync: install and turn on Self-hosted LiveSync first (Settings → Community plugins).", 10000);
      window.open(LIVESYNC_PAGE);
      return;
    }
    const replacing = liveSyncConfigured(ls);
    const ok = await ask(this.app, {
      title: "Make this computer the hub?",
      body: [
        "Your notes will sync through this computer. Phones and other computers sync whenever Obsidian is open here.",
        ...(replacing ? ["Self-hosted LiveSync is already set up in this vault. Your other devices will need to scan a new code."] : []),
        "Obsidian will restart once.",
      ],
      yes: "Make this computer the hub",
    });
    if (!ok) return;
    this.conn.reset();
    this.settings.hub ??= newHubState(this.app.vault.getName());
    this.settings.mode = "hub";
    this.settings.advanced = false;
    await this.saveSettings();
    await this.startHub();
    if (this.hubError) {
      new Notice(`tcsync: ${statusText("hub", "error", { detail: this.hubError })}`, 15000);
      return;
    }
    await this.initialiseLiveSync("hub", await this.hubStore!.isEmpty());
  }

  /** Stops being the hub (devices stop syncing until a hub is back). */
  async stopHub(): Promise<void> {
    const ok = await ask(this.app, {
      title: "Stop being the hub?",
      body: ["Your other devices will stop syncing until you turn the hub back on. Nothing is deleted."],
      yes: "Stop the hub",
      warning: true,
    });
    if (!ok) return;
    this.releaseKeepAlive?.();
    this.releaseKeepAlive = null;
    await this.hub?.stop();
    this.hub = null;
    this.hubReady = null;
    this.settings.mode = "tunnel";
    await this.saveSettings();
    this.onState("idle");
  }

  /** "Add a device": mints a device key and shows the pairing QR code. */
  async addDevice(name: string): Promise<void> {
    if (!this.hub || !this.settings.hub) {
      new Notice("tcsync: the hub isn't running yet.");
      return;
    }
    const { privateKey, record } = await this.hub.addDevice(name);
    const h = this.settings.hub;
    const expiresAt = record.addedAt + PAIR_TTL_MS;
    const link = pairingLink({ v: 1, hub: h.addr, key: privateKey, vault: h.vaultName, e2ee: h.secrets.e2ee, idKey: h.secrets.idKey, db: "obsidian", exp: expiresAt });
    new PairModal(this.app, {
      deviceName: name,
      link,
      expiresAt,
      isPaired: () => this.settings.hub?.devices.find((d) => d.publicKey === record.publicKey)?.state === "paired",
    }).open();
  }

  async removeDevice(publicKey: string, name: string): Promise<void> {
    const ok = await ask(this.app, {
      title: `Remove “${name}”?`,
      body: ["It stops syncing straight away. Its notes stay on it. To add it again, scan a new code."],
      yes: "Remove",
      warning: true,
    });
    if (ok) await this.hub?.removeDevice(publicKey);
  }

  // ---------------------------------------------------------------------------------------------
  // Pairing (device side)

  async onPairingLink(pair: string): Promise<void> {
    if (this.settings.mode === "hub") {
      new Notice("tcsync: this computer is the hub. Open the code on the device you want to add.", 10000);
      return;
    }
    const r = readPairing(pair, Date.now(), this.settings.pendingPair ? undefined : this.settings.privateKey);
    if (!r.ok) {
      const msg = {
        expired: "This code has expired. Make a new one on your computer.",
        invalid: "This pairing code isn't valid. Make a new one on your computer.",
        version: "This code needs a newer tcsync. Update tcsync here, then scan again.",
        "already-paired": "This vault is already paired with that hub.",
      }[r.reason];
      new Notice(`tcsync: ${msg}`, 10000);
      return;
    }
    const ok = await ask(this.app, {
      title: `Pair this vault with “${r.payload.vault}”?`,
      body: [
        "This vault will sync with your hub. Notes already here are kept and merged with the hub's; a backup zip is saved in this vault first.",
        "Obsidian will restart once.",
      ],
      yes: "Pair",
    });
    if (!ok) return;
    this.settings.mode = "tunnel";
    this.settings.advanced = false;
    this.settings.addr = r.payload.hub;
    this.settings.privateKey = r.payload.key;
    this.settings.hubName = r.payload.vault;
    this.settings.pendingPair = r.payload;
    await this.saveSettings();
    await this.resumePendingPair();
  }

  /** Finishes a pairing once the hub is reachable and LiveSync is loaded (after tcsync). */
  private async resumePendingPair(): Promise<void> {
    const p = this.settings.pendingPair;
    if (!p) return;
    this.conn.reset();
    new Notice("tcsync: connecting to your hub…");
    try {
      await this.conn.ensureUp();
    } catch {
      new Notice("tcsync: couldn't reach your hub. Make sure Obsidian is open on your computer, then scan the code again.", 15000);
      return;
    }
    if (!liveSyncOf(this.app)) {
      new Notice("tcsync: connected. Now install and turn on Self-hosted LiveSync to finish pairing. tcsync continues by itself.", 15000);
      window.open(LIVESYNC_PAGE);
      this.restartWhenLiveSyncAppears();
      return;
    }
    const zip = await backupNotes(this.vaultFs(), new Date());
    if (zip) console.info(`[tcsync] backed up this vault's notes to ${zip}`);
    await this.finishPairing(p);
  }

  private async finishPairing(p: PairingPayload): Promise<void> {
    this.settings.pendingPair = undefined;
    await this.saveSettings();
    await this.initialiseLiveSync("device", false, { e2ee: p.e2ee, idKey: p.idKey });
  }

  /**
   * LiveSync was installed while tcsync was already running, so LiveSync bound the real fetch:
   * restart once (tcsync then loads first) and pairing resumes on the next start.
   */
  private restartWhenLiveSyncAppears(): void {
    const t = window.setInterval(() => {
      if (!liveSyncOf(this.app)) return;
      window.clearInterval(t);
      new Notice("tcsync: Self-hosted LiveSync is on. Restarting Obsidian once to finish pairing…", 8000);
      window.setTimeout(() => this.restartObsidian(), 1500);
    }, 2000);
    this.register(() => window.clearInterval(t));
  }

  private restartObsidian(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = this.app as any;
    if (typeof a.commands?.executeCommandById === "function" && a.commands.executeCommandById("app:reload")) return;
    window.location.reload();
  }

  // ---------------------------------------------------------------------------------------------
  // LiveSync initialisation with autopilot

  /**
   * Applies tcsync's LiveSync settings and runs LiveSync's own initialisation (fetch for a device,
   * rebuild for the hub), answering its known dialogs. Obsidian restarts in between, so the session
   * is saved first and resumed on the next start (resumeAutopilot).
   */
  private async initialiseLiveSync(role: "hub" | "device", initialise: boolean, secrets = this.settings.hub?.secrets): Promise<void> {
    const ls = liveSyncOf(this.app);
    if (!ls || !secrets) return;
    this.settings.autopilot = { role, until: Date.now() + AUTOPILOT_MS };
    await this.saveSettings();
    const r = await configureLiveSync(ls, { role, secrets, initialise });
    if (r === "applied") {
      this.settings.autopilot = undefined;
      if (role === "hub") await this.hub?.markInitialised();
      await this.saveSettings();
    } else if (r === "fallback") {
      this.settings.autopilot = undefined;
      await this.saveSettings();
      new Notice("tcsync: this version of Self-hosted LiveSync can't be set up automatically. See tcsync's setup guide.", 15000);
    }
  }

  private resumeAutopilot(): void {
    const ap = this.settings.autopilot;
    if (!ap) return;
    if (Date.now() > ap.until) {
      this.settings.autopilot = undefined;
      void this.saveSettings();
      return;
    }
    this.stopAutopilot = startAutopilot(document, ap.role, (s) => console.info(`[tcsync] ${s}`));
    new Notice(ap.role === "hub" ? "tcsync: setting up the hub… (this takes a minute)" : "tcsync: downloading your notes from the hub…", 8000);
    const t = window.setInterval(() => void (async () => {
      const ls = liveSyncOf(this.app);
      if (!ls?.isReady()) return;
      for (const f of INIT_FLAGS) if (await this.app.vault.adapter.exists(f)) return;
      if (document.querySelector(".modal")) return;
      window.clearInterval(t);
      this.stopAutopilot?.();
      this.stopAutopilot = null;
      this.settings.autopilot = undefined;
      if (ap.role === "hub") await this.hub?.markInitialised();
      await this.saveSettings();
      new Notice(ap.role === "hub" ? "tcsync: the hub is ready. Add your phone: Settings → tcsync → Add a device." : "tcsync: paired. Your notes now sync with your hub.", 10000);
      await enableLiveSync(ls);
    })(), 2000);
    this.register(() => window.clearInterval(t));
  }

  // ---------------------------------------------------------------------------------------------

  private vaultFs(): BackupFs {
    const a = this.app.vault.adapter;
    const list = async (dir: string): Promise<string[]> => {
      const l = await a.list(dir);
      const out = [...l.files];
      for (const d of l.folders) out.push(...(await list(d)));
      return out;
    };
    return {
      list: () => list(""),
      read: async (p) => new Uint8Array(await a.readBinary(p)),
      write: (p, d) => a.writeBinary(p, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer),
      remove: (p) => a.remove(p),
    };
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
          enabled.clear();
          for (const id of next) enabled.add(id);
          const path = `${this.app.vault.configDir}/community-plugins.json`;
          await this.app.vault.adapter.write(path, JSON.stringify(next, null, 2));
        }
      }
      if (liveSyncLoadedFirst && !this.settings.pendingPair) {
        new Notice("tcsync: please restart Obsidian once. tcsync now loads before Self-hosted LiveSync, which it needs.", 15000);
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
    if (s === "unreachable") this.unreachableSince ||= Date.now();
    else this.unreachableSince = 0;
    this.refresh();
  }

  /** What the person should see now. */
  status(): { label: string; text: string; cls: string } {
    const m = this.settings.mode;
    let shown: Shown;
    if (m === "hub") shown = this.hubError ? "error" : this.hub ? "hub-on" : "connecting";
    else if (m === "tunnel" && !this.settings.addr) shown = "idle";
    else shown = this.conn.state === "idle" ? "connecting" : this.conn.state;
    const o = {
      devices: this.settings.hub?.devices.filter((d) => d.state === "paired").length ?? 0,
      detail: m === "hub" ? this.hubError : this.lastDetail,
      longOffline: this.unreachableSince > 0 && Date.now() - this.unreachableSince > LONG_OFFLINE_MS,
    };
    return { label: statusLabel(m, shown, o), text: statusText(m, shown, o), cls: shown };
  }

  refresh(): void {
    const s = this.status();
    this.statusBar?.show(s.label, s.text, s.cls);
    this.onRefresh?.();
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
    let uri: string | undefined;
    try {
      uri = this.liveSyncPlugin()?.core?.services?.setting?.currentSettings?.()?.couchDB_URI;
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
      const res = await this.route(url, { method: "GET" }, fetch);
      let msg = `HTTP ${res.status}`;
      if (res.ok) {
        const j = (await res.json()) as { couchdb?: string; version?: string; vendor?: { name?: string } };
        if (j.vendor?.name === "tcsync hub") msg = "your hub answered";
        else if (j.couchdb) msg = `CouchDB ${j.version ?? ""} answered`;
      } else if (res.status === 401) {
        msg = "CouchDB answered (login required — LiveSync supplies it)";
      }
      new Notice(`tcsync: connected, ${msg}.`, 8000);
    } catch (e) {
      new Notice(`tcsync: ${e instanceof Error ? e.message : String(e)}`, 12000);
    }
  }

  private addCommands(): void {
    this.addCommand({ id: "make-hub", name: "Make this computer the hub", callback: () => void this.makeHub() });
    this.addCommand({
      id: "add-device",
      name: "Add a device (show pairing code)",
      checkCallback: (checking) => {
        if (this.settings.mode !== "hub") return false;
        if (!checking) void this.addDevice("New device");
        return true;
      },
    });
    this.addCommand({ id: "reconnect", name: "Reconnect", callback: () => void this.reconnect() });
    this.addCommand({ id: "test-connection", name: "Test connection", callback: () => void this.testConnection() });
    this.addCommand({ id: "copy-device-key", name: "Copy device key (advanced)", callback: () => void this.copyDeviceKey() });
    this.addCommand({ id: "status", name: "Show status", callback: () => new Notice(`tcsync: ${this.status().text}`, 8000) });
  }
}
