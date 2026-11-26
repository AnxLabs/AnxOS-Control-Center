#!/usr/bin/env node
"use strict";

// Build 216-F finish line: an isolated profile written by the real Build 215
// app upgrades to Build 216 with 0 lost settings, credentials, nodes, SSH
// profiles, backups, favorites or paired phones.
//
// The Build 215 app (a checkout of the published Build 215 source, given with
// --base=<folder> or ANXHOST_BASE_215_DIR) runs on a temporary profile and
// config folder and creates real data through its own bridge: a Local Owner
// with "Stay signed in", a preference, an Agent computer (its token goes to
// the encrypted credential store), an SSH profile, a backup on that computer,
// a Marketplace favorite and a phone paired through the HTTPS gateway. The
// Build 216 app (this checkout) then opens the same profile and folder.
//
// U1 the remembered Local Owner session restores without a password (216-E)
// U2 the saved preference is unchanged
// U3 the computer is listed and its stored token still authenticates
// U4 the SSH profile is listed
// U5 the backup made by 215 is listed by 216
// U6 the Marketplace favorite is kept
// U7 the paired phone is listed and its session cookie still works
// U8 no renderer errors in either app
//
// Usage: node scripts/upgrade-from-215-ui-qa.js --base=<Build 215 checkout>
// (the checkout needs its node_modules; it is only read, never changed).

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");
const { evaluateMain, OFFSCREEN } = require("./test-helpers/anxhost-real-app");

const ROOT = path.resolve(__dirname, "..");
const BASE = (process.argv.find((arg) => arg.startsWith("--base=")) || "").slice(7) || process.env.ANXHOST_BASE_215_DIR || "";
const SERVER_ID = "upgrade-survival";
const PASSWORD = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;

