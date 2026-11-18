import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { LIVESYNC_PAGE, liveSyncOf } from "./livesync/configure";
import type TcsyncPlugin from "./main";
import type { Mode } from "./types";
import { askText } from "./ui/modals";

const DOCS = "https://github.com/englishcompiler/tcsync#readme";

function ago(t?: number): string {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export class TcsyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TcsyncPlugin) {
    super(app, plugin);
  }

  hide(): void {
    this.plugin.onRefresh = null;
  }

  display(): void {
    const { containerEl: el } = this;
    const p = this.plugin;
    p.onRefresh = () => { if (el.isShown()) this.display(); };
    el.empty();

    const intro = el.createEl("p");
    intro.appendText("tcsync keeps this vault in sync across your devices through your own computer — no account, no cloud. ");
    intro.createEl("a", { text: "Help", href: DOCS });
    el.createEl("p", { text: p.status().text, cls: "tcsync-setting-status" });

    if (!liveSyncOf(this.app)) {
      new Setting(el)
        .setName("Step 1: install Self-hosted LiveSync")
        .setDesc("tcsync needs the free Self-hosted LiveSync plugin. Install it, turn it on, then come back here.")
        .addButton((b) => b.setButtonText("Install Self-hosted LiveSync").setCta().onClick(() => window.open(LIVESYNC_PAGE)));
    }

    const role = p.settings.mode === "hub" ? "hub" : p.settings.advanced ? "advanced" : "device";
    new Setting(el)
      .setName("This device is…")
      .setDesc("Choose “the hub” on the one computer that keeps everything together. Choose “syncing with a hub” on every phone, tablet and other computer.")
      .addDropdown((d) => {
        if (!Platform.isMobile || role === "hub") d.addOption("hub", "The hub (this computer)");
        d.addOption("device", "Syncing with a hub");
        d.addOption("advanced", "Advanced: my own server");
        d.setValue(role).onChange(async (v) => {
          if (v === role) return;
          if (role === "hub") {
            await p.stopHub();
            if (p.settings.mode === "hub") return this.display();
          }
          if (v === "hub") await p.makeHub();
          else {
            p.settings.advanced = v === "advanced";
            if (p.settings.mode === "hub") p.settings.mode = "tunnel";
            await p.saveSettingsAndReconnect();
          }
          this.display();
        });
      });

    if (role === "hub") this.hubSection(el);
    else if (role === "device") this.deviceSection(el);
    else this.advancedSection(el);

    new Setting(el)
      .setName("Detailed log")
      .setDesc("For troubleshooting: logs every sync request to the developer console.")
      .addToggle((t) =>
        t.setValue(p.settings.verbose).onChange(async (v) => {
          p.settings.verbose = v;
          await p.saveSettings();
        }),
      );
  }

  private hubSection(el: HTMLElement): void {
    const p = this.plugin;
    const h = p.settings.hub;
    new Setting(el)
      .setName("Add a device")
      .setDesc("Shows a QR code. Scan it with the phone (or tablet, or other computer) you want to add.")
      .addButton((b) =>
        b.setButtonText("Add a device").setCta().onClick(async () => {
          const name = await askText(this.app, { title: "Add a device", body: "What should this device be called?", value: "My phone", ok: "Show code" });
          if (name) await p.addDevice(name);
        }),
      );

    el.createEl("h3", { text: "Devices" });
    const devices = h?.devices ?? [];
    if (devices.length === 0) el.createEl("p", { text: "No devices yet. Use “Add a device” above.", cls: "setting-item-description" });
    for (const d of devices) {
      const desc = d.state === "paired"
        ? `Paired · last synced ${ago(d.lastSeen)}`
        : `Waiting for the code to be scanned (expires ${new Date(d.addedAt + 10 * 60 * 1000).toLocaleTimeString()})`;
      new Setting(el).setName(d.name).setDesc(desc).addButton((b) => b.setButtonText("Remove").setWarning().onClick(() => p.removeDevice(d.publicKey, d.name)));
    }

    el.createEl("h3", { text: "Hub" });
    new Setting(el)
      .setName("Keep this computer awake while Obsidian is open")
      .setDesc("Recommended. Your devices can only sync while this computer is awake and Obsidian is open.")
      .addToggle((t) =>
        t.setValue(h?.keepAwake ?? true).onChange(async (v) => {
          if (!p.settings.hub) return;
          p.settings.hub.keepAwake = v;
          await p.saveSettings();
          p.applyKeepAlive();
        }),
      );
    new Setting(el)
      .setName("Test")
      .setDesc("Checks that the hub answers.")
      .addButton((b) => b.setButtonText("Test").onClick(() => p.testConnection()));
  }

  private deviceSection(el: HTMLElement): void {
    const p = this.plugin;
    if (p.settings.addr && !p.settings.pendingPair) {
      new Setting(el)
        .setName(`Paired with “${p.settings.hubName ?? "your hub"}”`)
        .setDesc("To pair with a different hub, scan a new code from that computer.")
        .addButton((b) => b.setButtonText("Test").onClick(() => p.testConnection()))
        .addButton((b) =>
          b.setButtonText("Reconnect").onClick(async () => {
            await p.reconnect();
            new Notice("tcsync: reconnecting");
          }),
        );
      return;
    }
    const how = el.createEl("ol", { cls: "tcsync-steps" });
    how.createEl("li", { text: "On your computer, open Obsidian → Settings → tcsync. If it isn't the hub yet, choose “The hub (this computer)”." });
    how.createEl("li", { text: "Press “Add a device”. A QR code appears." });
    how.createEl("li", { text: Platform.isMobile ? "Scan the QR code with this phone's camera and tap the link." : "Press “Copy link” there, then “Paste pairing link” below." });
    new Setting(el)
      .setName("Paste pairing link")
      .setDesc("Only needed when you can't scan the code (for example on a computer).")
      .addButton((b) =>
        b.setButtonText("Paste pairing link").onClick(async () => {
          const link = await askText(this.app, { title: "Paste pairing link", body: "Paste the link from “Copy link” on your hub computer.", placeholder: "obsidian://tcsync?pair=…", ok: "Pair" });
          if (!link) return;
          let pair = "";
          try { pair = new URL(link).searchParams.get("pair") ?? ""; } catch { pair = ""; }
          await p.onPairingLink(pair);
        }),
      );
  }

  private advancedSection(el: HTMLElement): void {
    const p = this.plugin;
    el.createEl("p", { cls: "setting-item-description", text: "For people running their own always-on CouchDB server (see the setup guide). Most people should use a hub instead." });
    new Setting(el)
      .setName("Connection")
      .setDesc("Tunnel: this device reaches the server through tailcat. Direct: CouchDB runs on this computer.")
      .addDropdown((d) =>
        d.addOption("tunnel", "Tunnel").addOption("direct", "Direct").setValue(p.settings.mode === "direct" ? "direct" : "tunnel")
          .onChange(async (v) => {
            p.settings.mode = v as Mode;
            await p.saveSettingsAndReconnect();
            this.display();
          }),
      );
    if (p.settings.mode === "tunnel") {
      new Setting(el)
        .setName("Server address")
        .setDesc("The tc… address printed by the server setup (server/status.sh shows it again).")
        .addTextArea((t) => {
          t.inputEl.addClass("tcsync-mono");
          t.inputEl.rows = 3;
          t.setPlaceholder("tc…").setValue(p.settings.addr);
          t.inputEl.addEventListener("change", async () => {
            p.settings.addr = t.getValue().trim();
            await p.saveSettingsAndReconnect();
          });
        });
      const keySetting = new Setting(el).setName("Device key").setDesc("Add this key to the server's allowlist: server/allow.sh add <key>");
      const keyEl = keySetting.descEl.createEl("code", { cls: "tcsync-mono tcsync-key", text: "loading…" });
      void p.devicePublicKey().then((k) => keyEl.setText(k), (e) => keyEl.setText(`unavailable: ${e instanceof Error ? e.message : e}`));
      keySetting.addButton((b) => b.setButtonText("Copy").onClick(() => p.copyDeviceKey()));
    } else {
      new Setting(el)
        .setName("Direct URL")
        .setDesc("Where CouchDB listens on this computer.")
        .addText((t) => t.setValue(p.settings.directUrl).onChange(async (v) => { p.settings.directUrl = v.trim(); await p.saveSettings(); }));
    }
    new Setting(el)
      .setName("Tunnel hostname")
      .setDesc("LiveSync requests to this hostname go through tcsync, e.g. http://couch.tailcat:5984")
      .addText((t) => t.setValue(p.settings.host).onChange(async (v) => { p.settings.host = v.trim() || "couch.tailcat"; await p.saveSettings(); }));
    new Setting(el)
      .addButton((b) => b.setButtonText("Test connection").setCta().onClick(() => p.testConnection()))
      .addButton((b) => b.setButtonText("Reconnect").onClick(async () => { await p.reconnect(); new Notice("tcsync: reconnecting"); }));
  }
}
