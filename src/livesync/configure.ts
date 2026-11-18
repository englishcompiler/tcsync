/**
 * Configures Self-hosted LiveSync for tcsync without its setup wizard.
 *
 * Probed against LiveSync 1.0.50 (test/e2e/probe-livesync.mjs):
 * - Settings: `core.services.setting.applyPartial(partial, save)`, `currentSettings()`.
 * - Initialisation: `core.serviceModules.rebuilder.scheduleRebuild()` / `scheduleFetch()` write a flag
 *   file and restart Obsidian; on the next start LiveSync asks its own questions (below). The merge
 *   behaviour we want ("newer wins, keep local files") exists only inside that flow, so tcsync runs
 *   it and answers the known dialogs itself ("autopilot"). Unknown dialogs are left to the person.
 * - LiveSync's initialisation switches every sync trigger off (`suspendAllSync`) and never turns them
 *   back on, so tcsync applies SYNC_MODE_LIVE once initialisation has finished.
 */

export interface LiveSyncSecrets {
  /** End-to-end encryption passphrase. */
  e2ee: string;
  /** LiveSync ID-derivation key (64 hex chars). */
  idKey: string;
}

export interface LiveSyncLike {
  version: string;
  setting: {
    applyPartial(p: Record<string, unknown>, save?: boolean): Promise<unknown>;
    currentSettings(): Record<string, unknown>;
  };
  rebuilder: { scheduleFetch(): Promise<unknown>; scheduleRebuild(): Promise<unknown> };
  /** Restarts LiveSync (core.services.appLifecycle.performRestart); live mode only starts after one. */
  restart(): void;
  /** True once LiveSync finished starting up (and any scheduled initialisation). */
  isReady?(): boolean;
}

export const REMOTE_ID = "remote-tcsync-hub";
export const TCSYNC_IGNORE_PATTERN = "\\/\\.obsidian\\/plugins\\/tcsync\\/";

/** What LiveSync's own setup link applies for tcsync's fixed remote (minus sync mode and secrets). */
export const LIVESYNC_SETTINGS_FOR_TCSYNC: Record<string, unknown> = {
  couchDB_URI: "http://couch.tailcat:5984",
  couchDB_USER: "tcsync",
  couchDB_PASSWORD: "tcsync",
  couchDB_DBNAME: "obsidian",
  remoteConfigurations: {
    [REMOTE_ID]: { id: REMOTE_ID, name: "tcsync hub", uri: "sls+http://tcsync:tcsync@couch.tailcat:5984/?db=obsidian", isEncrypted: false },
  },
  activeConfigurationId: REMOTE_ID,
  encrypt: true,
  usePathObfuscation: true,
  concurrencyOfReadChunksOnline: 30,
  minimumIntervalOfReadChunksOnline: 25,
  isConfigured: true,
};

/** LiveSync mode: changes go out and come in within seconds. */
export const SYNC_MODE_LIVE: Record<string, unknown> = {
  liveSync: true,
  periodicReplication: false,
  syncOnStart: true,
  syncOnSave: false,
  syncOnEditorSave: false,
  syncOnFileOpen: false,
  syncAfterMerge: false,
  batchSave: false,
};

export function liveSyncSettings(secrets: LiveSyncSecrets, currentIgnore: string): Record<string, unknown> {
  const ignore = currentIgnore.includes(TCSYNC_IGNORE_PATTERN)
    ? currentIgnore
    : [currentIgnore, TCSYNC_IGNORE_PATTERN].filter((s) => s.trim()).join(", ");
  return {
    ...LIVESYNC_SETTINGS_FOR_TCSYNC,
    passphrase: secrets.e2ee,
    idDerivationVersion: 1,
    idDerivationKey: secrets.idKey,
    syncInternalFilesIgnorePatterns: ignore,
  };
}

/**
 * Applies tcsync's LiveSync settings and starts LiveSync's own initialisation:
 * - device: fetch from the hub (merge) → "scheduled" (Obsidian restarts; autopilot answers).
 * - hub, initialise: overwrite the (empty) hub store from this vault → "scheduled".
 * - hub, !initialise: the hub store already has the data → settings + live sync now → "applied".
 * Returns "fallback" without changing anything if LiveSync's internals aren't as expected.
 * Callers persist their autopilot session BEFORE calling: "scheduled" restarts Obsidian.
 */
export async function configureLiveSync(
  ls: LiveSyncLike,
  o: { role: "hub" | "device"; secrets: LiveSyncSecrets; initialise?: boolean },
): Promise<"scheduled" | "applied" | "fallback"> {
  if (typeof ls?.setting?.applyPartial !== "function" || typeof ls.setting.currentSettings !== "function"
    || typeof ls.rebuilder?.scheduleFetch !== "function" || typeof ls.rebuilder.scheduleRebuild !== "function"
    || typeof ls.restart !== "function") return "fallback";
  const ignore = String(ls.setting.currentSettings().syncInternalFilesIgnorePatterns ?? "");
  await ls.setting.applyPartial(liveSyncSettings(o.secrets, ignore), true);
  if (o.role === "device") {
    await ls.rebuilder.scheduleFetch();
    return "scheduled";
  }
  if (o.initialise ?? true) {
    await ls.rebuilder.scheduleRebuild();
    return "scheduled";
  }
  await enableLiveSync(ls);
  return "applied";
}