const results = [];
function check(id, ok, detail) {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`);
}

function hideWindows({ BrowserWindow }, offscreen) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.setPosition(offscreen.x, offscreen.y); win.blur(); } catch {}
  }
}

async function launch(appRoot, userData, env, label) {
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", appRoot, "--qa-mode"], env });
  await evaluateMain(app, hideWindows, OFFSCREEN).catch(() => {});
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`${label}: ${String(error.message).slice(0, 200)}`));
  await page.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 90000 });
  return { app, page, errors };
}

function request(port, method, pathname, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: "127.0.0.1", port, method, path: pathname, rejectUnauthorized: false,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `https://127.0.0.1:${port}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  if (!BASE || !fs.existsSync(path.join(BASE, "main.js"))) {
    throw new Error("Give a Build 215 checkout with --base=<folder> (or ANXHOST_BASE_215_DIR).");
  }
  const baseRelease = JSON.parse(fs.readFileSync(path.join(BASE, "release.json"), "utf8"));
  if (Number(baseRelease.build) !== 215) throw new Error(`--base is Build ${baseRelease.build}, not 215.`);

  const agent = await startServiceManagedAgent({ initial: "running", extraInstanceConfigs: [fakeMinecraftInstance({ id: SERVER_ID })] });
  const qa = createIsolatedQaEnv("anx-216f-upgrade-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-216f-upgrade-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  let old = null;
  let current = null;
  const recorded = {};
  try {
    // ------------------------------------------------------------ Build 215 writes the data
    old = await launch(BASE, userData, env, "215");
    const written = await old.page.evaluate(async ({ password, agentUrl, agentToken, serverId }) => {
      const api = window.anxos;
      const out = {};
      await api.security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password, staySignedIn: true });
      out.status = await api.security.getStatus();
      await api.settings.savePreferences({ "ai.provider": "deterministic" });
      out.preferences = await api.settings.getPreferences();
      const node = await api.nodes.save({ displayName: "QA Upgrade Agent", agentUrl, agentToken });
      out.nodeId = node?.node?.id || node?.id || null;
      await api.ssh.saveProfile({ displayName: "QA Upgrade SSH", host: "192.0.2.10", port: 22, username: "qa", authType: "password" });
      out.profiles = await api.ssh.listProfiles();
      const backup = await api.backups.create({ nodeId: out.nodeId, instanceId: serverId, type: "full" });
      out.backupId = backup?.backup?.id || backup?.id || null;
      localStorage.setItem("anxos:marketplace-favorites", JSON.stringify(["minecraft-paper"]));
      await api.mobile.enable();
      out.mobile = await api.mobile.status();
      out.pairing = await api.mobile.createPairing("Operator");
      return out;
    }, { password: PASSWORD, agentUrl: agent.url, agentToken: agent.token, serverId: SERVER_ID });
    recorded.nodeId = written.nodeId;
    recorded.backupId = written.backupId;
    recorded.aiProvider = written.preferences?.settings?.["ai.provider"] ?? written.preferences?.["ai.provider"];
    if (!written.status?.localOwnerAuthenticated) throw new Error("Build 215 did not sign the owner in");
    if (!recorded.nodeId || !recorded.backupId) throw new Error(`Build 215 setup incomplete: ${JSON.stringify({ nodeId: recorded.nodeId, backupId: recorded.backupId })}`);
    const port = written.mobile?.port;
    // The code travels in the link's fragment (#pair=<code>).
    const pairCode = decodeURIComponent(String(written.pairing?.links?.[0] || "").split("#pair=")[1] || "");
    const paired = await request(port, "POST", "/api/pair", { code: pairCode, deviceName: "QA phone (215)" });
    if (paired.status !== 200) throw new Error(`Build 215 pairing failed: ${paired.status} ${paired.text.slice(0, 200)}`);
    recorded.cookie = String(paired.headers["set-cookie"] || "").split(";")[0];
    recorded.deviceId = JSON.parse(paired.text).device?.id;
    console.log(`INFO Build 215 wrote: owner, ai.provider=${recorded.aiProvider}, node ${recorded.nodeId}, backup ${recorded.backupId}, phone ${recorded.deviceId} on port ${port}`);
    await old.app.close();
    old.app = null;

    // ------------------------------------------------------------ Build 216 opens the same profile
    current = await launch(ROOT, userData, env, "216");
    await current.page.waitForTimeout(2500);
    const seen = await current.page.evaluate(async ({ nodeId, serverId }) => {
      const api = window.anxos;
      const out = {};
      out.status = await api.security.getStatus();
      out.preferences = await api.settings.getPreferences();
      out.nodes = await api.nodes.list();
      out.health = await api.nodes.health(nodeId).catch((error) => ({ error: error?.message || String(error) }));
      out.profiles = await api.ssh.listProfiles();
      out.backups = await api.backups.list({ nodeId, instanceId: serverId }).catch((error) => ({ error: error?.message || String(error) }));
      out.favorites = localStorage.getItem("anxos:marketplace-favorites");
      out.mobile = await api.mobile.status();
      if (!out.mobile?.running) { await api.mobile.enable(); out.mobile = await api.mobile.status(); }
      return out;
    }, { nodeId: recorded.nodeId, serverId: SERVER_ID });

    check("U1", seen.status?.localOwnerAuthenticated === true, `the remembered owner session restored without a password (authenticated=${seen.status?.localOwnerAuthenticated})`);
    const provider = seen.preferences?.settings?.["ai.provider"] ?? seen.preferences?.["ai.provider"];
    check("U2", provider === recorded.aiProvider && provider === "deterministic", `the saved preference is unchanged (ai.provider=${provider})`);
    const nodeList = Array.isArray(seen.nodes) ? seen.nodes : seen.nodes?.nodes || [];
    const node = nodeList.find((entry) => entry.id === recorded.nodeId);
    const healthy = /online|connected|ok|healthy/i.test(JSON.stringify(seen.health || {})) && !seen.health?.error;
    check("U3", Boolean(node) && healthy, `the computer "${node?.displayName || node?.name || "missing"}" is listed and its stored token authenticates (${JSON.stringify(seen.health).slice(0, 120)})`);
    const profileList = Array.isArray(seen.profiles) ? seen.profiles : seen.profiles?.profiles || [];
    check("U4", profileList.some((profile) => profile.displayName === "QA Upgrade SSH"), `the SSH profile is listed (${profileList.length} profile(s))`);
    const backupList = Array.isArray(seen.backups) ? seen.backups : seen.backups?.backups || [];
    check("U5", backupList.some((backup) => backup.id === recorded.backupId), `the backup made by 215 is listed by 216 (${backupList.length} backup(s)${seen.backups?.error ? `, error ${seen.backups.error}` : ""})`);
    check("U6", seen.favorites === JSON.stringify(["minecraft-paper"]), `the Marketplace favorite is kept (${seen.favorites})`);
    const phone = (seen.mobile?.devices || []).find((device) => device.id === recorded.deviceId);
    const session = seen.mobile?.port ? await request(seen.mobile.port, "GET", "/api/session", null, recorded.cookie) : { status: 0, text: "" };
    check("U7", Boolean(phone) && session.status === 200 && session.text.includes(recorded.deviceId), `the paired phone "${phone?.name || "missing"}" is listed and its session cookie works on 216 (${session.status})`);
    const errors = [...(old?.errors || []), ...(current?.errors || [])];
    check("U8", errors.length === 0, `${errors.length} renderer errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  } finally {
    if (old?.app) await old.app.close().catch(() => {});
    if (current?.app) await current.app.close().catch(() => {});
    await agent.stop().catch(() => {});
    try { qa.cleanup(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`Upgrade from Build 215: ${results.length - failed} of ${results.length} passed.`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
