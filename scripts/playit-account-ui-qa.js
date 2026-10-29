"use strict";

// Public Access > Connect Playit.gg, in the real app (isolated profile and
// config, QA mode). Drives the renderer's own render functions with each
// account state and asserts the Install -> Start -> Link Account -> View
// Tunnels -> Manage stepper, the tunnel list (public address + Copy, local
// port, status, server) and the Settings fallback. It never clicks an action,
// so no Playit command runs and no browser page opens.
// Run: node scripts/playit-account-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");

async function main() {
  const qa = createIsolatedQaEnv("anx-playit-account-ui-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-playit-account-ui-profile-"));
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
    await page.evaluate(() => window.showPage("playit"));
    await page.waitForFunction(() => document.querySelector("[data-playit-account-card]")?.offsetWidth > 0, null, { timeout: 15000 });

    const view = (setup) => page.evaluate((script) => {
      // eslint-disable-next-line no-new-func
      new Function(script)();
      const card = document.querySelector("[data-playit-account-card]");
      return {
        pill: card.querySelector("[data-playit-account-pill]").textContent,
        message: card.querySelector("[data-playit-account-message]").textContent,
        steps: [...card.querySelectorAll("[data-playit-step]")].map((item) => `${item.dataset.playitStep}:${item.classList.contains("is-current") ? "current" : item.classList.contains("is-done") ? "done" : "todo"}`),
        actions: [...card.querySelectorAll("[data-playit-account-actions] button")].map((button) => `${button.dataset.publicAccessAction}${button.disabled ? "(disabled)" : ""}`),
      };
    }, setup);

    let state = await view("playitLinkSession = null; latestPlayitTunnels = []; renderPlayitAccount({ installed: false, running: false, linked: false, step: 'install' });");
    assert.deepStrictEqual(state.steps, ["install:current", "start:todo", "link:todo", "tunnels:todo", "manage:todo"]);
    assert.deepStrictEqual(state.actions, ["playit-account-install", "playit-account-download", "playit-account-refresh"]);
    state = await view("renderPlayitAccount({ installed: true, running: false, linked: true, step: 'start' });");
    assert.deepStrictEqual(state.steps.slice(0, 2), ["install:done", "start:current"]);
    assert.ok(/linked but not running/i.test(state.message));
    assert.deepStrictEqual(state.actions, ["playit-start", "playit-account-refresh"]);
    console.log("PASS U1 Install and Start steps offer the matching action");

    state = await view("renderPlayitAccount({ installed: true, running: true, linked: false, step: 'link' });");
    assert.strictEqual(state.steps[2], "link:current");
    assert.ok(/never sees your password/i.test(state.message));
    assert.deepStrictEqual(state.actions, ["playit-account-link", "playit-account-refresh"]);
    state = await view("renderPlayitAccount({ installed: true, running: true, linked: null, step: 'start' });");
    assert.strictEqual(state.steps[2], "link:current");
    assert.ok(!state.actions.includes("playit-account-link"), "an unknown link state never offers linking");
    state = await view("latestPlayitAccount = { installed: true, running: true, linked: false, step: 'link' }; playitLinkSession = { id: 'qa', state: 'starting', hasLink: false, nodeId: getSelectedNodeId() }; renderPlayitAccount();");
    assert.deepStrictEqual(state.actions, ["playit-account-link-open(disabled)", "playit-account-link-cancel"]);
    state = await view("playitLinkSession = { id: 'qa', state: 'awaiting-approval', hasLink: true, nodeId: getSelectedNodeId() }; renderPlayitAccount();");
    assert.strictEqual(state.pill, "Waiting for approval");
    assert.deepStrictEqual(state.actions, ["playit-account-link-open", "playit-account-link-cancel"]);
    console.log("PASS U2 Link Account offers linking only when Playit reports no link, then tracks approval");

    state = await view(`playitLinkSession = null; latestPlayitAccount = { installed: true, running: true, linked: true, step: 'tunnels' }; renderPlayitTunnels({ ok: true, tunnels: [] });`);
    assert.deepStrictEqual(state.steps.slice(3), ["tunnels:current", "manage:todo"]);
    assert.deepStrictEqual(state.actions, ["playit-account-manage", "playit-refresh-tunnels", "playit-account-refresh"]);
    state = await view(`renderPlayitTunnels({ ok: true, tunnels: [
      { id: "t1", name: "Minecraft", status: "online", protocol: "TCP", localHost: "127.0.0.1", localPort: 25565, publicAddress: "qa-one.playit.example" },
      { id: "t2", name: "Voice", status: "offline", protocol: "UDP", localHost: "127.0.0.1", localPort: 24454, publicAddress: "qa-two.joinmc.example:24454" },
      { id: "t3", name: "Pending", status: "unknown", localHost: "127.0.0.1", localPort: 8080 },
    ] });`);
    assert.deepStrictEqual(state.steps, ["install:done", "start:done", "link:done", "tunnels:done", "manage:current"]);
    assert.ok(/3 tunnels/.test(state.message));
    const tunnels = await page.evaluate(() => [...document.querySelectorAll("[data-playit-tunnel-list] .playit-tunnel-item")].map((item) => ({
      text: item.innerText.replace(/\s+/g, " "),
      copy: item.querySelector(".playit-tunnel-copy")?.dataset.publicAccessAction || null,
      address: item.querySelector(".playit-tunnel-item__address code")?.textContent,
    })));
    assert.strictEqual(tunnels.length, 3, "every tunnel is listed");
    assert.deepStrictEqual(tunnels.map((tunnel) => tunnel.address), ["qa-one.playit.example", "qa-two.joinmc.example:24454", "Public address not reported"]);
    assert.deepStrictEqual(tunnels.map((tunnel) => tunnel.copy), ["playit-copy:t1", "playit-copy:t2", null], "each public address has its own Copy button");
    assert.ok(tunnels[0].text.includes("Local 127.0.0.1:25565") && tunnels[0].text.includes("online") && tunnels[0].text.includes("Server:"));
    console.log("PASS U3 every tunnel shows its public address with Copy, local port, status and server");

    const layout = await page.evaluate(() => {
      const card = document.querySelector("[data-playit-account-card]");
      const list = document.querySelector(".playit-tunnels-card");
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        accountFirst: card.parentElement.firstElementChild === card,
        sameWidth: Math.abs(card.offsetWidth - list.offsetWidth) <= 1,
        stepsOneRow: new Set([...card.querySelectorAll("[data-playit-step]")].map((item) => item.offsetTop)).size === 1,
      };
    });
    assert.deepStrictEqual(layout, { overflow: false, accountFirst: true, sameWidth: true, stepsOneRow: true });
    console.log("PASS U4 the account card leads the page and the tunnel list spans the full width");

    const settings = await page.evaluate(() => {
      const details = document.querySelector("[data-playit-manual-address]");
      return { tag: details?.tagName, open: details?.open, hasInput: Boolean(details?.querySelector('[data-setting="playit.address"]')) };
    });
    assert.deepStrictEqual(settings, { tag: "DETAILS", open: false, hasInput: true }, "the manual address stays available under Advanced, collapsed");
    const linkInDom = await page.evaluate(() => /playit\.gg\/(claim|login)/i.test(document.documentElement.innerHTML));
    assert.strictEqual(linkInDom, false, "no claim or sign-in link is ever in the page");
    console.log("PASS U5 the manual address is an Advanced fallback and no playit.gg link reaches the page");

    assert.deepStrictEqual(rendererErrors.filter((entry) => !/Unlock AnxOS|AGENT_UNAVAILABLE/i.test(entry)), [], "no renderer errors");
    console.log("playit account UI QA passed (5 checks).");
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
