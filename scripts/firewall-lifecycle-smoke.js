// V2-H firewall lifecycle smoke (hermetic).
//
// Proves the bounded firewall-rule surface introduced for the V2-H
// "network/firewall rules with previews and a recovery path" milestone:
//   - preview content matches the shared platform builder and flags lockout risk
//   - applying a management-port rule requires elevated confirmation
//   - the rollback guard removes the rule when the Agent becomes unreachable
//   - no rollback is attempted when the Agent stays reachable
//   - a failed rollback is reported honestly with the manual fallback command
//   - inventory/delete only ever touch AnxOS-managed rules
//   - a non-Windows platform is reported as unsupported, never as an error
//
// The firewall command executor and the Agent reachability probe are injected,
// so the smoke never runs netsh/powershell and never contacts a real Agent.
// Ends with "firewall-lifecycle-smoke passed".
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
// Pin runtime roots BEFORE requiring any src/ service, or the registry/service
// layers can write into the real machine root.
const smokeRoot = pinAgentRoots("anx-firewall-lifecycle-smoke-");

const root = path.resolve(__dirname, "..");
const servicePath = path.join(root, "src", "services", "publicAccessProviderService.js");
const agentRoutePath = path.join(root, "agent", "src", "routes", "publicAccess.js");
const agentClientPath = path.join(root, "src", "services", "agentClient.js");
const preloadPath = path.join(root, "preload.js");
const ipcPath = path.join(root, "src", "ipc", "publicAccessIpc.js");

const desktopService = require("../src/services/publicAccessProviderService");
const agentRoute = require("../agent/src/routes/publicAccess");
const agentClientSource = fs.readFileSync(agentClientPath, "utf8");
const serviceSource = fs.readFileSync(servicePath, "utf8");
const agentRouteSource = fs.readFileSync(agentRoutePath, "utf8");
const preloadSource = fs.readFileSync(preloadPath, "utf8");
const ipcSource = fs.readFileSync(ipcPath, "utf8");

// ---------------------------------------------------------------------------
// 1. Preview content + lockout-risk detection (desktop-side, no executor).
// ---------------------------------------------------------------------------
const safePreview = desktopService.buildWindowsFirewallRulePreview(
  { localPort: 25565, protocol: "tcp", name: "AnxOS Smoke TCP 25565" },
  { platform: "win32", agentPort: 47131, sshPort: 22 },
);
assert.strictEqual(safePreview.supported, true, "A Windows preview must be supported on win32.");
assert.strictEqual(safePreview.previewable, true, "A valid rule must be previewable.");
assert.strictEqual(safePreview.rule.protocol, "TCP", "Preview must report the normalized protocol.");
assert.strictEqual(safePreview.rule.port, 25565, "Preview must report the numeric port.");
assert.strictEqual(safePreview.rule.direction, "in", "Preview must report an inbound rule.");
assert.strictEqual(safePreview.rule.action, "allow", "Preview must report an allow rule.");
assert.strictEqual(safePreview.rule.program, null, "The builder does not scope by program; preview must not imply one.");
assert.strictEqual(safePreview.rule.programScopeSupported, false, "Preview must state program scoping is unsupported.");
assert(safePreview.rule.command.startsWith("netsh advfirewall firewall add rule"), `Preview must expose the exact builder command (${safePreview.rule.command}).`);
assert(safePreview.rule.command.includes("name=AnxOS Smoke TCP 25565"), "Preview command must carry the AnxOS rule name.");
assert.strictEqual(safePreview.lockoutRisk.risky, false, "A normal service port must not be flagged as a lockout risk.");

const agentPortPreview = desktopService.buildWindowsFirewallRulePreview(
  { localPort: 47131, protocol: "tcp" },
  { platform: "win32", agentPort: 47131, sshPort: 22 },
);
assert.strictEqual(agentPortPreview.lockoutRisk.risky, true, "The Agent port must be flagged as a lockout risk.");
assert(agentPortPreview.lockoutRisk.reasons.some((reason) => reason.code === "AGENT_PORT"), "The Agent-port risk reason must be explicit.");
assert(agentPortPreview.summary.includes("LOCKOUT RISK"), "Preview summary must loudly flag lockout risk.");

