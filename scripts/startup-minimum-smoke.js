#!/usr/bin/env node
"use strict";

// 217-A: the startup screen's minimum duration. The main process defaulted
// to 4200 ms and the renderer to 2000 ms. loadSettings() copies the main
// process's settings into renderer storage, so a new install held the startup
// screen for at least 4.2 s on every launch after the first, although the app
// is ready in about 1 s.
//   M1 one default: the service and the renderer both use 900 ms
//   M2 a saved 4200 or 2000 (an old default) reads back as 900; only that
//      field changes on disk, and a later read does not rewrite the file
//   M3 a value the user chose (0, 1500, 3000, 15000) is kept, file untouched
//   M4 an old default display name and an old startup minimum migrate in one
//      atomic write
//   M5 the renderer reads an old default as 900 before the main-process
//      migration has run, and keeps any other value
//   M6 the startup steps scale with the minimum, so a short splash still shows
//      every step before it ends
//   M7 a locked app (owner sign-in next) leaves the startup screen at its
//      minimum instead of waiting for readings that cannot arrive; an unlocked
//      app still waits for its first readings
// Run: node scripts/startup-minimum-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "startup-minimum-"));
process.env.ANXHUB_CONFIG_DIR = temp;
const service = require("../src/services/settingsPreferenceService");
const file = path.join(temp, "preferences.json");
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const results = [];
function check(label, fn) {
  try { fn(); results.push(`PASS ${label}`); } catch (error) { results.push(`FAIL ${label}\n  ${error.stack || error}`); }
}
const record = (settings) => ({ schemaVersion: 1, settings: { "appearance.theme": "light", "a.key.this.build.does.not.know": { kept: true }, ...settings }, updatedAt: "2026-11-27T10:00:00.000Z" });

function rendererConstant(name) {
  const match = new RegExp(`^const ${name} = ([^;]+);`, "m").exec(appSource);
  assert.ok(match, `app.js declares ${name}`);
  return vm.runInNewContext(match[1]);
}

function rendererFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js declares ${name}`);
  let depth = 0;
  for (let index = appSource.indexOf(") {", start) + 2; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] === "}") { depth -= 1; if (depth === 0) return appSource.slice(start, index + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

try {
  check("M1 one default (900 ms) in the service and the renderer", () => {
    assert.strictEqual(service.defaultSettings()["startup.minimumDurationMs"], 900);
    assert.strictEqual(rendererConstant("STARTUP_MINIMUM_MS"), 900);
  });

  check("M2 a saved old default (4200, 2000) migrates; nothing else changes", () => {
    for (const old of [4200, 2000]) {
      fs.writeFileSync(file, JSON.stringify(record({ "startup.minimumDurationMs": old }), null, 2));
      assert.strictEqual(service.readPreferences().settings["startup.minimumDurationMs"], 900, `${old} reads as 900`);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), record({ "startup.minimumDurationMs": 900 }), "only that field changed");
      const bytes = fs.readFileSync(file, "utf8");
      service.readPreferences();
      assert.strictEqual(fs.readFileSync(file, "utf8"), bytes, "a later read does not rewrite");
    }
  });

  check("M3 a value the user chose is kept and the file is not touched", () => {
    for (const own of [0, 1500, 3000, 15000]) {
      const bytes = JSON.stringify(record({ "startup.minimumDurationMs": own }), null, 2);
      fs.writeFileSync(file, bytes);
      assert.strictEqual(service.readPreferences().settings["startup.minimumDurationMs"], own);
      assert.strictEqual(fs.readFileSync(file, "utf8"), bytes);
    }
  });

  check("M4 display name and startup minimum migrate in one write", () => {
    fs.writeFileSync(file, JSON.stringify(record({ "app.displayName": "AnxOS Control Center", "startup.minimumDurationMs": 4200 }), null, 2));
    const settings = service.readPreferences().settings;
    assert.strictEqual(settings["app.displayName"], "AnxHost Control Center");
    assert.strictEqual(settings["startup.minimumDurationMs"], 900);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), record({ "app.displayName": "AnxHost Control Center", "startup.minimumDurationMs": 900 }));
    assert.deepStrictEqual(fs.readdirSync(temp).filter((name) => name.endsWith(".tmp")), [], "no temporary file left");
  });

  check("M5 the renderer reads an old default as 900 and keeps other values", () => {
    const sandbox = { stored: {}, STARTUP_MINIMUM_MS: rendererConstant("STARTUP_MINIMUM_MS"), LEGACY_STARTUP_MINIMUM_DEFAULTS_MS: rendererConstant("LEGACY_STARTUP_MINIMUM_DEFAULTS_MS") };
    vm.runInNewContext(`${rendererFunction("normalizeNumber")}\n${rendererFunction("getStartupMinimumMs")}\nfunction readStoredSettings() { return stored; }\nthis.get = getStartupMinimumMs;`, sandbox);
    for (const [stored, expected] of [[2000, 900], [4200, 900], [undefined, 900], [0, 0], [3000, 3000], [99999, 15000]]) {
      sandbox.stored = { "startup.minimumDurationMs": stored };
      assert.strictEqual(sandbox.get(), expected, `stored ${stored}`);
    }
  });

  check("M7 a locked app leaves the startup screen at its minimum; an unlocked one waits for readings", () => {
    const sandbox = { revealed: 0, locked: true, securityStatusLoaded: false, startupState: null, window: { setTimeout: () => 0 }, Date: { now: () => 10_000 } };
    vm.runInNewContext(`${rendererFunction("tryCompleteStartup")}\nfunction getStartupMinimumMs() { return 900; }\nfunction revealAppShell() { revealed += 1; startupState.finished = true; }\nfunction isAppLockedForBackgroundWork() { return locked; }\nthis.run = tryCompleteStartup;`, sandbox);
    const reset = (overrides) => { sandbox.revealed = 0; sandbox.startupState = { finished: false, systemReady: false, sequenceReady: true, startedAt: 0, ...overrides }; };
    reset();
    sandbox.securityStatusLoaded = true;
    sandbox.locked = true;
    sandbox.run();
    assert.strictEqual(sandbox.revealed, 1, "locked, status known, minimum passed, no readings: revealed");
    reset();
    sandbox.securityStatusLoaded = false;
    sandbox.run();
    assert.strictEqual(sandbox.revealed, 0, "status not known yet: still waiting");
    reset();
    sandbox.securityStatusLoaded = true;
    sandbox.locked = false;
    sandbox.run();
    assert.strictEqual(sandbox.revealed, 0, "unlocked: waits for the first readings");
    reset({ systemReady: true });
    sandbox.run();
    assert.strictEqual(sandbox.revealed, 1, "unlocked with readings: revealed");
    reset({ sequenceReady: false });
    sandbox.locked = true;
    sandbox.run();
    assert.strictEqual(sandbox.revealed, 0, "never before the minimum's sequence has run");
    assert.ok(/markSecurityStatusLoaded\(\);\n  \} catch/.test(appSource) && /function markSecurityStatusLoaded\(\) \{\n  securityStatusLoaded = true;\n  if \(!startupState\.finished\) tryCompleteStartup\(\);/.test(appSource), "the security status answer re-checks the startup screen");
  });

  check("M6 the startup steps scale with the minimum", () => {
    const body = rendererFunction("runStartupSequence");
    assert.ok(!/\}, (450|950|1450)\);/.test(body), "no fixed step times");
    for (const factor of ["0.225", "0.475", "0.725"]) assert.ok(body.includes(`minimumMs * ${factor}`), `step at ${factor} of the minimum`);
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) { process.exitCode = 1; console.log(`startup-minimum-smoke: ${failed} failed`); } else console.log(`startup-minimum-smoke passed (${results.length} checks)`);
