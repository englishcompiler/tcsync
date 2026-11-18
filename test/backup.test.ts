import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { backupNotes, type BackupFs } from "../src/backup";

function memFs(files: Record<string, string>) {
  const m = new Map<string, Uint8Array>(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const fs: BackupFs & { m: typeof m } = {
    m,
    list: async () => [...m.keys()],
    read: async (p) => m.get(p)!,
    size: async (p) => m.get(p)!.length,
    write: async (p, d) => { m.set(p, d); },
    remove: async (p) => { m.delete(p); },
  };
  return fs;
}
const at = (s: string) => new Date(s);

describe("backupNotes", () => {
  it("zips notes and attachments but not .obsidian/ or earlier backups", async () => {
    const fs = memFs({ "a.md": "A", "img/p.png": "PNG", ".obsidian/plugins/tcsync/data.json": "{}", "tcsync-backup-20260101-000000.zip": "old" });
    const r = await backupNotes(fs, at("2026-11-18T10:44:03"));
    const z = unzipSync(fs.m.get((r as { path: string }).path)!);
    expect(Object.keys(z).sort()).toEqual(["a.md", "img/p.png"]);
    expect(strFromU8(z["a.md"])).toBe("A");
  });
  it("names it tcsync-backup-20261118-104403.zip (local time)", async () => {
    const fs = memFs({ "a.md": "A" });
    expect(await backupNotes(fs, at("2026-11-18T10:44:03"))).toEqual({ path: "tcsync-backup-20261118-104403.zip" });
  });
  it("keeps only the 3 newest backups", async () => {
    const fs = memFs({ "a.md": "A" });
    for (const t of ["2026-11-18T10:00:01", "2026-11-18T10:00:02", "2026-11-18T10:00:03", "2026-11-18T10:00:04"]) await backupNotes(fs, at(t), { keep: 3 });
    expect([...fs.m.keys()].filter((k) => k.startsWith("tcsync-backup-")).sort()).toEqual([
      "tcsync-backup-20261118-100002.zip", "tcsync-backup-20261118-100003.zip", "tcsync-backup-20261118-100004.zip"]);
  });
  it("reports an empty vault", async () => {
    expect(await backupNotes(memFs({ ".obsidian/app.json": "{}" }), at("2026-11-18T10:00:00"))).toEqual({ skipped: "empty" });
  });
  it("skips every dot-folder (.trash, .git, a custom config dir)", async () => {
    const fs = memFs({ "a.md": "A", ".trash/old.md": "x", ".git/HEAD": "x", "sub/.hidden/y.md": "y", ".cfg/plugins/x.json": "{}" });
    const r = (await backupNotes(fs, at("2026-11-18T10:00:00"))) as { path: string };
    expect(Object.keys(unzipSync(fs.m.get(r.path)!))).toEqual(["a.md"]);
  });
  it("skips the backup (without reading files) when the vault is larger than the cap", async () => {
    const fs = memFs({ "a.md": "12345", "b.md": "67890" });
    let reads = 0;
    const read = fs.read;
    fs.read = async (p) => { reads++; return read(p); };
    fs.size = async () => 5;
    expect(await backupNotes(fs, at("2026-11-18T10:00:00"), { maxBytes: 8 })).toEqual({ skipped: "too-large", bytes: 10 });
    expect(reads).toBe(0);
  });
});
