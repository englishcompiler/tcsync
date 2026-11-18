// Draws the whiteboard-style diagrams in docs/img/ (hand-drawn look, pastel colours).
//   node docs/diagrams/make.mjs        (macOS/Linux with Google Chrome or Chromium installed)
// Shapes come from rough.js with fixed seeds, so re-running gives the same pictures. Text uses the
// Kalam handwriting font (SIL OFL), downloaded once into node_modules/.cache.
import rough from "roughjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = join(repo, "docs/img");
const cache = join(repo, "node_modules/.cache/tcsync-diagrams");

// ---------- palette ----------
const INK = "#3f4652";
const C = {
  blue: { fill: "#e7f0fa", stroke: "#6d93bd" },
  green: { fill: "#e6f3e4", stroke: "#6c9f6b" },
  yellow: { fill: "#fdf3cf", stroke: "#c9a441" },
  pink: { fill: "#fbe8ee", stroke: "#c27b93" },
  lilac: { fill: "#efeaf8", stroke: "#8d78bb" },
  peach: { fill: "#fdebdf", stroke: "#c98a5f" },
  grey: { fill: "#f3f4f6", stroke: "#8a909a" },
};

// ---------- drawing ----------
class Board {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.els = [];
    this.gen = rough.generator();
    this.seed = 1;
  }
  opts(o = {}) {
    return {
      seed: o.seed ?? this.seed++,
      roughness: o.roughness ?? 1.1,
      bowing: o.bowing ?? 1,
      stroke: o.stroke ?? INK,
      strokeWidth: o.strokeWidth ?? 1.6,
      fill: o.fill,
      fillStyle: o.fillStyle ?? "solid",
      hachureGap: o.hachureGap ?? 6,
      fillWeight: o.fillWeight ?? 1,
    };
  }
  draw(drawable, o = {}) {
    for (const p of this.gen.toPaths(drawable)) {
      const dash = o.dashed && p.fill === "none" ? ` stroke-dasharray="8 7"` : "";
      this.els.push(`<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill ?? "none"}" stroke-linecap="round"${dash}/>`);
    }
  }
  path(d, o = {}) { this.draw(this.gen.path(d, this.opts(o)), o); }
  box(x, y, w, h, col, o = {}) {
    const r = o.r ?? 14;
    const d = `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
    this.path(d, { fill: col?.fill, stroke: col?.stroke ?? INK, ...o });
  }
  circle(cx, cy, d, col, o = {}) {
    this.draw(this.gen.ellipse(cx, cy, d, d, this.opts({ fill: col?.fill, stroke: col?.stroke ?? INK, ...o })), o);
  }
  line(x1, y1, x2, y2, o = {}) { this.draw(this.gen.line(x1, y1, x2, y2, this.opts(o)), o); }
  head(x, y, angle, o = {}) {
    const len = 13, spread = 0.45;
    for (const s of [-spread, spread]) {
      const a = angle + Math.PI + s;
      this.line(x, y, x + len * Math.cos(a), y + len * Math.sin(a), { ...o, dashed: false, roughness: 0.6 });
    }
  }
  /** Straight arrow; `both` puts a head at each end. */
  arrow(x1, y1, x2, y2, o = {}) {
    this.line(x1, y1, x2, y2, { roughness: 0.9, bowing: 2, ...o });
    const a = Math.atan2(y2 - y1, x2 - x1);
    this.head(x2, y2, a, o);
    if (o.both) this.head(x1, y1, a + Math.PI, o);
  }
  /** Arrow along a polyline (for the return path). */
  route(points, o = {}) {
    for (let i = 0; i < points.length - 1; i++) this.line(...points[i], ...points[i + 1], { roughness: 0.8, ...o });
    const [p, q] = points.slice(-2);
    this.head(q[0], q[1], Math.atan2(q[1] - p[1], q[0] - p[0]), o);
  }
  text(x, y, str, o = {}) {
    const size = o.size ?? 20, lh = size * 1.25;
    const lines = String(str).split("\n");
    const anchor = o.anchor ?? "middle";
    const weight = o.bold ? 700 : 400;
    const rot = o.rotate ? ` transform="rotate(${o.rotate} ${x} ${y})"` : "";
    const y0 = o.valign === "top" ? y + size : y - ((lines.length - 1) * lh) / 2 + size * 0.35;
    const spans = lines.map((l, i) => `<tspan x="${x}" y="${(y0 + i * lh).toFixed(1)}">${esc(l)}</tspan>`).join("");
    this.els.push(`<text font-family="Kalam" font-size="${size}" font-weight="${weight}" fill="${o.color ?? INK}" text-anchor="${anchor}"${rot}>${spans}</text>`);
  }
  /** Small numbered circle. */
  badge(cx, cy, n) {
    this.circle(cx, cy, 28, { fill: "#ffffff", stroke: INK }, { strokeWidth: 1.4, roughness: 0.7 });
    this.text(cx, cy, String(n), { size: 17, bold: true });
  }
  padlock(cx, cy, col = C.yellow) {
    this.path(`M${cx - 6} ${cy - 2} V${cy - 8} A6 6 0 0 1 ${cx + 6} ${cy - 8} V${cy - 2}`, { strokeWidth: 1.8, roughness: 0.5 });
    this.box(cx - 10, cy - 3, 20, 15, col, { r: 3, roughness: 0.6, strokeWidth: 1.5 });
  }
  sticky(x, y, w, h, str, o = {}) {
    const g = [];
    const before = this.els.length;
    this.box(x, y, w, h, C.yellow, { r: 4, roughness: 0.8 });
    this.text(x + w / 2, y + h / 2, str, { size: o.size ?? 18 });
    if (o.rotate) {
      g.push(...this.els.splice(before));
      this.els.push(`<g transform="rotate(${o.rotate} ${x + w / 2} ${y + h / 2})">${g.join("")}</g>`);
    }
  }
  cloud(cx, cy, w, h, col) {
    const sx = w / 260, sy = h / 170;
    const P = (dx, dy) => `${(cx + dx * sx).toFixed(1)} ${(cy + dy * sy).toFixed(1)}`;
    const A = (r, dx, dy) => `A${(r * sx).toFixed(1)} ${(r * sy).toFixed(1)} 0 0 1 ${P(dx, dy)}`;
    const d = `M${P(-95, 60)} ${A(48, -118, -20)} ${A(55, -55, -78)} ${A(62, 40, -82)} ${A(55, 118, -25)} ${A(48, 95, 60)} Z`;
    this.path(d, { fill: col.fill, stroke: col.stroke });
  }
  cylinder(x, y, w, h, col) {
    const ry = 12;
    this.path(`M${x} ${y + ry} V${y + h - ry} A${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} V${y + ry}`, { fill: col.fill, stroke: col.stroke });
    this.draw(this.gen.ellipse(x + w / 2, y + ry, w, ry * 2, this.opts({ fill: col.fill, stroke: col.stroke })));
  }
  phone(cx, cy, col = C.blue) {
    this.box(cx - 28, cy - 50, 56, 100, { fill: "#ffffff", stroke: col.stroke }, { r: 10 });
    this.box(cx - 21, cy - 38, 42, 70, col, { r: 3, roughness: 0.6 });
    this.circle(cx, cy + 42, 7, null, { strokeWidth: 1.2 });
  }
  tablet(cx, cy, col = C.blue) {
    this.box(cx - 46, cy - 58, 92, 116, { fill: "#ffffff", stroke: col.stroke }, { r: 10 });
    this.box(cx - 37, cy - 47, 74, 88, col, { r: 3, roughness: 0.6 });
    this.circle(cx, cy + 50, 7, null, { strokeWidth: 1.2 });
  }
  laptop(cx, cy, col = C.blue) {
    this.box(cx - 55, cy - 45, 110, 70, { fill: "#ffffff", stroke: col.stroke }, { r: 6 });
    this.box(cx - 46, cy - 37, 92, 54, col, { r: 2, roughness: 0.6 });
    this.path(`M${cx - 55} ${cy + 27} L${cx - 72} ${cy + 45} H${cx + 72} L${cx + 55} ${cy + 27}`, { fill: "#ffffff", stroke: col.stroke });
  }
  monitor(cx, cy, w, h, col = C.green) {
    this.box(cx - w / 2, cy - h / 2, w, h, { fill: "#ffffff", stroke: col.stroke }, { r: 10 });
    this.box(cx - w / 2 + 10, cy - h / 2 + 10, w - 20, h - 20, col, { r: 4, roughness: 0.6 });
    this.path(`M${cx - 14} ${cy + h / 2} L${cx - 22} ${cy + h / 2 + 30} H${cx + 22} L${cx + 14} ${cy + h / 2}`, { fill: "#ffffff", stroke: col.stroke });
    this.line(cx - 55, cy + h / 2 + 32, cx + 55, cy + h / 2 + 32, { stroke: col.stroke, strokeWidth: 2 });
  }
  svg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>${this.els.join("\n")}</svg>`;
  }
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- sequence diagrams ----------
/**
 * participants: [{id, label, col}], steps: [{from, to, text, back?} | {note, over: [id, id?]}]
 */
