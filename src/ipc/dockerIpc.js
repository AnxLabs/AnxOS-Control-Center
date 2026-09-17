const { ipcMain } = require("electron");
const {
  createDockerContainer,
  createDockerNetwork,
  deleteDockerImage,
  deleteDockerContainer,
  disconnectDockerNetwork,
  dockerComposeAction,
  execDockerContainer,
  getDockerCleanupPreview,
  getDockerContainerLogs,
  getDockerContainerStats,
  getDockerSnapshot,
  inspectDockerImage,
  inspectDockerContainer,
  inspectDockerNetwork,
  inspectDockerVolume,
  killDockerContainer,
  listDockerContainers,
  listDockerComposeProjects,
  listDockerImages,
  listDockerNetworks,
  listDockerVolumes,
  pauseDockerContainer,
  preflightDockerContainer,
  pullDockerImage,
  pruneDockerImages,
  pruneDockerNetworks,
  pruneDockerVolumes,
  removeDockerNetwork,
  removeDockerVolume,
  renameDockerContainer,
  restartDockerContainer,
  runDockerCleanup,
  startDockerContainer,
  stopDockerContainer,
  unpauseDockerContainer,
  connectDockerNetwork,
} = require("../services/serviceRouter");
const { audit, requirePermission } = require("../services/securityService");
const { wrapExpectedAgentRead } = require("./expectedAgentError");
const { requireNodeContext } = require("./nodeContext");
const { createIpcError } = require("../shared/ipcError");

function requireDockerNodeContext(payload = {}, operation = "request") {
  return requireNodeContext(payload, `Docker ${operation}`);
}

function requireDockerRead(payload = {}, operation = "request", target = null) {
  requirePermission("docker:read", target || payload.container || payload.image || payload.volume || payload.network || payload.nodeId);
  return requireDockerNodeContext(payload, operation);
}

function invokeDockerOperation(operation) {
  return Promise.resolve()
    .then(operation)
    .catch((error) => {
      throw createIpcError(error, {
        code: "DOCKER_REQUEST_FAILED",
        fallbackMessage: "Docker request failed.",
        suggestion: "Verify Docker is running and the selected Agent has Docker access, then retry.",
      });
    });
}

