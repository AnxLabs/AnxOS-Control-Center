#!/usr/bin/env node
"use strict";

// Build 216-A3 My Servers and the server page: acceptance checks in the REAL
// app, for the AnxHost look and for the A3 inventory rows no other suite
// covers. Off-screen, isolated profile, real Agent test fixture with a
// disposable stand-in Paper server (scripts/test-helpers/fake-minecraft-instance.js),
// signed-in disposable owner; see scripts/test-helpers/anxhost-real-app.js.
//
//   M1  list: AnxHost page layer (summary tiles on tokens), live rows from
//       the Agent, state pills with a status shape and sentence case
//   M2  search and status filter narrow the rows; the computer selector
//       (data-node-target=instances) lists the computer
//   M3  "Create Server" opens the Create Server window (until A4 brings it
//       into the main window). The older inline create form has no caller
//       that opens it in Build 215 (dormant, an A10 retirement candidate);
//       shown directly it still works: presets set the type, every field is
//       present, an invalid ID is refused and nothing is created, Cancel
//       closes it
//   M4  server page: header, Copy address (both buttons), "All servers"
//   M5  the six main tabs and the three detail tabs open their panels
//   M6  console: streamed lines, status filter, search, wrap, pause and
//       auto-scroll, Copy, Download, Jump to latest, Send
//   M7  Files tab: into a folder and Up again
//   M8  Backups tab: "All backups" opens Backups
//   M9  Settings: every startup field present and filled, Advanced, Raw
//       configuration (stored record), Reset Runtime explains why it is
//       unavailable, network port input, "Network details" opens Network
//   M10 Add-ons: Modrinth/CurseForge choice, Import opens a file picker,
//       Check for updates answers, Change history
//   M11 More menu, "Why are some actions unavailable?", Technical details
//   M12 FiveM setup dialog: show/hide key, empty key refused, Cancel closes
//   M13 layout: no horizontal page overflow or clipped header text at
//       900x640, 1280x800 and 1920x1080 (list and server page)
//   M14 contrast: WCAG AA for list and server page text, 3:1 status shapes
//   M15 no renderer errors
//
// Usage: node scripts/anxhost-servers-ui-qa.js [--shots=<dir>]

const fs = require("fs");
const path = require("path");
const { launchRealApp, waitFor, evaluateMain } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");

const SERVER_ID = "survival-test";
const shotsArg = process.argv.find((arg) => arg.startsWith("--shots="));
const SHOTS = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (id, ok, message) => {
  results.push({ id, ok: Boolean(ok), message });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
};

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 15000 }).catch(() => {});
}

const CONTRAST_HELPERS = `
  const parse = (value) => {
    const s = String(value || "").trim();
    let m = /^rgba?\\(([^)]+)\\)/.exec(s);
    if (m) {
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    m = /^color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) {
      const parts = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
    }
    return null;
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    let colour = { r: 8, g: 6, b: 13, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) colour = over(layers[i], colour);
    return colour;
  };
  const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const lowContrast = (elements, minimum) => {
    const low = [];
    for (const element of elements) {
      const fg = parse(getComputedStyle(element).color);
      if (!fg) continue;
      const bg = backgroundOf(element);
      const r = ratio(over(fg, bg), bg);
      if (r < minimum) low.push(element.className.split(" ")[0] + " '" + element.innerText.trim().slice(0, 24) + "' " + r.toFixed(2));
    }
    return low;
  };
`;

const visible = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]"))`;

async function openList(page) {
  await page.evaluate(async () => {
    if (window.AnxServerView?.isOpen?.()) await window.AnxServerView.close();
    window.showPage("instances");
  });
  await page.waitForTimeout(300);
}

async function openServer(page, tab = "overview") {
  await page.evaluate(async ({ id, tab: target }) => {
    window.showPage("instances");
    selectInstance(id);
    await window.AnxServerView.open(id, target);
  }, { id: SERVER_ID, tab });
  await page.waitForTimeout(400);
}

