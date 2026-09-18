const { ipcMain } = require("electron");
const workloadTransferService = require("../services/workloadTransferService");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");
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
}

module.exports = {
  registerWorkloadIpc,
};
