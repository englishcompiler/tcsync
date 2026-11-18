import { describe, it, expect } from "vitest";
import {
  configureLiveSync, liveSyncSettings, SYNC_MODE_LIVE, answerModal, liveSyncVersionWarning,
  type LiveSyncLike, type ModalView,
} from "../src/livesync/configure";

function fakeLiveSync(over: Partial<LiveSyncLike> = {}) {
  const calls: string[] = [];
  let saved: Record<string, unknown> = { syncInternalFilesIgnorePatterns: "\\/node_modules\\/, \\/\\.git\\/, \\/obsidian-livesync\\/" };
  const ls: LiveSyncLike & { calls: string[]; saved: () => Record<string, unknown> } = {
    version: "1.0.50",
    setting: {
      applyPartial: async (p) => { saved = { ...saved, ...p }; calls.push("save"); },
      currentSettings: () => saved,
    },
    rebuilder: {
      scheduleFetch: async () => { calls.push("scheduleFetch"); return true; },
      scheduleRebuild: async () => { calls.push("scheduleRebuild"); return true; },
    },
    restart: () => { calls.push("restart"); },
    calls,
    saved: () => saved,
    ...over,
  };
  return ls;
}
const secrets = { e2ee: "pass-phrase", idKey: "ab".repeat(32) };

describe("configureLiveSync", () => {
  it("device: applies remote, E2EE and ID settings, then schedules a fetch", async () => {
    const ls = fakeLiveSync();
    expect(await configureLiveSync(ls, { role: "device", secrets })).toBe("scheduled");
    expect(ls.saved()).toMatchObject({
      couchDB_URI: "http://couch.tailcat:5984", couchDB_DBNAME: "obsidian", couchDB_USER: "tcsync", couchDB_PASSWORD: "tcsync",
      activeConfigurationId: "remote-tcsync-hub", encrypt: true, passphrase: "pass-phrase", usePathObfuscation: true,
      idDerivationVersion: 1, idDerivationKey: "ab".repeat(32), isConfigured: true,
    });
    expect((ls.saved().remoteConfigurations as Record<string, { uri: string }>)["remote-tcsync-hub"].uri)
      .toBe("sls+http://tcsync:tcsync@couch.tailcat:5984/?db=obsidian");
    expect(ls.calls).toEqual(["save", "scheduleFetch"]);
  });
  it("keeps tcsync's own folder out of hidden-file sync, preserving existing patterns", async () => {
    const ls = fakeLiveSync();
    await configureLiveSync(ls, { role: "device", secrets });
    const p = ls.saved().syncInternalFilesIgnorePatterns as string;
    expect(p).toContain("\\/obsidian-livesync\\/");
    expect(p).toContain("\\/\\.obsidian\\/plugins\\/tcsync\\/");
  });
  it("hub with initialise: schedules a rebuild (initialise the remote)", async () => {
    const ls = fakeLiveSync();
    expect(await configureLiveSync(ls, { role: "hub", secrets, initialise: true })).toBe("scheduled");
    expect(ls.calls).toEqual(["save", "scheduleRebuild"]);
  });
  it("hub without initialise (store already has data): applies settings, turns live sync on and restarts once", async () => {
    const ls = fakeLiveSync();
    expect(await configureLiveSync(ls, { role: "hub", secrets, initialise: false })).toBe("applied");
    expect(ls.calls).toEqual(["save", "save", "restart"]);
    expect(ls.saved()).toMatchObject(SYNC_MODE_LIVE);
  });
  it("returns 'fallback' and changes nothing when an internal is missing", async () => {
    const ls = fakeLiveSync({ rebuilder: undefined as unknown as LiveSyncLike["rebuilder"] });
    expect(await configureLiveSync(ls, { role: "device", secrets })).toBe("fallback");
    expect(ls.calls).toEqual([]);
  });
  it("liveSyncSettings never enables periodic/live sync before initialisation", () => {
    const s = liveSyncSettings(secrets, "");
    expect(s.liveSync).toBeUndefined();
    expect(s.periodicReplication).toBeUndefined();
  });
  it("SYNC_MODE_LIVE is LiveSync mode", () => {
    expect(SYNC_MODE_LIVE).toMatchObject({ liveSync: true, periodicReplication: false, syncOnStart: true });
  });
});

