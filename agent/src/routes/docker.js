const {
  createContainer,
  createNetwork,
  deleteContainer,
  execContainer,
  getCleanupPreview,
  getComposeLogs,
  getComposeStatus,
  getContainerLogs,
  getContainerStats,
  getDockerContainers,
  getDockerSnapshot,
  getDockerSummary,
  inspectImage,
  inspectContainer,
  inspectNetwork,
  inspectVolume,
  killContainer,
  listImages,
  listComposeProjects,
  listNetworks,
  listVolumes,
  pauseContainer,
  pullImage,
  pruneImages,
  pruneNetworks,
  pruneVolumes,
  recreateComposeProject,
  removeImage,
  removeComposeProject,
  removeNetwork,
  removeVolume,
  renameContainer,
  restartContainer,
  restartComposeProject,
  runCleanup,
  startContainer,
  startComposeProject,
  stopContainer,
  stopComposeProject,
  pullComposeProject,
  buildComposeProject,
  validateComposeConfig,
  connectNetwork,
  disconnectNetwork,
  unpauseContainer,
} = require("../services/dockerService");
const { mintDockerJob } = require("../services/dockerJobService");

function parseJsonBody(request) {
  if (!request.body) {
    return {};
  }
  try {
    return JSON.parse(request.body);
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    error.statusCode = 400;
    throw error;
  }
}

function result(statusCode, body) {
  return { statusCode, body };
}

// Job options are request-level and must never leak into the docker payload.
function stripJobOptions(payload = {}) {
  const copy = { ...payload };
  for (const key of ["idempotencyKey", "jobTimeoutMs", "owner"]) {
    delete copy[key];
  }
  return copy;
}

// State-changing docker responses carry their durable job alongside the
// operation result (additive; existing docker response fields are preserved).
function attachJob(opResult, job) {
  if (opResult && typeof opResult === "object" && !Array.isArray(opResult)) {
    return { ...opResult, job };
  }
  return { result: opResult, job };
}

