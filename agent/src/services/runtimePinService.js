// V2-D runtime pins (docs/MASTER_ROADMAP.md V2-D: "Resolve runtime versions
// per workload; avoid silently changing shared dependencies required by
// another service").
//
// When an install or check resolves a runtime version for a workload (for
// example bundled Java 21 for instance X), the resolution is recorded here.
// Before any dependency install or version-affecting update on a node, the
// dependency service consults these pins and refuses actions that would
// change the shared runtime underneath another workload's pin
// (RUNTIME_PINNED_BY_OTHER_WORKLOAD). Removing a pin is always an explicit
// operator action through the runtime-pins API.
//
// Per-node JSON store persisted next to the other agent-managed stores (same
// style as the restart-schedule file: atomic JSON writes, one dedicated
// directory, COPYFILE_EXCL corruption quarantine capped at one file).

const fs = require("fs/promises");
const path = require("path");

const { DEPENDENCY_REGISTRY, assertKnownDependencyId } = require("../../../src/shared/marketplaceDependencies");
const { getConfig } = require("../config");

const RUNTIME_PIN_SCHEMA_VERSION = 1;
const STORE_FILE_NAME = "runtime-pins.json";
const WORKLOAD_ID_MAX_LENGTH = 128;
const NODE_ID_MAX_LENGTH = 128;
const VERSION_MAX_LENGTH = 64;
const SOURCE_MAX_LENGTH = 64;

let configuredRoot = null;

// Test seams: the hermetic smoke injects a clock and an explicit root so no
// real machine state is required. Production values resolve lazily so a plain
// require of this module stays cheap.
const seams = {
  now: null,
};

function configureRuntimePinService(overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, "root")) {
    configuredRoot = overrides.root ? path.resolve(overrides.root) : null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "now")) {
    seams.now = overrides.now || null;
  }
}

function now() {
  return seams.now ? seams.now() : Date.now();
}

function nowIso(atMs = now()) {
  return new Date(atMs).toISOString();
}

function createRuntimePinError(code, message, details = {}, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, details });
}

// Mirror the agent config instance-root resolution (AGENT_INSTANCE_ROOT env
// fast path first, config fallback last) so smokes that pin AGENT_INSTANCE_ROOT
// never trigger agent-config side effects, while a desktop-shell-launched
// agent resolves the same directory family as backups/ and restart-schedules/.
function getPinRoot() {
  if (configuredRoot) return configuredRoot;
  const envRoot = String(process.env.AGENT_RUNTIME_PIN_ROOT || "").trim();
  if (envRoot) return path.resolve(envRoot);
  const instanceRoot = String(process.env.AGENT_INSTANCE_ROOT || "").trim();
  if (instanceRoot) return path.resolve(path.join(path.dirname(instanceRoot), "runtime-pins"));
  return path.resolve(path.join(path.dirname(getConfig().instanceRoot), "runtime-pins"));
}

function pinsPath() {
  return path.join(getPinRoot(), STORE_FILE_NAME);
}

async function ensurePinRoot() {
  await fs.mkdir(getPinRoot(), { recursive: true, mode: 0o700 });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

// Workload identity must stay permissive (marketplace options carry raw
// instance names, not only slugs) but bounded: no control characters, no
// empty values, no unbounded length.
function normalizeWorkloadInstanceId(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return null;
  if (text.length > WORKLOAD_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) {
    throw createRuntimePinError("INVALID_RUNTIME_PIN_WORKLOAD", "Runtime pin workload identifier is invalid.", { workloadId: null }, 400);
  }
  return text;
}

function normalizeNodeId(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return null;
  return text.slice(0, NODE_ID_MAX_LENGTH);
}

function normalizeResolvedVersion(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return null;
  return text.slice(0, VERSION_MAX_LENGTH);
}

function normalizePinSource(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return (text || "dependency-install").slice(0, SOURCE_MAX_LENGTH);
}

// Read-side defense only: entries that lost their identity (or reference a
// dependency the registry no longer knows) cannot drive the install guard, so
// they are dropped instead of trusted.
function sanitizePins(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    return entry
      && typeof entry === "object"
      && typeof entry.instanceId === "string"
      && entry.instanceId
      && typeof entry.pinnedAt === "string"
      && Boolean(DEPENDENCY_REGISTRY[entry.dependencyId]);
  });
}

