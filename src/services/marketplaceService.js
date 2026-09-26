const fs = require("fs");
const path = require("path");
const agentClient = require("./agentClient");
const diagnostics = require("./diagnosticsService");
const {
  applyMinecraftServerProperties,
  buildMinecraftProperties: buildMinecraftServerProperties,
  normalizePortList,
  resolveMinecraftPort,
} = require("./minecraftServerConfig");
const {
  getTemplateInstallerType,
  normalizeInstallerType,
  validateMarketplaceCatalog,
  validateMarketplaceTemplate,
} = require("./marketplaceInstallerRegistry");
const { getExecutionTarget, getNode, getSelectedNodeId } = require("./nodeService");
const {
  buildMarketplaceInstallContext,
  validateMarketplaceInstallContext,
} = require("./marketplaceInstallContext");
const {
  MARKETPLACE_JOB_TYPES,
  buildMarketplaceInstallKey,
  mintMarketplaceJob,
} = require("./marketplaceInstallJobService");
const longOperations = require("../shared/longOperationService");
const { resolveTemplateDependencyIds } = require("../shared/marketplaceDependencies");
const { evaluatePublisherTrust } = require("../shared/publisherTrustPolicy");
const { redactString, sanitize } = require("../shared/redaction");
const { normalizeDiskEvidence } = require("../shared/diskSpace");

const TEMPLATE_PATH = path.join(__dirname, "..", "..", "config", "marketplace-templates.json");
const CATEGORIES = ["Minecraft", "Game Servers", "Applications", "Databases", "Media", "Bots", "Development", "Networking", "Utilities"];
const PAPER_DEFAULT_BUILD = "latest";
const MOJANG_VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_META_URL = "https://meta.fabricmc.net/v2";
const FORGE_PROMOTIONS_URL = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN_METADATA_URL = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
const NEOFORGE_MAVEN_METADATA_URL = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
const BUNGEECORD_JAR_URL = "https://hub.spigotmc.org/jenkins/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar";
const COMMUNITY_TEMPLATE_FORMAT_VERSION = 1;
const INSTANCE_VERSION_CACHE_VERSION = 2;
const HTTP_USER_AGENT = "AnxOS-Control-Center/Marketplace";
const DOWNLOAD_TIMEOUT_MS = 120000;
const DOWNLOAD_RETRY_DELAYS_MS = [0, 750, 2000];
const STEAMCMD_INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const STEAMCMD_MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024;
const STEAMCMD_RETRY_DELAYS_MS = [0, 1000];
const INSTALLER_RESULT_STAGES = new Set([
  "validating",
  "dependency-check",
  "creating-instance",
  "downloading",
  "extracting",
  "configuring",
  "verifying",
  "starting",
  "installed",
  "cancelled",
  "failed",
]);

const MARKETPLACE_OPERATION_KIND = "marketplace-download";

function mapMarketplaceOperationStatus(status) {
  if (["complete", "failed", "cancelled"].includes(status)) {
    return status;
  }
  return "running";
}

// Backed by the shared long-operation framework (src/shared/longOperationService.js)
// so Marketplace downloads/dependency installs participate in the same persistence,
// crash-recovery, and diagnostics pipeline as other long-running operations, while
// every existing Map-style call site in this file keeps working unchanged.
const downloads = {
  get(id) {
    const operation = longOperations.getOperation(id);
    return operation ? operation.metadata : undefined;
  },
  set(id, record) {
    longOperations.upsertOperation(id, {
      kind: MARKETPLACE_OPERATION_KIND,
      nodeId: record?.nodeId || null,
      status: mapMarketplaceOperationStatus(record?.status),
      canCancel: record?.canCancel === true && typeof record?.controller?.abort === "function",
      canRetry: record?.canRetry === true,
      retryable: record?.canRetry === true,
      metadata: record,
    });
    if (record?.canCancel === true && typeof record?.controller?.abort === "function") {
      longOperations.registerCancelHandler(id, () => record.controller.abort());
    }
    return downloads;
  },
  delete(id) {
    return longOperations.deleteOperation(id);
  },
  has(id) {
    return Boolean(longOperations.getOperation(id));
  },
  values() {
    return longOperations.listOperations({ kind: MARKETPLACE_OPERATION_KIND }).map((operation) => operation.metadata);
  },
};
const minecraftVersionCatalogCache = new Map();
const MINECRAFT_VERSION_CATALOG_TTL_MS = 10 * 60 * 1000;

function createMarketplaceError(message, code = "MARKETPLACE_ERROR", details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function createMarketplaceValidationError({ field, received, expected, suggestion, userMessage }) {
  const validation = {
    field,
    received,
    expected,
    suggestion,
    userMessage: userMessage || suggestion || "Check the install value and try again.",
  };
  return createMarketplaceError(validation.userMessage, "MARKETPLACE_VALIDATION_FAILED", {
    ...validation,
    validation,
  });
}

function buildInstallContext(payload = {}, template = {}, options = {}, instancePayload = {}) {
  return buildMarketplaceInstallContext({
    payload,
    template,
    options,
    instancePayload,
    sourceFallback: "marketplace",
    preferOptionProvider: false,
    installPathFallback: "data",
  });
}

function validateInstallContext(installContext = {}) {
  return validateMarketplaceInstallContext(installContext, {
    createError: (message, code, details) => createMarketplaceError(message, code, details),
  });
}

function resolveMarketplaceAgentConfig(nodeId = null) {
  const executionTarget = getExecutionTarget(nodeId);
  if (executionTarget.type === "agent") {
    const node = getNode(executionTarget.nodeId);
    if (node.enabled === false) {
      throw createMarketplaceError("Selected node is disabled.", "NODE_DISABLED", {
        nodeId: executionTarget.nodeId,
      });
    }
    return {
      ...executionTarget.config,
      nodeId: executionTarget.nodeId,
      agentNodeId: executionTarget.nodeId,
    };
  }

  return { backendMode: "local" };
}

function summarizeUnsatisfiedDependencies(dependencies = []) {
  return dependencies
    .filter((dependency) => !dependency.installed || dependency.state === "update-required" || dependency.state === "unsupported")
    .map((dependency) => ({
      id: dependency.id,
      displayName: dependency.displayName,
      state: dependency.state,
      installed: Boolean(dependency.installed),
      supported: Boolean(dependency.supported),
      version: dependency.version || null,
      minVersion: dependency.minVersion || null,
      commands: dependency.commands || [],
      packages: dependency.packages || [],
      packageManager: dependency.packageManager || null,
      requiresElevation: Boolean(dependency.requiresElevation),
      reason: dependency.reason || null,
      notes: dependency.notes || null,
      errorCode: dependency.errorCode || null,
    }));
}

function linkChildDownloadRecord(parentRecord, childRecord) {
  if (!parentRecord?.id || !childRecord?.id) return;
  if (!Array.isArray(parentRecord.childTaskIds)) {
    parentRecord.childTaskIds = [];
  }
  if (!parentRecord.childTaskIds.includes(childRecord.id)) {
    parentRecord.childTaskIds.push(childRecord.id);
    downloads.set(parentRecord.id, parentRecord);
  }
}

async function ensureTemplateDependencies(template, options = {}, agentConfig = null, progress = [], parentRecord = null) {
  const dependencyIds = resolveTemplateDependencyIds(template);
  if (dependencyIds.length === 0 || agentConfig?.backendMode === "local") {
    return { ok: true, dependencyIds, dependencies: [] };
  }

  // V2-D runtime pins: attribute dependency resolution and installs to the
  // workload being installed so the agent can refuse cross-workload runtime
  // changes. Plan previews pass no workload identity and never pin. Identity
  // is the durable instance id — a display name would leave pins keyed to a
  // label that can outlive the workload (review P1-2).
  const workloadId = String(options.instanceId || options.id || "").trim() || null;

  pushStep(progress, "Check dependencies", "running", "Checking node runtime dependencies.");
  const check = await agentClient.checkDependencies({ dependencyIds, instanceId: workloadId, nodeId: options.nodeId || null }, agentConfig);
  if (check.ok) {
    pushStep(progress, "Check dependencies", "complete", "Node dependencies are ready.");
    return check;
  }

  const missing = summarizeUnsatisfiedDependencies(check.dependencies);
  if (options.autoInstallDependencies === true) {
    pushStep(progress, "Install dependencies", "running", `Installing ${missing.map((dependency) => dependency.displayName).join(", ")}.`);
    const missingDependencyIds = missing.map((dependency) => dependency.id);
    const dependencyRecord = createDependencyInstallRecord({
      nodeId: options.nodeId || agentConfig?.nodeId || null,
      dependencyIds: missingDependencyIds,
    }, {
      installableActions: missing.map((dependency) => ({
        id: dependency.id,
        displayName: dependency.displayName || dependency.id,
      })),
      missingDependencyIds,
    }, {
      parentTaskId: parentRecord?.id || null,
      installSessionId: parentRecord?.installSessionId || null,
    });
    linkChildDownloadRecord(parentRecord, dependencyRecord);
    updateDependencyInstallRecord(dependencyRecord.id, {
      status: "running",
      stage: "Installing files",
      body: `Installing ${missing.map((dependency) => dependency.displayName || dependency.id).join(", ")} for ${template.displayName || template.id}.`,
      logs: [{ step: "Install dependencies", message: "Marketplace dependency installation is running through the shared dependency job system." }],
    });
    let install;
    try {
      install = await agentClient.installDependencies({ dependencyIds: missingDependencyIds, instanceId: workloadId, nodeId: options.nodeId || agentConfig?.nodeId || null }, agentConfig);
      finalizeDependencyInstallRecord(dependencyRecord.id, install, null);
      diagnostics.updateRuntimeState({
        dependencyInstall: {
          state: install?.degraded ? "degraded" : install?.ok === false ? "failed" : "completed",
          nodeId: options.nodeId || agentConfig?.nodeId || null,
          dependencyIds: missingDependencyIds,
          jobs: Array.isArray(install?.jobs) ? install.jobs : [],
          source: "marketplace",
          templateId: template.id,
          completedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      finalizeDependencyInstallRecord(dependencyRecord.id, null, error);
      diagnostics.updateRuntimeState({
        dependencyInstall: {
          state: "failed",
          nodeId: options.nodeId || agentConfig?.nodeId || null,
          dependencyIds: missingDependencyIds,
          source: "marketplace",
          templateId: template.id,
          error: {
            code: error?.code || "DEPENDENCY_INSTALL_FAILED",
            message: error?.message || "Dependency installation failed.",
          },
          completedAt: new Date().toISOString(),
        },
      });
      throw error;
    }
    const recheck = await agentClient.checkDependencies({ dependencyIds }, agentConfig);
    if (recheck.ok) {
      pushStep(progress, "Install dependencies", "complete", "Node dependencies installed and verified.");
      return { ...recheck, install };
    }
    const stillMissing = summarizeUnsatisfiedDependencies(recheck.dependencies);
    throw createMarketplaceError("Required node dependencies are still missing after installation.", "DEPENDENCIES_REQUIRED", {
      templateId: template.id,
      dependencyIds,
      dependencies: recheck.dependencies,
      missingDependencies: stillMissing,
      install,
      retryable: true,
      userAction: "install-dependencies",
    });
  }

  throw createMarketplaceError("This template requires node dependencies before installation can continue.", "DEPENDENCIES_REQUIRED", {
    templateId: template.id,
    dependencyIds,
    dependencies: check.dependencies,
    missingDependencies: missing,
    retryable: true,
    userAction: "install-dependencies",
  });
}

function sanitizeStackLocation(error) {
  const line = String(error?.stack || "").split("\n").find((entry) => /(?:src|agent|scripts)\//.test(entry));
  return line ? line.trim().replace(process.cwd(), "") : null;
}

function createInstallerResultOk(stage, data = {}) {
  return { ok: true, stage, data };
}

function createInstallerResultError(stage, error, options = {}) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    ok: false,
    stage,
    error: {
      code: error?.code || options.code || "INTERNAL_INSTALLER_ERROR",
      message: error?.message || options.message || "Marketplace installer failed.",
      details: {
        ...details,
        stage,
        handlerName: options.handlerName || details.handlerName || null,
        installerType: options.installerType || details.installerType || null,
        runtimeType: options.runtimeType || details.runtimeType || null,
        templateId: options.templateId || details.templateId || null,
        stackLocation: sanitizeStackLocation(error),
        timestamp: new Date().toISOString(),
      },
      retryable: options.retryable ?? details.retryable ?? true,
    },
  };
}

function assertInstallerResult(result, context = {}) {
  const malformed = !result ||
    typeof result !== "object" ||
    typeof result.ok !== "boolean" ||
    !INSTALLER_RESULT_STAGES.has(result.stage) ||
    (result.ok && (!result.data || typeof result.data !== "object" || Array.isArray(result.data))) ||
    (!result.ok && (!result.error || typeof result.error !== "object" || !result.error.code || !result.error.message));

  if (!malformed) {
    return result;
  }

  throw createMarketplaceError("Installer handler returned an invalid result contract.", "HANDLER_RESULT_INVALID", {
    stage: context.stage || result?.stage || "unknown",
    handlerName: context.handlerName || null,
    installerType: context.installerType || null,
    runtimeType: context.runtimeType || null,
    templateId: context.templateId || null,
    receivedType: Array.isArray(result) ? "array" : typeof result,
    receivedKeys: result && typeof result === "object" ? Object.keys(result).sort() : [],
    retryable: false,
  });
}

function unwrapInstallerResult(result, context = {}) {
  const normalized = assertInstallerResult(result, context);
  if (normalized.ok) {
    return normalized.data;
  }
  throw createMarketplaceError(normalized.error.message, normalized.error.code, {
    ...normalized.error.details,
    retryable: normalized.error.retryable,
  });
}

function truncateText(value, maxLength = 1200) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function truncateLogLine(value, maxLength = 300) {
  return truncateText(redactString(value), maxLength);
}

function formatErrorDetails(details = {}) {
  const parts = [];
  if (details.templateId) parts.push(`templateId=${details.templateId}`);
  if (details.step) parts.push(`step=${details.step}`);
  if (details.url) parts.push(`url=${details.url}`);
  if (details.status !== undefined && details.status !== null) parts.push(`status=${details.status}`);
  if (details.responseUrl) parts.push(`responseUrl=${details.responseUrl}`);
  if (details.causeCode) parts.push(`causeCode=${details.causeCode}`);
  if (details.networkCode) parts.push(`networkCode=${details.networkCode}`);
  if (details.exitCode !== undefined && details.exitCode !== null) parts.push(`exitCode=${details.exitCode}`);
  if (details.failureReason) parts.push(`failureReason=${details.failureReason}`);
  if (details.command) parts.push(`command=${details.command}`);
  if (details.workingDirectory) parts.push(`workingDirectory=${details.workingDirectory}`);
  if (details.resolvedInstallDirectory) parts.push(`installDirectory=${details.resolvedInstallDirectory}`);
  if (details.executablePath) parts.push(`executable=${details.executablePath}`);
  if (details.logHint) parts.push(`logs=${details.logHint}`);
  if (details.message) parts.push(`message=${details.message}`);
  return parts.length ? ` (${parts.join(" | ")})` : "";
}

function createMarketplaceStepError(message, code, details = {}) {
  return createMarketplaceError(`${message}${formatErrorDetails(details)}`, code, details);
}

function getMissingInstallerDependencyMessage(context = {}, instance = {}) {
  if (context.installerType === "steamcmd-native" || String(instance.executable || "").toLowerCase() === "steamcmd") {
    return "SteamCMD is not installed or is not available on PATH on the selected Agent.";
  }
  const executable = String(instance.executable || "").trim();
  return executable
    ? `Required executable "${executable}" is not installed or is not available on PATH on the selected Agent.`
    : "A required installer executable is not installed or is not available on PATH on the selected Agent.";
}

function getNetworkCauseDetails(error = {}) {
  const cause = error?.cause && typeof error.cause === "object" ? error.cause : {};
  return {
    causeName: cause.name || error.name || null,
    causeCode: cause.code || error.code || null,
    causeMessage: cause.message || error.message || null,
    syscall: cause.syscall || error.syscall || null,
    hostname: cause.hostname || error.hostname || null,
    address: cause.address || error.address || null,
    port: cause.port || error.port || null,
  };
}

function classifyNetworkError(error = {}) {
  const code = error?.cause?.code || error?.code || "";
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return "NETWORK_DNS_FAILED";
  if (/CERT|TLS|SSL/i.test(code)) return "NETWORK_TLS_FAILED";
  if (/ETIMEDOUT|Timeout/i.test(code) || error?.name === "AbortError") return "NETWORK_TIMEOUT";
  if (/ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(code)) return "NETWORK_CONNECTION_FAILED";
  return "DOWNLOAD_FAILED";
}

function createFetchHeaders(extraHeaders = {}) {
  return {
    "User-Agent": HTTP_USER_AGENT,
    Accept: "*/*",
    ...extraHeaders,
  };
}

async function fetchWithDetails(url, options = {}) {
  const timeoutMs = options.timeoutMs || DOWNLOAD_TIMEOUT_MS;
  const attempts = Number.isInteger(options.attempts) ? Math.max(options.attempts, 1) : DOWNLOAD_RETRY_DELAYS_MS.length;
  const { timeoutMs: _timeoutMs, attempts: _attempts, ...fetchOptions } = options;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const delay = DOWNLOAD_RETRY_DELAYS_MS[attempt] || 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const signal = options.signal && typeof AbortSignal?.any === "function"
        ? AbortSignal.any([options.signal, controller.signal])
        : options.signal || controller.signal;
      const response = await fetch(url, {
        ...fetchOptions,
        redirect: options.redirect || "follow",
        headers: createFetchHeaders(options.headers || {}),
        signal,
      });
      clearTimeout(timeout);
      response.attempt = attempt + 1;
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (options.signal?.aborted || error?.name === "AbortError" && attempt === attempts - 1) {
        break;
      }
    }
  }

  throw lastError;
}

function getAgentErrorCode(error) {
  return error?.payload?.error?.code || error?.code || null;
}

function getErrorDetails(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const payloadDetails = error?.payload?.error?.details && typeof error.payload.error.details === "object"
    ? error.payload.error.details
    : {};
  return { ...payloadDetails, ...details };
}

function getErrorStage(error, fallback = "Failed") {
  const details = getErrorDetails(error);
  return details.stage || details.step || fallback;
}

function mapMarketplaceError(error, fallback = "Template install failed.") {
  const validation = error?.payload?.error?.details || error?.details?.validation || null;
  if (validation?.userMessage || validation?.field) {
    return [
      validation.userMessage || error?.payload?.error?.message || error?.message || fallback,
      validation.field ? `field=${validation.field}` : null,
      validation.expected ? `expected=${validation.expected}` : null,
      validation.received !== undefined ? `received=${JSON.stringify(validation.received)}` : null,
      validation.code ? `code=${validation.code}` : null,
    ].filter(Boolean).join(" | ");
  }

  if (error?.details?.templateId || error?.details?.step) {
    if (getAgentErrorCode(error) === "DEPENDENCY_MISSING" && error?.details?.failureReason === "EXECUTABLE_NOT_FOUND") {
      return error.message || "A required runtime dependency is missing.";
    }
    return error.message || fallback;
  }

  const code = getAgentErrorCode(error);
  const friendlyMessages = {
    INSTALL_VALIDATION_FAILED: "Marketplace install validation failed.",
    INVALID_INSTALL_CONTEXT: "Required install configuration is missing.",
    HANDLER_RESULT_INVALID: "Marketplace installer returned an invalid internal result.",
    DEPENDENCY_MISSING: "A required runtime dependency is missing.",
    EXTRACTION_FAILED: "The server files could not be extracted.",
    CONFIGURATION_FAILED: "The server configuration could not be generated.",
    INSTANCE_CREATION_FAILED: "The server instance could not be created.",
    START_FAILED: "The server could not be started.",
    INSTALL_CANCELLED: "Marketplace install was cancelled.",
    INTERNAL_INSTALLER_ERROR: "Marketplace installer failed internally.",
    INSTANCE_ALREADY_EXISTS: "An instance with this ID already exists. Delete the failed partial instance or choose a different name, then retry.",
    INSTANCE_NOT_FOUND: "The target instance was not found. The install was stopped before file setup.",
    NOT_FOUND: "The target instance was not found. The install was stopped before file setup.",
    INSTANCE_VERIFICATION_FAILED: error?.message || "Created instance could not be verified.",
    PATH_NOT_FOUND: "A required install file or folder was not found.",
    DOWNLOAD_FAILED: "The template download failed.",
    NETWORK_DNS_FAILED: "The download host could not be resolved.",
    NETWORK_TLS_FAILED: "The download failed TLS/certificate validation.",
    NETWORK_TIMEOUT: "The download timed out.",
    NETWORK_CONNECTION_FAILED: "The download connection failed.",
    DOWNLOAD_REQUIRED: "This template requires a downloadable server file.",
    DOWNLOAD_URL_INCOMPLETE: "The template download URL is incomplete.",
    DOWNLOAD_RESOLVE_FAILED: "Unable to resolve the latest server download.",
    INSTALLER_NOT_SUPPORTED: "This server template cannot be fully automated yet.",
    MANUAL_SETUP_REQUIRED: "This server requires manual setup before AnxOS can start it.",
    FABRIC_RESOLVE_FAILED: "Unable to resolve Fabric download.",
    FORGE_RESOLVE_FAILED: "Unable to download Forge installer.",
    NEOFORGE_RESOLVE_FAILED: "Unable to download NeoForge installer.",
    PROXY_RESOLVE_FAILED: "Unable to resolve proxy download.",
    TEMPLATE_NOT_READY: "This template is not ready yet.",
    TEMPLATE_INSTALL_TIMEOUT: "The template installer did not finish in time.",
    TEMPLATE_INSTALL_FAILED: "The server installer failed. Check the instance logs for setup details.",
    STEAMCMD_INSTALL_FAILED: "SteamCMD installer failed. Check the instance logs for setup details.",
    EXECUTABLE_NOT_FOUND: "The expected server executable was not found after installation.",
    STARTUP_CONFIGURATION_FAILED: "The startup command could not be configured.",
    INVALID_EXECUTABLE: "The generated startup executable is invalid.",
    INVALID_ARGS: "The generated startup arguments are invalid.",
    INVALID_INSTANCE_TYPE: "This installer generated an unsupported instance type.",
    INVALID_MEMORY_LIMIT: "Use memory like 512M, 2G, or 2048M.",
    INVALID_PORTS: "Enter valid ports between 1 and 65535.",
  };

  return friendlyMessages[code] || error?.message || fallback;
}

function readTemplatesFile() {
  const raw = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw createMarketplaceError("Template catalog must contain an array.", "INVALID_TEMPLATE_CATALOG");
  }

  return parsed.map((template) => ({
    screenshots: [],
    author: "AnxOS",
    version: "1.0.0",
    // V2-D package metadata defaults (docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md
    // §3.1): catalog items carry versioned-package fields unless the template
    // declares them explicitly.
    packageVersion: "1.0.0",
    checksum: null,
    provenance: { source: "anxos-catalog" },
    defaultPorts: [],
    configurationSchema: [],
    installScript: [],
    ...template,
  }));
}

function deepMergeTemplate(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  return Object.entries(override).reduce((merged, [key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
      merged[key] = deepMergeTemplate({ ...merged[key] }, value);
    } else {
      merged[key] = value;
    }
    return merged;
  }, { ...base });
}

