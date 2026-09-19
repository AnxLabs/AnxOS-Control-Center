// V2-I workload trust levels, non-admin execution and resource-limit policy.
// (docs/MASTER_ROADMAP.md, milestone V2-I bullets 4–5.)
//
// WHAT THIS MODULE IS
// A pure, dependency-free classifier for *workload definitions*. It answers two
// questions with one verdict:
//   1. Which trust level does this definition actually demand, given the host
//      capabilities it requests (host mounts, host networking, published host
//      ports, host PID namespace, the privileged flag, an engine-socket mount,
//      device access)?
//   2. Does the level the caller *declared* cover that demand, and does the
//      declared level's own contract (non-admin execution, explicit resource
//      limits) actually hold?
//
// If the answer to (2) is no, the workload is REFUSED with a typed code that
// names the exceeded capability. It is never silently downgraded, and it is
// never silently upgraded into privileges it did not declare.
//
// NON-ADMIN EXECUTION
// A workload only counts as non-admin when the identity can be *positively*
// determined as non-root/non-admin from the definition. "I could not tell" is
// treated as NOT non-admin (fail closed). For containers that means a numeric
// non-zero uid (e.g. `user: "1000"` or `user: "1000:1000"`); a *named* user is
// refused as unverifiable, because whether `nobody` maps to uid 0 depends on
// the image's /etc/passwd and AnxOS does not inspect images. For process
// workloads the identity is always undetermined, because the AnxOS instance
// runtime never drops privileges.
//
// WHERE THE TRUST VERDICT IS ENFORCED
//   - src/shared/dockerPolicy.js — `policeContainerRequest` (container create)
//     and `policeComposeDocument` (compose services). The trust verdict is
//     ADDITIVE there: the existing deny-by-default grant gate keeps its exact
//     decisions, and the trust layer can only add refusals (the stricter of the
//     two always wins). A `policyGrant` can never lift a trust-level refusal,
//     because a grant answers "may this option ever be used on this host?" while
//     the declared level answers "may THIS workload ask for it?".
//   - src/shared/instances/instanceServiceCore.js — instance create/update.
//     A process workload that asks for a container-only capability (privileged,
//     host networking, host mounts, devices, host PID, engine socket) is now
//     refused instead of having the field silently ignored, and an instance may
//     not declare a level its own definition cannot justify.
//
// ===========================================================================
// RESIDUAL HOST PRIVILEGES — WHAT AnxOS CANNOT ISOLATE (read this before
// treating a level name as a security boundary; it is not one)
// ===========================================================================
//
// The level names describe *what AnxOS will let a workload declare and what it
// refuses*. They are a policy vocabulary, not a kernel-enforced sandbox. AnxOS
// ships no seccomp/AppArmor/SELinux profile management, no user-namespace
// remapping, no cgroup v2 controller wiring for process workloads, no
// filesystem ACL enforcement, no capability-bounding-set management, and no
// privilege-dropping for the workloads it launches itself.
//
// Shared (both supported hosts):
//   - A process workload runs as the identity that runs the Agent. If the Agent
//     runs as root/Administrator, so does every process workload. AnxOS never
//     changes that identity, so no process workload is ever `sandboxed`.
//   - `memoryLimit` is a launch hint (a JVM `-Xmx` argument for Minecraft), NOT
//     an OS-enforced memory ceiling. Total RSS can exceed it.
//   - The trust policy decides whether a workload may be CREATED. It does not
//     constrain what the workload does once running: it can read/write anything
//     its runtime identity can, listen on any interface that identity can, and
//     spawn children with the same identity.
//   - An operator with host shell access is outside this model entirely.
//   - The AnxOS management plane (IPC/API permissions) governs who may REQUEST
//     a workload. It is not part of the workload's runtime isolation.
//
// Windows:
//   - Process workloads run with the host user's full token; AnxOS applies no
//     Job Object CPU/memory/handle limits, no AppContainer, and no integrity
//     level change.
//   - Containers are isolated by Docker Desktop's own backend (a WSL2 or
//     Hyper-V Linux VM, or Windows containers). AnxOS configures nothing about
//     that backend and cannot verify its isolation settings.
//   - Docker Desktop's WSL2 backend shares the host filesystem by default;
//     a granted host mount there reaches real Windows paths.
//
// Linux:
//   - Process workloads run as the Agent's service user (root if the unit is
//     root). AnxOS applies no namespaces, no seccomp filter, no MAC profile and
//     no cgroup limits to them.
//   - For containers, AnxOS delegates all isolation to the Docker daemon and
//     cannot verify or enforce the daemon's seccomp profile, AppArmor profile,
//     userns-remap setting, rootless mode, or default capability set.
//   - A granted `privileged` container or a granted engine-socket mount is
//     effectively root on the host: it can escape the container trust model.
//     `host-privileged` means exactly that and is refused by default.
//   - Membership of the `docker` group is root-equivalent and is outside this
//     policy's control.
//
// Residual risk is therefore: a workload AnxOS calls `sandboxed` has a bounded
// host-exposure *surface* (no mounts, no host networking, no published ports,
// non-admin identity, explicit limits) but is NOT kernel-isolated by AnxOS, and
// a `host-privileged` workload is by definition able to act as the host user.

