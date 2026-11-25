#!/usr/bin/env node
"use strict";

// Build 216-E: remembered Local Owner sessions follow the approved policy in
// docs/anxhost/SECURITY_REVIEW_216E.md. Each case runs the real
// securityService against a temporary config folder, with Electron's
// safeStorage replaced by a reversible fake and an app "restart" simulated by
// reloading every module under src/.
//
// P1  restore without a prompt after a restart
// P2  restore without a prompt after an upgrade (Build 215-format stores)
// P3  the remembered token changes on every restore; the previous one is refused
// P4  a failed rotation write fails closed
// P5  logout requires the password
// P6  manual lock requires the password now, and the next launch restores
// P7  revoke (this session, log out everywhere) requires the password
// P8  absolute expiry requires the password
// P9  idle timeout locks; below the limit, or with idle lock off, it does not
// P10 remembered-session inactivity expiry requires the password
// P11 device ID mismatch requires the password
// P12 a removed device requires the password
// P13 opting out of "Trust this device" removes the remembered session and stops new ones
// P14 no secure storage: nothing is remembered, and a fallback-encrypted
//     session from an older build is refused and deleted
// P15 without a Local Owner session, protected actions stay refused

const assert = require("assert");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.ANXOS_FORCE_PRODUCTION = "1";

const SRC = path.join(path.resolve(__dirname, ".."), "src") + path.sep;
const fakeSafeStorage = {
  available: true,
  failEncrypt: false,
  isEncryptionAvailable() { return this.available; },
  encryptString(text) {
    if (this.failEncrypt) throw new Error("simulated secure storage write failure");
    return Buffer.from(`SAFE:${Buffer.from(String(text), "utf8").toString("base64")}`, "utf8");
  },
  decryptString(buffer) {
    const text = Buffer.from(buffer).toString("utf8");
    if (!text.startsWith("SAFE:")) throw new Error("not protected by the fake safe storage");
    return Buffer.from(text.slice(5), "base64").toString("utf8");
  },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: undefined, safeStorage: fakeSafeStorage } };

const PASSWORD = `Smoke-${crypto.randomBytes(8).toString("hex")}-Zz9!`;
let root = null;

function restart() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) delete require.cache[key];
  }
  return require("../src/services/securityService");
}

function configPath(name) { return path.join(root, name); }
function readState() { return JSON.parse(fs.readFileSync(configPath("security.json"), "utf8")); }
function writeState(state) { fs.writeFileSync(configPath("security.json"), `${JSON.stringify(state, null, 2)}\n`); }
function sessionFileExists() { return fs.existsSync(configPath("session.dat")); }

async function freshOwner({ staySignedIn = true } = {}) {
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-secure-session-"));
  process.env.ANXHUB_CONFIG_DIR = root;
  fakeSafeStorage.available = true;
  fakeSafeStorage.failEncrypt = false;
  const security = restart();
  await security.setupAdmin({ username: "owner", password: PASSWORD, passwordConfirm: PASSWORD });
  security.logout();
  await security.login({ username: "owner", password: PASSWORD, staySignedIn });
  return security;
}

function unlocked(security) { return security.getStatus().localOwnerAuthenticated === true; }

const results = [];
async function check(id, title, fn) {
  try {
    await fn();
    results.push({ id, ok: true });
    console.log(`PASS ${id} ${title}`);
  } catch (error) {
    results.push({ id, ok: false });
    console.log(`FAIL ${id} ${title}: ${error.message}`);
  }
}

