import { App, Modal, Setting } from "obsidian";
import qrcode from "qrcode-generator";

/** A yes/no question. Resolves true for the main button. */
export function ask(app: App, o: { title: string; body: string[]; yes: string; no?: string; warning?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const m = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(o.title);
        for (const p of o.body) this.contentEl.createEl("p", { text: p });
        new Setting(this.contentEl)
          .addButton((b) => {
            b.setButtonText(o.yes).onClick(() => { answered = true; resolve(true); this.close(); });
            if (o.warning) b.setWarning(); else b.setCta();
          })
          .addButton((b) => b.setButtonText(o.no ?? "Cancel").onClick(() => this.close()));
      }
      onClose() { if (!answered) resolve(false); this.contentEl.empty(); }
    })(app);
    m.open();
  });
}

/** Asks for one line of text (device name, pasted link). Resolves null on cancel. */
export function askText(app: App, o: { title: string; body: string; value?: string; placeholder?: string; ok: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let value = o.value ?? "";
    let done = false;
    const m = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(o.title);
        this.contentEl.createEl("p", { text: o.body });
        new Setting(this.contentEl).addText((t) => {
          t.setValue(value).setPlaceholder(o.placeholder ?? "").onChange((v) => (value = v));
          t.inputEl.style.width = "100%";
          window.setTimeout(() => t.inputEl.focus(), 50);
        });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText(o.ok).setCta().onClick(() => { done = true; resolve(value.trim() || null); this.close(); }))
          .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
      }
      onClose() { if (!done) resolve(null); this.contentEl.empty(); }
    })(app);
    m.open();
  });
}

/** Shows the pairing QR code and link with a countdown. */
export class PairModal extends Modal {
  private timer = 0;
  constructor(app: App, private o: { deviceName: string; link: string; expiresAt: number; isPaired: () => boolean }) {
    super(app);
  }

  onOpen(): void {
    const { contentEl: el } = this;
    this.titleEl.setText(`Add “${this.o.deviceName}”`);
    el.addClass("tcsync-pair");
    const steps = el.createEl("ol");
    steps.createEl("li", { text: "On the new device, install Obsidian and open (or create) the vault you want to sync." });
    steps.createEl("li", { text: "Install the plugins tcsync and Self-hosted LiveSync there, and turn both on." });
    steps.createEl("li", { text: "Point the phone's camera at this code and tap the link. On a computer, use “Copy link” and paste it into tcsync’s settings there." });
    steps.createEl("li", { text: "Tap “Pair” on the new device. That’s it. Keep this window open until it says Paired." });

    const qr = qrcode(0, "L");
    qr.addData(this.o.link);
    qr.make();
    const box = el.createDiv({ cls: "tcsync-qr" });
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });

    const status = el.createEl("p", { cls: "tcsync-pair-status" });
    new Setting(el).addButton((b) =>
      b.setButtonText("Copy link").onClick(async () => {
        await navigator.clipboard.writeText(this.o.link);
        b.setButtonText("Copied");
      }),
    ).addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));

    const tick = () => {
      if (this.o.isPaired()) {
        status.setText("✅ Paired. The device is downloading your notes now.");
        box.empty();
        window.clearInterval(this.timer);
        return;
      }
      const left = Math.max(0, this.o.expiresAt - Date.now());
      if (left === 0) {
        status.setText("This code has expired. Close this window and choose Add a device again.");
        box.empty();
        window.clearInterval(this.timer);
        return;
      }
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      status.setText(`Waiting for the device… this code works for ${m}:${String(s).padStart(2, "0")} more.`);
    };
    tick();
    this.timer = window.setInterval(tick, 1000);
  }

  onClose(): void {
    window.clearInterval(this.timer);
    this.contentEl.empty();
  }
}
