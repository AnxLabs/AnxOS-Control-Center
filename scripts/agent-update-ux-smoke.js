#!/usr/bin/env node
// Build 215 Agent update UX regressions (Bugs A, C, D, E, F from the first
// real in-app Linux Agent upgrade, Build 213 -> 214 on the VPS). The renderer
// code runs verbatim from app.js and src/renderer/agentAutoUpdate.js in a
// sandbox against fakes:
//   U1  unlocking reloads SSH profiles and storage connections, then redraws
//       Agent Control's eligibility (Bug A)
//   U2  a locked profile load clears profiles; the next load restores them and
//       redraws Agent Control (Bug A)
//   U3  the Update tooltip names the node's real update method (Bug E)
//   U4  the Update confirmation names the computer, both builds, the method and
//       what keeps running, with an explicit Update Agent action (Bug F)
//   U5  after an update the panel drops the stale "Pending 213 -> 214" line and
//       "not connected" note, and shows the verified build (Bug C, Bug D)
//   U6  unsaved edits survive a refresh; only the computer notes change (Bug C)
//   U7  an older, slower overview never replaces a newer one (Bug C)
//   U8  update history records builds, never the 0.1.0 placeholder (Bug D)
//   U9  live progress events redraw the step list and refresh state at the end
//   U10 a specific error code is never relabelled "The Agent is not
//       responding" (Build 215 RC1: an unpublished release did); generic
//       connection failures still are
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");

