// V2-C deny-by-default policy gate and preflight helpers
// (docs/v2/V2C_CONTAINERS_WAVE1.md §3.4–3.5): privileged containers, host
// path mounts, engine-socket mounts and host networking fail closed unless
// the caller carries an explicit per-flag grant; cleanup that touches
// persistent data (volumes) requires an explicit confirmation flag; preflight
// port, mount and resource-limit checks stay pure so they can be pinned
// hermetically without a Docker engine.

const DOCKER_SOCKET_HINT = /docker\.sock/i;

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// An absolute POSIX path, a Windows drive path, or a UNC share is a host path.
function isHostPathSource(source) {
  return /^[/\\]/.test(source) || /^[a-zA-Z]:[\\/]/.test(source);
}

// `-v /host/path:/ctr/path[:mode]` | `-v name:/ctr/path` | `-v /ctr/path`.
// A leading single-letter segment is a Windows drive prefix, so the host
// source spans the first two segments ("C:\\host:/ctr" → "C:\\host").
function inspectVolumeEntry(entry) {
  const segments = String(entry).split(":");
  let source = segments[0];
  if (segments.length > 2 && /^[a-zA-Z]$/.test(source)) {
    source = `${source}:${segments[1]}`;
  }
  return {
    source,
    hostPath: isHostPathSource(source),
    socket: DOCKER_SOCKET_HINT.test(String(entry)),
  };
}

// `--mount type=bind,source=/host,target=/ctr[,readonly]`
function inspectMountEntry(entry) {
  const fields = {};
  for (const part of String(entry).split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  const source = fields.source || fields.src || "";
  return {
    source,
    hostPath: fields.type === "bind" && isHostPathSource(source),
    socket: DOCKER_SOCKET_HINT.test(String(entry)),
  };
}

// Every option that can expose the node is reported here. The gate itself
// (policeContainerRequest) decides which reported options are actually denied.
function detectDangerousCreateOptions(payload = {}) {
  const flags = [];
  if (payload.privileged === true) {
    flags.push({ key: "privileged", label: "privileged mode" });
  }
  if (payload.network === "host") {
    flags.push({ key: "hostNetwork", label: "host networking" });
  }
  for (const entry of splitList(payload.volumes)) {
    const { hostPath, socket } = inspectVolumeEntry(entry);
    if (hostPath) flags.push({ key: "hostMount", label: `host path mount (${entry})` });
    if (socket) flags.push({ key: "socketAccess", label: `engine socket mount (${entry})` });
  }
  for (const entry of splitList(payload.binds || payload.mounts)) {
    const { hostPath, socket } = inspectMountEntry(entry);
    if (hostPath) flags.push({ key: "hostMount", label: `host path mount (${entry})` });
    if (socket) flags.push({ key: "socketAccess", label: `engine socket mount (${entry})` });
  }
  return flags;
}

// Fail closed: any dangerous option without its matching explicit grant is a
// denial. `payload.policyGrant` carries the grants (e.g.
// { privileged: true, hostMount: true }). Renderer confirmations are
// presentation only — this gate is the actual boundary.
function policeContainerRequest(payload = {}) {
  const flags = detectDangerousCreateOptions(payload);
  const grant = payload.policyGrant && typeof payload.policyGrant === "object" ? payload.policyGrant : {};
  const denied = flags.filter((flag) => grant[flag.key] !== true);
  const seen = new Set();
  const denials = denied.filter((flag) => {
    if (seen.has(flag.key)) return false;
    seen.add(flag.key);
    return true;
  });
  return { allowed: denials.length === 0, flags, denials };
}

// Volume data is the only current cleanup kind that touches persistent data;
// this classification must stay in lockstep with getCleanupPreview() so the
// preview and the enforcement gate can never disagree.
function cleanupAffectsPersistentData(kind) {
  return kind === "volumes";
}

function cleanupSelectionError() {
  const error = new Error("Volume pruning removes persistent container data. Confirm volume data removal explicitly.");
  error.code = "VOLUME_REMOVAL_CONFIRMATION_REQUIRED";
  error.statusCode = 400;
  return error;
}

// Enforced at the engine boundary (runCleanup) before any docker command runs.
function assertCleanupSelection(kind, confirmVolumeDataRemoval) {
  if (cleanupAffectsPersistentData(kind) && confirmVolumeDataRemoval !== true) {
    throw cleanupSelectionError();
  }
}

// docker -p forms: HOST, HOST:CONTAINER, IP:HOST:CONTAINER, IP::CONTAINER.
function parseHostPort(entry) {
  const text = String(entry ?? "").trim();
  if (!text) return null;
  const segments = text.split(":");
  const raw = segments.length === 1 ? segments[0] : segments[segments.length - 2];
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function normalizeHostPorts(payload = {}) {
  return splitList(payload.ports)
    .map(parseHostPort)
    .filter((port) => port !== null);
}

// Accepts either normalized "8080/tcp" strings or { hostPort } objects; a
// wanted port already bound on the host is reported as a conflict.
function detectHostPortConflicts(wantedPorts, runningBindings = []) {
  const bound = new Set();
  for (const binding of runningBindings) {
    const raw = typeof binding === "object" && binding !== null
      ? String(binding.hostPort ?? binding.HostPort ?? "")
      : String(binding ?? "");
    const port = Number.parseInt(raw.replace(/\/[a-z0-9]+$/i, ""), 10);
    if (Number.isInteger(port) && port > 0) bound.add(port);
  }
  return [...new Set(wantedPorts.filter((port) => bound.has(port)))];
}

function validateResourceLimits(payload = {}) {
  const problems = [];
  const memory = payload.memory;
  if (memory !== undefined && memory !== null && String(memory).trim() !== "") {
    if (!/^\d+(\.\d+)?[kmgt]?$/i.test(String(memory).trim())) {
      problems.push({ field: "memory", code: "INVALID_MEMORY_LIMIT", message: `Memory limit '${memory}' must be a size such as 512m or 2g.` });
    }
  }
  const cpus = payload.cpus;
  if (cpus !== undefined && cpus !== null && String(cpus).trim() !== "") {
    const value = Number(cpus);
    if (!Number.isFinite(value) || value <= 0) {
      problems.push({ field: "cpus", code: "INVALID_CPU_LIMIT", message: `CPU limit '${cpus}' must be a positive number.` });
    }
  }
  return problems;
}

module.exports = {
  assertCleanupSelection,
  cleanupAffectsPersistentData,
  detectDangerousCreateOptions,
  detectHostPortConflicts,
  inspectMountEntry,
  inspectVolumeEntry,
  isHostPathSource,
  normalizeHostPorts,
  parseHostPort,
  policeContainerRequest,
  validateResourceLimits,
};