function normalizeTargetPlatform(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "win32" || normalized === "windows") return "windows";
  if (normalized === "linux") return "linux";
  if (normalized === "darwin" || normalized === "macos" || normalized === "mac") return "macos";
  return normalized || "";
}

function getInstallTargetPlatform(payload = {}, agentConfig = null) {
  const explicit = normalizeTargetPlatform(payload.platform || payload.targetPlatform || payload.options?.platform);
  if (explicit) {
    return explicit;
  }

  const node = getNode(payload.nodeId || getSelectedNodeId());
  return normalizeTargetPlatform(
    node?.profile?.platform ||
      node?.localProfile?.platform ||
      node?.connection?.platform ||
      node?.platform ||
      agentConfig?.platform ||
      agentConfig?.os ||
      ""
  );
}

function resolveTemplateForPlatform(template = {}, platform = "") {
  const targetPlatform = normalizeTargetPlatform(platform);
  const platformConfig = targetPlatform ? template.platforms?.[targetPlatform] : null;
  if (!platformConfig) {
    return {
      ...template,
      targetPlatform: targetPlatform || null,
      platformVariant: null,
    };
  }

  const merged = deepMergeTemplate(template, platformConfig);
  delete merged.platforms;
  return {
    ...merged,
    targetPlatform,
    platformVariant: targetPlatform,
    platformNotes: platformConfig.notes || template.platformNotes || null,
  };
}

function listTemplates() {
  const templates = readTemplatesFile();
  const validation = validateMarketplaceCatalog(templates);
  const invalidById = new Map(validation.errors.map((error) => [error.templateId, error]));
  return {
    categories: CATEGORIES,
    templates: templates.map((template) => {
      const invalid = invalidById.get(template.id);
      return invalid
        ? {
          ...template,
          disabled: true,
          installable: false,
          installerType: getTemplateInstallerType(template) || null,
          invalidManifest: true,
          unavailableReason: `Unavailable due to invalid Marketplace definition: ${invalid.message}`,
        }
        : {
          ...template,
          installerType: getTemplateInstallerType(template),
        };
    }),
    validation,
  };
}

function getTemplateInstallPlan(templateId) {
  const template = findTemplate(templateId);
  const downloads = normalizeTemplateDownloads(template);
  const steps = [
    "Validate template",
    "Create instance",
    "Create folders",
    "Resolve download",
    "Download files",
    "Extract files",
    "Configure startup",
    "Write config",
    "Verify installation",
    "Optional start",
  ];

  if (template.disabled || template.comingSoon) {
    return {
      templateId: template.id,
      installable: false,
      disabled: true,
      reason: template.comingSoonMessage || "Template is disabled.",
      steps,
    };
  }

  const installerType = getTemplateInstallerType(template);
  const hasAutomaticDownload = downloads.some((download) => ["url", "inline", "generated"].includes(download.type));
  const installable = Boolean(installerType && installerType !== "no-install");

  return {
    templateId: template.id,
    installable,
    disabled: false,
    workflow: installerType || (hasAutomaticDownload ? "direct-download" : "local-import"),
    installerType,
    reason: installable ? null : "Template does not define an automatic installer or download source.",
    downloadCount: downloads.length,
    steps,
  };
}

// V2-D plan preview: compose the curated install plan with read-only preflight
// verdicts (dependency diff + disk check) so the Marketplace UI can show the
// transaction before it is executed. The preview never installs anything: the
// dependency check runs with autoInstallDependencies forced off.
async function getTemplateInstallPlanPreview(payload = {}) {
  const templateId = payload.templateId || payload.id;
  if (!templateId || typeof templateId !== "string") {
    throw createMarketplaceError("A templateId is required to build an install plan.", "TEMPLATE_ID_REQUIRED", { templateId: null });
  }

  let agentConfig = null;
  try {
    agentConfig = resolveMarketplaceAgentConfig(payload.nodeId);
  } catch {
    agentConfig = null;
  }
  const targetPlatform = getInstallTargetPlatform(payload, agentConfig);
  const template = resolveTemplateForPlatform(findTemplate(templateId), targetPlatform);
  const plan = getTemplateInstallPlan(template.id || templateId);
  const installablePlan = { ...plan, templateId: template.id || templateId };

  const resolvedDownloads = normalizeTemplateDownloads(template).map((download) => ({
    type: download.type,
    destination: download.destination || null,
    fileName: download.fileName || null,
    url: typeof download.url === "string" ? download.url : null,
    size: Number.isFinite(Number(download.size)) ? Number(download.size) : null,
  }));

  let dependencies;
  try {
    const check = await ensureTemplateDependencies(
      template,
      { nodeId: payload.nodeId || null, autoInstallDependencies: false },
      agentConfig,
      [],
    );
    dependencies = {
      checked: true,
      ok: check.ok !== false,
      dependencyIds: Array.isArray(check.dependencyIds) ? check.dependencyIds : [],
      dependencies: Array.isArray(check.dependencies) ? check.dependencies : [],
    };
  } catch (error) {
    dependencies = {
      checked: true,
      ok: false,
      dependencyIds: Array.isArray(error?.details?.dependencyIds) ? error.details.dependencyIds : [],
      missing: error?.details?.missingDependencies || null,
      code: error?.code || "DEPENDENCY_CHECK_FAILED",
      message: error?.message || "Dependency preflight failed.",
    };
  }

  let disk;
  try {
    // Lazy require: the disk preflight lives with the provider install
    // executors, and resolving it at call time keeps this module free of any
    // require-order coupling to marketplaceInstallService.
    const { getInstallDiskPreflight } = require("./marketplaceInstallService");
    disk = await getInstallDiskPreflight({ nodeId: payload.nodeId });
  } catch (error) {
    disk = { checked: false, ok: null, code: "DISK_SPACE_CHECK_UNAVAILABLE", message: error?.message || "Disk preflight could not run." };
  }

  return {
    ...installablePlan,
    downloads: resolvedDownloads,
    dependencies,
    disk,
  };
}

function findTemplate(templateId, templateOverride = null) {
  if (templateOverride && typeof templateOverride === "object") {
    return {
      screenshots: [],
      author: "AnxOS",
      version: "1.0.0",
      defaultPorts: [],
      configurationSchema: [],
      installScript: [],
      ...templateOverride,
    };
  }

  const template = readTemplatesFile().find((entry) => entry.id === templateId);
  if (!template) {
    throw createMarketplaceError(`Template ${templateId || "unknown"} was not found.`, "TEMPLATE_NOT_FOUND");
  }

  return template;
}

function validateCommunityTemplate(template = {}) {
  const id = String(template.id || "").trim();
  const hasDownloadSource = Boolean(template.downloadSource) || (Array.isArray(template.downloads) && template.downloads.length > 0) || Boolean(template.installer);
  const hasDockerImage = template.runtime === "docker" && Boolean(template.docker?.image || template.downloadSource?.image);
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(id)) {
    throw createMarketplaceError("Community template id is invalid.", "INVALID_COMMUNITY_TEMPLATE");
  }
  if (!String(template.displayName || "").trim()) {
    throw createMarketplaceError("Community template displayName is required.", "INVALID_COMMUNITY_TEMPLATE");
  }
  if (!String(template.category || "").trim()) {
    throw createMarketplaceError("Community template category is required.", "INVALID_COMMUNITY_TEMPLATE");
  }
  if (template.disabled !== true && template.comingSoon !== true && !hasDownloadSource && !hasDockerImage) {
    throw createMarketplaceError("Community template must define a real download source, Docker image, or be disabled.", "INVALID_COMMUNITY_TEMPLATE");
  }

  return {
    screenshots: [],
    author: "Community",
    version: "1.0.0",
    defaultPorts: [],
    configurationSchema: [],
    installScript: [],
    formatVersion: COMMUNITY_TEMPLATE_FORMAT_VERSION,
    ...template,
    tags: Array.isArray(template.tags) ? template.tags : [],
  };
}

function importCommunityTemplate(payload = {}) {
  const template = validateCommunityTemplate(payload.template || payload);
  return {
    template,
    installable: !(template.disabled || template.comingSoon),
    warnings: template.runtime === "docker" && !template.docker?.image && !template.downloadSource?.image
      ? ["Docker templates should define docker.image or downloadSource.image."]
      : [],
  };
}

function getImportSupport() {
  return {
    communityTemplates: {
      supported: true,
      formatVersion: COMMUNITY_TEMPLATE_FORMAT_VERSION,
      requiredFields: ["id", "displayName", "category"],
      installableWhen: "Template declares a real download source, SteamCMD installer, Docker image, or is explicitly disabled.",
    },
    modpacks: {
      modrinth: {
        supported: true,
        mode: "metadata-validation",
        notes: "Modrinth .mrpack import can be validated and converted into a community template when server files are available.",
      },
      curseforge: {
        supported: false,
        reason: "CurseForge imports often require API credentials or user-authorized downloads, so automated one-click install is not enabled by default.",
      },
    },
  };
}

function normalizeName(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `instance-${Date.now()}`;
}

function normalizeTagValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeTemplateTags(template, isMinecraft = template?.category === "Minecraft") {
  const rawTags = [
    template?.category,
    template?.id,
    ...(Array.isArray(template?.tags) ? template.tags : []),
    isMinecraft ? "minecraft" : null,
  ];
  return [...new Set(rawTags.map(normalizeTagValue).filter((tag) => /^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(tag)))].slice(0, 32);
}

function parsePorts(value, fallback = []) {
  try {
    return normalizePortList(value, fallback);
  } catch (error) {
    throw createMarketplaceError(error.message, error.code || "PORT_INVALID", error.details || {});
  }
}

function isBlankNumericValue(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function normalizeWholeNumberField(value, {
  field,
  label,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
  defaultValue,
  optional = false,
  suggestion,
}) {
  if (isBlankNumericValue(value)) {
    if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
      return normalizeWholeNumberField(defaultValue, { field, label, min, max, optional: false, suggestion });
    }
    if (optional) {
      return null;
    }
  }

  const raw = typeof value === "string" ? value.trim() : value;
  const rawText = String(raw);
  const expected = `whole number from ${min} to ${max}`;
  const userMessage = `${label || field} must be a whole number from ${min} to ${max}.`;
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw >= min && raw <= max) {
      return raw;
    }
  } else if (/^[0-9]+$/.test(rawText)) {
    const parsed = Number(rawText);
    if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) {
      return parsed;
    }
  }

  throw createMarketplaceValidationError({
    field,
    received: value,
    expected,
    userMessage,
    suggestion: suggestion || `Enter ${label || field} as digits only, without units or decimals.`,
  });
}

function normalizeInstallerTimeoutMs(value, fallbackMs) {
  return normalizeWholeNumberField(value, {
    field: "startupTimeoutMs",
    label: "Startup timeout",
    min: 1,
    max: STEAMCMD_INSTALL_TIMEOUT_MS,
    defaultValue: fallbackMs,
    suggestion: `Startup timeout must be a whole number from 1 to ${STEAMCMD_INSTALL_TIMEOUT_MS}.`,
  });
}

function normalizePortField(value, { field, label, defaultValue, optional = false } = {}) {
  return normalizeWholeNumberField(value, {
    field,
    label,
    min: 1,
    max: 65535,
    defaultValue,
    optional,
    suggestion: `${label || field} must be a whole number from 1 to 65535.`,
  });
}

function normalizeMarketplaceMemoryField(value, defaultValue = "") {
  const raw = isBlankNumericValue(value) ? defaultValue : value;
  const memory = String(raw || "").trim();
  if (!memory) {
    return "";
  }
  const match = memory.match(/^([1-9][0-9]{0,5})([kKmMgG]?)$/);
  if (!match) {
    throw createMarketplaceValidationError({
      field: "memory",
      received: value,
      expected: "memory value such as 512M, 2G, or 2048M",
      userMessage: "Memory must be a value such as 512M, 2G, or 2048M.",
      suggestion: "Remove spaces and words such as GB; use 8G instead of 8 GB.",
    });
  }
  return `${match[1]}${match[2] ? match[2].toUpperCase() : ""}`;
}

function uniqueNumberList(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value)))];
}

function normalizePalworldInstallOptions(template, options = {}) {
  const defaultPorts = Array.isArray(template.defaultPorts) ? template.defaultPorts : [];
  const optionPorts = Array.isArray(options.ports) ? options.ports : [];
  const serverPort = normalizePortField(options.serverPort ?? options.port ?? optionPorts[0], {
    field: "serverPort",
    label: "Server port",
    defaultValue: defaultPorts[0] || 8211,
  });
  const queryPort = normalizePortField(options.queryPort ?? optionPorts[1], {
    field: "queryPort",
    label: "Query port",
    defaultValue: defaultPorts[1] || 27015,
  });
  const rconPort = normalizePortField(options.rconPort, {
    field: "rconPort",
    label: "RCON port",
    optional: true,
  });
  const maxPlayers = normalizeWholeNumberField(options.maxPlayers ?? options.players, {
    field: "maxPlayers",
    label: "Maximum players",
    min: 1,
    max: 256,
    defaultValue: 32,
    suggestion: "Enter the maximum player count as a whole number greater than 0.",
  });
  const memory = normalizeMarketplaceMemoryField(options.memory ?? options.ram ?? options.memoryLimit, template.defaultRam || "8G");
  const steamAppId = normalizeWholeNumberField(template.installer?.appId ?? template.downloadSource?.appId, {
    field: "steamAppId",
    label: "Steam app ID",
    min: 1,
    max: 999999999,
  });
  const steamDepotId = isBlankNumericValue(options.steamDepotId)
    ? null
    : normalizeWholeNumberField(options.steamDepotId, {
      field: "steamDepotId",
      label: "Steam depot ID",
      min: 1,
      max: 999999999,
      optional: true,
    });
  const ports = uniqueNumberList([serverPort, queryPort, rconPort]);
  return {
    ...options,
    memory,
    port: serverPort,
    serverPort,
    queryPort,
    rconPort,
    maxPlayers,
    players: maxPlayers,
    steamAppId,
    steamDepotId,
    ports,
  };
}

function normalizeMarketplaceInstallOptions(template, options = {}) {
  if (template?.id === "palworld") {
    const normalized = normalizePalworldInstallOptions(template, options);
    console.info("[Marketplace][Install] Normalized Palworld install configuration.", {
      templateId: template.id,
      serverPort: normalized.serverPort,
      queryPort: normalized.queryPort,
      rconPort: normalized.rconPort,
      maxPlayers: normalized.maxPlayers,
      memory: normalized.memory,
      steamAppId: normalized.steamAppId,
      hasSteamDepotId: normalized.steamDepotId !== null,
    });
    return normalized;
  }
  return options;
}

async function listAgentInstanceIds(agentConfig = null) {
  const list = await agentClient.listInstances(agentConfig);
  return Array.isArray(list?.instances) ? list.instances.map((instance) => instance.id).filter(Boolean) : [];
}

function resolveCreatedInstanceId(createResult, fallbackId) {
  return createResult?.instance?.id ||
    createResult?.id ||
    createResult?.data?.id ||
    createResult?.data?.instance?.id ||
    fallbackId;
}

async function verifyAgentInstanceExists(instanceId, agentConfig = null) {
  const instanceIds = await listAgentInstanceIds(agentConfig);
  if (!instanceIds.includes(instanceId)) {
    throw createMarketplaceError(
      `Created instance could not be verified. Expected ${instanceId}. Available: ${instanceIds.join(", ") || "none"}.`,
      "INSTANCE_VERIFICATION_FAILED"
    );
  }

  return instanceIds;
}

function pushStep(progress, label, status = "complete", detail = "") {
  const step = {
    label,
    status,
    detail,
    timestamp: new Date().toISOString(),
  };
  progress.push(step);
  return step;
}

function createDownloadRecord(template, fileName, options = {}) {
  const id = `${template.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const installSessionId = options.installSessionId || id;
  const nodeId = options.nodeId || null;
  const record = {
    id,
    installSessionId,
    nodeId,
    templateId: template.id,
    name: fileName || template.displayName || template.id,
    installerType: getTemplateInstallerType(template) || null,
    stage: "Preparing",
    status: "queued",
    progress: 0,
    bytesReceived: 0,
    bytesTotal: null,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    error: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    canRetry: false,
    canCancel: false,
    parentTaskId: options.parentTaskId || null,
    childTaskIds: [],
    errorCode: null,
    retryContext: null,
    logs: [{
      at: new Date().toISOString(),
      level: "info",
      message: `Queued ${fileName || template.displayName || template.id}.`,
      templateId: template.id,
      nodeId,
      step: "Validate template",
    }],
  };
  downloads.set(id, record);
  return record;
}

function appendDownloadLog(record, entry = {}) {
  const logs = Array.isArray(record.logs) ? record.logs : [];
  logs.push({
    at: new Date().toISOString(),
    level: entry.level || "info",
    message: entry.message || "",
    templateId: entry.templateId || record.templateId,
    step: entry.step || null,
    url: entry.url || null,
    status: entry.status || null,
    responseUrl: entry.responseUrl || null,
    causeCode: entry.causeCode || null,
    networkCode: entry.networkCode || null,
    exitCode: entry.exitCode ?? null,
    failureReason: entry.failureReason || null,
    body: entry.body ? truncateText(entry.body) : null,
    workingDirectory: entry.workingDirectory || null,
    resolvedInstallDirectory: entry.resolvedInstallDirectory || null,
    executablePath: entry.executablePath || null,
    finalStdoutLines: Array.isArray(entry.finalStdoutLines) ? entry.finalStdoutLines.slice(-20).map((line) => truncateLogLine(line)) : [],
    finalStderrLines: Array.isArray(entry.finalStderrLines) ? entry.finalStderrLines.slice(-20).map((line) => truncateLogLine(line)) : [],
    diskSpaceCheck: entry.diskSpaceCheck ? sanitize(entry.diskSpaceCheck, { maxStringLength: 500 }) : null,
    writePermissionCheck: entry.writePermissionCheck ? sanitize(entry.writePermissionCheck, { maxStringLength: 500 }) : null,
  });
  record.logs = logs.slice(-50);
  downloads.set(record.id, record);
  return record;
}

function updateDownload(record, patch) {
  const stageFromStatus = {
    queued: "Preparing",
    resolving: "Resolving installer",
    running: "Downloading",
    complete: "Completed",
    degraded: "Verification degraded",
    failed: "Failed",
    cancelled: "Cancelled",
    skipped: "Installing",
    waiting: "Waiting",
  };
  Object.assign(record, patch, {
    stage: patch.stage || stageFromStatus[patch.status] || record.stage || "Preparing",
    updatedAt: new Date().toISOString(),
  });
  if (record.status === "failed") {
    record.progress = Math.min(Number(record.progress) || 0, 99);
  }
  downloads.set(record.id, record);
  return record;
}

function isFiveMTemplate(template = {}) {
  return String(template.id || "").toLowerCase() === "fivem" ||
    [template.startupType, template.instanceType, ...(Array.isArray(template.tags) ? template.tags : [])].join(" ").toLowerCase().includes("fivem");
}

function createInstallTaskRecord(template, options = {}) {
  const record = createDownloadRecord(template, template.displayName || template.id, {
    nodeId: options.nodeId || null,
  });
  updateDownload(record, {
    stage: "Validating",
    status: "running",
    progress: 1,
    canCancel: false,
    canRetry: false,
    retryContext: {
      templateId: template.id,
      options: {
        id: options.id || null,
        name: options.name || null,
        version: options.version || null,
        port: options.port || null,
        ports: options.ports || null,
        memory: options.memory || null,
        start: options.start !== false,
      },
      installSessionId: record.installSessionId,
    },
  });
  appendDownloadLog(record, {
    step: "Validate template",
    message: `Started install task for ${template.id}.`,
  });
  return record;
}

function createDependencyInstallRecord(payload = {}, plan = null, options = {}) {
  const dependencyIds = Array.isArray(payload.dependencyIds) && payload.dependencyIds.length
    ? payload.dependencyIds
    : Array.isArray(plan?.missingDependencyIds) && plan.missingDependencyIds.length
      ? plan.missingDependencyIds
      : ["dependencies"];
  const dependencyNames = Array.isArray(plan?.installableActions) && plan.installableActions.length
    ? plan.installableActions.map((action) => action.displayName || action.id).filter(Boolean)
    : dependencyIds;
  const id = `dependency-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const record = {
    id,
    installSessionId: options.installSessionId || id,
    nodeId: payload.nodeId || null,
    templateId: "dependency",
    type: "Dependency",
    name: dependencyNames.length === 1 ? `Installing ${dependencyNames[0]}` : `Installing ${dependencyNames.length} dependencies`,
    fileName: dependencyNames.join(", "),
    url: "",
    status: "running",
    stage: "Preparing installation",
    progress: null,
    progressMode: "indeterminate",
    body: `Dependency installation started for ${payload.nodeId || "selected node"}.`,
    metadataText: dependencyIds.join(", "),
    actionText: "Progress stays inside AnxOS. Raw package-manager output is available in sanitized logs.",
    bytesReceived: 0,
    bytesTotal: null,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    error: null,
    startedAt: now,
    updatedAt: now,
    canRetry: false,
    canCancel: false,
    parentTaskId: options.parentTaskId || null,
    childTaskIds: [],
    errorCode: null,
    retryContext: null,
    dependencyJobs: [],
    logs: [{
      at: now,
      level: "info",
      message: `Queued dependency install for ${dependencyNames.join(", ")}.`,
      templateId: "dependency",
      step: "Preparing installation",
    }],
  };
  downloads.set(id, record);
  return sanitizeDownload(record);
}

function updateDependencyInstallRecord(downloadId, patch = {}) {
  const record = downloads.get(downloadId);
  if (!record) return null;
  if (Array.isArray(patch.logs)) {
    patch.logs.forEach((entry) => appendDownloadLog(record, entry));
  }
  return sanitizeDownload(updateDownload(record, {
    status: patch.status || record.status,
    stage: patch.stage || record.stage,
    progress: patch.progress ?? record.progress,
    progressMode: patch.progressMode || record.progressMode || "indeterminate",
    body: patch.body || record.body,
    metadataText: patch.metadataText || record.metadataText,
    actionText: patch.actionText || record.actionText,
    error: patch.error || null,
    errorCode: patch.errorCode || null,
    canRetry: patch.canRetry === true,
    canCancel: false,
  }));
}

