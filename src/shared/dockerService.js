const { execFile } = require("child_process");
const dgram = require("dgram");
const net = require("net");
const fs = require("fs/promises");
const path = require("path");
const longOperations = require("./longOperationService");
const {
  assertCleanupSelection,
  detectHostPortConflicts,
  normalizeHostPorts,
  policeComposeYaml,
  policeContainerRequest,
  validateResourceLimits,
} = require("./dockerPolicy");

const COMPOSE_FILE_CANDIDATES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

const COMMAND_TIMEOUT_MS = 8000;
const CONTAINER_CREATE_TIMEOUT_MS = 60000;
const LOG_TIMEOUT_MS = 12000;
const SNAPSHOT_OPTIONAL_TIMEOUT_MS = 2500;
const CONTAINER_TARGET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const IMAGE_TARGET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/;
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const NETWORK_TARGET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const VOLUME_TARGET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
const COMPOSE_PROJECT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_PATH_PATTERN = /^[^\0\r\n]+$/;
const SECRET_KEY_PATTERN = /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)/i;

class DockerServiceError extends Error {
  constructor(message, code = "DOCKER_COMMAND_FAILED", statusCode = 502, detail = null) {
    super(message);
    this.name = "DockerServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        errorCode: error?.code || error?.name || null,
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout: stdout ? stdout.trim() : "",
        stderr: stderr ? stderr.trim() : "",
        resolvedExecutablePath: command,
      });
    });
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getPathCandidates(executableName) {
  return (process.env.PATH || "")
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((dir) => path.join(dir, executableName));
}

function getWindowsDockerCandidates() {
  return unique([
    ...getPathCandidates("docker.exe"),
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
  ]);
}

async function resolveDockerExecutable() {
  const checks = [];

  if (process.platform === "win32") {
    for (const candidate of getWindowsDockerCandidates()) {
      const found = await pathExists(candidate);
      checks.push({ path: candidate, found });
      if (found) {
        return { executablePath: candidate, found: true, checks };
      }
    }
    return { executablePath: "docker", found: true, checks };
  }

  const candidates = unique([
    process.env.DOCKER_BINARY,
    ...getPathCandidates("docker"),
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    "/bin/docker",
    "/snap/bin/docker",
  ]);

  for (const candidate of candidates) {
    const found = await pathExists(candidate);
    checks.push({ path: candidate, found });
    if (found) {
      return { executablePath: candidate, found: true, checks };
    }
  }

  return { executablePath: "docker", found: false, checks };
}

function parseDockerVersion(output) {
  const match = String(output || "").match(/Docker version\s+([^,\s]+)/i);
  return match?.[1] || null;
}

function parseComposeVersion(output) {
  const text = String(output || "").trim();
  return text.match(/(?:Docker\s+)?Compose\s+version\s+v?([^\s,]+)/i)?.[1] || text.match(/\bv?(\d+\.\d+\.\d+[^\s,]*)/)?.[1] || null;
}

function classifyDockerFailure(result) {
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  const errorCode = String(result?.errorCode || "");

  // Only a missing docker binary is "not installed": the spawn fails with
  // ENOENT, or a shell says docker itself was not found. Matching any "no such
  // file" or "command not found" text also caught the container's own errors
  // (a missing path in a terminal command, a missing entrypoint on Start).
  if (/ENOENT/i.test(errorCode) || /\bdocker(?:\.exe)?: (?:command )?not found|'docker(?:\.exe)?' is not recognized/i.test(output)) {
    return new DockerServiceError("Docker is not installed or is not available on PATH for this node.", "DOCKER_NOT_INSTALLED", 503, output.trim() || null);
  }

  // A permission problem counts only when it is about Docker itself (its
  // socket, pipe or daemon), not a container command that hit a protected file.
  const dockerScoped = /docker|daemon|\/\/\.\/pipe\//i.test(output);
  if (/got permission denied/i.test(output) || (dockerScoped && /permission denied|access is denied|requires elevated privileges|connect: operation not permitted/i.test(output))) {
    const socketRelated = /docker\.sock|\/\/\.\/pipe\/docker|docker_engine|daemon socket|var\/run\/docker/i.test(output);
    return new DockerServiceError(
      socketRelated
        ? "Docker is running, but the Agent process cannot access the Docker socket."
        : "Docker is installed, but this user does not have permission to access it.",
      socketRelated ? "DOCKER_SOCKET_PERMISSION_DENIED" : "DOCKER_PERMISSION_DENIED",
      403,
      output.trim() || null,
    );
  }

  // Docker Desktop stopped on Windows: its engine pipe does not exist. The CLI
  // says "failed to connect to the docker API at npipe:////./pipe/
  // dockerDesktopLinuxEngine ... cannot find the file specified", which the
  // socket rule below misreported as the Agent being unable to reach the socket.
  if (/pipe\/dockerDesktop[A-Za-z]*Engine/i.test(output) && /cannot find the file specified|no such file|does not exist/i.test(output)) {
    return new DockerServiceError("Docker Desktop isn't running on this computer. Start Docker Desktop, then refresh.", "DOCKER_SERVICE_UNREACHABLE", 503, output.trim() || null);
  }

  if (/cannot connect|is the docker daemon running|error during connect|docker daemon is not running|open \/\/\.\/pipe\/docker|Cannot connect to the Docker daemon/i.test(output)) {
    const socketUnavailable = /docker\.sock|\/\/\.\/pipe\/docker|docker_engine|var\/run\/docker/i.test(output);
    return new DockerServiceError(
      socketUnavailable
        ? "Docker is installed, but the Agent process cannot reach the Docker socket."
        : "Docker is installed, but the Docker daemon is not running or is unavailable on this node.",
      socketUnavailable ? "DOCKER_SOCKET_UNAVAILABLE" : "DOCKER_SERVICE_UNREACHABLE",
      503,
      output.trim() || null,
    );
  }

  return new DockerServiceError(describeDockerCommandFailure(output), "DOCKER_COMMAND_FAILED", 502, output.trim() || null);
}

// The daemon's own reason (a port already allocated, a name already in use) is
// what the user needs; "Docker command failed." alone left them guessing.
function describeDockerCommandFailure(output) {
  // `docker inspect` of something that does not exist prints "[]" before its
  // error, so the first line alone read "Docker command failed: []".
  const line = redactDockerText(output).split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry && entry !== "[]");
  if (!line) return "Docker command failed.";
  const reason = line.replace(/^Error response from daemon:\s*/i, "").replace(/^Error:\s*/i, "");
  return `Docker command failed: ${reason.length > 300 ? `${reason.slice(0, 297)}...` : reason}`;
}

function inferState(status) {
  if (/^up\b|running/i.test(status || "")) {
    return "running";
  }
  if (/created/i.test(status || "")) {
    return "created";
  }
  if (/exited|dead|paused|restarting|removing|stopped/i.test(status || "")) {
    return "stopped";
  }
  return status || null;
}

function normalizeName(value) {
  if (Array.isArray(value)) {
    return normalizeName(value[0]);
  }
  return typeof value === "string" ? value.replace(/^\/+/, "").trim() : "";
}

function cleanPortProtocol(value) {
  const protocol = String(value || "tcp").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return protocol || "tcp";
}

