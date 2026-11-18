import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { backupNotes, type BackupFs } from "../src/backup";

function memFs(files: Record<string, string>) {
  const m = new Map(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const fs: BackupFs & { m: typeof m } = {
    m,
    list: async () => [...m.keys()],
    read: async (p) => m.get(p)!,
    write: async (p, d) => { m.set(p, d); },
    remove: async (p) => { m.delete(p); },
  };
  return fs;
}
const at = (s: string) => new Date(s);

describe("backupNotes", () => {
  it("zips notes and attachments but not .obsidian/ or earlier backups", async () => {
    const fs = memFs({ "a.md": "A", "img/p.png": "PNG", ".obsidian/plugins/tcsync/data.json": "{}", "tcsync-backup-20260101-000000.zip": "old" });
    const p = await backupNotes(fs, at("2026-11-18T10:44:03"));
    const z = unzipSync(fs.m.get(p!)!);
    expect(Object.keys(z).sort()).toEqual(["a.md", "img/p.png"]);
    expect(strFromU8(z["a.md"])).toBe("A");
  });
  it("names it tcsync-backup-20261118-104403.zip (local time)", async () => {
    const fs = memFs({ "a.md": "A" });
    expect(await backupNotes(fs, at("2026-11-18T10:44:03"))).toBe("tcsync-backup-20261118-104403.zip");
  });
  it("keeps only the 3 newest backups", async () => {
    const fs = memFs({ "a.md": "A" });
    for (const t of ["2026-11-18T10:00:01", "2026-11-18T10:00:02", "2026-11-18T10:00:03", "2026-11-18T10:00:04"]) await backupNotes(fs, at(t));
    expect([...fs.m.keys()].filter((k) => k.startsWith("tcsync-backup-")).sort()).toEqual([
      "tcsync-backup-20261118-100002.zip", "tcsync-backup-20261118-100003.zip", "tcsync-backup-20261118-100004.zip"]);
  });
  it("returns null for an empty vault", async () => {
    expect(await backupNotes(memFs({ ".obsidian/app.json": "{}" }), at("2026-11-18T10:00:00"))).toBeNull();
  });
});
