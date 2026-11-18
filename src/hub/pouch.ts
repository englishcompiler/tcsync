import PouchDBCore from "pouchdb-core";
import idb from "pouchdb-adapter-idb";
import mapreduce from "pouchdb-mapreduce";
import find from "pouchdb-find";

/** PouchDB with the IndexedDB adapter (the hub's storage), map/reduce and Mango (_find). */
export const PouchDB = PouchDBCore.plugin(idb).plugin(mapreduce).plugin(find);
export type Database = PouchDB.Database<Record<string, unknown>>;