function cleanPortNumber(value) {
  const port = Number.parseInt(String(value || "").trim(), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : null;
}

function normalizePortEntry(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    const publicPort = cleanPortNumber(value.PublicPort || value.publicPort);
    const privatePort = cleanPortNumber(value.PrivatePort || value.privatePort);
    const type = cleanPortProtocol(value.Type || value.type);
    const port = publicPort || privatePort;
    return port ? `${port}/${type}` : null;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  const arrowMatch = raw.match(/(?:^|:)(\d{1,5})->\d{1,5}\/([a-z0-9]+)/i);
  if (arrowMatch) {
    const port = cleanPortNumber(arrowMatch[1]);
    return port ? `${port}/${cleanPortProtocol(arrowMatch[2])}` : null;
  }

  const exposedMatch = raw.match(/(?:^|,|\s)(\d{1,5})\/([a-z0-9]+)/i);
  if (exposedMatch) {
    const port = cleanPortNumber(exposedMatch[1]);
    return port ? `${port}/${cleanPortProtocol(exposedMatch[2])}` : null;
  }

  return null;
}

function normalizePortBindings(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  return unique(entries.map(normalizePortEntry)).filter(Boolean);
}

function parseJsonLines(output, normalizer) {
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return normalizer(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function shortContainerId(value) {
  const id = value ? String(value) : null;
  return id && /^[0-9a-f]{64}$/i.test(id) ? id.slice(0, 12) : id;
}

// Labels a container list may carry to the Desktop. Label values can hold
// anything a compose file or image author put there (including secrets), so
// only AnxOS's own labels and Compose's project/service names are kept.
const LISTED_LABEL_KEYS = new Set([
  "anxos.managed",
  "anxos.template",
  "anxos.instance",
  "com.docker.compose.project",
  "com.docker.compose.service",
  "com.docker.compose.depends_on",
]);

// `docker ps --format json` gives labels as "k=v,k2=v2" (an object from the
// Engine API); values containing commas are cut, which is acceptable for the
// short names kept here.
function normalizeListedLabels(value) {
  const labels = {};
  const entries = value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : String(value || "").split(",").map((pair) => {
      const index = pair.indexOf("=");
      return index > 0 ? [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] : null;
    }).filter(Boolean);
  for (const [key, raw] of entries) {
    if (!LISTED_LABEL_KEYS.has(key)) continue;
    labels[key] = String(raw ?? "").slice(0, 200);
  }
  return labels;
}

// Names only (volume names or host paths as docker ps shortens them).
function normalizeNameList(value) {
  return unique(String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean)).slice(0, 20);
}

function normalizeContainer(container) {
  const status = container.Status || container.State || null;
  const rawPorts = container.Ports || null;
  const health = String(status || "").match(/\((healthy|unhealthy|starting)\)/i)?.[1] || container.Health || null;
  return {
    labels: normalizeListedLabels(container.Labels),
    mounts: normalizeNameList(container.Mounts),
    networks: normalizeNameList(container.Networks),
    id: shortContainerId(container.ID || container.Id || null),
    name: normalizeName(container.Names || container.Name) || null,
    image: container.Image || null,
    command: container.Command || null,
    createdAt: container.CreatedAt || container.Created || null,
    status,
    health,
    state: container.State || inferState(status),
    ports: normalizePortBindings(rawPorts),
    rawPorts,
    runningFor: container.RunningFor || status,
    restartPolicy: container.RestartPolicy || null,
    stats: null,
  };
}

function normalizeImage(image) {
  return {
    id: image.ID || image.Id || null,
    repository: image.Repository || null,
    tag: image.Tag || null,
    digest: image.Digest || null,
    createdAt: image.CreatedAt || image.CreatedSince || null,
    size: image.Size || null,
  };
}

function normalizeNetwork(network) {
  return {
    id: network.ID || network.Id || null,
    name: network.Name || null,
    driver: network.Driver || null,
    scope: network.Scope || null,
    ipv6: network.IPv6 || null,
    internal: network.Internal || null,
  };
}

function normalizeVolume(volume) {
  return {
    name: volume.Name || null,
    driver: volume.Driver || null,
    mountpoint: volume.Mountpoint || null,
    scope: volume.Scope || null,
    size: volume.Size || null,
  };
}

function redactDockerText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/([A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,]+)/gi, "$1[REDACTED]"))
    .join("\n");
}

function maskEnv(env = []) {
  return (Array.isArray(env) ? env : []).map((entry) => {
    const text = String(entry || "");
    const index = text.indexOf("=");
    const key = index >= 0 ? text.slice(0, index) : text;
    if (SECRET_KEY_PATTERN.test(key)) {
      return `${key}=[REDACTED]`;
    }
    return text;
  });
}

function parseMemoryUsage(value) {
  if (!value || typeof value !== "string") {
    return { usage: null, limit: null, raw: null };
  }
  const [usage, limit] = value.split(/\s*\/\s*/);
  return { usage: usage || null, limit: limit || null, raw: value };
}

function parseNetworkIo(value) {
  if (!value || typeof value !== "string") {
    return { rx: null, tx: null, raw: null };
  }
  const [rx, tx] = value.split(/\s*\/\s*/);
  return { rx: rx || null, tx: tx || null, raw: value };
}

function normalizeStats(stats) {
  const memory = parseMemoryUsage(stats.MemUsage ?? stats.MemUsageRaw ?? stats.memoryRaw ?? stats.memoryUsageRaw);
  const network = parseNetworkIo(stats.NetIO ?? stats.NetIORaw ?? stats.networkRaw);
  return {
    id: stats.ID || stats.Container || null,
    container: stats.Container || null,
    name: normalizeName(stats.Name) || null,
    cpuPercent: stats.CPUPerc ?? stats.CPUPercRaw ?? stats.CPUPercent ?? stats.cpuPercent ?? null,
    memoryUsage: memory.usage,
    memoryLimit: memory.limit,
    memoryRaw: memory.raw,
    memoryPercent: stats.MemPerc ?? stats.MemPercRaw ?? stats.MemoryPercent ?? stats.memoryPercent ?? null,
    networkRx: network.rx,
    networkTx: network.tx,
    networkRaw: network.raw,
    blockIo: stats.BlockIO || null,
    pids: stats.PIDs || null,
  };
}

function parseStatsTable(output) {
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s{2,}/);
      if (parts.length < 4) {
        return null;
      }
      return normalizeStats({
        ID: parts[0],
        Name: parts[1],
        CPUPerc: parts[2],
        MemUsage: parts[3],
        MemPerc: parts[4] || null,
        NetIO: parts[5] || null,
      });
    })
    .filter(Boolean);
}