function sequence({ participants, steps, colW = 215, top = 30 }) {
  const boxH = 74, rowH = 64, margin = 30;
  const xs = Object.fromEntries(participants.map((p, i) => [p.id, margin + colW / 2 + i * colW]));
  const rows = steps.map((s) => (s.note ? Math.max(rowH, 30 + s.note.split("\n").length * 24) : rowH + (s.text.split("\n").length - 1) * 22));
  const height = top + boxH + 30 + rows.reduce((a, b) => a + b, 0) + 30;
  const b = new Board(margin * 2 + colW * participants.length, height);
  const bottom = height - 25;
  for (const p of participants) {
    const x = xs[p.id];
    b.line(x, top + boxH, x, bottom, { stroke: "#b8bdc6", strokeWidth: 1.3, dashed: true, roughness: 0.5 });
  }
  for (const p of participants) {
    const x = xs[p.id];
    b.box(x - colW / 2 + 12, top, colW - 24, boxH, p.col);
    b.text(x, top + boxH / 2, p.label, { size: 18 });
  }
  let y = top + boxH + 30;
  let n = 1;
  steps.forEach((s, i) => {
    const h = rows[i];
    if (s.note) {
      const xa = xs[s.over[0]], xb = xs[s.over.at(-1)];
      const longest = Math.max(...s.note.split("\n").map((l) => l.length));
      const w = Math.max(colW - 10, xb - xa + colW - 30, longest * 8.6 + 36);
      b.sticky((xa + xb) / 2 - w / 2, y + 6, w, h - 14, s.note, { size: 17 });
    } else {
      const x1 = xs[s.from], x2 = xs[s.to];
      const ay = y + h - 18;
      const dir = Math.sign(x2 - x1);
      b.badge(x1 + dir * 17, ay, n++);
      b.arrow(x1 + dir * 34, ay, x2 - dir * 6, ay, { dashed: s.back, stroke: s.back ? "#6b7280" : INK });
      const lines = s.text.split("\n").length;
      b.text((x1 + x2) / 2 + dir * 14, ay - 22 - ((lines - 1) * 22) / 2, s.text, { size: 17 });
    }
    y += h;
  });
  return b;
}

