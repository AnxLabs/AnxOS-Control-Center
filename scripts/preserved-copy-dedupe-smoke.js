#!/usr/bin/env node
// Phase 9: an unreadable encrypted store is preserved once per distinct
// contents, not once per failed read (one PC had 646 copies of 3 contents).
//   K1 repeated failures with the same bytes reuse the first copy
//   K2 different bytes get their own copy and every distinct copy is kept
//   K3 "undecryptable" and "corrupt" copies are tracked separately; a
//      same-millisecond name clash gets a numbered name instead of failing
//   K4 the real store path: an undecryptable account session read many times
//      through accountAuthService/SecureSessionStore leaves exactly one copy
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const { listPreservedCopies, preserveUnreadableFile } = require("../src/shared/preserveUnreadableFile");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anx-preserved-copy-"));
  try {
    // K1
    const store = path.join(temp, "session.dat");
    fs.writeFileSync(store, "unreadable-A");
    let clock = 1000;
    const now = () => clock++;
    const first = preserveUnreadableFile(store, { now });
    assert.strictEqual(first.created, true);
    for (let i = 0; i < 25; i += 1) {
      const again = preserveUnreadableFile(store, { now });
      assert.deepStrictEqual(again, { path: first.path, created: false });
    }
    assert.strictEqual(listPreservedCopies(store).length, 1);
    console.log("PASS K1 25 more failures with the same bytes reuse the first copy");

    // K2
    fs.writeFileSync(store, "unreadable-B");
    const second = preserveUnreadableFile(store, { now });
    assert.strictEqual(second.created, true);
    fs.writeFileSync(store, "unreadable-A");
    assert.deepStrictEqual(preserveUnreadableFile(store, { now }), { path: first.path, created: false }, "older identical contents are found too");
    const copies = listPreservedCopies(store);
    assert.deepStrictEqual(copies.map((copy) => fs.readFileSync(copy.path, "utf8")), ["unreadable-B", "unreadable-A"], "newest first, both distinct copies kept");
    console.log("PASS K2 each distinct content gets one copy and all are kept");

    // K3
    const corrupt = preserveUnreadableFile(store, { kind: "corrupt", now });
    assert.strictEqual(corrupt.created, true);
    assert.match(path.basename(corrupt.path), /^session\.dat\.corrupt-\d+\.backup$/);
    assert.strictEqual(listPreservedCopies(store, "undecryptable").length, 2);
    assert.strictEqual(listPreservedCopies(store, "corrupt").length, 1);
    assert.throws(() => preserveUnreadableFile(store, { kind: "other" }), /Unknown preserved-copy kind/);
    const clash = path.join(temp, "clash.json");
    fs.writeFileSync(clash, "one");
    const fixed = () => 5000;
    const a = preserveUnreadableFile(clash, { now: fixed });
    fs.writeFileSync(clash, "two");
    const b = preserveUnreadableFile(clash, { now: fixed });
    assert.notStrictEqual(a.path, b.path);
    assert.match(path.basename(b.path), /^clash\.json\.undecryptable-5000-1\.backup$/);
    assert.strictEqual(fs.readFileSync(a.path, "utf8"), "one", "an existing copy is never overwritten");
    assert.ok(!listPreservedCopies(path.join(temp, "session")).length, "a store's name prefix does not match another store's copies");
    console.log("PASS K3 kinds are separate; a same-millisecond clash gets a numbered name");

    // K4
    const configDir = path.join(temp, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account.json"), JSON.stringify({
      schemaVersion: 1,
      method: "aes-256-gcm",
      iv: Buffer.alloc(12).toString("base64"),
      tag: Buffer.alloc(16).toString("base64"),
      data: Buffer.from("unreadable-session").toString("base64"),
    }));
    process.env.ANXHUB_CONFIG_DIR = configDir;
    process.env.ANXOS_SUPABASE_URL = "https://projectref.supabase.co";
    process.env.ANXOS_SUPABASE_ANON_KEY = "anon-key";
    for (let i = 0; i < 12; i += 1) {
      for (const file of ["accountAuthService.js", "secureSessionStore.js"]) delete require.cache[require.resolve(path.join(root, "src", "services", file))];
      const service = require("../src/services/accountAuthService");
      const status = await service.restoreSession();
      assert.strictEqual(status.state, "locked_recoverable");
    }
    const preserved = fs.readdirSync(configDir).filter((name) => name.includes(".undecryptable-") && name.endsWith(".backup"));
    assert.strictEqual(preserved.length, 1, `12 restarts with the same unreadable session leave one copy (found ${preserved.length})`);
    console.log("PASS K4 12 app starts with one unreadable session leave exactly one preserved copy");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("Preserved copy dedupe smoke: 4 checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
