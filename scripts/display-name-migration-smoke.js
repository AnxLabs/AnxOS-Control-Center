#!/usr/bin/env node
"use strict";

// 216-B1 (FROZEN_IDENTIFIERS.md): a saved app.displayName that still equals
// the old default becomes the new product name; any other name is the user's.
// RC1 acceptance on the owner's PC: after the upgrade Settings still showed
// "AnxOS Control Center" (the service's default was the old name and nothing
// migrated the saved value).
//   D1 a Build 215 record with the old default reads back as AnxHost Control
//      Center, and the file is rewritten with only that field changed (every
//      other key, known or not, is kept byte for byte in value)
//   D2 a name the user typed is kept, and the file is not touched
//   D3 a fresh install defaults to the new name
//   D4 the migration runs once: a later read does not rewrite the file

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "display-name-migration-"));
process.env.ANXHUB_CONFIG_DIR = temp;
const service = require("../src/services/settingsPreferenceService");
const file = path.join(temp, "preferences.json");
const results = [];
function check(label, fn) {
  try { fn(); results.push(`PASS ${label}`); } catch (error) { results.push(`FAIL ${label}\n  ${error.stack || error}`); }
}
const record215 = (name) => ({
  schemaVersion: 1,
  settings: { "app.displayName": name, "amp.username": "Anx", "appearance.theme": "light", "a.key.this.build.does.not.know": { kept: true } },
  updatedAt: "2026-11-20T10:00:00.000Z",
});

try {
  check("D1 the old default is migrated; only that field changes", () => {
    fs.writeFileSync(file, JSON.stringify(record215("AnxOS Control Center"), null, 2));
    const read = service.readPreferences();
    assert.strictEqual(read.settings["app.displayName"], "AnxHost Control Center");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = record215("AnxHost Control Center");
    assert.deepStrictEqual(onDisk, expected, "everything else in the file is unchanged");
  });

  check("D4 a later read does not rewrite the file", () => {
    const before = fs.statSync(file).mtimeMs;
    const bytes = fs.readFileSync(file, "utf8");
    service.readPreferences();
    assert.strictEqual(fs.readFileSync(file, "utf8"), bytes);
    assert.strictEqual(fs.statSync(file).mtimeMs, before);
  });

  check("D2 a name the user typed is kept and the file is not touched", () => {
    const own = JSON.stringify(record215("Anx's Server Room"), null, 2);
    fs.writeFileSync(file, own);
    assert.strictEqual(service.readPreferences().settings["app.displayName"], "Anx's Server Room");
    assert.strictEqual(fs.readFileSync(file, "utf8"), own);
  });

  check("D3 a fresh install defaults to the new name", () => {
    fs.rmSync(file, { force: true });
    assert.strictEqual(service.readPreferences().settings["app.displayName"], "AnxHost Control Center");
    assert.strictEqual(service.SETTING_DEFINITIONS["app.displayName"].default, "AnxHost Control Center");
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) {
  console.log(`display-name-migration-smoke: ${failed} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`display-name-migration-smoke passed (${results.length} checks)`);
