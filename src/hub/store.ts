import { PouchDB, type Database } from "./pouch";

/**
 * The hub's databases. CouchDB distinguishes "database exists" from "database is empty", PouchDB
 * doesn't (opening creates), so existing names are kept in a registry doc in `<prefix>meta`.
 */
export interface HubStore {
  open(db: string): Database;
  exists(db: string): Promise<boolean>;
  /** Returns false if it already existed. */
  create(db: string): Promise<boolean>;
  /** Returns false if it didn't exist. */
  destroy(db: string): Promise<boolean>;
  /** True when no database holds any document. */
  isEmpty(): Promise<boolean>;
}

const REGISTRY = "dbs";

/**
 * IndexedDB is shared by every vault in the app, so the hub's databases are namespaced by the
 * vault's app id (as LiveSync does for its own).
 */
export function hubStorePrefix(appId: string): string {
  return `tcsync-hub-${appId}-`;
}

export function createStore(adapter: "idb" | "memory", prefix = "tcsync-hub-"): HubStore {
  const meta = new PouchDB(`${prefix}meta`, { adapter });
  const open = new Map<string, Database>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f, f);
    chain = p.catch(() => undefined);
    return p;
  };

  async function names(): Promise<{ names: string[]; _rev?: string }> {
    try {
      return (await meta.get(REGISTRY)) as unknown as { names: string[]; _rev?: string };
    } catch (e) {
      // Only "no registry yet" means empty; anything else (IndexedDB trouble) must not look empty.
      if ((e as { status?: number }).status === 404) return { names: [] };
      throw e;
    }
  }
  async function setNames(n: string[]): Promise<void> {
    const cur = await names();
    await meta.put({ _id: REGISTRY, _rev: cur._rev, names: n } as never);
  }
  const db = (name: string): Database => {
    let d = open.get(name);
    if (!d) {
      d = new PouchDB(`${prefix}${name}`, { adapter }) as Database;
      open.set(name, d);
    }
    return d;
  };

  return {
    open: db,
    exists: async (name) => (await names()).names.includes(name),
    create: (name) => serial(async () => {
      const n = (await names()).names;
      if (n.includes(name)) return false;
      db(name);
      await setNames([...n, name]);
      return true;
    }),
    destroy: (name) => serial(async () => {
      const n = (await names()).names;
      if (!n.includes(name)) return false;
      await db(name).destroy();
      open.delete(name);
      await setNames(n.filter((x) => x !== name));
      return true;
    }),
    isEmpty: async () => {
      for (const name of (await names()).names) {
        if ((await db(name).info()).doc_count > 0) return false;
      }
      return true;
    },
  };
}
