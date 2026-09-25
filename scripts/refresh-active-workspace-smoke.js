#!/usr/bin/env node
// Regression coverage for refreshActiveWorkspace (app.js): only the ACTIVE
// page's refreshers run, instead of eagerly evaluating all 14 workspace
// refreshes (Agent config, marketplace downloads, files discovery, security,
// alerts, backups, ...) on a single refresh.
//
// The real renderer function is extracted from app.js and driven in a VM with
// stubbed collaborators that record calls, so this asserts observed invocation
// sets and toast/rethrow semantics, not source text.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_PATH = path.resolve(__dirname, "..", "app.js");
const source = fs.readFileSync(APP_PATH, "utf8");

function extractFunction(name) {
  const asyncNeedle = `async function ${name}(`;
  const syncNeedle = `function ${name}(`;
  const asyncStart = source.indexOf(asyncNeedle);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(syncNeedle);
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

const REFRESH_EXTRACTED = extractFunction("refreshActiveWorkspace");
const DISPLAY_EXTRACTED = extractFunction("getPageDisplayName");
assert(REFRESH_EXTRACTED.includes("Promise.allSettled"), "app.js refreshActiveWorkspace must be extracted intact.");
assert(DISPLAY_EXTRACTED.includes("data-nav-label"), "app.js getPageDisplayName must be extracted intact.");

// Every refresher the real switch can reach; every one is stubbed so a foreign
// (out-of-page) invocation is recorded and caught instead of silently working.
const REFRESHERS = [
  "refreshDashboard",
  "refreshInstances",
  "refreshDockerStatus",
  "refreshPlayitStatus",
  "refreshAgentControl",
  "refreshNodes",
  "refreshFleetSummary",
  "refreshMarketplace",
  "refreshMarketplaceDownloads",
  "refreshCurrentFilesDirectory",
  "refreshFilesDiscovery",
  "refreshConsoleMetrics",
  "refreshConsoleLogs",
  "refreshBackups",
  "loadDurableJobs",
  "loadAlerts",
  "refreshSecurityState",
];

// Fake sidebar labels shaped like index.html nav items, so the real
// getPageDisplayName resolves each tested page's toast label.
const PAGE_LABELS = {
  dashboard: "Dashboard",
  nodes: "Nodes",
  "agent-control": "Agent Control",
  marketplace: "Marketplace",
  instances: "Instances",
  playit: "Public Access",
  docker: "Docker",
  files: "Files",
  console: "Monitoring",
  backups: "Backups",
  operations: "Operations",
  notifications: "Notifications",
  security: "Security",
  settings: "Settings",
  ssh: "SSH",
};
const NAV_ITEMS = Object.entries(PAGE_LABELS).map(([pageTarget, pageLabel]) => ({ dataset: { pageTarget, pageLabel } }));

const EXTRACTED = [DISPLAY_EXTRACTED, REFRESH_EXTRACTED].join("\n\n");

// Recorded arguments cross the VM realm boundary, so clone them into plain
// main-realm values before deepStrictEqual.
function cloneArgs(args) {
  return args.map((value) => (value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value));
}

function createHarness({ page, connected = false, rejections = {} } = {}) {
  const calls = [];
  const toasts = [];
  const context = {
    getActivePageName: () => page,
    showToast: (message, tone) => { toasts.push({ message, tone }); },
    filesConnectionState: { connected },
    navItems: NAV_ITEMS,
  };
  for (const name of REFRESHERS) {
    context[name] = (...args) => {
      calls.push({ name, args: cloneArgs(args) });
      const rejection = rejections[name];
      if (rejection) return Promise.reject(rejection);
      return Promise.resolve(name);
    };
  }
  vm.createContext(context);
  vm.runInContext(
    `${EXTRACTED}\nthis.refreshActiveWorkspace = refreshActiveWorkspace;\nthis.getPageDisplayName = getPageDisplayName;`,
    context,
  );
  return { context, calls, toasts };
}

function calledNames(calls) {
  return [...new Set(calls.map((call) => call.name))].sort();
}

const checks = [];
function check(label, fn) {
  checks.push({ label, fn });
}

// --- 1. Every mapped page runs only its own refreshers -----------------------
check("dashboard runs only its five refreshers", async () => {
  const { context, calls, toasts } = createHarness({ page: "dashboard" });
  await context.refreshActiveWorkspace();
  assert.deepStrictEqual(calledNames(calls), ["refreshAgentControl", "refreshDashboard", "refreshDockerStatus", "refreshInstances", "refreshPlayitStatus"], `dashboard called: ${calledNames(calls).join(", ")}`);
  assert.deepStrictEqual(calls.find((call) => call.name === "refreshAgentControl").args, [], "the dashboard's Agent Control refresh must stay config-light");
  assert.deepStrictEqual(toasts, [{ message: "Dashboard refreshed.", tone: "success" }]);
});

for (const [page, expected] of [
  ["nodes", ["refreshFleetSummary", "refreshNodes"]],
  ["marketplace", ["refreshMarketplace", "refreshMarketplaceDownloads"]],
  ["instances", ["refreshInstances"]],
  ["playit", ["refreshPlayitStatus"]],
  ["docker", ["refreshDockerStatus"]],
  ["backups", ["refreshBackups"]],
  ["operations", ["loadDurableJobs"]],
  ["notifications", ["loadAlerts"]],
  ["security", ["refreshSecurityState"]],
]) {
  check(`${page} runs only its own refresher(s)`, async () => {
    const { context, calls, toasts } = createHarness({ page });
    await context.refreshActiveWorkspace();
    assert.deepStrictEqual(calledNames(calls), expected, `${page} called: ${calledNames(calls).join(", ")}`);
    assert.deepStrictEqual(calls.every((call) => expected.includes(call.name)), true, "no foreign refresher may run");
    assert.strictEqual(toasts.length, 1, "one settled refresh must report exactly once");
    assert.strictEqual(toasts[0].tone, "success");
  });
}

check("agent-control runs one config-inclusive refresh", async () => {
  const { context, calls, toasts } = createHarness({ page: "agent-control" });
  await context.refreshActiveWorkspace();
  assert.deepStrictEqual(calledNames(calls), ["refreshAgentControl"]);
  assert.deepStrictEqual(calls[0].args, [{ includeConfig: true }], "the agent-control page refresh must include config");
  assert.deepStrictEqual(toasts, [{ message: "Agent Control refreshed.", tone: "success" }]);
});

// --- 2. The files special path ----------------------------------------------
check("files refreshes discovery when disconnected", async () => {
  const { context, calls, toasts } = createHarness({ page: "files", connected: false });
  await context.refreshActiveWorkspace();
  assert.deepStrictEqual(calledNames(calls), ["refreshFilesDiscovery"]);
  assert.deepStrictEqual(toasts, [{ message: "Files refreshed.", tone: "success" }]);
});

check("files refreshes the current directory when connected", async () => {
  const { context, calls, toasts } = createHarness({ page: "files", connected: true });
  await context.refreshActiveWorkspace();
  assert.deepStrictEqual(calledNames(calls), ["refreshCurrentFilesDirectory"]);
  assert.deepStrictEqual(toasts, [{ message: "Files refreshed.", tone: "success" }]);
});

// --- 3. The console special path --------------------------------------------
check("console refreshes instances, then metrics and silent logs", async () => {
  const { context, calls, toasts } = createHarness({ page: "console" });
  await context.refreshActiveWorkspace();
  assert.deepStrictEqual(calls.map((call) => call.name), ["refreshInstances", "refreshConsoleMetrics", "refreshConsoleLogs"], `console called: ${calls.map((call) => call.name).join(", ")}`);
  assert.deepStrictEqual(calls.find((call) => call.name === "refreshConsoleLogs").args, [{ silent: true }]);
  assert.deepStrictEqual(toasts, [{ message: "Monitoring refreshed.", tone: "success" }]);
});

// --- 4. Unmapped pages stay a no-op with the informational toast -------------
check("an unmapped page reports up to date without running any refresher", async () => {
  const { context, calls, toasts } = createHarness({ page: "settings" });
  await context.refreshActiveWorkspace();
  assert.deepStrictEqual(calls, [], "an unmapped page must not run any workspace refresher");
  assert.deepStrictEqual(toasts, [{ message: "Settings is already up to date.", tone: "info" }]);
});

// --- 5. Failure semantics ----------------------------------------------------
check("an all-failed refresh rejects with the first failure and no toast", async () => {
  const first = Object.assign(new Error("nodes refresh failed"), { code: "SMOKE_NODES" });
  const second = new Error("fleet refresh failed");
  const { context, calls, toasts } = createHarness({ page: "nodes", rejections: { refreshNodes: first, refreshFleetSummary: second } });
  await assert.rejects(() => context.refreshActiveWorkspace(), (error) => error === first, "the first rejection must be rethrown");
  assert.deepStrictEqual(calledNames(calls), ["refreshFleetSummary", "refreshNodes"], "both of the page's refreshers must still run");
  assert.deepStrictEqual(toasts, [], "a fully failed refresh must not claim success or warnings");
});

check("a single-task failure rejects with its own reason", async () => {
  const failure = Object.assign(new Error("instances refresh failed"), { code: "SMOKE_INSTANCES" });
  const { context, toasts } = createHarness({ page: "instances", rejections: { refreshInstances: failure } });
  await assert.rejects(() => context.refreshActiveWorkspace(), (error) => error === failure);
  assert.deepStrictEqual(toasts, [], "a fully failed refresh must not toast");
});

check("a partial failure resolves with the warning toast", async () => {
  const { context, calls, toasts } = createHarness({ page: "marketplace", rejections: { refreshMarketplaceDownloads: new Error("downloads failed") } });
  await context.refreshActiveWorkspace();
  assert.deepStrictEqual(calledNames(calls), ["refreshMarketplace", "refreshMarketplaceDownloads"]);
  assert.deepStrictEqual(toasts, [{ message: "Marketplace refreshed with warnings.", tone: "warning" }]);
});

async function main() {
  console.log("Refresh active workspace regression smoke");
  let failures = 0;
  for (const { label, fn } of checks) {
    try {
      await fn();
      console.log(`  ok   ${label}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${label}`);
      console.error(`       ${error.message}`);
    }
  }
  if (failures) {
    console.error(`\nRefresh active workspace regression smoke FAILED (${failures} check(s)).`);
    process.exitCode = 1;
  } else {
    console.log("\nRefresh active workspace regression smoke passed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});