function isMatchingId(left, right) {
  if (!left || !right) {
    return false;
  }
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function attachStats(containers, statsList) {
  return containers.map((container) => {
    const byName = statsList.find((stats) => stats.name && container.name && stats.name.toLowerCase() === container.name.toLowerCase());
    const byId = byName || statsList.find((stats) => isMatchingId(container.id, stats.id) || isMatchingId(container.id, stats.container));
    return { ...container, stats: byName || byId || null };
  });
}

function validateContainerTarget(value) {
  const target = String(value || "").trim();
  if (!CONTAINER_TARGET_PATTERN.test(target)) {
    throw new DockerServiceError("Invalid container target.", "INVALID_CONTAINER_TARGET", 400);
  }
  return target;
}

function validateImageTarget(value) {
  const target = String(value || "").trim();
  if (!IMAGE_TARGET_PATTERN.test(target) || /[;&|`$<>\\\0]/.test(target)) {
    throw new DockerServiceError("Invalid Docker image target.", "INVALID_IMAGE_TARGET", 400);
  }
  return target;
}

function validateImage(value) {
  const image = String(value || "").trim();
  if (!image || image.includes("\0") || /[;&|`$<>\\]/.test(image) || image.length > 256) {
    throw new DockerServiceError("Invalid Docker image.", "INVALID_DOCKER_IMAGE", 400);
  }
  return image;
}

function validateName(value, label = "Docker name") {
  const target = String(value || "").trim();
  if (!NAME_PATTERN.test(target)) {
    throw new DockerServiceError(`Invalid ${label}.`, "INVALID_DOCKER_NAME", 400);
  }
  return target;
}

function validateNetworkTarget(value) {
  const target = String(value || "").trim();
  if (!NETWORK_TARGET_PATTERN.test(target)) {
    throw new DockerServiceError("Invalid Docker network target.", "INVALID_NETWORK_TARGET", 400);
  }
  return target;
}

function validateVolumeTarget(value) {
  const target = String(value || "").trim();
  if (!VOLUME_TARGET_PATTERN.test(target)) {
    throw new DockerServiceError("Invalid Docker volume target.", "INVALID_VOLUME_TARGET", 400);
  }
  return target;
}

function validateComposeProject(value) {
  return validateName(value, "Compose project name");
}

function validateNodePath(value) {
  const text = String(value || "").trim();
  if (!text || !SAFE_PATH_PATTERN.test(text) || text.includes("..")) {
    throw new DockerServiceError("Invalid node path.", "INVALID_DOCKER_PATH", 400);
  }
  return text;
}

function normalizeKeyValueMap(value, maxItems = 128) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const entries = Array.isArray(value)
    ? value
    : Object.entries(value).map(([key, entryValue]) => `${key}=${entryValue}`);
  if (!Array.isArray(entries) || entries.length > maxItems) {
    throw new DockerServiceError("Invalid Docker key/value entries.", "INVALID_DOCKER_ARGS", 400);
  }
  return entries.map((entry) => String(entry || "").trim()).filter(Boolean).map((entry) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(=.*)?$/.test(entry) && !/^[a-zA-Z0-9_.-]+=.*/.test(entry)) {
      throw new DockerServiceError("Invalid Docker key/value entry.", "INVALID_DOCKER_ARGS", 400);
    }
    return entry;
  });
}

function normalizeStringArray(value, maxItems = 64) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DockerServiceError("Invalid Docker arguments.", "INVALID_DOCKER_ARGS", 400);
  }
  return value.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function normalizePorts(value) {
  return normalizeStringArray(value, 32).map((entry) => {
    if (!/^(?:\d{1,3}(?:\.\d{1,3}){3}:)?\d{1,5}:\d{1,5}(?:\/(?:tcp|udp))?$/i.test(entry)) {
      throw new DockerServiceError("Invalid Docker port mapping.", "INVALID_DOCKER_PORT", 400);
    }
    return entry;
  });
}

function normalizeRestartPolicy(value) {
  const policy = String(value || "unless-stopped").trim();
  return ["no", "always", "unless-stopped", "on-failure"].includes(policy) ? policy : "unless-stopped";
}

async function getDockerExecutableOrThrow() {
  const executable = await resolveDockerExecutable();
  if (!executable.found && process.platform !== "win32") {
    throw new DockerServiceError("Docker is not installed or is not available on PATH for this node.", "DOCKER_NOT_INSTALLED", 503);
  }
  return executable.executablePath;
}

async function runDockerCommandWithExecutable(dockerPath, args, options = {}) {
  const result = await exec(dockerPath, args, options);
  if (!result.ok) {
    throw classifyDockerFailure(result);
  }
  return result;
}

async function runDockerCommand(args, options = {}) {
  const dockerPath = await getDockerExecutableOrThrow();
  return runDockerCommandWithExecutable(dockerPath, args, options);
}

async function getComposeVersion(dockerPath = null) {
  const resolved = dockerPath || await getDockerExecutableOrThrow();
  const result = await exec(resolved, ["compose", "version", "--short"], { timeout: SNAPSHOT_OPTIONAL_TIMEOUT_MS });
  if (result.ok) return parseComposeVersion(result.stdout);
  const fallback = await exec(resolved, ["compose", "version"], { timeout: SNAPSHOT_OPTIONAL_TIMEOUT_MS });
  return fallback.ok ? parseComposeVersion(fallback.stdout) : null;
}

function buildDockerCapabilityState({ installed = false, daemonRunning = false, errorCode = null, version = null } = {}) {
  const permissionDenied = errorCode === "DOCKER_PERMISSION_DENIED";
  return {
    supported: true,
    installed: Boolean(installed),
    configured: Boolean(installed),
    running: Boolean(daemonRunning),
    reachable: Boolean(daemonRunning),
    authorized: daemonRunning ? true : permissionDenied ? false : null,
    compatible: installed ? Boolean(version) : null,
    repairGuidance: !installed
      ? "Install Docker on this node, then refresh Docker status."
      : permissionDenied
        ? "Grant the Agent service account access to Docker, then restart the Agent and refresh status."
        : !daemonRunning
          ? "Start the Docker daemon on this node, then refresh Docker status."
          : null,
  };
}

// SMOOTH-3002: the capability probe (`docker --version`, `docker info`,
// `docker compose version` plus the executable filesystem sweep) is re-run on
// every 5 s snapshot, i.e. it re-spawns three processes per poll even though a
// Docker install changes on human timescales, not on a poll. Cache the fully
// healthy probe for a bounded window so a poll does not re-spawn it.
// Only the healthy result is cached: an unhealthy probe (missing docker,
// daemon down, permission denied) is re-probed on every call, so a daemon
// start/stop or a fresh install is observed on the next poll and a rejected
// probe can never poison the cache.
const DOCKER_PROBE_CACHE_TTL_MS = 10000;

let dockerProbeCacheValue = null;
let dockerProbeCacheExpiresAt = 0;
let dockerProbeCacheInFlight = null;
// Test instrument: how many times the probe body actually executed.
let dockerProbeRunCount = 0;

function resetDockerProbeCache() {
  dockerProbeCacheValue = null;
  dockerProbeCacheExpiresAt = 0;
  dockerProbeCacheInFlight = null;
  dockerProbeRunCount = 0;
}

// One probe, shared by concurrent callers (the snapshot and
// ensureDockerAvailable can ask within the same tick).
async function loadDockerProbe() {
  const now = Date.now();
  if (dockerProbeCacheValue && dockerProbeCacheExpiresAt > now) {
    return dockerProbeCacheValue;
  }
  if (dockerProbeCacheInFlight) {
    return dockerProbeCacheInFlight;
  }

  const inFlight = (async () => {
    dockerProbeRunCount += 1;
    const executable = await resolveDockerExecutable();
    const versionResult = executable.found
      ? await exec(executable.executablePath, ["--version"])
      : { ok: false, errorCode: "DOCKER_MISSING", stdout: "", stderr: "", resolvedExecutablePath: executable.executablePath };
    const installed = versionResult.ok && Boolean(versionResult.stdout);
    const infoResult = installed
      ? await exec(executable.executablePath, ["info"])
      : { ok: false, errorCode: "DOCKER_MISSING", stdout: "", stderr: "", resolvedExecutablePath: executable.executablePath };
    const daemonRunning = installed && infoResult.ok;
    const unavailableError = installed && !daemonRunning ? classifyDockerFailure(infoResult) : null;
    const dockerVersion = parseDockerVersion(versionResult.stdout);
    const composeVersion = installed ? await getComposeVersion(executable.executablePath).catch(() => null) : null;

    return { executable, installed, daemonRunning, unavailableError, dockerVersion, composeVersion };
  })();

  dockerProbeCacheInFlight = inFlight;
  try {
    const value = await inFlight;
    if (value.installed && value.daemonRunning) {
      dockerProbeCacheValue = value;
      dockerProbeCacheExpiresAt = Date.now() + DOCKER_PROBE_CACHE_TTL_MS;
    }
    return value;
  } finally {
    dockerProbeCacheInFlight = null;
  }
}