const DOCKER_ROUTE_MANIFEST = Object.freeze([
  { method: "GET", path: "/api/v1/docker/capabilities", operation: "docker.capabilities" },
  { method: "GET", path: "/api/v1/docker/snapshot", operation: "docker.snapshot" },
  { method: "GET", path: "/api/v1/docker/summary", operation: "docker.summary" },
  { method: "GET", path: "/api/v1/docker/containers", operation: "docker.containers.list" },
  { method: "POST", path: "/api/v1/docker/containers", operation: "docker.containers.create" },
  { method: "GET", path: "/api/v1/docker/containers/:container/inspect", operation: "docker.containers.inspect" },
  { method: "GET", path: "/api/v1/docker/containers/:container/logs", operation: "docker.containers.logs" },
  { method: "GET", path: "/api/v1/docker/containers/:container/stats", operation: "docker.containers.stats" },
  { method: "POST", path: "/api/v1/docker/containers/:container/start", operation: "docker.containers.start" },
  { method: "POST", path: "/api/v1/docker/containers/:container/stop", operation: "docker.containers.stop" },
  { method: "POST", path: "/api/v1/docker/containers/:container/restart", operation: "docker.containers.restart" },
  { method: "POST", path: "/api/v1/docker/containers/:container/pause", operation: "docker.containers.pause" },
  { method: "POST", path: "/api/v1/docker/containers/:container/unpause", operation: "docker.containers.unpause" },
  { method: "POST", path: "/api/v1/docker/containers/:container/kill", operation: "docker.containers.kill" },
  { method: "POST", path: "/api/v1/docker/containers/:container/rename", operation: "docker.containers.rename" },
  { method: "POST", path: "/api/v1/docker/containers/:container/exec", operation: "docker.containers.exec" },
  { method: "DELETE", path: "/api/v1/docker/containers/:container", operation: "docker.containers.delete" },
  { method: "GET", path: "/api/v1/docker/images", operation: "docker.images.list" },
  { method: "GET", path: "/api/v1/docker/images/:image", operation: "docker.images.inspect" },
  { method: "DELETE", path: "/api/v1/docker/images/:image", operation: "docker.images.delete" },
  { method: "POST", path: "/api/v1/docker/images/pull", operation: "docker.images.pull" },
  { method: "POST", path: "/api/v1/docker/images/prune", operation: "docker.images.prune" },
  { method: "GET", path: "/api/v1/docker/networks", operation: "docker.networks.list" },
  { method: "POST", path: "/api/v1/docker/networks", operation: "docker.networks.create" },
  { method: "GET", path: "/api/v1/docker/networks/:network/inspect", operation: "docker.networks.inspect" },
  { method: "DELETE", path: "/api/v1/docker/networks/:network", operation: "docker.networks.delete" },
  { method: "POST", path: "/api/v1/docker/networks/:network/connect", operation: "docker.networks.connect" },
  { method: "POST", path: "/api/v1/docker/networks/:network/disconnect", operation: "docker.networks.disconnect" },
  { method: "POST", path: "/api/v1/docker/networks/prune", operation: "docker.networks.prune" },
  { method: "GET", path: "/api/v1/docker/volumes", operation: "docker.volumes.list" },
  { method: "GET", path: "/api/v1/docker/volumes/:volume/inspect", operation: "docker.volumes.inspect" },
  { method: "DELETE", path: "/api/v1/docker/volumes/:volume", operation: "docker.volumes.delete" },
  { method: "POST", path: "/api/v1/docker/volumes/prune", operation: "docker.volumes.prune" },
  { method: "GET", path: "/api/v1/docker/compose/projects", operation: "docker.compose.list" },
  { method: "POST", path: "/api/v1/docker/compose/config", operation: "docker.compose.validate" },
  { method: "POST", path: "/api/v1/docker/compose/up", operation: "docker.compose.start" },
  { method: "POST", path: "/api/v1/docker/compose/stop", operation: "docker.compose.stop" },
  { method: "POST", path: "/api/v1/docker/compose/restart", operation: "docker.compose.restart" },
  { method: "POST", path: "/api/v1/docker/compose/pull", operation: "docker.compose.pull" },
  { method: "POST", path: "/api/v1/docker/compose/build", operation: "docker.compose.build" },
  { method: "POST", path: "/api/v1/docker/compose/recreate", operation: "docker.compose.recreate" },
  { method: "POST", path: "/api/v1/docker/compose/logs", operation: "docker.compose.logs" },
  { method: "POST", path: "/api/v1/docker/compose/status", operation: "docker.compose.status" },
  { method: "POST", path: "/api/v1/docker/compose/down", operation: "docker.compose.remove" },
  { method: "GET", path: "/api/v1/docker/cleanup/preview", operation: "docker.cleanup.preview" },
  { method: "POST", path: "/api/v1/docker/cleanup", operation: "docker.cleanup.run" },
]);