// ---------- the diagrams ----------
function overview() {
  const b = new Board(1200, 560);
  // devices
  b.box(30, 40, 310, 480, { fill: "#f7fafd", stroke: C.blue.stroke }, { dashed: true, roughness: 0.8, r: 22 });
  b.text(185, 78, "Your other devices", { size: 26, bold: true });
  b.text(185, 110, "anywhere: home, mobile data, café", { size: 18, color: "#6b7280" });
  b.phone(110, 205);
  b.text(235, 205, "Phone", { size: 22 });
  b.tablet(110, 335);
  b.text(235, 335, "Tablet", { size: 22 });
  b.laptop(110, 455);
  b.text(235, 455, "Laptop", { size: 22 });
  // relay
  b.cloud(600, 250, 290, 190, C.yellow);
  b.text(600, 225, "Public relay", { size: 25, bold: true });
  b.text(600, 272, "passes on locked boxes,\ncan't open them", { size: 18 });
  // hub
  b.box(860, 40, 310, 480, { fill: "#f6fbf5", stroke: C.green.stroke }, { dashed: true, roughness: 0.8, r: 22 });
  b.text(1015, 78, "HUB COMPUTER", { size: 26, bold: true });
  b.text(1015, 110, "yours, at home", { size: 18, color: "#6b7280" });
  b.monitor(1015, 250, 240, 150);
  b.text(1015, 250, "Obsidian\n+ tcsync", { size: 24, bold: true });
  b.text(1015, 400, "keeps every device\nin step", { size: 20 });
  // arrows
  b.arrow(298, 200, 462, 238, { both: true });
  b.arrow(298, 345, 462, 272, { both: true });
  b.arrow(298, 455, 472, 302, { both: true });
  b.arrow(748, 255, 884, 255, { both: true });
  b.padlock(380, 188);
  b.text(380, 160, "encrypted", { size: 16 });
  b.padlock(816, 226);
  b.text(816, 286, "encrypted", { size: 16 });
  // note
  b.sticky(468, 400, 270, 92, "Only devices you added\nwith a QR code get in", { rotate: -2, size: 19 });
  return b;
}