/**
 * Turns LiveSync mode on (initialisation leaves every trigger off) and restarts LiveSync once:
 * in 1.0.50 a settings change alone runs one sync but does not start the live feed.
 */
export async function enableLiveSync(ls: LiveSyncLike): Promise<void> {
  await ls.setting.applyPartial(SYNC_MODE_LIVE, true);
  ls.restart();
}

export function liveSyncVersionWarning(version: string): string | null {
  return /^1\.0\.\d+$/.test(version) ? null : `Self-hosted LiveSync ${version} hasn't been tested with tcsync yet. Sync may still work.`;
}

// ---------------------------------------------------------------------------------------------
// Autopilot: answers LiveSync's known initialisation dialogs.

export interface ModalView {
  title: string;
  labels: { text: string; type: string; checked: boolean; click(): void }[];
  buttons: { text: string; disabled: boolean; click(): void }[];
}

interface Rule {
  title: RegExp;
  roles: ("hub" | "device")[];
  tick?: RegExp[];
  click: string;
}

const RULES: Rule[] = [
  {
    title: /^Final Confirmation: Overwrite Server Data/,
    roles: ["hub"],
    tick: [/^I understand that/, /^I understand the risks/],
    click: "I Understand, Overwrite Server",
  },
  { title: /^All optional features are disabled/, roles: ["hub", "device"], click: "OK" },
  { title: /^Data retrieval scheduled$/, roles: ["device"], click: "Compare time and take newer" },
  { title: /^Conflict & Deletion Options$/, roles: ["device"], click: "Keep local files even if deleted on remote" },
  { title: /^Resume scheduled fetch\?$/, roles: ["device"], click: "Continue with these choices" },
];

/** Answers one dialog if it is a known LiveSync initialisation dialog. Returns true if it clicked. */
export function answerModal(m: ModalView, role: "hub" | "device"): boolean {
  const rule = RULES.find((r) => r.title.test(m.title.trim()) && r.roles.includes(role));
  if (!rule) return false;
  for (const l of m.labels) {
    if (!l.checked && rule.tick?.some((re) => re.test(l.text.trim()))) l.click();
  }
  const b = m.buttons.find((x) => x.text.trim() === rule.click);
  if (!b || b.disabled) return false;
  b.click();
  return true;
}

/** Reads an Obsidian `.modal` element as a ModalView. */
export function modalView(el: HTMLElement): ModalView {
  return {
    title: el.querySelector(".modal-title")?.textContent ?? "",
    labels: [...el.querySelectorAll("label")].flatMap((l) => {
      const input = l.querySelector("input");
      if (!input) return [];
      return [{ text: l.textContent ?? "", type: input.type, get checked() { return input.checked; }, click: () => input.click() }];
    }),
    buttons: [...el.querySelectorAll("button")].map((b) => ({ text: b.textContent ?? "", disabled: b.disabled, click: () => b.click() })),
  };
}

/** Watches for LiveSync dialogs and answers known ones until stopped. */
export function startAutopilot(doc: Document, role: "hub" | "device", log: (s: string) => void): () => void {
  const scan = () => {
    for (const el of doc.querySelectorAll<HTMLElement>(".modal")) {
      const v = modalView(el);
      // Ticking boxes enables the button asynchronously (Svelte); answer on the next frame.
      if (answerModal(v, role)) log(`answered "${v.title}"`);
      else if (v.labels.length) window.setTimeout(() => { if (doc.contains(el) && answerModal(modalView(el), role)) log(`answered "${v.title}"`); }, 300);
    }
  };
  const obs = new MutationObserver(() => scan());
  obs.observe(doc.body, { childList: true, subtree: true });
  scan();
  return () => obs.disconnect();
}

// ---------------------------------------------------------------------------------------------
// Access to the installed LiveSync plugin.

export const LIVESYNC_ID = "obsidian-livesync";
/** Opens Self-hosted LiveSync's page in Community plugins (install button). */
export const LIVESYNC_PAGE = "obsidian://show-plugin?id=obsidian-livesync";
/** Flag files LiveSync uses for a scheduled fetch/rebuild (present until it has finished). */
export const INIT_FLAGS = ["flag_fetch.md", "flag_rebuild.md", "redflag2.md", "redflag3.md"];

/** The running LiveSync, or null if it isn't installed/enabled (or its internals changed). */
export function liveSyncOf(app: unknown): (LiveSyncLike & { isReady(): boolean }) | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (app as any)?.plugins?.plugins?.[LIVESYNC_ID];
  const c = p?.core;
  if (!c?.services?.setting || !c.serviceModules?.rebuilder || !c.services.appLifecycle) return null;
  return {
    version: String(p.manifest?.version ?? "?"),
    setting: c.services.setting,
    rebuilder: c.serviceModules.rebuilder,
    restart: () => c.services.appLifecycle.performRestart(),
    isReady: () => Boolean(c.services.appLifecycle.isReady?.()),
  };
}

/** True when LiveSync already points at some remote (switching to hub mode replaces it). */
export function liveSyncConfigured(ls: LiveSyncLike): boolean {
  const s = ls.setting.currentSettings();
  const remotes = s.remoteConfigurations && typeof s.remoteConfigurations === "object" ? Object.keys(s.remoteConfigurations) : [];
  return s.isConfigured === true && (Boolean(s.couchDB_URI) || remotes.length > 0);
}