async function probeDocker() {
  const { executable, installed, daemonRunning, unavailableError, dockerVersion, composeVersion } = await loadDockerProbe();
  return {
    executable,
    installed,
    daemonRunning,
    ...buildDockerCapabilityState({ installed, daemonRunning, errorCode: unavailableError?.code || null, version: dockerVersion }),
    dockerVersion,
    composeVersion,
    version: dockerVersion,
    message: !installed
      ? "Docker is not installed or is not available on PATH for this node."
      : daemonRunning
        ? "Docker is available."
        : unavailableError.message,
    errorCode: !installed ? "DOCKER_NOT_INSTALLED" : daemonRunning ? null : unavailableError.code,
  };
}

async function ensureDockerAvailable() {
  const status = await probeDocker();
  if (!status.installed) {
    throw new DockerServiceError(status.message, "DOCKER_NOT_INSTALLED", 503);
  }
  if (!status.daemonRunning) {
    throw new DockerServiceError(status.message, status.errorCode || "DOCKER_DAEMON_UNAVAILABLE", status.errorCode === "DOCKER_PERMISSION_DENIED" ? 403 : 503);
  }
  return status;
}

async function listContainersRaw(options = {}) {
  const dockerPath = options.dockerPath || await getDockerExecutableOrThrow();
  // --no-trunc: docker ps otherwise cuts volume names ("app-dat…"), which the
  // workload list shows as kept data. Ids are shortened back to Docker's
  // usual 12 characters in normalizeContainer, so nothing else changes.
  const result = await runDockerCommandWithExecutable(dockerPath, ["ps", "-a", "--no-trunc", "--format", "json"], {
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
  });
  return parseJsonLines(result.stdout, normalizeContainer);
}

async function listStatsRaw(target = null, options = {}) {
  const dockerPath = options.dockerPath || await getDockerExecutableOrThrow();
  const args = ["stats", "--no-stream", "--format", "json"];
  if (target) {
    args.push(validateContainerTarget(target));
  }
  const result = await runDockerCommandWithExecutable(dockerPath, args, {
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
  });
  const parsed = parseJsonLines(result.stdout, normalizeStats);
  return parsed.length > 0 ? parsed : parseStatsTable(result.stdout);
}

async function listImagesRaw(options = {}) {
  const dockerPath = options.dockerPath || await getDockerExecutableOrThrow();
  const result = await runDockerCommandWithExecutable(dockerPath, ["images", "--digests", "--format", "json"], {
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
  });
  return parseJsonLines(result.stdout, normalizeImage);
}

async function listNetworksRaw(options = {}) {
  const dockerPath = options.dockerPath || await getDockerExecutableOrThrow();
  const result = await runDockerCommandWithExecutable(dockerPath, ["network", "ls", "--format", "json"], {
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
  });
  return parseJsonLines(result.stdout, normalizeNetwork);
}

async function listVolumesRaw(options = {}) {
  const dockerPath = options.dockerPath || await getDockerExecutableOrThrow();
  const result = await runDockerCommandWithExecutable(dockerPath, ["volume", "ls", "--format", "json"], {
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
  });
  return parseJsonLines(result.stdout, normalizeVolume);
}

async function getDockerDiskUsage(options = {}) {
  const dockerPath = options.dockerPath || await getDockerExecutableOrThrow();
  const result = await runDockerCommandWithExecutable(dockerPath, ["system", "df", "--format", "json"], {
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
  });
  const rows = parseJsonLines(result.stdout, (row) => row);
  return {
    rows,
    summary: rows.map((row) => `${row.Type || "Resource"}: ${row.Size || row.TotalSize || "unknown"} (${row.Reclaimable || "0B"} reclaimable)`).join("; "),
  };
}

function summarizeContainers(containers) {
  const runningContainers = containers.filter((container) => /^running$/i.test(container.state || "") || /^up\b/i.test(container.status || ""));
  return {
    runningContainers: runningContainers.length,
    stoppedContainers: Math.max(containers.length - runningContainers.length, 0),
    totalContainers: containers.length,
  };
}

async function getDockerSnapshot() {
  const status = await probeDocker();
  if (!status.installed || !status.daemonRunning) {
    return {
      ...status,
      images: 0,
      imageCount: 0,
      volumeCount: 0,
      containers: [],
      summary: {
        installed: status.installed,
        daemonRunning: status.daemonRunning,
        runningContainers: 0,
        stoppedContainers: 0,
        totalContainers: 0,
        images: 0,
        volumes: 0,
      },
      lastCheckedAt: new Date().toISOString(),
    };
  }

  const dockerPath = status.executable?.executablePath || await getDockerExecutableOrThrow();
  const optionalSnapshotOptions = { dockerPath, timeoutMs: SNAPSHOT_OPTIONAL_TIMEOUT_MS };
  const [containers, stats, images, volumes, networks, diskUsage] = await Promise.all([
    listContainersRaw({ dockerPath }),
    listStatsRaw(null, optionalSnapshotOptions).catch(() => []),
    listImagesRaw(optionalSnapshotOptions).catch(() => []),
    listVolumesRaw(optionalSnapshotOptions).catch(() => []),
    listNetworksRaw(optionalSnapshotOptions).catch(() => []),
    getDockerDiskUsage(optionalSnapshotOptions).catch(() => ({ rows: [], summary: null })),
  ]);
  const containersWithStats = attachStats(containers, stats);
  const containerSummary = summarizeContainers(containersWithStats);

  return {
    ...status,
    images: images.length,
    imageCount: images.length,
    volumeCount: volumes.length,
    networkCount: networks.length,
    diskUsage,
    containers: containersWithStats,
    summary: {
      installed: status.installed,
      daemonRunning: status.daemonRunning,
      ...containerSummary,
      images: images.length,
      volumes: volumes.length,
      networks: networks.length,
      diskUsage: diskUsage.summary,
    },
    lastCheckedAt: new Date().toISOString(),
  };
}

async function getDockerSummary() {
  const snapshot = await getDockerSnapshot();
  return {
    installed: snapshot.installed,
    daemonRunning: snapshot.daemonRunning,
    runningContainers: snapshot.summary.runningContainers,
    stoppedContainers: snapshot.summary.stoppedContainers,
    totalContainers: snapshot.summary.totalContainers,
    images: snapshot.summary.images,
    volumes: snapshot.summary.volumes,
    dockerVersion: snapshot.dockerVersion,
    composeVersion: snapshot.composeVersion,
    networks: snapshot.summary.networks,
    diskUsage: snapshot.summary.diskUsage,
    message: snapshot.message,
  };
}

// The container list (Docker page, All computers). It used to build the
// whole snapshot and keep only the containers, starting images, volumes,
// networks and `system df` for nothing. Live stats (`docker stats
// --no-stream`, about 2.7 s on Docker Desktop because it samples) are kept
// for the Docker page and skipped with { stats: false } by callers that do
// not show them. Build 215-E, measured on the development PC: median 2.07 s
// -> see docs/HANDOFF_BUILD215.md for the after numbers.
async function getDockerContainers(options = {}) {
  const status = await probeDocker();
  if (!status.installed || !status.daemonRunning) {
    return { installed: status.installed, daemonRunning: status.daemonRunning, dockerVersion: status.dockerVersion, message: status.message, containers: [] };
  }
  const dockerPath = status.executable?.executablePath || await getDockerExecutableOrThrow();
  const [containers, stats] = await Promise.all([
    listContainersRaw({ dockerPath }),
    options.stats === false ? Promise.resolve([]) : listStatsRaw(null, { dockerPath, timeoutMs: SNAPSHOT_OPTIONAL_TIMEOUT_MS }).catch(() => []),
  ]);
  return {
    installed: status.installed,
    daemonRunning: status.daemonRunning,
    dockerVersion: status.dockerVersion,
    message: status.message,
    containers: attachStats(containers, stats),
  };
}