const sshPreview = desktopService.buildWindowsFirewallRulePreview(
  { localPort: 22, protocol: "tcp" },
  { platform: "win32", agentPort: 47131, sshPort: 22 },
);
assert.strictEqual(sshPreview.lockoutRisk.risky, true, "The SSH port must be flagged as a lockout risk.");
assert(sshPreview.lockoutRisk.reasons.some((reason) => reason.code === "SSH_PORT"), "The SSH-port risk reason must be explicit.");

const managementPortPreview = desktopService.buildWindowsFirewallRulePreview(
  { localPort: 9100, protocol: "tcp" },
  { platform: "win32", agentPort: 47131, sshPort: 22, managementPorts: [9100] },
);
assert.strictEqual(managementPortPreview.lockoutRisk.risky, true, "A currently-used management port must be flagged.");
assert(managementPortPreview.lockoutRisk.reasons.some((reason) => reason.code === "MANAGEMENT_PORT"), "The management-port risk reason must be explicit.");

// ---------------------------------------------------------------------------
// 2. List / delete only touch AnxOS-managed rules (agent route, injected executor).
// ---------------------------------------------------------------------------
assert.strictEqual(agentRoute._test.isAnxOsManagedFirewallRuleName("AnxOS TCP 25565"), true, "AnxOS-prefixed rules are managed.");
assert.strictEqual(agentRoute._test.isAnxOsManagedFirewallRuleName("Random Vendor Rule"), false, "Unmanaged rules must not be treated as AnxOS rules.");
assert.strictEqual(agentRoute._test.isAnxOsManagedFirewallRuleName("AnxOS "), false, "An empty AnxOS name must not be treated as a managed rule.");

const parsedRules = agentRoute._test.parseManagedFirewallRuleList(JSON.stringify([
  { name: "AnxOS TCP 25565", direction: "Inbound", action: "Allow", enabled: "True", protocol: "TCP", localPort: "25565" },
  { name: "Third Party Rule", direction: "Inbound", action: "Allow", enabled: "True", protocol: "TCP", localPort: "3389" },
]));
assert.strictEqual(parsedRules.length, 1, "Inventory must drop rules that are not AnxOS-managed.");
assert.strictEqual(parsedRules[0].name, "AnxOS TCP 25565", "Inventory must keep the AnxOS rule.");
assert.strictEqual(parsedRules[0].localPort, 25565, "Inventory must normalize the local port.");
assert.strictEqual(parsedRules[0].deletableByAnxOS, true, "AnxOS rules must be flagged as deletable.");
assert.strictEqual(agentRoute._test.parseManagedFirewallRuleList("").length, 0, "Empty inventory output must parse to zero rules.");

async function assertManagedRuleIsolation() {
  // Unmanaged delete is refused before any command runs, on every platform.
  let unmanagedExecuted = false;
  await assert.rejects(
    () => agentRoute._test.deleteWindowsFirewallRule({ name: "Third Party Rule" }, { runCommand: async () => { unmanagedExecuted = true; return { ok: true, stdout: "", stderr: "" }; } }),
    (error) => error?.code === "FIREWALL_RULE_UNMANAGED",
    "AnxOS must refuse to delete a rule it did not create.",
  );
  assert.strictEqual(unmanagedExecuted, false, "A refused unmanaged delete must not run any firewall command.");

  if (process.platform === "win32") {
    const commands = [];
    const result = await agentRoute._test.deleteWindowsFirewallRule(
      { name: "AnxOS TCP 25565" },
      { runCommand: async (command, args) => { commands.push({ command, args }); return { ok: true, stdout: "", stderr: "" }; } },
    );
    assert.strictEqual(result.ok, true, "A managed delete must succeed with an injected executor.");
    assert.strictEqual(commands.length, 1, "A managed delete must run exactly one firewall command.");
    assert.strictEqual(commands[0].command, "netsh.exe", "Managed delete must use netsh.");
    assert(commands[0].args.includes("delete") && commands[0].args.includes("name=AnxOS TCP 25565"), "Managed delete must target the named rule.");
  }
}

