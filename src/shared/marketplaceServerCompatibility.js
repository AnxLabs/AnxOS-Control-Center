const fs = require("fs");
const path = require("path");

const CLASSIFICATIONS = Object.freeze({
  VERIFIED: "VERIFIED",
  OFFICIAL_SERVER_PACK: "OFFICIAL_SERVER_PACK",
  SERVER_COMPATIBLE: "SERVER_COMPATIBLE",
  LIKELY_COMPATIBLE: "LIKELY_COMPATIBLE",
  UNKNOWN: "UNKNOWN",
  CLIENT_ONLY: "CLIENT_ONLY",
  UNSUPPORTED: "UNSUPPORTED",
});

const LABELS = Object.freeze({
  VERIFIED: "Verified Server Pack",
  OFFICIAL_SERVER_PACK: "Official Server Pack",
  SERVER_COMPATIBLE: "Server Compatible",
  LIKELY_COMPATIBLE: "Likely Server Compatible",
  UNKNOWN: "Compatibility Unknown",
  CLIENT_ONLY: "Client Only",
  UNSUPPORTED: "Unsupported",
});

const SUPPORTED_RUNTIMES = new Set(["fabric", "forge", "neoforge", "neo-forge", "quilt"]);
const REGISTRY_FILE_NAME = "marketplace-server-certifications.json";
const DEFAULT_REGISTRY_PATH = path.join(__dirname, "..", "..", "config", REGISTRY_FILE_NAME);

function getRegistryPaths(registryPath = null, options = {}) {
  if (registryPath) return [registryPath];
  const defaultPath = options.defaultPath || DEFAULT_REGISTRY_PATH;
  const resourcesPath = options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath;
  const paths = [defaultPath];
  if (defaultPath.includes("app.asar.unpacked")) {
    paths.push(defaultPath.replace("app.asar.unpacked", "app.asar"));
  }
  if (resourcesPath) {
    paths.push(path.join(resourcesPath, "app.asar", "config", REGISTRY_FILE_NAME));
    paths.push(path.join(resourcesPath, "app", "config", REGISTRY_FILE_NAME));
  }
  return [...new Set(paths)];
}

function readRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  for (const candidate of getRegistryPaths(registryPath === DEFAULT_REGISTRY_PATH ? null : registryPath)) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (value && value.schemaVersion === 1 && Array.isArray(value.records)) return value;
    } catch {}
  }
  return { schemaVersion: 1, maxAgeDays: 180, records: [] };
}