async function inspectContainer(container) {
  const target = validateContainerTarget(container);
  const result = await runDockerCommand(["inspect", target]);
  return { container: target, inspect: JSON.parse(result.stdout || "[]") };
}

async function createContainer(payload = {}) {
  // V2-C fail-closed policy gate: privileged mode, host networking, host path
  // mounts and engine-socket mounts are denied unless the request carries an
  // explicit per-flag policyGrant (renderer confirmations are presentation,
  // never the boundary).
  const policy = policeContainerRequest(payload);
  if (!policy.allowed) {
    const labels = policy.denials.map((flag) => flag.label).join(", ");
    throw new DockerServiceError(`Docker policy denied this request: ${labels}. Grant the option explicitly to allow it.`, "DOCKER_POLICY_DENIED", 403);
  }
  const limitProblems = validateResourceLimits(payload);
  if (limitProblems.length > 0) {
    throw new DockerServiceError(limitProblems[0].message, limitProblems[0].code, 400);
  }
  const name = validateContainerTarget(payload.name || `anxhub-${Date.now()}`);
  const image = validateImage(payload.image);
  const args = ["create", "--name", name, "--restart", normalizeRestartPolicy(payload.restartPolicy)];
  normalizePorts(payload.ports).forEach((port) => args.push("-p", port));
  normalizeKeyValueMap(payload.environment || payload.env).forEach((entry) => args.push("-e", entry));
  normalizeKeyValueMap(payload.labels, 64).forEach((entry) => args.push("--label", entry));
  normalizeStringArray(payload.volumes, 64).forEach((entry) => args.push("-v", entry));
  normalizeStringArray(payload.binds || payload.mounts, 64).forEach((entry) => args.push("--mount", entry));
  if (payload.network) args.push("--network", validateNetworkTarget(payload.network));
  if (payload.entrypoint) args.push("--entrypoint", String(payload.entrypoint).trim());
  if (payload.workdir || payload.workingDirectory) args.push("-w", String(payload.workdir || payload.workingDirectory).trim());
  if (payload.user) args.push("-u", String(payload.user).trim());
  if (payload.memory) {
    args.push("--memory", String(payload.memory));
  }
  if (payload.cpus) {
    args.push("--cpus", String(payload.cpus));
  }
  if (payload.privileged === true) args.push("--privileged");
  if (payload.autoRemove === true) args.push("--rm");
  args.push(image, ...normalizeStringArray(payload.command, 64));
  // Creating and starting a container can take far longer than the 8-second
  // limit for quick commands on a busy computer (volumes are created, the
  // image is unpacked); timing out here left a container nobody reported.
  const result = await runDockerCommand(args, { timeout: CONTAINER_CREATE_TIMEOUT_MS });
  if (payload.start === true) {
    try {
      await runDockerCommand(["start", name], { timeout: CONTAINER_CREATE_TIMEOUT_MS });
    } catch (error) {
      // This call just created the container under the name validated above,
      // so removing it is safe. Left in Created state, it made every retry fail
      // with a name conflict until the user found it on the Docker page.
      await runDockerCommand(["rm", "-f", name], { timeout: CONTAINER_CREATE_TIMEOUT_MS }).catch(() => {});
      throw error;
    }
  }
  return { container: { id: result.stdout || name, name, image, started: payload.start === true } };
}

async function pauseContainer(container) {
  const target = validateContainerTarget(container);
  await runDockerCommand(["pause", target]);
  return { container: target, action: "pause" };
}

async function unpauseContainer(container) {
  const target = validateContainerTarget(container);
  await runDockerCommand(["unpause", target]);
  return { container: target, action: "unpause" };
}

async function killContainer(container) {
  const target = validateContainerTarget(container);
  await runDockerCommand(["kill", target]);
  return { container: target, action: "kill" };
}

async function renameContainer(container, nextName) {
  const target = validateContainerTarget(container);
  const name = validateName(nextName, "container name");
  await runDockerCommand(["rename", target, name]);
  return { container: target, name };
}

async function startContainer(container) {
  const target = validateContainerTarget(container);
  await runDockerCommand(["start", target]);
  return { container: target, action: "start" };
}

async function stopContainer(container) {
  const target = validateContainerTarget(container);
  await runDockerCommand(["stop", target]);
  return { container: target, action: "stop" };
}

async function restartContainer(container) {
  const target = validateContainerTarget(container);
  await runDockerCommand(["restart", target]);
  return { container: target, action: "restart" };
}

async function deleteContainer(container) {
  const target = validateContainerTarget(container);
  await runDockerCommand(["rm", "-f", target]);
  return { container: target, deleted: true };
}

async function removeImage(image) {
  const target = validateImageTarget(image);
  await runDockerCommand(["rmi", target]);
  return { image: target, deleted: true };
}

async function inspectImage(image) {
  const target = validateImageTarget(image);
  const result = await runDockerCommand(["image", "inspect", target]);
  return { image: target, inspect: JSON.parse(result.stdout || "[]") };
}

async function pullImage(image) {
  const target = validateImage(image);
  let operation;
  try {
    operation = longOperations.createOperation({
      kind: "docker-image-pull",
      lockKey: `docker-pull:${target}`,
      status: "running",
      canCancel: false,
      retryable: true,
      rollbackSupported: false,
      // Defense-in-depth against a stuck lock: runDockerCommand already applies
      // its own 10-minute exec timeout below, but this ensures the shared
      // registry itself cannot hold the lock indefinitely if that mechanism
      // ever fails to resolve (e.g. a signal that does not terminate cleanly).
      timeoutMs: 11 * 60 * 1000,
      metadata: { image: target },
    });
  } catch (error) {
    if (error?.code === "DUPLICATE_OPERATION") {
      throw new DockerServiceError(`Image ${target} is already being pulled.`, "DOCKER_PULL_ALREADY_IN_PROGRESS", 409);
    }
    throw error;
  }
  // Registered immediately so that if this attempt fails and canRetry becomes
  // true, longOperations.retryOperation() genuinely re-runs the pull rather
  // than merely resetting status with nothing behind it.
  longOperations.registerRetryHandler(operation.id, () => pullImage(target));
  try {
    const result = await runDockerCommand(["pull", target], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 4 });
    const output = { image: target, output: redactDockerText(`${result.stdout}\n${result.stderr}`.trim()) };
    longOperations.completeOperation(operation.id);
    return output;
  } catch (error) {
    longOperations.failOperation(operation.id, {
      code: error?.code || "DOCKER_PULL_FAILED",
      message: error?.message || "Docker image pull failed.",
    }, { retryable: true });
    throw error;
  }
}

async function pruneImages() {
  const result = await runDockerCommand(["image", "prune", "-f"], { timeout: 120000 });
  return { output: redactDockerText(result.stdout) };
}

