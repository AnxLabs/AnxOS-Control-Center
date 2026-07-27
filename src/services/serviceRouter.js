const localAmpService = require("./ampService");
const localDockerService = require("./dockerService");
const localPlayitService = require("./playitService");
const localInstanceService = require("./localInstanceService");
const agentClient = require("./agentClient");
const { APPLICATION_HOST_NODE_ID, getExecutionTarget, getNode, getSelectedNodeId } = require("./nodeService");
const diagnostics = require("./diagnosticsService");
const {
  clearForgottenInstance,
  filterForgottenInstances,
  rememberForgottenInstance,
} = require("./instanceForgetService");
const fs = require("fs");
const path = require("path");
let electronShell = null;
try {
  electronShell = require("electron").shell || null;
} catch {
  electronShell = null;
}
const { resolveTemplateDependencyIds } = require("../shared/marketplaceDependencies");

const MARKETPLACE_TEMPLATE_PATH = path.join(__dirname, "..", "..", "config", "marketplace-templates.json");
let marketplaceTemplateCache = null;

class AgentUnavailableError extends Error {
  constructor() {
    super("Agent unavailable. Check Agent settings.");
    this.name = "AgentUnavailableError";
    this.code = "AGENT_UNAVAILABLE";
    this.statusCode = 503;
  }
}

function getAgentErrorCode(error) {
  return error?.payload?.error?.code || error?.code || null;
}

function shouldPreserveAgentError(error) {
  const code = getAgentErrorCode(error);
  return [
    "UNAUTHORIZED",
    "AUTHENTICATION_FAILED",
    "AGENT_INCOMPATIBLE",
    "NODE_DISABLED",
    "NODE_NOT_FOUND",
    "NODE_REQUIRED",
    "AGENT_TIMEOUT",
    "TIMEOUT",
    "NETWORK_ERROR",
  ].includes(code) || error?.status === 401 || error?.statusCode === 401;
}

function createUnavailableFileListing(message = "File service unavailable.") {
  return {
    configured: false,
    connected: false,
    status: "unavailable",
    message,
    currentPath: null,
    roots: [],
    breadcrumbs: [],
    entries: [],
    summary: {
      directoryCount: 0,
      fileCount: 0,
      totalCount: 0,
    },
    lastCheckedAt: new Date().toISOString(),
    diagnostics: {
      local: {
        implemented: false,
      },
    },
  };
}

async function getAgentDockerSnapshot(options = {}) {
  const nodeId = getRequestNodeId(options);
  try {
    const nodeConfig = getOptionalNodeConfig(options);
    const snapshot = await agentClient.getDockerSnapshot(nodeConfig);
    const capabilities = await agentClient.getDockerCapabilities(nodeConfig).catch((error) => {
      if (shouldPreserveAgentError(error)) {
        throw error;
      }
      return {
        available: false,
        code: error?.code || error?.payload?.error?.code || null,
        message: error?.message || "Docker capability manifest is unavailable on this Agent.",
      };
    });
    return withNodeContext({
      ...snapshot,
      agentDockerCapabilities: capabilities,
    }, nodeId);
  } catch (error) {
    diagnostics.log("warn", "docker", "agent-snapshot-failed", "Remote Docker snapshot request failed", {
      nodeId: options?.nodeId || getSelectedNodeId(),
      stage: "agent-request",
      errorCode: error?.code || error?.payload?.error?.code || "DOCKER_AGENT_REQUEST_FAILED",
      endpointCategory: "agent",
    }, { file: "docker" });
    throw error;
  }
}

function createDockerUnavailableSnapshot(message = "Docker is unavailable for this node.") {
  return {
    installed: false,
    daemonRunning: false,
    dockerVersion: null,
    version: null,
    message,
    containers: [],
    images: 0,
    imageCount: 0,
    volumeCount: 0,
    summary: {
      installed: false,
      daemonRunning: false,
      runningContainers: 0,
      stoppedContainers: 0,
      totalContainers: 0,
      images: 0,
      volumes: 0,
    },
    lastCheckedAt: new Date().toISOString(),
  };
}

function isDockerDisabledForNode(options = {}) {
  const selectedNodeId = options?.nodeId || "";
  if (!selectedNodeId || selectedNodeId === "default") {
    return false;
  }
  try {
    return getNode(selectedNodeId)?.docker?.enabled === false;
  } catch {
    return false;
  }
}

function assertDockerEnabledForNode(options = {}) {
  if (isDockerDisabledForNode(options)) {
    const error = new Error("Docker is disabled for this node.");
    error.code = "DOCKER_DISABLED_FOR_NODE";
    error.statusCode = 503;
    throw error;
  }
}

