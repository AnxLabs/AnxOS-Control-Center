const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Static UI contract smoke for the final renderer workstream: node details
// connectivity, the operational-notification bridge, telemetry Settings, and
// backup verification. Follows the ui-polish-smoke conventions: CRLF is
// normalized and every check is a presence/absence assertion over source text.
const root = path.resolve(__dirname, "..");
const normalize = (value) => value.replace(/\r\n/g, "\n");
const readSource = (relativePath) => normalize(fs.readFileSync(path.join(root, relativePath), "utf8"));

const index = readSource("index.html");
const app = readSource("app.js");
const styles = readSource("styles.css");

function assertOnce(haystack, needle, label) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...haystack.matchAll(new RegExp(`${escaped}(?![\\w-])`, "g"))].length;
  assert.strictEqual(matches, 1, `${label} must appear exactly once (found ${matches}).`);
}

function requireStyle(selector, label) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert(new RegExp(`${escaped}(?![\\w-])`).test(styles), `${label} must be defined in styles.css (${selector}).`);
}

// ---------------------------------------------------------------------------
// A. Node details connectivity section
// ---------------------------------------------------------------------------
assert(index.includes("data-node-connectivity"), "The node details drawer must include the connectivity section.");
["summary", "endpoints", "stale"].forEach((part) => {
  assertOnce(index, `data-node-connectivity-${part}`, `Node connectivity ${part} hook`);
});
assert(
  /data-node-connectivity-stale[^>]*hidden/.test(index),
  "The connectivity stale notice must start hidden.",
);
["refresh", "open-network", "add-endpoint"].forEach((action) => {
  assertOnce(index, `data-node-connectivity-action="${action}"`, `Node connectivity action ${action}`);
});
assert(
  index.indexOf("settings-section--node-health") < index.indexOf("data-node-connectivity>"),
  "The connectivity section must follow the Node Health section in the drawer.",
);