"use strict";

/**
 * @typedef {"sandboxed" | "standard" | "elevated" | "host-privileged"} TrustLevel
 * @typedef {"container-create" | "compose-service" | "process"} WorkloadKind
 * @typedef {{
 *   privileged: boolean,
 *   hostMount: boolean,
 *   hostNetwork: boolean,
 *   hostPid: boolean,
 *   engineSocket: boolean,
 *   deviceAccess: boolean,
 *   publishedHostPorts: boolean,
 * }} CapabilitySet
 * @typedef {{
 *   code: string,
 *   capability: string | null,
 *   message: string,
 *   statusCode: number,
 *   declaredTier: TrustLevel | null,
 *   requiredTier: TrustLevel | null,
 * }} TrustRefusal
 * @typedef {{
 *   nonAdmin: boolean,
 *   source: string,
 *   detail: string,
 *   requestedNonAdminIdentity: boolean,
 * }} ExecutionIdentity
 * @typedef {{
 *   kind: WorkloadKind,
 *   declaredTier: TrustLevel | null,
 *   declaredTierValid: boolean,
 *   requiredTier: TrustLevel | null,
 *   effectiveTier: TrustLevel | null,
 *   allowed: boolean,
 *   refusals: TrustRefusal[],
 *   capabilities: CapabilitySet,
 *   capabilityLabels: string[],
 *   identity: ExecutionIdentity,
 *   limits: { memory: string | null, cpus: string | null, present: Record<string, boolean>, required: string[], missing: string[] },
 * }} TrustVerdict
 */

// Typed refusal codes. Callers surface these verbatim (the instance path maps
// them into createInstanceError, the docker path into denial labels), so they
// are part of the contract.
const TRUST_REFUSAL_CODES = Object.freeze({
  DECLARATION_INVALID: "WORKLOAD_TRUST_DECLARATION_INVALID",
  TIER_EXCEEDED: "WORKLOAD_TRUST_TIER_EXCEEDED",
  CAPABILITY_UNSUPPORTED: "WORKLOAD_TRUST_CAPABILITY_UNSUPPORTED",
  NON_ADMIN_REQUIRED: "WORKLOAD_TRUST_NON_ADMIN_REQUIRED",
  RESOURCE_LIMITS_REQUIRED: "WORKLOAD_TRUST_RESOURCE_LIMITS_REQUIRED",
});

