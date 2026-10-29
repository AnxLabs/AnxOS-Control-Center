"use strict";

// Nodes page > Route row and Routes panel, in the real app (isolated profile
// and config, QA mode, one registered Agent node that is not running). The
// renderer's own functions are driven with route and tunnel states; nothing
// is saved and no SSH or Tailscale command runs.
// Run: node scripts/node-routes-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");
const TS = "http://anxlab.tail6fda7f.ts.net:47131";

async function main() {
  const qa = createIsolatedQaEnv("anx-node-routes-ui-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-routes-ui-profile-"));
  fs.writeFileSync(path.join(qa.configDir, "nodes.json"), `${JSON.stringify({
    schemaVersion: 2,
    selectedNodeId: "application-host",
    nodes: [{ id: "qa-remote", kind: "agent", name: "QA Remote", displayName: "QA Remote", baseUrl: "http://127.0.0.1:9", agentUrl: "http://127.0.0.1:9", enabled: true, agentIdentity: { deviceId: "qa-remote", hostname: "qa-remote" } }],
  }, null, 2)}\n`);
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const rendererErrors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setIgnoreMouseEvents(true);
      win?.setSize(1440, 900);
    });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 30000 });
    await page.evaluate(() => window.showPage("nodes"));
    await page.waitForFunction(() => (nodesState.nodes || []).some((node) => node.id === "qa-remote"), null, { timeout: 20000 });

    const card = (setup) => page.evaluate((script) => {
      // eslint-disable-next-line no-new-func
      new Function(script)();
      renderNodes();
      const element = [...document.querySelectorAll(".node-card")].find((item) => item.textContent.includes("QA Remote"));
      const rows = Object.fromEntries([...element.querySelectorAll(".node-card__meta > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]));
      return { route: rows.Route, agent: rows.Agent, actions: [...element.querySelectorAll("[data-node-card-action]")].map((button) => button.dataset.nodeCardAction) };
    }, setup);

    let view = await card("nodeRouteStatusById = new Map(); nodeTunnelStatusById = new Map();");
    assert.strictEqual(view.route, "Main", "a plain node uses its main address");
    assert.ok(view.actions.includes("routes"), "Agent nodes offer a Routes action");
    view = await card(`const n = nodesState.nodes.find((x) => x.id === "qa-remote"); n.fallbackUrls = [{ url: "${TS}", label: "Tailscale" }]; nodeRouteStatusById.set("qa-remote", { nodeId: "qa-remote", activeUrl: "${TS}", routes: [{ url: n.baseUrl, label: "Main", verified: false, error: "ETIMEDOUT" }, { url: "${TS}", label: "Tailscale", verified: true, latencyMs: 38 }] });`);
    assert.strictEqual(view.route, "Tailscale · 38 ms", "the card shows the route in use and its latency");
    view = await card(`nodeRouteStatusById.set("qa-remote", { nodeId: "qa-remote", activeUrl: "http://127.0.0.1:9", routes: [{ url: "http://127.0.0.1:9", label: "Main", verified: false, error: "ETIMEDOUT" }, { url: "${TS}", label: "Tailscale", verified: false, error: "IDENTITY_MISMATCH" }] });`);
    assert.strictEqual(view.route, "No route answering", "an unverified route is never shown as in use");
    view = await card(`const n = nodesState.nodes.find((x) => x.id === "qa-remote"); n.transport = { type: "ssh-tunnel", sshProfileId: "qa-key", remoteHost: "127.0.0.1", remotePort: 47132 }; nodeTunnelStatusById.set("qa-remote", { nodeId: "qa-remote", state: "failed", lastError: { code: "SSH_HOST_KEY_NOT_APPROVED", message: "Approve the host key first." } });`);
    assert.strictEqual(view.route, "SSH tunnel · Needs attention · Approve the host key first.", "tunnel problems show their reason on the card");
    console.log("PASS N1 the node card shows the route in use, its latency and tunnel problems");

    const modal = await page.evaluate(() => {
      openNodeRoutesModal("qa-remote");
      const dialog = document.querySelector("[data-node-routes-modal] .app-modal");
      const result = {
        title: dialog.querySelector("#node-routes-title").textContent,
        routes: [...dialog.querySelectorAll(".node-routes__list li")].map((item) => item.querySelector("strong").textContent),
        buttons: [...dialog.querySelectorAll("button")].map((button) => button.textContent),
        profileOptions: [...dialog.querySelectorAll("select option")].map((option) => option.textContent),
        overflow: dialog.scrollWidth > dialog.clientWidth + 1,
      };
      document.querySelector("[data-node-routes-close]").click();
      result.closed = !document.querySelector("[data-node-routes-modal]");
      return result;
    });
    assert.strictEqual(modal.title, "QA Remote routes");
    assert.deepStrictEqual(modal.routes, ["Main", "Tailscale"]);
    for (const label of ["Remove", "Find Tailscale route", "Save tunnel", "Reconnect tunnel", "Stop using tunnel", "Done"]) {
      assert.ok(modal.buttons.includes(label), `the Routes panel offers ${label}`);
    }
    assert.ok(modal.profileOptions.includes("qa-key (missing profile)"), "a missing SSH profile is named, not blank");
    assert.strictEqual(modal.overflow, false);
    assert.strictEqual(modal.closed, true, "the panel closes");
    console.log("PASS N2 the Routes panel lists addresses and tunnel controls, and closes cleanly");

    assert.deepStrictEqual(rendererErrors.filter((entry) => !/Unlock AnxOS|AGENT_UNAVAILABLE/i.test(entry)), [], "no renderer errors");
    console.log("node routes UI QA passed (2 checks).");
  } finally {
    await app.close().catch(() => {});
    try { qa.cleanup(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
