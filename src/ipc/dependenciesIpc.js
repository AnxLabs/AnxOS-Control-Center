const { ipcMain } = require("electron");
const {
  checkDependencies,
  getDependencyCatalog,
  installDependencies,
  planDependencyPreparation,
} = require("../services/serviceRouter");
const {
  createDependencyInstallRecord,
  finalizeDependencyInstallRecord,
  updateDependencyInstallRecord,
} = require("../services/marketplaceService");
// V2-I bullet 5: the dependency provenance / advisory report
// (src/services/dependencyService.js). It reads THIS application tree's
// package.json + lockfile, never the selected node's host dependencies, which
// is why it needs no node context and arrives under a distinct channel name
// from serviceRouter's host-dependency catalog above.
const { getDependencyCatalog: getDependencyProvenanceReport } = require("../services/dependencyService");
const diagnostics = require("../services/diagnosticsService");
const { audit, requirePermission } = require("../services/securityService");
const { requireNodeContext } = require("./nodeContext");
const { normalizeIpcError } = require("../shared/ipcError");
const requireDependencyNodeContext = requireNodeContext;
// V2-J bullet 2: the operation scope every dependency action enters, so the
// install record, its diagnostics line and the Agent install job join on one id.
const { runWithCorrelationScope } = require("../shared/structuredLogger");

function invokeDependencyOperation(operation, operationName = "dependencies:request") {
  return Promise.resolve()
    .then(() => runWithCorrelationScope({ prefix: "dependencies" }, operation))
    .catch((error) => {
      const normalized = normalizeIpcError(error, {
        code: "DEPENDENCY_REQUEST_FAILED",
        fallbackMessage: "Dependency request failed.",
        suggestion: "Review the dependency plan and selected-node capabilities, then retry.",
      });
      diagnostics.log("error", "dependencies", operationName, "Dependency IPC operation failed", {
        errorCode: normalized.code,
        status: normalized.status?.code || null,
        retryable: normalized.retryable,
      }, { file: "dependencies" });
      return {
        ok: false,
        error: normalized,
      };
    });
}

function registerDependenciesIpc() {
  ipcMain.handle("dependencies:getCatalog", async (_, payload = {}) => invokeDependencyOperation(() => { requirePermission("dependencies:read", payload.nodeId); return getDependencyCatalog(requireDependencyNodeContext(payload, "dependency catalog")); }, "dependencies:getCatalog"));
  // Read-only provenance report. No options are forwarded from the renderer:
  // the report's rootDir/manifest/lockfile inputs are resolved in main, so a
  // renderer can neither point it at an arbitrary path nor substitute a
  // manifest. The read tier matches dependencies:getCatalog.
  ipcMain.handle("dependencies:getProvenanceReport", async () => invokeDependencyOperation(() => {
    requirePermission("dependencies:read", "dependency-provenance");
    return getDependencyProvenanceReport();
  }, "dependencies:getProvenanceReport"));
  ipcMain.handle("dependencies:check", async (_, payload = {}) => invokeDependencyOperation(async () => {
    requirePermission("dependencies:read", payload.nodeId);
    requireDependencyNodeContext(payload, "dependency detection");
    const result = await checkDependencies(payload);
    diagnostics.updateRuntimeState({
      dependencyCheck: result,
      dependencyNodeId: result.nodeId || payload.nodeId || null,
      dependencyCheckedAt: new Date().toISOString(),
    });
    return result;
  }, "dependencies:check"));
  ipcMain.handle("dependencies:plan", async (_, payload = {}) => invokeDependencyOperation(async () => {
    requirePermission("dependencies:read", payload.nodeId);
    requireDependencyNodeContext(payload, "dependency planning");
    const result = await planDependencyPreparation(payload);
    diagnostics.updateRuntimeState({
      dependencyPlan: result,
      dependencyNodeId: result.nodeId || payload.nodeId || null,
      dependencyPlannedAt: new Date().toISOString(),
    });
    return result;
  }, "dependencies:plan"));
  ipcMain.handle("dependencies:install", async (_, payload = {}) => invokeDependencyOperation(async () => {
    requireDependencyNodeContext(payload, "dependency installation");
    requirePermission("instance:write", "marketplace-dependencies");
    audit({ action: "dependencies.install", target: Array.isArray(payload.dependencyIds) ? payload.dependencyIds.join(",") : "marketplace" });
    const plan = await planDependencyPreparation(payload).catch(() => null);
    const download = createDependencyInstallRecord(payload, plan);
    updateDependencyInstallRecord(download.id, {
      status: "running",
      stage: "Preparing installation",
      progress: null,
      progressMode: "indeterminate",
      body: "Installing selected dependencies on the selected node.",
      logs: [{ step: "Preparing installation", message: "Dependency installation is running through the selected backend." }],
    });
    try {
      const result = await installDependencies(payload);
      finalizeDependencyInstallRecord(download.id, result, null);
      diagnostics.updateRuntimeState({
        dependencyInstall: {
          state: result?.degraded ? "degraded" : result?.ok === false ? "failed" : "completed",
          nodeId: result.nodeId || payload.nodeId || null,
          dependencyIds: Array.isArray(payload.dependencyIds) ? payload.dependencyIds : [],
          jobs: Array.isArray(result?.jobs) ? result.jobs : [],
          restartRequired: Array.isArray(result?.jobs) ? result.jobs.some((job) => job.restartRequired === true) : false,
          completedAt: new Date().toISOString(),
        },
      });
      return {
        ...result,
        downloadId: download.id,
      };
    } catch (error) {
      finalizeDependencyInstallRecord(download.id, null, error);
      diagnostics.updateRuntimeState({
        dependencyInstall: {
          state: "failed",
          nodeId: payload.nodeId || null,
          dependencyIds: Array.isArray(payload.dependencyIds) ? payload.dependencyIds : [],
          error: {
            code: error?.code || error?.payload?.error?.code || "DEPENDENCY_INSTALL_FAILED",
            message: error?.payload?.error?.message || error?.message || "Dependency installation failed.",
          },
          completedAt: new Date().toISOString(),
        },
      });
      throw error;
    }
  }, "dependencies:install"));
}

module.exports = { registerDependenciesIpc };