// Ascending host-exposure ladder. Rank order is the ladder itself; the boolean
// columns are the allow/deny table the roadmap bullet asks for. The per-
// capability "floor" (see CAPABILITY_FLOORS) is DERIVED from these columns, so
// the table and the computed required level can never disagree.
//
// Column meanings (all "may this workload request this at this level?"):
//   hostMounts            host path / bind mount
//   hostNetworking        host network namespace (Docker `--network host`)
//   hostPid               host PID namespace (compose `pid: host`)
//   privileged            Docker privileged mode
//   engineSocket          engine socket mount (/var/run/docker.sock)
//   deviceAccess          explicit host device passthrough
//   publishedHostPorts    publishing a port on the host (`-p`, `ports:`)
//
// Contract columns:
//   requiresNonAdminExecution  the level promises a non-root/non-admin identity
//   requiredResourceLimits     fields a definition MUST supply when it declares
//                              this level (empty = the declaration carries no
//                              bounds requirement)
//
// deviceAccess is `false` at every level on purpose: no shipped AnxOS execution
// path (container create or compose review) emits a device passthrough, so the
// capability has no floor and is always refused rather than silently dropped.
const TRUST_LEVELS = Object.freeze(["sandboxed", "standard", "elevated", "host-privileged"]);

const TRUST_LEVEL_TABLE = Object.freeze({
  sandboxed: Object.freeze({
    rank: 0,
    hostMounts: false,
    hostNetworking: false,
    hostPid: false,
    privileged: false,
    engineSocket: false,
    deviceAccess: false,
    publishedHostPorts: false,
    requiresNonAdminExecution: true,
    requiredResourceLimits: Object.freeze(["memory", "cpus"]),
  }),
  standard: Object.freeze({
    rank: 1,
    hostMounts: false,
    hostNetworking: false,
    hostPid: false,
    privileged: false,
    engineSocket: false,
    deviceAccess: false,
    publishedHostPorts: false,
    requiresNonAdminExecution: false,
    requiredResourceLimits: Object.freeze(["memory"]),
  }),
  elevated: Object.freeze({
    rank: 2,
    hostMounts: true,
    hostNetworking: true,
    hostPid: false,
    privileged: false,
    engineSocket: false,
    deviceAccess: false,
    publishedHostPorts: true,
    requiresNonAdminExecution: false,
    requiredResourceLimits: Object.freeze(["memory"]),
  }),
  "host-privileged": Object.freeze({
    rank: 3,
    hostMounts: true,
    hostNetworking: true,
    hostPid: true,
    privileged: true,
    engineSocket: true,
    deviceAccess: false,
    publishedHostPorts: true,
    requiresNonAdminExecution: false,
    requiredResourceLimits: Object.freeze(["memory", "cpus"]),
  }),
});

// Capability -> the table column that decides it, plus the human label used in
// refusal messages. Labels are the vocabulary an operator sees, so they name
// the exact requested thing rather than the internal key.
const CAPABILITY_TABLE_COLUMN = Object.freeze({
  privileged: "privileged",
  hostMount: "hostMounts",
  hostNetwork: "hostNetworking",
  hostPid: "hostPid",
  engineSocket: "engineSocket",
  deviceAccess: "deviceAccess",
  publishedHostPorts: "publishedHostPorts",
});

const CAPABILITY_LABELS = Object.freeze({
  privileged: "privileged mode",
  hostMount: "host path mount",
  hostNetwork: "host networking",
  hostPid: "host PID namespace",
  engineSocket: "engine socket mount",
  deviceAccess: "device access",
  publishedHostPorts: "published host ports",
});

const CAPABILITY_KEYS = Object.freeze(Object.keys(CAPABILITY_TABLE_COLUMN));

// Which capabilities each execution path can ACTUALLY honor. A capability that
// a kind cannot honor is refused outright — never accepted and then ignored,
// which would be a silent downgrade.
//
//   container-create   dockerService.createContainer emits --privileged,
//                      --network, -p, -v/--mount. It does NOT emit --device or
//                      --pid, so those cannot be honored here.
//   compose-service    the compose file is executed by the engine itself, so
//                      pid: host IS honored. Device passthrough still is not
//                      emitted by any AnxOS path.
//   process            the instance runtime launches a host process and binds
//                      its declared ports. It has no container features at all,
//                      and it never drops privileges, so every container
//                      capability and any requested non-admin identity is
//                      unhonorable.
const HONORED_CAPABILITIES = Object.freeze({
  "container-create": Object.freeze([
    "privileged", "hostMount", "hostNetwork", "engineSocket", "publishedHostPorts",
  ]),
  "compose-service": Object.freeze([
    "privileged", "hostMount", "hostNetwork", "hostPid", "engineSocket", "publishedHostPorts",
  ]),
  process: Object.freeze(["publishedHostPorts"]),
});

