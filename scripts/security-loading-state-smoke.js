const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert(start >= 0, `Could not find ${name}.`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

async function runScenario({ status, dashboard }) {
  const renders = [];
  const requestSerials = new Map();
  const context = {
    SECURITY_REQUEST_TIMEOUT_MS: 20,
    securityState: null,
    securityDashboardState: null,
    dashboardHandler: dashboard,
    getDesktopApiState: () => ({
      hasSecurity: true,
      api: {
        security: { getStatus: status, getDashboard: (...args) => context.dashboardHandler(...args, context) },
        diagnostics: { capture: () => Promise.resolve() },
      },
    }),
    selectedNodeId: "fixture",
    selectedNodeVersion: 1,
    getNodeRequestContext: (label) => {
      const serial = (requestSerials.get(label) || 0) + 1;
      requestSerials.set(label, serial);
      return { label, nodeId: context.selectedNodeId, version: context.selectedNodeVersion, serial };
    },
    getNodeScopedPayload: (request) => ({ nodeId: request.nodeId }),
    isNodeRequestCurrent: (request) => request.nodeId === context.selectedNodeId
      && request.version === context.selectedNodeVersion
      && requestSerials.get(request.label) === request.serial,
    withTimeout: (promise, ms, message, code) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(message), { code })), ms)),
    ]),
    normalizeIpcErrorMessage: (error, fallback) => error?.message || fallback,
    renderSecurityState: () => renders.push(context.securityDashboardState),
    refreshSettingsPermissions: () => Promise.resolve(),
    syncSecurityEventNotifications: () => {},
    isOwnerWorkspaceAuthorized: () => false,
    refreshOwnerWorkspace: () => Promise.resolve(),
    ownerWorkspaceState: { pages: [] },
    console: { warn: () => {} },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction("refreshSecurityState")}; this.refreshSecurityState = refreshSecurityState;`, context);
  await context.refreshSecurityState();
  return { state: context.securityDashboardState, renders, context };
}

async function main() {
  const stalledStatus = await runScenario({
    status: () => new Promise(() => {}),
    dashboard: () => Promise.resolve({ overview: { status: "Secure" } }),
  });
  assert.strictEqual(stalledStatus.state.requestState, "bounded-error", "A stalled status request must resolve to a bounded error.");
  assert.strictEqual(stalledStatus.renders.length, 1, "A stalled status request must render its terminal state.");

  // Since the Local Owner authentication model (Build 203), the security
  // dashboard request is gated on status.localOwnerAuthenticated === true.
  // Scenarios exercising dashboard error/loading states present a
  // locally-authenticated status; a status without it lands "unauthorized".
  const unavailableDashboard = await runScenario({
    status: () => Promise.resolve({ authenticated: true, localOwnerAuthenticated: true }),
    dashboard: () => Promise.reject(Object.assign(new Error("Service unavailable"), { code: "SERVICE_UNAVAILABLE" })),
  });
  assert.strictEqual(unavailableDashboard.state.requestState, "unavailable");

  const unauthorizedDashboard = await runScenario({
    status: () => Promise.resolve({ authenticated: true }),
    dashboard: () => Promise.resolve({ overview: { status: "Secure" }, events: [] }),
  });
  assert.strictEqual(unauthorizedDashboard.state.requestState, "unauthorized", "A status without local owner authentication must gate the dashboard request.");
  assert.match(String(unauthorizedDashboard.state.error || ""), /[Ll]ocal [Oo]wner authentication is required/, "The unauthorized state must name the local owner gate.");

  const loadedDashboard = await runScenario({
    status: () => Promise.resolve({ authenticated: true, localOwnerAuthenticated: true }),
    dashboard: () => Promise.resolve({ overview: { status: "Secure" }, events: [] }),
  });
  assert.strictEqual(loadedDashboard.state.requestState, "loaded");
  assert.strictEqual(loadedDashboard.renders.length, 1);

  const stalePreviousNode = await runScenario({
    status: () => Promise.resolve({ authenticated: true, localOwnerAuthenticated: true }),
    dashboard: (payload, scenarioContext) => {
      scenarioContext.selectedNodeId = "new-node";
      scenarioContext.selectedNodeVersion += 1;
      return Promise.resolve({ overview: { status: "Secure" }, events: [] });
    },
  });
  assert.strictEqual(stalePreviousNode.state, null, "A response for a previous node must remain discarded.");
  assert.strictEqual(stalePreviousNode.renders.length, 0, "A stale previous-node response must not render.");

  stalePreviousNode.context.dashboardHandler = () => Promise.resolve({ overview: { status: "Secure" }, events: [] });
  await stalePreviousNode.context.refreshSecurityState();
  assert.strictEqual(stalePreviousNode.context.securityDashboardState.requestState, "loaded", "A replacement request for the current node must store loaded state.");
  assert.strictEqual(stalePreviousNode.renders.length, 1, "A replacement current-node response must render exactly once.");

  assert(source.includes('if (safePageName === "security")') && source.includes("refreshSecurityState();"), "Opening Security must issue a request for the current restored node.");

  console.log("Security loading-state smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