async function getContainerLogs(container, options = {}) {
  const target = validateContainerTarget(container);
  const tail = Number.parseInt(options.tail, 10);
  // Always ask for timestamps: `docker logs` sends a container's stderr to its
  // own stderr, and returning only stdout hid every error line (nginx logs
  // its errors there). The timestamps put both streams back in order.
  const result = await runDockerCommand(
    ["logs", "--timestamps", "--tail", String(Number.isFinite(tail) ? Math.min(Math.max(tail, 1), 5000) : 300), target],
    { timeout: LOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 2 },
  );
  const keepTimestamps = options.timestamps === true || options.timestamps === "true";
  return { container: target, logs: redactDockerText(mergeDockerLogStreams(result.stdout, result.stderr, keepTimestamps)) };
}

const DOCKER_LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}) ?/;

// Merge `docker logs --timestamps` stdout and stderr into one time-ordered
// text. Sort keys come from the parsed time (the local log driver can use a
// zone offset) plus nanoseconds; a line without a timestamp keeps the key of
// the line before it, and ties keep stdout first and the original order.
function mergeDockerLogStreams(stdout = "", stderr = "", keepTimestamps = false) {
  const entries = [];
  [stdout, stderr].forEach((text, stream) => {
    let key = "";
    String(text || "").split(/\r?\n/).forEach((line, index) => {
      if (!line) return;
      const match = DOCKER_LOG_TIMESTAMP.exec(line);
      if (match) {
        const seconds = Date.parse(`${match[1]}${match[3]}`);
        key = `${String(Number.isFinite(seconds) ? seconds : 0).padStart(15, "0")}.${(match[2] || "").padEnd(9, "0")}`;
      }
      entries.push({ key, stream, index, text: match && !keepTimestamps ? line.slice(match[0].length) : line });
    });
  });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.stream - b.stream || a.index - b.index));
  return entries.map((entry) => entry.text).join("\n");
}

async function getContainerStats(container) {
  const target = validateContainerTarget(container);
  const stats = await listStatsRaw(target);
  const inspect = await inspectContainer(target).catch(() => null);
  const state = Array.isArray(inspect?.inspect) ? inspect.inspect[0]?.State : null;
  return {
    container: target,
    stats: stats[0] || null,
    status: state?.Status || null,
    uptime: state?.StartedAt || null,
  };
}

async function listImages() {
  const [images, containers] = await Promise.all([listImagesRaw(), listContainersRaw().catch(() => [])]);
  return {
    images: images.map((image) => {
      const ref = `${image.repository || "<none>"}:${image.tag || "<none>"}`;
      return { ...image, containersUsing: containers.filter((container) => container.image === ref || container.image === image.id).map((container) => container.name || container.id) };
    }),
  };
}

async function listNetworks() {
  const networks = await listNetworksRaw();
  const detailed = await Promise.all(networks.map(async (network) => {
    const inspect = await inspectNetwork(network.name || network.id).catch(() => null);
    const data = Array.isArray(inspect?.inspect) ? inspect.inspect[0] : null;
    const ipam = data?.IPAM?.Config?.[0] || {};
    return { ...network, subnet: ipam.Subnet || null, gateway: ipam.Gateway || null, containers: Object.values(data?.Containers || {}).map((entry) => entry.Name).filter(Boolean) };
  }));
  return { networks: detailed };
}

