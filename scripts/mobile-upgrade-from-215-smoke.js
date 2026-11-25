#!/usr/bin/env node
"use strict";

// Build 216-C finish line: a phone paired on Build 215 stays paired and works
// after the upgrade. scripts/fixtures/mobile-devices-build215.json was written
// by Build 215's own src/mobile/sessions.js (13825d70): a real pairing, its
// devices.json, session secret, session token and CSRF value. The current
// session store must accept all of it unchanged.
//
// U1 the Build 215 device is listed with its name and role
// U2 its session token still authenticates (no new pairing needed)
// U3 its CSRF value still passes, so it can still act (start, stop)
// U4 the stored files are not rewritten into a different shape on first use

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSessionStore } = require("../src/mobile/sessions");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "mobile-devices-build215.json"), "utf8"));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "anx-216c-phone-"));
const results = [];
function check(id, title, fn) {
  try {
    fn();
    results.push(true);
    console.log(`PASS ${id} ${title}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${id} ${title}: ${error.message}`);
  }
}

try {
  fs.writeFileSync(path.join(folder, "devices.json"), fixture.devicesJson);
  fs.writeFileSync(path.join(folder, "session-secret"), fixture.sessionSecret);
  // An hour after the 215 pairing, well inside the session limits.
  const store = createSessionStore({ folder, now: () => fixture.pairedAt + 60 * 60 * 1000 });

  check("U1", "the Build 215 phone is still listed", () => {
    const device = store.listDevices().find((entry) => entry.id === fixture.deviceId);
    assert(device, "device missing");
    assert.strictEqual(device.role, fixture.role);
    assert.strictEqual(device.name, "QA phone (Build 215)");
  });

  let auth = null;
  check("U2", "its session token still authenticates", () => {
    auth = store.authenticate(fixture.token, { address: "192.168.50.20" });
    assert(auth && auth.id === fixture.deviceId, "token refused");
  });

  check("U3", "its CSRF value still passes", () => {
    assert(auth, "no session");
    assert.strictEqual(store.checkCsrf(auth.tokenHash, fixture.csrf), true);
  });

  check("U4", "the stored record keeps the Build 215 shape", () => {
    const saved = JSON.parse(fs.readFileSync(path.join(folder, "devices.json"), "utf8"));
    const original = JSON.parse(fixture.devicesJson);
    assert.strictEqual(saved.version, original.version);
    assert.deepStrictEqual(Object.keys(saved.devices[0]).sort(), Object.keys(original.devices[0]).sort());
    assert.strictEqual(fs.readFileSync(path.join(folder, "session-secret"), "utf8"), fixture.sessionSecret);
  });
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`mobile-upgrade-from-215-smoke: ${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
