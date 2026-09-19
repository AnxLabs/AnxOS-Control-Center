const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("./migrationRecoveryPolicy");

const SCHEMA_VERSION = 1;
const DEFAULT_FILE_NAME = "public-access-services.json";
const SUPPORTED_PROTOCOLS = new Set(["tcp", "udp", "http", "https"]);

function nowIso() {
  return new Date().toISOString();
}

function createAccessServiceError(code, message, details = {}, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.statusCode = statusCode;
  return error;
}

function defaultConfigDirectory() {
  return process.env.ANXHUB_CONFIG_DIR || path.join(process.cwd(), "config");
}

function registryPath(options = {}) {
  return options.filePath || path.join(options.configDir || defaultConfigDirectory(), DEFAULT_FILE_NAME);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, parsed: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Registry root must be an object.");
    }
    return { exists: true, parsed };
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw createAccessServiceError(
      "PUBLIC_ACCESS_REGISTRY_CORRUPT",
      "Public Access state is unreadable. The original file was preserved for recovery.",
      { causeCode: error?.code || "INVALID_JSON" },
      500,
    );
  }
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function normalizeProtocol(value) {
  const protocol = String(value || "tcp").trim().toLowerCase();
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw createAccessServiceError("INVALID_PROTOCOL", "Choose a supported protocol.", {
      field: "protocol",
      received: value,
      expected: [...SUPPORTED_PROTOCOLS],
    });
  }
  return protocol;
}

function normalizePort(value, field = "localPort") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw createAccessServiceError("INVALID_SERVICE_PORT", "Service port must be a whole number from 1 to 65535.", {
      field,
      received: value,
      expected: "integer 1-65535",
    });
  }
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw createAccessServiceError("INVALID_SERVICE_PORT", "Service port must be a whole number from 1 to 65535.", {
      field,
      received: value,
      expected: "integer 1-65535",
    });
  }
  return number;
}

function normalizeHost(value) {
  const host = String(value || "127.0.0.1").trim();
  if (!host || /\s/.test(host)) {
    throw createAccessServiceError("INVALID_LOCAL_ENDPOINT", "Local host must be a hostname or IP address.", {
      field: "localHost",
      received: value,
      expected: "hostname or IP address",
    });
  }
  return host;
}

function normalizeEndpointAddress(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeTailscaleEndpoint(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["magicdns", "ipv4", "ipv6"].includes(text) ? text : null;
}

function buildTailscaleEndpointOptions(service = {}, provider = {}) {
  const options = [];
  const seen = new Set();
  const add = (type, label, host) => {
    const cleanHost = String(host || "").trim().replace(/\.$/, "");
    if (!cleanHost || seen.has(`${type}:${cleanHost}`)) return;
    seen.add(`${type}:${cleanHost}`);
    options.push({
      type,
      label,
      host: cleanHost,
      address: `${cleanHost}:${service.localPort}`,
    });
  };
  add("magicdns", "MagicDNS", service.hostname || provider.DNSName || provider.hostname);
  add("ipv4", "Tailscale IPv4", service.IPv4 || provider.IPv4);
  add("ipv6", "Tailscale IPv6", service.IPv6 || provider.IPv6);
  return options;
}

function selectTailscaleEndpoint(service = {}, provider = {}) {
  const options = buildTailscaleEndpointOptions(service, provider);
  const preference = normalizeTailscaleEndpoint(service.addressPreference || service.endpointPreference);
  return options.find((option) => option.type === preference) || options[0] || null;
}

function normalizePublicHostname(value, providerId) {
  const text = String(value || "").trim().toLowerCase();
  if (providerId !== "cloudflare-tunnel") return text || null;
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(text) || !text.includes(".") || text.includes("..")) {
    throw createAccessServiceError("INVALID_PUBLIC_HOSTNAME", "Public hostname must be a valid DNS hostname.", {
      field: "publicHostname",
      received: value,
      expected: "DNS hostname",
    });
  }
  return text;
}

