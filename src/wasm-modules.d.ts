declare module "tcsync:wasm" {
  const b64: string;
  export default b64;
}
declare module "../bridge/dist/wasm_exec.js";

declare module "pouchdb-adapter-idb";
declare module "pouchdb-mapreduce";
declare module "pouchdb-adapter-memory";