const WORKLOAD_KINDS = Object.freeze(Object.keys(HONORED_CAPABILITIES));

// The minimum level that permits each capability, derived from the table so the
// two can never drift. A capability no level permits has floor null.
const CAPABILITY_FLOORS = Object.freeze(CAPABILITY_KEYS.reduce((floors, capability) => {
  const column = CAPABILITY_TABLE_COLUMN[capability];
  const permitting = TRUST_LEVELS.filter((level) => TRUST_LEVEL_TABLE[level][column] === true);
  floors[capability] = permitting.length > 0 ? permitting[0] : null;
  return floors;
}, {}));

// Accepted spellings of the trust declaration. `x-anxos-trust-level` is the
// compose annotation form: Compose ignores `x-` extension keys, so a compose
// service can carry a trust declaration without breaking `docker compose`.
const DECLARATION_FIELDS = Object.freeze(["trustLevel", "trust_level", "workloadTrustLevel", "x-anxos-trust-level"]);

const KNOWN_LEVEL_TEXT = TRUST_LEVELS.join(", ");

// ---------------------------------------------------------------------------
// Pure helpers (kept local so the module stays dependency-free; dockerPolicy
// requires this module, so requiring it back would be a cycle).
// ---------------------------------------------------------------------------

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isHostPathSource(source) {
  return /^[/\\]/.test(source) || /^[a-zA-Z]:[\\/]/.test(source);
}

const DOCKER_SOCKET_HINT = /docker\.sock/i;

// `-v /host/path:/ctr/path[:mode]` | `-v name:/ctr/path` | `-v /ctr/path`.
// Mirrors dockerPolicy's short-syntax reader (including the Windows drive
// prefix spanning two segments).
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

// `--mount type=bind,source=/host,target=/ctr[,readonly]` and the compose
// long-form object variant.
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

function isNonEmpty(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return String(value).trim() !== "";
}

function emptyCapabilities() {
  return CAPABILITY_KEYS.reduce((caps, key) => {
    caps[key] = false;
    return caps;
  }, {});
}

/**
 * Detect the host capabilities a workload definition requests.
 *
 * Pure and total: an unparsable/absent field is simply "not requested". The
 * only deliberate asymmetry is device access, which is a real request whenever
 * the field is present, because AnxOS cannot honor it at all.
 *
 * @param {object} definition
 * @param {TrustLevel} [_kind] reserved; detection is kind-independent because a
 *   capability is a property of the *request*, and whether the kind can honor
 *   it is decided separately by HONORED_CAPABILITIES.
 * @returns {CapabilitySet}
 */
function detectCapabilities(definition = {}) {
  const caps = emptyCapabilities();
  const source = definition && typeof definition === "object" ? definition : {};

  caps.privileged = source.privileged === true;
  caps.hostNetwork = source.network === "host" || source.networkMode === "host" || source.network_mode === "host";
  caps.hostPid = source.pid === "host" || source.pidMode === "host" || source.pid_mode === "host";
  caps.deviceAccess = isNonEmpty(source.devices) || isNonEmpty(source.device);
  caps.publishedHostPorts = isNonEmpty(source.ports) || isNonEmpty(source.port);

  for (const entry of splitList(source.volumes)) {
    const { hostPath, socket } = inspectVolumeEntry(entry);
    if (hostPath) caps.hostMount = true;
    if (socket) caps.engineSocket = true;
  }

  for (const entry of splitList(source.binds || source.mounts)) {
    const { hostPath, socket } = inspectMountEntry(entry);
    if (hostPath) caps.hostMount = true;
    if (socket) caps.engineSocket = true;
  }

  // Compose long-form volumes arrive as objects, not strings.
  const longForm = Array.isArray(source.volumes) ? source.volumes : [];
  for (const entry of longForm) {
    if (!entry || typeof entry !== "object") continue;
    const entrySource = String(entry.source || "");
    const type = entry.type === undefined ? undefined : String(entry.type);
    if ((type === "bind" || type === undefined) && isHostPathSource(entrySource)) caps.hostMount = true;
    if (DOCKER_SOCKET_HINT.test(entrySource) || DOCKER_SOCKET_HINT.test(String(entry.target || ""))) {
      caps.engineSocket = true;
    }
  }

  return caps;
}