function normalizeCloudflareLocalServiceUrl(value, protocol, localHost, localPort) {
  const fallback = `${protocol}://${localHost}:${localPort}`;
  const text = String(value || fallback).trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw createAccessServiceError("INVALID_LOCAL_ENDPOINT", "Cloudflare local service URL must be a valid HTTP or HTTPS URL.", {
      field: "localServiceUrl",
      received: value,
      expected: "http://host:port or https://host:port",
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw createAccessServiceError("INVALID_LOCAL_ENDPOINT", "Cloudflare local service URL must use HTTP or HTTPS.", {
      field: "localServiceUrl",
      received: value,
      expected: "HTTP or HTTPS URL",
    });
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeCloudflarePath(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!text.startsWith("/") || text.includes("..")) {
    throw createAccessServiceError("INVALID_CLOUDFLARE_PATH", "Cloudflare ingress path must start with / and cannot contain traversal segments.", {
      field: "path",
      received: value,
      expected: "/path",
    });
  }
  return text;
}

function sanitizeServiceName(value, fallback) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return (name || fallback || "Access Service").slice(0, 80);
}

function createServiceId(service) {
  const hash = crypto
    .createHash("sha256")
    .update([
      service.nodeId,
      service.providerId,
      service.localHost,
      service.localPort,
      service.protocol,
      service.linkedInstanceId || "",
      service.name || "",
    ].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `access-${hash}`;
}

function normalizeAccessService(input = {}, existing = {}) {
  const providerId = String(input.providerId || existing.providerId || "").trim();
  const nodeId = String(input.nodeId || existing.nodeId || "").trim();
  if (!providerId) {
    throw createAccessServiceError("PROVIDER_REQUIRED", "Choose an access provider.", { field: "providerId" });
  }
  if (!nodeId) {
    throw createAccessServiceError("NODE_REQUIRED", "Choose a target node.", { field: "nodeId" });
  }
  const protocol = normalizeProtocol(input.protocol || existing.protocol);
  if (providerId === "cloudflare-tunnel" && !["http", "https"].includes(protocol)) {
    throw createAccessServiceError("INCOMPATIBLE_SERVICE", "Cloudflare Tunnel supports HTTP and HTTPS services in this build.", {
      field: "protocol",
      providerId: "cloudflare-tunnel",
      received: protocol,
      expected: ["http", "https"],
    });
  }
  const localPort = normalizePort(input.localPort ?? existing.localPort);
  const publicHostname = normalizePublicHostname(input.publicHostname || input.publicAddress || existing.publicHostname || existing.publicAddress, providerId);
  const localHost = normalizeHost(input.localHost || existing.localHost);
  const cloudflareLocalServiceUrl = providerId === "cloudflare-tunnel"
    ? normalizeCloudflareLocalServiceUrl(input.localServiceUrl || existing.localServiceUrl, protocol, localHost, localPort)
    : input.localServiceUrl || existing.localServiceUrl || null;
  const cloudflarePath = providerId === "cloudflare-tunnel"
    ? normalizeCloudflarePath(input.path || input.ingressPath || existing.path || existing.ingressPath)
    : input.path || existing.path || null;
  const hasProviderAddress = Boolean(input.publicAddress || existing.publicAddress || input.privateAddress || existing.privateAddress || publicHostname);
  const defaultState = providerId === "playit" && !hasProviderAddress
    ? "pending-provider-setup"
    : providerId === "tailscale"
      ? "available"
      : "pending-provider-setup";
  const defaultStatus = providerId === "playit" && !hasProviderAddress
    ? "Pending Playit tunnel setup"
    : providerId === "tailscale"
      ? "Private Tailnet"
      : "Pending provider setup";
  const now = nowIso();
  const normalized = {
    id: existing.id || null,
    name: sanitizeServiceName(input.name || existing.name, `${providerId} ${protocol.toUpperCase()} ${localPort}`),
    providerId,
    providerName: input.providerName || existing.providerName || null,
    accessType: input.accessType || existing.accessType || (providerId === "tailscale" ? "private-tailnet" : "public-internet"),
    nodeId,
    linkedInstanceId: input.linkedInstanceId || existing.linkedInstanceId || null,
    localHost,
    localPort,
    protocol,
    providerResourceId: input.providerResourceId || existing.providerResourceId || null,
    publicAddress: providerId === "cloudflare-tunnel" ? publicHostname : input.publicAddress || existing.publicAddress || null,
    publicHostname,
    localServiceUrl: cloudflareLocalServiceUrl,
    path: cloudflarePath,
    tunnelName: providerId === "cloudflare-tunnel" ? input.tunnelName || existing.tunnelName || null : input.tunnelName || existing.tunnelName || null,
    tunnelId: providerId === "cloudflare-tunnel" ? input.tunnelId || existing.tunnelId || input.providerResourceId || existing.providerResourceId || null : input.tunnelId || existing.tunnelId || null,
    ingressStatus: providerId === "cloudflare-tunnel" ? input.ingressStatus || existing.ingressStatus || "pending-config" : input.ingressStatus || existing.ingressStatus || null,
    privateAddress: normalizeEndpointAddress(input.privateAddress || existing.privateAddress),
    hostname: input.hostname || existing.hostname || null,
    IPv4: input.IPv4 || existing.IPv4 || null,
    IPv6: input.IPv6 || existing.IPv6 || null,
    addressPreference: providerId === "tailscale"
      ? normalizeTailscaleEndpoint(input.addressPreference || existing.addressPreference) || "magicdns"
      : input.addressPreference || existing.addressPreference || null,
    endpointOptions: Array.isArray(input.endpointOptions)
      ? input.endpointOptions
      : Array.isArray(existing.endpointOptions)
        ? existing.endpointOptions
        : [],
    state: input.state || existing.state || defaultState,
    status: input.status || existing.status || defaultStatus,
    providerResourceStatus: input.providerResourceStatus || existing.providerResourceStatus || (providerId === "playit" && !hasProviderAddress ? "not-created-by-anxos" : null),
    unsupportedReason: input.unsupportedReason || existing.unsupportedReason || null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastCheckedAt: input.lastCheckedAt || existing.lastCheckedAt || null,
  };
  normalized.id = existing.id || input.id || createServiceId(normalized);
  return normalized;
}

function endpointKey(service) {
  return [
    service.nodeId,
    service.providerId,
    service.localHost,
    String(service.localPort),
    service.protocol,
  ].join("|").toLowerCase();
}

function cloudflareIngressKey(service) {
  if (service.providerId !== "cloudflare-tunnel" || !service.publicHostname) return null;
  return [
    service.nodeId,
    service.providerId,
    service.publicHostname,
    service.path || "/",
  ].join("|").toLowerCase();
}

function normalizeState(parsed = {}) {
  const services = Array.isArray(parsed.services) ? parsed.services : [];
  const byId = new Map();
  for (const service of services) {
    try {
      const normalized = normalizeAccessService(service, service);
      byId.set(normalized.id, normalized);
    } catch {
      // Ignore malformed legacy entries rather than breaking Public Access startup.
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    services: [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
  };
}

function readRegistry(options = {}) {
  const filePath = registryPath(options);
  const { exists, parsed } = readJsonFile(filePath);
  if (!exists) return normalizeState({});
  const schemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > SCHEMA_VERSION) {
    throw createAccessServiceError(
      "PUBLIC_ACCESS_SCHEMA_UNSUPPORTED",
      "Public Access state was created by a newer application version.",
      { schemaVersion, supportedSchemaVersion: SCHEMA_VERSION },
      409,
    );
  }
  const state = normalizeState(parsed);
  if (schemaVersion < SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(filePath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    // V2-J bullet 6: the registry rewrite below only runs behind a recovery
    // point that was read back and verified. An unverified copy is refused, not
    // warned past. Published access routes cannot be rebuilt from anywhere else.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "public-access-registry",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw createAccessServiceError(
        "PUBLIC_ACCESS_MIGRATION_RECOVERY_UNVERIFIED",
        "Public Access state could not be migrated safely because the pre-migration recovery point could not be verified.",
        { storeId: "public-access-registry", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
        500,
      );
    }
    atomicWriteJson(filePath, state);
  }
  return state;
}

function writeRegistry(state, options = {}) {
  const next = normalizeState(state);
  atomicWriteJson(registryPath(options), next);
  return next;
}

function listAccessServices(options = {}) {
  return readRegistry(options).services.filter((service) => {
    if (options.nodeId && service.nodeId !== options.nodeId) return false;
    if (options.providerId && service.providerId !== options.providerId) return false;
    return true;
  });
}

function createAccessService(input = {}, options = {}) {
  const state = readRegistry(options);
  const service = normalizeAccessService(input);
  const duplicate = state.services.find((entry) => endpointKey(entry) === endpointKey(service));
  if (duplicate) {
    throw createAccessServiceError("DUPLICATE_ACCESS_SERVICE", "An access service already exists for this provider and local endpoint.", {
      existingServiceId: duplicate.id,
      providerId: service.providerId,
      nodeId: service.nodeId,
      localHost: service.localHost,
      localPort: service.localPort,
      protocol: service.protocol,
    }, 409);
  }
  const ingressKey = cloudflareIngressKey(service);
  const duplicateIngress = ingressKey ? state.services.find((entry) => cloudflareIngressKey(entry) === ingressKey) : null;
  if (duplicateIngress) {
    throw createAccessServiceError("DUPLICATE_ACCESS_SERVICE", "A Cloudflare ingress route already exists for this hostname and path.", {
      existingServiceId: duplicateIngress.id,
      providerId: service.providerId,
      nodeId: service.nodeId,
      publicHostname: service.publicHostname,
      path: service.path || "/",
    }, 409);
  }
  const next = writeRegistry({ ...state, services: [...state.services, service] }, options);
  return next.services.find((entry) => entry.id === service.id);
}

function updateAccessService(serviceId, patch = {}, options = {}) {
  const state = readRegistry(options);
  const index = state.services.findIndex((entry) => entry.id === serviceId);
  if (index === -1) {
    throw createAccessServiceError("PROVIDER_RESOURCE_NOT_FOUND", "Access service was not found.", { serviceId }, 404);
  }
  const service = normalizeAccessService({ ...state.services[index], ...patch }, state.services[index]);
  const duplicate = state.services.find((entry, entryIndex) => entryIndex !== index && endpointKey(entry) === endpointKey(service));
  if (duplicate) {
    throw createAccessServiceError("DUPLICATE_ACCESS_SERVICE", "Another access service already uses this provider and local endpoint.", {
      existingServiceId: duplicate.id,
    }, 409);
  }
  const ingressKey = cloudflareIngressKey(service);
  const duplicateIngress = ingressKey ? state.services.find((entry, entryIndex) => entryIndex !== index && cloudflareIngressKey(entry) === ingressKey) : null;
  if (duplicateIngress) {
    throw createAccessServiceError("DUPLICATE_ACCESS_SERVICE", "Another Cloudflare access service already uses this hostname and path.", {
      existingServiceId: duplicateIngress.id,
      publicHostname: service.publicHostname,
      path: service.path || "/",
    }, 409);
  }
  const services = [...state.services];
  services[index] = service;
  const next = writeRegistry({ ...state, services }, options);
  return next.services.find((entry) => entry.id === service.id);
}

function deleteAccessService(serviceId, options = {}) {
  const state = readRegistry(options);
  const service = state.services.find((entry) => entry.id === serviceId);
  if (!service) {
    throw createAccessServiceError("PROVIDER_RESOURCE_NOT_FOUND", "Access service was not found.", { serviceId }, 404);
  }
  if (options.nodeId && service.nodeId !== options.nodeId) {
    throw createAccessServiceError("PROVIDER_RESOURCE_NOT_FOUND", "Access service was not found on the selected node.", {
      serviceId,
      nodeId: options.nodeId,
    }, 404);
  }
  writeRegistry({ ...state, services: state.services.filter((entry) => entry.id !== serviceId) }, options);
  return {
    success: true,
    serviceId,
    removed: true,
    service,
  };
}

function reconcileAccessServices(services = [], snapshot = {}) {
  const detectedServices = Array.isArray(snapshot.services) ? snapshot.services : [];
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  return services.map((service) => {
    const provider = providers.find((entry) => entry.id === service.providerId || entry.providerId === service.providerId) || {};
    if (service.providerId === "tailscale") {
      const endpointOptions = buildTailscaleEndpointOptions(service, provider);
      const selectedEndpoint = selectTailscaleEndpoint(service, provider);
      const privateAddress = service.privateAddress || selectedEndpoint?.address || null;
      return {
        ...service,
        providerName: service.providerName || provider.name || "Tailscale",
        privateAddress,
        hostname: service.hostname || provider.DNSName || provider.hostname || null,
        IPv4: service.IPv4 || provider.IPv4 || null,
        IPv6: service.IPv6 || provider.IPv6 || null,
        addressPreference: normalizeTailscaleEndpoint(service.addressPreference) || selectedEndpoint?.type || "magicdns",
        endpointOptions,
        accessType: "private-tailnet",
        exposureScope: "tailnet-only",
        state: provider.connected === true || provider.lifecycleState === "running" ? "available" : "provider-unavailable",
        status: provider.connected === true || provider.lifecycleState === "running" ? "Private Tailnet" : "Provider unavailable",
        lastCheckedAt: snapshot.checkedAt || service.lastCheckedAt,
      };
    }
    if (service.providerId === "cloudflare-tunnel") {
      const publicAddress = service.publicAddress || service.publicHostname || null;
      return {
        ...service,
        providerName: service.providerName || provider.name || "Cloudflare Tunnel",
        accessType: "public-internet",
        exposureScope: "public-internet",
        publicAddress,
        publicHostname: service.publicHostname || publicAddress,
        providerResourceId: service.providerResourceId || service.tunnelId || null,
        tunnelId: service.tunnelId || service.providerResourceId || null,
        ingressStatus: service.ingressStatus || "pending-config",
        providerResourceStatus: service.providerResourceId || service.tunnelId ? "linked" : "not-created-by-anxos",
        unsupportedReason: service.providerResourceId || service.tunnelId
          ? null
          : "AnxOS saved this Cloudflare web service record, but tunnel and DNS resources must be created or linked through a supported cloudflared workflow before traffic will route.",
        state: provider.running === true || provider.lifecycleState === "running" ? "available" : service.state || "pending-provider-setup",
        status: provider.running === true || provider.lifecycleState === "running" ? "Web Tunnel" : service.status || "Pending tunnel setup",
        lastCheckedAt: snapshot.checkedAt || service.lastCheckedAt,
      };
    }
    const detected = detectedServices.find((entry) => (
      entry.providerId === service.providerId &&
      Number(entry.localPort) === Number(service.localPort) &&
      String(entry.protocol || "").toLowerCase() === service.protocol
    )) || null;
    if (detected?.publicAddress || detected?.providerResourceId || detected?.tunnelId) {
      return {
        ...service,
        providerName: detected.providerName || service.providerName,
        providerResourceId: detected.providerResourceId || detected.tunnelId || service.providerResourceId,
        publicAddress: detected.publicAddress || service.publicAddress,
        providerResourceStatus: "detected",
        unsupportedReason: null,
        state: detected.status === "Public" ? "running" : "detected",
        status: detected.status || "Detected",
        lastCheckedAt: detected.lastCheckedAt || snapshot.checkedAt || service.lastCheckedAt,
      };
    }
    return {
      ...service,
      status: service.providerId === "playit" ? "Pending Playit tunnel setup" : service.status || "Pending provider setup",
      state: service.state || "pending-provider-setup",
      providerResourceStatus: service.providerResourceStatus || (service.providerId === "playit" ? "not-created-by-anxos" : null),
      unsupportedReason: service.unsupportedReason || (service.providerId === "playit" ? "AnxOS saved this access record, but the detected Playit integration did not expose safe tunnel creation. Create or link the matching tunnel in Playit, then refresh." : null),
      lastCheckedAt: snapshot.checkedAt || service.lastCheckedAt,
    };
  });
}

module.exports = {
  DEFAULT_FILE_NAME,
  SCHEMA_VERSION,
  SUPPORTED_PROTOCOLS,
  createAccessService,
  createAccessServiceError,
  deleteAccessService,
  listAccessServices,
  normalizeAccessService,
  readRegistry,
  reconcileAccessServices,
  registryPath,
  updateAccessService,
  _test: {
    buildTailscaleEndpointOptions,
    selectTailscaleEndpoint,
  },
};