function registerDockerIpc() {
  ipcMain.handle("docker:getSnapshot", async (_, payload = {}) => wrapExpectedAgentRead("docker:getSnapshot", () => getDockerSnapshot(requireDockerRead(payload, "snapshot"))));
  ipcMain.handle("docker:listContainers", async (_, payload = {}) => wrapExpectedAgentRead("docker:listContainers", () => listDockerContainers(requireDockerRead(payload, "container listing"))));
  ipcMain.handle("docker:inspectContainer", async (_, payload = {}) => invokeDockerOperation(() => inspectDockerContainer(payload.container, requireDockerRead(payload, "container inspection"))));
  ipcMain.handle("docker:listImages", async (_, payload = {}) => wrapExpectedAgentRead("docker:listImages", () => listDockerImages(requireDockerRead(payload, "image listing"))));
  ipcMain.handle("docker:removeImage", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "image removal");
    requirePermission("instance:delete", payload.image);
    audit({ action: "docker.image.delete", target: payload.image });
    return deleteDockerImage(payload.image, payload);
  }));
  ipcMain.handle("docker:pullImage", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "image pull");
    requirePermission("instance:write", payload.image);
    audit({ action: "docker.image.pull", target: payload.image });
    return pullDockerImage(payload.image, payload);
  }));
  ipcMain.handle("docker:inspectImage", async (_, payload = {}) => invokeDockerOperation(() => inspectDockerImage(payload.image, requireDockerRead(payload, "image inspection"))));
  ipcMain.handle("docker:pruneImages", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "image prune");
    requirePermission("instance:delete", "docker-images");
    audit({ action: "docker.images.prune", target: "unused-images" });
    return pruneDockerImages(payload);
  }));
  ipcMain.handle("docker:listNetworks", async (_, payload = {}) => wrapExpectedAgentRead("docker:listNetworks", () => listDockerNetworks(requireDockerRead(payload, "network listing"))));
  ipcMain.handle("docker:listVolumes", async (_, payload = {}) => wrapExpectedAgentRead("docker:listVolumes", () => listDockerVolumes(requireDockerRead(payload, "volume listing"))));
  ipcMain.handle("docker:create", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container creation");
    requirePermission("instance:write", payload.name || payload.image);
    audit({ action: "docker.create", target: payload.name || payload.image });
    return createDockerContainer(payload);
  }));
  ipcMain.handle("docker:preflightContainer", async (_, payload = {}) => invokeDockerOperation(() => {
    requirePermission("docker:read", payload.name || payload.image || payload.nodeId);
    requireDockerNodeContext(payload, "container preflight");
    audit({ action: "docker.preflight.container", target: payload.name || payload.image });
    return preflightDockerContainer(payload);
  }));
  ipcMain.handle("docker:start", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container start");
    requirePermission("instance:lifecycle", payload.container);
    return startDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:stop", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container stop");
    requirePermission("instance:lifecycle", payload.container);
    return stopDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:restart", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container restart");
    requirePermission("instance:lifecycle", payload.container);
    return restartDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:pause", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container pause");
    requirePermission("instance:lifecycle", payload.container);
    return pauseDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:unpause", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container unpause");
    requirePermission("instance:lifecycle", payload.container);
    return unpauseDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:kill", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container kill");
    requirePermission("instance:lifecycle", payload.container);
    audit({ action: "docker.kill", target: payload.container });
    return killDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:rename", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container rename");
    requirePermission("instance:write", payload.container);
    audit({ action: "docker.rename", target: payload.container });
    return renameDockerContainer(payload.container, payload.name, payload);
  }));
  ipcMain.handle("docker:delete", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container deletion");
    requirePermission("instance:delete", payload.container);
    audit({ action: "docker.delete", target: payload.container });
    return deleteDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:removeContainer", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container removal");
    requirePermission("instance:delete", payload.container);
    audit({ action: "docker.delete", target: payload.container });
    return deleteDockerContainer(payload.container, payload);
  }));
  ipcMain.handle("docker:getLogs", async (_, payload = {}) => invokeDockerOperation(() => getDockerContainerLogs(payload.container, requireDockerRead(payload, "container logs"))));
  ipcMain.handle("docker:getStats", async (_, payload = {}) => invokeDockerOperation(() => getDockerContainerStats(payload.container, requireDockerRead(payload, "container stats"))));
  ipcMain.handle("docker:exec", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "container exec");
    requirePermission("instance:write", payload.container);
    audit({ action: "docker.exec", target: payload.container });
    return execDockerContainer(payload.container, payload, payload);
  }));
  ipcMain.handle("docker:inspectVolume", async (_, payload = {}) => invokeDockerOperation(() => inspectDockerVolume(payload.volume, requireDockerRead(payload, "volume inspection"))));
  ipcMain.handle("docker:removeVolume", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "volume removal");
    requirePermission("instance:delete", payload.volume);
    audit({ action: "docker.volume.delete", target: payload.volume });
    return removeDockerVolume(payload.volume, payload);
  }));
  ipcMain.handle("docker:pruneVolumes", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "volume prune");
    requirePermission("instance:delete", "docker-volumes");
    audit({ action: "docker.volumes.prune", target: "unused-volumes" });
    return pruneDockerVolumes(payload);
  }));
  ipcMain.handle("docker:inspectNetwork", async (_, payload = {}) => invokeDockerOperation(() => inspectDockerNetwork(payload.network, requireDockerRead(payload, "network inspection"))));
  ipcMain.handle("docker:createNetwork", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "network creation");
    requirePermission("instance:write", payload.name);
    audit({ action: "docker.network.create", target: payload.name });
    return createDockerNetwork(payload);
  }));
  ipcMain.handle("docker:removeNetwork", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "network removal");
    requirePermission("instance:delete", payload.network);
    audit({ action: "docker.network.delete", target: payload.network });
    return removeDockerNetwork(payload.network, payload);
  }));
  ipcMain.handle("docker:connectNetwork", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "network connect");
    requirePermission("instance:write", payload.container);
    audit({ action: "docker.network.connect", target: `${payload.network}:${payload.container}` });
    return connectDockerNetwork(payload.network, payload.container, payload);
  }));
  ipcMain.handle("docker:disconnectNetwork", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "network disconnect");
    requirePermission("instance:write", payload.container);
    audit({ action: "docker.network.disconnect", target: `${payload.network}:${payload.container}` });
    return disconnectDockerNetwork(payload.network, payload.container, payload);
  }));
  ipcMain.handle("docker:pruneNetworks", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "network prune");
    requirePermission("instance:delete", "docker-networks");
    audit({ action: "docker.networks.prune", target: "unused-networks" });
    return pruneDockerNetworks(payload);
  }));
  ipcMain.handle("docker:listComposeProjects", async (_, payload = {}) => invokeDockerOperation(() => listDockerComposeProjects(requireDockerRead(payload, "Compose project listing"))));
  ipcMain.handle("docker:compose", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "Compose action");
    if (["config", "logs", "status"].includes(payload.action)) requirePermission("docker:read", payload.projectName);
    else requirePermission("instance:write", payload.projectName);
    audit({ action: `docker.compose.${payload.action || "unknown"}`, target: payload.projectName || payload.projectDirectory });
    return dockerComposeAction(payload.action, payload);
  }));
  ipcMain.handle("docker:getCleanupPreview", async (_, payload = {}) => invokeDockerOperation(() => getDockerCleanupPreview(requireDockerRead(payload, "cleanup preview"))));
  ipcMain.handle("docker:cleanup", async (_, payload = {}) => invokeDockerOperation(() => {
    requireDockerNodeContext(payload, "cleanup");
    requirePermission("instance:delete", `docker-cleanup-${payload.kind || "unknown"}`);
    audit({ action: "docker.cleanup", target: payload.kind });
    return runDockerCleanup(payload);
  }));
}

module.exports = {
  registerDockerIpc,
};