const DOCKER_ROUTE_ALIASES = Object.freeze([
  { method: "GET", path: "/api/v1/docker/image", target: "/api/v1/docker/images" },
  { method: "GET", path: "/api/v1/docker/image/:image", target: "/api/v1/docker/images/:image" },
  { method: "DELETE", path: "/api/v1/docker/image/:image", target: "/api/v1/docker/images/:image" },
  { method: "POST", path: "/api/v1/docker/image/pull", target: "/api/v1/docker/images/pull" },
  { method: "POST", path: "/api/v1/docker/image/prune", target: "/api/v1/docker/images/prune" },
  { method: "GET", path: "/api/v1/docker/container/:container/inspect", target: "/api/v1/docker/containers/:container/inspect" },
  { method: "GET", path: "/api/v1/docker/container/:container/logs", target: "/api/v1/docker/containers/:container/logs" },
  { method: "GET", path: "/api/v1/docker/container/:container/stats", target: "/api/v1/docker/containers/:container/stats" },
  { method: "POST", path: "/api/v1/docker/container/:container/start", target: "/api/v1/docker/containers/:container/start" },
  { method: "POST", path: "/api/v1/docker/container/:container/stop", target: "/api/v1/docker/containers/:container/stop" },
  { method: "POST", path: "/api/v1/docker/container/:container/restart", target: "/api/v1/docker/containers/:container/restart" },
  { method: "POST", path: "/api/v1/docker/container/:container/pause", target: "/api/v1/docker/containers/:container/pause" },
  { method: "POST", path: "/api/v1/docker/container/:container/unpause", target: "/api/v1/docker/containers/:container/unpause" },
  { method: "POST", path: "/api/v1/docker/container/:container/kill", target: "/api/v1/docker/containers/:container/kill" },
  { method: "POST", path: "/api/v1/docker/container/:container/rename", target: "/api/v1/docker/containers/:container/rename" },
  { method: "POST", path: "/api/v1/docker/container/:container/exec", target: "/api/v1/docker/containers/:container/exec" },
  { method: "DELETE", path: "/api/v1/docker/container/:container", target: "/api/v1/docker/containers/:container" },
  { method: "GET", path: "/api/v1/docker/network", target: "/api/v1/docker/networks" },
  { method: "POST", path: "/api/v1/docker/network", target: "/api/v1/docker/networks" },
  { method: "GET", path: "/api/v1/docker/network/:network/inspect", target: "/api/v1/docker/networks/:network/inspect" },
  { method: "DELETE", path: "/api/v1/docker/network/:network", target: "/api/v1/docker/networks/:network" },
  { method: "POST", path: "/api/v1/docker/network/:network/connect", target: "/api/v1/docker/networks/:network/connect" },
  { method: "POST", path: "/api/v1/docker/network/:network/disconnect", target: "/api/v1/docker/networks/:network/disconnect" },
  { method: "POST", path: "/api/v1/docker/network/prune", target: "/api/v1/docker/networks/prune" },
  { method: "GET", path: "/api/v1/docker/volume", target: "/api/v1/docker/volumes" },
  { method: "GET", path: "/api/v1/docker/volume/:volume/inspect", target: "/api/v1/docker/volumes/:volume/inspect" },
  { method: "DELETE", path: "/api/v1/docker/volume/:volume", target: "/api/v1/docker/volumes/:volume" },
  { method: "POST", path: "/api/v1/docker/volume/prune", target: "/api/v1/docker/volumes/prune" },
  { method: "POST", path: "/api/v1/docker/compose/start", target: "/api/v1/docker/compose/up" },
  { method: "POST", path: "/api/v1/docker/compose/remove", target: "/api/v1/docker/compose/down" },
]);

function handleDockerCapabilities() {
  return result(200, {
    apiVersion: "v1",
    resource: "docker",
    routes: DOCKER_ROUTE_MANIFEST,
    aliases: DOCKER_ROUTE_ALIASES,
    capabilities: {
      containers: true,
      images: true,
      networks: true,
      volumes: true,
      compose: true,
      cleanup: true,
    },
  });
}

function applyDockerRouteAlias(request, url) {
  const alias = DOCKER_ROUTE_ALIASES.find((entry) => entry.method === request.method && entry.path === url.pathname);
  if (alias) {
    url.pathname = alias.target;
    return;
  }
  const dynamicPrefixes = [
    ["/api/v1/docker/container/", "/api/v1/docker/containers/"],
    ["/api/v1/docker/image/", "/api/v1/docker/images/"],
    ["/api/v1/docker/network/", "/api/v1/docker/networks/"],
    ["/api/v1/docker/volume/", "/api/v1/docker/volumes/"],
  ];
  const prefix = dynamicPrefixes.find(([source]) => url.pathname.startsWith(source));
  if (prefix) {
    url.pathname = `${prefix[1]}${url.pathname.slice(prefix[0].length)}`;
  }
}

function errorResult(error) {
  return result(error.statusCode || 500, {
    error: {
      code: error.code || "DOCKER_REQUEST_FAILED",
      message: error.message || "Docker request failed.",
    },
  });
}

async function handleDockerSnapshot() {
  return {
    statusCode: 200,
    body: await getDockerSnapshot(),
  };
}

async function handleDockerSummary() {
  return {
    statusCode: 200,
    body: await getDockerSummary(),
  };
}

