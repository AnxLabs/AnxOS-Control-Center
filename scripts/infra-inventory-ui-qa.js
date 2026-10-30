#!/usr/bin/env node
"use strict";

// AIM-1 desktop UI acceptance for the Infrastructure Inventory panel.
//
// Launches the REAL Electron app (isolated profile and config, --qa-mode)
// against a REAL Agent whose only fake is systemd (Build 206 fixture), drives
// the Nodes page with real clicks and reads what the Agent actually did.
//
// Proves:
//   U1 the panel renders on the Nodes page and loads only the stored snapshot
//      on open (no discovery until Refresh is pressed);
//   U2 Refresh runs read-only discovery: the systemd service row shows its unit,
//      systemd ownership, a verified identity and the Production protection;
//   U3 the kind filter and name search narrow the table;
//   U4 discovery issued ZERO systemd control calls and spawned nothing;
//   U5 when the Agent goes away, a refresh keeps the rows and marks them stale,
//      and the status turns "Partially stale" instead of green;
//   U6 no renderer errors.
//
// Never touches the installed app or its data. Run: node scripts/infra-inventory-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");
const artifactDir = process.env.INFRA_INVENTORY_UI_QA_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-infra-ui-qa-"));
fs.mkdirSync(artifactDir, { recursive: true });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(label, assertion, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(`${label}: ${lastError?.message || "timed out"}`);
}

