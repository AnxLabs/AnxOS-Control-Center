#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const nodeService = fs.readFileSync(path.join(root, "src", "services", "nodeService.js"), "utf8");
const agentControlService = fs.readFileSync(path.join(root, "src", "services", "agentControlService.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const ipc = fs.readFileSync(path.join(root, "src", "ipc", "agentControlIpc.js"), "utf8");

function functionSpan(source, name, label = name) {
  const marker = source.includes(`async function ${name}`) ? `async function ${name}` : `function ${name}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Missing function: ${label}`);
  const paramsEnd = source.indexOf(")", start);
  const braceStart = source.indexOf("{", paramsEnd);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { start, braceStart, end: index + 1 };
    }
  }
  throw new Error(`Could not parse ${label}`);
}

function functionSource(source, name, label = name) {
  const span = functionSpan(source, name, label);
  return source.slice(span.start, span.end);
}

function functionBody(source, name, label) {
  const span = functionSpan(source, name, label || name);
  return source.slice(span.braceStart, span.end);
}

const appBody = (name) => functionBody(app, name, `renderer function ${name}`);

const pairBody = appBody("pairNodeFromSettings");
assert(app.includes("let nodePairingSubmitInFlight = false"), "Renderer must track in-flight pairing submissions.");
assert(pairBody.includes("nodePairingSubmitInFlight") && pairBody.includes("return;"), "Duplicate click or Enter submissions must be ignored while pairing is in flight.");
assert(pairBody.includes("nodePairingSubmissionSerial"), "Stale asynchronous pairing handlers must be invalidated.");
assert(pairBody.includes("nodePairingLastSubmittedCode"), "Expired or already-submitted pairing codes must be tracked.");
assert(pairBody.includes('nodePairingCodeInput.value = ""') && pairBody.includes("Pairing code expired."), "PAIRING_EXPIRED must clear stale code and show a friendly message.");
assert(pairBody.includes("Generate or paste a new pairing code before trying again."), "Stale codes must not be automatically resubmitted.");
assert(pairBody.includes("confirmUrlChange: options.confirmUrlChange === true"), "URL-change confirmation must use a dedicated confirmation flag.");
assert(pairBody.includes("await pairNodeFromSettings({ confirmUrlChange: true })"), "URL-change confirmation should retry through one explicit path.");
assert(pairBody.match(/await pairNodeFromSettings\(\{ confirmUrlChange: true \}\)/g).length === 1, "URL-change confirmation must retry at most once.");
assert(app.includes("nodePairingCodeInput?.addEventListener(\"input\"") && app.includes("updateNodePairingControls();"), "Pair button state must update only from a single input listener.");
assert(app.includes('pairButton.disabled = nodeFormBusy || nodePairingSubmitInFlight || !String(nodePairingCodeInput?.value || "").trim()'), "Pair must stay disabled until a new code is entered.");
assert.strictEqual((html.match(/data-node-action="pair-code"/g) || []).length, 1, "Pair Agent button should exist once.");
assert.strictEqual((app.match(/addEventListener\("click", pairNodeFromSettings\)/g) || []).length, 1, "Pair Agent click listener should be attached once.");
assert(!app.includes("setInterval(pairNodeFromSettings"), "Pairing must not retry from polling.");

