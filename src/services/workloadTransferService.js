// V2-G Wave 4: backup/restore-based workload transfer between compatible
// nodes (docs/MASTER_ROADMAP.md drill-harness transfer leg). Desktop-side
// orchestration only: the Agent already owns every primitive (createBackup,
// archive download, import, restore with targetInstanceId + preview), so this
// service routes the steps across two registered nodes with per-step records
// and best-effort cleanup of the target-side archive whenever a confirmed
// restore did not consume it. No new Agent endpoints and no desktop-side
// instance surgery: the transfer rides the same bounded backup/restore paths
// the operator already uses, so preview verdicts and confirmation semantics
// stay identical to a direct restore.
const { getExecutionTarget, getNode } = require("./nodeService");
const serviceRouter = require("./serviceRouter");
const diagnostics = require("./diagnosticsService");
const { MAX_BACKUP_ARCHIVE_BYTES } = require("../shared/backupLimits");

// Same shape the Agent's backupService.validateInstanceId enforces; failing
// here first keeps a malformed id from ever reaching either Agent.
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;

function nowIso() {
  return new Date().toISOString();
}

function getAgentErrorCode(error) {
  return error?.code || error?.payload?.error?.code || null;
}

function createTransferError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode: details.statusCode || 400,
    details,
  });
}

function createStepRecorder() {
  const steps = [];
  return {
    steps,
    // Non-throwing record for steps that complete inline.
    record(step, detail = {}) {
      const entry = { step, ok: true, at: nowIso(), ...detail };
      steps.push(entry);
      return entry;
    },
    // Runs one awaited transfer step and records its outcome either way so a
    // failed transfer always carries the full per-step trail in error.details.
    async guard(step, operation, describe = null) {
      try {
        const value = await operation();
        steps.push({ step, ok: true, at: nowIso(), ...(describe ? describe(value) : {}) });
        return value;
      } catch (error) {
        steps.push({
          step,
          ok: false,
          at: nowIso(),
          errorCode: getAgentErrorCode(error) || "TRANSFER_STEP_FAILED",
          errorMessage: String(error?.payload?.error?.message || error?.message || "Transfer step failed."),
        });
        throw error;
      }
    },
  };
}

function resolveTransferNode(nodeId, role) {
  const id = String(nodeId || "").trim();
  if (!id) {
    throw createTransferError("TRANSFER_NODE_REQUIRED", `A ${role} node is required for a workload transfer.`, { role, statusCode: 400 });
  }
  const node = getNode(id);
  const executionTarget = getExecutionTarget(id);
  if (executionTarget.type !== "agent") {
    throw createTransferError("TRANSFER_NODE_UNSUPPORTED", "Workload transfer requires an Agent node on both ends; the application host cannot take part.", { nodeId: id, role, statusCode: 400 });
  }
  if (node?.enabled === false) {
    throw createTransferError("NODE_DISABLED", "Selected node is disabled.", { nodeId: id, role, statusCode: 403 });
  }
  return {
    nodeId: executionTarget.nodeId,
    deviceId: executionTarget.deviceId || null,
    localAgent: executionTarget.localAgent === true,
  };
}

function validateTransferInstanceId(value, role) {
  const id = String(value || "").trim();
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw createTransferError("INVALID_INSTANCE_ID", `The ${role} instance id is not a valid instance identifier.`, { role, instanceId: String(value || "") || null, statusCode: 400 });
  }
  return id;
}

// The Agent's deleteBackup is idempotent (alreadyDeleted), so repeated
// best-effort cleanups of the same imported archive are safe.
async function cleanupImportedArchive(recorder, context, reason) {
  let deletion = null;
  try {
    deletion = await serviceRouter.deleteBackup(context.importedBackupId, { nodeId: context.target.nodeId });
  } catch (error) {
    // Best-effort by contract: a failed cleanup must not mask the original
    // transfer failure, but it must be visible in the step trail.
    recorder.record("target.import.cleanup", {
      backupId: context.importedBackupId,
      reason,
      deleted: false,
      errorCode: getAgentErrorCode(error) || "TRANSFER_CLEANUP_FAILED",
    });
    return false;
  }
  const removed = deletion?.deleted === true || deletion?.alreadyDeleted === true;
  recorder.record("target.import.cleanup", {
    backupId: context.importedBackupId,
    reason,
    deleted: deletion?.deleted === true,
    alreadyDeleted: deletion?.alreadyDeleted === true,
  });
  if (removed) {
    context.importedBackupCleanedUp = true;
  }
  return removed;
}