async function launch(agent, deviceId) {
  const qa = createIsolatedQaEnv("anx-infra-ui-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-infra-ui-qa-profile-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true, agentIdentity: { deviceId } }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1", ANXOS_INVENTORY_STORE: path.join(qa.configDir, "infrastructure-inventory.json") };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const mainLogs = [];
  app.process().stdout?.on("data", (chunk) => mainLogs.push(String(chunk)));
  app.process().stderr?.on("data", (chunk) => mainLogs.push(String(chunk)));
  const page = await app.firstWindow();
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(String(error.stack || error.message)));
  page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
  page.setDefaultTimeout(10000);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setSize(1500, 1100); window?.center(); });
  await page.waitForLoadState("domcontentloaded");
  await eventually("app shell ready", async () => assert.ok(await page.evaluate(() => typeof window.showPage === "function")), 30000);
  const useDevice = page.getByRole("button", { name: "Use this device" }).first();
  if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
  // The inventory channels require an unlocked Local Owner. This disposable QA
  // profile gets a test owner with a random per-run password that is never
  // printed or written outside the temporary profile.
  const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
  const unlocked = await page.evaluate(async (password) => {
    const security = window.anxhub?.security;
    const setup = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
    const login = await security.login({ username: "qa-owner", password }).catch((error) => ({ error: error?.message }));
    return { setupError: setup?.error || null, loginError: login?.error || null };
  }, testPassword);
  assert.ok(!unlocked.setupError && !unlocked.loginError, `QA owner unlock failed: ${unlocked.setupError || unlocked.loginError}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await eventually("app shell ready after unlock", async () => assert.ok(await page.evaluate(() => typeof window.showPage === "function")), 30000);
  if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
  await page.evaluate(() => window.showPage("nodes"));
  return {
    page,
    rendererErrors,
    mainLogs,
    async close() {
      await app.close().catch(() => {});
      for (const cleanup of [() => qa.cleanup(), () => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })]) {
        try { cleanup(); } catch {}
      }
    },
  };
}

async function panelState(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("[data-infra-inventory-panel]");
    const rows = Array.from(document.querySelectorAll("[data-infra-inventory-body] tbody tr")).map((row) => ({
      key: row.dataset.infraInventoryKey,
      cells: Array.from(row.querySelectorAll("td")).map((cell) => cell.innerText.replace(/\s+/g, " ").trim()),
    }));
    return {
      visible: Boolean(panel && !panel.hidden && panel.getBoundingClientRect().height > 0),
      status: document.querySelector("[data-infra-inventory-status]")?.textContent?.trim(),
      message: document.querySelector("[data-infra-inventory-message]")?.textContent?.trim(),
      overview: document.querySelector("[data-infra-inventory-overview]")?.innerText?.replace(/\s+/g, " ").trim() || "",
      nodes: document.querySelector("[data-infra-inventory-nodes]")?.innerText?.replace(/\s+/g, " ").trim() || "",
      rows,
    };
  });
}

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const deviceId = (await agent.api("GET", "/api/v1/health")).json?.identity?.deviceId;
  assert.ok(deviceId);
  const ui = await launch(agent, deviceId);
  const { page } = ui;
  let agentStopped = false;
  try {
    // U1: panel visible; opening it only reads the stored (empty) snapshot.
    agent.clearRecords();
    const opened = await eventually("inventory panel visible", async () => {
      const state = await panelState(page);
      assert.ok(state.visible, "panel visible on the Nodes page");
      assert.match(state.status, /Not discovered|Not loaded/);
      return state;
    }, 30000);
    assert.strictEqual(opened.rows.length, 0);
    await page.locator("[data-infra-inventory-panel]").scrollIntoViewIfNeeded();
    await page.locator("[data-infra-inventory-panel]").screenshot({ path: path.join(artifactDir, "inventory-not-discovered.png") });

    // U2: Refresh runs discovery.
    await page.locator('[data-infra-inventory-action="refresh"]').click();
    const discovered = await eventually("discovery rendered", async () => {
      const state = await panelState(page);
      // The QA profile also carries a migrated local node that is offline, so
      // nothing is stale but the inventory is honestly incomplete.
      assert.match(state.status, /^(Current|Incomplete)$/);
      const svc = state.rows.find((row) => row.cells[0] === "systemd service");
      assert.ok(svc, `systemd service row rendered (rows: ${state.rows.length})`);
      return { state, svc };
    }, 40000);
    // AIM-2 added the Function column after Health; a systemd service has no functional check.
    const [kind, name, node, health, functional, ownership, identity, protection] = discovered.svc.cells;
    assert.strictEqual(kind, "systemd service");
    assert.match(name, new RegExp(`unit ${agent.unit.replace(/\./g, "\\.")}`));
    assert.strictEqual(node, "OVH");
    assert.strictEqual(health, "healthy");
    assert.strictEqual(functional, "—", "no functional check is defined for a systemd service");
    assert.strictEqual(ownership, "systemd (not owned by the Agent)");
    assert.strictEqual(identity, "Verified");
    assert.strictEqual(protection, "Production");
    assert.ok(!/not allowlisted/.test(name), "no allow-list judgment on a host that does not support service-managed instances");
    assert.match(discovered.state.overview, /systemd services\s*1/i);
    assert.match(discovered.state.message, /read-only, no service was changed/);
    assert.ok(discovered.state.rows.some((row) => row.cells[0] === "Host" && row.cells[6] === "Verified"), "host row verified");
    assert.ok(discovered.state.rows.every((row) => row.cells[7] === "Production"), "every row protected as production");
    await page.locator("[data-infra-inventory-panel]").screenshot({ path: path.join(artifactDir, "inventory-discovered.png") });

    // U3: filters.
    await page.locator("[data-infra-inventory-kind]").selectOption("service-managed-instance");
    await eventually("kind filter", async () => {
      const state = await panelState(page);
      assert.strictEqual(state.rows.length, 1);
      assert.strictEqual(state.rows[0].cells[0], "systemd service");
    });
    await page.locator("[data-infra-inventory-panel]").screenshot({ path: path.join(artifactDir, "inventory-filter-systemd.png") });
    await page.locator("[data-infra-inventory-kind]").selectOption("all");
    await page.locator("[data-infra-inventory-search]").fill("zz-no-such-resource");
    await eventually("search filter", async () => {
      const state = await panelState(page);
      assert.strictEqual(state.rows.length, 0);
    });
    await page.locator("[data-infra-inventory-search]").fill("");

    // U4: discovery changed nothing.
    assert.deepStrictEqual(agent.controlCalls(), [], "no systemd control call from discovery");
    assert.deepStrictEqual(agent.spawnAttempts(), [], "no process spawned for discovery");

    // U5: the Agent goes away; refresh keeps rows, marks them stale.
    const rowCount = discovered.state.rows.length;
    await agent.stop();
    agentStopped = true;
    await page.locator('[data-infra-inventory-action="refresh"]').click();
    const stale = await eventually("stale rendering", async () => {
      const state = await panelState(page);
      assert.strictEqual(state.status, "Partially stale");
      assert.strictEqual(state.rows.length, rowCount, "rows kept");
      assert.ok(state.rows.every((row) => / stale$/.test(row.cells[8])), "every row marked stale");
      assert.match(state.nodes, /Unavailable/);
      assert.match(state.nodes, /NODE_UNREACHABLE/);
      return state;
    }, 40000);
    await page.locator("[data-infra-inventory-panel]").screenshot({ path: path.join(artifactDir, "inventory-stale.png") });

    // U6: renderer stayed clean (fetch failures to the stopped Agent are logged
    // by the main process, not the renderer).
    const relevant = ui.rendererErrors.filter((entry) => !/favicon|ERR_CONNECTION_REFUSED/i.test(entry));
    assert.deepStrictEqual(relevant, [], "no renderer errors");
    console.log(`infra inventory UI QA passed (${stale.rows.length} rows; screenshots: ${artifactDir})`);
  } catch (error) {
    // Main-process tail for diagnosis; tokens never reach these logs (redacted at source).
    const logLines = ui.mainLogs.join("").split(/\r?\n/);
    console.error(logLines.filter((line) => !/token|secret|password/i.test(line)).slice(-40).join("\n"));
    throw error;
  } finally {
    await ui.close();
    if (!agentStopped) await agent.stop();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