// ---------------------------------------------------------------------------
// 3. Apply-with-rollback guard (desktop orchestrator, injected transport + probe).
// ---------------------------------------------------------------------------
function makeRecordingTransport(overrides = {}) {
  const calls = { created: [], deleted: [], listed: [] };
  return {
    calls,
    createWindowsFirewallRule: async (payload) => {
      calls.created.push(payload);
      return { ok: true, rule: { name: payload.name, protocol: String(payload.protocol || "tcp").toUpperCase(), localPort: payload.localPort } };
    },
    deleteWindowsFirewallRule: async (payload) => {
      calls.deleted.push(payload);
      if (overrides.deleteError) throw overrides.deleteError;
      return { ok: true, deleted: { name: payload.name } };
    },
    listWindowsFirewallRules: async () => {
      calls.listed.push(true);
      return { ok: true, supported: true, platform: "win32", rules: [] };
    },
  };
}

async function assertApplyGuard() {
  // Risky rule without elevated confirmation must be refused before any create.
  const refusedTransport = makeRecordingTransport();
  await assert.rejects(
    () => desktopService.applyWindowsFirewallRule(
      { localPort: 47131, protocol: "tcp", name: "AnxOS Smoke TCP 47131" },
      { platform: "win32", config: null, transport: refusedTransport, rollbackDelayMs: 0, reachabilityProbe: async () => true },
    ),
    (error) => error?.code === "FIREWALL_ELEVATED_CONFIRM_REQUIRED",
    "Applying a management-port rule must require elevated confirmation.",
  );
  assert.strictEqual(refusedTransport.calls.created.length, 0, "A refused risky apply must not create a rule.");

  // Safe rule applies without elevated confirmation and needs no rollback.
  const safeTransport = makeRecordingTransport();
  const safeApply = await desktopService.applyWindowsFirewallRule(
    { localPort: 25565, protocol: "tcp", name: "AnxOS Smoke TCP 25565" },
    { platform: "win32", config: null, transport: safeTransport, rollbackDelayMs: 0, reachabilityProbe: async () => true },
  );
  assert.strictEqual(safeApply.rollback.status, "not-needed", "A safe rule needs no rollback guard.");
  assert.strictEqual(safeTransport.calls.created.length, 1, "A safe rule must be created exactly once.");
  assert.strictEqual(safeTransport.calls.deleted.length, 0, "A safe rule must never be auto-deleted.");

  // Risky rule + reachable Agent: no rollback.
  const reachableTransport = makeRecordingTransport();
  const reachableApply = await desktopService.applyWindowsFirewallRule(
    { localPort: 47131, protocol: "tcp", name: "AnxOS Smoke TCP 47131", confirmElevated: true },
    { platform: "win32", config: null, transport: reachableTransport, rollbackDelayMs: 0, reachabilityProbe: async () => true },
  );
  assert.strictEqual(reachableApply.rollback.status, "not-needed", "A reachable Agent must not trigger a rollback.");
  assert.strictEqual(reachableTransport.calls.deleted.length, 0, "A reachable Agent must leave the rule in place.");

  // Risky rule + unreachable Agent: rule is removed and reported honestly.
  const rollbackTransport = makeRecordingTransport();
  const rollbackApply = await desktopService.applyWindowsFirewallRule(
    { localPort: 47131, protocol: "tcp", name: "AnxOS Smoke TCP 47131", confirmElevated: true },
    { platform: "win32", config: null, transport: rollbackTransport, rollbackDelayMs: 0, reachabilityProbe: async () => false },
  );
  assert.strictEqual(rollbackApply.rollback.status, "rolled-back", "An unreachable Agent must trigger the rollback.");
  assert.strictEqual(rollbackTransport.calls.deleted.length, 1, "The rollback must delete exactly the new rule.");
  assert.strictEqual(rollbackTransport.calls.deleted[0].name, "AnxOS Smoke TCP 47131", "The rollback must delete the rule AnxOS just created.");
  assert(rollbackApply.rollback.manualCommand.includes("netsh advfirewall firewall delete rule"), "A rollback must report the manual fallback command.");

  // Risky rule + unreachable Agent + delete failure: reported honestly.
  const failingTransport = makeRecordingTransport({ deleteError: Object.assign(new Error("netsh unavailable"), { code: "FIREWALL_RULE_DELETE_FAILED" }) });
  const failingApply = await desktopService.applyWindowsFirewallRule(
    { localPort: 47131, protocol: "tcp", name: "AnxOS Smoke TCP 47131", confirmElevated: true },
    { platform: "win32", config: null, transport: failingTransport, rollbackDelayMs: 0, reachabilityProbe: async () => false },
  );
  assert.strictEqual(failingApply.rollback.status, "rollback-failed", "A failed rollback must be reported, never hidden.");
  assert(failingApply.rollback.manualCommand.includes("name=\"AnxOS Smoke TCP 47131\""), "A failed rollback must include the exact manual command.");
  assert.strictEqual(failingApply.rollback.errorCode, "FIREWALL_RULE_DELETE_FAILED", "A failed rollback must preserve the failure code.");
}