function buildTransferResult(context, extra = {}) {
  return {
    ok: true,
    action: "workload-transfer",
    sourceNodeId: context.source.nodeId,
    targetNodeId: context.target.nodeId,
    sourceInstanceId: context.sourceInstanceId,
    targetInstanceId: context.targetInstanceId,
    backupId: context.backupId,
    importedBackupId: context.importedBackupId,
    importedBackupConsumed: context.importedBackupConsumed,
    importedBackupCleanedUp: context.importedBackupCleanedUp === true,
    requiresConfirmation: false,
    confirmed: false,
    steps: context.recorder.steps,
    completedAt: nowIso(),
    ...extra,
  };
}

/**
 * Orchestrate a backup/restore-based workload transfer between two registered
 * Agent nodes. Preview-first: the restore preview on the target always runs
 * before the destructive phase and its verdict is surfaced; without
 * `confirmOverwrite` the transfer stops there and cleans up the imported
 * archive. Re-run with the returned `backupId` and `confirmOverwrite: true`
 * to complete the transfer.
 *
 * @param {object} request
 * @param {string} request.sourceNodeId Registered Agent node holding the workload.
 * @param {string} request.targetNodeId Registered Agent node receiving the workload.
 * @param {string} [request.backupId] Existing full-scope backup on the source node.
 * @param {string} [request.instanceId] Source instance to back up (required without backupId).
 * @param {string} [request.targetInstanceId] Instance id on the target (defaults to the source instance id).
 * @param {boolean} [request.confirmOverwrite] Confirms the destructive restore phase.
 * @param {boolean} [request.restart] Restarts passthrough for the confirmed restore.
 * @param {string} [request.backupName] Name for the source-side backup.
 */