function loadMarketplaceTemplatesForDependencies() {
  if (marketplaceTemplateCache) {
    return marketplaceTemplateCache;
  }
  try {
    marketplaceTemplateCache = JSON.parse(fs.readFileSync(MARKETPLACE_TEMPLATE_PATH, "utf8"));
  } catch {
    marketplaceTemplateCache = [];
  }
  return marketplaceTemplateCache;
}

function findMarketplaceTemplateById(templateId) {
  const id = String(templateId || "").trim();
  if (!id) return null;
  return loadMarketplaceTemplatesForDependencies().find((template) => template?.id === id) || null;
}

async function ensureInstanceDependenciesBeforeStart(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return;
  }
  const status = await getAgentNodeClient(options).getInstanceStatus(instanceId).catch(() => null);
  const instance = status?.instance || status;
  const template = findMarketplaceTemplateById(instance?.templateId);
  const dependencyIds = template ? resolveTemplateDependencyIds(template) : [];
  if (dependencyIds.length === 0) {
    return;
  }
  const check = await agentClient.checkDependencies({ dependencyIds }, getOptionalNodeConfig(options));
  if (check.ok) {
    return;
  }
  if (options.autoInstallDependencies === true) {
    await agentClient.installDependencies({ dependencyIds: check.missingDependencyIds || dependencyIds }, getOptionalNodeConfig(options));
    const recheck = await agentClient.checkDependencies({ dependencyIds }, getOptionalNodeConfig(options));
    if (recheck.ok) {
      return;
    }
  }
  const error = new Error("This instance requires node dependencies before it can start.");
  error.code = "DEPENDENCIES_REQUIRED";
  error.details = {
    instanceId,
    templateId: instance?.templateId || null,
    dependencyIds,
    dependencies: check.dependencies,
    missingDependencies: check.dependencies?.filter((dependency) => !dependency.installed || dependency.state === "update-required") || [],
  };
  throw error;
}

async function getDockerSnapshot(options = {}) {
  const nodeId = getRequestNodeId(options);
  if (isDockerDisabledForNode(options)) {
    return withNodeContext(createDockerUnavailableSnapshot("Docker is disabled for this node."), nodeId);
  }

  if (isApplicationHostTarget(options)) {
    return withNodeContext(await localDockerService.getDockerSnapshot(), nodeId);
  }
  return getAgentDockerSnapshot(options);
}

async function createDockerContainer(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  assertDockerEnabledForNode(payload);
  if (shouldUseLocalDocker(payload)) {
    return withNodeContext(await localDockerService.createContainer(payload), nodeId);
  }
  return withNodeContext(await agentClient.createDockerContainer(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function startDockerContainer(container, options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.startContainer(container), nodeId);
  }
  return withNodeContext(await agentClient.startDockerContainer(container, getOptionalNodeConfig(options)), nodeId);
}

async function stopDockerContainer(container, options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.stopContainer(container), nodeId);
  }
  return withNodeContext(await agentClient.stopDockerContainer(container, getOptionalNodeConfig(options)), nodeId);
}

async function restartDockerContainer(container, options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.restartContainer(container), nodeId);
  }
  return withNodeContext(await agentClient.restartDockerContainer(container, getOptionalNodeConfig(options)), nodeId);
}

async function deleteDockerContainer(container, options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.deleteContainer(container), nodeId);
  }
  return withNodeContext(await agentClient.deleteDockerContainer(container, getOptionalNodeConfig(options)), nodeId);
}

async function getDockerContainerLogs(container, options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.getContainerLogs(container, options), nodeId);
  }
  return withNodeContext(await agentClient.getDockerContainerLogs(container, options, getOptionalNodeConfig(options)), nodeId);
}

async function getDockerContainerStats(container, options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.getContainerStats(container), nodeId);
  }
  return withNodeContext(await agentClient.getDockerContainerStats(container, getOptionalNodeConfig(options)), nodeId);
}

function shouldUseLocalDocker(options = {}) {
  return isApplicationHostTarget(options);
}

function shouldUseLocalInstances(options = {}) {
  return isApplicationHostTarget(options);
}

async function listDockerContainers(options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.getDockerContainers(), nodeId);
  }
  return withNodeContext(await agentClient.getDockerContainers(getOptionalNodeConfig(options)), nodeId);
}

async function inspectDockerContainer(container, options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.inspectContainer(container), nodeId);
  }
  return withNodeContext(await agentClient.inspectDockerContainer(container, getOptionalNodeConfig(options)), nodeId);
}