// ---------------------------------------------------------------------------
// 4. Vertical slice through the real Agent route with an injected executor.
// ---------------------------------------------------------------------------
async function assertAgentBoundarySlice() {
  if (process.platform !== "win32") return;
  const executorCommands = [];
  const executor = async (command, args) => { executorCommands.push({ command, args }); return { ok: true, stdout: "", stderr: "" }; };
  const listExecutor = async () => ({
    ok: true,
    stdout: JSON.stringify([{ name: "AnxOS TCP 25565", direction: "Inbound", action: "Allow", enabled: "True", protocol: "TCP", localPort: "25565" }]),
    stderr: "",
  });
  const transport = {
    createWindowsFirewallRule: (payload) => agentRoute._test.createWindowsFirewallRule(payload, { runCommand: executor }),
    deleteWindowsFirewallRule: (payload) => agentRoute._test.deleteWindowsFirewallRule(payload, { runCommand: executor }),
    listWindowsFirewallRules: () => agentRoute._test.listWindowsFirewallRules({ runCommand: listExecutor }),
  };
  const applied = await desktopService.applyWindowsFirewallRule(
    { localPort: 47131, protocol: "tcp", name: "AnxOS Smoke TCP 47131", confirmElevated: true },
    { platform: "win32", config: null, transport, rollbackDelayMs: 0, reachabilityProbe: async () => false },
  );
  assert.strictEqual(applied.rollback.status, "rolled-back", "The full desktop->Agent slice must roll back through the real route delete.");
  const createCommand = executorCommands.find((entry) => entry.args.includes("add"));
  const deleteCommand = executorCommands.find((entry) => entry.args.includes("delete"));
  assert(createCommand && createCommand.command === "netsh.exe", "The slice must create the rule with netsh.");
  assert(deleteCommand && deleteCommand.args.includes("name=AnxOS Smoke TCP 47131"), "The slice must delete the created AnxOS rule.");

  const listed = await desktopService.listWindowsFirewallRules({ nodeId: "anxlab" }, { platform: "win32", config: null, transport });
  assert.strictEqual(listed.supported, true, "The slice must list supported rules on win32.");
  assert.strictEqual(listed.rules.length, 1, "The slice must return the injected AnxOS rule.");
  assert.strictEqual(listed.rules[0].name, "AnxOS TCP 25565", "The slice must return the managed rule name.");
}

// ---------------------------------------------------------------------------
// 5. Unsupported-platform honesty (no-op, never an error).
// ---------------------------------------------------------------------------
function assertUnsupportedPlatformHonesty() {
  const linuxPreview = desktopService.buildWindowsFirewallRulePreview({ localPort: 25565, protocol: "tcp" }, { platform: "linux" });
  assert.strictEqual(linuxPreview.supported, false, "A non-Windows preview must report unsupported.");
  assert.strictEqual(linuxPreview.previewable, false, "A non-Windows preview must not claim a previewable rule.");
  assert.strictEqual(linuxPreview.rule, null, "A non-Windows preview must not invent a rule.");
  assert(!linuxPreview.error, "A non-Windows preview must not be reported as an error.");
}