function howItWorks() {
  const b = new Board(1240, 560);
  // phone
  b.box(30, 30, 300, 420, { fill: "#f7fafd", stroke: C.blue.stroke }, { dashed: true, roughness: 0.8, r: 22 });
  b.text(180, 66, "Your phone", { size: 25, bold: true });
  b.box(65, 105, 230, 80, C.lilac);
  b.text(180, 145, "LiveSync", { size: 22, bold: true });
  b.box(65, 285, 230, 80, C.blue);
  b.text(180, 325, "tcsync", { size: 22, bold: true });
  b.arrow(180, 190, 180, 278);
  b.badge(150, 234, 1);
  b.text(232, 234, "\"send my\nchanges\"", { size: 17, anchor: "start" });
  // relay
  b.cloud(520, 325, 230, 150, C.yellow);
  b.text(520, 312, "Relay", { size: 23, bold: true });
  b.text(520, 345, "can't read them", { size: 17 });
  b.arrow(300, 325, 405, 325);
  b.badge(352, 290, 2);
  b.padlock(352, 360);
  // hub
  b.box(700, 30, 510, 420, { fill: "#f6fbf5", stroke: C.green.stroke }, { dashed: true, roughness: 0.8, r: 22 });
  b.text(955, 66, "HUB COMPUTER", { size: 25, bold: true });
  b.box(730, 285, 190, 80, C.green);
  b.text(825, 325, "tcsync hub", { size: 22, bold: true });
  b.arrow(636, 325, 723, 325);
  b.badge(680, 290, 3);
  b.sticky(728, 110, 200, 104, "Is this a device\nadded by\nQR code?", { rotate: -2, size: 18 });
  b.line(825, 218, 825, 280, { stroke: "#9aa0a8", strokeWidth: 1.3, dashed: true });
  b.text(838, 250, "no → ignored", { size: 16, color: "#6b7280", anchor: "start" });
  b.cylinder(1015, 270, 160, 120, C.peach);
  b.text(1095, 335, "Hub\ndatabase", { size: 20, bold: true });
  b.arrow(925, 325, 1008, 325);
  b.badge(966, 292, 4);
  b.text(1095, 425, "stores it, still\nend-to-end encrypted", { size: 16, color: "#6b7280" });
  // way back
  b.route([[1095, 465], [1095, 505], [180, 505], [180, 372]], { dashed: true, stroke: "#6b7280" });
  b.badge(640, 505, 5);
  b.text(680, 532, "other devices' changes come back the same way", { size: 18, anchor: "middle" });
  return b;
}