async function listDockerImages(options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.listImages(), nodeId);
  }
  return withNodeContext(await agentClient.listDockerImages(getOptionalNodeConfig(options)), nodeId);
}

async function deleteDockerImage(image, options = {}) {
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return localDockerService.removeImage(image);
  }
  return agentClient.deleteDockerImage(image, getOptionalNodeConfig(options));
}

async function routeDockerOperation(localMethod, agentMethod, args = [], options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService[localMethod](...args), nodeId);
  }
  return withNodeContext(await agentClient[agentMethod](...args, getOptionalNodeConfig(options)), nodeId);
}

async function pullDockerImage(image, options = {}) { return routeDockerOperation("pullImage", "pullDockerImage", [image], options); }
async function inspectDockerImage(image, options = {}) { return routeDockerOperation("inspectImage", "inspectDockerImage", [image], options); }
async function pruneDockerImages(options = {}) { return routeDockerOperation("pruneImages", "pruneDockerImages", [], options); }
async function pauseDockerContainer(container, options = {}) { return routeDockerOperation("pauseContainer", "pauseDockerContainer", [container], options); }
async function unpauseDockerContainer(container, options = {}) { return routeDockerOperation("unpauseContainer", "unpauseDockerContainer", [container], options); }
async function killDockerContainer(container, options = {}) { return routeDockerOperation("killContainer", "killDockerContainer", [container], options); }
async function renameDockerContainer(container, name, options = {}) { return routeDockerOperation("renameContainer", "renameDockerContainer", [container, name], options); }
async function execDockerContainer(container, payload = {}, options = {}) { return routeDockerOperation("execContainer", "execDockerContainer", [container, payload], options); }
async function inspectDockerVolume(volume, options = {}) { return routeDockerOperation("inspectVolume", "inspectDockerVolume", [volume], options); }
async function removeDockerVolume(volume, options = {}) { return routeDockerOperation("removeVolume", "removeDockerVolume", [volume], options); }
async function pruneDockerVolumes(options = {}) { return routeDockerOperation("pruneVolumes", "pruneDockerVolumes", [], options); }
async function inspectDockerNetwork(network, options = {}) { return routeDockerOperation("inspectNetwork", "inspectDockerNetwork", [network], options); }
async function createDockerNetwork(payload = {}) { return routeDockerOperation("createNetwork", "createDockerNetwork", [payload], payload); }
async function removeDockerNetwork(network, options = {}) { return routeDockerOperation("removeNetwork", "removeDockerNetwork", [network], options); }
async function connectDockerNetwork(network, container, options = {}) { return routeDockerOperation("connectNetwork", "connectDockerNetwork", [network, container], options); }
async function disconnectDockerNetwork(network, container, options = {}) { return routeDockerOperation("disconnectNetwork", "disconnectDockerNetwork", [network, container], options); }
async function pruneDockerNetworks(options = {}) { return routeDockerOperation("pruneNetworks", "pruneDockerNetworks", [], options); }
async function listDockerComposeProjects(options = {}) { return routeDockerOperation("listComposeProjects", "listDockerComposeProjects", [], options); }
async function dockerComposeAction(action, payload = {}) {
  assertDockerEnabledForNode(payload);
  if (shouldUseLocalDocker(payload)) {
    const map = {
      config: "validateComposeConfig",
      up: "startComposeProject",
      stop: "stopComposeProject",
      restart: "restartComposeProject",
      pull: "pullComposeProject",
      build: "buildComposeProject",
      recreate: "recreateComposeProject",
      logs: "getComposeLogs",
      status: "getComposeStatus",
      down: "removeComposeProject",
    };
    if (!map[action]) throw Object.assign(new Error("Invalid Compose action."), { code: "INVALID_COMPOSE_ACTION" });
    return localDockerService[map[action]](payload);
  }
  return agentClient.dockerComposeAction(action, payload, getOptionalNodeConfig(payload));
}
async function getDockerCleanupPreview(options = {}) { return routeDockerOperation("getCleanupPreview", "getDockerCleanupPreview", [], options); }
async function runDockerCleanup(payload = {}) { return routeDockerOperation("runCleanup", "runDockerCleanup", [payload], payload); }

async function listDockerNetworks(options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.listNetworks(), nodeId);
  }
  return withNodeContext(await agentClient.listDockerNetworks(getOptionalNodeConfig(options)), nodeId);
}