async function readPinStore() {
  const filePath = pinsPath();
  if (!await fs.stat(filePath).then((stats) => stats.isFile(), () => false)) {
    return { schemaVersion: RUNTIME_PIN_SCHEMA_VERSION, pins: [] };
  }
  let parsed;
  try {
    parsed = await readJson(filePath);
  } catch (error) {
    // COPYFILE_EXCL caps the quarantine at one file (the restartSchedule
    // precedent): a persistently corrupt store hit on every install must not
    // grow the runtime-pins dir forever. The first capture is preserved.
    const backupPath = `${filePath}.corrupt`;
    await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL).catch(() => {});
    throw createRuntimePinError("RUNTIME_PIN_STORE_CORRUPT", "The runtime pin store is corrupt and was quarantined for inspection.", {
      causeCode: error?.code || "INVALID_JSON",
    }, 500);
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > RUNTIME_PIN_SCHEMA_VERSION) {
    throw createRuntimePinError("RUNTIME_PIN_SCHEMA_UNSUPPORTED", "The runtime pin store was written by a newer schema.", {
      schemaVersion,
      supportedSchemaVersion: RUNTIME_PIN_SCHEMA_VERSION,
    }, 409);
  }
  return { schemaVersion, pins: sanitizePins(parsed?.pins) };
}

async function writePinStore(pins) {
  await ensurePinRoot();
  await writeJson(pinsPath(), { schemaVersion: RUNTIME_PIN_SCHEMA_VERSION, pins });
}

// Serialize read-modify-write cycles so concurrent dependency checks cannot
// lose each other's pins through interleaved store rewrites.
let storeQueue = Promise.resolve();

function withStoreLock(task) {
  const run = storeQueue.then(task, task);
  storeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function pinMatches(pin, filter = {}) {
  if (filter.dependencyId && pin.dependencyId !== filter.dependencyId) return false;
  if (filter.instanceId && pin.instanceId !== filter.instanceId) return false;
  return true;
}

async function listRuntimePins(filter = {}) {
  const store = await readPinStore();
  const dependencyId = filter?.dependencyId ? String(filter.dependencyId) : null;
  if (dependencyId) assertKnownDependencyId(dependencyId);
  const instanceId = filter?.instanceId ? String(filter.instanceId) : null;
  return store.pins.filter((pin) => pinMatches(pin, { dependencyId, instanceId }));
}

async function upsertRuntimePin(record = {}) {
  const dependencyId = assertKnownDependencyId(record?.dependencyId);
  const instanceId = normalizeWorkloadInstanceId(record?.instanceId);
  const resolvedVersion = normalizeResolvedVersion(record?.resolvedVersion);
  const nodeId = normalizeNodeId(record?.nodeId);
  const source = normalizePinSource(record?.source);
  return withStoreLock(async () => {
    const store = await readPinStore();
    const existing = store.pins.find((pin) => pin.dependencyId === dependencyId && pin.instanceId === instanceId) || null;
    const pinnedAt = existing?.pinnedAt || nowIso();
    const pin = {
      dependencyId,
      instanceId,
      resolvedVersion,
      nodeId: nodeId ?? existing?.nodeId ?? null,
      pinnedAt,
      updatedAt: nowIso(),
      source,
    };
    const pins = existing
      ? store.pins.map((entry) => (entry === existing ? pin : entry))
      : [...store.pins, pin];
    await writePinStore(pins);
    return { pin, created: !existing };
  });
}

// Explicit operator unpin. A dependency-wide reset requires all: true so an
// omitted instanceId can never wipe other workloads' pins by accident.
async function removeRuntimePin(payload = {}) {
  const dependencyId = assertKnownDependencyId(payload?.dependencyId);
  const targetInstanceId = payload?.all === true ? null : normalizeWorkloadInstanceId(payload?.instanceId);
  if (!targetInstanceId && payload?.all !== true) {
    throw createRuntimePinError("RUNTIME_PIN_TARGET_REQUIRED", "An unpin request needs an instanceId, or all: true to reset every workload's pin for the dependency.", {
      dependencyId,
    }, 400);
  }
  return withStoreLock(async () => {
    const store = await readPinStore();
    const removedPins = store.pins.filter((pin) => pin.dependencyId === dependencyId && (!targetInstanceId || pin.instanceId === targetInstanceId));
    if (removedPins.length === 0) {
      return { dependencyId, instanceId: targetInstanceId, removed: false, removedCount: 0, removedPins: [] };
    }
    await writePinStore(store.pins.filter((pin) => !removedPins.includes(pin)));
    return { dependencyId, instanceId: targetInstanceId, removed: true, removedCount: removedPins.length, removedPins };
  });
}

// The install guard: return the oldest other-workload pin that a dependency
// install or version-affecting update on this node would disturb. A requester
// without a workload identity conflicts with every pin (fail-closed).
async function findConflictingRuntimePin({ dependencyId, requesterInstanceId } = {}) {
  const pins = await listRuntimePins({ dependencyId });
  const conflicts = pins.filter((pin) => pin.instanceId !== requesterInstanceId);
  conflicts.sort((left, right) => String(left.pinnedAt).localeCompare(String(right.pinnedAt)) || String(left.instanceId).localeCompare(String(right.instanceId)));
  return conflicts[0] || null;
}

module.exports = {
  configureRuntimePinService,
  findConflictingRuntimePin,
  listRuntimePins,
  normalizeWorkloadInstanceId,
  removeRuntimePin,
  upsertRuntimePin,
};