function finalizeDependencyInstallRecord(downloadId, installResult = null, error = null) {
  const record = downloads.get(downloadId);
  if (!record) return null;
  const jobs = Array.isArray(installResult?.jobs) ? installResult.jobs : [];
  const dependencyJobs = jobs.map((job) => ({
    id: job.id || null,
    dependencyId: job.dependencyId || null,
    dependencyName: job.dependencyName || job.dependencyId || "Dependency",
    nodeId: job.nodeId || record.nodeId || null,
    platform: job.platform || null,
    state: job.state || null,
    stage: job.stage || null,
    progressMode: job.progressMode || null,
    progressPercent: job.progressPercent ?? null,
    message: job.message || null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    exitCode: job.exitCode ?? null,
    restartRequired: job.restartRequired === true,
    authenticationRequired: job.authenticationRequired === true,
    executionBackend: job.executionBackend || null,
    installationMethod: job.installationMethod || null,
    externalTerminal: job.externalTerminal === true,
    cancellationSupported: job.cancellationSupported === true,
    cancellationReason: job.cancellationReason || null,
    error: job.error || null,
  }));
  const degraded = !error && (installResult?.degraded === true || dependencyJobs.some((job) => job.state === "degraded"));
  const failed = Boolean(error) || (installResult?.ok === false && !degraded);
  const jobLogs = jobs.flatMap((job) => [
    ...(Array.isArray(job.events) ? job.events.map((event) => ({
      level: event.state === "failed" ? "error" : "info",
      step: event.stage || job.stage,
      message: event.message || job.message,
      status: event.state || job.state,
    })) : []),
    ...(Array.isArray(job.output) ? job.output.map((entry) => ({
      level: entry.exitCode === 0 || entry.exitCode === null ? "info" : "error",
      step: entry.phase || job.stage,
      message: entry.command ? `${entry.command} completed.` : job.message,
      exitCode: entry.exitCode,
      body: [entry.stdout, entry.stderr, entry.errorMessage].filter(Boolean).join("\n"),
    })) : []),
  ]);
  jobLogs.forEach((entry) => appendDownloadLog(record, entry));
  return sanitizeDownload(updateDownload(record, {
    status: failed ? "failed" : degraded ? "degraded" : "complete",
    stage: failed ? "Failed" : degraded ? "Verification degraded" : "Installation complete",
    progress: failed ? Math.min(Number(record.progress) || 0, 99) : 100,
    progressMode: "determinate",
    body: failed
      ? error?.message || "Dependency installation failed."
      : degraded
        ? "Installation completed, but AnxOS could not verify the dependency."
      : "Dependency installation completed and verification succeeded.",
    error: failed ? error?.message || "Dependency installation failed." : null,
    errorCode: failed ? error?.code || "DEPENDENCY_INSTALL_FAILED" : degraded ? "VERIFICATION_FAILED" : null,
    actionText: failed
      ? "Review sanitized logs, fix the dependency issue, then retry from the dependency panel."
      : degraded
        ? "Retry verification after confirming the dependency is available on the selected node."
      : "Dependency state has been refreshed for the selected node.",
    canRetry: degraded,
    canRetryVerification: degraded,
    canCancel: false,
    dependencyJobs,
  }));
}

function finalizeInstallTaskRecord(record, status, message, details = {}) {
  if (!record) {
    return null;
  }
  const failed = status === "failed";
  appendDownloadLog(record, {
    step: details.stage || record.stage,
    level: failed ? "error" : "info",
    message,
    status: details.status || null,
    body: details.body || null,
    ...details,
  });
  return updateDownload(record, {
    status,
    stage: details.stage || (failed ? "Failed" : "Completed"),
    progress: status === "complete" ? 100 : failed ? Math.min(Number(record.progress) || 0, 99) : record.progress,
    error: failed ? message : null,
    errorCode: failed ? details.code || null : null,
    canRetry: failed && details.retryable !== false,
    canCancel: false,
  });
}

function getDownloads() {
  return {
    downloads: [...downloads.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
  };
}

function getDownloadsForNode(nodeId = null) {
  const requestedNodeId = nodeId || getSelectedNodeId();
  const allDownloads = getDownloads().downloads;
  if (!requestedNodeId) {
    return { downloads: allDownloads };
  }
  return {
    downloads: allDownloads.filter((download) => !download.nodeId || download.nodeId === requestedNodeId),
  };
}

function getInstallSessionRecords(record) {
  if (!record) return [];
  const sessionId = record.installSessionId || record.retryContext?.installSessionId || record.id;
  const relatedIds = new Set([record.id, ...(Array.isArray(record.childTaskIds) ? record.childTaskIds : [])]);
  return [...downloads.values()].filter((entry) =>
    entry.installSessionId === sessionId ||
    entry.parentTaskId === record.id ||
    relatedIds.has(entry.id)
  );
}

function assertDownloadNode(record, nodeId = null) {
  if (!record || !nodeId || !record.nodeId || record.nodeId === nodeId) {
    return;
  }
  throw createMarketplaceError("Download belongs to a different node.", "DOWNLOAD_NODE_MISMATCH", {
    downloadId: record.id,
    nodeId,
    downloadNodeId: record.nodeId,
  });
}

function cancelDownload(downloadId, options = {}) {
  const record = downloads.get(downloadId);
  if (!record) {
    throw createMarketplaceError("Download was not found.", "DOWNLOAD_NOT_FOUND");
  }
  assertDownloadNode(record, options.nodeId || null);

  if (record.controller) {
    record.controller.abort();
  }

  updateDownload(record, {
    status: "cancelled",
    canCancel: false,
    canRetry: true,
  });

  return { download: sanitizeDownload(record) };
}

async function retryDownload(downloadId, options = {}) {
  const record = downloads.get(downloadId);
  if (!record) {
    throw createMarketplaceError("Download was not found.", "DOWNLOAD_NOT_FOUND");
  }
  assertDownloadNode(record, options.nodeId || null);

  const retryContext = record.retryContext && typeof record.retryContext === "object"
    ? JSON.parse(JSON.stringify(record.retryContext))
    : null;
  if (retryContext?.templateId) {
    for (const related of getInstallSessionRecords(record)) {
      if (related.status === "running" || related.status === "resolving") {
        throw createMarketplaceError("This install is still running and cannot be retried yet.", "INSTALL_STILL_RUNNING", {
          templateId: related.templateId,
          installSessionId: related.installSessionId || null,
        });
      }
    }
    for (const related of getInstallSessionRecords(record)) {
      downloads.delete(related.id);
    }
    return installTemplate({
      templateId: retryContext.templateId,
      options: retryContext.options || {},
    });
  }

  updateDownload(record, {
    status: "queued",
    progress: 0,
    bytesReceived: 0,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    error: null,
    canRetry: false,
  });
  appendDownloadLog(record, { step: "Retry", message: "Retry queued. Start the install again to rebuild the original context." });

  return { download: sanitizeDownload(record) };
}

function sanitizeDownload(record) {
  const { controller, ...safeRecord } = record;
  return safeRecord;
}

function sanitizeDownloads(payload) {
  return {
    downloads: (payload.downloads || []).map(sanitizeDownload),
  };
}

function normalizeInstanceFilePath(filePath) {
  const normalized = String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^data\/+/i, "");
  return normalized || "server.jar";
}

function fileNameFromDestination(destination) {
  return path.posix.basename(normalizeInstanceFilePath(destination));
}

function resolveUrlTemplate(download, options = {}) {
  const source = download || {};
  let url = source.url || source.urlTemplate || "";
  const replacements = {
    version: options.version || source.version || "latest",
    build: options.build || source.build || PAPER_DEFAULT_BUILD,
  };

  Object.entries(replacements).forEach(([key, value]) => {
    url = url.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
  });

  return url;
}

async function fetchTextWithDetails(url, label, context = {}) {
  try {
    const response = await fetchWithDetails(url, { timeoutMs: context.timeoutMs || DOWNLOAD_TIMEOUT_MS });
    const body = await response.text();
    if (!response.ok) {
      throw createMarketplaceStepError(`${label} failed with HTTP ${response.status}.`, context.code || "DOWNLOAD_RESOLVE_FAILED", {
        ...context,
        url,
        responseUrl: response.url || url,
        status: response.status,
        statusText: response.statusText || null,
        body,
        message: `${label} failed with HTTP ${response.status}.`,
        attempt: response.attempt || null,
      });
    }
    return { body, response };
  } catch (error) {
    if (error?.code) {
      throw error;
    }
    const networkDetails = getNetworkCauseDetails(error);
    throw createMarketplaceStepError(`${label} failed: ${error?.message || "Network request failed."}`, context.code || classifyNetworkError(error), {
      ...context,
      url,
      ...networkDetails,
      message: error?.message || "Network request failed.",
    });
  }
}

async function fetchJson(url, label, context = {}) {
  const { body } = await fetchTextWithDetails(url, label, context);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw createMarketplaceStepError(`${label} returned invalid JSON.`, context.code || "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      url,
      body,
      message: error?.message || "Invalid JSON.",
    });
  }
}

function latestFromList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  return values[values.length - 1];
}

function categorizeMinecraftVersion(version, type = "") {
  const text = String(version || "").trim();
  const lowerType = String(type || "").toLowerCase();
  if (lowerType.includes("snapshot") || /\d{2}w\d{2}[a-z]/i.test(text) || /pre|rc/i.test(text)) {
    return "snapshots";
  }
  if (lowerType.includes("old") || /^(rd-|c0\.|a1\.|b1\.|inf-|in-|0\.)/i.test(text)) {
    return "legacy";
  }
  return "releases";
}

function versionSortKey(version) {
  const text = String(version || "");
  const snapshot = text.match(/^(\d{2})w(\d{2})([a-z])$/i);
  if (snapshot) {
    return [Number(snapshot[1]) + 2000, Number(snapshot[2]), snapshot[3].toLowerCase().charCodeAt(0) - 96, 0];
  }
  const parts = text.match(/\d+/g)?.slice(0, 4).map((part) => Number.parseInt(part, 10)) || [];
  while (parts.length < 4) parts.push(0);
  return parts;
}

function compareMinecraftVersions(left, right) {
  const leftKey = versionSortKey(left?.id || left?.version || left);
  const rightKey = versionSortKey(right?.id || right?.version || right);
  for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
    const difference = (rightKey[index] || 0) - (leftKey[index] || 0);
    if (difference !== 0) return difference;
  }
  return String(right?.id || right?.version || right).localeCompare(String(left?.id || left?.version || left));
}

function normalizeVersionEntry(entry = {}) {
  const id = String(entry.id || entry.version || "").trim();
  if (!id) return null;
  return {
    id,
    label: entry.label || id,
    category: entry.category || categorizeMinecraftVersion(id, entry.type),
    type: entry.type || "",
    recommended: Boolean(entry.recommended),
    details: entry.details || "",
    loaderVersion: entry.loaderVersion || "",
    softwareVersion: entry.softwareVersion || "",
    url: entry.url || "",
    releaseTime: entry.releaseTime || entry.time || "",
  };
}

function uniqueVersionEntries(entries = []) {
  const byId = new Map();
  for (const rawEntry of entries) {
    const entry = normalizeVersionEntry(rawEntry);
    if (!entry) continue;
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing ? {
      ...existing,
      ...entry,
      recommended: existing.recommended || entry.recommended,
      details: entry.details || existing.details,
      loaderVersion: entry.loaderVersion || existing.loaderVersion,
      softwareVersion: entry.softwareVersion || existing.softwareVersion,
    } : entry);
  }
  return [...byId.values()].sort(compareMinecraftVersions);
}

function getLatestReleaseEntry(entries = []) {
  return entries.find((entry) => entry.category === "releases") || entries[0] || null;
}

function buildMinecraftCatalogResponse(template, entries, latest = null, extras = {}) {
  const versions = uniqueVersionEntries(entries);
  const latestEntry = latest
    ? normalizeVersionEntry(latest)
    : getLatestReleaseEntry(versions);
  const recommended = [
    ...(latestEntry ? [{ ...latestEntry, recommended: true }] : []),
    ...versions.filter((entry) => entry.recommended),
  ];
  return {
    templateId: template.id,
    provider: template.id.replace(/^minecraft-/, ""),
    fetchedAt: new Date().toISOString(),
    latest: latestEntry,
    versions,
    recommended: uniqueVersionEntries(recommended),
    filters: ["recommended", "releases", "snapshots", "legacy", "all"],
    ...extras,
  };
}

function getCachedMinecraftVersionCatalog(templateId) {
  const cached = minecraftVersionCatalogCache.get(templateId);
  if (cached && Date.now() - cached.cachedAt < MINECRAFT_VERSION_CATALOG_TTL_MS) {
    return cached.catalog;
  }
  return null;
}

function setCachedMinecraftVersionCatalog(templateId, catalog) {
  minecraftVersionCatalogCache.set(templateId, {
    catalog,
    cachedAt: Date.now(),
  });
  return catalog;
}

async function getVanillaVersionCatalog(template, context = {}) {
  const manifest = await fetchJson(MOJANG_VERSION_MANIFEST_URL, "Mojang version manifest", {
    ...context,
    step: "Resolve version catalog",
    code: "VERSION_CATALOG_FAILED",
  });
  const latestRelease = manifest?.latest?.release || latestFromList(manifest?.versions?.filter((entry) => entry.type === "release").map((entry) => entry.id));
  const entries = (manifest?.versions || []).map((entry) => ({
    id: entry.id,
    type: entry.type,
    category: categorizeMinecraftVersion(entry.id, entry.type),
    releaseTime: entry.releaseTime,
    url: entry.url,
    recommended: entry.id === latestRelease,
  }));
  return buildMinecraftCatalogResponse(template, entries, { id: latestRelease, category: "releases", recommended: true });
}

async function getPaperVersionCatalog(template, context = {}) {
  const api = await fetchJson("https://fill.papermc.io/v3/projects/paper/versions", "Paper version catalog", {
    ...context,
    step: "Resolve version catalog",
    code: "VERSION_CATALOG_FAILED",
  });
  const rawVersions = Array.isArray(api?.versions) ? api.versions : [];
  const entries = rawVersions.map((entry) => {
    const version = typeof entry === "string" ? entry : entry?.version?.id || entry?.id || entry?.version;
    return {
      id: version,
      category: categorizeMinecraftVersion(version, entry?.version?.type || entry?.type),
      recommended: Boolean(entry?.recommended || entry?.version?.recommended),
    };
  });
  const latest = api?.latest?.release || getLatestReleaseEntry(uniqueVersionEntries(entries))?.id;
  return buildMinecraftCatalogResponse(template, entries, { id: latest, category: "releases", recommended: true });
}

async function getPurpurVersionCatalog(template, context = {}) {
  const api = await fetchJson("https://api.purpurmc.org/v2/purpur", "Purpur version catalog", {
    ...context,
    step: "Resolve version catalog",
    code: "VERSION_CATALOG_FAILED",
  });
  const entries = (api?.versions || []).map((version) => ({
    id: version,
    category: categorizeMinecraftVersion(version),
  }));
  return buildMinecraftCatalogResponse(template, entries, { id: getLatestReleaseEntry(uniqueVersionEntries(entries))?.id, category: "releases", recommended: true });
}

async function getFabricVersionCatalog(template, context = {}) {
  const [games, loaders] = await Promise.all([
    fetchJson(`${FABRIC_META_URL}/versions/game`, "Fabric game version catalog", {
      ...context,
      step: "Resolve version catalog",
      code: "VERSION_CATALOG_FAILED",
    }),
    fetchJson(`${FABRIC_META_URL}/versions/loader`, "Fabric loader version catalog", {
      ...context,
      step: "Resolve version catalog",
      code: "VERSION_CATALOG_FAILED",
    }),
  ]);
  const stableLoader = loaders.find((entry) => entry.stable)?.version || loaders[0]?.version || "";
  const entries = (games || []).map((entry) => ({
    id: entry.version,
    category: entry.stable ? "releases" : categorizeMinecraftVersion(entry.version, "snapshot"),
    recommended: Boolean(entry.stable && entry.version === games.find((game) => game.stable)?.version),
    loaderVersion: stableLoader,
    details: stableLoader ? `Fabric Loader ${stableLoader}` : "",
  }));
  const latestStable = games.find((entry) => entry.stable)?.version || games[0]?.version;
  return buildMinecraftCatalogResponse(template, entries, { id: latestStable, category: "releases", recommended: true }, {
    loaderVersions: loaders.map((entry) => entry.version).filter(Boolean),
    latestLoader: stableLoader,
  });
}

async function getForgeVersionCatalog(template, context = {}) {
  const [metadataXml, promotions] = await Promise.all([
    fetchTextWithDetails(FORGE_MAVEN_METADATA_URL, "Forge version metadata", {
      ...context,
      step: "Resolve version catalog",
      code: "VERSION_CATALOG_FAILED",
    }).then((result) => result.body),
    fetchJson(FORGE_PROMOTIONS_URL, "Forge promotions", {
      ...context,
      step: "Resolve version catalog",
      code: "VERSION_CATALOG_FAILED",
    }).catch(() => ({})),
  ]);
  const promotionEntries = Object.entries(promotions?.promos || {});
  const recommendedByVersion = new Map();
  for (const [key, build] of promotionEntries) {
    const match = key.match(/^(.+)-(latest|recommended)$/);
    if (match) {
      recommendedByVersion.set(match[1], String(build));
    }
  }
  const entries = extractXmlTags(metadataXml, "version").map((forgeVersion) => {
    const [minecraftVersion, ...forgeParts] = String(forgeVersion).split("-");
    const forgeBuild = forgeParts.join("-");
    return {
      id: minecraftVersion,
      category: categorizeMinecraftVersion(minecraftVersion),
      softwareVersion: forgeBuild || forgeVersion,
      details: forgeBuild ? `Forge ${forgeBuild}` : `Forge ${forgeVersion}`,
      recommended: recommendedByVersion.has(minecraftVersion),
    };
  });
  const latestVersion = extractXmlTag(metadataXml, "latest");
  const latestMinecraft = latestVersion ? String(latestVersion).split("-")[0] : entries[0]?.id;
  return buildMinecraftCatalogResponse(template, entries, { id: latestMinecraft, category: "releases", recommended: true });
}

async function getNeoForgeVersionCatalog(template, context = {}) {
  const metadataXml = (await fetchTextWithDetails(NEOFORGE_MAVEN_METADATA_URL, "NeoForge version metadata", {
    ...context,
    step: "Resolve version catalog",
    code: "VERSION_CATALOG_FAILED",
  })).body;
  const versions = extractXmlTags(metadataXml, "version");
  const entries = versions.map((softwareVersion) => {
    const minecraftVersion = inferNeoForgeMinecraftVersion(softwareVersion);
    return {
      id: minecraftVersion || softwareVersion,
      category: categorizeMinecraftVersion(minecraftVersion || softwareVersion),
      softwareVersion,
      details: `NeoForge ${softwareVersion}`,
    };
  });
  const latestSoftware = extractXmlTag(metadataXml, "latest") || latestFromList(versions);
  const latestMinecraft = inferNeoForgeMinecraftVersion(latestSoftware) || entries[0]?.id;
  return buildMinecraftCatalogResponse(template, entries, { id: latestMinecraft, category: "releases", recommended: true });
}

async function getMinecraftVersionCatalog(templateId) {
  const template = findTemplate(templateId);
  if (template.category !== "Minecraft") {
    throw createMarketplaceError("Version catalogs are only available for Minecraft templates.", "VERSION_CATALOG_NOT_SUPPORTED", { templateId });
  }
  const cached = getCachedMinecraftVersionCatalog(template.id);
  if (cached) {
    return cached;
  }
  const context = { templateId: template.id };
  const resolver = {
    "minecraft-vanilla": getVanillaVersionCatalog,
    "minecraft-paper": getPaperVersionCatalog,
    "minecraft-purpur": getPurpurVersionCatalog,
    "minecraft-fabric": getFabricVersionCatalog,
    "minecraft-forge": getForgeVersionCatalog,
    "minecraft-neoforge": getNeoForgeVersionCatalog,
  }[template.id] || getVanillaVersionCatalog;

  const catalog = await resolver(template, context);
  return setCachedMinecraftVersionCatalog(template.id, catalog);
}

function extractXmlTag(xml, tagName) {
  const match = String(xml || "").match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
  return match ? match[1].trim() : "";
}

function extractXmlTags(xml, tagName) {
  return [...String(xml || "").matchAll(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, "g"))].map((match) => match[1].trim());
}

function inferNeoForgeMinecraftVersion(version) {
  const text = String(version || "");
  const literal = text.match(/\b1\.\d+(?:\.\d+)?\b/)?.[0];
  if (literal) {
    return literal;
  }
  const modern = text.match(/^(\d{2})\.(\d+)\./);
  return modern ? `1.${Number.parseInt(modern[1], 10)}.${Number.parseInt(modern[2], 10)}` : "";
}

// PaperMC's API exposes the minimum Java major each game version runs on. Read
// it defensively: older API shapes or proxy projects may omit it, in which
// case the pre-flight compatibility guard stays out of the way.
function getPaperJavaMinimum(entry) {
  const minimum = Number(entry?.version?.java?.version?.minimum ?? entry?.java?.version?.minimum);
  return Number.isInteger(minimum) && minimum > 0 ? minimum : null;
}

async function resolvePaperDownload(download, options = {}, context = {}) {
  const project = download.project || "paper";
  const projectUrl = `https://fill.papermc.io/v3/projects/${encodeURIComponent(project)}`;
  const versionsPayload = await fetchJson(`${projectUrl}/versions`, "Paper version lookup", context);
  const requestedVersion = options.version || download.version || "latest";
  const versionEntries = Array.isArray(versionsPayload?.versions) ? versionsPayload.versions : [];
  const javaMinimumByVersion = new Map();
  for (const entry of versionEntries) {
    const id = entry?.version?.id;
    const javaMinimum = getPaperJavaMinimum(entry);
    if (id && javaMinimum) {
      javaMinimumByVersion.set(String(id), javaMinimum);
    }
  }
  const candidateVersions = String(requestedVersion).toLowerCase() === "latest"
    ? versionEntries.map((entry) => entry?.version?.id).filter(Boolean)
    : [requestedVersion];

  for (const version of candidateVersions) {
    const builds = await fetchJson(`${projectUrl}/versions/${encodeURIComponent(String(version))}/builds`, "Paper build lookup", context);
    const buildEntries = Array.isArray(builds) ? builds : Array.isArray(builds?.builds) ? builds.builds : [];
    const requestedBuild = options.build || download.build || PAPER_DEFAULT_BUILD;
    const stableBuilds = buildEntries.filter((build) => String(build?.channel || "").toUpperCase() === "STABLE");
    const selectedBuild = String(requestedBuild).toLowerCase() === "latest"
      ? stableBuilds.sort((left, right) => Number(right.id || right.build) - Number(left.id || left.build))[0]
      : buildEntries.find((build) => String(build?.id || build?.build) === String(requestedBuild));
    const serverDownload = selectedBuild?.downloads?.["server:default"] || selectedBuild?.downloads?.server;

    if (selectedBuild && serverDownload?.url) {
      return {
        url: serverDownload.url,
        version,
        build: selectedBuild.id || selectedBuild.build,
        checksum: serverDownload.checksums?.sha256 || null,
        size: serverDownload.size || null,
        javaMinimum: javaMinimumByVersion.get(String(version)) || null,
      };
    }
  }

  throw createMarketplaceStepError("Unable to resolve latest stable Paper build.", "DOWNLOAD_RESOLVE_FAILED", {
    ...context,
    url: `${projectUrl}/versions`,
    message: "No stable Paper build with a server download was found.",
  });
}

