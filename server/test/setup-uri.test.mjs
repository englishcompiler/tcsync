import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSettingsFromSetupURI } from "@vrtmrz/livesync-commonlib/setup-uri";
import { generateSetupURI } from "../setup-uri.mjs";

const env = {
  LIVESYNC_HOST: "http://couch.tailcat:5984",
  LIVESYNC_USER: "tcsync",
  LIVESYNC_PASS: "pw-123",
  LIVESYNC_DB: "obsidian",
  LIVESYNC_PASSPHRASE: "e2ee-secret",
  uri_passphrase: "setup-pass",
  uri_mode: "persistent",
};

test("round-trips CouchDB settings with E2EE on", async () => {
  const g = await generateSetupURI(env);
  assert.match(g.setupURI, /^obsidian:\/\/setuplivesync\?settings=/);
  const s = await decodeSettingsFromSetupURI(g.setupURI, "setup-pass");
  assert.equal(s.couchDB_URI, "http://couch.tailcat:5984");
  assert.equal(s.couchDB_USER, "tcsync");
  assert.equal(s.couchDB_DBNAME, "obsidian");
  assert.equal(s.encrypt, true);
  assert.equal(s.usePathObfuscation, true);
  assert.equal(s.passphrase, "e2ee-secret");
});

test("reuses a supplied id recovery code", async () => {
  const code = "sls-id-v1:" + "ab".repeat(32);
  const g = await generateSetupURI({ ...env, id_recovery_code: code });
  assert.equal(g.idRecoveryCode, code);
});

test("a wrong setup passphrase does not decode", async () => {
  const g = await generateSetupURI(env);
  await assert.rejects(async () => {
    const s = await decodeSettingsFromSetupURI(g.setupURI, "wrong");
    if (!s || !s.couchDB_URI) throw new Error("not decoded");
  });
});

test("missing required values are reported by name", async () => {
  const { LIVESYNC_PASS: _omit, ...rest } = env;
  await assert.rejects(generateSetupURI(rest), /LIVESYNC_PASS/);
});
