#!/usr/bin/env node
// Generates a Self-hosted LiveSync setup URI for a CouchDB remote with
// end-to-end encryption. Adapted from Self-hosted LiveSync's
// utils/setup/generate_setup_uri.ts (MIT, © vorotamoroz), CouchDB branch only,
// ported from Deno to Node.
//
// Inputs (environment variables):
//   LIVESYNC_HOST        CouchDB URI as LiveSync should use it (e.g. http://couch.tailcat:5984)
//   LIVESYNC_USER        CouchDB user
//   LIVESYNC_PASS        CouchDB password
//   LIVESYNC_DB          database name
//   LIVESYNC_PASSPHRASE  end-to-end encryption passphrase
//   id_recovery_code     optional sls-id-v1:… code; reuse it for every URI of the same vault
//   uri_passphrase       optional passphrase protecting the URI (random if empty)
//   uri_mode             ephemeral (default, time-limited) or persistent
import {
  encodeTimeBoundSetupURI,
  isTimeBoundSetupURIUsableNow,
} from "@vrtmrz/livesync-commonlib/setup-uri";
import { createNewVaultSettings, PREFERRED_SETTING_SELF_HOSTED } from "@vrtmrz/livesync-commonlib/settings";
import { upsertRemoteConfigurationInPlace } from "@vrtmrz/livesync-commonlib/remote-configurations";
import { pathToFileURL } from "node:url";

const ID_RECOVERY_CODE_PREFIX = "sls-id-v1:";
const ID_RECOVERY_CODE_PATTERN = /^sls-id-v1:([0-9a-f]{64})$/u;

export function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString("base64url");
}

function requireValue(env, name) {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function configureIdDerivation(settings, env) {
  const supplied = env.id_recovery_code?.trim();
  const key = supplied
    ? ID_RECOVERY_CODE_PATTERN.exec(supplied)?.[1]
    : Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  if (!key) throw new Error("id_recovery_code must be a valid sls-id-v1 recovery code");
  Object.assign(settings, { idDerivationVersion: 1, idDerivationKey: key });
  return `${ID_RECOVERY_CODE_PREFIX}${key}`;
}

export function createCouchDBSettings(env) {
  const settings = createNewVaultSettings();
  Object.assign(settings, PREFERRED_SETTING_SELF_HOSTED, {
    couchDB_URI: requireValue(env, "LIVESYNC_HOST"),
    couchDB_USER: requireValue(env, "LIVESYNC_USER"),
    couchDB_PASSWORD: requireValue(env, "LIVESYNC_PASS"),
    couchDB_DBNAME: requireValue(env, "LIVESYNC_DB"),
    batchSave: true,
    periodicReplication: true,
    syncOnStart: true,
    syncOnFileOpen: true,
    syncAfterMerge: true,
    isConfigured: true,
    encrypt: true,
    passphrase: requireValue(env, "LIVESYNC_PASSPHRASE"),
    usePathObfuscation: true,
  });
  upsertRemoteConfigurationInPlace(settings, "couchdb", { activate: true });
  return settings;
}

export async function generateSetupURI(env) {
  const mode = (env.uri_mode?.trim().toLowerCase() || "ephemeral");
  if (mode !== "ephemeral" && mode !== "persistent") throw new Error("uri_mode must be ephemeral or persistent");
  const setupPassphrase = env.uri_passphrase?.trim() || generateSecret();
  const settings = createCouchDBSettings(env);
  const idRecoveryCode = configureIdDerivation(settings, env);
  const { uri, usableUntil } = await encodeTimeBoundSetupURI(settings, setupPassphrase, {
    mode,
    removeProperties: ["pluginSyncExtendedSetting", "doNotUseFixedRevisionForChunks"],
    skipDefaultValue: true,
  });
  if (!isTimeBoundSetupURIUsableNow(usableUntil)) throw new Error("Setup URI time window changed during generation");
  return { setupURI: uri.trim(), setupPassphrase, mode, usableUntil, idRecoveryCode };
}

async function main() {
  const g = await generateSetupURI(process.env);
  console.log(g.mode === "persistent" ? "Persistent setup URI (no expiry)." : `Ephemeral setup URI, usable until ${new Date(g.usableUntil).toISOString()} (UTC).`);
  console.log(`Setup URI passphrase: ${g.setupPassphrase}`);
  console.log(`ID recovery code: ${g.idRecoveryCode}`);
  console.log(g.setupURI);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
