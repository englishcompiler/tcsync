import { zipSync } from "fflate";

/** The vault files tcsync needs (paths relative to the vault root). */
export interface BackupFs {
  list(): Promise<string[]>;
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export type BackupResult = { path: string } | { skipped: "empty" } | { skipped: "too-large"; bytes: number };

const PREFIX = "tcsync-backup-";
/** Above this the backup is skipped (a phone can't hold a copy of a huge vault in memory). */
export const BACKUP_MAX_BYTES = 300 * 1024 * 1024;
const pad = (n: number) => String(n).padStart(2, "0");
/** Dot-folders (.obsidian or another config dir, .trash, .git…) and earlier backups are left out. */
const included = (p: string) => !p.split("/").some((seg) => seg.startsWith(".")) && !p.startsWith(PREFIX);

/**
 * Zips the vault's notes and attachments to `tcsync-backup-YYYYMMDD-HHmmss.zip` in the vault root
 * before a device first syncs, keeping the newest `keep`. Stored, not compressed: cheap on phones.
 */
export async function backupNotes(fs: BackupFs, now: Date, o: { keep?: number; maxBytes?: number } = {}): Promise<BackupResult> {
  const keep = o.keep ?? 3, maxBytes = o.maxBytes ?? BACKUP_MAX_BYTES;
  const all = await fs.list();
  const notes = all.filter(included);
  if (notes.length === 0) return { skipped: "empty" };
  let bytes = 0;
  for (const p of notes) bytes += await fs.size(p);
  if (bytes > maxBytes) return { skipped: "too-large", bytes };
  const entries: Record<string, Uint8Array> = {};
  for (const p of notes) entries[p] = await fs.read(p);
  const name = `${PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
  await fs.write(name, zipSync(entries, { level: 0 }));
  const backups = [...new Set([...all.filter((p) => /^tcsync-backup-\d{8}-\d{6}\.zip$/.test(p)), name])].sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) await fs.remove(old);
  return { path: name };
}