function archHub() {
  return sequence({
    participants: [
      { id: "LS", label: "LiveSync\n(phone)", col: C.lilac },
      { id: "TC", label: "tcsync\n(phone)", col: C.blue },
      { id: "DERP", label: "DERP relay", col: C.yellow },
      { id: "L", label: "hub: tailcat listener\n(WASM, in Obsidian)", col: C.green },
      { id: "H", label: "CouchDB-compatible\nhandler (TypeScript)", col: C.green },
      { id: "DB", label: "PouchDB in\nIndexedDB", col: C.peach },
      { id: "LH", label: "LiveSync\n(hub computer)", col: C.lilac },
    ],
    steps: [
      { from: "LS", to: "TC", text: "fetch(couch.tailcat:5984\n/obsidian/_changes…)" },
      { from: "TC", to: "DERP", text: "WireGuard packets\nover a WebSocket" },
      { from: "DERP", to: "L", text: "forwards ciphertext" },
      { note: "device key paired by QR code?\nno → dropped silently", over: ["L"] },
      { from: "L", to: "H", text: "HTTP request\n(+ the device's key)" },
      { from: "H", to: "DB", text: "db.changes(…): waits\nfor a change or 25 s" },
      { from: "LH", to: "H", text: "in-process: same handler, no network" },
      { from: "H", to: "L", text: "CouchDB-shaped JSON\n(documents are\nE2EE ciphertext)", back: true },
      { from: "L", to: "TC", text: "encrypted reply via DERP", back: true },
      { from: "TC", to: "LS", text: "Response", back: true },
    ],
  });
}

function archServer() {
  return sequence({
    participants: [
      { id: "LS", label: "LiveSync\n(phone)", col: C.lilac },
      { id: "TC", label: "tcsync", col: C.blue },
      { id: "GO", label: "Go WASM bridge\n(tailcat client)", col: C.blue },
      { id: "DERP", label: "DERP relay", col: C.yellow },
      { id: "SV", label: "tailcat serve\n(your computer)", col: C.green },
      { id: "DB", label: "CouchDB", col: C.peach },
    ],
    steps: [
      { from: "LS", to: "TC", text: "fetch(couch.tailcat:5984\n/obsidian/_changes…)" },
      { note: "hostname matches → route it\n(other URLs pass through untouched)", over: ["TC"] },
      { from: "TC", to: "GO", text: "tcsyncFetch({method,\nurl, headers, body})" },
      { from: "GO", to: "DERP", text: "WireGuard-encrypted TCP\nover a WebSocket" },
      { from: "DERP", to: "SV", text: "forwards ciphertext\n(can't read it)" },
      { note: "device key on the allowlist?\nno → dropped silently", over: ["SV"] },
      { from: "SV", to: "DB", text: "HTTP to 127.0.0.1:5984\n(Basic auth\nfrom LiveSync)" },
      { from: "DB", to: "SV", text: "JSON (documents are\nE2EE ciphertext)", back: true },
      { from: "SV", to: "DERP", text: "encrypted reply", back: true },
      { from: "DERP", to: "GO", text: "encrypted reply", back: true },
      { from: "GO", to: "TC", text: "{status, headers, body}", back: true },
      { from: "TC", to: "LS", text: "Response", back: true },
    ],
  });
}

// ---------- render ----------
const FONTS = ["Kalam-Regular", "Kalam-Bold"];

async function fonts() {
  mkdirSync(cache, { recursive: true });
  for (const f of FONTS) {
    const p = join(cache, `${f}.ttf`);
    if (existsSync(p)) continue;
    const r = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/kalam/${f}.ttf`);
    if (!r.ok) throw new Error(`font download failed: ${r.status}`);
    writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
}

function chrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const c = candidates.find((p) => existsSync(p));
  if (!c) throw new Error("Chrome/Chromium not found; set CHROME=/path/to/chrome");
  return c;
}

function render(name, board) {
  const html = join(cache, `${name}.html`);
  const face = (f, w) => `@font-face{font-family:Kalam;font-weight:${w};src:url("file://${join(cache, f)}.ttf")}`;
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${face("Kalam-Regular", 400)}${face("Kalam-Bold", 700)}html,body{margin:0;background:#fff}svg{display:block}</style>${board.svg()}`);
  const png = join(out, `${name}.png`);
  execFileSync(chrome(), [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    "--allow-file-access-from-files", "--virtual-time-budget=3000",
    `--window-size=${board.w},${board.h}`, `--screenshot=${png}`, `file://${html}`,
  ], { stdio: "ignore" });
  console.log("wrote", png);
}

await fonts();
mkdirSync(out, { recursive: true });
render("overview", overview());
render("how-it-works", howItWorks());
render("architecture-hub", archHub());
render("architecture-own-server", archServer());