async function resolvePaperProjectDownload(download, options = {}, context = {}) {
  const project = download.project || "paper";
  const projectUrl = `https://fill.papermc.io/v3/projects/${encodeURIComponent(project)}`;
  const versionsPayload = await fetchJson(`${projectUrl}/versions`, `${project} version lookup`, context);
  const requestedVersion = options.version || download.version || "latest";
  const versionEntries = Array.isArray(versionsPayload?.versions) ? versionsPayload.versions : [];
  const candidateVersions = String(requestedVersion).toLowerCase() === "latest"
    ? versionEntries.map((entry) => entry?.version?.id).filter(Boolean)
    : [requestedVersion];

  for (const version of candidateVersions) {
    const builds = await fetchJson(`${projectUrl}/versions/${encodeURIComponent(String(version))}/builds`, `${project} build lookup`, context);
    const buildEntries = Array.isArray(builds) ? builds : Array.isArray(builds?.builds) ? builds.builds : [];
    const requestedBuild = options.build || download.build || "latest";
    const stableBuilds = buildEntries.filter((build) => String(build?.channel || "").toUpperCase() === "STABLE");
    const selectedBuild = String(requestedBuild).toLowerCase() === "latest"
      ? stableBuilds.sort((left, right) => Number(right.id || right.build) - Number(left.id || left.build))[0]
      : buildEntries.find((build) => String(build?.id || build?.build) === String(requestedBuild));
    const serverDownload = selectedBuild?.downloads?.["server:default"] || selectedBuild?.downloads?.server;

    if (selectedBuild && serverDownload?.url) {
      return {
        url: serverDownload.url,
        version,
        build: selectedBuild.id || selectedBuild.build,
        checksum: serverDownload.checksums?.sha256 || null,
        size: serverDownload.size || null,
      };
    }
  }

  throw createMarketplaceStepError("Unable to resolve proxy download.", "PROXY_RESOLVE_FAILED", {
    ...context,
    url: `${projectUrl}/versions`,
    message: "No proxy build with a server download was found.",
  });
}

async function resolvePurpurDownload(download, options = {}, context = {}) {
  const projectUrl = "https://api.purpurmc.org/v2/purpur";
  const projectPayload = await fetchJson(projectUrl, "Purpur version lookup", context);
  const requestedVersion = options.version || download.version || "latest";
  const version = String(requestedVersion).toLowerCase() === "latest"
    ? latestFromList(projectPayload?.versions)
    : requestedVersion;

  if (!version) {
    throw createMarketplaceStepError("Unable to resolve latest Purpur version.", "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      url: projectUrl,
      message: "Purpur API did not return a usable version.",
    });
  }

  const versionPayload = await fetchJson(`${projectUrl}/${encodeURIComponent(String(version))}`, "Purpur build lookup", context);
  const builds = versionPayload?.builds;
  const allBuilds = Array.isArray(builds?.all) ? builds.all : Array.isArray(builds) ? builds : [];
  const requestedBuild = options.build || download.build || "latest";
  const build = String(requestedBuild).toLowerCase() === "latest"
    ? builds?.latest || latestFromList(allBuilds)
    : requestedBuild;

  if (!build) {
    throw createMarketplaceStepError("Unable to resolve latest Purpur build.", "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      url: `${projectUrl}/${encodeURIComponent(String(version))}`,
      message: "Purpur API did not return a usable build.",
    });
  }

  return {
    url: `${projectUrl}/${encodeURIComponent(String(version))}/${encodeURIComponent(String(build))}/download`,
    version,
    build,
  };
}

async function resolveFabricDownload(download, options = {}, context = {}) {
  const games = await fetchJson(`${FABRIC_META_URL}/versions/game`, "Fabric game version lookup", context);
  const loaders = await fetchJson(`${FABRIC_META_URL}/versions/loader`, "Fabric loader lookup", context);
  const installers = await fetchJson(`${FABRIC_META_URL}/versions/installer`, "Fabric installer lookup", context);
  const requestedVersion = options.version || download.version || "latest";
  const game = String(requestedVersion).toLowerCase() === "latest"
    ? games.find((entry) => entry.stable)?.version
    : requestedVersion;
  const loader = loaders.find((entry) => entry.stable)?.version || loaders[0]?.version;
  const installer = installers.find((entry) => entry.stable)?.version || installers[0]?.version;

  if (!game || !loader || !installer) {
    throw createMarketplaceStepError("Unable to resolve Fabric download.", "FABRIC_RESOLVE_FAILED", {
      ...context,
      url: `${FABRIC_META_URL}/versions/loader`,
      message: "Fabric metadata did not include a usable game, loader, or installer version.",
    });
  }

  return {
    url: `${FABRIC_META_URL}/versions/loader/${encodeURIComponent(String(game))}/${encodeURIComponent(String(loader))}/${encodeURIComponent(String(installer))}/server/jar`,
    version: game,
    build: loader,
  };
}

async function resolveForgeDownload(download, options = {}, context = {}) {
  const requestedVersion = options.version || download.version || "latest";
  let forgeVersion = "";
  let metadata = "";

  if (String(requestedVersion).toLowerCase() !== "latest") {
    const promotions = await fetchJson(FORGE_PROMOTIONS_URL, "Forge promotions lookup", context);
    const promos = promotions?.promos || {};
    const forgeBuild = promos[`${requestedVersion}-recommended`] || promos[`${requestedVersion}-latest`];
    if (forgeBuild) {
      forgeVersion = `${requestedVersion}-${forgeBuild}`;
    }
  }

  if (!forgeVersion) {
    ({ body: metadata } = await fetchTextWithDetails(FORGE_MAVEN_METADATA_URL, "Forge metadata lookup", { ...context, code: "FORGE_RESOLVE_FAILED" }));
    const versions = extractXmlTags(metadata, "version");
    if (String(requestedVersion).toLowerCase() !== "latest") {
      forgeVersion = versions.filter((version) => String(version).startsWith(`${requestedVersion}-`)).at(-1) || "";
    }
    if (!forgeVersion) {
      forgeVersion = extractXmlTag(metadata, "release") || extractXmlTag(metadata, "latest");
    }
  }

  if (!forgeVersion) {
    throw createMarketplaceStepError("Unable to download Forge installer.", "FORGE_RESOLVE_FAILED", {
      ...context,
      url: FORGE_MAVEN_METADATA_URL,
      message: "Forge metadata did not include a usable release or latest version.",
    });
  }

  return {
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(forgeVersion)}/forge-${encodeURIComponent(forgeVersion)}-installer.jar`,
    version: forgeVersion.split("-")[0],
    build: forgeVersion,
  };
}

async function resolveNeoForgeDownload(download, options = {}, context = {}) {
  const requestedVersion = options.version || download.version || "latest";
  const { body: metadata } = await fetchTextWithDetails(NEOFORGE_MAVEN_METADATA_URL, "NeoForge metadata lookup", { ...context, code: "NEOFORGE_RESOLVE_FAILED" });
  const versions = extractXmlTags(metadata, "version");
  let neoForgeVersion = extractXmlTag(metadata, "release") || extractXmlTag(metadata, "latest");
  if (String(requestedVersion).toLowerCase() !== "latest") {
    neoForgeVersion = versions.filter((version) => inferNeoForgeMinecraftVersion(version) === String(requestedVersion)).at(-1) ||
      versions.filter((version) => version.startsWith(`${requestedVersion}.`)).at(-1) ||
      neoForgeVersion;
  }

  if (!neoForgeVersion) {
    throw createMarketplaceStepError("Unable to download NeoForge installer.", "NEOFORGE_RESOLVE_FAILED", {
      ...context,
      url: NEOFORGE_MAVEN_METADATA_URL,
      message: "NeoForge metadata did not include a usable release or latest version.",
    });
  }

  return {
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(neoForgeVersion)}/neoforge-${encodeURIComponent(neoForgeVersion)}-installer.jar`,
    version: String(requestedVersion).toLowerCase() === "latest" ? inferNeoForgeMinecraftVersion(neoForgeVersion) || requestedVersion : requestedVersion,
    build: neoForgeVersion,
  };
}

async function resolveBungeeCordDownload() {
  return {
    url: BUNGEECORD_JAR_URL,
    version: "latest",
  };
}

async function resolveGithubReleaseDownload(download, options = {}, context = {}) {
  const repo = String(download.repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw createMarketplaceStepError("GitHub release resolver is missing a repo.", "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      message: "Template download metadata must include a GitHub owner/repo.",
    });
  }

  const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await fetchJson(releaseUrl, "GitHub release lookup", context);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const pattern = download.assetPattern ? new RegExp(download.assetPattern, "i") : null;
  const asset = assets.find((entry) => {
    return entry?.browser_download_url && (!pattern || pattern.test(entry.name || ""));
  });

  if (!asset?.browser_download_url) {
    throw createMarketplaceStepError("Unable to resolve GitHub release asset.", "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      url: releaseUrl,
      body: JSON.stringify({ tag: release?.tag_name || null, assets: assets.map((entry) => entry?.name).filter(Boolean).slice(0, 25) }),
      message: "The latest GitHub release did not contain a matching downloadable asset.",
    });
  }

  return {
    url: asset.browser_download_url,
    version: release?.tag_name || "latest",
    size: asset.size || null,
  };
}

async function resolveFiveMDownload(download = {}, options = {}, context = {}) {
  const windows = download.resolver === "fivem-windows" || download.platform === "windows";
  const fileName = windows ? "server.zip" : "fx.tar.xz";
  const listingUrl = windows
    ? "https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/"
    : "https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/";
  const { body: html } = await fetchTextWithDetails(listingUrl, "FiveM artifact lookup", context);
  const hrefPattern = windows ? /href="([^"]+server\.zip)"/gi : /href="([^"]+fx\.tar\.xz)"/gi;
  const hrefs = [...html.matchAll(hrefPattern)].map((match) => match[1]);
  const href = hrefs[0];
  if (!href) {
    throw createMarketplaceStepError("Unable to resolve latest FiveM FXServer artifact.", "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      url: listingUrl,
      body: html,
      message: `FiveM artifact listing did not include a ${fileName} download.`,
    });
  }

  const version = String(href).match(new RegExp(`/([^/]+)/${fileName.replace(".", "\\.")}$`, "i"))?.[1] || "latest";
  return {
    url: new URL(href, listingUrl).toString(),
    version,
  };
}

async function resolveFiveMServerDataDownload(download = {}) {
  const ref = String(download.ref || "refs/heads/master").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(ref) || ref.includes("..")) {
    throw createMarketplaceError("FiveM server data ref is invalid.", "INVALID_TEMPLATE_CATALOG", { ref });
  }
  // Official Cfx.re server data pack (cfx-server-data) — provides the stock
  // resources (mapmanager, spawnmanager, gamemode, maps) a FiveM client needs
  // before it can spawn into the world.
  return {
    url: `https://codeload.github.com/citizenfx/cfx-server-data/tar.gz/${ref}`,
    version: ref.replace(/^refs\/(?:heads|tags)\//, ""),
  };
}

async function resolveVanillaDownload(download, options = {}, context = {}) {
  const manifest = await fetchJson(download.manifestUrl || MOJANG_VERSION_MANIFEST_URL, "Mojang version lookup", context);
  const requestedVersion = options.version || download.version || "latest";
  const versionId = String(requestedVersion).toLowerCase() === "latest"
    ? manifest?.latest?.release
    : requestedVersion;
  const versionEntry = Array.isArray(manifest?.versions)
    ? manifest.versions.find((entry) => entry.id === versionId)
    : null;

  if (!versionEntry?.url) {
    throw createMarketplaceStepError("Unable to resolve latest Vanilla server version.", "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      url: download.manifestUrl || MOJANG_VERSION_MANIFEST_URL,
      message: "Mojang manifest did not include the requested server version.",
    });
  }

  const versionPayload = await fetchJson(versionEntry.url, "Mojang server download lookup", context);
  const url = versionPayload?.downloads?.server?.url;
  if (!url) {
    throw createMarketplaceStepError("Unable to resolve Vanilla server jar URL.", "DOWNLOAD_RESOLVE_FAILED", {
      ...context,
      url: versionEntry.url,
      body: JSON.stringify(versionPayload?.downloads || {}),
      message: "Mojang version metadata did not include a server jar URL.",
    });
  }

  const javaMinimum = Number(versionPayload?.javaVersion?.majorVersion);

  return {
    url,
    version: versionId,
    javaMinimum: Number.isInteger(javaMinimum) && javaMinimum > 0 ? javaMinimum : null,
  };
}

async function resolveDownloadUrl(download, options = {}, context = {}) {
  if (download.resolver === "papermc") {
    return resolvePaperDownload(download, options, context);
  }

  if (download.resolver === "paper-project") {
    return resolvePaperProjectDownload(download, options, context);
  }

  if (download.resolver === "purpur") {
    return resolvePurpurDownload(download, options, context);
  }

  if (download.resolver === "fabric") {
    return resolveFabricDownload(download, options, context);
  }

  if (download.resolver === "forge") {
    return resolveForgeDownload(download, options, context);
  }

  if (download.resolver === "neoforge") {
    return resolveNeoForgeDownload(download, options, context);
  }

  if (download.resolver === "bungeecord") {
    return resolveBungeeCordDownload(download, options);
  }

  if (download.resolver === "github-release") {
    return resolveGithubReleaseDownload(download, options, context);
  }

  if (download.resolver === "fivem-linux" || download.resolver === "fivem-windows") {
    return resolveFiveMDownload(download, options, context);
  }

  if (download.resolver === "fivem-server-data") {
    return resolveFiveMServerDataDownload(download);
  }

  if (download.resolver === "mojang-vanilla") {
    return resolveVanillaDownload(download, options, context);
  }

  return { url: resolveUrlTemplate(download, options) };
}

async function writeInstanceText(instanceId, filePath, content, agentConfig = null) {
  return agentClient.writeInstanceFile(instanceId, filePath, content, { config: agentConfig });
}

async function writeInstanceBuffer(instanceId, filePath, buffer, agentConfig = null) {
  return agentClient.writeInstanceFile(instanceId, filePath, Buffer.from(buffer).toString("base64"), { encoding: "base64", config: agentConfig });
}

function buildMinecraftProperties(options, ports) {
  return buildMinecraftServerProperties(options, ports[0] || 25565);
}

function firstPort(ports, fallback = 3000) {
  return Array.isArray(ports) && ports[0] ? ports[0] : fallback;
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "'\"'\"'")}'`;
}

function psSingleQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function normalizeArchiveVerifyFile(filePath, extractDir) {
  const normalizedFile = normalizeInstanceFilePath(filePath);
  const normalizedExtractDir = normalizeInstanceFilePath(extractDir).replace(/\/+$/, "");
  const prefix = `${normalizedExtractDir}/`;
  return normalizedFile.startsWith(prefix) ? normalizedFile.slice(prefix.length) : normalizedFile;
}

function buildAdditionalArchiveExtractionPowerShell(installer) {
  const lines = [];
  for (const entry of normalizeAdditionalArchives(installer)) {
    lines.push(`# Additional archive: ${entry.archive} -> ${entry.extractDir}`);
    lines.push(`$additionalArchive = ${psSingleQuote(entry.archive)}`);
    lines.push(`$additionalDir = ${psSingleQuote(entry.extractDir)}`);
    lines.push("New-Item -ItemType Directory -Force -Path $additionalDir | Out-Null");
    if (/\.zip$/i.test(entry.archive)) {
      if (entry.stripComponents > 0) {
        throw createMarketplaceError("Zip additional archives do not support stripComponents.", "INVALID_TEMPLATE_CATALOG", { archive: entry.archive });
      }
      lines.push("Expand-Archive -Path $additionalArchive -DestinationPath $additionalDir -Force");
    } else if (/\.tar\.xz$/i.test(entry.archive)) {
      throw createMarketplaceError("Windows installs cannot extract .tar.xz additional archives.", "INVALID_TEMPLATE_CATALOG", { archive: entry.archive });
    } else if (/\.tar\.gz$|\.tgz$|\.tar$/i.test(entry.archive)) {
      const flags = /\.tar\.gz$|\.tgz$/i.test(entry.archive) ? "-xzf" : "-xf";
      lines.push(`tar ${flags} $additionalArchive -C $additionalDir${entry.stripComponents > 0 ? ` --strip-components=${entry.stripComponents}` : ""}`);
      lines.push(`if ($LASTEXITCODE -ne 0) { throw ${psSingleQuote(`Failed to extract ${entry.archive}.`)} }`);
    } else {
      throw createMarketplaceError("Additional archive type is not supported.", "INVALID_TEMPLATE_CATALOG", { archive: entry.archive });
    }
  }
  return lines;
}

function buildWindowsArchiveInstallerScript(installer) {
  const archive = installer.archive || getPrimaryArtifactPath(installer.template || {}, {});
  assertSafeInstallerArchive(archive);
  const archivePath = normalizeInstanceFilePath(archive);
  assertSafeInstallerExtractDir(installer.extractDir);
  const extractDir = normalizeInstanceFilePath(installer.extractDir || "server");
  if (!/\.zip$/i.test(archivePath)) {
    throw createMarketplaceError("Windows archive installers currently require a .zip archive.", "INSTALLER_TYPE_UNSUPPORTED", {
      installerType: "archive-download",
      platform: "windows",
      archive: archivePath,
    });
  }
  const expectedFiles = (Array.isArray(installer.verifyFiles) ? installer.verifyFiles : [])
    .map((filePath) => normalizeArchiveVerifyFile(filePath, extractDir))
    .filter(Boolean);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$archivePath = ${psSingleQuote(archivePath)}`,
    `$extractDir = ${psSingleQuote(extractDir)}`,
    "New-Item -ItemType Directory -Force -Path $extractDir | Out-Null",
    "Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force",
    ...buildAdditionalArchiveExtractionPowerShell(installer),
    `$expectedFiles = @(${expectedFiles.map(psSingleQuote).join(", ")})`,
    "if ($expectedFiles.Count -gt 0) {",
    "  $missing = $false",
    "  foreach ($expectedFile in $expectedFiles) {",
    "    if (-not (Test-Path -LiteralPath (Join-Path $extractDir $expectedFile))) { $missing = $true }",
    "  }",
    "  if ($missing) {",
    "    $children = @(Get-ChildItem -LiteralPath $extractDir -Force)",
    "    $directories = @($children | Where-Object { $_.PSIsContainer })",
    "    if ($children.Count -eq 1 -and $directories.Count -eq 1) {",
    "      $root = $directories[0].FullName",
    "      $rootMatches = $true",
    "      foreach ($expectedFile in $expectedFiles) {",
    "        if (-not (Test-Path -LiteralPath (Join-Path $root $expectedFile))) { $rootMatches = $false }",
    "      }",
    "      if ($rootMatches) {",
    "        Get-ChildItem -LiteralPath $root -Force | Move-Item -Destination $extractDir -Force",
    "        Remove-Item -LiteralPath $root -Force",
    "      }",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

function templateValue(key, template, options = {}, ports = []) {
  const values = {
    id: slugify(options.id || options.name || template.id),
    name: normalizeName(options.name, template.displayName || template.id),
    displayName: template.displayName || template.id,
    memory: normalizeName(options.memory, template.defaultRam || ""),
    port: String(firstPort(ports, firstPort(template.defaultPorts, 3000))),
    serverPort: String(options.serverPort || firstPort(ports, firstPort(template.defaultPorts, 3000))),
    queryPort: String(options.queryPort || (ports[1] || "")),
    rconPort: String(options.rconPort || ""),
    maxPlayers: String(options.maxPlayers || options.players || 32),
    version: options.version || "latest",
    jar: getPrimaryArtifactName(template, options),
  };

  return values[key] ?? "";
}

function expandTemplateString(value, template, options = {}, ports = []) {
  return String(value ?? "").replace(/\{([a-zA-Z0-9_-]+)\}/g, (_, key) => {
    return String(templateValue(key, template, options, ports));
  });
}

function expandTemplateArray(values = [], template, options = {}, ports = []) {
  return Array.isArray(values)
    ? values.map((value) => expandTemplateString(value, template, options, ports))
    : [];
}

function buildConfigFileContent(configFile, template, options, ports) {
  if (Array.isArray(configFile.lines)) {
    return `${configFile.lines.map((line) => expandTemplateString(line, template, options, ports)).join("\n")}\n`;
  }

  if (configFile.content !== undefined) {
    return expandTemplateString(configFile.content, template, options, ports);
  }

  return "";
}

function buildSteamCmdInstallerScript(installer) {
  const installDir = installer.installDir || "server";
  const login = installer.login === "required"
    ? [
      "echo \"This server requires a Steam account login and cannot be installed automatically yet.\" >&2",
      "exit 42",
    ].join("\n")
    : "login anonymous";
  const validate = installer.validate === false ? "" : " validate";
  const extraCommands = Array.isArray(installer.extraCommands) ? installer.extraCommands : [];
  const commandParts = [
    "+force_install_dir", "\"$INSTALL_DIR\"",
    `+${login}`,
    "+app_update", String(installer.appId), validate.trim(),
    ...extraCommands.map((command) => `+${command}`),
    "+quit",
  ].filter(Boolean);

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if ! command -v steamcmd >/dev/null 2>&1; then",
    "  echo \"SteamCMD is required for this template. Install steamcmd on the host, then retry.\" >&2",
    "  exit 127",
    "fi",
    `INSTALL_DIR="${installDir}"`,
    "mkdir -p \"$INSTALL_DIR\"",
    `steamcmd ${commandParts.join(" ")}`,
    "",
  ].join("\n");
}

function buildSteamCmdInstallerArgs(installer = {}, installDirOverride = null) {
  if (!installer.appId) {
    throw createMarketplaceError("SteamCMD template is missing an app ID.", "INVALID_TEMPLATE_CATALOG");
  }
  if (installer.login === "required") {
    throw createMarketplaceError("This SteamCMD template requires authenticated Steam login, which is not implemented for unattended installs.", "INSTALLER_TYPE_UNSUPPORTED", {
      installerType: "steamcmd-native",
      appId: installer.appId,
    });
  }
  const args = [
    "+force_install_dir",
    installDirOverride || installer.installDir || "server",
    "+login",
    "anonymous",
    "+app_update",
    String(installer.appId),
  ];
  if (installer.validate !== false) {
    args.push("validate");
  }
  for (const command of Array.isArray(installer.extraCommands) ? installer.extraCommands : []) {
    const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      args.push(`+${parts[0]}`, ...parts.slice(1));
    }
  }
  args.push("+quit");
  return args;
}

// Additional archive paths end up inside tar/unzip shell commands, so they must
// stay relative to the instance directory. Mirrors the reject-".." discipline in
// src/shared/agentRuntimePayload.js: absolute paths, ".." fragments, drive or
// scheme separators, and C0 control characters are refused before any script is
// generated. Control characters matter because entry.archive/extractDir are
// interpolated into the generated installer script's comment lines, where a
// newline would start a new, attacker-controlled command line.
function hasUnsafeInstancePathSegments(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return normalized.startsWith("/") || normalized.includes("..") || normalized.includes(":") || /[\u0000-\u001f]/.test(normalized);
}

// The top-level installer.extractDir becomes the tar/unzip extraction target
// and the PowerShell Expand-Archive destination, so it must satisfy the same
// containment rule as additionalArchives entries before any script is built.
function assertSafeInstallerExtractDir(extractDir) {
  if (hasUnsafeInstancePathSegments(extractDir)) {
    throw createMarketplaceError("Installer extractDir must not use absolute paths, \"..\" segments, or control characters.", "INVALID_TEMPLATE_CATALOG", { extractDir });
  }
}

// The top-level installer.archive is interpolated as the tar/unzip source argument
// and as the PowerShell Expand-Archive -Path, so a ".." or absolute value would read
// outside the instance directory. Same containment rule as additionalArchives entries.
function assertSafeInstallerArchive(archive) {
  if (hasUnsafeInstancePathSegments(archive)) {
    throw createMarketplaceError("Installer archive must not use absolute paths, \"..\" segments, or control characters.", "INVALID_TEMPLATE_CATALOG", { archive });
  }
}

function normalizeAdditionalArchives(installer = {}) {
  const entries = Array.isArray(installer.additionalArchives) ? installer.additionalArchives : [];
  return entries.map((entry) => {
    if (hasUnsafeInstancePathSegments(entry?.archive) || hasUnsafeInstancePathSegments(entry?.extractDir)) {
      throw createMarketplaceError("Additional archive entries must not use absolute paths, \"..\" segments, or control characters.", "INVALID_TEMPLATE_CATALOG", { entry });
    }
    const archive = normalizeInstanceFilePath(entry?.archive || "");
    const extractDir = normalizeInstanceFilePath(entry?.extractDir || "");
    const stripComponents = Number.isInteger(entry?.stripComponents) ? entry.stripComponents : 0;
    if (!archive || !extractDir || stripComponents < 0) {
      throw createMarketplaceError("Additional archive entries require archive, extractDir and a non-negative stripComponents.", "INVALID_TEMPLATE_CATALOG", { entry });
    }
    return { archive, extractDir, stripComponents };
  });
}

function buildAdditionalArchiveExtractionShell(installer) {
  const lines = [];
  for (const entry of normalizeAdditionalArchives(installer)) {
    const tarFlags = /\.tar\.xz$/i.test(entry.archive) ? "-xJf"
      : /\.tar\.gz$|\.tgz$/i.test(entry.archive) ? "-xzf"
        : /\.tar$/i.test(entry.archive) ? "-xf"
          : "";
    lines.push(`# Additional archive: ${entry.archive} -> ${entry.extractDir}`);
    lines.push(`mkdir -p ${shellQuote(entry.extractDir)}`);
    if (tarFlags) {
      lines.push("if ! command -v tar >/dev/null 2>&1; then");
      lines.push(`  echo ${shellQuote(`tar is required to extract ${entry.archive}.`)} >&2`);
      lines.push("  exit 127");
      lines.push("fi");
      lines.push(`tar ${tarFlags} ${shellQuote(entry.archive)} -C ${shellQuote(entry.extractDir)}${entry.stripComponents > 0 ? ` --strip-components=${entry.stripComponents}` : ""}`);
    } else if (/\.zip$/i.test(entry.archive)) {
      if (entry.stripComponents > 0) {
        throw createMarketplaceError("Zip additional archives do not support stripComponents.", "INVALID_TEMPLATE_CATALOG", { archive: entry.archive });
      }
      lines.push("if ! command -v unzip >/dev/null 2>&1; then");
      lines.push(`  echo ${shellQuote(`unzip is required to extract ${entry.archive}.`)} >&2`);
      lines.push("  exit 127");
      lines.push("fi");
      lines.push(`unzip -o ${shellQuote(entry.archive)} -d ${shellQuote(entry.extractDir)}`);
    } else {
      throw createMarketplaceError("Additional archive type is not supported.", "INVALID_TEMPLATE_CATALOG", { archive: entry.archive });
    }
  }
  return lines;
}

