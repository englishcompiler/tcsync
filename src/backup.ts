import { zipSync } from "fflate";

/** The vault files tcsync needs (paths relative to the vault root). */
export interface BackupFs {
  list(): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

const PREFIX = "tcsync-backup-";
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Zips the vault's notes and attachments (not `.obsidian/`, not earlier backups) to
 * `tcsync-backup-YYYYMMDD-HHmmss.zip` in the vault root before a device first syncs, keeping the
 * newest `keep`. Returns the zip's path, or null if there was nothing to back up.
 */
export async function backupNotes(fs: BackupFs, now: Date, keep = 3): Promise<string | null> {
  const all = await fs.list();
  const notes = all.filter((p) => !p.startsWith(".obsidian/") && !p.startsWith(PREFIX));
  if (notes.length === 0) return null;
  const entries: Record<string, Uint8Array> = {};
  for (const p of notes) entries[p] = await fs.read(p);
  const name = `${PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
  await fs.write(name, zipSync(entries, { level: 6 }));
  const backups = [...all.filter((p) => /^tcsync-backup-\d{8}-\d{6}\.zip$/.test(p)), name].filter((v, i, a) => a.indexOf(v) === i).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) await fs.remove(old);
  return name;
}
