const { ipcMain } = require("electron");
const workloadTransferService = require("../services/workloadTransferService");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");
// V2-I bullet 4: the workload trust vocabulary the read-only panel displays.
// The policy stays in main — the renderer receives a projection and an
// evaluation verdict, never the authority to decide a tier itself.
const {
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  HONORED_CAPABILITIES,
  RESIDUAL_HOST_PRIVILEGES,
  TRUST_DECLARATION_FIELDS,
  TRUST_LEVELS,
  TRUST_LEVEL_TABLE,
  TRUST_REFUSAL_CODES,
  WORKLOAD_KINDS,
  capabilityAllowedAt,
  capabilityFloor,
  evaluateWorkloadTrust,
} = require("../shared/workloadTrustPolicy");
// V2-J bullet 2: the operation scope every transfer action enters, so the
// source-side backup, the target-side import and both nodes' Agent actions all
// join on the operation that requested them.
const { runWithCorrelationScope } = require("../shared/structuredLogger");

const WORKLOAD_IPC_ERROR_OPTIONS = {
  code: "WORKLOAD_REQUEST_FAILED",
  fallbackMessage: "Workload transfer request failed.",
  suggestion: "Review the per-step transfer records, correct the reported problem, then retry.",
};

function transferTarget(payload = {}) {
  return `${payload.sourceNodeId || "unknown-source"}->${payload.targetNodeId || "unknown-target"}`;
}

// Per-step audit entries mirror the fleet batch pattern: the channel is
// authorized once here, and every recorded transfer step is audited with its
// own outcome so the destructive cross-node phases leave a full trail.
function auditTransferSteps(steps, sourceNodeId, targetNodeId) {
  (Array.isArray(steps) ? steps : []).forEach((step) => {
    audit({
      action: `workload.transfer.${step.step}`,
      target: `${sourceNodeId}->${targetNodeId}`,
      outcome: step.ok === false ? "failed" : "ok",
      reason: step.ok === false ? (step.errorCode || "TRANSFER_STEP_FAILED") : null,
    });
  });
}

function attachTransferSteps(wrapped, error) {
  const steps = error?.details?.steps || error?.payload?.error?.details?.steps;
  if (Array.isArray(steps)) {
    wrapped.details = { ...(wrapped.details || {}), steps };
    wrapped.steps = steps;
  }
  return wrapped;
}

async function invokeWorkloadOperation(operation, { auditStepTrail = false } = {}) {
  try {
    return await runWithCorrelationScope({ prefix: "transfer" }, operation);
  } catch (error) {
    if (auditStepTrail) {
      const steps = error?.details?.steps || error?.payload?.error?.details?.steps;
      if (Array.isArray(steps)) {
        auditTransferSteps(steps, error?.details?.sourceNodeId, error?.details?.targetNodeId);
      }
    }
    throw attachTransferSteps(createIpcError(error, WORKLOAD_IPC_ERROR_OPTIONS), error);
  }
}

// ---------------------------------------------------------------------------
// V2-I workload trust (read-only). Two projections, no writes:
//
//   workload:getTrustPolicy  the tier ladder, per-capability allow/deny, the
//                            per-kind honored sets and the residual host
//                            privileges, straight from the policy module.
//   workload:evaluateTrust   the policy's own verdict for a representative
//                            declaration, so an operator can see WHY a tier is
//                            required or refused before creating anything.
//
// Setting a tier is not a persisted operation in this build: the tier is a
// field on a workload definition (container create / instance create), where
// main enforces it (src/shared/dockerPolicy.js, instanceServiceCore.js). This
// channel only reports the decision; it grants nothing.
// ---------------------------------------------------------------------------
function trustPolicyProjection() {
  const levels = TRUST_LEVELS.map((level) => {
    const row = TRUST_LEVEL_TABLE[level];
    return {
      level,
      rank: row.rank,
      allowedCapabilities: CAPABILITY_KEYS.filter((key) => capabilityAllowedAt(level, key)),
      deniedCapabilities: CAPABILITY_KEYS.filter((key) => !capabilityAllowedAt(level, key)),
      requiresNonAdminExecution: row.requiresNonAdminExecution === true,
      requiredResourceLimits: [...row.requiredResourceLimits],
    };
  });
  const capabilityFloors = {};
  for (const key of CAPABILITY_KEYS) {
    capabilityFloors[key] = capabilityFloor(key);
  }
  const honoredCapabilities = {};
  for (const kind of WORKLOAD_KINDS) {
    honoredCapabilities[kind] = [...HONORED_CAPABILITIES[kind]];
  }
  return {
    levels,
    capabilityKeys: [...CAPABILITY_KEYS],
    capabilityLabels: { ...CAPABILITY_LABELS },
    capabilityFloors,
    kinds: [...WORKLOAD_KINDS],
    honoredCapabilities,
    declarationFields: [...TRUST_DECLARATION_FIELDS],
    refusalCodes: { ...TRUST_REFUSAL_CODES },
    residualHostPrivileges: {
      summary: RESIDUAL_HOST_PRIVILEGES.summary,
      shared: [...RESIDUAL_HOST_PRIVILEGES.shared],
      windows: [...RESIDUAL_HOST_PRIVILEGES.windows],
      linux: [...RESIDUAL_HOST_PRIVILEGES.linux],
    },
  };
}

const TRUST_EVALUATION_KIND_SET = new Set(WORKLOAD_KINDS);

function sanitizeTrustText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

