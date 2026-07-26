#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

function clearServiceCache() {
  [
    path.join(root, "src", "services", "accountAuthService.js"),
    path.join(root, "src", "services", "secureSessionStore.js"),
  ].forEach((file) => {
    delete require.cache[require.resolve(file)];
  });
}

function loadService(configDir) {
  process.env.ANXHUB_CONFIG_DIR = configDir;
  process.env.ANXOS_SUPABASE_URL = "https://projectref.supabase.co";
  process.env.ANXOS_SUPABASE_ANON_KEY = "anon-key";
  clearServiceCache();
  return require("../src/services/accountAuthService");
}

function fetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function makeSessionResponse(overrides = {}) {
  return {
    access_token: overrides.accessToken || "access-token",
    refresh_token: overrides.refreshToken || "refresh-token",
    expires_in: overrides.expiresIn ?? 3600,
    user: {
      id: "user-1",
      email: "anx@example.invalid",
      user_metadata: { name: "Anx" },
    },
  };
}

async function withTempService(fn) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-account-restore-"));
  try {
    await fn(configDir);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    clearServiceCache();
  }
}

async function signIn(service, response = makeSessionResponse()) {
  global.fetch = async () => fetchResponse(response);
  return service.loginWithPassword({ email: "anx@example.invalid", password: "correct horse battery staple" });
}

async function main() {
  await withTempService(async (configDir) => {
    let service = loadService(configDir);
    await signIn(service);
    service = loadService(configDir);
    const restored = await service.restoreSession();
    assert.strictEqual(restored.authenticated, true, "app restart with a valid saved session must restore as authenticated.");
    assert.strictEqual(restored.restorationState, "authenticated");
  });

  await withTempService(async (configDir) => {
    const service = loadService(configDir);
    await signIn(service);
    const refreshed = await service.restoreSession();
    assert.strictEqual(refreshed.authenticated, true, "renderer refresh with a valid session must stay authenticated.");
  });

  await withTempService(async (configDir) => {
    let service = loadService(configDir);
    await signIn(service, makeSessionResponse({ accessToken: "expired-access", refreshToken: "refresh-ok", expiresIn: -5 }));
    global.fetch = async () => fetchResponse(makeSessionResponse({ accessToken: "fresh-access", refreshToken: "refresh-ok", expiresIn: 3600 }));
    service = loadService(configDir);
    const restored = await service.restoreSession();
    assert.strictEqual(restored.authenticated, true, "expired access token with a valid refresh token must refresh during restoration.");
    assert.strictEqual(restored.restorationState, "authenticated");
  });

  await withTempService(async (configDir) => {
    let service = loadService(configDir);
    await signIn(service, makeSessionResponse({ accessToken: "expired-access", refreshToken: "refresh-offline", expiresIn: -5 }));
    global.fetch = async () => { throw new Error("fetch failed"); };
    service = loadService(configDir);
    const restored = await service.restoreSession();
    assert.strictEqual(restored.restorationState, "temporarily-offline", "temporary network failures must not become login-required.");
    assert(fs.existsSync(restored.accountPath), "temporary refresh failure must preserve saved credentials.");
  });

  await withTempService(async (configDir) => {
    let service = loadService(configDir);
    await signIn(service, makeSessionResponse({ accessToken: "expired-access", refreshToken: "refresh-revoked", expiresIn: -5 }));
    global.fetch = async () => fetchResponse({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
    service = loadService(configDir);
    const restored = await service.restoreSession();
    assert.strictEqual(restored.restorationState, "invalid", "revoked refresh token must become an invalid signed-out session.");
    assert(!fs.existsSync(restored.accountPath), "revoked refresh token must clear the saved account session.");
  });

  await withTempService(async (configDir) => {
    const service = loadService(configDir);
    await signIn(service);
    const before = service.getStatus();
    assert(fs.existsSync(before.accountPath), "login must persist the account session.");
    await service.logout();
    const after = service.getStatus();
    assert.strictEqual(after.authenticated, false, "explicit logout must sign out.");
    assert(!fs.existsSync(after.accountPath), "explicit logout must clear the saved session.");
  });

  console.log("Account session restore smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