assert(app.includes("function renderNodeConnectivity(nodeId)"), "app.js must define renderNodeConnectivity(nodeId).");
assert(app.includes("renderNodeConnectivity(node.id);"), "openNodeDetails must render the connectivity section.");
assert(
  /if \(nodeDetailsId && nodeDetailsModal && !nodeDetailsModal\.hidden\) \{[\s\S]{0,160}renderNodeConnectivity\(nodeDetailsId\)/.test(app),
  "refreshNodeHealth must refresh the connectivity section while the drawer is open.",
);
assert(
  app.includes("api.computers.getSummary({ nodeId: requestedId })"),
  "The connectivity section must read the computer summary through api.computers.getSummary.",
);
assert(
  app.includes("typeof api?.computers?.getSummary !== \"function\"") === false &&
    app.includes("typeof api?.computers?.getSummary === \"function\""),
  "The computer summary read must be capability-guarded.",
);
assert(
  app.includes("buildNodeConnectivityFallbackSummary(requestedId, await api.endpoints.list({ nodeId: requestedId }))"),
  "The fallback path must read api.endpoints.list({ nodeId }) with the loaded node record.",
);
assert(
  app.includes('`Showing last known state (as of ${formatDateTime(lastContact)}).`'),
  "The stale rule must render the last known state with a localized lastContact.",
);
assert(
  app.includes("createConnectivityPill(getNodeConnectivityEndpointState(endpoint))"),
  "Endpoint rows must render the shared connectivity state pill from endpoint.health.state.",
);
assert(
  app.includes("openEndpointModal(null, { computerId: prefillNodeId });"),
  "Add Endpoint must open the endpoint modal prefilled with the node computerId.",
);
assert(app.includes('showPage("network");') && app.includes('if (action === "open-network")'), "Open Network must navigate to the Network page.");
assert(!/\bwindow\.(confirm|alert|prompt)\b/.test(app), "Renderer workflows must not use browser confirm, alert, or prompt dialogs.");

// ---------------------------------------------------------------------------
// B. Operational notification bridge
// ---------------------------------------------------------------------------
["syncOperationalNotifications", "mergeOperationalNotificationEvents", "ensureOperationalNotificationRefreshTask"].forEach((name) => {
  assert(app.includes(`function ${name}(`), `app.js must define ${name}().`);
});
assert(app.includes("operationalNotificationSyncInFlight") && app.includes("operationalNotificationSyncError"), "The bridge must keep in-flight and renderer error state.");
assert(app.includes('OPERATIONAL_NOTIFICATION_DEDUP_PREFIX = "op:"'), "Operational notifications must dedupe on the op:<id> prefix.");
assert(app.includes("${OPERATIONAL_NOTIFICATION_DEDUP_PREFIX}${eventId}"), "The dedup key must be op:<event id>.");
assert(app.includes("api.list({ limit: 50 })"), "The bridge must read api.notifications.list({ limit: 50 }).");
assert(
  app.includes('agent: "Agent"') && app.includes('service: "Nodes"') && app.includes('provider: "Nodes"') && app.includes('endpoint: "Nodes"') && app.includes('backup: "Backups"'),
  "Operational categories must map onto the existing Notification Center categories.",
);
["open-nodes", "open-network", "open-instance"].forEach((actionId) => {
  assert(app.includes(`"${actionId}":`), `The notification action allowlist must include ${actionId}.`);
});
assert(app.includes("selectInstance(notification.relatedInstanceId)"), "open-instance must select the event's instance.");
assert(app.includes('showPage("nodes")') && app.includes('showPage("network")'), "open-nodes and open-network must navigate to their pages.");
assert(app.includes("— recovered"), "Resolved events must annotate the existing notification with — recovered.");
assert(
  /if \(event\?\.resolvedAt\) \{[\s\S]{0,240}if \(!existing\) return;/.test(app),
  "A resolved event without a mirrored notification must be skipped, not re-created.",
);
assert(
  app.includes("syncOperationalNotifications();\n  ensureOperationalNotificationRefreshTask();"),
  "bootstrapApplication must start the bridge and its refresh task after settings load.",
);
assert(
  /if \(safePageName === "notifications"\) \{[\s\S]{0,160}syncOperationalNotifications\(\);/.test(app),
  "Activating the Notifications page must sync operational events.",
);
assert(
  /registerRefreshTask\(\(\) => \{[\s\S]{0,200}getActivePageName\(\) === "notifications"[\s\S]{0,160}\}, 60000\);/.test(app),
  "The bridge must register one 60000 ms Notifications refresh task.",
);
assert(
  /function ensureOperationalNotificationRefreshTask\(\) \{[\s\S]{0,220}if \(operationalNotificationRefreshTaskRegistered\) return;/.test(app),
  "The refresh task registration must be guarded against duplicates.",
);

// ---------------------------------------------------------------------------
// C. Telemetry Settings UI
// ---------------------------------------------------------------------------
[
  'data-setting="telemetry.enabled"',
  'data-setting="telemetry.samplingIntervalMs"',
  'data-setting="telemetry.retentionDays"',
].forEach((hook) => assertOnce(index, hook, `Telemetry setting ${hook}`));
assert(
  index.includes('data-settings-category="performance"') && /data-settings-keywords="[^"]*telemetry/.test(index),
  "The Performance section must advertise telemetry in its settings keywords.",
);
["60000", "120000", "300000", "600000"].forEach((value) => {
  assert(index.includes(`<option value="${value}">`), `The sampling interval select must offer ${value}.`);
});
["1 min", "2 min", "5 min", "10 min"].forEach((label) => {
  assert(index.includes(`>${label}</option>`), `The sampling interval select must label ${label}.`);
});
assert(
  /data-setting="telemetry.retentionDays"[^>]*min="1"[^>]*max="30"|type="number" min="1" max="30" data-setting="telemetry\.retentionDays"/.test(index),
  "Retention days must be a bounded number input (1..30).",
);
assert(index.includes("Bounded local sampling; no high-frequency polling."), "The telemetry group must explain its bounded local sampling.");
assert(
  app.includes('"telemetry.enabled": true') && app.includes('"telemetry.samplingIntervalMs": 120000') && app.includes('"telemetry.retentionDays": 7'),
  "DEFAULT_SETTINGS must mirror the trusted telemetry defaults.",
);

// ---------------------------------------------------------------------------
// D. Backup verification UI
// ---------------------------------------------------------------------------
assert(index.includes("<th>Verification</th>"), "The backup history table must expose a Verification column.");
assert(app.includes('pill.dataset.backupVerification = normalized;'), "Backup pills must carry data-backup-verification.");
assert(
  app.includes("BACKUP_VERIFICATION_STATES") && app.includes('Object.freeze(["unverified", "verified", "failed", "corrupt", "unknown"])'),
  "The verification state vocabulary must stay frozen.",
);
assert(app.includes('verifyButton.dataset.backupAction = "verify";'), "Each backup row must expose a Verify button hook.");
assert(app.includes('verifyButton.setAttribute("aria-label", "Verify backup integrity");'), "The Verify button must keep its accessible name.");
assert(app.includes("verifyButton.disabled = verificationPending;"), "The Verify button must be disabled while in-flight.");
assert(
  app.includes("api.backups.verify(id, { nodeId: getSelectedNodeId(), instanceId: backup.instanceId || null })"),
  "Verify must call api.backups.verify(backupId, { nodeId, instanceId }).",
);
assert(app.includes('showToast("Verification is unavailable in this build.");'), "A missing verify channel must render the honest toast.");
assert(app.includes("getBackupVerificationFailureMessage(state, result?.code)"), "Failed verifications must explain themselves through the friendly message.");
// The pill must never derive "Verified" from anything other than the exact state.
assert(
  app.includes('// NEVER display "Verified" unless the normalized state is exactly'),
  "The verification pill must document the never-claim-verified rule.",
);
assert(
  app.includes('const normalized = BACKUP_VERIFICATION_STATES.includes(state) ? state : "unknown";') &&
    app.includes('createTextElement("span", labels[normalized], `status-pill backup-verification-pill'),
  "The verification pill must derive its label only from the normalized state.",
);
assert(
  app.includes("will replace the current instance data") && app.includes("Files created or changed since this backup was taken are overwritten."),
  "Restore confirmation must state that current data is overwritten.",
);
assert(
  /confirmDestructiveAction\(\{[\s\S]{0,200}title: "Restore this backup\?"/.test(app),
  "Restore must keep using confirmDestructiveAction().",
);

// ---------------------------------------------------------------------------
// E. Diagnostics toast honesty (F7) + verification fallback honesty (F8)
// ---------------------------------------------------------------------------
assert(app.includes("function getConnectivityToastTone(state)"), "app.js must derive the diagnostics toast tone from the observed state.");
assert(
  app.includes('if (normalized === "healthy") return "success";') &&
    app.includes('if (normalized === "failed") return "error";') &&
    app.includes('if (normalized === "degraded" || normalized === "unknown") return "warning";'),
  "The toast tone map must follow healthy->success, failed->error, degraded/unknown->warning.",
);
assert(
  !app.includes('showToast(`Endpoint test finished: ${networkStateLabel(overallState)}.`, "success")'),
  "A diagnostics/test toast must never hardcode the success tone.",
);
assert(
  !app.includes('"Endpoint connectivity test finished.", "success"') &&
    !app.includes('"Connectivity diagnostics finished.", "success"'),
  "A diagnostics/test toast must never report a bare finished message.",
);
assert.strictEqual(
  (app.match(/finished: \$\{networkStateLabel\(overallState\)\}\./g) || []).length,
  3,
  "All three diagnostics/test toasts must include the state label and use the derived tone.",
);
assert(
  !app.includes('method: "sha256", checkedAt: new Date().toISOString()'),
  "The verification fallback must not synthesize method/checkedAt fields the agent did not return.",
);
assert(
  app.includes("const fallbackVerification = { state };") &&
    app.includes("backup.verification = record?.verification || fallbackVerification;"),
  "The verification fallback must surface the state plus only agent-returned fields.",
);

// ---------------------------------------------------------------------------
// F. Styles
// ---------------------------------------------------------------------------
[
  ".settings-subgroup",
  ".settings-section--node-connectivity",
  ".node-connectivity-summary",
  ".node-connectivity-stale",
  ".node-connectivity-endpoints",
  ".node-connectivity-endpoint__address",
  ".node-connectivity-loading",
  ".status-pill--muted",
  ".backup-verification-cell",
  ".backup-verification-pill",
  ".backup-verify-button",
].forEach((selector) => requireStyle(selector, "V2-K renderer surface class"));

console.log("Node connectivity / operational notification / telemetry / backup verification UI smoke checks passed.");
