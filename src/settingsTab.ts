import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TcsyncPlugin from "./main";
import type { Mode } from "./types";

const DOCS = "https://github.com/englishcompiler/tcsync/blob/main/docs/setup.md";

export class TcsyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TcsyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl: el } = this;
    const p = this.plugin;
    el.empty();

    const intro = el.createEl("p");
    intro.appendText("tcsync carries Self-hosted LiveSync's CouchDB traffic through a tailcat tunnel to your own server. ");
    intro.createEl("a", { text: "Setup guide", href: DOCS });
    el.createEl("p", { text: `Status: ${p.conn.state}${p.lastDetail ? ` (${p.lastDetail})` : ""}`, cls: "tcsync-setting-status" });

    new Setting(el)
      .setName("Mode")
      .setDesc("Tunnel: this device reaches the server through tailcat. Direct: this device is the server (CouchDB on this computer).")
      .addDropdown((d) =>
        d
          .addOption("tunnel", "Tunnel")
          .addOption("direct", "Direct")
          .setValue(p.settings.mode)
          .onChange(async (v) => {
            p.settings.mode = v as Mode;
            await p.saveSettingsAndReconnect();
            this.display();
          }),
      );

    if (p.settings.mode === "tunnel") {
      new Setting(el)
        .setName("Server address")
        .setDesc("The tc… address printed by the server setup (status.sh shows it again).")
        .addTextArea((t) => {
          t.inputEl.addClass("tcsync-mono");
          t.inputEl.rows = 3;
          t.setPlaceholder("tc…").setValue(p.settings.addr);
          t.inputEl.addEventListener("change", async () => {
            p.settings.addr = t.getValue().trim();
            await p.saveSettingsAndReconnect();
          });
        });

      const keySetting = new Setting(el)
        .setName("Device key")
        .setDesc("Add this key to the server's allowlist: ./server/allow.sh add <key>");
      const keyEl = keySetting.descEl.createEl("code", { cls: "tcsync-mono tcsync-key", text: "loading…" });
      void p.devicePublicKey().then(
        (k) => keyEl.setText(k),
        (e) => keyEl.setText(`unavailable: ${e instanceof Error ? e.message : e}`),
      );
      keySetting.addButton((b) => b.setButtonText("Copy").onClick(() => p.copyDeviceKey()));
    } else {
      new Setting(el)
        .setName("Direct URL")
        .setDesc("Where CouchDB listens on this computer.")
        .addText((t) =>
          t.setValue(p.settings.directUrl).onChange(async (v) => {
            p.settings.directUrl = v.trim();
            await p.saveSettings();
          }),
        );
    }

    new Setting(el)
      .setName("Tunnel hostname")
      .setDesc("LiveSync requests to this hostname go through tcsync. Use it in LiveSync's server URI, e.g. http://couch.tailcat:5984")
      .addText((t) =>
        t.setValue(p.settings.host).onChange(async (v) => {
          p.settings.host = v.trim() || "couch.tailcat";
          await p.saveSettings();
        }),
      );

    new Setting(el)
      .setName("Verbose log")
      .setDesc("Log every routed request to the developer console.")
      .addToggle((t) =>
        t.setValue(p.settings.verbose).onChange(async (v) => {
          p.settings.verbose = v;
          await p.saveSettings();
        }),
      );

    new Setting(el)
      .addButton((b) => b.setButtonText("Test connection").setCta().onClick(() => p.testConnection()))
      .addButton((b) =>
        b.setButtonText("Reconnect").onClick(async () => {
          await p.reconnect();
          new Notice("tcsync: reconnecting");
          this.display();
        }),
      );
  }
}