function buildArchiveInstallerScript(installer) {
  const archive = installer.archive || getPrimaryArtifactPath(installer.template || {}, {});
  assertSafeInstallerArchive(archive);
  const archivePath = normalizeInstanceFilePath(archive);
  assertSafeInstallerExtractDir(installer.extractDir);
  const extractDir = installer.extractDir || "server";
  const stripComponents = Number.isInteger(installer.stripComponents) ? installer.stripComponents : 0;
  const tarFlags = String(archivePath).endsWith(".tar.xz") ? "-xJf" : String(archivePath).endsWith(".tar.gz") || String(archivePath).endsWith(".tgz") ? "-xzf" : "";
  const expectedFiles = (Array.isArray(installer.verifyFiles) ? installer.verifyFiles : [])
    .map((filePath) => normalizeArchiveVerifyFile(filePath, extractDir))
    .filter(Boolean);
  const nestedArchiveExtraction = [
    "NESTED_ARCHIVES_FILE=$(mktemp)",
    "find \"$EXTRACT_DIR\" -maxdepth 2 -type f \\( -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' -o -name '*.tar.xz' \\) > \"$NESTED_ARCHIVES_FILE\"",
    "if [ -s \"$NESTED_ARCHIVES_FILE\" ]; then",
    "  if ! command -v tar >/dev/null 2>&1; then",
    "    echo \"tar is required to extract nested archive payloads.\" >&2",
    "    rm -f \"$NESTED_ARCHIVES_FILE\"",
    "    exit 127",
    "  fi",
    "  while IFS= read -r nested_archive; do",
    "    case \"$nested_archive\" in",
    "      *.tar.xz) tar -xJf \"$nested_archive\" -C \"$EXTRACT_DIR\" ;;",
    "      *.tar.gz|*.tgz) tar -xzf \"$nested_archive\" -C \"$EXTRACT_DIR\" ;;",
    "      *.tar) tar -xf \"$nested_archive\" -C \"$EXTRACT_DIR\" ;;",
    "    esac",
    "  done < \"$NESTED_ARCHIVES_FILE\"",
    "fi",
    "rm -f \"$NESTED_ARCHIVES_FILE\"",
  ];
  const singleRootNormalization = expectedFiles.length > 0 ? [
    `EXPECTED_FILES=(${expectedFiles.map(shellQuote).join(" ")})`,
    "missing_expected=0",
    "for expected_file in \"${EXPECTED_FILES[@]}\"; do",
    "  if [ ! -e \"$EXTRACT_DIR/$expected_file\" ]; then",
    "    missing_expected=1",
    "  fi",
    "done",
    "if [ \"$missing_expected\" -eq 1 ]; then",
    "  mapfile -t root_dirs < <(find \"$EXTRACT_DIR\" -mindepth 1 -maxdepth 1 -type d)",
    "  if [ \"${#root_dirs[@]}\" -eq 1 ]; then",
    "    root_dir=\"${root_dirs[0]}\"",
    "    root_matches=1",
    "    for expected_file in \"${EXPECTED_FILES[@]}\"; do",
    "      if [ ! -e \"$root_dir/$expected_file\" ]; then",
    "        root_matches=0",
    "      fi",
    "    done",
    "    if [ \"$root_matches\" -eq 1 ]; then",
    "      shopt -s dotglob nullglob",
    "      mv \"$root_dir\"/* \"$EXTRACT_DIR\"/",
    "      shopt -u dotglob nullglob",
    "      rmdir \"$root_dir\" 2>/dev/null || true",
    "    fi",
    "  fi",
    "fi",
  ] : [
    "# No installer verify files declared; skipping archive layout normalization.",
  ];

  if (tarFlags) {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if ! command -v tar >/dev/null 2>&1; then",
      "  echo \"tar is required to extract this server runtime.\" >&2",
      "  exit 127",
      "fi",
      `EXTRACT_DIR=${shellQuote(extractDir)}`,
      "mkdir -p \"$EXTRACT_DIR\"",
      `tar ${tarFlags} ${shellQuote(archivePath)} -C "$EXTRACT_DIR"${stripComponents > 0 ? ` --strip-components=${stripComponents}` : ""}`,
      ...buildAdditionalArchiveExtractionShell(installer),
      ...singleRootNormalization,
      "",
    ].join("\n");
  }

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if ! command -v unzip >/dev/null 2>&1; then",
    "  echo \"unzip is required to extract this server runtime.\" >&2",
    "  exit 127",
    "fi",
    `EXTRACT_DIR=${shellQuote(extractDir)}`,
    "mkdir -p \"$EXTRACT_DIR\"",
      `unzip -o ${shellQuote(archivePath)} -d "$EXTRACT_DIR"`,
      ...nestedArchiveExtraction,
      ...buildAdditionalArchiveExtractionShell(installer),
      ...singleRootNormalization,
    "",
  ].join("\n");
}

function buildTemplateInstallerScript(template) {
  const installer = template.installer || null;
  if (!installer) {
    return null;
  }

  if (installer.type === "steamcmd") {
    if (!installer.appId) {
      throw createMarketplaceError("SteamCMD template is missing an app ID.", "INVALID_TEMPLATE_CATALOG");
    }
    return buildSteamCmdInstallerScript(installer);
  }

  if (installer.type === "archive") {
    return buildArchiveInstallerScript({
      ...installer,
      archive: installer.archive,
      template,
    });
  }

  if (installer.type === "manual") {
    throw createMarketplaceError(installer.message || "This server requires manual setup.", "MANUAL_SETUP_REQUIRED");
  }

  throw createMarketplaceError("This installer type is not supported.", "INSTALLER_NOT_SUPPORTED");
}

function generatedFileForTemplate(template, options, ports) {
  const port = ports[0] || 3000;
  const appName = normalizeName(options.name, template.displayName || "AnxOS App");

  if (template.instanceType === "node-app") {
    return {
      path: "index.js",
      content: [
        "const http = require(\"http\");",
        `const port = Number(process.env.PORT || ${port});`,
        `const name = ${JSON.stringify(appName)};`,
        "http.createServer((_, response) => {",
        "  response.writeHead(200, { \"content-type\": \"application/json\" });",
        "  response.end(JSON.stringify({ ok: true, service: name }));",
        "}).listen(port, () => console.log(`${name} listening on ${port}`));",
        "",
      ].join("\n"),
    };
  }

  if (template.instanceType === "python-app") {
    return {
      path: template.id === "python-discord-bot" ? "bot.py" : "app.py",
      content: [
        "import os",
        "import time",
        `name = ${JSON.stringify(appName)}`,
        "print(f\"{name} started\", flush=True)",
        "while True:",
        "    time.sleep(30)",
        "",
      ].join("\n"),
    };
  }

  return null;
}

function getTemplateServerSoftware(template = {}) {
  const searchable = [template.id, template.displayName, template.instanceType, ...(Array.isArray(template.tags) ? template.tags : [])].join(" ").toLowerCase();
  if (searchable.includes("neoforge")) return "NeoForge";
  if (searchable.includes("forge")) return "Forge";
  if (searchable.includes("fabric")) return "Fabric";
  if (searchable.includes("purpur")) return "Purpur";
  if (searchable.includes("paper")) return "Paper";
  if (searchable.includes("vanilla")) return "Vanilla";
  return template.serverSoftware || null;
}

function getTemplateGameFamily(template = {}) {
  const searchable = [template.id, template.displayName, template.instanceType, ...(Array.isArray(template.tags) ? template.tags : [])].join(" ").toLowerCase();
  if (template.category === "Minecraft" || searchable.includes("minecraft")) return "minecraft";
  if (searchable.includes("terraria") || searchable.includes("tshock")) return "terraria";
  if (searchable.includes("fivem") || searchable.includes("fxserver")) return "fivem";
  if (searchable.includes("valheim")) return "valheim";
  if (searchable.includes("rust")) return "rust";
  if (searchable.includes("palworld")) return "palworld";
  if (searchable.includes("counter-strike") || searchable.includes("cs2")) return "cs2";
  return null;
}

function buildTemplateVersionInfo(template, values = {}) {
  const game = values.game || getTemplateGameFamily(template);
  const software = values.software || getTemplateServerSoftware(template) || template.displayName || template.id;
  const gameVersion = values.gameVersion || values.minecraftVersion || values.serverVersion || null;
  const softwareVersion = values.softwareVersion || null;
  const buildNumber = values.buildNumber || values.paperBuild || null;
  const buildDate = values.buildDate || null;
  let displayVersion = values.displayVersion || null;
  let displayVersionDetail = values.displayVersionDetail || null;

  if (!displayVersion) {
    if (game === "minecraft") {
      displayVersion = [
        software,
        gameVersion,
        buildNumber && /paper|purpur|folia/i.test(String(software || "")) ? `build ${buildNumber}` : null,
        softwareVersion && !String(softwareVersion).includes(String(gameVersion || "")) && !/paper|purpur|folia/i.test(String(software || "")) ? softwareVersion : null,
      ].filter(Boolean).join(" ") || gameVersion || softwareVersion || buildNumber || null;
    } else if (game === "fivem" && buildNumber) {
      displayVersion = `Artifact ${buildNumber}`;
    } else {
      displayVersion = gameVersion || softwareVersion || buildNumber || null;
    }
  }

  if (!displayVersionDetail) {
    if (game === "minecraft") {
      if ((/paper|purpur/i.test(software)) && buildNumber) {
        displayVersionDetail = `${software} Build ${buildNumber}`;
      } else if ((/fabric|quilt/i.test(software)) && softwareVersion) {
        displayVersionDetail = `${software} Loader ${softwareVersion}`;
      } else if ((/forge|neoforge|mohist|magma|arclight/i.test(software)) && softwareVersion) {
        displayVersionDetail = `${software} ${softwareVersion}`;
      } else if (softwareVersion && softwareVersion !== gameVersion) {
        displayVersionDetail = `${software} ${softwareVersion}`;
      } else if (buildNumber) {
        displayVersionDetail = `${software} Build ${buildNumber}`;
      }
    } else if (game === "terraria" && softwareVersion) {
      displayVersionDetail = `${software} ${softwareVersion}`;
    } else if (game === "fivem" && buildNumber) {
      displayVersionDetail = `${software} Artifact ${buildNumber}`;
    } else if (softwareVersion && softwareVersion !== displayVersion) {
      displayVersionDetail = `${software} ${softwareVersion}`;
    }
  }

  return {
    game,
    software,
    gameVersion,
    softwareVersion,
    buildNumber,
    buildDate,
    displayVersion,
    displayVersionDetail,
    isMinecraft: game === "minecraft",
  };
}

function getTemplateStartupEnvironment(template = {}) {
  return template.startup?.environment && typeof template.startup.environment === "object" && !Array.isArray(template.startup.environment)
    ? Object.entries(template.startup.environment).reduce((environment, [key, value]) => {
      environment[String(key)] = String(value ?? "");
      return environment;
    }, {})
    : {};
}

function buildInstancePayload(template, options, ports) {
  const name = normalizeName(options.name, template.displayName || "AnxOS Instance");
  const id = slugify(options.id || name);
  const memory = normalizeName(options.memory, template.defaultRam || "");
  const isMinecraft = template.category === "Minecraft";
  const tags = normalizeTemplateTags(template, isMinecraft);
  const environment = getTemplateStartupEnvironment(template);
  const serverSoftware = getTemplateServerSoftware(template);
  const game = getTemplateGameFamily(template);
  const requestedVersion = options.version && String(options.version).trim() ? String(options.version).trim() : "";
  const serverVersion = requestedVersion || template.serverVersion || template.gameVersion || (isMinecraft ? "latest" : null);
  const cleanInitialVersion = serverVersion && serverVersion !== "latest" ? serverVersion : null;
  const initialVersionInfo = buildTemplateVersionInfo(template, {
    game,
    software: serverSoftware,
    gameVersion: cleanInitialVersion,
    displayVersion: cleanInitialVersion,
  });
  const metadata = {
    game,
    version: cleanInitialVersion,
    serverVersion: cleanInitialVersion,
    serverSoftware,
    minecraftVersion: isMinecraft ? cleanInitialVersion : null,
    gameVersion: cleanInitialVersion,
    displayVersion: initialVersionInfo.displayVersion || cleanInitialVersion,
    displayVersionDetail: initialVersionInfo.displayVersionDetail || null,
    templateVersion: template.version || null,
    templateId: template.id || null,
    primaryPort: ports[0] || null,
    versionInfo: initialVersionInfo,
  };
  if (getTemplateInstallerType(template) === "steamcmd-native") {
    const installer = template.installer || {};
    metadata.installerType = "steamcmd-native";
    metadata.steamAppId = Number(installer.appId);
    metadata.steamInstallDir = String(installer.installDir || "server");
    metadata.steamVerifyFiles = (Array.isArray(installer.verifyFiles) ? installer.verifyFiles : []).map((entry) => String(entry)).filter(Boolean);
  }

  if (ports[0]) {
    environment.PORT = String(ports[0]);
  }

  if (template.instanceType === "node-app") {
    return {
      id,
      displayName: name,
      type: "node-app",
      workingDirectory: "data",
      executable: "node",
      args: [generatedFileForTemplate(template, options, ports)?.path || "index.js"],
      environment,
      autoStart: Boolean(options.autoStart),
      restartPolicy: "on-failure",
      startupTimeoutMs: 30000,
      shutdownTimeoutMs: 10000,
      memoryLimit: memory,
      ports,
      ...metadata,
      tags,
    };
  }

  if (template.instanceType === "python-app") {
    return {
      id,
      displayName: name,
      type: "python-app",
      workingDirectory: "data",
      executable: "python3",
      args: [generatedFileForTemplate(template, options, ports)?.path || "app.py"],
      environment,
      autoStart: Boolean(options.autoStart),
      restartPolicy: "on-failure",
      startupTimeoutMs: 30000,
      shutdownTimeoutMs: 10000,
      memoryLimit: memory,
      ports,
      ...metadata,
      tags,
    };
  }

  if (template.startupType === "java-jar" || template.instanceType === "minecraft-paper" || template.instanceType === "java-app") {
    const jarName = getPrimaryArtifactName(template, options);
    const args = [];
    if (memory) {
      args.push(`-Xmx${memory}`);
    }
    args.push("-jar", jarName, "nogui");

    return {
      id,
      displayName: name,
      type: template.instanceType || "java-app",
      workingDirectory: "data",
      executable: "java",
      args,
      environment,
      autoStart: Boolean(options.autoStart),
      restartPolicy: "on-failure",
      startupTimeoutMs: 60000,
      shutdownTimeoutMs: 15000,
      memoryLimit: memory,
      ports,
      ...metadata,
      tags,
    };
  }

  if (template.startup && typeof template.startup === "object") {
    const startupArgs = resolveTemplateArgs(template.startup.args, template, options);
    return {
      id,
      displayName: name,
      type: template.instanceType || "custom-command",
      workingDirectory: template.startup.workingDirectory || "data",
      executable: template.startup.executable || template.executable || "bash",
      args: startupArgs,
      environment,
      autoStart: Boolean(options.autoStart),
      restartPolicy: template.startup.restartPolicy || "on-failure",
      startupTimeoutMs: template.startup.startupTimeoutMs || 30000,
      shutdownTimeoutMs: template.startup.shutdownTimeoutMs || 10000,
      memoryLimit: memory,
      ports,
      ...metadata,
      tags,
    };
  }

  if (template.executable) {
    return {
      id,
      displayName: name,
      type: template.instanceType || "custom-command",
      workingDirectory: "data",
      executable: template.executable,
      args: Array.isArray(template.args) ? template.args : [],
      environment,
      autoStart: Boolean(options.autoStart),
      restartPolicy: "on-failure",
      startupTimeoutMs: 30000,
      shutdownTimeoutMs: 10000,
      memoryLimit: memory,
      ports,
      ...metadata,
      tags,
    };
  }

  return {
    id,
    displayName: name,
    type: "custom-command",
    workingDirectory: "data",
    executable: "node",
    args: ["index.js"],
    environment,
    autoStart: Boolean(options.autoStart),
    restartPolicy: "never",
    startupTimeoutMs: 30000,
    shutdownTimeoutMs: 10000,
    memoryLimit: memory,
    ports,
    ...metadata,
    tags,
  };
}

function normalizeTemplateDownloads(template) {
  if (Array.isArray(template.downloads) && template.downloads.length > 0) {
    return template.downloads.map((download) => ({
      type: "url",
      required: true,
      overwrite: true,
      ...download,
      destination: normalizeInstanceFilePath(download.destination || download.fileName || "server.jar"),
    }));
  }

  const source = template.downloadSource || {};
  if (!source.type) {
    return [];
  }

  const sourceType = normalizeInstallerType(source.type);
  if (sourceType === "steamcmd-native") {
    return [{
      ...source,
      type: "steamcmd",
      destination: `steamcmd-app-${source.appId || template.installer?.appId || template.id}`,
      fileName: `SteamCMD app ${source.appId || template.installer?.appId || template.id}`,
      required: false,
    }];
  }

  return [{
    ...source,
    destination: normalizeInstanceFilePath(source.destination || source.fileName || "server.jar"),
    required: source.required === true || template.id === "minecraft-paper",
  }];
}

function getPrimaryArtifactPath(template, options = {}) {
  if (options.jar) {
    return normalizeInstanceFilePath(options.jar);
  }

  const downloads = normalizeTemplateDownloads(template);
  const primary = downloads.find((download) => download.primary !== false) || downloads[0];
  if (primary?.destination) {
    return normalizeInstanceFilePath(primary.destination);
  }

  return normalizeInstanceFilePath(template.downloadSource?.fileName || "server.jar");
}

function getPrimaryArtifactName(template, options = {}) {
  return fileNameFromDestination(getPrimaryArtifactPath(template, options));
}

function templateNeedsDownloadedArtifact(template, generated) {
  return !generated && (template.startupType === "java-jar" || template.instanceType === "minecraft-paper" || template.instanceType === "java-app");
}

function resolveTemplateArgs(args = [], template, options = {}) {
  return Array.isArray(args)
    ? args.map((arg) => expandTemplateString(arg, template, options, parsePorts(options.ports || options.port, template.defaultPorts)))
    : [];
}

function buildStartupPatch(template, options, ports) {
  if (template.startup && typeof template.startup === "object") {
    return {
      executable: template.startup.executable || "java",
      args: resolveTemplateArgs(template.startup.args, template, options),
      workingDirectory: template.startup.workingDirectory || "data",
      environment: getTemplateStartupEnvironment(template),
      memoryLimit: normalizeName(options.memory, template.defaultRam || ""),
      ports,
      restartPolicy: template.startup.restartPolicy || "on-failure",
    };
  }

  if (!(template.startupType === "java-jar" || template.instanceType === "minecraft-paper" || template.instanceType === "java-app")) {
    return null;
  }

  const memory = normalizeName(options.memory, template.defaultRam || "");
  const args = [];
  if (memory) {
    args.push(`-Xmx${memory}`);
  }
  args.push("-jar", getPrimaryArtifactName(template, options), "nogui");

  return {
    executable: "java",
    args,
    workingDirectory: "data",
    memoryLimit: memory,
    ports,
  };
}