assert(nodeService.indexOf("if (existingById && existingUrl !== agentUrl && payload.confirmUrlChange !== true)") < nodeService.indexOf("const permanentToken = generateAgentToken()"), "URL mismatch must be detected before consuming the pairing session.");
assert(agentControlService.includes("getPairingSessionTarget") && agentControlService.includes("requestedNodeId"), "Pairing generation must resolve an explicit node target.");
// FIX 1 (Build 205): the retired single message ("Pairing code generation was
// not redirected to the Windows Local Agent.") was intentionally replaced by
// local/remote-specific wording. The invariant it protected is unchanged and
// is asserted against the real function now: a failed generation must throw the
// typed PAIRING_AGENT_UNREACHABLE error, must state the specific Agent that was
// unreachable, and must never be retried or rewritten against a localhost URL.
// This smoke's scenario is a remote target, so the remote variant is asserted;
// the local variant must exist too because the same guard serves local mints.
const startPairingBody = functionBody(agentControlService, "startPairingSession", "agentControlService.startPairingSession");
assert(startPairingBody.includes('code: "PAIRING_AGENT_UNREACHABLE"'), "Generation failure must surface the typed PAIRING_AGENT_UNREACHABLE error.");
assert(startPairingBody.includes("Remote Agent at ${mintTarget.agentUrl} is unreachable."), "Remote generation failure must say the remote Agent was unreachable.");
assert(startPairingBody.includes("The Local Agent at ${mintTarget.agentUrl} is unreachable."), "Local generation failure must keep the Local Agent-specific wording.");
assert(!startPairingBody.includes("getLocalAgentUrl"), "Remote generation failure must not construct a localhost fallback URL.");
assert.strictEqual((startPairingBody.match(/fetch\(/g) || []).length, 1, "A failed generation must throw; it must not retry against a localhost endpoint.");
assert(preload.includes('startPairingSession: (payload = {}) => ipcRenderer.invoke("agentControl:startPairingSession", payload)'), "Preload must preserve pairing target payload.");
assert(ipc.includes('agentControl:startPairingSession", (_, payload = {})'), "IPC must preserve pairing target payload.");
assert(html.includes("Pairing Agent") && html.includes("data-agent-pairing-target-url"), "Pairing UI must show target name and address before generation.");
assert(app.includes("getWrongPairingTargetMessage") && app.includes("This code belongs to the"), "Wrong-target pairing codes must produce an in-app error.");
assert(app.includes("activeAgentPairingExpiresAt") && app.includes("activeAgentPairingExpiryTimer"), "Agent Control must track and schedule pairing-code expiration.");
assert(app.includes("Date.parse(activeAgentPairingExpiresAt) <= Date.now()"), "Expired Agent Control pairing codes must be cleared before display or copy.");
assert(pairBody.includes("renderAgentPairingSetup(null, { clearCode: true })"), "A consumed pairing code must be cleared after successful pairing.");

// FIX 2 (Build 205): opt-in state/copy honesty when the Agent is ALREADY
// network-reachable. The service must report that state explicitly, must not
// write the opt-in marker (it does not own a user-configured bind), and the
// renderer must keep the checkbox on while a code from that generation is
// active instead of letting the 3-second poll flip it to the default-off copy.
const enableBody = functionBody(agentControlService, "enableLocalAgentNetworkAccessForPairing", "agentControlService.enableLocalAgentNetworkAccessForPairing");
const reachableBranchStart = enableBody.indexOf("if (plan.currentBindingReachable)");
assert(reachableBranchStart >= 0, "The already-reachable pairing branch must exist.");
const reachableBranchEnd = enableBody.indexOf("const previousHost", reachableBranchStart);
assert(reachableBranchEnd > reachableBranchStart, "The already-reachable branch must end before the widen-and-marker path.");
const reachableBranch = enableBody.slice(reachableBranchStart, reachableBranchEnd);
assert(reachableBranch.includes("alreadyReachable: true") && reachableBranch.includes("changedBinding: false"), "The already-reachable branch must report alreadyReachable=true with changedBinding=false.");
assert(!reachableBranch.includes("saveConfig") && !reachableBranch.includes("PAIRING_NETWORK_OPT_IN_KEY"), "The already-reachable branch must not write an opt-in marker (no config ownership).");
assert(enableBody.includes("alreadyReachable: false"), "The widened path must report alreadyReachable=false explicitly.");
const restorePlanBody = functionBody(agentControlService, "planLocalAgentPairingRestore", "agentControlService.planLocalAgentPairingRestore");
assert(restorePlanBody.includes("fallbackToLoopback: true") && restorePlanBody.includes('host: "127.0.0.1"'), "The restore plan must fall back to loopback when the recorded address is gone.");
assert(restorePlanBody.includes("isBindableAgentHost(recordedHost)"), "The restore fallback must use the shared bind-eligibility rule.");
assert(restorePlanBody.includes("no longer available on this computer"), "The restore fallback must carry a clear note.");
const restoreBody = functionBody(agentControlService, "restoreLocalAgentPairingBinding", "agentControlService.restoreLocalAgentPairingBinding");
assert(restoreBody.includes("saveRestoreConfig") && restoreBody.includes("AGENT_HOST_INVALID"), "Restore must still fall back to loopback if the recorded host becomes invalid at save time.");
assert(agentControlService.includes("pairingNetwork: getLocalAgentPairingNetworkState(local.config)"), "Agent Control listings must expose the service-derived pairing network state to the renderer.");
assert(agentControlService.includes("alreadyReachable: plan.currentBindingReachable === true"), "The derived state must mirror the mint decision.");

// Renderer-level leg: run the real checkbox decision function, extracted from
// app.js, against the poll scenarios that used to flip the state.
const shouldShowNetworkEnabled = new Function(`${functionSource(app, "shouldShowAgentPairingNetworkEnabled", "app.js.shouldShowAgentPairingNetworkEnabled")}; return shouldShowAgentPairingNetworkEnabled;`)();
assert.strictEqual(shouldShowNetworkEnabled({ persisted: false, userChoice: null, alreadyReachableActive: true }), true, "The 3-second poll must keep the checkbox on while an already-reachable code is active.");
assert.strictEqual(shouldShowNetworkEnabled({ persisted: false, userChoice: null, alreadyReachableActive: false }), false, "Default-off must stay off with no marker and no already-reachable code.");
assert.strictEqual(shouldShowNetworkEnabled({ persisted: true, userChoice: null, alreadyReachableActive: false }), true, "A persisted opt-in marker must keep the checkbox on.");
assert.strictEqual(shouldShowNetworkEnabled({ persisted: true, userChoice: false, alreadyReachableActive: true }), false, "The user's uncommitted choice must still win over the poll.");
assert(app.includes("isActiveAgentPairingAlreadyReachable"), "The renderer must derive the already-reachable display state from the active network-aware code.");
assert(app.includes("On (this Agent already accepts connections on your network)"), "The already-reachable checked state must use the distinct honest note.");
assert(app.includes("This Agent already accepts network connections, so its listening setting will not change."), "The confirmation dialog must not promise a restore when the Agent is already reachable.");
assert(app.includes("getLocalPairingNetworkOverviewState"), "The dialog must read the service-derived reachability state.");
assert(app.includes("network.restoreNote"), "The renderer must surface the loopback restore note.");

console.log("Expired pairing single-submit smoke checks passed.");