// Build a definition from an explicit allowlist of fields. The renderer never
// supplies arbitrary keys, so nothing it sends can reach the policy beyond the
// capability flags and the contract fields below, and nothing is echoed back
// unbounded. Each requested capability is expressed with a representative
// request shape — the policy classifies by shape, not by path.
function buildTrustDefinition(payload = {}) {
  const capabilities = payload.capabilities && typeof payload.capabilities === "object" ? payload.capabilities : {};
  const definition = {};
  if (capabilities.privileged === true) definition.privileged = true;
  if (capabilities.hostNetwork === true) definition.network = "host";
  if (capabilities.hostPid === true) definition.pid = "host";
  const volumes = [];
  if (capabilities.hostMount === true) volumes.push("/host/path:/workload/path");
  if (capabilities.engineSocket === true) volumes.push("/var/run/docker.sock:/var/run/docker.sock");
  if (volumes.length > 0) definition.volumes = volumes;
  if (capabilities.deviceAccess === true) definition.devices = ["/dev/requested-device"];
  if (capabilities.publishedHostPorts === true) definition.ports = ["8080:80"];

  const tier = sanitizeTrustText(payload.trustLevel, 40);
  if (tier) definition.trustLevel = tier;
  const user = sanitizeTrustText(payload.user, 64);
  if (user) definition.user = user;
  const memory = sanitizeTrustText(payload.memory, 32);
  if (memory) definition.memory = memory;
  const cpus = sanitizeTrustText(payload.cpus, 32);
  if (cpus) definition.cpus = cpus;
  return definition;
}

function evaluateTrustDeclaration(payload = {}) {
  const kind = TRUST_EVALUATION_KIND_SET.has(payload.kind) ? payload.kind : "container-create";
  const definition = buildTrustDefinition(payload);
  const verdict = evaluateWorkloadTrust(definition, { kind });
  return {
    kind: verdict.kind,
    declaredTier: verdict.declaredTier,
    declaredTierValid: verdict.declaredTierValid,
    requiredTier: verdict.requiredTier,
    effectiveTier: verdict.effectiveTier,
    allowed: verdict.allowed,
    capabilities: verdict.capabilities,
    capabilityLabels: verdict.capabilityLabels,
    identity: {
      nonAdmin: verdict.identity.nonAdmin === true,
      source: verdict.identity.source || null,
      detail: verdict.identity.detail || null,
      requestedNonAdminIdentity: verdict.identity.requestedNonAdminIdentity === true,
    },
    limits: {
      memory: verdict.limits.memory,
      cpus: verdict.limits.cpus,
      present: { ...verdict.limits.present },
      required: [...verdict.limits.required],
      missing: [...verdict.limits.missing],
    },
    refusals: verdict.refusals.map((item) => ({
      code: item.code,
      capability: item.capability || null,
      message: item.message,
      statusCode: item.statusCode || null,
      declaredTier: item.declaredTier || null,
      requiredTier: item.requiredTier || null,
    })),
  };
}

function registerWorkloadIpc() {
  // Preview channel: despite the name, this RUNS the transfer pipeline up to
  // the target restore preview — including a source backup, archive pull,
  // target-side import, and placeholder registration — so it is a WRITE-tier
  // channel (same grant as workload:transfer) and its per-step trail is
  // audited exactly like the confirmed channel's (review P1-3/P1-5: a read
  // tier must never launder backups/imports/instance creation).
  ipcMain.handle("workload:transferPreview", async (_, payload = {}) => invokeWorkloadOperation(async () => {
    requireLocalOwnerAuthenticated("workload:transfer-preview", "Unlock AnxOS to plan workload transfers.");
    requirePermission("settings:write", "nodes");
    audit({ action: "workload.transfer-preview", target: transferTarget(payload) });
    const outcome = await workloadTransferService.transferWorkload({ ...payload, confirmOverwrite: false });
    auditTransferSteps(outcome.steps, outcome.sourceNodeId, outcome.targetNodeId);
    return outcome;
  }, { auditStepTrail: true }));
  // Write channel: matches the fleet batch tier (local owner + settings:write)
  // because it creates backups, registers a placeholder instance on the
  // target, and runs a confirmed destructive restore there.
  ipcMain.handle("workload:transfer", async (_, payload = {}) => invokeWorkloadOperation(async () => {
    requireLocalOwnerAuthenticated("workload:transfer", "Unlock AnxOS to transfer workloads between nodes.");
    requirePermission("settings:write", "nodes");
    audit({ action: "workload.transfer", target: transferTarget(payload) });
    const outcome = await workloadTransferService.transferWorkload(payload);
    auditTransferSteps(outcome.steps, outcome.sourceNodeId, outcome.targetNodeId);
    return outcome;
  }, { auditStepTrail: true }));
  // Read-only trust vocabulary at the settings-read tier (the same guard shape
  // as the neighbouring directory read families: plain requirePermission, so a
  // signed-out desktop is refused with LOGIN_REQUIRED). The projection and the
  // verdict carry no node/instance/credential data, no write happens, and no
  // tier is granted. Both channels re-derive everything from the policy in
  // main, so a renderer can neither invent a tier nor be trusted to enforce one.
  ipcMain.handle("workload:getTrustPolicy", async (_, payload = {}) => invokeWorkloadOperation(async () => {
    requirePermission("settings:read", "workload-trust");
    return { ok: true, ...trustPolicyProjection() };
  }));
  ipcMain.handle("workload:evaluateTrust", async (_, payload = {}) => invokeWorkloadOperation(async () => {
    requirePermission("settings:read", "workload-trust");
    return { ok: true, ...evaluateTrustDeclaration(payload) };
  }));
}

module.exports = {
  registerWorkloadIpc,
};