/** @returns {string[]} human labels for the requested capabilities. */
function capabilityLabels(capabilities = {}) {
  return CAPABILITY_KEYS.filter((key) => capabilities[key] === true).map((key) => CAPABILITY_LABELS[key]);
}

/** The lowest level whose table permits the capability, or null if none does. */
function capabilityFloor(capability) {
  return CAPABILITY_FLOORS[capability] ?? null;
}

function capabilityAllowedAt(level, capability) {
  const row = TRUST_LEVEL_TABLE[level];
  if (!row) return false;
  return row[CAPABILITY_TABLE_COLUMN[capability]] === true;
}

/**
 * The minimum level this capability set demands. Starts at `standard` because
 * `sandboxed` is a positive promise (non-admin identity + explicit bounds) that
 * a workload must qualify for, not a level a definition can be forced into.
 *
 * @param {CapabilitySet} capabilities
 * @returns {TrustLevel | null} null when a requested capability has no floor
 *   (it is unsupported by every level and the caller must refuse it).
 */
function requiredTierForCapabilities(capabilities = {}) {
  let rank = TRUST_LEVEL_TABLE.standard.rank;
  for (const key of CAPABILITY_KEYS) {
    if (capabilities[key] !== true) continue;
    const floor = capabilityFloor(key);
    if (floor === null) return null;
    rank = Math.max(rank, TRUST_LEVEL_TABLE[floor].rank);
  }
  return TRUST_LEVELS.find((level) => TRUST_LEVEL_TABLE[level].rank === rank) || "standard";
}

/**
 * Determine whether a workload runs as a non-root/non-admin identity.
 * FAIL CLOSED: anything not positively provable as non-admin is NOT non-admin.
 *
 * @param {object} definition
 * @param {WorkloadKind} kind
 * @returns {ExecutionIdentity}
 */
function resolveExecutionIdentity(definition = {}, kind = "container-create") {
  const source = definition && typeof definition === "object" ? definition : {};
  const rawRunAs = source.runAs ?? source.user;
  const requestedNonAdminIdentity = rawRunAs !== undefined && rawRunAs !== null && String(rawRunAs).trim() !== "";

  if (kind === "process") {
    // The instance runtime never drops privileges, so a process workload cannot
    // run under a chosen identity even if one is named. Report it as a request
    // so the caller can refuse it instead of pretending it was honored.
    return {
      nonAdmin: false,
      source: "process-runtime-fixed-identity",
      detail: "process workloads run as the AnxOS Agent identity; AnxOS cannot drop privileges for them",
      requestedNonAdminIdentity,
    };
  }

  const raw = String(rawRunAs ?? "").trim();
  if (!raw) {
    return {
      nonAdmin: false,
      source: "container-image-default",
      detail: "no user override supplied, so the container runs as the image's default user (root in most images)",
      requestedNonAdminIdentity: false,
    };
  }

  const userPart = raw.split(":")[0].trim();
  if (userPart === "" || userPart === "0" || /^root$/i.test(userPart)) {
    return {
      nonAdmin: false,
      source: "container-user-root",
      detail: `user override '${raw}' resolves to root (uid 0)`,
      requestedNonAdminIdentity: true,
    };
  }
  if (/^\d+$/.test(userPart)) {
    return {
      nonAdmin: true,
      source: "container-user-numeric-uid",
      detail: `user override '${raw}' is the non-root numeric uid ${userPart}`,
      requestedNonAdminIdentity: true,
    };
  }
  // A named non-root user cannot be verified without reading the image's
  // /etc/passwd, where the name could still map to uid 0.
  return {
    nonAdmin: false,
    source: "container-user-unverifiable-name",
    detail: `user override '${raw}' names a user whose uid AnxOS cannot verify as non-root without inspecting the image`,
    requestedNonAdminIdentity: true,
  };
}