async function handleDockerContainers() {
  return {
    statusCode: 200,
    body: await getDockerContainers(),
  };
}

function getContainerFromPath(pathname, suffix = "") {
  const prefix = "/api/v1/docker/containers/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  return decodeURIComponent(pathname.slice(prefix.length, suffix ? -suffix.length : undefined).replace(/\/$/, ""));
}

function getImageFromPath(pathname) {
  const prefix = "/api/v1/docker/images/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  return decodeURIComponent(pathname.slice(prefix.length).replace(/\/$/, ""));
}

function getVolumeFromPath(pathname, suffix = "") {
  const prefix = "/api/v1/docker/volumes/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  return decodeURIComponent(pathname.slice(prefix.length, suffix ? -suffix.length : undefined).replace(/\/$/, ""));
}

function getNetworkFromPath(pathname, suffix = "") {
  const prefix = "/api/v1/docker/networks/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  return decodeURIComponent(pathname.slice(prefix.length, suffix ? -suffix.length : undefined).replace(/\/$/, ""));
}

async function handleDocker(request, url) {
  try {
    applyDockerRouteAlias(request, url);
    if (request.method === "GET" && url.pathname === "/api/v1/docker/capabilities") {
      return handleDockerCapabilities();
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/snapshot") {
      return handleDockerSnapshot();
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/summary") {
      return handleDockerSummary();
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/containers") {
      return handleDockerContainers();
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/containers") {
      const payload = parseJsonBody(request);
      const job = await mintDockerJob({
        type: "docker.container.create",
        target: { containerId: String(payload?.name || "").trim() || null },
        idempotencyKey: payload?.idempotencyKey,
        jobTimeoutMs: payload?.jobTimeoutMs,
        cancellationSupported: false,
        run: () => createContainer(stripJobOptions(payload)),
      });
      return result(201, attachJob(job.result, job.job));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/images/pull") {
      const body = parseJsonBody(request);
      const job = await mintDockerJob({
        type: "docker.image.pull",
        target: { imageId: body?.image },
        idempotencyKey: body?.idempotencyKey,
        jobTimeoutMs: body?.jobTimeoutMs,
        run: () => pullImage(body?.image),
      });
      return result(200, attachJob(job.result, job.job));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/images/prune") {
      return result(200, await pruneImages());
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/images") {
      return result(200, await listImages());
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/compose/projects") {
      return result(200, await listComposeProjects());
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/config") {
      return result(200, await validateComposeConfig(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/up") {
      return result(200, await startComposeProject(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/stop") {
      return result(200, await stopComposeProject(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/restart") {
      return result(200, await restartComposeProject(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/pull") {
      return result(200, await pullComposeProject(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/build") {
      return result(200, await buildComposeProject(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/recreate") {
      return result(200, await recreateComposeProject(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/logs") {
      return result(200, await getComposeLogs(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/status") {
      return result(200, await getComposeStatus(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/compose/down") {
      return result(200, await removeComposeProject(parseJsonBody(request)));
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/cleanup/preview") {
      return result(200, await getCleanupPreview());
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/cleanup") {
      return result(200, await runCleanup(parseJsonBody(request)));
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/networks") {
      return result(200, await listNetworks());
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/networks") {
      return result(201, await createNetwork(parseJsonBody(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/networks/prune") {
      return result(200, await pruneNetworks());
    }
    if (request.method === "GET" && url.pathname === "/api/v1/docker/volumes") {
      return result(200, await listVolumes());
    }
    if (request.method === "POST" && url.pathname === "/api/v1/docker/volumes/prune") {
      return result(200, await pruneVolumes());
    }
    const imageId = getImageFromPath(url.pathname);
    if (request.method === "GET" && imageId) {
      return result(200, await inspectImage(imageId));
    }
    if (request.method === "DELETE" && imageId) {
      return result(200, await removeImage(imageId));
    }
    const volumeInspect = getVolumeFromPath(url.pathname, "/inspect");
    if (request.method === "GET" && volumeInspect) {
      return result(200, await inspectVolume(volumeInspect));
    }
    const volumeId = getVolumeFromPath(url.pathname);
    if (request.method === "DELETE" && volumeId) {
      return result(200, await removeVolume(volumeId));
    }
    const networkInspect = getNetworkFromPath(url.pathname, "/inspect");
    if (request.method === "GET" && networkInspect) {
      return result(200, await inspectNetwork(networkInspect));
    }
    const networkConnect = getNetworkFromPath(url.pathname, "/connect");
    if (request.method === "POST" && networkConnect) {
      return result(200, await connectNetwork(networkConnect, parseJsonBody(request).container));
    }
    const networkDisconnect = getNetworkFromPath(url.pathname, "/disconnect");
    if (request.method === "POST" && networkDisconnect) {
      return result(200, await disconnectNetwork(networkDisconnect, parseJsonBody(request).container));
    }
    const networkId = getNetworkFromPath(url.pathname);
    if (request.method === "DELETE" && networkId) {
      return result(200, await removeNetwork(networkId));
    }
    const inspectId = getContainerFromPath(url.pathname, "/inspect");
    if (request.method === "GET" && inspectId) {
      return result(200, await inspectContainer(inspectId));
    }
    const logsId = getContainerFromPath(url.pathname, "/logs");
    if (request.method === "GET" && logsId) {
      return result(200, await getContainerLogs(logsId, { tail: url.searchParams.get("tail"), timestamps: url.searchParams.get("timestamps") }));
    }
    const statsId = getContainerFromPath(url.pathname, "/stats");
    if (request.method === "GET" && statsId) {
      return result(200, await getContainerStats(statsId));
    }
    const startId = getContainerFromPath(url.pathname, "/start");
    if (request.method === "POST" && startId) {
      const job = await mintDockerJob({
        type: "docker.container.start",
        target: { containerId: startId },
        run: () => startContainer(startId),
      });
      return result(200, attachJob(job.result, job.job));
    }
    const stopId = getContainerFromPath(url.pathname, "/stop");
    if (request.method === "POST" && stopId) {
      const job = await mintDockerJob({
        type: "docker.container.stop",
        target: { containerId: stopId },
        run: () => stopContainer(stopId),
      });
      return result(200, attachJob(job.result, job.job));
    }
    const restartId = getContainerFromPath(url.pathname, "/restart");
    if (request.method === "POST" && restartId) {
      const job = await mintDockerJob({
        type: "docker.container.restart",
        target: { containerId: restartId },
        run: () => restartContainer(restartId),
      });
      return result(200, attachJob(job.result, job.job));
    }
    const pauseId = getContainerFromPath(url.pathname, "/pause");
    if (request.method === "POST" && pauseId) {
      return result(200, await pauseContainer(pauseId));
    }
    const unpauseId = getContainerFromPath(url.pathname, "/unpause");
    if (request.method === "POST" && unpauseId) {
      return result(200, await unpauseContainer(unpauseId));
    }
    const killId = getContainerFromPath(url.pathname, "/kill");
    if (request.method === "POST" && killId) {
      return result(200, await killContainer(killId));
    }
    const renameId = getContainerFromPath(url.pathname, "/rename");
    if (request.method === "POST" && renameId) {
      return result(200, await renameContainer(renameId, parseJsonBody(request).name));
    }
    const execId = getContainerFromPath(url.pathname, "/exec");
    if (request.method === "POST" && execId) {
      return result(200, await execContainer(execId, parseJsonBody(request)));
    }
    const deleteId = getContainerFromPath(url.pathname);
    if (request.method === "DELETE" && deleteId) {
      const job = await mintDockerJob({
        type: "docker.container.delete",
        target: { containerId: deleteId },
        run: () => deleteContainer(deleteId),
      });
      return result(200, attachJob(job.result, job.job));
    }
    return result(404, { error: { code: "NOT_FOUND", message: "Request failed." } });
  } catch (error) {
    return errorResult(error);
  }
}

module.exports = {
  DOCKER_ROUTE_ALIASES,
  DOCKER_ROUTE_MANIFEST,
  handleDocker,
  handleDockerCapabilities,
  handleDockerContainers,
  handleDockerSnapshot,
  handleDockerSummary,
};