function sameId(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function findCertification(input, registry) {
  const provider = String(input.provider || "").toLowerCase();
  return registry.records.find((record) => String(record.provider || "").toLowerCase() === provider && (
    sameId(record.fileId, input.fileId || input.id) ||
    sameId(record.projectId, input.projectId || input.providerProjectId || input.modId) ||
    (record.slug && input.slug && String(record.slug).toLowerCase() === String(input.slug).toLowerCase())
  )) || null;
}

function isStale(record, registry, now) {
  const timestamp = Date.parse(record?.lastValidatedAt || "");
  const maxAgeDays = Math.max(1, Number(record?.maxAgeDays || registry.maxAgeDays) || 180);
  return !Number.isFinite(timestamp) || now.getTime() - timestamp > maxAgeDays * 86400000;
}

function result(classification, reason, evidence, certification = null, extra = {}) {
  const blocked = classification === CLASSIFICATIONS.CLIENT_ONLY || classification === CLASSIFICATIONS.UNSUPPORTED;
  return {
    classification,
    state: classification.toLowerCase().replaceAll("_", "-"),
    label: LABELS[classification],
    reason,
    detail: reason,
    evidenceSource: evidence[0]?.source || "insufficient-metadata",
    evidence,
    confidence: extra.confidence || (classification === CLASSIFICATIONS.UNKNOWN ? "low" : "high"),
    installable: !blocked,
    serverPackFileId: extra.serverPackFileId || null,
    recommendedFileId: extra.recommendedFileId || extra.serverPackFileId || null,
    certification,
    evaluatedAt: extra.evaluatedAt,
  };
}

function classifyServerCompatibility(input = {}, options = {}) {
  const registry = options.registry || readRegistry(options.registryPath);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const record = findCertification(input, registry);
  const stale = record ? isStale(record, registry, now) : false;
  const certification = record ? {
    status: stale ? "stale" : String(record.status || "recorded"),
    lastValidatedAt: record.lastValidatedAt || null,
    stale,
    validatedBy: record.validatedBy || null,
  } : { status: "not-certified", lastValidatedAt: null, stale: false, validatedBy: null };
  const evaluatedAt = now.toISOString();

  if (record && !stale && CLASSIFICATIONS[record.classification]) {
    const classification = record.classification;
    if (classification === CLASSIFICATIONS.VERIFIED && !record.evidence) {
      return result(CLASSIFICATIONS.UNKNOWN, "A verification record exists but has no validation evidence, so compatibility remains unknown.", [{ source: "manual-certification", outcome: "invalid", detail: "Validation evidence is missing." }], certification, { evaluatedAt });
    }
    return result(classification, record.evidence || "An active manual certification record determines server compatibility.", [{ source: "manual-certification", outcome: "accepted", detail: record.evidence || null }], certification, {
      evaluatedAt,
      serverPackFileId: record.serverPackFileId,
      recommendedFileId: record.serverPackFileId || record.fileId,
    });
  }

  const staleEvidence = record ? [{ source: "manual-certification", outcome: "stale", detail: `Last validated ${record.lastValidatedAt || "on an unknown date"}; current provider evidence was re-evaluated.` }] : [];
  const explicitServerPackId = input.serverPackFileId || input.raw?.serverPackFileId || input.raw?.server_pack_file_id || null;
  if (explicitServerPackId) {
    return result(CLASSIFICATIONS.OFFICIAL_SERVER_PACK, "CurseForge links an official server-pack file. AnxHost will use that file instead of the client archive.", [...staleEvidence, { source: "provider-server-pack-metadata", outcome: "accepted", detail: `Server pack file ${explicitServerPackId}.` }], certification, { evaluatedAt, serverPackFileId: explicitServerPackId });
  }

  const serverFlag = input.serverCompatible ?? input.serverPackCompatible ?? input.serverCapable ?? input.raw?.serverCompatible ?? input.raw?.server_pack_compatible ?? input.raw?.server_capable;
  const clientFlag = input.clientOnly ?? input.raw?.clientOnly ?? input.raw?.client_only;
  if (clientFlag === true || serverFlag === false) {
    return result(CLASSIFICATIONS.CLIENT_ONLY, "Provider metadata explicitly marks this project or file as client-only or not server-capable.", [...staleEvidence, { source: "provider-compatibility-metadata", outcome: "client-only", detail: "Explicit negative server compatibility flag." }], certification, { evaluatedAt });
  }
  if (serverFlag === true) {
    return result(CLASSIFICATIONS.SERVER_COMPATIBLE, "Provider metadata explicitly declares dedicated-server compatibility.", [...staleEvidence, { source: "provider-compatibility-metadata", outcome: "compatible", detail: "Explicit positive server compatibility flag." }], certification, { evaluatedAt });
  }

  const loaders = [...new Set([...(input.loaders || []), ...(input.minecraftVersions || []), input.loader].filter(Boolean).map((value) => String(value).toLowerCase()))];
  const declaredLoader = loaders.find((loader) => /fabric|forge|neoforge|neo-forge|quilt|rift|liteloader|cauldron/.test(loader));
  if (declaredLoader && !SUPPORTED_RUNTIMES.has(declaredLoader)) {
    return result(CLASSIFICATIONS.UNSUPPORTED, `The ${declaredLoader} loader/runtime is not supported by the AnxHost dedicated-server installer.`, [...staleEvidence, { source: "runtime-compatibility", outcome: "unsupported", detail: declaredLoader }], certification, { evaluatedAt });
  }
  if (declaredLoader && SUPPORTED_RUNTIMES.has(declaredLoader)) {
    return result(CLASSIFICATIONS.LIKELY_COMPATIBLE, `The declared ${declaredLoader} runtime is supported, but the provider does not publish enough evidence to verify this pack for a dedicated server.`, [...staleEvidence, { source: "runtime-compatibility", outcome: "supported", detail: declaredLoader }], certification, { evaluatedAt, confidence: "medium" });
  }

  return result(CLASSIFICATIONS.UNKNOWN, "CurseForge does not expose enough project or file evidence to determine dedicated-server compatibility.", [...staleEvidence, { source: "insufficient-metadata", outcome: "unknown", detail: "No certification, server-pack relationship, explicit compatibility declaration, or known runtime evidence." }], certification, { evaluatedAt });
}

module.exports = { CLASSIFICATIONS, LABELS, classifyServerCompatibility, getRegistryPaths, readRegistry };