async function listDockerVolumes(options = {}) {
  const nodeId = getRequestNodeId(options);
  assertDockerEnabledForNode(options);
  if (shouldUseLocalDocker(options)) {
    return withNodeContext(await localDockerService.listVolumes(), nodeId);
  }
  return withNodeContext(await agentClient.listDockerVolumes(getOptionalNodeConfig(options)), nodeId);
}

async function getAgentPlayitSnapshot(options = {}) {
  try {
    return await agentClient.getPlayitSnapshot(getOptionalNodeConfig(options));
  } catch (error) {
    if (shouldPreserveAgentError(error)) throw error;
    throw new AgentUnavailableError();
  }
}

async function getPlayitSnapshot(options = {}) {
  return isApplicationHostTarget(options) ? localPlayitService.getPlayitSnapshot() : getAgentPlayitSnapshot(options);
}

async function getAgentAmpSnapshot(options = {}) {
  try {
    return await agentClient.getAmpSnapshot(getOptionalNodeConfig(options));
  } catch (error) {
    if (shouldPreserveAgentError(error)) throw error;
    throw new AgentUnavailableError();
  }
}

async function getAmpSnapshot(options = {}) {
  return isApplicationHostTarget(options) ? localAmpService.getAmpSnapshot() : getAgentAmpSnapshot(options);
}

async function getAgentFileListing(options = {}) {
  const config = getOptionalNodeConfig(options);
  try {
    if (!(await agentClient.isHealthy(config))) {
      throw new AgentUnavailableError();
    }
  } catch (error) {
    if (shouldPreserveAgentError(error)) throw error;
    throw new AgentUnavailableError();
  }

  try {
    return await agentClient.getFileListing(".", config);
  } catch (error) {
    if (shouldPreserveAgentError(error)) throw error;
    throw new AgentUnavailableError();
  }
}

async function getFileListing(options = {}) {
  return isApplicationHostTarget(options)
    ? createUnavailableFileListing("Use the renderer-local filesystem provider for the application host.")
    : getAgentFileListing(options);
}

function getOptionalNodeConfig(options = {}) {
  const nodeId = getRequestNodeId(options);
  const target = getExecutionTarget(nodeId);
  if (target.type !== "agent") {
    return null;
  }
  const node = getNode(target.nodeId);
  if (node?.enabled === false) {
    const error = new Error("Selected node is disabled.");
    error.code = "NODE_DISABLED";
    error.statusCode = 403;
    throw error;
  }
  return {
    ...target.config,
    nodeId: target.nodeId,
    agentNodeId: target.nodeId,
  };
}

function getAgentNodeClient(options = {}) {
  const nodeId = getRequestNodeId(options);
  return agentClient.forNode(nodeId);
}

function getRequestNodeId(options = {}) {
  if (options?.nodeId) {
    return options.nodeId;
  }
  const selectedNodeId = getSelectedNodeId() || APPLICATION_HOST_NODE_ID;
  if (selectedNodeId !== APPLICATION_HOST_NODE_ID) {
    diagnostics.log("info", "nodes", "implicit-node-fallback-selected", "Using selected node for agent-backed service request with no explicit nodeId.", {
      selectedNodeId,
      code: "SELECTED_NODE_DEFAULT",
    }, { file: "nodes" });
    return selectedNodeId;
  }
  return APPLICATION_HOST_NODE_ID;
}

function withNodeContext(payload, nodeId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const next = { ...payload, nodeId };
  if (Array.isArray(next.containers)) {
    next.containers = next.containers.map((container) => ({ ...container, nodeId }));
  }
  if (Array.isArray(next.images)) {
    next.images = next.images.map((image) => ({ ...image, nodeId }));
  }
  if (Array.isArray(next.networks)) {
    next.networks = next.networks.map((network) => ({ ...network, nodeId }));
  }
  if (Array.isArray(next.volumes)) {
    next.volumes = next.volumes.map((volume) => ({ ...volume, nodeId }));
  }
  if (Array.isArray(next.backups)) {
    next.backups = next.backups.map((backup) => ({ ...backup, nodeId }));
  }
  if (Array.isArray(next.dependencies)) {
    next.dependencies = next.dependencies.map((dependency) => ({ ...dependency, nodeId: dependency.nodeId || nodeId }));
  }
  if (Array.isArray(next.missingDependencies)) {
    next.missingDependencies = next.missingDependencies.map((dependency) => ({ ...dependency, nodeId: dependency.nodeId || nodeId }));
  }
  if (Array.isArray(next.jobs)) {
    next.jobs = next.jobs.map((job) => ({ ...job, nodeId: job.nodeId || nodeId }));
  }
  if (Array.isArray(next.schedules)) {
    next.schedules = next.schedules.map((schedule) => ({ ...schedule, nodeId }));
  }
  if (next.container && typeof next.container === "object") {
    next.container = { ...next.container, nodeId };
  }
  if (next.backup && typeof next.backup === "object") {
    next.backup = { ...next.backup, nodeId };
  }
  return next;
}

