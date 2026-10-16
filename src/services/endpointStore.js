"use strict";

/**
 * Endpoint registry persistence for `<configDirectory>/endpoints.json`.
 *
 * Document shape:
 *   {
 *     schemaVersion: 1,
 *     endpoints: [],
 *     providerSyncs: { [nodeId]: { providerId, lastSyncAt, state, tunnelCount, errorCode } },
 *     legacyMigration: { appliedAt, source, imported, skipped, reasons } | null
 *   }
 *
 * Guarantees:
 * - Atomic write (tmp + rename, mode 0o600) and tolerant load.
 * - A corrupt file is preserved byte-for-byte as `<file>.corrupt-<timestamp>` and the
 *   store starts empty (`loadReport.corrupt = true`, code ENDPOINT_STORE_CORRUPT).
 *   Nothing is ever silently deleted.
 * - A future schemaVersion throws ENDPOINT_SCHEMA_UNSUPPORTED from load() and the
 *   file is left untouched.
 * - Schema migrations run behind the migrationRecoveryPolicy guard: a recovery point
 *   `<file>.schema-v<from>.backup` must be taken, read back, and verified before the
 *   rewrite. No older schema version exists yet (v1 is current); the guard path is in
 *   place for future versions.
 * - Legacy Public Access records (`public-access-services.json`, read-only) are
 *   migrated once into endpoint records.
 *
 * This module never requires electron at load time; the electron userData path is
 * resolved lazily inside the config-directory resolver, mirroring nodeService.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
  buildEndpointId,
  endpointKey,
  normalizeEndpointRecord,
  sortEndpoints,
  validateEndpointInput,
} = require("../shared/endpointModel");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../shared/migrationRecoveryPolicy");

const ENDPOINT_SCHEMA_VERSION = 1;
const ENDPOINTS_FILE_NAME = "endpoints.json";
const LEGACY_ACCESS_SERVICES_FILE_NAME = "public-access-services.json";
const MAX_OPTION_ENDPOINTS_PER_SERVICE = 3;
const MAX_RECORDED_REASONS = 100;
const MAX_ENDPOINT_NAME_LENGTH = 120;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROVIDER_SYNC_FIELDS = Object.freeze(["providerId", "lastSyncAt", "state", "tunnelCount", "errorCode"]);

let cachedElectronApp;
let electronAppResolved = false;

function getElectronApp() {
  if (electronAppResolved) return cachedElectronApp;
  electronAppResolved = true;
  cachedElectronApp = null;
  try {
    const electron = require("electron");
    cachedElectronApp = electron && electron.app ? electron.app : null;
  } catch {
    cachedElectronApp = null;
  }
  return cachedElectronApp;
}

function resolveConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try {
    const app = getElectronApp();
    return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config");
  } catch {
    return path.join(process.cwd(), "config");
  }
}

function createStoreError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function setOwnProperty(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function normalizeIsoNow(value) {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return new Date().toISOString();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(input, key) {
  return isPlainObject(input) && Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

function cloneRecord(record) {
  if (!record || typeof record !== "object") return null;
  const clone = { ...record };
  if (isPlainObject(record.metadata)) clone.metadata = { ...record.metadata };
  if (isPlainObject(record.health)) clone.health = { ...record.health };
  return clone;
}

function emptyDocument() {
  return {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    endpoints: [],
    providerSyncs: {},
    legacyMigration: null,
  };
}

function normalizeProviderSyncEntry(entry) {
  if (!isPlainObject(entry)) return null;
  return {
    providerId: typeof entry.providerId === "string" ? entry.providerId : null,
    lastSyncAt: typeof entry.lastSyncAt === "string" ? entry.lastSyncAt : null,
    state: typeof entry.state === "string" ? entry.state : null,
    tunnelCount: Number.isInteger(entry.tunnelCount) && entry.tunnelCount >= 0 ? entry.tunnelCount : null,
    errorCode: typeof entry.errorCode === "string" ? entry.errorCode : null,
  };
}

function normalizeProviderSyncs(raw) {
  const syncs = {};
  if (!isPlainObject(raw)) return syncs;
  for (const key of Object.keys(raw)) {
    const entry = normalizeProviderSyncEntry(raw[key]);
    if (entry) setOwnProperty(syncs, String(key), entry);
  }
  return syncs;
}

function normalizeLegacyMigration(raw) {
  if (!isPlainObject(raw)) return null;
  const appliedAt = typeof raw.appliedAt === "string" && raw.appliedAt.trim() !== "" ? raw.appliedAt : null;
  if (!appliedAt) return null;
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons
        .filter((entry) => isPlainObject(entry))
        .slice(0, MAX_RECORDED_REASONS)
        .map((entry) => ({
          ref: typeof entry.ref === "string" ? entry.ref : entry.ref === null ? null : null,
          reason: typeof entry.reason === "string" ? entry.reason : "unknown",
        }))
    : [];
  return {
    appliedAt,
    source: typeof raw.source === "string" ? raw.source : null,
    imported: Number.isInteger(raw.imported) && raw.imported >= 0 ? raw.imported : 0,
    skipped: Number.isInteger(raw.skipped) && raw.skipped >= 0 ? raw.skipped : 0,
    reasons,
  };
}

function normalizeDocument(parsed) {
  const rawEndpoints = Array.isArray(parsed?.endpoints) ? parsed.endpoints : [];
  const endpoints = [];
  const seenIds = new Set();
  const seenKeys = new Set();
  for (const raw of rawEndpoints) {
    const record = normalizeEndpointRecord(raw);
    if (!record) continue;
    const key = endpointKey(record);
    if (seenIds.has(record.id) || seenKeys.has(key)) continue;
    seenIds.add(record.id);
    seenKeys.add(key);
    endpoints.push(record);
  }
  return {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    endpoints,
    providerSyncs: normalizeProviderSyncs(parsed?.providerSyncs),
    legacyMigration: normalizeLegacyMigration(parsed?.legacyMigration),
  };
}

function serializeDocument(document) {
  return {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    endpoints: document.endpoints,
    providerSyncs: document.providerSyncs,
    legacyMigration: document.legacyMigration,
  };
}

function normalizeLegacyPort(value) {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) return null;
  return value;
}

function normalizeLegacyProtocol(value, allowed, fallback) {
  const protocol = String(value || "").trim().toLowerCase();
  return allowed.has(protocol) ? protocol : fallback;
}

function sanitizeCandidateName(base, suffix) {
  const cleanBase = String(base || "").trim() || "Access service";
  const cleanSuffix = String(suffix || "").trim();
  if (!cleanSuffix) return cleanBase.slice(0, MAX_ENDPOINT_NAME_LENGTH);
  const maxBase = Math.max(1, MAX_ENDPOINT_NAME_LENGTH - cleanSuffix.length - 3);
  return `${cleanBase.slice(0, maxBase)} (${cleanSuffix})`;
}

function stripScheme(value) {
  const text = String(value || "").trim();
  const match = text.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i);
  return match ? match[1] : text;
}

function parseLegacyHostPort(value, fallbackPort) {
  let text = stripScheme(value).replace(/\/+$/, "").trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end === -1) return null;
    const host = text.slice(1, end).trim();
    if (!host) return null;
    const rest = text.slice(end + 1);
    let port = fallbackPort;
    if (rest.startsWith(":")) {
      const parsed = Number.parseInt(rest.slice(1), 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) port = parsed;
    }
    return { host, port: port ?? null };
  }
  const colon = text.lastIndexOf(":");
  if (colon !== -1 && text.indexOf(":") === colon) {
    const host = text.slice(0, colon).trim();
    const parsed = Number.parseInt(text.slice(colon + 1), 10);
    if (!host) return null;
    const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallbackPort ?? null;
    return { host, port };
  }
  return { host: text, port: fallbackPort ?? null };
}

function hostFromLegacyAddress(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = parseLegacyHostPort(value, null);
  return parsed && parsed.host ? parsed.host : null;
}

function buildLegacyCandidates(service, localPort) {
  const legacyRef = typeof service.id === "string" ? service.id : service.id ? String(service.id) : null;
  const baseName = String(service.name || "").trim() || (legacyRef ? String(legacyRef) : "Access service");
  const linkedServiceId = typeof service.linkedInstanceId === "string" && service.linkedInstanceId.trim() !== ""
    ? service.linkedInstanceId.trim()
    : null;
  const computerId = typeof service.nodeId === "string" && service.nodeId.trim() !== "" ? service.nodeId.trim() : null;
  const candidates = [];

  // LOCAL endpoint: always present for a record with a usable localPort.
  {
    const localHost = typeof service.localHost === "string" && service.localHost.trim() !== ""
      ? service.localHost.trim()
      : "127.0.0.1";
    candidates.push({
      name: sanitizeCandidateName(baseName, "local"),
      type: "private",
      host: localHost,
      port: localPort,
      protocol: normalizeLegacyProtocol(service.protocol, new Set(["tcp", "udp"]), "tcp"),
      providerId: null,
      serviceId: linkedServiceId,
      computerId,
      source: "discovered",
      metadata: { legacyRef, scope: "local" },
    });
  }

  // PUBLIC endpoint: only when the record carries a non-empty publicAddress.
  if (typeof service.publicAddress === "string" && service.publicAddress.trim() !== "") {
    const parsed = parseLegacyHostPort(service.publicAddress, localPort);
    if (parsed && parsed.host) {
      const providerId = typeof service.providerId === "string" && PROVIDER_ID_PATTERN.test(service.providerId)
        ? service.providerId
        : "manual";
      candidates.push({
        name: sanitizeCandidateName(baseName, "public"),
        type: "public",
        host: parsed.host,
        port: parsed.port ?? localPort,
        protocol: normalizeLegacyProtocol(service.protocol, new Set(["tcp", "udp", "http", "https"]), "tcp"),
        providerId,
        serviceId: linkedServiceId,
        computerId,
        source: "provider",
        metadata: {
          legacyRef,
          tunnelId: typeof service.tunnelId === "string" ? service.tunnelId : service.tunnelId ?? null,
          tunnelName: typeof service.tunnelName === "string" ? service.tunnelName : service.tunnelName ?? null,
          accessType: typeof service.accessType === "string" ? service.accessType : service.accessType ?? null,
        },
      });
    }
  }

  // TAILSCALE endpoint: privateAddress, hostname or DNSName present.
  const tailscaleHost = hostFromLegacyAddress(service.privateAddress)
    || (typeof service.DNSName === "string" && service.DNSName.trim() !== "" ? service.DNSName.trim() : null)
    || (typeof service.dnsName === "string" && service.dnsName.trim() !== "" ? service.dnsName.trim() : null)
    || (typeof service.hostname === "string" && service.hostname.trim() !== "" ? service.hostname.trim() : null)
    || (typeof service.IPv4 === "string" && service.IPv4.trim() !== "" ? service.IPv4.trim() : null);
  if (tailscaleHost) {
    candidates.push({
      name: sanitizeCandidateName(baseName, "tailscale"),
      type: "tailscale",
      host: tailscaleHost,
      port: localPort,
      protocol: normalizeLegacyProtocol(service.protocol, new Set(["tcp", "udp"]), "tcp"),
      providerId: null,
      serviceId: linkedServiceId,
      computerId,
      source: "discovered",
      metadata: {
        legacyRef,
        addressPreference: typeof service.addressPreference === "string" && service.addressPreference.trim() !== ""
          ? service.addressPreference.trim()
          : null,
      },
    });
  }

  // Additional endpointOptions entries (bounded per service).
  const options = Array.isArray(service.endpointOptions)
    ? service.endpointOptions.slice(0, MAX_OPTION_ENDPOINTS_PER_SERVICE)
    : [];
  for (const option of options) {
    if (!isPlainObject(option)) continue;
    const optionType = String(option.optionType || option.type || "").trim().toLowerCase();
    if (!["magicdns", "ipv4", "ipv6"].includes(optionType)) continue;
    const optionHost = hostFromLegacyAddress(option.host) || hostFromLegacyAddress(option.address);
    if (!optionHost) continue;
    candidates.push({
      name: sanitizeCandidateName(baseName, String(option.label || optionType)),
      type: "tailscale",
      host: optionHost,
      port: localPort,
      protocol: normalizeLegacyProtocol(service.protocol, new Set(["tcp", "udp"]), "tcp"),
      providerId: null,
      serviceId: linkedServiceId,
      computerId,
      source: "discovered",
      metadata: {
        legacyRef,
        optionLabel: typeof option.label === "string" && option.label.trim() !== "" ? option.label.trim() : null,
      },
    });
  }

  return candidates;
}

function upsertInto(endpoints, input, { now }) {
  const inputId = isPlainObject(input) && typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : null;
  const existingById = inputId ? endpoints.find((entry) => entry.id === inputId) || null : null;
  const validation = validateEndpointInput(input, { existing: existingById });
  if (!validation.ok) {
    throw createStoreError("ENDPOINT_VALIDATION_FAILED", "Endpoint input is invalid.", { errors: validation.errors });
  }
  const value = validation.value;
  const key = endpointKey(value);
  let existing = existingById;
  if (existing) {
    const conflict = endpoints.find((entry) => entry.id !== existing.id && endpointKey(entry) === key);
    if (conflict) {
      throw createStoreError("ENDPOINT_DUPLICATE", "An endpoint already exists for this endpoint identity.", {
        existingEndpointId: conflict.id,
        incomingEndpointId: existing.id,
      });
    }
  } else {
    const byKey = endpoints.find((entry) => endpointKey(entry) === key) || null;
    if (byKey) {
      if (inputId && inputId !== byKey.id) {
        throw createStoreError("ENDPOINT_DUPLICATE", "An endpoint already exists for this endpoint identity.", {
          existingEndpointId: byKey.id,
          incomingEndpointId: inputId,
        });
      }
      existing = byKey;
    }
  }

  const base = existing || {};
  const record = {
    id: base.id || inputId || buildEndpointId({
      computerId: value.computerId,
      type: value.type,
      host: value.host,
      port: value.port,
      protocol: value.protocol,
      serviceId: value.serviceId,
      name: value.name,
    }),
    name: value.name,
    type: value.type,
    host: value.host,
    port: hasOwn(input, "port") ? value.port : base.port ?? null,
    protocol: hasOwn(input, "protocol") ? value.protocol : base.protocol ?? null,
    providerId: hasOwn(input, "providerId") ? value.providerId : base.providerId ?? null,
    serviceId: hasOwn(input, "serviceId") ? value.serviceId : base.serviceId ?? null,
    computerId: hasOwn(input, "computerId") ? value.computerId : base.computerId ?? null,
    source: hasOwn(input, "source") ? value.source : base.source || value.source,
    enabled: hasOwn(input, "enabled") ? value.enabled : typeof base.enabled === "boolean" ? base.enabled : value.enabled,
    notes: hasOwn(input, "notes") ? value.notes : typeof base.notes === "string" ? base.notes : value.notes,
    metadata: hasOwn(input, "metadata")
      ? value.metadata
      : isPlainObject(base.metadata)
        ? { ...base.metadata }
        : value.metadata,
    health: hasOwn(input, "health") ? input.health ?? null : base.health ?? null,
    lastCheckedAt: hasOwn(input, "lastCheckedAt")
      ? typeof input.lastCheckedAt === "string" ? input.lastCheckedAt : null
      : base.lastCheckedAt ?? null,
    createdAt: base.createdAt || now,
    updatedAt: now,
  };

  const normalized = normalizeEndpointRecord(record);
  if (!normalized) {
    throw createStoreError("ENDPOINT_VALIDATION_FAILED", "Endpoint record could not be normalized.", { errors: [] });
  }
  normalized.createdAt = base.createdAt || now;
  normalized.updatedAt = now;

  if (existing) {
    const index = endpoints.indexOf(existing);
    endpoints[index] = normalized;
  } else {
    endpoints.push(normalized);
  }
  return normalized;
}

function createEndpointStore({ configDirectory } = {}) {
  const directory = configDirectory || resolveConfigDirectory();
  const filePath = path.join(directory, ENDPOINTS_FILE_NAME);
  const legacyFilePath = path.join(directory, LEGACY_ACCESS_SERVICES_FILE_NAME);

  let state = null;
  let loaded = false;
  let loadError = null;
  let autoMigrationAttempted = false;
  const report = {
    path: filePath,
    legacyPath: legacyFilePath,
    exists: null,
    corrupt: false,
    corruptCode: null,
    corruptBackupPath: null,
    schemaVersion: null,
    migratedFrom: null,
    legacyMigration: null,
    migrationError: null,
  };

  function persist() {
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(serializeDocument(state), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    report.exists = true;
  }

  function quarantineCorruptFile() {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(filePath, quarantinePath, fs.constants.COPYFILE_EXCL);
      report.corruptBackupPath = quarantinePath;
    } catch {
      report.corruptBackupPath = null;
    }
    report.corrupt = true;
    report.corruptCode = "ENDPOINT_STORE_CORRUPT";
  }

  function migrateSchema(parsed, fromVersion) {
    const backupPath = `${filePath}.schema-v${fromVersion}.backup`;
    const originalBytes = fs.readFileSync(filePath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const verification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const verdict = decideMigrationRecovery({
      storeId: "endpoint-registry",
      fromSchemaVersion: fromVersion,
      toSchemaVersion: ENDPOINT_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: verification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (verdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw createStoreError(
        "ENDPOINT_MIGRATION_RECOVERY_UNVERIFIED",
        "Endpoint state could not be migrated safely because the pre-migration recovery point could not be verified.",
        { storeId: "endpoint-registry", reason: verdict.reason, verification: verification.reason, path: filePath },
      );
    }
    // v0 -> v1: normalize the stored document into the current schema.
    const migrated = normalizeDocument(parsed);
    migrated.legacyMigration = normalizeLegacyMigration(parsed?.legacyMigration);
    return migrated;
  }

  function loadInternal() {
    if (loadError) throw loadError;
    if (loaded) return state;
    report.exists = fs.existsSync(filePath);
    if (!report.exists) {
      state = emptyDocument();
      loaded = true;
      report.schemaVersion = ENDPOINT_SCHEMA_VERSION;
      return state;
    }

    let raw = null;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      quarantineCorruptFile();
      state = emptyDocument();
      loaded = true;
      report.schemaVersion = ENDPOINT_SCHEMA_VERSION;
      return state;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isPlainObject(parsed)) {
      quarantineCorruptFile();
      state = emptyDocument();
      loaded = true;
      report.schemaVersion = ENDPOINT_SCHEMA_VERSION;
      return state;
    }

    const schemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0;
    if (schemaVersion > ENDPOINT_SCHEMA_VERSION) {
      loadError = createStoreError(
        "ENDPOINT_SCHEMA_UNSUPPORTED",
        `Endpoint state schema ${schemaVersion} is newer than this application supports.`,
        { schemaVersion, supportedSchemaVersion: ENDPOINT_SCHEMA_VERSION, path: filePath },
      );
      throw loadError;
    }
    if (schemaVersion < ENDPOINT_SCHEMA_VERSION) {
      state = migrateSchema(parsed, schemaVersion);
      loaded = true;
      report.migratedFrom = schemaVersion;
      report.schemaVersion = ENDPOINT_SCHEMA_VERSION;
      persist();
      return state;
    }

    state = normalizeDocument(parsed);
    loaded = true;
    report.schemaVersion = ENDPOINT_SCHEMA_VERSION;
    return state;
  }

  function load() {
    const document = loadInternal();
    if (!autoMigrationAttempted) {
      autoMigrationAttempted = true;
      if (report.exists === false && report.corrupt !== true && !(document.legacyMigration && document.legacyMigration.appliedAt)) {
        if (fs.existsSync(legacyFilePath)) {
          try {
            const migrationReport = runLegacyMigration({ dryRun: false, now: new Date().toISOString() });
            report.legacyMigration = state.legacyMigration;
            if (migrationReport.error) report.migrationError = migrationReport.error;
          } catch (error) {
            report.migrationError = {
              code: error?.code || "ENDPOINT_LEGACY_MIGRATION_FAILED",
              message: error?.message || "Legacy Public Access migration failed.",
            };
          }
        }
      }
    }
    return serializeDocument(state);
  }

  function save(nextDocument) {
    loadInternal();
    state = normalizeDocument(nextDocument);
    persist();
    return serializeDocument(state);
  }

  function list(filter = {}) {
    loadInternal();
    const criteria = isPlainObject(filter) ? filter : {};
    const matches = state.endpoints.filter((entry) => {
      if (criteria.nodeId && entry.computerId !== criteria.nodeId) return false;
      if (criteria.serviceId && entry.serviceId !== criteria.serviceId) return false;
      if (criteria.type && entry.type !== criteria.type) return false;
      if (typeof criteria.enabled === "boolean" && (entry.enabled !== false) !== criteria.enabled) return false;
      return true;
    });
    return sortEndpoints(matches).map(cloneRecord);
  }

  function get(id) {
    loadInternal();
    const record = state.endpoints.find((entry) => entry.id === id) || null;
    return record ? cloneRecord(record) : null;
  }

  function upsert(input, options = {}) {
    loadInternal();
    const now = normalizeIsoNow(options.now);
    const record = upsertInto(state.endpoints, input, { now });
    persist();
    return cloneRecord(record);
  }

  function remove(id) {
    loadInternal();
    const index = state.endpoints.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw createStoreError("ENDPOINT_NOT_FOUND", "Endpoint was not found.", { endpointId: id });
    }
    const removed = state.endpoints[index];
    state.endpoints = state.endpoints.filter((entry) => entry.id !== id);
    persist();
    return cloneRecord(removed);
  }

  function setEnabled(id, enabled) {
    loadInternal();
    if (typeof enabled !== "boolean") {
      throw createStoreError("ENDPOINT_VALIDATION_FAILED", "Endpoint input is invalid.", {
        errors: [{ field: "enabled", code: "ENDPOINT_ENABLED_INVALID", message: "Endpoint enabled flag must be a boolean." }],
      });
    }
    const record = state.endpoints.find((entry) => entry.id === id);
    if (!record) {
      throw createStoreError("ENDPOINT_NOT_FOUND", "Endpoint was not found.", { endpointId: id });
    }
    record.enabled = enabled;
    record.updatedAt = new Date().toISOString();
    persist();
    return cloneRecord(record);
  }

  function recordProviderSync(nodeId, patch = {}) {
    const id = typeof nodeId === "string" ? nodeId.trim() : "";
    if (!id) {
      throw createStoreError("ENDPOINT_NODE_REQUIRED", "A node id is required to record a provider sync.");
    }
    loadInternal();
    const existing = state.providerSyncs[id] || {};
    const merged = { ...existing };
    if (isPlainObject(patch)) {
      for (const field of PROVIDER_SYNC_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
      }
    }
    const entry = normalizeProviderSyncEntry(merged);
    setOwnProperty(state.providerSyncs, id, entry);
    persist();
    return { ...entry };
  }

  function getProviderSyncs() {
    loadInternal();
    const syncs = {};
    for (const key of Object.keys(state.providerSyncs)) {
      setOwnProperty(syncs, key, { ...state.providerSyncs[key] });
    }
    return syncs;
  }

  function pushReason(reasons, ref, reason) {
    if (reasons.length >= MAX_RECORDED_REASONS) return;
    reasons.push({ ref: typeof ref === "string" ? ref : ref === null || ref === undefined ? null : String(ref), reason });
  }

  function runLegacyMigration({ dryRun, now }) {
    const existing = state.legacyMigration;
    if (existing && existing.appliedAt) {
      return {
        imported: 0,
        skipped: 0,
        applied: false,
        alreadyApplied: true,
        dryRun,
        reasons: [],
        endpointIds: [],
        appliedAt: existing.appliedAt,
        source: existing.source,
        error: null,
      };
    }
    if (!fs.existsSync(legacyFilePath)) {
      return {
        imported: 0,
        skipped: 0,
        applied: false,
        alreadyApplied: false,
        dryRun,
        reasons: [],
        endpointIds: [],
        appliedAt: null,
        source: null,
        error: null,
      };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(legacyFilePath, "utf8"));
    } catch {
      parsed = null;
    }
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
      return {
        imported: 0,
        skipped: 0,
        applied: false,
        alreadyApplied: false,
        dryRun,
        reasons: [{ ref: null, reason: "legacy-corrupt" }],
        endpointIds: [],
        appliedAt: null,
        source: LEGACY_ACCESS_SERVICES_FILE_NAME,
        error: {
          code: "ENDPOINT_LEGACY_CORRUPT",
          message: "Legacy Public Access state is unreadable; the file was left untouched.",
        },
      };
    }

    const services = Array.isArray(parsed?.services) ? parsed.services : Array.isArray(parsed) ? parsed : [];
    const endpointsWork = dryRun ? state.endpoints.map(cloneRecord) : state.endpoints;
    const reasons = [];
    const endpointIds = [];
    let skippedCount = 0;

    for (const service of services) {
      if (!isPlainObject(service)) continue;
      const localPort = normalizeLegacyPort(service.localPort);
      if (!localPort) {
        skippedCount += 1;
        pushReason(reasons, service.id, "no-port");
        continue;
      }
      const candidates = buildLegacyCandidates(service, localPort);
      for (const candidate of candidates) {
        // Migration is additive: a candidate whose identity already exists in the
        // working set (from an earlier legacy record or an existing endpoint) is
        // skipped visibly instead of silently merged into that endpoint.
        const candidateValidation = validateEndpointInput(candidate);
        if (!candidateValidation.ok) {
          skippedCount += 1;
          pushReason(reasons, service.id, "invalid");
          continue;
        }
        const candidateKey = endpointKey(candidateValidation.value);
        if (endpointsWork.some((entry) => endpointKey(entry) === candidateKey)) {
          skippedCount += 1;
          pushReason(reasons, service.id, "duplicate");
          continue;
        }
        try {
          const record = upsertInto(endpointsWork, candidate, { now });
          endpointIds.push(record.id);
        } catch (error) {
          skippedCount += 1;
          pushReason(reasons, service.id, error?.code === "ENDPOINT_DUPLICATE" ? "duplicate" : "invalid");
        }
      }
    }

    const summary = {
      appliedAt: now,
      source: LEGACY_ACCESS_SERVICES_FILE_NAME,
      imported: endpointIds.length,
      skipped: skippedCount,
      reasons,
    };

    if (!dryRun) {
      if (state.legacyMigration && state.legacyMigration.appliedAt) {
        // Another writer applied the migration concurrently; keep the recorded report.
      } else {
        state.legacyMigration = summary;
        persist();
        report.legacyMigration = summary;
      }
    }

    return {
      imported: endpointIds.length,
      skipped: skippedCount,
      applied: !dryRun,
      alreadyApplied: false,
      dryRun,
      reasons,
      endpointIds,
      appliedAt: now,
      source: LEGACY_ACCESS_SERVICES_FILE_NAME,
      error: null,
    };
  }

  function migrateLegacyAccessServices(options = {}) {
    const dryRun = options.dryRun === true;
    const now = normalizeIsoNow(options.now);
    loadInternal();
    return runLegacyMigration({ dryRun, now });
  }

  function getStatus() {
    let errorCode = null;
    try {
      loadInternal();
    } catch (error) {
      errorCode = error?.code || "ENDPOINT_STORE_ERROR";
    }
    return {
      path: filePath,
      exists: fs.existsSync(filePath),
      corrupt: report.corrupt === true,
      schemaVersion: errorCode ? null : state?.schemaVersion ?? null,
      endpointCount: errorCode ? 0 : state?.endpoints.length ?? 0,
      legacyMigration: state?.legacyMigration ?? null,
      errorCode,
    };
  }

  const store = {
    configDirectory: directory,
    filePath,
    legacyFilePath,
    load,
    save,
    list,
    get,
    upsert,
    remove,
    setEnabled,
    recordProviderSync,
    getProviderSyncs,
    migrateLegacyAccessServices,
    getStatus,
  };
  Object.defineProperty(store, "loadReport", {
    enumerable: true,
    get: () => ({ ...report, legacyMigration: state?.legacyMigration ?? report.legacyMigration }),
  });
  return store;
}

let defaultStore = null;

function getEndpointStore() {
  if (!defaultStore) defaultStore = createEndpointStore();
  return defaultStore;
}

function getEndpointStoreStatus() {
  return getEndpointStore().getStatus();
}

module.exports = {
  ENDPOINT_SCHEMA_VERSION,
  ENDPOINTS_FILE_NAME,
  LEGACY_ACCESS_SERVICES_FILE_NAME,
  MAX_OPTION_ENDPOINTS_PER_SERVICE,
  createEndpointStore,
  getEndpointStore,
  getEndpointStoreStatus,
  resolveConfigDirectory,
  _test: {
    normalizeDocument,
    normalizeProviderSyncEntry,
    buildLegacyCandidates,
    parseLegacyHostPort,
    sanitizeCandidateName,
  },
};