async function assertUnsupportedPlatformListDelete() {
  const listed = await desktopService.listWindowsFirewallRules({ nodeId: "anxlab" }, { platform: "linux", config: null, transport: { listWindowsFirewallRules: async () => { throw new Error("must not be called"); } } });
  assert.strictEqual(listed.ok, true, "Non-Windows list must resolve ok, not throw.");
  assert.strictEqual(listed.supported, false, "Non-Windows list must report unsupported.");
  assert.deepStrictEqual(listed.rules, [], "Non-Windows list must return no rules.");

  const deleted = await desktopService.deleteWindowsFirewallRule({ nodeId: "anxlab", name: "AnxOS TCP 25565" }, { platform: "linux", config: null, transport: { deleteWindowsFirewallRule: async () => { throw new Error("must not be called"); } } });
  assert.strictEqual(deleted.ok, true, "Non-Windows delete must resolve ok, not throw.");
  assert.strictEqual(deleted.supported, false, "Non-Windows delete must report unsupported.");
  assert.strictEqual(deleted.deleted, null, "Non-Windows delete must not claim a deletion.");

  // An older Agent without the inventory endpoint must be reported honestly as
  // unsupported, not as a transport failure, and must not invent any rules.
  const legacyListed = await desktopService.listWindowsFirewallRules(
    { nodeId: "anxlab" },
    { platform: "win32", config: null, transport: { listWindowsFirewallRules: async () => { throw Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 }); } } },
  );
  assert.strictEqual(legacyListed.ok, true, "A missing inventory endpoint must resolve ok.");
  assert.strictEqual(legacyListed.supported, false, "A missing inventory endpoint must report unsupported.");
  assert.deepStrictEqual(legacyListed.rules, [], "A missing inventory endpoint must not invent rules.");
  assert(/Update the Agent/.test(legacyListed.message), "A missing inventory endpoint must tell the operator to update the Agent.");
}

// ---------------------------------------------------------------------------
// 6. Wiring: routes, transport wrappers and IPC/preload bridges exist.
// ---------------------------------------------------------------------------
assert(agentRouteSource.includes('request.method === "GET"') && agentRouteSource.includes("listWindowsFirewallRules"), "The Agent must serve firewall inventory over GET.");
assert(agentRouteSource.includes('request.method === "DELETE"') && agentRouteSource.includes("deleteWindowsFirewallRule"), "The Agent must serve firewall deletion over DELETE.");
assert(agentRouteSource.includes("MANAGED_RULE_PREFIX = \"AnxOS \""), "The Agent must keep the AnxOS managed-rule marker.");
assert(agentClientSource.includes("listWindowsFirewallRules") && agentClientSource.includes("deleteWindowsFirewallRule"), "The Agent client must expose firewall inventory/deletion wrappers.");
assert(serviceSource.includes("applyWindowsFirewallRule") && serviceSource.includes("FIREWALL_ELEVATED_CONFIRM_REQUIRED"), "The desktop service must gate risky applies behind elevated confirmation.");
assert(serviceSource.includes("buildManualFirewallRuleDeleteCommand"), "The desktop service must expose the manual rollback command.");
assert(preloadSource.includes("publicAccess:previewFirewallRule") && preloadSource.includes("publicAccess:applyFirewallRule"), "Preload must bridge the firewall preview/apply channels.");
assert(preloadSource.includes("publicAccess:listFirewallRules") && preloadSource.includes("publicAccess:deleteFirewallRule"), "Preload must bridge the firewall list/delete channels.");
assert(ipcSource.includes("publicAccess:previewFirewallRule") && ipcSource.includes("publicAccess:listFirewallRules"), "IPC must register the firewall preview/list channels.");
assert(ipcSource.includes("publicAccess:applyFirewallRule") && ipcSource.includes("publicAccess:deleteFirewallRule"), "IPC must register the firewall apply/delete channels.");

(async () => {
  await assertManagedRuleIsolation();
  await assertApplyGuard();
  await assertAgentBoundarySlice();
  assertUnsupportedPlatformHonesty();
  await assertUnsupportedPlatformListDelete();
  console.log("firewall-lifecycle-smoke passed");
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  process.exit(1);
});