function isApplicationHostTarget(options = {}) {
  return getExecutionTarget(getRequestNodeId(options)).type === "application-host";
}

async function listInstances(options = {}) {
  const nodeId = getRequestNodeId(options);
  if (shouldUseLocalInstances(options)) {
    return filterForgottenInstances(await localInstanceService.listInstances(), nodeId);
  }
  try {
    return filterForgottenInstances(await getAgentNodeClient(options).listInstances(), nodeId);
  } catch (error) {
    diagnostics.log("warn", "instances", "list-failed", "Instance list request failed.", {
      nodeId,
      errorCode: getAgentErrorCode(error) || "INSTANCE_LIST_FAILED",
    }, { file: "instances" });
    if (shouldPreserveAgentError(error)) throw error;
    throw new AgentUnavailableError();
  }
}

async function createInstance(payload) {
  const nodeId = getRequestNodeId(payload);
  const result = shouldUseLocalInstances(payload)
    ? await localInstanceService.createInstance(payload)
    : await getAgentNodeClient(payload).createInstance(payload);
  clearForgottenInstance(nodeId, result?.id || result?.instance?.id || payload?.id);
  return result;
}

async function updateInstance(instanceId, payload, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.updateInstance(instanceId, payload);
  }
  return getAgentNodeClient(options).updateInstance(instanceId, payload);
}

async function renameInstance(instanceId, displayName, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.renameInstance(instanceId, displayName);
  }
  return getAgentNodeClient(options).renameInstance(instanceId, displayName);
}

async function duplicateInstance(instanceId, payload = {}, options = {}) {
  const nodeId = options?.nodeId || getSelectedNodeId();
  const result = shouldUseLocalInstances(options)
    ? await localInstanceService.duplicateInstance(instanceId, payload)
    : await getAgentNodeClient(options).duplicateInstance(instanceId, payload);
  clearForgottenInstance(nodeId, result?.instance?.id || result?.id || payload?.id);
  return result;
}

async function openInstanceFolder(instanceId, options = {}) {
  const nodeId = options?.nodeId || getSelectedNodeId();
  const node = getNode(nodeId);
  if (!shouldUseLocalInstances(options) && node?.localAgent !== true) {
    const error = new Error("INSTANCE_FOLDER_OPEN_UNSUPPORTED");
    error.code = "INSTANCE_FOLDER_OPEN_UNSUPPORTED";
    error.statusCode = 400;
    throw error;
  }
  const status = shouldUseLocalInstances(options)
    ? await localInstanceService.getStatus(instanceId)
    : await getAgentNodeClient(options).getInstanceStatus(instanceId);
  const instance = status?.instance || status || {};
  const folderPath = instance.instancePath;
  if (!folderPath || !path.isAbsolute(folderPath)) {
    const error = new Error("INSTANCE_FOLDER_UNAVAILABLE");
    error.code = "INSTANCE_FOLDER_UNAVAILABLE";
    error.statusCode = 404;
    throw error;
  }
  if (!electronShell?.openPath) {
    const error = new Error("INSTANCE_FOLDER_OPEN_UNSUPPORTED");
    error.code = "INSTANCE_FOLDER_OPEN_UNSUPPORTED";
    error.statusCode = 400;
    throw error;
  }
  const openError = await electronShell.openPath(folderPath);
  if (openError) {
    const error = new Error("INSTANCE_FOLDER_OPEN_FAILED");
    error.code = "INSTANCE_FOLDER_OPEN_FAILED";
    error.statusCode = 500;
    error.message = openError;
    throw error;
  }
  return {
    id: instance.id || instanceId,
    path: folderPath,
    opened: true,
  };
}

async function getInstanceStatus(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.getStatus(instanceId);
  }
  return getAgentNodeClient(options).getInstanceStatus(instanceId);
}

async function getInstanceMetrics(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.getMetrics(instanceId);
  }
  return getAgentNodeClient(options).getInstanceMetrics(instanceId);
}

async function getInstanceLogs(instanceId, options) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.readLogs(instanceId, options);
  }
  return getAgentNodeClient(options).getInstanceLogs(instanceId, options);
}

async function clearInstanceLogs(instanceId, options) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.clearLogs(instanceId, options);
  }
  return getAgentNodeClient(options).clearInstanceLogs(instanceId, options);
}