// One `docker inspect` for every listed item. Inspecting each container and
// volume with its own command took longer than the desktop's 12-second limit
// on a computer with about ten containers, so the volume list never loaded.
// Returns null when the single command fails (for example an item removed
// between the list and the inspect), and the caller inspects one by one.
async function inspectMany(prefixArgs, targets) {
  if (targets.length === 0) return [];
  try {
    const result = await runDockerCommand([...prefixArgs, ...targets], { timeout: 20000, maxBuffer: 1024 * 1024 * 16 });
    const parsed = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function listVolumes() {
  const [volumes, containers] = await Promise.all([listVolumesRaw(), listContainersRaw().catch(() => [])]);
  const containerIds = containers.map((container) => container.id).filter(Boolean);
  const volumeNames = volumes.map((volume) => volume.name).filter(Boolean);
  const containerData = await inspectMany(["inspect"], containerIds)
    || (await Promise.all(containerIds.map((id) => inspectContainer(id).catch(() => null))))
      .map((entry) => Array.isArray(entry?.inspect) ? entry.inspect[0] : null);
  const volumeData = await inspectMany(["volume", "inspect"], volumeNames)
    || (await Promise.all(volumeNames.map((name) => inspectVolume(name).catch(() => null))))
      .map((entry) => Array.isArray(entry?.inspect) ? entry.inspect[0] : null);
  const volumeByName = new Map(volumeData.filter(Boolean).map((entry) => [entry.Name, entry]));
  return {
    volumes: volumes.map((volume) => {
      const users = containerData
        .filter((entry) => (entry?.Mounts || []).some((mount) => mount.Type === "volume" && mount.Name === volume.name))
        .map((entry) => normalizeName(entry?.Name) || entry?.Id)
        .filter(Boolean);
      return { ...volume, labels: volumeByName.get(volume.name)?.Labels || {}, containersUsing: users };
    }),
  };
}

async function inspectVolume(volume) {
  const target = validateVolumeTarget(volume);
  const result = await runDockerCommand(["volume", "inspect", target]);
  return { volume: target, inspect: JSON.parse(result.stdout || "[]") };
}

async function removeVolume(volume) {
  const target = validateVolumeTarget(volume);
  const volumes = await listVolumes();
  const entry = volumes.volumes.find((candidate) => candidate.name === target);
  if (entry?.containersUsing?.length) {
    throw new DockerServiceError("Docker volume is currently used by a container.", "DOCKER_VOLUME_IN_USE", 409);
  }
  await runDockerCommand(["volume", "rm", target]);
  return { volume: target, deleted: true };
}

async function pruneVolumes() {
  const result = await runDockerCommand(["volume", "prune", "-f"], { timeout: 120000 });
  return { output: redactDockerText(result.stdout) };
}

async function inspectNetwork(network) {
  const target = validateNetworkTarget(network);
  const result = await runDockerCommand(["network", "inspect", target]);
  return { network: target, inspect: JSON.parse(result.stdout || "[]") };
}

async function createNetwork(payload = {}) {
  const name = validateName(payload.name, "network name");
  const args = ["network", "create"];
  if (payload.driver) args.push("--driver", String(payload.driver).trim());
  if (payload.subnet) args.push("--subnet", String(payload.subnet).trim());
  if (payload.gateway) args.push("--gateway", String(payload.gateway).trim());
  normalizeKeyValueMap(payload.labels, 64).forEach((entry) => args.push("--label", entry));
  args.push(name);
  const result = await runDockerCommand(args);
  return { network: { id: result.stdout, name } };
}

function assertMutableNetwork(network) {
  const target = validateNetworkTarget(network);
  if (["bridge", "host", "none"].includes(target)) {
    throw new DockerServiceError("Default Docker networks are protected from deletion.", "DOCKER_DEFAULT_NETWORK_PROTECTED", 409);
  }
  return target;
}

async function removeNetwork(network) {
  const target = assertMutableNetwork(network);
  await runDockerCommand(["network", "rm", target]);
  return { network: target, deleted: true };
}

async function connectNetwork(network, container) {
  const net = validateNetworkTarget(network);
  const target = validateContainerTarget(container);
  await runDockerCommand(["network", "connect", net, target]);
  return { network: net, container: target, connected: true };
}

async function disconnectNetwork(network, container) {
  const net = validateNetworkTarget(network);
  const target = validateContainerTarget(container);
  await runDockerCommand(["network", "disconnect", net, target]);
  return { network: net, container: target, disconnected: true };
}

async function pruneNetworks() {
  const result = await runDockerCommand(["network", "prune", "-f"], { timeout: 120000 });
  return { output: redactDockerText(result.stdout) };
}

async function listComposeProjects() {
  const result = await runDockerCommand(["compose", "ls", "--format", "json"], { timeout: COMMAND_TIMEOUT_MS });
  const projects = JSON.parse(result.stdout || "[]");
  return { projects: Array.isArray(projects) ? projects : [] };
}

function composeArgs(payload = {}, command = []) {
  const projectName = validateComposeProject(payload.projectName || payload.name || "anxos");
  const projectDirectory = validateNodePath(payload.projectDirectory || payload.path || process.cwd());
  return ["compose", "--project-name", projectName, "--project-directory", projectDirectory, ...command];
}

async function runCompose(payload = {}, command = [], options = {}) {
  const result = await runDockerCommand(composeArgs(payload, command), { timeout: options.timeoutMs || 120000, maxBuffer: options.maxBuffer || 1024 * 1024 * 4 });
  return { projectName: payload.projectName || payload.name || "anxos", output: redactDockerText(`${result.stdout}\n${result.stderr}`.trim()) };
}

async function validateComposeConfig(payload = {}) {
  return runCompose(payload, ["config"], { timeoutMs: 30000 });
}

async function startComposeProject(payload = {}) {
  await validateComposeConfig(payload);
  return runCompose(payload, ["up", "-d"], { timeoutMs: 10 * 60 * 1000 });
}

async function stopComposeProject(payload = {}) {
  return runCompose(payload, ["stop"]);
}

async function restartComposeProject(payload = {}) {
  return runCompose(payload, ["restart"]);
}

async function pullComposeProject(payload = {}) {
  return runCompose(payload, ["pull"], { timeoutMs: 10 * 60 * 1000 });
}

async function buildComposeProject(payload = {}) {
  return runCompose(payload, ["build"], { timeoutMs: 20 * 60 * 1000 });
}

async function recreateComposeProject(payload = {}) {
  await validateComposeConfig(payload);
  return runCompose(payload, ["up", "-d", "--force-recreate"], { timeoutMs: 10 * 60 * 1000 });
}

async function getComposeLogs(payload = {}) {
  const tail = Number.parseInt(payload.tail, 10);
  return runCompose(payload, ["logs", "--no-color", "--tail", String(Number.isFinite(tail) ? Math.min(Math.max(tail, 1), 2000) : 300)], { timeoutMs: LOG_TIMEOUT_MS });
}

async function getComposeStatus(payload = {}) {
  const result = await runCompose(payload, ["ps", "--format", "json"]);
  return { ...result, services: parseJsonLines(result.output, (row) => row) };
}

async function removeComposeProject(payload = {}) {
  const command = ["down"];
  if (payload.volumes === true) command.push("--volumes");
  return runCompose(payload, command, { timeoutMs: 10 * 60 * 1000 });
}

async function getCleanupPreview() {
  const diskUsage = await getDockerDiskUsage().catch(() => ({ rows: [], summary: null }));
  return {
    diskUsage,
    actions: [
      { id: "containers", label: "Stopped containers", command: "container prune", affectsPersistentData: false },
      { id: "images", label: "Unused images", command: "image prune -a", affectsPersistentData: false },
      { id: "build-cache", label: "Build cache", command: "builder prune", affectsPersistentData: false },
      { id: "networks", label: "Unused networks", command: "network prune", affectsPersistentData: false },
      { id: "volumes", label: "Unused volumes", command: "volume prune", affectsPersistentData: true },
      { id: "safe", label: "Full safe prune without volumes", command: "system prune", affectsPersistentData: false },
    ],
  };
}

async function runCleanup(payload = {}) {
  const kind = String(payload.kind || "").trim();
  const commands = {
    containers: ["container", "prune", "-f"],
    images: ["image", "prune", "-a", "-f"],
    "build-cache": ["builder", "prune", "-f"],
    networks: ["network", "prune", "-f"],
    volumes: ["volume", "prune", "-f"],
    safe: ["system", "prune", "-f"],
  };
  if (!commands[kind]) throw new DockerServiceError("Invalid Docker cleanup action.", "INVALID_DOCKER_CLEANUP", 400);
  // V2-C volume protection: persistent-data cleanup requires an explicit
  // confirmation flag from the caller, in addition to the renderer dialog.
  assertCleanupSelection(kind, payload.confirmVolumeDataRemoval);
  const result = await runDockerCommand(commands[kind], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 4 });
  return { kind, output: redactDockerText(result.stdout) };
}

async function execContainer(container, payload = {}) {
  const target = validateContainerTarget(container);
  const shellCandidates = ["bash", "sh", "ash"];
  const command = String(payload.command || "").trim();
  if (!command || command.length > 2000 || /[\0]/.test(command)) {
    throw new DockerServiceError("Invalid container command.", "INVALID_CONTAINER_COMMAND", 400);
  }
  // With no shell requested, try bash, then sh and ash: Alpine images (the
  // Nginx template among them) have no bash, so every command used to fail.
  const shells = payload.shell ? [shellCandidates.includes(payload.shell) ? payload.shell : "sh"] : shellCandidates;
  const dockerPath = await getDockerExecutableOrThrow();
  for (const [index, shell] of shells.entries()) {
    const result = await exec(dockerPath, ["exec", target, shell, "-lc", command], { timeout: LOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 2 });
    if (!result.ok) {
      const output = `${result.stdout}\n${result.stderr}`;
      const shellMissing = /executable file not found|exec: "?(?:bash|sh|ash)"?: (?:no such file|not found)/i.test(output);
      if (shellMissing && index < shells.length - 1) continue;
      // Docker's own failures (no such container, daemon down, no shell at all)
      // are errors. A command that ran and exited non-zero is a result: its
      // output and exit code go back to the user instead of being classified,
      // which turned "ls: no such file" into "Docker is not installed".
      if (shellMissing || /ENOENT/i.test(String(result.errorCode || "")) || /Error response from daemon|OCI runtime exec failed|Cannot connect to the Docker daemon|error during connect|permission denied while trying to connect/i.test(output)) {
        throw classifyDockerFailure(result);
      }
    }
    return { container: target, shell, exitCode: result.ok ? 0 : result.exitCode, output: redactDockerText(result.stdout), errorOutput: redactDockerText(result.stderr) };
  }
}

// V2-C create preflight (roadmap: preflight ports, capacity, mounts, limits).
// Pure checks are exact; engine-dependent checks (port conflicts against
// currently published host ports) are best-effort and reported as
// engineUnavailable when the engine is not reachable. Never throws for
// findings — the caller decides whether to proceed.
// Host ports that listed containers publish. The Docker CLI reports them as
// text ("0.0.0.0:8080->80/tcp, [::]:8080->80/tcp"); the Engine API reports
// objects with PublicPort. Reading only the object form found no ports on a
// real engine, so a busy port was never reported before the create failed.
function readPublishedHostPorts(rawPorts) {
  const ports = new Set();
  if (Array.isArray(rawPorts)) {
    for (const binding of rawPorts) {
      const port = Number.parseInt(binding?.PublicPort, 10);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  } else if (typeof rawPorts === "string") {
    for (const match of rawPorts.matchAll(/:(\d{1,5})(?:-(\d{1,5}))?->/g)) {
      const first = Number.parseInt(match[1], 10);
      const last = match[2] ? Number.parseInt(match[2], 10) : first;
      for (let port = first; port <= last && port <= 65535 && ports.size < 4096; port += 1) ports.add(port);
    }
  }
  return [...ports];
}

// Whether another program on this computer already holds a host port the
// container would publish. Docker only refuses a port another container
// holds, and Docker Desktop on Windows published a port a Windows program was
// already listening on, so the install "succeeded" with the service
// unreachable. A bind that fails with EADDRINUSE is the evidence; any other
// error (no permission for a low port, no IPv6) is "cannot tell".
function parsePublishedPort(entry) {
  const match = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):\d{1,5}(?:\/(tcp|udp))?$/i.exec(String(entry || "").trim());
  if (!match) return null;
  return { address: match[1] || "0.0.0.0", port: Number(match[2]), protocol: (match[3] || "tcp").toLowerCase() };
}

function probeHostPortHeld({ address, port, protocol }) {
  return new Promise((resolve) => {
    if (protocol === "udp") {
      const socket = dgram.createSocket("udp4");
      socket.once("error", (error) => { try { socket.close(); } catch {} resolve(error?.code === "EADDRINUSE"); });
      socket.bind({ port, address, exclusive: true }, () => socket.close(() => resolve(false)));
      return;
    }
    const server = net.createServer();
    server.once("error", (error) => resolve(error?.code === "EADDRINUSE"));
    server.listen({ port, host: address, exclusive: true }, () => server.close(() => resolve(false)));
  });
}

async function findHostPortsHeldByOtherPrograms(ports = []) {
  const held = [];
  for (const entry of Array.isArray(ports) ? ports : []) {
    const published = parsePublishedPort(entry);
    if (!published) continue;
    // Windows lets a second program take the same port on a different
    // address (all addresses vs 127.0.0.1), so both are tried.
    const addresses = published.address === "0.0.0.0" ? ["0.0.0.0", "127.0.0.1"] : [published.address, "0.0.0.0"];
    for (const address of addresses) {
      if (await probeHostPortHeld({ ...published, address }).catch(() => false)) {
        held.push(published);
        break;
      }
    }
  }
  return held;
}

async function preflightContainerCreate(payload = {}) {
  const findings = [];
  for (const held of await findHostPortsHeldByOtherPrograms(payload.ports)) {
    findings.push({ severity: "error", code: "HOST_PORT_IN_USE", field: "ports", message: `Port ${held.port} (${held.protocol.toUpperCase()}) is already used by another program on this computer. Choose another port, or stop that program first.` });
  }
  const policy = policeContainerRequest(payload);
  for (const denial of policy.denials) {
    findings.push({ severity: "error", code: "POLICY_DENIED", field: denial.key, message: `${denial.label} is denied by Docker policy unless explicitly granted.` });
  }
  for (const flag of policy.flags) {
    if (!policy.denials.some((denial) => denial.key === flag.key)) {
      findings.push({ severity: "warning", code: "POLICY_GRANTED", field: flag.key, message: `${flag.label} is allowed by an explicit grant.` });
    }
  }
  for (const problem of validateResourceLimits(payload)) {
    findings.push({ severity: "error", code: problem.code, field: problem.field, message: problem.message });
  }
  try {
    validateImage(payload.image ?? "");
  } catch (error) {
    findings.push({ severity: "error", code: "INVALID_IMAGE", field: "image", message: error?.message || "A container image is required." });
  }
  let requestedName = null;
  try {
    requestedName = validateContainerTarget(payload.name ?? "");
  } catch {
    findings.push({ severity: "error", code: "INVALID_NAME", field: "name", message: "A valid container name is required." });
  }
  let engineAvailable = false;
  try {
    await listStatsRaw(null, { timeoutMs: SNAPSHOT_OPTIONAL_TIMEOUT_MS });
    engineAvailable = true;
    // Published host ports come from live containers, not stats output.
    // rawPorts entries carry PublicPort (host side); normalized `ports` mixes
    // exposed container ports in, which would fabricate conflicts.
    const containers = await listContainersRaw({ timeoutMs: SNAPSHOT_OPTIONAL_TIMEOUT_MS });
    const publishedHostPorts = [];
    for (const container of containers) {
      for (const hostPort of readPublishedHostPorts(container.rawPorts)) {
        publishedHostPorts.push({ hostPort });
      }
    }
    for (const port of detectHostPortConflicts(normalizeHostPorts(payload), publishedHostPorts)) {
      findings.push({ severity: "warning", code: "HOST_PORT_IN_USE", field: "ports", message: `Host port ${port} is already published by another container. The create may fail with a port conflict.` });
    }
  } catch {
    // Engine unreachable: pure findings still stand.
  }
  return {
    engineAvailable,
    name: requestedName,
    findings,
    policy: { allowed: policy.allowed, deniedKeys: policy.denials.map((flag) => flag.key) },
  };
}

// V2-C compose policy gate: evaluate the compose file the engine would
// actually run. Inline payload.composeYaml (editor preview) wins; otherwise
// the file is resolved from the project directory exactly like
// `docker compose` resolves it. File reads are bounded: the directory must
// pass the existing compose path validation, only fixed compose basenames are
// accepted, and the resolved candidate must stay inside that directory.
// No compose file to review → null (the engine produces its own missing-file
// diagnostic); unparsable or denied content → DockerServiceError before any
// docker command runs.
async function assertComposePolicy(payload = {}) {
  const grant = payload.policyGrant && typeof payload.policyGrant === "object" ? payload.policyGrant : {};
  let yamlText = typeof payload.composeYaml === "string" && payload.composeYaml.trim() !== "" ? payload.composeYaml : null;
  if (yamlText === null) {
    const rawDirectory = payload.projectDirectory || payload.path || null;
    if (!rawDirectory) return null;
    const projectDirectory = path.resolve(validateNodePath(rawDirectory));
    for (const candidate of COMPOSE_FILE_CANDIDATES) {
      const candidatePath = path.resolve(projectDirectory, candidate);
      if (!candidatePath.startsWith(projectDirectory + path.sep)) continue;
      if (await pathExists(candidatePath)) {
        yamlText = await fs.readFile(candidatePath, "utf8");
        break;
      }
    }
  }
  if (yamlText === null) return null;
  const policy = policeComposeYaml(yamlText, grant);
  if (!policy.parsed) {
    throw new DockerServiceError(`Compose file could not be reviewed for policy: ${policy.parseError}`, "COMPOSE_POLICY_UNPARSEABLE", 400);
  }
  if (!policy.allowed) {
    const summary = policy.denials.map((flag) => `${flag.service}: ${flag.label}`).join("; ");
    throw new DockerServiceError(`Docker policy denied this compose project: ${summary}. Grant the options explicitly to allow them.`, "DOCKER_POLICY_DENIED", 403);
  }
  return policy;
}

module.exports = {
  DockerServiceError,
  attachStats,
  buildDockerCapabilityState,
  classifyDockerFailure,
  connectNetwork,
  createContainer,
  createNetwork,
  deleteContainer,
  disconnectNetwork,
  execContainer,
  getCleanupPreview,
  getComposeLogs,
  getComposeStatus,
  getContainerLogs,
  getContainerStats,
  getDockerContainers,
  getDockerExecutableOrThrow,
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
  maskEnv,
  normalizeContainer,
  normalizePortBindings,
  normalizeStats,
  parseComposeVersion,
  parseDockerVersion,
  parseJsonLines,
  pauseContainer,
  preflightContainerCreate,
  findHostPortsHeldByOtherPrograms,
  readPublishedHostPorts,
  assertComposePolicy,
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
  resolveDockerExecutable,
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
  // Test-only hooks (SMOOTH-3002): prove the probe cache hermetically without
  // a real Docker daemon.
  _test: {
    probeDocker,
    resetDockerProbeCache,
    getProbeRunCount() {
      return dockerProbeRunCount;
    },
  },
};