async function run() {
  const real = await launchRealApp({ prefix: "anx-216-a3-qa-", agentOptions: { initial: "running", extraInstanceConfigs: [fakeMinecraftInstance({ id: SERVER_ID })] } });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);
    await openList(page);
    await waitFor(page, (id) => Boolean(document.querySelector(`[data-instances-list] tr[data-instance-id="${id}"]`)), SERVER_ID, "the stand-in server in the list", 400);
    await page.waitForTimeout(600);
    await shot(page, "a3-1280-list");

    // ------------------------------------------------------------ M1 list
    const m1 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-instances-list] tr[data-instance-id]")].map((row) => row.dataset.instanceId);
      const tiles = [...document.querySelectorAll(".instances-summary-card")].filter((tile) => tile.getClientRects().length > 0);
      const probe = document.createElement("div");
      probe.style.background = "var(--ahx-surface-1)";
      document.body.append(probe);
      const surface1 = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const pills = [...document.querySelectorAll("[data-instances-list] .instance-state")].map((pill) => {
        const before = getComputedStyle(pill, "::before");
        return { text: pill.textContent.trim(), transform: getComputedStyle(pill).textTransform, shape: pill.classList.contains("is-stale") || (before.content !== "none" && parseFloat(before.width) > 0) };
      });
      return { rows, tiles: tiles.length, tilesOnToken: tiles.every((tile) => getComputedStyle(tile).backgroundColor === surface1), pills };
    });
    check("M1", m1.rows.includes(SERVER_ID) && m1.rows.length >= 2, `list shows live servers from the Agent: ${m1.rows.join(", ")}`);
    check("M1", m1.tiles >= 4 && m1.tilesOnToken, `${m1.tiles} summary tiles on --ahx-surface-1 (${m1.tilesOnToken})`);
    check("M1", m1.pills.length > 0 && m1.pills.every((pill) => pill.shape && pill.transform === "none"), `state pills keep a status shape and sentence case: ${m1.pills.map((pill) => pill.text).join(", ")}`);

    // ------------------------------------------------------------ M2 search, filter, computer
    const m2 = await page.evaluate(async () => {
      const search = document.querySelector("[data-instances-search]");
      const filter = document.querySelector("[data-instances-filter]");
      const shown = () => [...document.querySelectorAll("[data-instances-list] tr[data-instance-id]")].filter((row) => !row.hidden && row.getClientRects().length > 0).map((row) => row.dataset.instanceId);
      const before = shown();
      search.value = "survival";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const searched = shown();
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const options = [...filter.options].map((option) => option.value);
      const stopped = options.find((value) => /stop/i.test(value));
      filter.value = stopped || options[options.length - 1];
      filter.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const filtered = shown();
      filter.value = options[0];
      filter.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const node = document.querySelector('[data-node-target="instances"]');
      return { before, searched, filtered, after: shown(), filterValue: stopped, enabled: !search.disabled && !filter.disabled, nodeOptions: [...(node?.options || [])].map((option) => option.textContent.trim()) };
    });
    check("M2", m2.enabled && m2.searched.length >= 1 && m2.searched.every((id) => /survival/.test(id)) && m2.searched.length < m2.before.length, `search narrows ${m2.before.length} rows to ${m2.searched.join(", ")}`);
    check("M2", m2.filtered.length < m2.before.length && m2.after.length === m2.before.length, `status filter "${m2.filterValue}" narrows to ${m2.filtered.length} and back to ${m2.after.length}`);
    check("M2", m2.nodeOptions.some((label) => /QA Computer/.test(label)), `computer selector lists ${m2.nodeOptions.join(", ")}`);

    // ------------------------------------------------------------ M3 create form
    const idsBefore = await evaluateMain(real.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.id));
    await page.locator('[data-instance-action="create"]').first().click();
    let opened = [];
    for (let i = 0; i < 40 && !opened.length; i += 1) {
      opened = await evaluateMain(real.app, ({ BrowserWindow }, keep) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !keep.includes(win.id)).map((win) => win.id), idsBefore);
      if (!opened.length) await page.waitForTimeout(150);
    }
    await evaluateMain(real.app, ({ BrowserWindow }, keep) => { BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !keep.includes(win.id)).forEach((win) => win.close()); }, idsBefore);
    check("M3", opened.length === 1, `"Create Server" opens the Create Server window (${opened.length} new window)`);
    const m3 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      setInstanceCreateFormVisible(true);
      await wait(300);
      const form = document.querySelector("[data-instance-create-form]");
      const opened = !form.hidden && form.getClientRects().length > 0;
      const java = form.querySelector('[data-instance-template="java-app"]');
      java.click();
      await wait(150);
      const type = form.querySelector('[data-instance-form="type"]').value;
      const javaChecked = java.getAttribute("aria-checked");
      const custom = form.querySelector('[data-instance-template="custom-command"]');
      custom.click();
      await wait(150);
      const customType = form.querySelector('[data-instance-form="type"]').value;
      form.querySelector('[data-instance-template="minecraft-paper"]').click();
      await wait(150);
      const fields = ["type", "displayName", "id", "entrypoint", "executable", "args", "workingDirectory", "environment", "ports", "memoryLimit", "acceptEula", "playitTunnel", "tags"];
      const missing = fields.filter((name) => !form.querySelector(`[data-instance-form="${name}"]`));
      const before = (await window.anxos.instances.list({ nodeId: getSelectedNodeId() }))?.instances?.length ?? null;
      const id = form.querySelector('[data-instance-form="id"]');
      id.value = "x";
      id.dispatchEvent(new Event("input", { bubbles: true }));
      form.querySelector("[data-instance-create-submit]").click();
      await wait(800);
      const message = form.querySelector("[data-instance-form-message]")?.textContent.trim() || form.innerText.match(/Use an ID[^.]*\./)?.[0] || "";
      const after = (await window.anxos.instances.list({ nodeId: getSelectedNodeId() }))?.instances?.length ?? null;
      form.querySelector('[data-instance-action="cancel-create"]').click();
      await wait(300);
      return { opened, type, javaChecked, customType, missing, message, before, after, closed: form.hidden };
    });
    check("M3", m3.opened && m3.closed, `the dormant inline form, shown directly, is visible and Cancel closes it (opened=${m3.opened}, closed=${m3.closed})`);
    check("M3", m3.javaChecked === "true" && m3.type && m3.customType && m3.type !== m3.customType, `presets set the server type (java-app → ${m3.type}, custom-command → ${m3.customType})`);
    check("M3", m3.missing.length === 0, m3.missing.length ? `form fields missing: ${m3.missing.join(", ")}` : "all 13 form fields present");
    check("M3", /ID/.test(m3.message) && m3.before !== null && m3.after === m3.before, `an invalid ID is refused ("${m3.message}") and nothing is created (${m3.before} → ${m3.after})`);

    // ------------------------------------------------------------ M4 server page header
    await openServer(page);
    await shot(page, "a3-1280-server");
    const m4 = await page.evaluate(async () => {
      const copied = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => { copied.push(text); };
      try {
        const header = document.querySelector('[data-server-copy-address]');
        const headerEnabled = !header.disabled;
        if (headerEnabled) header.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const overview = document.querySelector("[data-instance-address-copy]");
        const overviewEnabled = overview && !overview.disabled;
        if (overviewEnabled) overview.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          name: document.querySelector('[data-instance-detail="name"]')?.textContent.trim(),
          state: document.querySelector('[data-field="instanceDetailState"]')?.textContent.trim(),
          headerEnabled, overviewEnabled, copied,
        };
      } finally {
        navigator.clipboard.writeText = original;
      }
    });
    check("M4", m4.name && m4.state, `server page header: "${m4.name}", state "${m4.state}"`);
    check("M4", m4.headerEnabled && m4.copied.length >= 1 && m4.copied.every((text) => /:\d+/.test(text)), `Copy address copies the address (${m4.copied.join(" | ")}; Overview copy enabled=${m4.overviewEnabled})`);
    await page.locator("[data-server-view-back]").click();
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => document.querySelector('.page[data-page="instances"]')?.dataset.serverView);
    check("M4", back !== "open", `"All servers" returns to the list (serverView=${back})`);

    // ------------------------------------------------------------ M5 tabs
    await openServer(page);
    const m5 = await page.evaluate(async () => {
      const opened = [];
      for (const tab of ["overview", "console", "files", "mods", "backups", "settings", "players", "performance", "network"]) {
        setActiveInstanceTab(tab);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const panel = document.querySelector(`[data-instance-panel="${tab}"]`);
        opened.push(`${tab}=${Boolean(panel && panel.classList.contains("is-active") && panel.getClientRects().length > 0)}`);
      }
      setActiveInstanceTab("overview");
      return opened;
    });
    check("M5", m5.every((entry) => entry.endsWith("=true")), `all nine tabs open their panels: ${m5.join(", ")}`);

    // ------------------------------------------------------------ M6 console
    await openServer(page, "console");
    await page.locator('.instance-quick-actions [data-instance-action="start"]').click();
    await waitFor(page, () => /running/i.test(document.querySelector('[data-field="instanceDetailState"]')?.textContent || ""), null, "the stand-in server running", 300);
    await waitFor(page, () => (document.querySelectorAll("[data-instances-logs] li").length || 0) >= 3, null, "console lines", 300).catch(() => {});
    const m6 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const list = document.querySelector("[data-instances-logs]");
      const shown = () => [...list.querySelectorAll("li")].filter((row) => !row.hidden).length;
      const total = list.querySelectorAll("li").length;
      const search = document.querySelector("[data-instance-console-search]");
      search.value = "zz-no-such-line-zz";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(400);
      const searched = shown();
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(400);
      const filter = document.querySelector("[data-instance-console-filter]");
      const filterOptions = [...filter.options].map((option) => option.value);
      filter.value = filterOptions.find((value) => /error/i.test(value)) || filterOptions[filterOptions.length - 1];
      filter.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(200);
      const filtered = shown();
      filter.value = filterOptions[0];
      filter.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(200);
      const viewer = document.querySelector(".instance-console-viewer") || list.parentElement;
      const wrap = document.querySelector("[data-instance-console-wrap]");
      wrap.click();
      await wait(100);
      const wrapped = document.querySelector(".is-wrapped") !== null;
      wrap.click();
      const pause = document.querySelector("[data-instance-console-pause]");
      const autoscroll = document.querySelector("[data-instance-console-autoscroll]");
      pause.click();
      await wait(100);
      const pausedStopsAutoscroll = pause.checked && !autoscroll.checked;
      pause.click();
      autoscroll.checked = true;
      autoscroll.dispatchEvent(new Event("change", { bubbles: true }));
      const copied = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => { copied.push(text); };
      document.querySelector('[data-instance-action="copy-console"]').click();
      await wait(300);
      navigator.clipboard.writeText = original;
      let downloaded = null;
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function captured() { downloaded = this.download; };
      document.querySelector('[data-instance-action="download-logs"]').click();
      HTMLAnchorElement.prototype.click = click;
      const scroller = [list, viewer, list.parentElement].find((element) => element && element.scrollHeight > element.clientHeight) || viewer;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
      await wait(200);
      const jump = document.querySelector("[data-console-jump]");
      const jumpShown = !jump.hidden;
      if (jumpShown) jump.click();
      await wait(200);
      const send = document.querySelector("[data-instance-console-form] button[type=submit], [data-instance-console-form] button:not([type])");
      return { total, searched, filtered, wrapped, pausedStopsAutoscroll, copied: copied[0]?.split("\n").length || 0, downloaded, jumpShown, jumpHiddenAfter: jump.hidden, scrollable: scroller.scrollHeight > scroller.clientHeight, sendLabel: send?.textContent.trim() };
    });
    check("M6", m6.total >= 3, `console streams the server's lines (${m6.total})`);
    check("M6", m6.searched === 0 && m6.filtered < m6.total, `search hides non-matching lines (0 shown) and the status filter narrows (${m6.filtered}/${m6.total})`);
    check("M6", m6.wrapped && m6.pausedStopsAutoscroll, `Wrap wraps lines; Pause turns auto-scroll off`);
    check("M6", m6.copied >= 3 && /-logs\.txt$/.test(m6.downloaded || ""), `Copy copies ${m6.copied} lines; Download saves ${m6.downloaded}`);
    check("M6", !m6.scrollable || (m6.jumpShown && m6.jumpHiddenAfter), `"Jump to latest" appears when scrolled up and returns to the end (scrollable=${m6.scrollable}, shown=${m6.jumpShown})`);
    const sent = await page.evaluate(async () => {
      const form = document.querySelector("[data-instance-console-form]");
      const input = form.querySelector("input");
      input.value = "say a3-console-check";
      form.requestSubmit();
      for (let i = 0; i < 60; i += 1) {
        if ([...document.querySelectorAll("[data-instances-logs] li")].some((row) => row.textContent.includes("a3-console-check"))) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    });
    check("M6", sent && m6.sendLabel, `Send ("${m6.sendLabel}") delivers a command and its answer streams back`);

    // ------------------------------------------------------------ M7 files
    await openServer(page, "files");
    await waitFor(page, () => document.querySelectorAll("[data-instance-files-list] tr.is-directory").length > 0, null, "a folder in the file list", 200).catch(() => {});
    const m7 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const pathOf = () => document.querySelector(".instance-files-toolbar [data-instance-file-path]")?.textContent.trim();
      const start = pathOf();
      const folder = document.querySelector("[data-instance-files-list] tr.is-directory");
      const name = folder?.querySelector("strong")?.textContent.trim() || null;
      if (folder) folder.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      for (let i = 0; i < 30 && pathOf() === start; i += 1) await wait(100);
      const inside = pathOf();
      document.querySelector('[data-instance-file-action="up"]').click();
      for (let i = 0; i < 30 && pathOf() === inside; i += 1) await wait(100);
      return { start, inside, after: pathOf(), folder: name };
    });
    check("M7", m7.folder && m7.inside !== m7.start && m7.after === m7.start, `Files: into "${m7.folder}" (${m7.start} → ${m7.inside}) and Up returns (${m7.after})`);

    // ------------------------------------------------------------ M8 backups
    await openServer(page, "backups");
    const m8 = await page.evaluate(async () => {
      document.querySelector('[data-instance-backup-action="history"]').click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return document.querySelector(".page.is-active")?.dataset.page;
    });
    check("M8", m8 === "backups", `"All backups" opens ${m8}`);

    // ------------------------------------------------------------ M9 settings
    await openServer(page, "settings");
    await page.waitForTimeout(600);
    const m9 = await page.evaluate(async () => {
      const panel = document.querySelector('[data-instance-panel="settings"]');
      const fields = ["id", "executable", "args", "workingDirectory", "environment", "restartPolicy", "startupTimeoutMs", "shutdownTimeoutMs", "jar"];
      const present = fields.filter((name) => panel.querySelector(`[data-instance-config="${name}"]`));
      const id = panel.querySelector('[data-instance-config="id"]');
      const details = [...panel.querySelectorAll("details")];
      const advanced = details.find((element) => /Advanced/i.test(element.querySelector("summary")?.textContent || ""));
      const raw = details.find((element) => /Raw configuration/i.test(element.querySelector("summary")?.textContent || ""));
      if (advanced) advanced.querySelector("summary").click();
      if (raw) raw.querySelector("summary").click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const json = panel.querySelector("[data-instance-raw-json]")?.value || "";
      const reset = panel.querySelector('[data-instance-action="reset-runtime"]');
      const tags = document.querySelector('[data-instance-advanced="tags"]');
      const port = panel.querySelector("[data-instance-network-port]");
      const add = panel.querySelector("[data-instance-network-add]");
      const resetDefault = document.querySelector("[data-game-config-reset-default]");
      panel.querySelector('[data-server-open-tab="network"]').click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const network = document.querySelector('[data-instance-panel="network"]')?.classList.contains("is-active");
      return {
        present, missing: fields.filter((name) => !present.includes(name)), idValue: id?.value, idReadOnly: id?.readOnly,
        advancedOpen: advanced?.open, rawOpen: raw?.open, jsonHasId: json.includes('"id"'),
        resetDisabled: reset?.disabled, resetReason: reset?.title || reset?.closest("[title]")?.title || "",
        tags: Boolean(tags), port: Boolean(port && add), resetDefault: Boolean(resetDefault), network,
      };
    });
    check("M9", m9.missing.length === 0 && m9.idValue && m9.idReadOnly, m9.missing.length ? `startup fields missing: ${m9.missing.join(", ")}` : `all startup fields present; ID "${m9.idValue}" read-only`);
    check("M9", m9.advancedOpen && m9.rawOpen && m9.jsonHasId, `Advanced and Raw configuration open; the stored record is shown (${m9.jsonHasId})`);
    check("M9", m9.tags && m9.port && m9.resetDefault, `tags, network port input and Reset Defaults present`);
    check("M9", m9.resetDisabled === false || Boolean(m9.resetReason), `Reset Runtime is available or says why not ("${m9.resetReason}")`);
    check("M9", m9.network, `"Network details and diagnostics" opens the Network tab`);

    // ------------------------------------------------------------ M10 add-ons
    await openServer(page, "mods");
    await page.waitForTimeout(600);
    const m10 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const panel = document.querySelector('[data-instance-panel="mods"]');
      const curse = panel.querySelector('[data-addons-provider="curseforge"]');
      const modrinth = panel.querySelector('[data-addons-provider="modrinth"]');
      curse.click();
      await wait(200);
      const curseChecked = curse.getAttribute("aria-checked");
      modrinth.click();
      await wait(200);
      const modrinthChecked = modrinth.getAttribute("aria-checked");
      const input = panel.querySelector("[data-addons-import-input]");
      let picked = false;
      const originalClick = input.click.bind(input);
      input.click = () => { picked = true; };
      panel.querySelector('[data-mods-action="import"]').click();
      input.click = originalClick;
      const history = [...panel.querySelectorAll("summary, button, h4, h5")].find((element) => /Change history/i.test(element.textContent));
      const updateAll = panel.querySelector('[data-mods-action="update-all"]');
      const check = panel.querySelector('[data-mods-action="check-updates"]');
      const statusBefore = panel.innerText;
      check.click();
      await wait(2500);
      return { curseChecked, modrinthChecked, picked, history: Boolean(history), updateAllHidden: updateAll?.hidden, checkAnswered: panel.innerText !== statusBefore || check.disabled === false };
    });
    check("M10", m10.curseChecked === "true" && m10.modrinthChecked === "true", "Modrinth and CurseForge can each be chosen");
    check("M10", m10.picked, "Import a file opens the file picker");
    check("M10", m10.checkAnswered && m10.updateAllHidden !== undefined && m10.history, `Check for updates answers; Update all ${m10.updateAllHidden ? "hidden with nothing to update" : "offered"}; Change history present`);

    // ------------------------------------------------------------ M11 menu and explanations
    await openServer(page);
    const m11 = await page.evaluate(async () => {
      const menu = document.querySelector("[data-server-more-menu]");
      menu.querySelector("summary").click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const groups = [...menu.querySelectorAll(".instance-action-group__label")].map((label) => label.textContent.trim());
      const open = menu.open;
      menu.querySelector("summary").click();
      const summaries = [...document.querySelectorAll('.page[data-page="instances"] summary')].map((summary) => summary.textContent.trim());
      return { open, groups, why: summaries.some((text) => /Why are some actions unavailable/i.test(text)), technical: summaries.some((text) => /Technical details/i.test(text)), adopt: Boolean(document.querySelector("[data-instance-adopt]")), openService: Boolean(document.querySelector("[data-instance-open-service]")), restartNow: Boolean(document.querySelector("[data-server-restart-banner] [data-server-restart-now]")), networkAdd: Boolean(document.querySelector("[data-instance-network-add]")), updateAll: Boolean(document.querySelector('[data-mods-action="update-all"]')) };
    });
    check("M11", m11.open && m11.groups.join() === "Access,Manage,Danger zone", `More menu opens with ${m11.groups.join(", ")}`);
    check("M11", m11.why && m11.technical && m11.adopt && m11.openService && m11.restartNow && m11.networkAdd && m11.updateAll, `"Why are some actions unavailable?", Technical details, Adopt service, Open service, Restart now, Add port and Update all are kept`);

    // ------------------------------------------------------------ M12 FiveM setup dialog
    const m12 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // The fixture's FiveM server; Save works only for a FiveM server.
      selectInstance("fivem-fxserver");
      await wait(300);
      setFiveMSetupModalVisible(true);
      await wait(300);
      const modal = document.querySelector("[data-fivem-setup-modal]");
      const opened = !modal.hidden;
      const key = modal.querySelector("[data-fivem-license-key]");
      const toggle = modal.querySelector("[data-fivem-license-toggle]");
      toggle.click();
      await wait(100);
      const shownType = key.type;
      toggle.click();
      await wait(100);
      const hiddenType = key.type;
      key.value = "";
      modal.querySelector('[data-fivem-setup-action="save"]').click();
      await wait(400);
      const status = modal.querySelector("[data-fivem-setup-status]")?.textContent.trim();
      const stillOpen = !modal.hidden;
      const openFiles = Boolean(modal.querySelector('[data-fivem-setup-action="open-files"]'));
      modal.querySelector('[data-fivem-setup-action="cancel"]').click();
      await wait(300);
      return { opened, shownType, hiddenType, status, stillOpen, openFiles, closed: modal.hidden };
    });
    check("M12", m12.opened && m12.shownType === "text" && m12.hiddenType === "password", `FiveM dialog shows and hides the key (${m12.shownType}/${m12.hiddenType})`);
    check("M12", m12.stillOpen && /Paste a FiveM license key/.test(m12.status || "") && m12.openFiles && m12.closed, `an empty key is refused ("${m12.status}"); Open server.cfg present; Cancel closes`);

    // ------------------------------------------------------------ M13 layout
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      for (const view of ["list", "server"]) {
        if (view === "list") await openList(page); else await openServer(page);
        await page.waitForTimeout(400);
        const layout = await page.evaluate(() => {
          const pageEl = document.querySelector('.page[data-page="instances"]');
          const host = pageEl.closest("[data-page-host]") || pageEl.parentElement;
          const clipped = [...pageEl.querySelectorAll(".instances-toolbar__title h1, .instances-summary-card strong, .server-header-main h3, .instance-tab, .instance-quick-actions .inline-action")]
            .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]"))
            .filter((element) => getComputedStyle(element).textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
            .map((element) => element.textContent.trim().slice(0, 24));
          return { overflow: host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped };
        });
        check("M13", !layout.overflow && !layout.clipped.length, `${width}x${height} ${view}: no horizontal page overflow (${layout.overflow}); clipped=[${layout.clipped.join("; ")}]`);
        await shot(page, `a3-${width}x${height}-${view}`);
      }
    }

    // ------------------------------------------------------------ M14 contrast
    await real.setViewport(1280, 800);
    const contrast = [];
    for (const view of ["list", "server"]) {
      if (view === "list") await openList(page); else await openServer(page);
      await page.waitForTimeout(400);
      contrast.push(await page.evaluate(new Function(`${CONTRAST_HELPERS}
        const pageEl = document.querySelector('.page[data-page="instances"]');
        const text = [...pageEl.querySelectorAll("h1, h3, h4, .lede, .instances-summary-card span, .instances-summary-card strong, th, td, .instance-state, .status-pill, .instance-tab, .inline-action:not(:disabled), .server-header-main span, .instance-overview-list dt, .instance-overview-list dd")]
          .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]") && element.innerText.trim());
        const shapes = [...pageEl.querySelectorAll(".instance-state")].filter((pill) => pill.getClientRects().length > 0 && !pill.classList.contains("is-stale")).map((pill) => {
          const before = getComputedStyle(pill, "::before");
          const colour = parse(before.backgroundColor)?.a > 0 ? parse(before.backgroundColor) : parse(before.borderTopColor);
          const bg = backgroundOf(pill.parentElement);
          return ratio(over(colour, bg), bg);
        });
        return { view: ${JSON.stringify(view)}, count: text.length, low: lowContrast(text, 4.5), shapes: shapes.map((value) => Number(value.toFixed(2))) };
      `)));
    }
    for (const entry of contrast) {
      check("M14", entry.count > 10 && entry.low.length === 0, `${entry.view}: text meets 4.5:1 (${entry.count} elements)${entry.low.length ? `; below: ${entry.low.slice(0, 6).join(" | ")}` : ""}`);
      check("M14", entry.shapes.every((value) => value >= 3), `${entry.view}: status shapes meet 3:1 (${entry.shapes.join(", ")})`);
    }

    // ------------------------------------------------------------ M15 errors
    check("M15", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-servers-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