async function sendInstanceCommand(instanceId, command, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.writeInstanceInput(instanceId, command);
  }
  return getAgentNodeClient(options).sendInstanceCommand(instanceId, command);
}

async function forceKillInstance(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.forceKillInstance(instanceId);
  }
  return getAgentNodeClient(options).forceKillInstance(instanceId);
}

async function listInstanceFiles(instanceId, currentPath, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.listInstanceFiles(instanceId, currentPath);
  }
  return getAgentNodeClient(options).listInstanceFiles(instanceId, currentPath);
}

async function readInstanceFile(instanceId, filePath, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.readInstanceFile(instanceId, filePath);
  }
  return getAgentNodeClient(options).readInstanceFile(instanceId, filePath);
}

async function writeInstanceFile(instanceId, filePath, content, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.writeInstanceFile(instanceId, filePath, content, options);
  }
  return getAgentNodeClient(options).writeInstanceFile(instanceId, filePath, content, options);
}

async function deleteInstanceFile(instanceId, filePath, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.deleteInstanceFile(instanceId, filePath);
  }
  return getAgentNodeClient(options).deleteInstanceFile(instanceId, filePath);
}

async function createInstanceFolder(instanceId, folderPath, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.createInstanceFolder(instanceId, folderPath);
  }
  return getAgentNodeClient(options).createInstanceFolder(instanceId, folderPath);
}

async function renameInstanceFile(instanceId, oldPath, newPath, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.renameInstanceFile(instanceId, oldPath, newPath);
  }
  return getAgentNodeClient(options).renameInstanceFile(instanceId, oldPath, newPath);
}

async function getMinecraftProperties(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.readMinecraftProperties(instanceId);
  }
  return getAgentNodeClient(options).getMinecraftProperties(instanceId);
}

async function getGameServerConfig(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.readGameServerConfig(instanceId, options);
  }
  return getAgentNodeClient(options).getGameServerConfig(instanceId, options);
}

async function saveGameServerConfig(instanceId, payload = {}, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.writeGameServerConfig(instanceId, payload);
  }
  return getAgentNodeClient(options).saveGameServerConfig(instanceId, payload);
}

async function saveMinecraftProperties(instanceId, properties, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.writeMinecraftProperties(instanceId, properties);
  }
  return getAgentNodeClient(options).saveMinecraftProperties(instanceId, properties);
}

async function getFiveMReadiness(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.refreshFiveMReadiness(instanceId);
  }
  return getAgentNodeClient(options).getFiveMReadiness(instanceId);
}

async function saveFiveMLicenseKey(instanceId, licenseKey, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.saveFiveMLicenseKey(instanceId, licenseKey);
  }
  return getAgentNodeClient(options).saveFiveMLicenseKey(instanceId, licenseKey);
}

async function getDependencyCatalog(options = {}) {
  const nodeId = getRequestNodeId(options);
  if (shouldUseLocalInstances(options)) {
    return withNodeContext({
      dependencies: [],
      groups: [],
      distribution: {
        id: process.platform,
        name: process.platform,
        packageManager: null,
      },
    }, nodeId);
  }
  return withNodeContext(await agentClient.getDependencyCatalog(getOptionalNodeConfig(options)), nodeId);
}