function modal(title: string, labels: { text: string; type: "checkbox" | "radio" }[], buttons: string[]) {
  const log: string[] = [];
  const m: ModalView & { log: string[] } = {
    title,
    labels: labels.map((l) => ({ ...l, checked: false as boolean, click() { this.checked = !this.checked; log.push(`tick:${l.text}`); } })),
    buttons: buttons.map((t) => ({ text: t, disabled: false, click() { log.push(`click:${t}`); } })),
    log,
  };
  return m;
}

describe("answerModal (autopilot)", () => {
  it("hub: confirms the overwrite after ticking every 'I understand' box and the risks radio", () => {
    const m = modal("Final Confirmation: Overwrite Server Data with This Device's Files", [
      { text: "I understand that all changes made on other smartphones…", type: "checkbox" },
      { text: "I understand that other devices will no longer…", type: "checkbox" },
      { text: "I understand that this action is irreversible once performed.", type: "checkbox" },
      { text: "I have created a backup of my Vault.", type: "radio" },
      { text: "I understand the risks and will proceed without a backup.", type: "radio" },
      { text: "I am unable to create a backup of my Vault.", type: "radio" },
    ], ["I Understand, Overwrite Server", "Cancel"]);
    expect(answerModal(m, "hub")).toBe(true);
    expect(m.log.filter((x) => x.startsWith("tick:")).length).toBe(4);
    expect(m.log).toContain("tick:I understand the risks and will proceed without a backup.");
    expect(m.log.at(-1)).toBe("click:I Understand, Overwrite Server");
  });
  it("device: never answers the overwrite-server confirmation", () => {
    const m = modal("Final Confirmation: Overwrite Server Data with This Device's Files", [], ["I Understand, Overwrite Server", "Cancel"]);
    expect(answerModal(m, "device")).toBe(false);
    expect(m.log).toEqual([]);
  });
  it("device: fetch merges (newer wins) and keeps local files", () => {
    const a = modal("Data retrieval scheduled", [], ["Compare time and take newer", "Overwrite all with remote files", "Use the detailed flow", "Cancel"]);
    expect(answerModal(a, "device")).toBe(true);
    expect(a.log).toEqual(["click:Compare time and take newer"]);
    const b = modal("Conflict & Deletion Options", [], ["Delete local files if deleted on remote", "Keep local files even if deleted on remote", "Cancel all and reboot"]);
    expect(answerModal(b, "device")).toBe(true);
    expect(b.log).toEqual(["click:Keep local files even if deleted on remote"]);
  });
  it("answers 'All optional features are disabled' and 'Resume scheduled fetch?'", () => {
    const a = modal("All optional features are disabled", [], ["OK"]);
    expect(answerModal(a, "hub")).toBe(true);
    const b = modal("Resume scheduled fetch?", [], ["Continue with these choices", "Choose again", "Cancel"]);
    expect(answerModal(b, "device")).toBe(true);
    expect(b.log).toEqual(["click:Continue with these choices"]);
  });
  it("leaves unknown dialogs to the person", () => {
    const m = modal("Something new", [], ["Yes", "No"]);
    expect(answerModal(m, "device")).toBe(false);
    expect(m.log).toEqual([]);
  });
  it("does not click a disabled button", () => {
    const m = modal("All optional features are disabled", [], ["OK"]);
    m.buttons[0].disabled = true;
    expect(answerModal(m, "hub")).toBe(false);
  });
});

describe("liveSyncVersionWarning", () => {
  it("is null for tested 1.0.x and a message otherwise", () => {
    expect(liveSyncVersionWarning("1.0.50")).toBeNull();
    expect(liveSyncVersionWarning("1.0.99")).toBeNull();
    expect(liveSyncVersionWarning("1.1.0")).toBe("Self-hosted LiveSync 1.1.0 hasn't been tested with tcsync yet. Sync may still work.");
    expect(liveSyncVersionWarning("2.0.0")).toMatch(/2\.0\.0/);
  });
});