/**
 * Read the resource limits a definition supplies. Presence only — value shape is
 * validated by the existing dockerPolicy.validateResourceLimits at the docker
 * boundary, so the two never disagree about what "a memory limit" looks like.
 *
 * @param {object} definition
 */
function inspectResourceLimits(definition = {}) {
  const source = definition && typeof definition === "object" ? definition : {};
  const pick = (...candidates) => {
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const text = String(candidate).trim();
      if (text !== "") return text;
    }
    return null;
  };
  const memory = pick(source.memory, source.memoryLimit, source["mem_limit"]);
  const cpus = pick(source.cpus, source.cpuLimit, source.cpu, source["cpu_limit"]);
  return {
    memory,
    cpus,
    present: { memory: memory !== null, cpus: cpus !== null },
  };
}

/** Read the declared level from any accepted spelling. */
function readDeclaredTier(definition = {}) {
  const source = definition && typeof definition === "object" ? definition : {};
  for (const field of DECLARATION_FIELDS) {
    const raw = source[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    return String(raw).trim().toLowerCase();
  }
  return null;
}

function refusal(code, { capability = null, message, statusCode, declaredTier = null, requiredTier = null }) {
  return { code, capability, message, statusCode, declaredTier, requiredTier };
}

function describeCapabilityList(labels) {
  return labels.length === 1 ? labels[0] : labels.join(", ");
}

/**
 * Classify a workload definition and decide whether it may run.
 * Pure: no I/O, no environment reads, no mutation of the input.
 *
 * @param {object} definition
 * @param {{ kind?: WorkloadKind }} [options]
 * @returns {TrustVerdict}
 */
function evaluateWorkloadTrust(definition = {}, options = {}) {
  const kind = WORKLOAD_KINDS.includes(options.kind) ? options.kind : "container-create";
  const capabilities = detectCapabilities(definition);
  const identity = resolveExecutionIdentity(definition, kind);
  const limits = inspectResourceLimits(definition);
  const declaredRaw = readDeclaredTier(definition);
  const refusals = [];

  const declaredTierValid = declaredRaw === null || TRUST_LEVELS.includes(declaredRaw);
  const declaredTier = declaredTierValid ? declaredRaw : null;

  if (!declaredTierValid) {
    refusals.push(refusal(TRUST_REFUSAL_CODES.DECLARATION_INVALID, {
      capability: "trustLevel",
      statusCode: 400,
      message: `Workload trust: unknown trust level '${declaredRaw}'. Known levels are: ${KNOWN_LEVEL_TEXT}.`,
    }));
  }

  // 1. Capabilities the execution path cannot honor. Refused regardless of the
  // declared level, because accepting them would silently ignore the request.
  const honored = HONORED_CAPABILITIES[kind];
  const unsupported = CAPABILITY_KEYS.filter((key) => capabilities[key] === true && !honored.includes(key));
  if (unsupported.length > 0) {
    refusals.push(refusal(TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED, {
      capability: unsupported[0],
      statusCode: 403,
      message: `Workload trust: '${describeCapabilityList(unsupported.map((key) => CAPABILITY_LABELS[key]))}' cannot be honored by a ${kind} workload. AnxOS refuses the request instead of silently ignoring it.`,
    }));
  }

  // 2. A capability no level permits (device access) has no floor, so no
  // declaration could ever cover it.
  const floorless = CAPABILITY_KEYS.filter(
    (key) => capabilities[key] === true && capabilityFloor(key) === null,
  );
  if (floorless.length > 0) {
    refusals.push(refusal(TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED, {
      capability: floorless[0],
      statusCode: 403,
      message: `Workload trust: '${describeCapabilityList(floorless.map((key) => CAPABILITY_LABELS[key]))}' is not permitted at any trust level; AnxOS does not expose it.`,
    }));
  }

  const requiredTier = floorless.length > 0 ? null : requiredTierForCapabilities(capabilities);

  // A process workload cannot run under a chosen identity at all: the instance
  // runtime launches the process as the Agent's own identity and never drops
  // privileges. Accepting `user`/`runAs` would silently ignore the request, so
  // it is refused here instead.
  if (kind === "process" && identity.requestedNonAdminIdentity) {
    refusals.push(refusal(TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED, {
      capability: "nonAdminExecution",
      statusCode: 403,
      message: "Workload trust: a process workload cannot run under a chosen non-admin identity (user/runAs). The AnxOS instance runtime does not drop privileges, so the declaration is refused rather than silently ignored.",
    }));
  }

  // 3. The declared level must cover every capability the definition requests.
  // A declared level BELOW the requirement is refused; a declared level above it
  // is accepted (under-declaring hides risk, over-declaring only costs rights).
  if (declaredTier !== null) {
    const uncovered = CAPABILITY_KEYS.filter(
      (key) => capabilities[key] === true && capabilityFloor(key) !== null && !capabilityAllowedAt(declaredTier, key),
    );
    if (uncovered.length > 0) {
      const needed = requiredTierForCapabilities(capabilities);
      refusals.push(refusal(TRUST_REFUSAL_CODES.TIER_EXCEEDED, {
        capability: uncovered[0],
        statusCode: 403,
        declaredTier,
        requiredTier: needed,
        message: `Workload trust: declared level '${declaredTier}' does not cover '${describeCapabilityList(uncovered.map((key) => CAPABILITY_LABELS[key]))}', which requires '${needed}'. Declare the required level explicitly; AnxOS never silently downgrades a workload.`,
      }));
    }
  }

  // 4. The declared level's own contract. Only a DECLARED level is held to
  // these promises: legacy definitions that declare nothing keep the behavior
  // they had before this policy existed (the existing docker gate and instance
  // validation still apply unchanged).
  const contractTier = declaredTier !== null ? declaredTier : null;
  let requiredLimits = [];
  let missingLimits = [];
  if (contractTier !== null) {
    const row = TRUST_LEVEL_TABLE[contractTier];
    if (row.requiresNonAdminExecution && identity.nonAdmin !== true) {
      refusals.push(refusal(TRUST_REFUSAL_CODES.NON_ADMIN_REQUIRED, {
        capability: "nonAdminExecution",
        statusCode: 403,
        declaredTier: contractTier,
        requiredTier: requiredTierForCapabilities(capabilities),
        message: `Workload trust: level '${contractTier}' promises non-admin execution, but the identity could not be confirmed as non-root/non-admin (${identity.detail}). AnxOS fails closed rather than promising isolation it cannot deliver.`,
      }));
    }
    requiredLimits = [...row.requiredResourceLimits];
    missingLimits = requiredLimits.filter((field) => limits.present[field] !== true);
    if (missingLimits.length > 0) {
      refusals.push(refusal(TRUST_REFUSAL_CODES.RESOURCE_LIMITS_REQUIRED, {
        capability: `resourceLimits:${missingLimits.join("+")}`,
        statusCode: 400,
        declaredTier: contractTier,
        requiredTier: requiredTierForCapabilities(capabilities),
        message: `Workload trust: level '${contractTier}' requires explicit resource limits (${requiredLimits.join(", ")}); missing: ${missingLimits.join(", ")}.`,
      }));
    }
  }

  const effectiveTier = declaredTier !== null ? declaredTier : requiredTier;

  return {
    kind,
    declaredTier,
    declaredTierValid,
    requiredTier,
    effectiveTier,
    allowed: refusals.length === 0,
    refusals,
    capabilities,
    capabilityLabels: capabilityLabels(capabilities),
    identity,
    limits: { ...limits, required: requiredLimits, missing: missingLimits },
  };
}

/**
 * Throwing form of evaluateWorkloadTrust: throws the first refusal as an Error
 * carrying `code`, `statusCode`, `capability` and `refusals`. Used by callers
 * that surface a plain error (the instance path maps the code into
 * createInstanceError; the docker path maps refusals into denial entries).
 *
 * @param {object} definition
 * @param {{ kind?: WorkloadKind }} [options]
 * @returns {TrustVerdict}
 */
function assertWorkloadTrust(definition = {}, options = {}) {
  const verdict = evaluateWorkloadTrust(definition, options);
  if (verdict.allowed) return verdict;
  const primary = verdict.refusals[0];
  const error = new Error(primary.message);
  error.code = primary.code;
  error.statusCode = primary.statusCode;
  error.capability = primary.capability;
  error.trustVerdict = verdict;
  error.refusals = verdict.refusals;
  throw error;
}

// Machine-readable copy of the module-header residual-privilege statement, so
// tooling and smokes can assert the documentation exists and pin its content
// without scraping prose.
const RESIDUAL_HOST_PRIVILEGES = Object.freeze({
  summary: "Trust-level names describe what AnxOS lets a workload declare and what it refuses. They are not a kernel-enforced security boundary. AnxOS ships no seccomp/AppArmor/SELinux profile management, no user-namespace remapping, no cgroup v2 controller wiring for process workloads, no filesystem ACL enforcement, no capability-bounding-set management, and no privilege dropping for the workloads it launches.",
  shared: Object.freeze([
    "A process workload runs as the identity that runs the Agent; if the Agent is root/Administrator, so is the workload. No process workload is ever 'sandboxed'.",
    "memoryLimit is a launch hint (a JVM -Xmx argument), not an OS-enforced memory ceiling; total RSS can exceed it.",
    "The policy decides whether a workload may be created; it does not constrain what the workload does once running with its runtime identity.",
    "An operator with host shell access is outside this model entirely.",
    "Management-plane IPC/API permissions govern who may REQUEST a workload, not the workload's runtime isolation.",
  ]),
  windows: Object.freeze([
    "Process workloads run with the host user's full token: no Job Object CPU/memory/handle limits, no AppContainer, no integrity-level change.",
    "Containers are isolated by Docker Desktop's own backend (WSL2/Hyper-V Linux VM or Windows containers); AnxOS configures and verifies nothing about that isolation.",
    "Docker Desktop's WSL2 backend shares the host filesystem by default, so a granted host mount there reaches real Windows paths.",
  ]),
  linux: Object.freeze([
    "Process workloads run as the Agent's service user (root if the unit is root): no namespaces, no seccomp filter, no MAC profile, no cgroup limits applied by AnxOS.",
    "Container isolation is delegated entirely to the Docker daemon; AnxOS cannot verify or enforce its seccomp profile, AppArmor profile, userns-remap setting, rootless mode, or default capability set.",
    "A granted privileged container or engine-socket mount is root-equivalent on the host and escapes the container trust model; 'host-privileged' means exactly that and is denied by default.",
    "Membership of the docker group is root-equivalent and is outside this policy's control.",
  ]),
});

module.exports = {
  CAPABILITY_FLOORS,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  HONORED_CAPABILITIES,
  RESIDUAL_HOST_PRIVILEGES,
  TRUST_DECLARATION_FIELDS: DECLARATION_FIELDS,
  TRUST_LEVELS,
  TRUST_LEVEL_TABLE,
  TRUST_REFUSAL_CODES,
  WORKLOAD_KINDS,
  assertWorkloadTrust,
  capabilityAllowedAt,
  capabilityFloor,
  capabilityLabels,
  detectCapabilities,
  evaluateWorkloadTrust,
  inspectResourceLimits,
  readDeclaredTier,
  requiredTierForCapabilities,
  resolveExecutionIdentity,
};