const dockerService = require("../src/services/dockerService");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

function runNormalizationChecks() {
  assert.deepStrictEqual(
    dockerService.buildDockerCapabilityState({ installed: true, daemonRunning: false, errorCode: "DOCKER_PERMISSION_DENIED", version: "27.0.0" }),
    {
      supported: true,
      installed: true,
      configured: true,
      running: false,
      reachable: false,
      authorized: false,
      compatible: true,
      repairGuidance: "Grant the Agent service account access to Docker, then restart the Agent and refresh status.",
    },
    "Docker capability state must distinguish installation, daemon reachability, and authorization.",
  );
  const container = dockerService.normalizeContainer({
    ID: "abc123",
    Names: "lavalink",
    Image: "fredboat/lavalink",
    Status: "Up 2 hours",
    State: "running",
    Ports: "0.0.0.0:2333->2333/tcp, :::2333->2333/tcp",
  });
  const stats = dockerService.normalizeStats({
    ID: "abc123",
    Name: "lavalink",
    CPUPerc: "1.80%",
    MemUsage: "410MiB / 1GiB",
    MemPerc: "40.04%",
    NetIO: "12kB / 3kB",
  });
  const [attached] = dockerService.attachStats([container], [stats]);

  assert.deepStrictEqual(container.ports, ["2333/tcp"], "Port mappings should be normalized and deduplicated.");
  assert.strictEqual(attached.stats.cpuPercent, "1.80%", "CPU percent should survive service normalization.");
  assert.strictEqual(attached.stats.memoryUsage, "410MiB", "Memory usage should survive service normalization.");
  assert.strictEqual(attached.stats.memoryLimit, "1GiB", "Memory limit should survive service normalization.");
  assert.strictEqual(attached.stats.memoryPercent, "40.04%", "Memory percent should survive service normalization.");

  const liveBot = dockerService.normalizeContainer({
    ID: "bot123",
    Names: "/discord-bot",
    Image: "discord-bot-clean-discord-bot",
    Status: "Up 4 days (healthy)",
    State: "running",
    Ports: "",
    RunningFor: "4 days ago",
  });
  const [botWithStats] = dockerService.attachStats([liveBot], [dockerService.normalizeStats({
    ID: "bot123",
    Name: "discord-bot",
    CPUPerc: "0.02%",
    MemUsage: "90.95MiB / 15.37GiB",
  })]);
  assert.strictEqual(botWithStats.name, "discord-bot", "Live Discord bot container names should be normalized.");
  assert.strictEqual(botWithStats.state, "running", "Live Discord bot running state should be preserved.");
  assert.strictEqual(botWithStats.stats.cpuPercent, "0.02%", "Live Discord bot CPU stats should attach by name or ID.");

  const masked = dockerService.maskEnv(["MYSQL_PASSWORD=secret", "VISIBLE=value"]);
  assert.deepStrictEqual(masked, ["MYSQL_PASSWORD=[REDACTED]", "VISIBLE=value"], "Sensitive Docker environment values should be masked.");
}