function extractFunction(name) {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  const open = appSource.indexOf("{", appSource.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] === "}") {
      depth -= 1;
      if (depth === 0) return appSource.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

function extractConst(name) {
  const start = appSource.indexOf(`const ${name} = `);
  assert(start >= 0, `Could not find const ${name} in app.js.`);
  // A one-line declaration ends at its line end (app.js may use CRLF).
  const end = appSource.indexOf("\n", start);
  const open = appSource.indexOf("[", start);
  if (open >= 0 && open < appSource.indexOf("\n", start)) {
    let depth = 0;
    for (let index = open; index < appSource.length; index += 1) {
      if (appSource[index] === "[") depth += 1;
      if (appSource[index] === "]") {
        depth -= 1;
        if (depth === 0) return `${appSource.slice(start, index + 1)};`;
      }
    }
  }
  return appSource.slice(start, end).trim();
}

function sandbox(names, globals = {}, prelude = "") {
  const context = vm.createContext({ console: { info() {}, warn() {}, error() {}, log() {} }, Promise, setTimeout, clearTimeout, Map, Set, ...globals });
  vm.runInContext(`${prelude}\n${names.map(extractFunction).join("\n\n")}`, context);
  return context;
}

// ---------------------------------------------------------------- fake DOM
// Just enough of the DOM for agentAutoUpdate.js: tag and [data-*] selectors
// with descendant combinators, :checked, closest(), events and textContent.
class FakeElement {
  constructor(tag, document) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this._text = "";
    this.className = "";
    this.checked = false;
    this.disabled = false;
    this.value = "";
    this.title = "";
    this.options = [];
    this.listeners = {};
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return key in this.dataset ? this.dataset[key] : null;
    }
    return this.attributes[name] ?? null;
  }
  append(...nodes) {
    nodes.forEach((node) => {
      node.parentNode = this;
      this.children.push(node);
    });
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  matchesCompound(compound) {
    const tag = compound.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const [, name, value] of compound.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)) {
      const actual = this.getAttribute(name);
      if (actual === null) return false;
      if (value !== undefined && actual !== value) return false;
    }
    if (compound.includes(":checked") && !this.checked) return false;
    return true;
  }
  matches(selector) {
    return selector.split(",").some((part) => {
      const compounds = part.trim().split(/\s+/);
      if (!this.matchesCompound(compounds[compounds.length - 1])) return false;
      let index = compounds.length - 2;
      let ancestor = this.parentNode;
      while (index >= 0 && ancestor) {
        if (ancestor.matchesCompound?.(compounds[index])) index -= 1;
        ancestor = ancestor.parentNode;
      }
      return index < 0;
    });
  }
  querySelectorAll(selector) {
    return this.descendants().filter((node) => node.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) {
    let node = this;
    while (node && node.matches) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  dispatch(type, target = this) {
    let node = this;
    while (node) {
      (node.listeners?.[type] || []).forEach((listener) => listener({ type, target }));
      node = node.parentNode;
    }
  }
}

function createAutoUpdatePanel() {
  const document = new FakeElement("document", null);
  document.readyState = "complete";
  document.createElement = (tag) => new FakeElement(tag, document);
  const make = (tag, attrs = {}) => {
    const node = new FakeElement(tag, document);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  };
  const container = make("div", { "data-agent-auto-update": "" });
  const status = make("p", { "data-agent-auto-update-status": "" });
  const enabled = make("input", { "data-agent-auto-update-field": "enabled" });
  const mode = make("select", { "data-agent-auto-update-field": "mode" });
  const start = make("input", { "data-agent-auto-update-field": "start" });
  const duration = make("select", { "data-agent-auto-update-field": "durationMinutes" });
  duration.options = [60, 120, 180].map((value) => ({ value: String(value) }));
  const days = make("fieldset", { "data-agent-auto-update-days": "" });
  const computers = make("fieldset", { "data-agent-auto-update-computers": "" });
  const history = make("div", { "data-agent-update-history": "" });
  container.append(status, enabled, mode, start, duration, days, computers, history);
  document.append(container);
  return { document, container, history, computers };
}

function loadAutoUpdate(api) {
  const panel = createAutoUpdatePanel();
  const window = { document: panel.document, anx: { nodes: api }, showToast() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src", "renderer", "agentAutoUpdate.js"), "utf8"), { window, Number, String, Date, Promise, Math, Set, Map });
  return { ...panel, module: window.AnxAgentAutoUpdate };
}

const POLICY = { enabled: true, mode: "notify", nodeIds: ["vps"], days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", durationMinutes: 120 };
const OVERVIEW_BEFORE = { desktopBuild: "2.0-build214", nodes: [{ nodeId: "vps", name: "VPS", installedBuild: "2.0-build213", targetBuild: "2.0-build214", state: "update-available", canUpdate: true, reason: "Update 2.0-build213 → 2.0-build214." }] };
const OVERVIEW_OFFLINE = { desktopBuild: "2.0-build214", nodes: [{ nodeId: "vps", name: "VPS", installedBuild: "2.0-build213", targetBuild: "2.0-build214", state: "offline", canUpdate: false, reason: "The computer is not connected." }] };
const OVERVIEW_AFTER = { desktopBuild: "2.0-build214", nodes: [{ nodeId: "vps", name: "VPS", installedBuild: "2.0-build214", targetBuild: "2.0-build214", state: "up-to-date", canUpdate: false, reason: "Up to date." }] };
const HISTORY_AFTER = [{ id: "h1", at: "2026-11-19T09:01:31.000Z", trigger: "manual", nodeId: "vps", name: "VPS", fromBuild: "2.0-build213", toBuild: "2.0-build214", verifiedBuild: "2.0-build214", status: "succeeded", method: "package" }];

(async () => {
  // U1
  {
    const calls = [];
    const step = (name) => async () => { calls.push(name); };
    const context = sandbox(["refreshProtectedStateAfterLocalOwnerAuthentication"], {
      securityState: { localOwnerAuthenticated: true, localCredentialContextAvailable: true },
      refreshSecurityState: step("security"),
      refreshNodes: step("nodes"),
      loadAgentSettings: step("agent-settings"),
      loadMarketplaceSettings: step("marketplace"),
      refreshInstances: step("instances"),
      refreshDockerStatus: step("docker"),
      refreshBackups: step("backups"),
      loadSshProfiles: step("ssh-profiles"),
      loadStorageConnections: step("storage"),
      syncAgentConnectionDisplayWithSelectedNode: () => calls.push("sync"),
      refreshAgentControlEligibility: () => calls.push("eligibility"),
      getActivePageName: () => "agent-control",
      refreshAgentControl: async () => { calls.push("agent-control"); },
    }, "var localOwnerProtectedRefreshPromise = null;");
    await context.refreshProtectedStateAfterLocalOwnerAuthentication({ localOwnerAuthenticated: true, localCredentialContextAvailable: true });
    assert(calls.includes("ssh-profiles"), "SSH profiles reload after unlock");
    assert(calls.includes("storage"), "storage connections reload after unlock");
    assert(calls.indexOf("eligibility") > calls.indexOf("ssh-profiles"), "Agent Control eligibility is redrawn after the profiles load");
    assert(calls.includes("agent-control"), "an open Agent Control page reloads its own state at unlock");
    console.log("  ok U1 unlock reloads SSH profiles and redraws Agent Control");
  }

  // U2
  {
    let locked = true;
    let redraws = 0;
    const profiles = [{ id: "anx-ovh", nodeId: "vps", authType: "privateKey", useSshAgent: true }];
    const context = sandbox(["loadSshProfiles"], {
      getDesktopApiState: () => ({ hasSsh: true, hasBridge: true, api: { ssh: { listProfiles: async () => {
        if (locked) throw Object.assign(new Error("LOGIN_REQUIRED: Unlock AnxOS."), { code: "LOGIN_REQUIRED" });
        return { servers: [{ id: "vps" }], profiles, defaultProfileId: "anx-ovh" };
      } } } }),
      logSafeSshDebug() {},
      setSshStatus() {},
      renderSshView() {},
      renderFilesView() {},
      syncSshSelectionState() {},
      syncFilesSelectionState() {},
      getFriendlyStatusFailureMessage: (error, fallback) => fallback,
      refreshAgentControlEligibility: () => { redraws += 1; },
    }, "var sshProfilesState = { servers: [], profiles: [{ id: 'stale' }] }; var sshSelectedServerId = null; var sshSelectedProfileId = null;");
    await context.loadSshProfiles();
    assert.strictEqual(vm.runInContext("sshProfilesState.profiles.length", context), 0, "a locked load shows no profiles");
    assert.strictEqual(redraws, 0);
    locked = false;
    await context.loadSshProfiles();
    assert.strictEqual(vm.runInContext("sshProfilesState.profiles[0].id", context), "anx-ovh", "profiles return after unlock");
    assert.strictEqual(redraws, 1, "Agent Control is redrawn once the profiles are back");
    console.log("  ok U2 profiles cleared while locked and restored after unlock");
  }

  // U3
  {
    const context = sandbox(["getRemoteAgentUpdateMethod", "describeRemoteAgentUpdateMethod"]);
    const pkg = context.describeRemoteAgentUpdateMethod({ verification: { scope: "system" } });
    assert(/release package/.test(pkg) && /SHA-256/.test(pkg), pkg);
    assert(!/bundled/i.test(pkg), "a package-managed Agent is not described as a bundled-runtime push");
    const runtime = context.describeRemoteAgentUpdateMethod({ verification: { scope: "user" } });
    assert(/Agent runtime/.test(runtime) && !/package/.test(runtime), runtime);
    const unknown = context.describeRemoteAgentUpdateMethod({});
    assert(/Verify Access/.test(unknown), unknown);
    console.log("  ok U3 Update tooltip follows the node's update method");
  }

  // U4
  {
    let captured = null;
    const context = sandbox(["getRemoteAgentUpdateMethod", "describeRemoteAgentUpdateMethod", "confirmRemoteAgentUpdate"], {
      getDesktopApiState: () => ({ api: { nodes: { agentUpdateOverview: async () => OVERVIEW_BEFORE } } }),
      createSecurityConfirmation: async (options) => { captured = options; return true; },
    });
    const confirmed = await context.confirmRemoteAgentUpdate({ nodeId: "vps", node: { displayName: "VPS" }, profile: { displayName: "Anx-OVH" }, verification: { scope: "system", hostname: "vps-7360e3ad" } });
    assert.strictEqual(confirmed, true);
    assert.strictEqual(captured.title, "Update the Agent on VPS?");
    assert.strictEqual(captured.confirmLabel, "Update Agent");
    const rows = Object.fromEntries(captured.details);
    assert.strictEqual(rows.Computer, "VPS (vps-7360e3ad)");
    assert.strictEqual(rows["Current build"], "2.0-build213");
    assert.strictEqual(rows["New build"], "2.0-build214");
    assert(/release package/.test(rows.Method));
    assert(/Docker containers/.test(rows.Services) && /needrestart/.test(rows.Services));
    console.log("  ok U4 Update confirmation names the computer, builds and effects");
  }

  // U5
  {
    let overview = OVERVIEW_BEFORE;
    let history = [];
    const api = {
      getAgentAutoUpdate: async () => ({ policy: POLICY, history }),
      agentUpdateOverview: async () => overview,
      setAgentAutoUpdate: async ({ policy }) => ({ policy, history }),
    };
    const panel = loadAutoUpdate(api);
    await panel.module.load();
    assert(/Pending: VPS 2\.0-build213 → 2\.0-build214/.test(panel.history.textContent), panel.history.textContent);
    overview = OVERVIEW_OFFLINE;
    await panel.module.load();
    assert(/not connected/.test(panel.computers.textContent));
    overview = OVERVIEW_AFTER;
    history = HISTORY_AFTER;
    await panel.module.load();
    assert(!/Pending/.test(panel.history.textContent), `stale pending line: ${panel.history.textContent}`);
    assert(!/not connected/.test(panel.computers.textContent), "stale not-connected note");
    assert(/up to date/.test(panel.computers.textContent));
    assert(/2\.0-build213 → 2\.0-build214 \(verified\)/.test(panel.history.textContent), panel.history.textContent);
    assert(!/0\.1\.0/.test(panel.history.textContent), "no placeholder version");
    console.log("  ok U5 the panel shows the post-update state, not the pending one");
  }

  // U6
  {
    let overview = OVERVIEW_OFFLINE;
    const api = { getAgentAutoUpdate: async () => ({ policy: POLICY, history: [] }), agentUpdateOverview: async () => overview };
    const panel = loadAutoUpdate(api);
    await panel.module.load();
    const box = panel.computers.querySelector("input");
    assert.strictEqual(box.checked, true);
    box.checked = false; // the owner unticks VPS and has not saved yet
    box.dispatch("change");
    overview = OVERVIEW_AFTER;
    await panel.module.load();
    const after = panel.computers.querySelector("input");
    assert.strictEqual(after.checked, false, "an unsaved choice survives the refresh");
    assert(/up to date/.test(panel.computers.textContent) && !/not connected/.test(panel.computers.textContent), "its note is current");
    assert(/unsaved changes/.test(panel.container.querySelector("[data-agent-auto-update-status]").textContent));
    console.log("  ok U6 unsaved edits survive; notes refresh");
  }

  // U7
  {
    let release = null;
    let call = 0;
    const api = {
      getAgentAutoUpdate: async () => ({ policy: POLICY, history: [] }),
      agentUpdateOverview: () => {
        call += 1;
        if (call === 1) return new Promise((resolve) => { release = () => resolve(OVERVIEW_BEFORE); });
        return Promise.resolve(OVERVIEW_AFTER);
      },
    };
    const panel = loadAutoUpdate(api);
    const older = panel.module.load();
    await panel.module.load();
    release();
    await older;
    assert(!/Pending/.test(panel.history.textContent), "the older overview did not overwrite the newer one");
    assert(/up to date/.test(panel.computers.textContent));
    console.log("  ok U7 stale responses are discarded");
  }

  // U8
  {
    const { historyEntryFor } = require("../src/services/agentUpdateManager");
    const entry = historyEntryFor({
      id: "x",
      at: "2026-11-19T09:01:31.000Z",
      trigger: "manual",
      overviewEntry: { nodeId: "vps", name: "VPS", installedBuild: null, targetBuild: null },
      outcome: { status: "succeeded", result: { method: "package", installedBuild: "2.0-build213", targetBuild: "2.0-build214", verifiedBuild: "2.0-build214", deferredRestarts: ["cron.service"], verification: { agentVersion: "0.1.0", agentArtifactVersion: "2.0-build214" } } },
    });
    assert.strictEqual(entry.fromBuild, "2.0-build213");
    assert.strictEqual(entry.toBuild, "2.0-build214");
    assert.strictEqual(entry.verifiedBuild, "2.0-build214");
    assert.deepStrictEqual(entry.deferredRestarts, ["cron.service"]);
    assert(!JSON.stringify(entry).includes("0.1.0"), "the placeholder package version is never recorded");
    console.log("  ok U8 history records verified builds only");
  }

  // U9
  {
    const document = createAutoUpdatePanel().document;
    const host = document.createElement("div");
    host.setAttribute("data-agent-update-progress", "");
    host.hidden = true;
    document.append(host);
    let refreshes = 0;
    const context = sandbox(["agentUpdateStepTone", "renderAgentUpdateProgress", "handleAgentUpdateProgress"], {
      document,
      createTextElement: (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; node.className = className || ""; return node; },
      scheduleAgentUpdateStateRefresh: () => { refreshes += 1; },
    }, "var agentUpdateProgressState = { nodeId: null, steps: [], fleet: new Map(), unsubscribe: null, refreshTimer: null };");
    context.handleAgentUpdateProgress({ nodeId: "vps", state: "running", steps: [{ id: "check", label: "Check the node", state: "complete", message: "ok" }, { id: "swap", label: "Install the package", state: "running" }] });
    assert.strictEqual(host.hidden, false);
    assert(/Install the package/.test(host.textContent) && /in progress/.test(host.textContent));
    assert.strictEqual(refreshes, 0);
    context.handleAgentUpdateProgress({ nodeId: "vps", state: "complete", steps: [{ id: "verify", label: "Verify", state: "complete", message: "The Agent answers and reports 2.0-build214." }] });
    assert.strictEqual(refreshes, 1, "the end of an update refreshes nodes, overview and history");
    context.handleAgentUpdateProgress({ fleet: true, nodeId: "vps", name: "VPS", state: "skipped" });
    assert(/Update all: VPS: skipped/.test(host.textContent));
    assert.strictEqual(refreshes, 2);
    console.log("  ok U9 live progress and end-of-update refresh");
  }

  // U10
  {
    const context = sandbox(["normalizeIpcErrorMessage", "getFriendlyErrorCode", "isSpecificErrorCode", "findFriendlyErrorDefinition"], {}, `${extractConst("FRIENDLY_ERROR_DEFINITIONS")}\n${extractConst("GENERIC_ERROR_CODE_PATTERN")}`);
    const find = (error) => context.findFriendlyErrorDefinition(error)?.id || null;
    const rc1 = "AGENT_PACKAGE_RELEASE_UNAVAILABLE: The v2.0-build215 release or its SHA256SUMS could not be read (HTTP 404 for https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/v2.0-build215/SHA256SUMS).";
    assert.strictEqual(find({ code: "AGENT_PACKAGE_RELEASE_UNAVAILABLE", message: rc1 }), null, "the RC1 refusal keeps its own message");
    assert.strictEqual(find(rc1), null, "also when only the message string is passed (toasts)");
    assert.strictEqual(find({ code: "AGENT_PACKAGE_RELEASE_UNAVAILABLE", message: "AGENT_PACKAGE_RELEASE_UNAVAILABLE: The release could not be read (fetch failed)." }), null, "offline GitHub is not a dead Agent");
    assert.strictEqual(find({ code: "AGENT_UNAVAILABLE", message: "x" }), "agent-unreachable", "listed codes still map");
    assert.strictEqual(find({ message: "connect ECONNREFUSED 127.0.0.1:47131" }), "agent-unreachable", "plain connection failures still map");
    assert.strictEqual(find({ code: "AGENT_REQUEST_FAILED", message: "AGENT_REQUEST_FAILED: fetch failed" }), "agent-unreachable", "generic request failures still map");
    assert.strictEqual(find({ message: "The Agent is unavailable right now." }), "agent-unreachable");
    console.log("  ok U10 specific error codes keep their own message");
  }

  console.log("Agent update UX smoke passed (10 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
