import type { ConnState } from "./types";

const LABEL: Record<ConnState, string> = {
  idle: "tcsync: idle",
  connecting: "tcsync: connecting…",
  up: "tcsync: up",
  unreachable: "tcsync: unreachable",
  direct: "tcsync: direct",
  error: "tcsync: error",
};

/** Renders the connection state into the status bar item. */
export class StatusBar {
  constructor(private el: HTMLElement) {
    el.addClass("tcsync-status");
    this.set("idle");
  }

  set(state: ConnState, detail?: string): void {
    this.el.setText(LABEL[state]);
    this.el.setAttr("aria-label", detail ? `${LABEL[state]} — ${detail}` : LABEL[state]);
    for (const s of Object.keys(LABEL)) this.el.removeClass(`tcsync-${s}`);
    this.el.addClass(`tcsync-${state}`);
  }
}