async function waitForInstanceInstaller(instanceId, timeoutMs, agentConfig = null, context = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await agentClient.getInstanceStatus(instanceId, agentConfig);
    const state = last?.instance?.state || last?.state;
    if (state === "Stopped") {
      return last;
    }
    // Installer runs on FiveM instances end in "Setup Required" (the agent
    // persists license readiness after the start pipeline), which is a clean
    // installer exit — not a hang.
    if (state === "Setup Required") {
      return last;
    }
    if (state === "Failed") {
      const instance = last?.instance || last || {};
      if (Number(instance.exitCode) === 0 && instance.failureReason === "EARLY_CLEAN_EXIT") {
        return last;
      }
      const code = instance.failureReason === "EXECUTABLE_NOT_FOUND"
        ? "DEPENDENCY_MISSING"
        : context.installerType === "steamcmd-native" ? "STEAMCMD_INSTALL_FAILED" : "MARKETPLACE_INSTALL_FAILED";
      const installerEvidence = context.installerType === "steamcmd-native"
        ? await collectInstallerFailureEvidence(instanceId, agentConfig, context).catch((error) => ({
          evidenceError: truncateLogLine(error?.message || "Could not collect SteamCMD evidence."),
        }))
        : {};
      const details = {
        ...context,
        ...installerEvidence,
        message: "The installer process entered Failed state.",
        body: installerEvidence.statusSummary
          ? JSON.stringify(installerEvidence.statusSummary)
          : JSON.stringify({ state, exitCode: instance.exitCode ?? null, failureReason: instance.failureReason || null }),
        exitCode: instance.exitCode ?? null,
        failureReason: instance.failureReason || null,
      };
      if (code === "DEPENDENCY_MISSING") {
        throw createMarketplaceError(getMissingInstallerDependencyMessage(context, instance), code, details);
      }
      throw createMarketplaceStepError("Template installer failed.", code, details);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (Array.isArray(context.timeoutArtifactPaths) && await hasInstalledArtifacts(instanceId, context.timeoutArtifactPaths, agentConfig)) {
    return last || agentClient.getInstanceStatus(instanceId, agentConfig);
  }

  try {
    await agentClient.forceKillInstance(instanceId, agentConfig);
  } catch {}
  throw createMarketplaceStepError("The template installer did not finish in time.", "TEMPLATE_INSTALL_TIMEOUT", {
    ...context,
    message: `Installer exceeded ${timeoutMs}ms timeout.`,
    body: last ? JSON.stringify(last) : "",
  });
}

function getEffectiveInstallerTimeoutMs(template, fallbackMs = 600000) {
  const declared = normalizeInstallerTimeoutMs(template?.installer?.timeoutMs, fallbackMs);
  if (getTemplateInstallerType(template) === "steamcmd-native") {
    return Math.max(declared, STEAMCMD_INSTALL_TIMEOUT_MS);
  }
  return declared;
}

async function startAndWaitForInstanceInstaller(instanceId, timeoutMs, agentConfig = null, context = {}) {
  try {
    // Installer processes run through the instance start pipeline, but they are
    // installation work — runtime start-readiness guards (e.g. the FiveM license
    // check) must not apply here.
    await agentClient.startInstance(instanceId, agentConfig, { role: "installer" });
  } catch (error) {
    if (getAgentErrorCode(error) !== "INSTANCE_ALREADY_RUNNING") {
      throw error;
    }
  }

  return waitForInstanceInstaller(instanceId, timeoutMs, agentConfig, context);
}

// B3 honest readiness: a start request is not a running server. Watch the
// instance until it reports ready, stays alive past its readiness window, or
// dies. A process that exits (or crash-loops) before becoming ready is a
// failed start, never a successful install. An unrecognizable status (local or
// stubbed backends) returns unverified so completion is never blocked on
// missing information.
const START_READINESS_POLL_MS = 1000;
const START_READINESS_MIN_WAIT_MS = 10000;
const START_READINESS_MAX_WAIT_MS = 75000;
// A fast crash-restart cycle can alternate Failed/Starting between 1 s samples
// (Failed -> Starting -> Failed), so a consecutive-sample rule can miss it
// entirely and report the crash-loop as readiness pending. Counting failed
// samples across the whole window keeps the documented tolerance for a single
// transient crash that recovers while still failing a start that keeps dying.
const START_READINESS_FAILED_SAMPLE_LIMIT = 2;

async function waitForStartedInstanceReadiness(instanceId, agentConfig = null) {
  const firstStatus = await agentClient.getInstanceStatus(instanceId, agentConfig).catch(() => null);
  let last = firstStatus?.instance || firstStatus || null;
  if (!last || !last.state) {
    return { verified: false, ready: false, failed: false, instance: last };
  }

  const startupTimeoutMs = Number(last.startupTimeoutMs);
  const waitMs = Math.min(
    Math.max(Number.isFinite(startupTimeoutMs) ? startupTimeoutMs + 5000 : START_READINESS_MIN_WAIT_MS, START_READINESS_MIN_WAIT_MS),
    START_READINESS_MAX_WAIT_MS
  );
  const deadline = Date.now() + waitMs;
  let failedSamples = 0;

  for (;;) {
    const state = String(last.state || "");
    if (state === "Setup Required") {
      return { verified: true, ready: false, failed: false, instance: last };
    }
    if (state === "Running") {
      const readiness = last.readinessState === undefined || last.readinessState === null
        ? "unknown"
        : String(last.readinessState).toLowerCase();
      if (readiness === "failed") {
        return { verified: true, ready: false, failed: true, instance: last };
      }
      // "ready" is a live server; "timeout" means the process stayed alive for
      // the full startup window without opening its port; "unknown" covers
      // runtimes that predate readiness tracking. Only "failed" is a crash.
      return { verified: true, ready: readiness === "ready", failed: false, instance: last };
    }
    if (state === "Failed" || state === "Stopped") {
      // The agent may be inside an automatic restart cycle. A single failed
      // sample that recovers into Running is tolerated, but the second failed
      // sample anywhere in the window is terminal — including the alternating
      // crash-loop that never produces two consecutive failures.
      failedSamples += 1;
      if (failedSamples >= START_READINESS_FAILED_SAMPLE_LIMIT) {
        return { verified: true, ready: false, failed: true, instance: last };
      }
    }

    if (Date.now() >= deadline) {
      return { verified: true, ready: false, failed: false, instance: last };
    }
    await new Promise((resolve) => setTimeout(resolve, START_READINESS_POLL_MS));
    const next = await agentClient.getInstanceStatus(instanceId, agentConfig).catch(() => null);
    const nextInstance = next?.instance || next || null;
    if (!nextInstance || !nextInstance.state) {
      return { verified: false, ready: false, failed: false, instance: last };
    }
    last = nextInstance;
  }
}

function getSteamCmdInstallArtifactPaths(template) {
  const installer = template.installer || {};
  const installDir = normalizeInstanceFilePath(installer.installDir || "server");
  return [
    installer.appId ? normalizeInstanceFilePath(`${installDir}/steamapps/appmanifest_${installer.appId}.acf`) : null,
    ...((Array.isArray(installer.verifyFiles) ? installer.verifyFiles : []).map(normalizeInstanceFilePath)),
  ].filter(Boolean);
}

async function hasInstalledArtifacts(instanceId, artifactPaths = [], agentConfig = null) {
  if (!artifactPaths.length) {
    return false;
  }
  for (const artifactPath of artifactPaths) {
    try {
      await agentClient.readInstanceFile(instanceId, artifactPath, agentConfig);
    } catch {
      return false;
    }
  }
  return true;
}

async function verifyInstalledArtifacts(instanceId, artifactPaths = [], agentConfig = null, context = {}) {
  const missing = [];
  for (const artifactPath of artifactPaths) {
    try {
      await agentClient.readInstanceFile(instanceId, artifactPath, agentConfig);
    } catch {
      missing.push(artifactPath);
    }
  }
  if (missing.length > 0) {
    throw createMarketplaceStepError("SteamCMD finished but required install artifacts are missing.", "STEAMCMD_ARTIFACTS_MISSING", {
      ...context,
      missingArtifacts: missing,
      retryable: true,
    });
  }
}

function getSteamCmdResolvedInstallDirectory(instance = {}, installer = {}) {
  const workingDirectory = String(instance.workingDirectory || "data")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "") || "data";
  const installDir = normalizeInstanceFilePath(installer.installDir || "server");
  const relativeInstallDirectory = `${workingDirectory}/${installDir}`.replace(/\/+/g, "/");
  const instancePath = String(instance.instancePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    workingDirectory,
    installDir,
    relativeInstallDirectory,
    resolvedInstallDirectory: instancePath ? `${instancePath}/${relativeInstallDirectory}` : relativeInstallDirectory,
  };
}

function getSteamCmdMinFreeBytes(installer = {}) {
  const declared = Number(installer.minFreeBytes ?? installer.requiredFreeBytes ?? installer.minDiskBytes);
  return Number.isFinite(declared) && declared > 0 ? declared : STEAMCMD_MIN_FREE_BYTES;
}

async function assertSteamCmdDiskSpace(installer = {}, agentConfig = null, context = {}) {
  let diskSpaceCheck;
  try {
    diskSpaceCheck = normalizeDiskEvidence(await agentClient.getSystemStats(agentConfig));
  } catch (error) {
    diskSpaceCheck = { status: "unavailable", message: truncateLogLine(error?.message || "Could not read Agent disk metrics.") };
  }
  const minFreeBytes = getSteamCmdMinFreeBytes(installer);
  if (Number.isFinite(diskSpaceCheck.freeBytes) && diskSpaceCheck.freeBytes < minFreeBytes) {
    throw createMarketplaceStepError("The selected node does not have enough free disk space for this SteamCMD install.", "INSUFFICIENT_DISK_SPACE", {
      ...context,
      diskSpaceCheck: { ...diskSpaceCheck, requiredFreeBytes: minFreeBytes },
      retryable: false,
    });
  }
  return { ...diskSpaceCheck, requiredFreeBytes: minFreeBytes };
}

async function assertInstanceWriteAccess(instanceId, directoryPath, agentConfig = null, context = {}) {
  const cleanDirectory = normalizeInstanceFilePath(directoryPath || "runtime");
  const probePath = normalizeInstanceFilePath(`${cleanDirectory}/.anxos-installer-write-check-${Date.now()}.tmp`);
  try {
    await agentClient.writeInstanceFile(instanceId, probePath, "write-check\n", { encoding: "utf8" }, agentConfig);
    await agentClient.deleteInstanceFile(instanceId, probePath, agentConfig).catch(() => {});
    return { status: "passed", path: probePath };
  } catch (error) {
    throw createMarketplaceStepError("SteamCMD install directory is not writable on the selected node.", "INSTALL_DIRECTORY_UNWRITABLE", {
      ...context,
      writePermissionCheck: { status: "failed", path: probePath, message: truncateLogLine(error?.message || "Write check failed.") },
      retryable: false,
    });
  }
}

function getSteamCmdFailureText(error = {}) {
  const details = error?.details || {};
  return [
    error.message,
    ...(Array.isArray(details.finalStdoutLines) ? details.finalStdoutLines : []),
    ...(Array.isArray(details.finalStderrLines) ? details.finalStderrLines : []),
    details.failureReason,
  ].filter(Boolean).join("\n");
}

function isPermanentSteamCmdFailure(error = {}) {
  const code = error?.code || error?.details?.code;
  if (["DEPENDENCY_MISSING", "INSUFFICIENT_DISK_SPACE", "INSTALL_DIRECTORY_UNWRITABLE", "INSTALL_DIRECTORY_CREATE_FAILED"].includes(code)) {
    return true;
  }
  const text = getSteamCmdFailureText(error);
  return /permission denied|not enough disk|no space left|access denied|invalid password|requires authenticated steam login|not available on path|executable_not_found/i.test(text);
}

function isTransientSteamCmdFailure(error = {}) {
  if (isPermanentSteamCmdFailure(error)) {
    return false;
  }
  const text = getSteamCmdFailureText(error);
  return /timed?\s*out|timeout|connection|temporar|try again|rate limit|busy|network|failed to request app info|content servers unavailable/i.test(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLogTail(entries = [], stream) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => !stream || entry?.stream === stream)
    .map((entry) => entry?.message || "")
    .filter(Boolean)
    .slice(-20)
    .map((line) => truncateLogLine(line));
}

async function readInstanceLogTail(instanceId, stream, agentConfig = null) {
  try {
    const logs = await agentClient.getInstanceLogs(instanceId, { stream, limit: 80 }, agentConfig);
    return getLogTail(logs?.entries || [], stream);
  } catch (error) {
    return [`[log read failed: ${truncateLogLine(error?.message || "unknown error")}]`];
  }
}

async function collectInstallerFailureEvidence(instanceId, agentConfig = null, context = {}) {
  const status = await agentClient.getInstanceStatus(instanceId, agentConfig).catch(() => null);
  const instance = status?.instance || status || {};
  const installer = context.installer || {};
  const installDirectory = getSteamCmdResolvedInstallDirectory(instance, installer);
  const [finalStdoutLines, finalStderrLines] = await Promise.all([
    readInstanceLogTail(instanceId, "stdout", agentConfig),
    readInstanceLogTail(instanceId, "stderr", agentConfig),
  ]);

  let diskSpaceCheck = { status: "not_checked", message: "Disk-space preflight has not run for this installer yet." };
  try {
    diskSpaceCheck = normalizeDiskEvidence(await agentClient.getSystemStats(agentConfig));
  } catch (error) {
    diskSpaceCheck = { status: "unavailable", message: truncateLogLine(error?.message || "Could not read Agent disk metrics.") };
  }

  const probePath = `runtime/.anxos-installer-write-check-${Date.now()}.tmp`;
  let writePermissionCheck = { status: "not_checked", path: probePath };
  try {
    await agentClient.writeInstanceFile(instanceId, probePath, "write-check\n", { encoding: "utf8" }, agentConfig);
    await agentClient.deleteInstanceFile(instanceId, probePath, agentConfig).catch(() => {});
    writePermissionCheck = { status: "passed", path: probePath };
  } catch (error) {
    writePermissionCheck = { status: "failed", path: probePath, message: truncateLogLine(error?.message || "Write check failed.") };
  }

  return {
    exitCode: instance.exitCode ?? null,
    signal: instance.signal || null,
    failureReason: instance.failureReason || null,
    workingDirectory: instance.workingDirectory || installDirectory.workingDirectory,
    resolvedInstallDirectory: installDirectory.resolvedInstallDirectory,
    relativeInstallDirectory: installDirectory.relativeInstallDirectory,
    executablePath: instance.executable || context.executablePath || "steamcmd",
    finalStdoutLines,
    finalStderrLines,
    diskSpaceCheck,
    writePermissionCheck,
    logHint: "View installer logs in Download Manager or the instance Console logs.",
    statusSummary: {
      instanceId,
      state: instance.state || status?.state || null,
      exitCode: instance.exitCode ?? null,
      signal: instance.signal || null,
      failureReason: instance.failureReason || null,
    },
  };
}

async function runTemplatePostInstall(template, options, instanceId, progress, agentConfig = null) {
  const postInstall = template.postInstall;
  if (!postInstall || postInstall.type !== "java-installer") {
    return createInstallerResultOk("installed", { artifacts: [] });
  }

  try {
    const installerJar = normalizeInstanceFilePath(postInstall.jar || getPrimaryArtifactPath(template, options));
    await agentClient.readInstanceFile(instanceId, installerJar, agentConfig);
    const installerArgs = ["-jar", fileNameFromDestination(installerJar), ...resolveTemplateArgs(postInstall.args || ["--installServer"], template, options)];

    pushStep(progress, "Extract files", "running", `Running ${fileNameFromDestination(installerJar)}.`);
    await agentClient.updateInstance(instanceId, {
      executable: "java",
      args: installerArgs,
      workingDirectory: "data",
      restartPolicy: "never",
      startupTimeoutMs: postInstall.timeoutMs || 300000,
    }, agentConfig);
    await startAndWaitForInstanceInstaller(instanceId, postInstall.timeoutMs || 300000, agentConfig, {
      templateId: template.id,
      step: "Extract files",
      installerType: "java-runtime",
      handlerName: "runTemplatePostInstall",
    });

    const requiredFiles = Array.isArray(postInstall.requiredFiles) ? postInstall.requiredFiles : [];
    for (const requiredFile of requiredFiles) {
      await agentClient.readInstanceFile(instanceId, requiredFile, agentConfig);
    }
    pushStep(progress, "Extract files", "complete", "Server installer finished.");
    return createInstallerResultOk("installed", {
      installDirectory: "data",
      executable: "java",
      runtime: "java",
      artifacts: requiredFiles,
    });
  } catch (error) {
    return createInstallerResultError("extracting", error, {
      code: error?.code || "EXTRACTION_FAILED",
      handlerName: "runTemplatePostInstall",
      installerType: "java-runtime",
      runtimeType: "java",
      templateId: template.id,
    });
  }
}