async function transferWorkload(request = {}) {
  const recorder = createStepRecorder();
  const context = {
    recorder,
    source: null,
    target: null,
    sourceInstanceId: null,
    targetInstanceId: null,
    backupId: null,
    importedBackupId: null,
    importedBackupConsumed: false,
    importedBackupCleanedUp: false,
  };

  try {
    const nodes = await recorder.guard("resolve.nodes", async () => {
      const sourceNodeId = String(request.sourceNodeId || "").trim();
      const targetNodeId = String(request.targetNodeId || "").trim();
      if (sourceNodeId && sourceNodeId === targetNodeId) {
        throw createTransferError("TRANSFER_NODES_IDENTICAL", "Source and target nodes must differ for a workload transfer.", { nodeId: sourceNodeId, statusCode: 400 });
      }
      return {
        source: resolveTransferNode(sourceNodeId, "source"),
        target: resolveTransferNode(targetNodeId, "target"),
      };
    }, (nodes) => ({ sourceNodeId: nodes.source.nodeId, targetNodeId: nodes.target.nodeId }));
    context.source = nodes.source;
    context.target = nodes.target;

    // --- Source side: reuse or take a full-scope archive ---
    const sourceBackup = await recorder.guard("source.backup", async () => {
      if (request.backupId) {
        // The listing is per-node by construction, so a hit here proves the
        // archive lives on the source node.
        const listing = await serviceRouter.listBackups({ nodeId: context.source.nodeId });
        const backup = (Array.isArray(listing?.backups) ? listing.backups : [])
          .find((entry) => entry?.id === request.backupId) || null;
        if (!backup) {
          throw createTransferError("BACKUP_NOT_FOUND", "The requested source backup does not exist on the source node.", { backupId: request.backupId, nodeId: context.source.nodeId, statusCode: 404 });
        }
        if (backup.type !== "full") {
          throw createTransferError("TRANSFER_SCOPE_UNSUPPORTED", "Only full-scope backups can be transferred: the instance record a fresh target needs to register the workload only travels in a full archive.", { backupId: backup.id, type: backup.type, statusCode: 400 });
        }
        return { backup, created: false };
      }
      const instanceId = validateTransferInstanceId(request.instanceId, "source");
      const created = await serviceRouter.createBackup({
        nodeId: context.source.nodeId,
        instanceId,
        type: "full",
        name: request.backupName || `${instanceId} workload transfer backup`,
        createdBy: "workload-transfer",
      });
      if (!created?.backup?.id) {
        throw createTransferError("TRANSFER_BACKUP_CREATE_FAILED", "The source node did not report a created backup.", { nodeId: context.source.nodeId, instanceId, statusCode: 502 });
      }
      return { backup: created.backup, created: true };
    }, (sourceBackup) => ({
      backupId: sourceBackup.backup.id,
      instanceId: sourceBackup.backup.instanceId,
      created: sourceBackup.created,
      backupType: sourceBackup.backup.type,
      sizeBytes: sourceBackup.backup.size ?? null,
      consistency: sourceBackup.backup.consistency ?? null,
    }));
    context.backupId = sourceBackup.backup.id;
    context.sourceInstanceId = sourceBackup.backup.instanceId;

    // --- Pull the archive: hold the bytes in memory exactly like the
    // existing desktop download path (backupsIpc.saveBackupDownload). The
    // Agent import route accepts archives as base64 JSON, so nothing is
    // written to disk on the desktop side.
    const archive = await recorder.guard("source.download", async () => {
      const download = await serviceRouter.downloadBackup(context.backupId, { nodeId: context.source.nodeId });
      const buffer = download?.buffer || null;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw createTransferError("TRANSFER_DOWNLOAD_EMPTY", "The source node returned an empty backup archive.", { backupId: context.backupId, nodeId: context.source.nodeId, statusCode: 502 });
      }
      if (buffer.length > MAX_BACKUP_ARCHIVE_BYTES) {
        // Refuse before base64-encoding a huge archive; the Agent import
        // route enforces the same limit (BACKUP_ARCHIVE_LIMIT_EXCEEDED).
        throw createTransferError("BACKUP_ARCHIVE_LIMIT_EXCEEDED", "The source backup exceeds the supported archive size limit.", { archiveBytes: buffer.length, maxArchiveBytes: MAX_BACKUP_ARCHIVE_BYTES, statusCode: 413 });
      }
      return buffer;
    }, (buffer) => ({ backupId: context.backupId, bytes: buffer.length }));

    // --- Import on the target: the imported record keeps the source instance
    // id so the restore preview can name the workload it would overwrite.
    const importedBackup = await recorder.guard("target.import", async () => {
      const result = await serviceRouter.importBackup({
        nodeId: context.target.nodeId,
        instanceId: context.sourceInstanceId,
        content: archive.toString("base64"),
        encoding: "base64",
        type: sourceBackup.backup.type,
        name: `${context.sourceInstanceId} workload transfer`,
        createdBy: "workload-transfer",
      });
      if (!result?.backup?.id) {
        throw createTransferError("TRANSFER_IMPORT_FAILED", "The target node did not report an imported backup.", { nodeId: context.target.nodeId, instanceId: context.sourceInstanceId, statusCode: 502 });
      }
      return result.backup;
    }, (importedBackup) => ({ backupId: importedBackup.id, instanceId: context.sourceInstanceId, bytes: archive.length }));
    context.importedBackupId = importedBackup.id;

    // --- Target instance registration: the Agent restore refuses any
    // cross-instance target that is not a registered instance, and a fresh
    // target node has none, so the transfer registers a placeholder through
    // the canonical create path first. A full-scope restore replaces the
    // placeholder's directory and record with the transferred workload's own
    // configuration, so the placeholder never survives a successful transfer.
    context.targetInstanceId = validateTransferInstanceId(request.targetInstanceId || context.sourceInstanceId, "target");
    await recorder.guard("target.instance.ensure", async () => {
      const registered = await serviceRouter.getInstanceStatus(context.targetInstanceId, { nodeId: context.target.nodeId })
        .then(() => true)
        .catch((error) => {
          if (getAgentErrorCode(error) === "INSTANCE_NOT_FOUND") {
            return false;
          }
          throw error;
        });
      if (registered) {
        return { created: false, instanceId: context.targetInstanceId };
      }
      const createdInstance = await serviceRouter.createInstance({
        nodeId: context.target.nodeId,
        id: context.targetInstanceId,
        displayName: `Transferred workload ${context.sourceInstanceId}`,
        type: "custom-command",
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
      });
      return { created: true, instanceId: createdInstance?.instance?.id || context.targetInstanceId };
    }, (ensured) => ({ created: ensured.created, instanceId: ensured.instanceId }));

    // --- Preview first: a genuinely read-only dry run on the target whose
    // verdict and warnings are surfaced to the caller verbatim.
    const preview = await recorder.guard("target.restore.preview", async () => {
      const result = await serviceRouter.restoreBackup({
        nodeId: context.target.nodeId,
        backupId: context.importedBackupId,
        targetInstanceId: context.targetInstanceId,
        preview: true,
      });
      if (!result?.conflict) {
        throw createTransferError("TRANSFER_PREVIEW_FAILED", "The target node did not report a restore preview.", { nodeId: context.target.nodeId, backupId: context.importedBackupId, statusCode: 502 });
      }
      return result;
    }, (preview) => ({
      backupId: context.importedBackupId,
      verdict: preview.conflict.verdict,
      warnings: preview.conflict.warnings,
      requiresConfirmation: preview.conflict.requiresConfirmation === true,
    }));

    if (request.confirmOverwrite !== true) {
      // Bounded stop before the destructive phase: the imported archive was
      // never consumed, so clean it up and hand the verdict back.
      const cleanupRemoved = await cleanupImportedArchive(recorder, context, "confirmation-required");
      if (cleanupRemoved) {
        context.importedBackupId = null;
      }
      diagnostics.log("info", "workload", "transfer-preview", "Workload transfer stopped for confirmation.", {
        sourceNodeId: context.source.nodeId,
        targetNodeId: context.target.nodeId,
        backupId: context.backupId,
        verdict: preview.conflict.verdict,
      }, { file: "workload" });
      return buildTransferResult(context, {
        requiresConfirmation: true,
        confirmed: false,
        verdict: preview.conflict.verdict,
        conflict: preview.conflict,
        preview,
      });
    }

    // --- Confirmed destructive phase on the target only; the source keeps
    // its workload and its backup untouched throughout.
    const restore = await recorder.guard("target.restore.confirm", async () => {
      const result = await serviceRouter.restoreBackup({
        nodeId: context.target.nodeId,
        backupId: context.importedBackupId,
        targetInstanceId: context.targetInstanceId,
        confirmOverwrite: true,
        ...(request.restart === undefined ? {} : { restart: request.restart === true }),
      });
      if (!result?.restore) {
        throw createTransferError("TRANSFER_RESTORE_FAILED", "The target node did not report a restore result.", { nodeId: context.target.nodeId, backupId: context.importedBackupId, statusCode: 502 });
      }
      return result.restore;
    }, (restore) => ({
      backupId: context.importedBackupId,
      targetInstanceId: restore.targetInstanceId || context.targetInstanceId,
      safetyBackupId: restore.safetyBackupId || null,
      restarted: restore.restart?.restarted === true,
    }));
    context.importedBackupConsumed = true;

    diagnostics.log("info", "workload", "transfer", "Workload transfer completed.", {
      sourceNodeId: context.source.nodeId,
      targetNodeId: context.target.nodeId,
      sourceInstanceId: context.sourceInstanceId,
      targetInstanceId: context.targetInstanceId,
      backupId: context.backupId,
      importedBackupId: context.importedBackupId,
      safetyBackupId: restore.safetyBackupId || null,
    }, { file: "workload" });
    return buildTransferResult(context, {
      confirmed: true,
      verdict: preview.conflict.verdict,
      conflict: preview.conflict,
      preview,
      restore,
    });
  } catch (error) {
    // Best-effort cleanup of the target-side imported archive whenever the
    // confirmed restore did not consume it (failed before/during restore, or
    // the confirmation stop above already handled its own case).
    if (context.importedBackupId && !context.importedBackupConsumed) {
      const cleanupRemoved = await cleanupImportedArchive(recorder, context, "transfer-failed");
      if (cleanupRemoved) {
        context.importedBackupId = null;
      }
    }
    if (!error?.code) {
      error.code = getAgentErrorCode(error) || "TRANSFER_FAILED";
    }
    error.details = {
      ...(error?.details || {}),
      ...(error?.payload?.error?.details || {}),
      steps: recorder.steps,
      sourceNodeId: context.source?.nodeId || String(request.sourceNodeId || "") || null,
      targetNodeId: context.target?.nodeId || String(request.targetNodeId || "") || null,
    };
    diagnostics.log("warn", "workload", "transfer-failed", "Workload transfer failed.", {
      sourceNodeId: error.details.sourceNodeId,
      targetNodeId: error.details.targetNodeId,
      errorCode: error.code,
      failedStep: [...recorder.steps].reverse().find((entry) => entry.ok === false)?.step || null,
    }, { file: "workload" });
    throw error;
  }
}

module.exports = {
  transferWorkload,
};
