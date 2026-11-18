/** Renders tcsync's status into its status bar item (short label; full sentence on hover). */
export class StatusBar {
  private cls = "";
  constructor(private el: HTMLElement) {
    el.addClass("tcsync-status");
    this.show("tcsync", "tcsync", "idle");
  }

  show(label: string, tooltip: string, cls: string): void {
    this.el.setText(label);
    this.el.setAttr("aria-label", tooltip);
    if (this.cls) this.el.removeClass(`tcsync-${this.cls}`);
    this.cls = cls;
    this.el.addClass(`tcsync-${cls}`);
  }
}