async function main() {
  await check("P1", "restore without a prompt after a restart", async () => {
    await freshOwner();
    assert(sessionFileExists(), "a trusted sign-in must remember the session");
    assert(unlocked(restart()), "the restarted app must restore the session without a password");
  });

  await check("P2", "restore without a prompt after an upgrade from Build 215-format stores", async () => {
    let security = await freshOwner({ staySignedIn: false });
    // Build 215 wrote a bcrypt token hash and the safeStorage envelope.
    const state = readState();
    const rawToken = crypto.randomBytes(48).toString("base64url");
    const now = Date.now();
    state.persistentSessions = [{
      id: crypto.randomUUID(),
      userId: state.users[0].id,
      tokenHash: bcrypt.hashSync(rawToken, 12),
      passwordHashDigest: crypto.createHash("sha256").update(String(state.users[0].passwordHash)).digest("base64url"),
      deviceId: security._test.getCurrentDeviceId(),
      deviceName: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 24 * 3600e3).toISOString(),
    }];
    writeState(state);
    fs.writeFileSync(configPath("session.dat"), `${JSON.stringify(security._test.encryptLocalSession({ sessionId: state.persistentSessions[0].id, token: rawToken, expiresAt: state.persistentSessions[0].expiresAt }))}\n`);
    security = restart();
    assert(unlocked(security), "a Build 215 remembered session must restore after the upgrade");
  });

  await check("P3", "the token changes on every restore and the previous token is refused", async () => {
    let security = await freshOwner();
    const first = restart()._test.readPersistentSessionFile();
    security = restart();
    assert(unlocked(security), "restore");
    const second = security._test.readPersistentSessionFile();
    assert(second?.token && second.token !== first.token, "the remembered token must change on restore");
    security = restart();
    assert(unlocked(security), "second restore");
    const third = security._test.readPersistentSessionFile();
    assert(third.token !== second.token, "the remembered token must change on every restore");
    // Put the previous token back, as a copied or stolen file would.
    security._test.writePersistentSessionFile(second);
    security = restart();
    assert(!unlocked(security), "a rotated-out token must be refused");
  });

  await check("P4", "a failed rotation write fails closed", async () => {
    await freshOwner();
    fakeSafeStorage.failEncrypt = true;
    const security = restart();
    assert(!unlocked(security), "a restore whose rotation could not be saved must not unlock");
    fakeSafeStorage.failEncrypt = false;
    assert.strictEqual(readState().persistentSessions.length, 0, "the session whose rotation failed must be removed");
    assert(!unlocked(restart()), "and must not restore later");
  });

  await check("P5", "logout requires the password", async () => {
    const security = await freshOwner();
    security.logout();
    assert(!unlocked(security), "logout");
    assert(!unlocked(restart()), "logout must survive a restart");
  });

  await check("P6", "manual lock requires the password; the next launch restores", async () => {
    const security = await freshOwner();
    security.lockLocalSession("manual");
    assert(!unlocked(security), "a manual lock must require the password in this session");
    assert(unlocked(restart()), "a trusted device restores at the next launch (policy item 6, D4)");
  });

  await check("P7", "revoke and log out everywhere require the password", async () => {
    let security = await freshOwner();
    const sessionId = security.getSecurityDashboard().sessions.find((row) => row.current && row.remembered)?.id
      || security.getSecurityDashboard().sessions.find((row) => row.remembered)?.id;
    assert(sessionId, "the remembered session is listed");
    security.revokePersistentSession(sessionId);
    assert(!unlocked(restart()), "a revoked session must not restore");
    security = await freshOwner();
    security.logoutAllSessions();
    assert(!unlocked(restart()), "log out everywhere");
  });

  await check("P8", "absolute expiry requires the password", async () => {
    await freshOwner();
    const state = readState();
    state.persistentSessions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    writeState(state);
    assert(!unlocked(restart()), "an expired session must not restore");
  });

  await check("P9", "idle timeout locks only past the limit and only when enabled", async () => {
    const security = await freshOwner();
    const now = Date.now();
    const limit = security._test.getIdleLockMs();
    assert.strictEqual(limit, 15 * 60 * 1000, "default idle lock is 15 minutes (D3)");
    assert.strictEqual(security.checkIdleLock({ systemIdleSeconds: limit / 1000 - 30, now: now + limit }).locked, false, "below the limit");
    assert(unlocked(security), "still unlocked below the limit");
    assert.strictEqual(security.checkIdleLock({ systemIdleSeconds: limit / 1000 + 30, now: now + 5000 }).locked, false, "a fresh unlock counts as activity");
    assert.strictEqual(security.checkIdleLock({ systemIdleSeconds: limit / 1000 + 30, now: now + limit + 30000 }).locked, true, "past the limit");
    assert(!unlocked(security), "idle lock requires the password even on a trusted device (D4)");
    const again = await freshOwner();
    const dashboard = again.getSecurityDashboard();
    again.updateSessionSecuritySettings({ inactiveSessionExpirationMs: 0, lockOwnerWorkspaceAfterInactivity: false, requireReauthForSensitiveActions: true, idleLockMinutes: dashboard.authentication?.idleLockMinutes ?? 15 });
    assert.strictEqual(again.checkIdleLock({ systemIdleSeconds: 99999, now: Date.now() + 99999e3 }).locked, false, "idle lock off");
    assert(unlocked(again), "idle lock off keeps the session");
  });

  await check("P10", "remembered-session inactivity expiry requires the password", async () => {
    const security = await freshOwner();
    security.updateSessionSecuritySettings({ inactiveSessionExpirationMs: 24 * 3600e3, lockOwnerWorkspaceAfterInactivity: true, requireReauthForSensitiveActions: true });
    const state = readState();
    state.persistentSessions[0].lastUsedAt = new Date(Date.now() - 2 * 24 * 3600e3).toISOString();
    writeState(state);
    assert(!unlocked(restart()), "a session unused for longer than the setting must not restore");
  });

  await check("P11", "a device ID mismatch requires the password", async () => {
    await freshOwner();
    const state = readState();
    state.persistentSessions[0].deviceId = "0000000000000000";
    writeState(state);
    assert(!unlocked(restart()), "a session from another device ID must not restore");
    assert.strictEqual(sessionFileExists(), false, "and its file is removed");
  });

  await check("P12", "a removed device requires the password", async () => {
    const security = await freshOwner();
    const device = security.getSecurityDashboard().trustedDevices.find((entry) => entry.current);
    assert(device?.id, "the current device is listed");
    security.removeTrustedDevice(device.id);
    assert.strictEqual(readState().persistentSessions.length, 0, "removing a device revokes its remembered sessions");
    assert(!unlocked(restart()), "a removed device must not restore");
  });

  await check("P13", "opting out of Trust this device", async () => {
    let security = await freshOwner();
    security.updateSessionSecuritySettings({ inactiveSessionExpirationMs: 0, lockOwnerWorkspaceAfterInactivity: true, requireReauthForSensitiveActions: true, trustThisDevice: false });
    assert.strictEqual(sessionFileExists(), false, "opting out deletes the remembered session");
    assert(!unlocked(restart()), "and it does not restore");
    security = restart();
    await security.login({ username: "owner", password: PASSWORD, staySignedIn: true });
    assert.strictEqual(sessionFileExists(), false, "an opted-out device remembers nothing");
    assert.strictEqual(security.getStatus().trustThisDeviceAvailable, false, "the lock screen is told the option is off");
  });

  await check("P14", "no secure storage", async () => {
    const security = await freshOwner({ staySignedIn: false });
    fakeSafeStorage.available = false;
    await security.login({ username: "owner", password: PASSWORD, staySignedIn: true });
    assert(unlocked(security), "sign-in still works");
    assert.strictEqual(sessionFileExists(), false, "nothing is remembered without secure storage");
    assert.strictEqual(security.getStatus().secureStorageAvailable, false, "status reports it");
    // An older build may have remembered a session with the fallback key.
    const legacy = restart();
    fakeSafeStorage.available = true;
    await legacy.login({ username: "owner", password: PASSWORD, staySignedIn: true });
    const payload = legacy._test.readPersistentSessionFile();
    fakeSafeStorage.available = false;
    const fallbackRecord = legacy._test.encryptLocalSession(payload);
    assert.strictEqual(fallbackRecord.method, "aes-256-gcm");
    fs.writeFileSync(configPath("session.dat"), `${JSON.stringify(fallbackRecord)}\n`);
    fakeSafeStorage.available = true;
    assert(!unlocked(restart()), "a fallback-encrypted session must not restore");
    assert.strictEqual(sessionFileExists(), false, "and is deleted");
  });

  await check("P15", "without a Local Owner session, protected actions stay refused", async () => {
    const security = await freshOwner();
    security.logout();
    assert.throws(() => security.requireLocalOwnerAuthenticated("smoke"), /Unlock|LOGIN|AUTH/i);
  });

  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`Secure session persistence smoke: ${failed.length} of ${results.length} failed (${failed.map((r) => r.id).join(", ")}).`);
    process.exit(1);
  }
  console.log(`Secure session persistence smoke: ${results.length} of ${results.length} passed.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
