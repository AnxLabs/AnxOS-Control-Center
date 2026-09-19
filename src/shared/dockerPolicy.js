// V2-C deny-by-default policy gate and preflight helpers
// (docs/v2/V2C_CONTAINERS_WAVE1.md §3.4–3.5): privileged containers, host
// path mounts, engine-socket mounts and host networking fail closed unless
// the caller carries an explicit per-flag grant; cleanup that touches
// persistent data (volumes) requires an explicit confirmation flag; preflight
// port, mount and resource-limit checks stay pure so they can be pinned
// hermetically without a Docker engine.

const DOCKER_SOCKET_HINT = /docker\.sock/i;

// Compose documents are parsed with js-yaml's safe default schema; a declared
// direct dependency (previously transitive) so the packaged agent runtime
// always resolves it.
const yaml = require("js-yaml");

// V2-I workload trust levels (src/shared/workloadTrustPolicy.js). This layer is
// ADDITIVE and can only ever add refusals: the deny-by-default grant gate below
// keeps its exact decisions, and a `policyGrant` can never lift a trust-level
// refusal. A grant answers "may this option ever be used on this host?"; the
// declared trust level answers "may THIS workload ask for it?". When the two
// disagree the stricter one wins.
const { evaluateWorkloadTrust } = require("./workloadTrustPolicy");

// A trust refusal is reported in the same { key, label } shape as a dangerous-
// option denial so every existing consumer (createContainer's error message,
// preflightContainerCreate's findings) names the exceeded capability without a
// second code path. The capability is part of the key so two refusals with the
// same code but different capabilities never collapse into one.
function trustDenialKey(item) {
  return `workloadTrust:${item.code}:${item.capability || "general"}`;
}

function toTrustDenial(item) {
  return { key: trustDenialKey(item), label: item.message, trust: true, capability: item.capability || null };
}

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
  // V2-I: the workload trust verdict is appended AFTER the grant filter, so an
  // explicit grant cannot lift a tier refusal (see the module note above).
  const trust = evaluateWorkloadTrust(payload, { kind: "container-create" });
  for (const item of trust.refusals) {
    const denial = toTrustDenial(item);
    if (denials.some((existing) => existing.key === denial.key)) continue;
    denials.push(denial);
  }
  return { allowed: denials.length === 0, flags, denials, trust };
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

// --- compose project policy (V2-C §3.5 applied to compose files) ---

// Evaluate one parsed compose service definition; pure.
function policeComposeService(service) {
  const flags = [];
  if (!service || typeof service !== "object") return flags;
  if (service.privileged === true) {
    flags.push({ key: "privileged", label: "privileged mode" });
  }
  if (service.network_mode === "host") {
    flags.push({ key: "hostNetwork", label: "host networking" });
  }
  if (service.pid === "host") {
    flags.push({ key: "hostPid", label: "host PID namespace" });
  }
  const volumes = Array.isArray(service.volumes) ? service.volumes : [];
  for (const entry of volumes) {
    if (typeof entry === "string") {
      const { hostPath, socket } = inspectVolumeEntry(entry);
      if (hostPath) flags.push({ key: "hostMount", label: `host path mount (${entry})` });
      if (socket) flags.push({ key: "socketAccess", label: `engine socket mount (${entry})` });
    } else if (entry && typeof entry === "object") {
      const source = String(entry.source || "");
      const type = entry.type === undefined ? undefined : String(entry.type);
      if ((type === "bind" || type === undefined) && isHostPathSource(source)) {
        flags.push({ key: "hostMount", label: `host path mount (${source})` });
      }
      if (DOCKER_SOCKET_HINT.test(source) || DOCKER_SOCKET_HINT.test(String(entry.target || ""))) {
        flags.push({ key: "socketAccess", label: `engine socket mount (${source})` });
      }
    }
  }
  return flags;
}

function policeComposeDocument(document, grant = {}) {
  const services = document && typeof document === "object"
    && document.services && typeof document.services === "object"
    ? document.services : {};
  const flags = [];
  for (const [name, service] of Object.entries(services)) {
    for (const flag of policeComposeService(service)) {
      flags.push({ service: name, ...flag });
    }
  }
  const denials = flags.filter((flag) => grant[flag.key] !== true);
  // V2-I: per-service trust verdict, appended after the grant filter for the
  // same reason as policeContainerRequest — a grant never lifts a tier refusal.
  // The compose service is evaluated as `compose-service` because the engine
  // executes the file itself, so `pid: host` is honored there (unlike the
  // container-create surface, which never emits --pid).
  for (const [name, service] of Object.entries(services)) {
    const trust = evaluateWorkloadTrust(service, { kind: "compose-service" });
    for (const item of trust.refusals) {
      const denial = { service: name, ...toTrustDenial(item) };
      if (denials.some((existing) => existing.key === denial.key && existing.service === name)) continue;
      denials.push(denial);
    }
  }
  return { services: Object.keys(services), flags, denials, allowed: denials.length === 0 };
}

// Parse + evaluate compose YAML text. Unparsable content fails closed
// (COMPOSE_POLICY_UNPARSEABLE decision lives in the caller): a document the
// policy cannot see must never silently bypass the gate. Oversized documents
// also fail closed — bounding the parse input neutralizes quadratic-CPU
// YAML DoS (js-yaml GHSA-5p4m-2wfm-xmqj / GHSA-2883-xcg3-v3hh) for the
// hostile-template case; real compose files are orders of magnitude smaller.
const MAX_COMPOSE_POLICY_BYTES = 256 * 1024;

function policeComposeYaml(yamlText, grant = {}) {
  const text = String(yamlText ?? "");
  if (text.length > MAX_COMPOSE_POLICY_BYTES) {
    return {
      parsed: false,
      parseError: `Compose document exceeds the ${MAX_COMPOSE_POLICY_BYTES} byte policy review limit.`,
      services: [],
      flags: [],
      denials: [],
      allowed: false,
    };
  }
  let document;
  try {
    document = yaml.load(text);
  } catch (error) {
    return {
      parsed: false,
      parseError: error?.message || "Unparsable compose document.",
      services: [],
      flags: [],
      denials: [],
      allowed: false,
    };
  }
  return { parsed: true, parseError: null, ...policeComposeDocument(document, grant) };
}

module.exports = {
  MAX_COMPOSE_POLICY_BYTES,
  assertCleanupSelection,
  cleanupAffectsPersistentData,
  detectDangerousCreateOptions,
  detectHostPortConflicts,
  inspectMountEntry,
  inspectVolumeEntry,
  isHostPathSource,
  normalizeHostPorts,
  parseHostPort,
  policeComposeDocument,
  policeComposeService,
  policeComposeYaml,
  policeContainerRequest,
  validateResourceLimits,
};