async function runTemplateInstaller(template, options, instanceId, progress, agentConfig = null) {
  if (!template.installer) {
    return createInstallerResultOk("installed", { artifacts: [] });
  }

  const installerType = getTemplateInstallerType(template);
  try {
    if (installerType === "steamcmd-native") {
      const status = await agentClient.getInstanceStatus(instanceId, agentConfig).catch(() => null);
      const instance = status?.instance || status || {};
      const installDirectory = getSteamCmdResolvedInstallDirectory({ ...instance, workingDirectory: "data" }, template.installer);
      const absoluteInstallDirectory = installDirectory.resolvedInstallDirectory;
      if (!/^([A-Za-z]:\/|\/)/.test(absoluteInstallDirectory)) {
        throw createMarketplaceStepError("SteamCMD install directory could not be resolved to an absolute path.", "INSTALL_DIRECTORY_INVALID", {
          templateId: template.id,
          step: "Install SteamCMD app",
          installerType: "steamcmd-native",
          workingDirectory: installDirectory.workingDirectory,
          resolvedInstallDirectory: absoluteInstallDirectory,
          retryable: false,
        });
      }
      const steamcmdArgs = buildSteamCmdInstallerArgs(template.installer, absoluteInstallDirectory);
      const steamcmdCommand = ["steamcmd", ...steamcmdArgs].join(" ");
      const artifactPaths = getSteamCmdInstallArtifactPaths(template);
      if (await hasInstalledArtifacts(instanceId, artifactPaths, agentConfig)) {
        pushStep(progress, "Install SteamCMD app", "complete", "SteamCMD app is already installed.");
        return createInstallerResultOk("installed", {
          installDirectory: normalizeInstanceFilePath(template.installer.installDir || "server"),
          executable: template.startup?.executable || "steamcmd",
          runtime: "steamcmd-native",
          artifacts: artifactPaths,
        });
      }
      pushStep(progress, "Install SteamCMD app", "running", `Preparing ${absoluteInstallDirectory}.`);
      try {
        await agentClient.createInstanceFolder(instanceId, installDirectory.installDir, agentConfig);
      } catch (error) {
        throw createMarketplaceStepError("SteamCMD install directory could not be created on the selected node.", "INSTALL_DIRECTORY_CREATE_FAILED", {
          templateId: template.id,
          step: "Install SteamCMD app",
          installerType: "steamcmd-native",
          workingDirectory: installDirectory.workingDirectory,
          resolvedInstallDirectory: absoluteInstallDirectory,
          relativeInstallDirectory: installDirectory.relativeInstallDirectory,
          message: truncateLogLine(error?.message || "Directory create failed."),
          retryable: false,
        });
      }
      const diskSpaceCheck = await assertSteamCmdDiskSpace(template.installer, agentConfig, {
        templateId: template.id,
        step: "Install SteamCMD app",
        installerType: "steamcmd-native",
        resolvedInstallDirectory: absoluteInstallDirectory,
      });
      const writePermissionCheck = await assertInstanceWriteAccess(instanceId, installDirectory.installDir, agentConfig, {
        templateId: template.id,
        step: "Install SteamCMD app",
        installerType: "steamcmd-native",
        resolvedInstallDirectory: absoluteInstallDirectory,
      });
      pushStep(progress, "Install SteamCMD app", "running", `Running SteamCMD app ${template.installer.appId}.`);
      await agentClient.updateInstance(instanceId, {
        executable: "steamcmd",
        args: steamcmdArgs,
        workingDirectory: "data",
        restartPolicy: "never",
        startupTimeoutMs: getEffectiveInstallerTimeoutMs(template),
      }, agentConfig);
      const installerContext = {
          templateId: template.id,
          step: "Install SteamCMD app",
          installerType: "steamcmd-native",
          handlerName: "runTemplateInstaller",
          command: steamcmdCommand,
          executablePath: "steamcmd",
          installer: template.installer,
          timeoutArtifactPaths: artifactPaths,
          workingDirectory: "data",
          resolvedInstallDirectory: absoluteInstallDirectory,
          relativeInstallDirectory: installDirectory.relativeInstallDirectory,
          diskSpaceCheck,
          writePermissionCheck,
      };
      let lastInstallerError = null;
      for (let attempt = 0; attempt < STEAMCMD_RETRY_DELAYS_MS.length; attempt += 1) {
        if (STEAMCMD_RETRY_DELAYS_MS[attempt] > 0) {
          await sleep(STEAMCMD_RETRY_DELAYS_MS[attempt]);
        }
        try {
          await startAndWaitForInstanceInstaller(instanceId, getEffectiveInstallerTimeoutMs(template), agentConfig, {
            ...installerContext,
            attempt: attempt + 1,
          });
          lastInstallerError = null;
          break;
        } catch (error) {
          lastInstallerError = error;
          if (await hasInstalledArtifacts(instanceId, artifactPaths, agentConfig)) {
            pushStep(progress, "Install SteamCMD app", "complete", "SteamCMD app was already installed after a retry failure.");
            lastInstallerError = null;
            break;
          }
          const hasRetry = attempt < STEAMCMD_RETRY_DELAYS_MS.length - 1;
          if (!hasRetry || !isTransientSteamCmdFailure(error)) {
            error.details = {
              ...(error.details || {}),
              ...installerContext,
              attempt: attempt + 1,
              retryable: hasRetry && isTransientSteamCmdFailure(error),
            };
            throw error;
          }
          pushStep(progress, "Install SteamCMD app", "running", `SteamCMD failed with a transient error; retrying attempt ${attempt + 2}.`);
        }
      }
      if (lastInstallerError) {
        throw lastInstallerError;
      }
      try {
        await verifyInstalledArtifacts(instanceId, artifactPaths, agentConfig, installerContext);
      } catch (error) {
        if (!(await hasInstalledArtifacts(instanceId, artifactPaths, agentConfig))) {
          throw error;
        }
      }
      pushStep(progress, "Install SteamCMD app", "complete", "SteamCMD installer finished.");
      return createInstallerResultOk("installed", {
        installDirectory: normalizeInstanceFilePath(template.installer.installDir || "server"),
        executable: template.startup?.executable || "steamcmd",
        runtime: "steamcmd-native",
        artifacts: artifactPaths,
      });
    }

    const windowsArchiveInstaller = template.targetPlatform === "windows" && installerType === "archive-download";
    const script = windowsArchiveInstaller
      ? buildWindowsArchiveInstallerScript({
        ...template.installer,
        archive: template.installer.archive,
        template,
      })
      : buildTemplateInstallerScript(template);
    if (!script) {
      return createInstallerResultOk("installed", { artifacts: [] });
    }

    const scriptPath = windowsArchiveInstaller ? "runtime/marketplace-install.ps1" : "runtime/marketplace-install.sh";
    await writeInstanceText(instanceId, scriptPath, script, agentConfig);
    pushStep(progress, "Extract files", "running", `Running ${template.installer.type} installer.`);
    await agentClient.updateInstance(instanceId, {
      executable: windowsArchiveInstaller ? "powershell.exe" : "bash",
      args: windowsArchiveInstaller
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
        : [scriptPath],
      workingDirectory: "data",
      restartPolicy: "never",
      startupTimeoutMs: template.installer.timeoutMs || 600000,
    }, agentConfig);
    await startAndWaitForInstanceInstaller(instanceId, template.installer.timeoutMs || 600000, agentConfig, {
      templateId: template.id,
      step: "Extract files",
      installerType,
      handlerName: "runTemplateInstaller",
      command: windowsArchiveInstaller ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${scriptPath}` : `bash ${scriptPath}`,
    });

    const requiredFiles = Array.isArray(template.installer.verifyFiles) ? template.installer.verifyFiles : [];
    for (const requiredFile of requiredFiles) {
      await agentClient.readInstanceFile(instanceId, normalizeInstanceFilePath(requiredFile), agentConfig);
    }
    pushStep(progress, "Extract files", "complete", "Server installer finished.");
    return createInstallerResultOk("installed", {
      installDirectory: normalizeInstanceFilePath(template.installer.extractDir || template.installer.installDir || "server"),
      executable: template.startup?.executable || "bash",
      runtime: installerType,
      artifacts: requiredFiles,
    });
  } catch (error) {
    const code = error?.code ||
      (installerType === "steamcmd-native" ? "STEAMCMD_INSTALL_FAILED" : "EXTRACTION_FAILED");
    return createInstallerResultError("extracting", error, {
      code,
      handlerName: "runTemplateInstaller",
      installerType,
      runtimeType: template.startupType || template.runtime || template.instanceType || null,
      templateId: template.id,
    });
  }
}

function getConciseInstallerFailureMessage(error = {}) {
  const details = error?.details || {};
  if (details.installerType === "steamcmd-native") {
    const codeText = details.exitCode !== undefined && details.exitCode !== null ? ` exit code ${details.exitCode}` : "";
    return `SteamCMD installer failed${codeText}. View installer logs for the final SteamCMD output.`;
  }
  return error?.message || "Installer failed.";
}

function finishInstallerDownloadRecords(records = [], status, message, details = {}) {
  for (const record of records) {
    if (!record || !["queued", "resolving", "running", "waiting", "skipped"].includes(record.status)) {
      continue;
    }
    appendDownloadLog(record, { step: details.step || "Extract files", level: status === "complete" ? "info" : "error", message, ...details });
    updateDownload(record, {
      status,
      progress: status === "complete" ? 100 : record.progress,
      error: status === "failed" ? message : null,
      canRetry: status === "failed",
      canCancel: false,
    });
  }
}

async function writeTemplateConfigFiles(template, options, ports, instanceId, agentConfig = null) {
  const files = Array.isArray(template.configFiles) ? template.configFiles : [];
  for (const configFile of files) {
    if (!configFile?.path) {
      continue;
    }
    await writeInstanceText(
      instanceId,
      normalizeInstanceFilePath(configFile.path),
      buildConfigFileContent(configFile, template, options, ports),
      agentConfig
    );
    await agentClient.readInstanceFile(instanceId, normalizeInstanceFilePath(configFile.path), agentConfig);
  }
}

function buildResolvedVersionMetadata(template, resolved = {}) {
  const serverSoftware = getTemplateServerSoftware(template);
  const game = getTemplateGameFamily(template);
  const minecraftVersion = template.category === "Minecraft" ? resolved.version || null : null;
  const gameVersion = game === "minecraft" ? minecraftVersion : resolved.version || null;
  const build = resolved.build || null;
  const isPaper = serverSoftware === "Paper";
  const versionInfo = buildTemplateVersionInfo(template, {
    game,
    software: serverSoftware,
    gameVersion,
    softwareVersion: game === "minecraft" && /fabric|forge|neoforge|quilt/i.test(serverSoftware || "") ? build : null,
    buildNumber: build,
    displayVersion: game === "minecraft"
      ? null
      : (game === "fivem" ? `Artifact ${build || resolved.version}` : resolved.version || null),
  });
  const version = versionInfo.displayVersion || resolved.version || null;
  return {
    game,
    version,
    versionName: version,
    serverVersion: resolved.version || null,
    serverSoftware,
    minecraftVersion,
    gameVersion,
    softwareVersion: versionInfo.softwareVersion || null,
    displayVersion: versionInfo.displayVersion || null,
    displayVersionDetail: versionInfo.displayVersionDetail || null,
    buildNumber: build,
    paperBuild: isPaper ? build : null,
    versionInfo,
    detectedVersionAt: new Date().toISOString(),
    versionCacheVersion: INSTANCE_VERSION_CACHE_VERSION,
  };
}

function parseSteamAppManifest(content) {
  const text = String(content || "");
  return {
    name: text.match(/"name"\s+"([^"]+)"/i)?.[1] || null,
    buildId: text.match(/"buildid"\s+"([^"]+)"/i)?.[1] || null,
  };
}

async function detectInstalledTemplateMetadata(template, instanceId, agentConfig = null) {
  if (template.installer?.type === "steamcmd" && template.installer.appId) {
    const installDir = normalizeInstanceFilePath(template.installer.installDir || "server");
    const manifestPath = normalizeInstanceFilePath(`${installDir}/steamapps/appmanifest_${template.installer.appId}.acf`);
    try {
      const manifest = await agentClient.readInstanceFile(instanceId, manifestPath, agentConfig);
      const parsed = parseSteamAppManifest(manifest?.content || "");
      if (parsed.buildId) {
        const versionInfo = buildTemplateVersionInfo(template, {
          game: getTemplateGameFamily(template),
          software: parsed.name || template.displayName || template.id,
          gameVersion: null,
          buildNumber: parsed.buildId,
          displayVersion: parsed.buildId,
        });
        return {
          game: versionInfo.game || null,
          version: versionInfo.displayVersion || parsed.buildId,
          serverVersion: parsed.buildId,
          serverSoftware: parsed.name || template.displayName || template.id,
          gameVersion: versionInfo.gameVersion || null,
          softwareVersion: versionInfo.softwareVersion || null,
          displayVersion: versionInfo.displayVersion || null,
          displayVersionDetail: versionInfo.displayVersionDetail || null,
          buildNumber: parsed.buildId,
          versionInfo,
          detectedVersionAt: new Date().toISOString(),
          versionCacheVersion: INSTANCE_VERSION_CACHE_VERSION,
        };
      }
    } catch {}
  }

  return {};
}

async function persistMarketplaceMetadata(instanceId, metadata, agentConfig = null) {
  const cleanMetadata = Object.entries(metadata || {}).reduce((result, [key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
    return result;
  }, {});

  if (Object.keys(cleanMetadata).length === 0) {
    return {};
  }

  await agentClient.updateInstance(instanceId, cleanMetadata, agentConfig);
  await writeInstanceText(instanceId, "metadata.json", `${JSON.stringify(cleanMetadata, null, 2)}\n`, agentConfig);
  return cleanMetadata;
}

// The Java major the selected node reported in the dependency check that
// already ran for this install. null means "no reliable information" (local
// backend, non-Java templates, detection failure) so the pre-flight guard
// stays out of the way instead of guessing.
function resolveAvailableJavaMajor(dependencyCheck = null) {
  const dependencies = Array.isArray(dependencyCheck?.dependencies) ? dependencyCheck.dependencies : [];
  const java = dependencies.find((dependency) => String(dependency?.id || dependency?.name || "").toLowerCase() === "java");
  if (!java || java.installed !== true) {
    return null;
  }
  const major = Number.parseInt(String(java.version || "").match(/(\d+)/)?.[1] || "", 10);
  return Number.isInteger(major) && major > 0 ? major : null;
}

// Pre-flight refusal for a resolved server artifact that needs a newer Java
// than the node provisioned. Only resolver results that actually expose a
// minimum Java major (Paper, Vanilla) are guarded; everything else keeps the
// previous behavior and relies on startup readiness reporting.
function assertResolvedJavaCompatible(resolved, availableJavaMajor, context = {}) {
  const requiredJavaMajor = Number(resolved?.javaMinimum);
  if (!Number.isInteger(requiredJavaMajor) || requiredJavaMajor <= 0) {
    return;
  }
  if (!Number.isInteger(availableJavaMajor) || availableJavaMajor <= 0) {
    return;
  }
  if (availableJavaMajor >= requiredJavaMajor) {
    return;
  }
  const versionLabel = resolved?.version ? String(resolved.version) : "This server version";
  throw createMarketplaceError(
    `${versionLabel} requires Java ${requiredJavaMajor}, but the selected node has Java ${availableJavaMajor}. `
      + `Choose a version that runs on Java ${availableJavaMajor} (for Minecraft, 1.21.11) or install Java ${requiredJavaMajor} on the node, then retry the install.`,
    "JAVA_VERSION_UNSUPPORTED",
    {
      ...context,
      step: "Resolve download",
      requiredJavaMajor,
      availableJavaMajor,
      resolvedVersion: resolved?.version || null,
      retryable: false,
    }
  );
}

async function downloadOneToInstance(template, download, options, instanceId, progress, agentConfig = null, parentRecord = null, runtimeAvailability = null) {
  const destination = normalizeInstanceFilePath(download.destination || download.fileName || "server.jar");
  const fileName = fileNameFromDestination(destination);
  const downloadRequired = download.required === true;
  const record = createDownloadRecord(template, fileName, {
    parentTaskId: parentRecord?.id || null,
    installSessionId: parentRecord?.installSessionId || null,
    nodeId: parentRecord?.nodeId || options.nodeId || agentConfig?.nodeId || null,
  });
  if (parentRecord && !parentRecord.childTaskIds.includes(record.id)) {
    parentRecord.childTaskIds.push(record.id);
    downloads.set(parentRecord.id, parentRecord);
  }
  const baseContext = {
    templateId: template.id,
    step: "Resolve download",
    installSessionId: record.installSessionId,
    parentTaskId: record.parentTaskId,
  };

  if (options.skipDownload || !download.type || download.type === "manual" || download.type === "docker" || download.type === "docker-compose") {
    if (downloadRequired) {
      appendDownloadLog(record, { level: "error", step: "Validate template", message: `${fileName} is required for this template.` });
      updateDownload(record, { status: "failed", error: `${fileName} is required for this template.`, canRetry: false });
      throw createMarketplaceStepError(`${fileName} is required for this template.`, "DOWNLOAD_REQUIRED", { ...baseContext, step: "Validate template" });
    }
    appendDownloadLog(record, { step: "Validate template", message: `No direct download is required for ${fileName}.` });
    updateDownload(record, { status: "skipped", progress: 100, canRetry: false, canCancel: false });
    pushStep(progress, "Download files", "skipped", `No direct download is required for ${fileName}.`);
    return { downloaded: false, record };
  }

  if (download.type === "inline") {
    updateDownload(record, { status: "running", startedAt: new Date().toISOString(), canCancel: false });
    appendDownloadLog(record, { step: "Download files", message: `Generating ${destination}.` });
    await writeInstanceText(instanceId, destination, download.content || "", agentConfig);
    updateDownload(record, { status: "complete", progress: 100, bytesReceived: String(download.content || "").length, bytesTotal: String(download.content || "").length });
    appendDownloadLog(record, { step: "Download files", message: `Generated ${destination}.` });
    pushStep(progress, "Download files", "complete", `Generated ${fileName}.`);
    return { downloaded: true, record };
  }

  if (download.type === "generated") {
    appendDownloadLog(record, { step: "Download files", message: "Generated starter project locally." });
    updateDownload(record, { status: "complete", progress: 100, canRetry: false, canCancel: false });
    pushStep(progress, "Download files", "skipped", "Generated starter project locally.");
    return { downloaded: true, record };
  }

  if (download.type === "steamcmd") {
    appendDownloadLog(record, { step: "Download files", message: `SteamCMD will install app ${download.appId || template.installer?.appId || "unknown"} during Extract files.` });
    updateDownload(record, { status: "skipped", stage: "Installing", progress: 0, canRetry: false, canCancel: false });
    pushStep(progress, "Download files", "skipped", "SteamCMD will download server files during installation.");
    return { downloaded: false, record };
  }

  if (download.type !== "url") {
    appendDownloadLog(record, { step: "Validate template", message: `Unsupported download type: ${download.type || "missing"}.`, level: "error" });
    updateDownload(record, { status: "failed", error: `Unsupported download type: ${download.type || "missing"}.`, canRetry: false });
    pushStep(progress, "Download files", "failed", "Template source is not supported by the automatic installer.");
    if (downloadRequired) {
      throw createMarketplaceStepError("Template source is not supported by the automatic installer.", "INSTALLER_NOT_SUPPORTED", {
        ...baseContext,
        step: "Validate template",
        message: `Unsupported download type: ${download.type || "missing"}.`,
      });
    }
    return { downloaded: false, record };
  }

  let resolved;
  try {
    updateDownload(record, { status: "resolving", startedAt: new Date().toISOString(), canCancel: false });
    appendDownloadLog(record, { step: "Resolve download", message: `Resolving ${fileName}.` });
    pushStep(progress, "Resolve download", "running", `Resolving ${fileName}.`);
    resolved = await resolveDownloadUrl(download, options, baseContext);
    assertResolvedJavaCompatible(resolved, runtimeAvailability?.availableJavaMajor, baseContext);
    appendDownloadLog(record, { step: "Resolve download", message: `Resolved ${resolved.url || "download URL"}.`, url: resolved.url });
    pushStep(progress, "Resolve download", "complete", `Resolved ${fileName}${resolved.version ? ` for ${resolved.version}` : ""}${resolved.build ? ` build ${resolved.build}` : ""}.`);
  } catch (error) {
    appendDownloadLog(record, {
      step: "Resolve download",
      level: "error",
      message: error?.message || "Download resolver failed.",
      url: error?.details?.url,
      status: error?.details?.status,
      responseUrl: error?.details?.responseUrl,
      causeCode: error?.details?.causeCode,
      networkCode: error?.details?.networkCode,
      body: error?.details?.body,
    });
    // Non-retryable resolver failures (for example JAVA_VERSION_UNSUPPORTED,
    // where the node cannot satisfy the required Java) must not offer a Retry
    // that would fail identically.
    const retryable = getErrorDetails(error).retryable !== false;
    updateDownload(record, { status: "failed", error: error?.message || "Download resolver failed.", canRetry: retryable });
    if (downloadRequired) {
      throw error;
    }
    pushStep(progress, "Download files", "skipped", mapMarketplaceError(error, "Download skipped."));
    return { downloaded: false, record };
  }
  const url = resolved?.url || "";
  if (!url || url.includes("{")) {
    if (downloadRequired) {
      const error = createMarketplaceStepError("Template download URL is incomplete.", "DOWNLOAD_URL_INCOMPLETE", { ...baseContext, url });
      appendDownloadLog(record, { step: "Resolve download", level: "error", message: error.message, url });
      updateDownload(record, { status: "failed", error: error.message, canRetry: true });
      throw error;
    }
    appendDownloadLog(record, { step: "Resolve download", level: "warning", message: "Download URL requires version/build data.", url });
    updateDownload(record, { status: "skipped", error: "Download URL requires version/build data.", canRetry: true });
    pushStep(progress, "Download files", "skipped", "Download URL requires version/build data.");
    return { downloaded: false, record };
  }

  const controller = new AbortController();
  updateDownload(record, {
    status: "running",
    startedAt: new Date().toISOString(),
    canCancel: true,
    controller,
    url,
  });
  appendDownloadLog(record, { step: "Download files", message: `Downloading ${url}.`, url });

  try {
    const response = await fetchWithDetails(url, { signal: controller.signal, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw createMarketplaceStepError(`Download failed with HTTP ${response.status}.`, "DOWNLOAD_FAILED", {
        ...baseContext,
        step: "Download files",
        url,
        responseUrl: response.url || url,
        status: response.status,
        statusText: response.statusText || null,
        body,
        message: `Download failed with HTTP ${response.status}.`,
        attempt: response.attempt || null,
      });
    }

    const total = Number.parseInt(response.headers.get("content-length") || "", 10);
    const chunks = [];
    let received = 0;
    const started = Date.now();

    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(Buffer.from(value));
        received += value.length;
        const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.1);
        const speed = received / elapsedSeconds;
        updateDownload(record, {
          bytesReceived: received,
          bytesTotal: Number.isFinite(total) ? total : null,
          progress: Number.isFinite(total) && total > 0 ? Math.round((received / total) * 100) : 0,
          speedBytesPerSecond: Math.round(speed),
          etaSeconds: Number.isFinite(total) && speed > 0 ? Math.max(Math.round((total - received) / speed), 0) : null,
        });
      }
    } else {
      const arrayBuffer = await response.arrayBuffer();
      chunks.push(Buffer.from(arrayBuffer));
      received = arrayBuffer.byteLength;
    }

    const buffer = Buffer.concat(chunks);
    await writeInstanceBuffer(instanceId, destination, buffer, agentConfig);
    await agentClient.readInstanceFile(instanceId, destination, agentConfig);
    updateDownload(record, {
      status: "complete",
      progress: 100,
      bytesReceived: buffer.length,
      bytesTotal: buffer.length,
      canCancel: false,
      canRetry: false,
    });
    appendDownloadLog(record, { step: "Download files", message: `Downloaded ${fileName}.`, url });
    pushStep(progress, "Download files", "complete", `Downloaded ${fileName}.`);
    pushStep(progress, "Verify installation", "complete", `${destination} is available.`);
    return { downloaded: true, record, metadata: buildResolvedVersionMetadata(template, resolved) };
  } catch (error) {
    const cancelled = error?.name === "AbortError";
    const networkCode = classifyNetworkError(error);
    const effectiveError = error?.code ? error : createMarketplaceStepError(
      networkCode === "DOWNLOAD_FAILED" ? (error?.message || "Download failed.") : `Download failed: ${error?.message || "network request failed"}.`,
      networkCode,
      {
        ...baseContext,
        step: "Download files",
        url,
        ...getNetworkCauseDetails(error),
        networkCode,
        message: error?.message || "Download failed.",
      }
    );
    updateDownload(record, {
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? null : effectiveError.message,
      canCancel: false,
      canRetry: true,
    });
    appendDownloadLog(record, {
      step: "Download files",
      level: cancelled ? "warning" : "error",
      message: cancelled ? "Download cancelled." : effectiveError.message || "Download failed.",
      url: effectiveError?.details?.url || url,
      status: effectiveError?.details?.status,
      responseUrl: effectiveError?.details?.responseUrl,
      causeCode: effectiveError?.details?.causeCode,
      networkCode: effectiveError?.details?.networkCode,
      body: effectiveError?.details?.body,
    });

    if (downloadRequired) {
      throw effectiveError;
    }

    pushStep(progress, "Download files", "skipped", effectiveError.message || "Download skipped.");
    return { downloaded: false, record };
  } finally {
    delete record.controller;
  }
}

async function downloadToInstance(template, options, instanceId, progress, agentConfig = null, parentRecord = null, runtimeAvailability = null) {
  const templateDownloads = normalizeTemplateDownloads(template);
  if (!templateDownloads.length) {
    pushStep(progress, "Download files", "skipped", "No direct download is required for this template.");
    return { downloaded: false, records: [] };
  }

  const records = [];
  const metadata = {};
  let downloaded = false;
  for (const download of templateDownloads) {
    const result = await downloadOneToInstance(template, download, options, instanceId, progress, agentConfig, parentRecord, runtimeAvailability);
    downloaded = downloaded || Boolean(result.downloaded);
    if (result.metadata) {
      Object.entries(result.metadata).forEach(([key, value]) => {
        if (value) {
          metadata[key] = value;
        }
      });
    }
    if (result.record) {
      records.push(result.record);
    }
  }

  return { downloaded, records, metadata };
}

async function setInstanceInstallStage(instanceId, stage, agentConfig = null, extraFields = null) {
  // Stage tracking is diagnostics only — it must never break an install.
  try {
    await agentClient.updateInstance(instanceId, { installStage: stage, ...extraFields }, agentConfig);
  } catch (error) {
    console.warn("[Marketplace] Could not update instance install stage.", {
      instanceId,
      stage,
      error: error?.message || String(error),
    });
  }
}

// V2-D publisher trust (docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md §3 item 5;
// roadmap V2-D bullets 7-8). Computes the trust verdict for the exact template
// about to be installed, from the facts this path actually holds:
//
//   provider      template.provenance.source ("anxos-catalog" for the shipped
//                 catalog) or an explicit template.provider
//   declaredHash  template.checksum — null for every entry in the shipped
//                 catalog (readTemplatesFile defaults it to null)
//   computedHash  ALWAYS null: this install path downloads the artifact but
//                 never hashes it, so no integrity match can be established
//                 and the verdict can never be `verified`. That is the honest
//                 state of the code today, not an oversight in the policy.
//   executable    the resolved installer type runs content when it is not
//                 "no-install"
function evaluateInstallPublisherTrust(template = {}, manifest = {}) {
  const installerType = manifest?.installerType || getTemplateInstallerType(template) || "";
  return evaluatePublisherTrust(template, {
    provider: template.provenance?.source || template.provider || "",
    sourceUrl: firstTemplateDownloadUrl(template),
    declaredHash: template.checksum ?? null,
    computedHash: null,
    executable: installerType ? installerType !== "no-install" : undefined,
  });
}

// The first concrete download URL a template declares, used only as publisher
// evidence (the URL host class) in the trust verdict.
function firstTemplateDownloadUrl(template = {}) {
  const downloads = normalizeTemplateDownloads(template);
  const withUrl = downloads.find((download) => typeof download?.url === "string" && download.url);
  return withUrl?.url || template.downloadSource?.url || template.downloadSource?.urlTemplate || null;
}

// The idempotency-key subject must be the identity the executor actually
// uses — slugify(options.id || options.name || template.id) (templateValue
// id, the instance id on disk). Exposed through _test so the transaction
// smoke can pin that distinct installs mint distinct keys (P0-1/P1-2).
function buildTemplateInstallSubject(payload = {}) {
  const requestedInstanceId = payload.options?.id || null;
  const requestedName = payload.options?.name || null;
  return (requestedInstanceId && slugify(requestedInstanceId))
    || (requestedName && slugify(requestedName))
    || payload.templateId
    || "unknown-template";
}

// The exported installTemplate wrapper rides the durable V2-A job lifecycle
// (V2-D install transactions) so every install is recorded, idempotent on
// keyed retry, and reconciled as interrupted if the desktop restarts
// mid-flight. The real executor is executeInstallTemplate below.
async function installTemplate(payload = {}) {
  const subject = buildTemplateInstallSubject(payload);
  const version = payload.packageVersion || payload.options?.packageVersion || "unversioned";
  const templateInstallController = new AbortController();
  // Callers (IPC, renderer, smokes) receive the install result exactly as
  // before the job wrapper existed: the durable job record lives in the job
  // store, not in this function's return shape.
  const job = await mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: { nodeId: payload.nodeId || null, templateId: payload.templateId || null },
    idempotencyKey: payload.idempotencyKey !== undefined && payload.idempotencyKey !== null
      ? payload.idempotencyKey
      : buildMarketplaceInstallKey({ nodeId: payload.nodeId, subject, version }),
    // The executor checks the shared controller at phase boundaries, so a
    // durable-job cancel stops the next phase from starting; the executor's
    // final guard refuses to report success after a late cancel (P1-1).
    cancellationSupported: true,
    cancel: async () => templateInstallController.abort(),
    run: async ({ jobId, setStage }) => {
      await setStage("executing");
      return executeInstallTemplate(payload, { controller: templateInstallController });
    },
  });
  return job.result;
}

// Cancellation seam for template installs: the executor checks the shared
// controller at phase boundaries, so a cancel stops the NEXT phase from
// starting rather than mid-flight work. The guard also runs immediately
// before completion, so a cancel arriving late still refuses to report
// success — keeping the durable job record honest (P1-1 review finding).
function assertInstallNotAborted(context) {
  if (context?.controller?.aborted) {
    throw createMarketplaceError("The install was cancelled.", "INSTALL_CANCELLED", { retryable: false });
  }
}

async function executeInstallTemplate(payload = {}, context = {}) {
  assertInstallNotAborted(context);
  const requestId = payload.requestId || require("crypto").randomUUID();
  const baseTemplate = findTemplate(payload.templateId, payload.template);
  const agentConfig = resolveMarketplaceAgentConfig(payload.nodeId);
  const targetPlatform = getInstallTargetPlatform(payload, agentConfig);
  const template = resolveTemplateForPlatform(baseTemplate, targetPlatform);
  console.info("[Marketplace][Stage]", { stage: "template.resolved", timestamp: new Date().toISOString(), requestId, nodeId: payload.nodeId || null, templateId: template?.id || payload.templateId || null, instanceName: payload.options?.name || null });
  const progress = [];
  pushStep(progress, "Validate template", "running", `Validating ${template.id}.`);
  if (template.comingSoon || template.disabled) {
    throw createMarketplaceError(template.comingSoonMessage || "This template is not ready yet.", "TEMPLATE_NOT_READY");
  }
  const manifestValidation = validateMarketplaceTemplate(template);
  pushStep(progress, "Validate template", "complete", `${template.id} is installable as ${manifestValidation.installerType}.`);
  // Publisher trust is evaluated for the real entry before any content is
  // downloaded or executed, and the verdict travels with the install record so
  // the existing Marketplace downloads read path surfaces it (no new channel).
  const trustVerdict = evaluateInstallPublisherTrust(template, manifestValidation);
  pushStep(progress, "Validate publisher trust", trustVerdict.verdict === "verified" ? "complete" : "skipped", `${trustVerdict.operatorTitle}. ${trustVerdict.operatorMessage}`);
  console.info("[Marketplace][Trust]", {
    stage: "trust.evaluated",
    timestamp: new Date().toISOString(),
    requestId,
    templateId: template.id,
    verdict: trustVerdict.verdict,
    code: trustVerdict.code,
    publisherKind: trustVerdict.publisherKind,
    executable: trustVerdict.executable,
    requiresReview: trustVerdict.requiresReview,
  });

  const options = normalizeMarketplaceInstallOptions(template, payload.options || {});
  const installNodeId = payload.nodeId || getSelectedNodeId();
  const parentRecord = createInstallTaskRecord(template, { ...options, nodeId: installNodeId });
  updateDownload(parentRecord, { trustVerdict });
  const ports = template.category === "Minecraft"
    ? [resolveMinecraftPort(options, template.defaultPorts)]
    : parsePorts(options.ports || options.port, template.defaultPorts);
  const instancePayload = buildInstancePayload(template, options, ports);
  const installContext = validateInstallContext(buildInstallContext(payload, template, options, instancePayload));

  let installDependencyCheck = null;
  try {
    console.info("[Marketplace][Stage]", { stage: "dependencies.start", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id });
    updateDownload(parentRecord, { stage: "Check dependencies", progress: 10 });
    installDependencyCheck = await ensureTemplateDependencies(template, { ...options, nodeId: installNodeId }, agentConfig, progress, parentRecord);
    console.info("[Marketplace][Stage]", { stage: "dependencies.complete", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id });
  } catch (error) {
    console.error("[Marketplace][Stage]", { stage: "dependencies.error", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id, errorCode: error?.code || null, errorMessage: error?.message || null });
    const message = mapMarketplaceError(error, "Marketplace dependency check failed.");
    finalizeInstallTaskRecord(parentRecord, "failed", message, {
      stage: "Check dependencies",
      code: error?.code || "DEPENDENCIES_REQUIRED",
      retryable: true,
    });
    error.progress = progress;
    throw error;
  }

  assertInstallNotAborted(context);
  if (template.runtime === "docker" || template.startupType === "docker-image") {
    try {
      pushStep(progress, "Create instance", "running", `Creating ${template.displayName}.`);
      updateDownload(parentRecord, { stage: "Create instance", progress: 20 });
      const portMappings = ports.map((port) => `${port}:${port}`);
      const result = await agentClient.createDockerContainer({
        name: slugify(options.id || options.name || template.id),
        image: template.docker?.image || template.downloadSource?.image,
        ports: Array.isArray(template.docker?.ports) ? template.docker.ports : portMappings,
        memory: normalizeName(options.memory, template.defaultRam || ""),
        restartPolicy: template.docker?.restartPolicy || "unless-stopped",
        start: options.start !== false,
        command: template.docker?.command || [],
      }, agentConfig);
      pushStep(progress, "Create instance", "complete", "Docker container created.");
      pushStep(progress, "Complete", "complete", "Installation finished.");
      finalizeInstallTaskRecord(parentRecord, "complete", "Docker container created.", { stage: "Completed" });
      return {
        template,
        instance: result.container,
        container: result.container,
        progress,
        trust: trustVerdict,
        downloads: sanitizeDownloads(getDownloadsForNode(installNodeId)).downloads,
      };
    } catch (error) {
      pushStep(progress, "Failed", "failed", mapMarketplaceError(error, "Docker template install failed."));
      finalizeInstallTaskRecord(parentRecord, "failed", mapMarketplaceError(error, "Docker template install failed."), {
        stage: error?.details?.stage || "Failed",
        code: getAgentErrorCode(error) || "MARKETPLACE_INSTALL_FAILED",
        retryable: error?.details?.retryable,
      });
      const installError = createMarketplaceError(mapMarketplaceError(error, "Docker template install failed."), getAgentErrorCode(error) || "MARKETPLACE_INSTALL_FAILED", {
        ...(error?.details || {}),
        templateId: template.id,
        installerType: manifestValidation.installerType,
        runtimeType: "docker",
        trust: trustVerdict,
        stage: error?.details?.stage || "Create instance",
        retryable: error?.details?.retryable ?? true,
      });
      installError.progress = progress;
      throw installError;
    }
  }

  const isMinecraft = template.category === "Minecraft";
  let createdInstanceId = null;

  try {
    console.info("[Marketplace][Stage]", { stage: "instance.create.start", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id, instanceName: options.name || null, installDirectory: instancePayload.workingDirectory || null });
    console.info("[Marketplace] Create requested.", {
      templateId: template.id,
      generatedInstanceId: instancePayload.id,
      displayName: instancePayload.displayName,
      selectedServerType: isMinecraft ? options.serverType || null : null,
    });
    pushStep(progress, "Create instance", "running", `Creating ${instancePayload.id}.`);
    updateDownload(parentRecord, { stage: "Create instance", progress: 15 });
    // Retry safety: if a previous failed install left the instance behind (it is
    // retained on purpose), reuse it instead of creating an orphaned duplicate.
    const existingStatus = await agentClient.getInstanceStatus(instancePayload.id, agentConfig).catch(() => null);
    const existingInstance = existingStatus?.instance || existingStatus || null;
    const busyStates = ["Starting", "Running", "Stopping", "Restarting"];
    if (existingInstance?.id && busyStates.includes(existingInstance.state)) {
      throw createMarketplaceError(`Instance ${instancePayload.id} is running and cannot be reinstalled. Stop it first.`, "INSTALL_TARGET_RUNNING", { templateId: template.id, instanceId: existingInstance.id, retryable: false });
    }
    const reuseExistingInstance = Boolean(existingInstance?.id) && (!existingInstance.templateId || existingInstance.templateId === template.id);
    if (existingInstance?.id && !reuseExistingInstance) {
      throw createMarketplaceError(`An instance named ${instancePayload.id} already exists for a different template.`, "INSTANCE_ALREADY_EXISTS", { templateId: template.id, instanceId: existingInstance.id, retryable: false });
    }
    let createResult;
    if (reuseExistingInstance) {
      createResult = existingInstance;
      createdInstanceId = existingInstance.id;
    } else {
      createResult = await agentClient.createInstance({ ...instancePayload, installStage: "instance-create" }, agentConfig);
      createdInstanceId = resolveCreatedInstanceId(createResult, instancePayload.id);
    }
    const createRecord = createResult?.instance || createResult?.data?.instance || createResult?.data || createResult || {};
    const instance = typeof createRecord === "object" ? { ...createRecord, id: createdInstanceId } : { id: createdInstanceId };
    console.info("[Marketplace] Create result.", {
      templateId: template.id,
      requestedInstanceId: instancePayload.id,
      createResponse: createResult,
      resolvedCreatedId: createdInstanceId,
    });
    const createdIds = await verifyAgentInstanceExists(createdInstanceId, agentConfig);
    console.info("[Marketplace] Instance verification result.", {
      templateId: template.id,
      requestedInstanceId: instancePayload.id,
      resolvedCreatedId: createdInstanceId,
      refreshedInstanceIds: createdIds,
    });
    pushStep(progress, "Create instance", "complete", `${reuseExistingInstance ? "Reused existing instance" : "Created"} ${createdInstanceId}. Agent instances: ${createdIds.join(", ") || "none"}.`);
    console.info("[Marketplace][Stage]", { stage: "instance.create.complete", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id, instanceId: createdInstanceId });
    assertInstallNotAborted(context);
    await setInstanceInstallStage(createdInstanceId, "instance-create", agentConfig);

    pushStep(progress, "Create folders", "running");
    updateDownload(parentRecord, { stage: "Create folders", progress: 25 });
    await agentClient.createInstanceFolder(createdInstanceId, "runtime", agentConfig);
    pushStep(progress, "Create folders", "complete", `Prepared folders for ${createdInstanceId}.`);

    const generated = generatedFileForTemplate(template, options, ports);
    if (generated) {
      pushStep(progress, "Download files", "running", `Writing ${generated.path}.`);
      await writeInstanceText(createdInstanceId, generated.path, generated.content, agentConfig);
      pushStep(progress, "Download files", "complete", "Starter project generated.");
    }

    assertInstallNotAborted(context);
    await setInstanceInstallStage(createdInstanceId, "archive-download", agentConfig);
    const downloadResult = await downloadToInstance(template, options, createdInstanceId, progress, agentConfig, parentRecord, {
      availableJavaMajor: resolveAvailableJavaMajor(installDependencyCheck),
    });
    console.info("[Marketplace][Stage]", { stage: "download.complete", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id, instanceId: createdInstanceId });
    const installerStageLabel = manifestValidation.installerType === "steamcmd-native" ? "Install SteamCMD app" : "Extract files";
    await setInstanceInstallStage(createdInstanceId, "archive-extract", agentConfig);
    updateDownload(parentRecord, {
      stage: installerStageLabel,
      progress: Math.max(Number(parentRecord.progress) || 0, downloadResult.downloaded ? 55 : 40),
      childTaskIds: Array.from(new Set([
        ...(Array.isArray(parentRecord.childTaskIds) ? parentRecord.childTaskIds : []),
        ...downloadResult.records.map((record) => record.id),
      ])),
    });
    if (downloadResult.metadata && Object.keys(downloadResult.metadata).length > 0) {
      pushStep(progress, "Detecting version", "running", "Saving resolved server version metadata.");
      const savedMetadata = await persistMarketplaceMetadata(createdInstanceId, downloadResult.metadata, agentConfig);
      Object.assign(instance, savedMetadata);
      pushStep(progress, "Detecting version", "complete", downloadResult.metadata.version || downloadResult.metadata.serverVersion || "Version metadata saved.");
    }
    try {
      unwrapInstallerResult(await runTemplateInstaller(template, options, createdInstanceId, progress, agentConfig), {
        stage: "extracting",
        handlerName: "runTemplateInstaller",
        installerType: manifestValidation.installerType,
        runtimeType: template.startupType || template.runtime || template.instanceType || null,
        templateId: template.id,
      });
      console.info("[Marketplace][Stage]", { stage: "installer.complete", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id, instanceId: createdInstanceId });
      finishInstallerDownloadRecords(downloadResult.records, "complete", "Installer completed.", { step: installerStageLabel });
    } catch (error) {
      finishInstallerDownloadRecords(downloadResult.records, "failed", getConciseInstallerFailureMessage(error), error?.details || {});
      throw error;
    }

    assertInstallNotAborted(context);
    pushStep(progress, "Write config", "running");
    updateDownload(parentRecord, { stage: "Write config", progress: 70 });
    await setInstanceInstallStage(createdInstanceId, "configuration", agentConfig);
    if (isMinecraft) {
      await writeInstanceText(createdInstanceId, "eula.txt", `eula=${options.acceptEula ? "true" : "false"}\n`, agentConfig);
      await applyMinecraftServerProperties(agentClient, createdInstanceId, options, ports[0], agentConfig);
      await agentClient.readInstanceFile(createdInstanceId, "eula.txt", agentConfig);
      await agentClient.readInstanceFile(createdInstanceId, "server.properties", agentConfig);
    } else if (Array.isArray(template.configFiles) && template.configFiles.length > 0) {
      await writeTemplateConfigFiles(template, options, ports, createdInstanceId, agentConfig);
    } else if (!generated && !normalizeTemplateDownloads(template).length && !template.startup) {
      await writeInstanceText(
        createdInstanceId,
        "index.js",
        [
          `console.log(${JSON.stringify(`${template.displayName} placeholder instance`)})`,
          "setInterval(() => {}, 30000);",
          "",
        ].join("\n"),
        agentConfig
      );
    }
    pushStep(progress, "Write config", "complete", "Configuration files generated.");

    let setupRequiredResult = null;
    if (isFiveMTemplate(template)) {
      setupRequiredResult = await agentClient.getFiveMReadiness(createdInstanceId, agentConfig);
      const readiness = setupRequiredResult?.readiness || {};
      if (readiness.setupRequired) {
        pushStep(progress, "Setup required", "complete", "FiveM FXServer was installed successfully. Add a license key to finish setup.");
        updateDownload(parentRecord, {
          stage: "Setup required",
          progress: 75,
          canRetry: false,
          canCancel: false,
        });
        appendDownloadLog(parentRecord, {
          step: "Setup required",
          level: "warning",
          message: "FiveM install completed, but sv_licenseKey is not configured.",
          failureReason: readiness.reasonCode || "FIVEM_LICENSE_REQUIRED",
        });
      }
    }

    unwrapInstallerResult(await runTemplatePostInstall(template, options, createdInstanceId, progress, agentConfig), {
      stage: "extracting",
      handlerName: "runTemplatePostInstall",
      installerType: manifestValidation.installerType,
      runtimeType: "java",
      templateId: template.id,
    });

    const installedMetadata = await detectInstalledTemplateMetadata(template, createdInstanceId, agentConfig);
    if (Object.keys(installedMetadata).length > 0) {
      pushStep(progress, "Detecting version", "running", "Saving installed server version metadata.");
      const savedMetadata = await persistMarketplaceMetadata(createdInstanceId, installedMetadata, agentConfig);
      Object.assign(instance, savedMetadata);
      pushStep(progress, "Detecting version", "complete", savedMetadata.version || savedMetadata.serverVersion || "Installed version metadata saved.");
    }

    const startupPatch = buildStartupPatch(template, options, ports);
    if (startupPatch) {
      pushStep(progress, "Configure startup", "running", "Configuring startup command.");
      updateDownload(parentRecord, { stage: "Configure startup", progress: 82 });
      const updated = await agentClient.updateInstance(createdInstanceId, startupPatch, agentConfig);
      const updatedInstance = updated?.instance || updated;
      if (updatedInstance?.executable !== startupPatch.executable || !Array.isArray(updatedInstance?.args) || updatedInstance.args.join("\n") !== startupPatch.args.join("\n")) {
        throw createMarketplaceError("Startup command was not configured.", "STARTUP_CONFIGURATION_FAILED");
      }
      pushStep(progress, "Configure startup", "complete", `Startup command configured: ${startupPatch.executable} ${startupPatch.args.join(" ")}.`);
    }

    let startedInstance = instance;
    const needsDownloadedArtifact = templateNeedsDownloadedArtifact(template, generated);
    if (needsDownloadedArtifact && downloadResult.downloaded) {
      const jarPath = getPrimaryArtifactPath(template, options);
      await agentClient.readInstanceFile(createdInstanceId, jarPath, agentConfig);
      pushStep(progress, "Verify installation", "complete", `${jarPath} is available.`);
    }

    if (startupPatch) {
      const refreshedIds = await verifyAgentInstanceExists(createdInstanceId, agentConfig);
      if (!startupPatch.executable || !Array.isArray(startupPatch.args) || startupPatch.args.length === 0) {
        throw createMarketplaceError("Startup command was not configured.", "STARTUP_CONFIGURATION_FAILED");
      }
      pushStep(progress, "Verify installation", "complete", `Verified ${createdInstanceId}. Agent instances: ${refreshedIds.join(", ") || "none"}.`);
    }

    if (template.manualStartRequired) {
      pushStep(progress, "Optional start", "skipped", template.manualStartMessage || "Manual setup is required before this server can start.");
    } else if (options.start !== false && !setupRequiredResult?.readiness?.setupRequired && (!needsDownloadedArtifact || downloadResult.downloaded)) {
      pushStep(progress, "Optional start", "running");
      updateDownload(parentRecord, { stage: "Optional start", progress: 92 });
      const started = await agentClient.startInstance(createdInstanceId, agentConfig);
      startedInstance = started.instance || started;
      const startReadiness = await waitForStartedInstanceReadiness(createdInstanceId, agentConfig);
      if (startReadiness.failed) {
        const failedInstance = startReadiness.instance || {};
        const stoppedWithoutReason = String(failedInstance.state || "") === "Stopped";
        const failureReason = failedInstance.failureReason || (stoppedWithoutReason ? "PROCESS_EXITED" : "STARTUP_FAILED");
        throw createMarketplaceError(
          `The server process exited before it became ready (${failureReason}${failedInstance.exitCode !== undefined && failedInstance.exitCode !== null ? `, exit code ${failedInstance.exitCode}` : ""}). Open the instance logs for the startup error, fix it, then start the server again.`,
          "START_FAILED",
          {
            templateId: template.id,
            instanceId: createdInstanceId,
            step: "Optional start",
            failureReason,
            exitCode: failedInstance.exitCode ?? null,
            state: failedInstance.state || null,
            healthState: failedInstance.healthState || null,
            readinessState: failedInstance.readinessState || null,
            retryable: true,
          }
        );
      }
      pushStep(
        progress,
        "Optional start",
        "complete",
        startReadiness.ready
          ? "Instance started and reported ready."
          : "Instance start requested; readiness is still pending."
      );
    } else {
      const skipReason = setupRequiredResult?.readiness?.setupRequired
        ? "Start skipped: FiveM setup is required before this server can start."
        : needsDownloadedArtifact
          ? "Start skipped until the server jar is available."
          : "Start was disabled for this install.";
      pushStep(progress, "Optional start", "skipped", skipReason);
    }

    // Final guard: a cancel arriving after all real work still refuses to
    // report success, so the durable record never says CANCELLED for an
    // install that completed (P1-1).
    assertInstallNotAborted(context);
    await setInstanceInstallStage(createdInstanceId, "ready", agentConfig);
    pushStep(progress, "Complete", "complete", setupRequiredResult?.readiness?.setupRequired ? "Installation finished. FiveM setup is required before startup." : "Installation finished.");
    if (setupRequiredResult?.readiness?.setupRequired) {
      updateDownload(parentRecord, {
        status: "complete",
        stage: "Installed — setup required",
        progress: 100,
        body: "FiveM FXServer was installed successfully. Add a license key to finish setup.",
        actionText: "Open FiveM Setup from the instance card.",
        canRetry: false,
        canCancel: false,
      });
    } else {
      finalizeInstallTaskRecord(parentRecord, "complete", "Installation finished.", { stage: "Completed" });
    }
    try {
      const refreshed = await agentClient.getInstanceStatus(createdInstanceId, agentConfig);
      startedInstance = refreshed.instance || refreshed || startedInstance;
    } catch {}

    return {
      template,
      instance: startedInstance,
      progress,
      trust: trustVerdict,
      downloads: sanitizeDownloads(getDownloadsForNode(installNodeId)).downloads,
    };
  } catch (error) {
    console.error("[Marketplace][Stage]", { stage: "install.error", timestamp: new Date().toISOString(), requestId, nodeId: installNodeId, templateId: template.id, instanceId: createdInstanceId, errorCode: error?.code || null, errorMessage: error?.message || null });
    pushStep(progress, "Failed", "failed", mapMarketplaceError(error));
    const errorDetails = getErrorDetails(error);
    const failureStage = getErrorStage(error, createdInstanceId ? "Failed" : "Create instance");
    if (createdInstanceId) {
      // Failed installs keep the instance so it stays visible on the Instances
      // page and can be retried without creating an orphaned duplicate.
      try {
        await agentClient.updateInstance(createdInstanceId, {
          installStage: failureStage,
          lastInstallError: String(mapMarketplaceError(error)).slice(0, 500),
          lastInstallAttemptAt: new Date().toISOString(),
        }, agentConfig);
        pushStep(progress, "Retain instance", "complete", `Instance ${createdInstanceId} retained and marked as a failed install.`);
      } catch (markError) {
        pushStep(progress, "Retain instance", "failed", `Could not record the install failure on instance ${createdInstanceId}: ${markError?.message || "unknown error"}.`);
      }
    }
    finalizeInstallTaskRecord(parentRecord, "failed", mapMarketplaceError(error), {
      ...errorDetails,
      stage: failureStage,
      code: getAgentErrorCode(error) || "MARKETPLACE_INSTALL_FAILED",
      retryable: errorDetails.retryable,
      body: errorDetails.body || null,
    });
    const installError = createMarketplaceError(mapMarketplaceError(error), getAgentErrorCode(error) || "MARKETPLACE_INSTALL_FAILED", {
      ...errorDetails,
      templateId: template.id,
      installerType: manifestValidation.installerType,
      runtimeType: template.startupType || template.runtime || template.instanceType || null,
      installContext,
      trust: trustVerdict,
      stage: failureStage,
      childTaskState: sanitizeDownloads({ downloads: getInstallSessionRecords(parentRecord) }).downloads,
      timestamp: new Date().toISOString(),
      retryable: errorDetails.retryable ?? true,
    });
    installError.progress = progress;
    throw installError;
  }
}

module.exports = {
  _test: {
    buildInstancePayload,
    buildInstallContext,
    buildTemplateInstallSubject,
    buildMinecraftProperties,
    buildSteamCmdInstallerArgs,
    buildResolvedVersionMetadata,
    buildTemplateInstallerScript,
    buildArchiveInstallerScript,
    buildWindowsArchiveInstallerScript,
    categorizeMinecraftVersion,
    compareMinecraftVersions,
    assertInstallerResult,
    assertResolvedJavaCompatible,
    createInstallerResultError,
    createInstallerResultOk,
    evaluateInstallPublisherTrust,
    firstTemplateDownloadUrl,
    getEffectiveInstallerTimeoutMs,
    getTemplateInstallerType,
    getTemplateInstallPlan,
    normalizeMarketplaceInstallOptions,
    normalizePalworldInstallOptions,
    normalizeTemplateDownloads,
    normalizeTemplateTags,
    registerCancellationSmokeRecord: (id, controller) => downloads.set(id, { id, nodeId: "smoke-node", status: "running", canCancel: true, canRetry: false, controller }),
    resolveAvailableJavaMajor,
    resolveTemplateForPlatform,
    parsePorts,
    resolveMarketplaceAgentConfig,
    uniqueVersionEntries,
    validateMarketplaceCatalog,
    validateMarketplaceTemplate,
    validateInstallContext,
    waitForStartedInstanceReadiness,
  },
  cancelDownload,
  createDependencyInstallRecord,
  finalizeDependencyInstallRecord,
  getDownloads: (nodeId = null) => sanitizeDownloads(getDownloadsForNode(nodeId)),
  getImportSupport,
  getMinecraftVersionCatalog,
  importCommunityTemplate,
  installTemplate,
  getTemplateInstallPlanPreview,
  listTemplates,
  retryDownload,
  updateDependencyInstallRecord,
  validateCommunityTemplate,
};