async function checkDependencies(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  if (shouldUseLocalInstances(payload)) {
    return withNodeContext({
      ok: true,
      dependencies: [],
      missingDependencyIds: [],
      checkedAt: new Date().toISOString(),
    }, nodeId);
  }
  return withNodeContext(await agentClient.checkDependencies(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function planDependencyPreparation(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  if (shouldUseLocalInstances(payload)) {
    return withNodeContext({
      ok: true,
      dependencyIds: [],
      distribution: {
        id: process.platform,
        name: process.platform,
        packageManager: null,
      },
      actions: [],
      installableActions: [],
      manualActions: [],
      missingDependencyIds: [],
      requiresUserInitiation: false,
      plannedAt: new Date().toISOString(),
    }, nodeId);
  }
  return withNodeContext(await agentClient.planDependencyPreparation(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function installDependencies(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  if (shouldUseLocalInstances(payload)) {
    const now = new Date().toISOString();
    const jobId = `dep-local-${Date.now().toString(36)}`;
    const job = {
      id: jobId,
      dependencyId: "local-desktop",
      dependencyName: "Local Desktop dependencies",
      nodeId: payload.nodeId || getSelectedNodeId(),
      platform: process.platform,
      state: "completed",
      stage: "Installation complete",
      progressMode: "determinate",
      progressPercent: 100,
      message: "Local Desktop dependency installation is not required for this target.",
      startedAt: now,
      completedAt: now,
      exitCode: null,
      restartRequired: false,
      authenticationRequired: false,
      executionBackend: "desktop",
      installationMethod: "local-noop",
      externalTerminal: false,
      error: null,
      events: [{
        jobId,
        nodeId: payload.nodeId || getSelectedNodeId(),
        dependencyId: "local-desktop",
        state: "completed",
        stage: "Installation complete",
        message: "Local Desktop dependency installation is not required for this target.",
        at: now,
      }],
      output: [],
    };
    return withNodeContext({
      ok: true,
      job,
      jobs: [job],
      results: [],
      dependencies: [],
      missingDependencyIds: [],
      completedAt: new Date().toISOString(),
    }, nodeId);
  }
  return withNodeContext(await agentClient.installDependencies(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function startInstance(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.startInstance(instanceId);
  }
  await ensureInstanceDependenciesBeforeStart(instanceId, options);
  return getAgentNodeClient(options).startInstance(instanceId);
}

async function stopInstance(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.stopInstance(instanceId);
  }
  return getAgentNodeClient(options).stopInstance(instanceId);
}

async function restartInstance(instanceId, options = {}) {
  if (shouldUseLocalInstances(options)) {
    return localInstanceService.restartInstance(instanceId);
  }
  return getAgentNodeClient(options).restartInstance(instanceId);
}

async function deleteInstance(instanceId, options = {}) {
  const nodeId = options?.nodeId || getSelectedNodeId();
  if (shouldUseLocalInstances(options)) {
    const result = await localInstanceService.deleteInstance(instanceId);
    clearForgottenInstance(nodeId, instanceId);
    diagnostics.log("info", "instances", "delete", "Local instance delete completed.", {
      nodeId,
      instanceId,
      filesDeleted: result?.filesDeleted,
      metadataRemoved: result?.metadataRemoved,
      alreadyMissing: result?.alreadyMissing,
      partiallyFailed: result?.partiallyFailed,
    }, { file: "instances" });
    return result;
  }
  try {
    const result = await getAgentNodeClient(options).deleteInstance(instanceId);
    clearForgottenInstance(nodeId, instanceId);
    diagnostics.log("info", "instances", "delete", "Agent instance delete completed.", {
      nodeId,
      instanceId,
      filesDeleted: result?.filesDeleted,
      metadataRemoved: result?.metadataRemoved,
      alreadyMissing: result?.alreadyMissing,
      partiallyFailed: result?.partiallyFailed,
    }, { file: "instances" });
    return result;
  } catch (error) {
    diagnostics.logError("instances", "delete-failed", error, {
      nodeId,
      instanceId,
      errorCode: error?.code || error?.payload?.error?.code || "INSTANCE_DELETE_FAILED",
      result: error?.payload?.error?.details?.result || error?.result || null,
    }, { file: "instances" });
    throw error;
  }
}

async function forgetInstance(instanceId, options = {}) {
  const nodeId = options?.nodeId || getSelectedNodeId();
  const baseResult = {
    id: instanceId,
    deleted: false,
    filesDeleted: false,
    metadataRemoved: false,
    alreadyMissing: false,
    partiallyFailed: false,
    stale: true,
    tombstoneAdded: false,
    nodeUnavailable: false,
    errors: [],
  };
  if (shouldUseLocalInstances(options)) {
    const result = await localInstanceService.forgetInstance(instanceId);
    rememberForgottenInstance(nodeId, instanceId, { reason: "local-forget" });
    diagnostics.log("info", "instances", "forget", "Local instance record removed.", {
      nodeId,
      instanceId,
      metadataRemoved: result?.metadataRemoved,
      alreadyMissing: result?.alreadyMissing,
    }, { file: "instances" });
    return { ...baseResult, ...result, tombstoneAdded: true };
  }
  try {
    const result = await getAgentNodeClient(options).forgetInstance(instanceId);
    rememberForgottenInstance(nodeId, instanceId, { reason: "agent-forget" });
    diagnostics.log("info", "instances", "forget", "Agent instance record removed.", {
      nodeId,
      instanceId,
      metadataRemoved: result?.metadataRemoved,
      alreadyMissing: result?.alreadyMissing,
    }, { file: "instances" });
    return { ...baseResult, ...result, tombstoneAdded: true };
  } catch (error) {
    if (error?.code === "AGENT_UNAVAILABLE" || error?.code === "AGENT_TIMEOUT" || error?.status === 503 || error?.statusCode === 503) {
      rememberForgottenInstance(nodeId, instanceId, { reason: "node-unavailable" });
      diagnostics.log("warn", "instances", "forget-offline", "Instance hidden because selected Agent is unavailable.", {
        nodeId,
        instanceId,
        errorCode: error?.code || "AGENT_UNAVAILABLE",
      }, { file: "instances" });
      return {
        ...baseResult,
        deleted: true,
        partiallyFailed: true,
        tombstoneAdded: true,
        nodeUnavailable: true,
        errors: [{ code: "AGENT_UNAVAILABLE", message: "Agent was unavailable; instance was removed from this Control Center list only." }],
      };
    }
    diagnostics.logError("instances", "forget-failed", error, {
      nodeId,
      instanceId,
      errorCode: error?.code || error?.payload?.error?.code || "INSTANCE_FORGET_FAILED",
    }, { file: "instances" });
    throw error;
  }
}

async function listBackups(options = {}) {
  const nodeId = getRequestNodeId(options);
  return withNodeContext(await agentClient.listBackups(options, getOptionalNodeConfig(options)), nodeId);
}

async function createBackup(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  return withNodeContext(await agentClient.createBackup(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function restoreBackup(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  return withNodeContext(await agentClient.restoreBackup(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function deleteBackup(backupId, options = {}) {
  const nodeId = getRequestNodeId(options);
  return withNodeContext(await agentClient.deleteBackup(backupId, getOptionalNodeConfig(options)), nodeId);
}

async function downloadBackup(backupId, options = {}) {
  return agentClient.downloadBackup(backupId, getOptionalNodeConfig(options));
}

async function importBackup(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  return withNodeContext(await agentClient.importBackup(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function listBackupSchedules(options = {}) {
  const nodeId = getRequestNodeId(options);
  return withNodeContext(await agentClient.listBackupSchedules(getOptionalNodeConfig(options)), nodeId);
}

async function saveBackupSchedule(payload = {}) {
  const nodeId = getRequestNodeId(payload);
  return withNodeContext(await agentClient.saveBackupSchedule(payload, getOptionalNodeConfig(payload)), nodeId);
}

async function deleteBackupSchedule(instanceId, options = {}) {
  const nodeId = getRequestNodeId(options);
  return withNodeContext(await agentClient.deleteBackupSchedule(instanceId, getOptionalNodeConfig(options)), nodeId);
}

module.exports = {
  checkDependencies,
  clearInstanceLogs,
  createBackup,
  createDockerContainer,
  createDockerNetwork,
  deleteDockerImage,
  createInstance,
  createInstanceFolder,
  deleteBackup,
  deleteBackupSchedule,
  deleteDockerContainer,
  disconnectDockerNetwork,
  dockerComposeAction,
  execDockerContainer,
  deleteInstance,
  duplicateInstance,
  deleteInstanceFile,
  downloadBackup,
  forceKillInstance,
  forgetInstance,
  getAmpSnapshot,
  getDependencyCatalog,
  getDockerSnapshot,
  getDockerCleanupPreview,
  getDockerContainerLogs,
  getDockerContainerStats,
  getFileListing,
  inspectDockerContainer,
  inspectDockerImage,
  inspectDockerNetwork,
  inspectDockerVolume,
  getInstanceLogs,
  getInstanceMetrics,
  getInstanceStatus,
  getGameServerConfig,
  openInstanceFolder,
  getFiveMReadiness,
  getMinecraftProperties,
  getPlayitSnapshot,
  importBackup,
  installDependencies,
  listDockerContainers,
  listDockerComposeProjects,
  listDockerImages,
  listDockerNetworks,
  listDockerVolumes,
  connectDockerNetwork,
  killDockerContainer,
  pauseDockerContainer,
  pullDockerImage,
  pruneDockerImages,
  pruneDockerNetworks,
  pruneDockerVolumes,
  listBackupSchedules,
  listBackups,
  listInstanceFiles,
  listInstances,
  planDependencyPreparation,
  readInstanceFile,
  renameInstanceFile,
  renameInstance,
  restartInstance,
  restartDockerContainer,
  removeDockerNetwork,
  removeDockerVolume,
  renameDockerContainer,
  runDockerCleanup,
  restoreBackup,
  saveFiveMLicenseKey,
  saveGameServerConfig,
  saveMinecraftProperties,
  saveBackupSchedule,
  sendInstanceCommand,
  startInstance,
  startDockerContainer,
  stopInstance,
  stopDockerContainer,
  unpauseDockerContainer,
  updateInstance,
  writeInstanceFile,
};