function dockerRouteToRegex(routePath) {
  const escaped = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:container|:image|:network|:volume/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

function materializeDockerRoute(routePath) {
  return routePath
    .replace(":container", "container123")
    .replace(":image", "image123")
    .replace(":network", "network123")
    .replace(":volume", "volume123");
}

function bodyForDockerRoute(route) {
  if (route.method !== "POST") return "";
  if (route.path === "/api/v1/docker/containers") return JSON.stringify({ name: "smoke", image: "alpine:latest" });
  if (route.path === "/api/v1/docker/images/pull") return JSON.stringify({ image: "alpine:latest" });
  if (route.path.endsWith("/rename")) return JSON.stringify({ name: "renamed-smoke" });
  if (route.path.endsWith("/exec")) return JSON.stringify({ command: "true" });
  if (route.path.endsWith("/connect") || route.path.endsWith("/disconnect")) return JSON.stringify({ container: "container123" });
  if (route.path.startsWith("/api/v1/docker/compose/")) return JSON.stringify({ projectName: "smoke", projectDirectory: "/tmp/smoke" });
  if (route.path === "/api/v1/docker/cleanup") return JSON.stringify({ kind: "images" });
  if (route.path === "/api/v1/docker/networks") return JSON.stringify({ name: "smoke-net" });
  return "{}";
}

async function runAgentDockerRouteChecks() {
  const dockerServicePath = require.resolve("../agent/src/services/dockerService");
  const ok = (value = {}) => Promise.resolve(value);
  const fakeDockerService = {
    createContainer: () => ok({ id: "container123" }),
    createNetwork: () => ok({ id: "network123" }),
    deleteContainer: () => ok({ removed: true }),
    execContainer: () => ok({ output: "" }),
    getCleanupPreview: () => ok({ reclaimableBytes: 0 }),
    getComposeLogs: () => ok({ logs: "" }),
    getComposeStatus: () => ok({ status: "ok" }),
    getContainerLogs: () => ok({ logs: "" }),
    getContainerStats: () => ok({ stats: {} }),
    getDockerContainers: () => ok({ containers: [] }),
    getDockerSnapshot: () => ok({ installed: true, daemonRunning: true, containers: [] }),
    getDockerSummary: () => ok({ installed: true, daemonRunning: true }),
    inspectImage: () => ok({ image: "image123" }),
    inspectContainer: () => ok({ container: "container123" }),
    inspectNetwork: () => ok({ network: "network123" }),
    inspectVolume: () => ok({ volume: "volume123" }),
    killContainer: () => ok({ killed: true }),
    listImages: () => ok({ images: [] }),
    listComposeProjects: () => ok({ projects: [] }),
    listNetworks: () => ok({ networks: [] }),
    listVolumes: () => ok({ volumes: [] }),
    pauseContainer: () => ok({ paused: true }),
    pullImage: () => ok({ image: "alpine:latest" }),
    pruneImages: () => ok({ output: "" }),
    pruneNetworks: () => ok({ output: "" }),
    pruneVolumes: () => ok({ output: "" }),
    recreateComposeProject: () => ok({ output: "" }),
    removeImage: () => ok({ removed: true }),
    removeComposeProject: () => ok({ output: "" }),
    removeNetwork: () => ok({ removed: true }),
    removeVolume: () => ok({ removed: true }),
    renameContainer: () => ok({ renamed: true }),
    restartContainer: () => ok({ restarted: true }),
    restartComposeProject: () => ok({ output: "" }),
    runCleanup: () => ok({ output: "" }),
    startContainer: () => ok({ started: true }),
    startComposeProject: () => ok({ output: "" }),
    stopContainer: () => ok({ stopped: true }),
    stopComposeProject: () => ok({ output: "" }),
    pullComposeProject: () => ok({ output: "" }),
    buildComposeProject: () => ok({ output: "" }),
    validateComposeConfig: () => ok({ valid: true }),
    connectNetwork: () => ok({ connected: true }),
    disconnectNetwork: () => ok({ disconnected: true }),
    unpauseContainer: () => ok({ unpaused: true }),
  };
  require.cache[dockerServicePath] = {
    id: dockerServicePath,
    filename: dockerServicePath,
    loaded: true,
    exports: fakeDockerService,
  };
  const dockerRoutes = require("../agent/src/routes/docker");
  const manifest = dockerRoutes.DOCKER_ROUTE_MANIFEST;
  const aliases = dockerRoutes.DOCKER_ROUTE_ALIASES;
  assert(Array.isArray(manifest) && manifest.length > 20, "Agent Docker route manifest should list all supported endpoint families.");
  assert(manifest.some((route) => route.path === "/api/v1/docker/images" && route.method === "GET"), "Agent manifest must include Docker image listing.");
  assert(manifest.some((route) => route.path === "/api/v1/docker/capabilities" && route.method === "GET"), "Agent manifest must include Docker capabilities.");

  for (const route of manifest) {
    const response = await dockerRoutes.handleDocker({
      method: route.method,
      body: bodyForDockerRoute(route),
    }, new URL(`http://agent.local${materializeDockerRoute(route.path)}`));
    assert.notStrictEqual(response.statusCode, 404, `${route.method} ${route.path} should be registered by the Agent Docker router.`);
  }

  for (const alias of aliases) {
    const response = await dockerRoutes.handleDocker({
      method: alias.method,
      body: bodyForDockerRoute(alias),
    }, new URL(`http://agent.local${materializeDockerRoute(alias.path)}`));
    assert.notStrictEqual(response.statusCode, 404, `${alias.method} ${alias.path} should be a Docker compatibility alias.`);
  }

  const agentClientSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "agentClient.js"), "utf8");
  const desktopDockerPaths = Array.from(agentClientSource.matchAll(/[`"]((?:\/api\/v1\/docker\/)[^`"]+)/g))
    .map((match) => match[1].split("?")[0].replace(/\$\{[^}]+\}/g, "dynamic"));
  const registered = [...manifest.map((route) => route.path), ...aliases.map((route) => route.path)].map(dockerRouteToRegex);
  desktopDockerPaths.forEach((desktopPath) => {
    if (desktopPath === "/api/v1/docker/compose/dynamic") return;
    assert(registered.some((pattern) => pattern.test(desktopPath)), `Desktop Docker path is not registered by Agent manifest: ${desktopPath}`);
  });
  ["config", "up", "stop", "restart", "pull", "build", "recreate", "logs", "status", "down"].forEach((action) => {
    assert(manifest.some((route) => route.method === "POST" && route.path === `/api/v1/docker/compose/${action}`), `Desktop Compose action is not registered by Agent manifest: ${action}`);
  });
}

async function main() {
  runNormalizationChecks();
  await runAgentDockerRouteChecks();
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const styleSource = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  const dockerIpcSource = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "dockerIpc.js"), "utf8");
  const serviceRouterSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "serviceRouter.js"), "utf8");
  const dockerServiceSource = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "dockerService.js"), "utf8");
  const agentServerSource = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "server.js"), "utf8");
  const agentDockerRouteSource = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "routes", "docker.js"), "utf8");
  [
    "function getDockerWorkspaceState",
    "function getDockerFastFailure",
    "DOCKER_REQUEST_TIMEOUT",
    "dockerRequestSerial",
    "withTimeout(",
    "data-docker-recovery-action",
    "updateDockerInspectorTabs(false)",
    "document.hidden || !dockerWorkspaceState?.ready",
    "logDockerDiagnostic(\"snapshot-success\"",
    "createSecurityConfirmation({ title: \"Remove Docker image?\"",
    "createSecurityConfirmation({ title: \"Remove Docker volume?\"",
    "function runDockerComposeUiAction",
    "function runDockerCleanupAction",
    "function focusDockerCreateForm",
  ].forEach((needle) => assert(appSource.includes(needle), `Docker workspace regression guard missing: ${needle}`));
  [
    "data-docker-compose-action=\"config\"",
    "data-docker-cleanup=\"volumes\"",
    "data-docker-create=\"privileged\"",
    "data-docker-logs-timestamps",
  ].forEach((needle) => assert(indexSource.includes(needle), `Docker workspace markup guard missing: ${needle}`));
  const fastFailureBody = appSource.match(/function getDockerFastFailure\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert(!fastFailureBody.includes("getCurrentAgentHealthTarget") && !fastFailureBody.includes("getNodeVisualState"), "Docker refresh must not be blocked by stale Agent Control or node visual state.");
  const createActionBody = appSource.match(/async function handleDockerAction\(actionName\) \{[\s\S]*?\n  const definition = getDockerActionDefinition/)?.[0] || "";
  assert(createActionBody.includes("focusDockerCreateForm") && createActionBody.includes("Create Container form"), "Docker create action should route users to the in-page form.");
  assert(!/window\.prompt|prompt\(|window\.confirm|confirm\(/.test(createActionBody), "Docker create action must not use browser dialogs.");
  assert(dockerIpcSource.includes("DOCKER_REQUEST_FAILED") && dockerIpcSource.includes("docker:getSnapshot") && dockerIpcSource.includes('getDockerSnapshot(requireDockerRead(payload, "snapshot"))'), "Docker IPC must preserve coded snapshot errors and authorize node-context reads.");
  [
    "docker:pause",
    "docker:kill",
    "docker:pullImage",
    "docker:compose",
    "docker:cleanup",
    "docker:removeVolume",
  ].forEach((needle) => assert(dockerIpcSource.includes(needle), `Docker IPC route missing: ${needle}`));
  assert(serviceRouterSource.includes("agent-snapshot-failed") && !serviceRouterSource.includes("throw new AgentUnavailableError();\n  }\n}\n\nfunction createDockerUnavailableSnapshot"), "Remote Docker failures must not be flattened into generic Agent unavailable.");
  assert(serviceRouterSource.includes("routeDockerOperation") && serviceRouterSource.includes("dockerComposeAction"), "Docker router must route extended Docker operations through the selected node.");
  assert(serviceRouterSource.includes("getDockerCapabilities") && serviceRouterSource.includes("agentDockerCapabilities"), "Remote Docker snapshots should include Agent Docker capability diagnostics when available.");
  assert(agentServerSource.includes('pathname === "/api/v1/docker" || pathname.startsWith("/api/v1/docker/")'), "Agent server must route all Docker endpoint families, not only containers.");
  assert(agentDockerRouteSource.includes("DOCKER_ROUTE_MANIFEST") && agentDockerRouteSource.includes("handleDockerCapabilities"), "Agent Docker router must expose a capability manifest.");
  assert(dockerServiceSource.includes("DOCKER_SOCKET_PERMISSION_DENIED") && dockerServiceSource.includes("DOCKER_SOCKET_UNAVAILABLE") && dockerServiceSource.includes("DOCKER_SERVICE_UNREACHABLE"), "Docker service must classify socket and service failures explicitly.");
  [
    "listComposeProjects",
    "validateComposeConfig",
    "DOCKER_VOLUME_IN_USE",
    "DOCKER_DEFAULT_NETWORK_PROTECTED",
    "redactDockerText",
    "getCleanupPreview",
    "execContainer",
  ].forEach((needle) => assert(dockerServiceSource.includes(needle), `Docker service guard missing: ${needle}`));
  assert(styleSource.includes(".docker-empty-actions"), "Docker empty state actions must have stable layout.");
  assert(styleSource.includes(".docker-resource-grid") && styleSource.includes(".docker-warning"), "Docker resource panels must have stable styling.");
  assert(indexSource.includes("docker-check-option") && styleSource.includes(".docker-check-option input[type=\"checkbox\"]"), "Docker create checkboxes must use compact scoped controls.");
  assert(styleSource.includes(".docker-create-grid input:not([type=\"checkbox\"])"), "Docker text-field styling must not enlarge create-container checkboxes.");
  assert(styleSource.includes(".docker-resource-panel--cleanup .docker-actions") && styleSource.includes("justify-content: flex-start"), "Docker cleanup actions must stay close to their section copy.");

  const snapshot = await dockerService.getDockerSnapshot();

  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Docker snapshot did not return an object.");
  }

  if (typeof snapshot.installed !== "boolean" || typeof snapshot.daemonRunning !== "boolean") {
    throw new Error("Docker snapshot is missing availability flags.");
  }

  if (!Array.isArray(snapshot.containers)) {
    throw new Error("Docker snapshot is missing a containers array.");
  }

  if (!snapshot.installed || !snapshot.daemonRunning) {
    if (!snapshot.message || !/docker/i.test(snapshot.message)) {
      throw new Error("Docker unavailable fallback did not include a friendly message.");
    }
    console.log(`Docker fallback OK: ${snapshot.message}`);
    return;
  }

  const [containers, images, networks, volumes] = await Promise.all([
    dockerService.getDockerContainers(),
    dockerService.listImages(),
    dockerService.listNetworks(),
    dockerService.listVolumes(),
  ]);

  if (!Array.isArray(containers.containers)) {
    throw new Error("Docker container list did not return an array.");
  }
  if (!Array.isArray(images.images)) {
    throw new Error("Docker image list did not return an array.");
  }
  if (!Array.isArray(networks.networks)) {
    throw new Error("Docker network list did not return an array.");
  }
  if (!Array.isArray(volumes.volumes)) {
    throw new Error("Docker volume list did not return an array.");
  }

  console.log(`Docker API OK: ${containers.containers.length} containers, ${images.images.length} images.`);
}

main().catch((error) => {
  const code = error?.code || "";
  if (/DOCKER_NOT_INSTALLED|DOCKER_PERMISSION_DENIED|DOCKER_DAEMON_UNAVAILABLE/.test(code)) {
    console.log(`Docker fallback OK: ${error.message}`);
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
