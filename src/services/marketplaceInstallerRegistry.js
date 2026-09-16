const SUPPORTED_INSTALLER_TYPES = new Set([
  "archive-download",
  "curseforge",
  "direct-download",
  "docker-image",
  "java-runtime",
  "local-import",
  "no-install",
  "provider-download",
  "steamcmd-native",
]);

const LEGACY_INSTALLER_TYPE_MAP = {
  archive: "archive-download",
  docker: "docker-image",
  manual: "local-import",
  steamcmd: "steamcmd-native",
  url: "direct-download",
};

class MarketplaceManifestError extends Error {
  constructor(message, code = "MARKETPLACE_MANIFEST_INVALID", details = {}) {
    super(message);
    this.name = "MarketplaceManifestError";
    this.code = code;
    this.details = details;
  }
}

function normalizeInstallerType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  return LEGACY_INSTALLER_TYPE_MAP[normalized] || normalized;
}

function getTemplateInstallerType(template = {}) {
  const explicit = normalizeInstallerType(template.installerType || template.installType);
  if (explicit) {
    return explicit;
  }

  if (template.disabled || template.comingSoon) {
    return "no-install";
  }

  if (template.runtime === "docker" || template.startupType === "docker-image") {
    return "docker-image";
  }

  const installerType = normalizeInstallerType(template.installer?.type);
  if (installerType) {
    return installerType;
  }

  const sourceType = normalizeInstallerType(template.downloadSource?.type);
  if (sourceType === "steamcmd-native") {
    return "steamcmd-native";
  }
  if (sourceType === "local-import") {
    return "local-import";
  }
  if (sourceType === "direct-download") {
    return "direct-download";
  }

  if (Array.isArray(template.downloads) && template.downloads.length > 0) {
    return template.category === "Minecraft" ? "java-runtime" : "direct-download";
  }

  if (template.category === "Minecraft" && template.startupType === "java-jar") {
    return "java-runtime";
  }

  return "";
}

// V2-D package metadata (docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md §3.1):
// opt-in versioned package fields are enforced when present, so the shipped
// Marketplace 1.x catalog is unaffected until a template declares them.
const PACKAGE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/;
const PACKAGE_CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/i;

function validateTemplateV2Metadata(template = {}) {
  const templateId = template.id || null;
  if (template.packageVersion !== undefined && template.packageVersion !== null
    && !PACKAGE_VERSION_PATTERN.test(String(template.packageVersion))) {
    throw new MarketplaceManifestError("Marketplace template packageVersion must be semver (e.g. 1.2.3).", "PACKAGE_VERSION_INVALID", { templateId });
  }
  if (template.checksum !== undefined && template.checksum !== null) {
    const raw = String(template.checksum).trim();
    if (!PACKAGE_CHECKSUM_PATTERN.test(raw)) {
      throw new MarketplaceManifestError("Marketplace template checksum must be sha256:<64 hex> for integrity verification.", "PACKAGE_CHECKSUM_INVALID", { templateId });
    }
  }
  if (template.provenance !== undefined && template.provenance !== null) {
    const prov = template.provenance;
    if (!prov || typeof prov !== "object" || Array.isArray(prov) || !String(prov.source || "").trim()) {
      throw new MarketplaceManifestError("Marketplace template provenance must declare a non-empty source.", "PACKAGE_PROVENANCE_INVALID", { templateId });
    }
  }
}

function validatePorts(template = {}) {
  const ports = Array.isArray(template.defaultPorts) ? template.defaultPorts : [];
  for (const port of ports) {
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
      throw new MarketplaceManifestError("Marketplace template declares an invalid default port.", "PORT_INVALID", {
        templateId: template.id || null,
        port,
      });
    }
  }
}

function validateSteamCmdTemplate(template = {}) {
  const installer = template.installer || template.downloadSource || {};
  if (!Number.isInteger(Number(installer.appId))) {
    throw new MarketplaceManifestError("SteamCMD template is missing a Steam app ID.", "MARKETPLACE_MANIFEST_INVALID", {
      templateId: template.id || null,
      installerType: "steamcmd-native",
    });
  }
  if (installer.login === "required" && !installer.allowAuthenticatedInstall) {
    throw new MarketplaceManifestError("SteamCMD authenticated installers are not implemented for this template.", "INSTALLER_TYPE_UNSUPPORTED", {
      templateId: template.id || null,
      installerType: "steamcmd-native",
    });
  }
  if (!Array.isArray(installer.verifyFiles) || installer.verifyFiles.length === 0) {
    throw new MarketplaceManifestError("SteamCMD template must declare executable or file verification candidates.", "MARKETPLACE_MANIFEST_INVALID", {
      templateId: template.id || null,
      installerType: "steamcmd-native",
    });
  }
}

function validateMarketplaceTemplate(template = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(String(template.id || ""))) {
    throw new MarketplaceManifestError("Marketplace template id is invalid.", "MARKETPLACE_MANIFEST_INVALID", { templateId: template.id || null });
  }
  if (!String(template.displayName || "").trim()) {
    throw new MarketplaceManifestError("Marketplace template display name is required.", "MARKETPLACE_MANIFEST_INVALID", { templateId: template.id || null });
  }
  if (!String(template.category || "").trim()) {
    throw new MarketplaceManifestError("Marketplace template category is required.", "MARKETPLACE_MANIFEST_INVALID", { templateId: template.id || null });
  }

  validatePorts(template);
  validateTemplateV2Metadata(template);

  const installerType = getTemplateInstallerType(template);
  if (!installerType || !SUPPORTED_INSTALLER_TYPES.has(installerType)) {
    throw new MarketplaceManifestError("Marketplace template has an unsupported installer type.", "INSTALLER_TYPE_UNSUPPORTED", {
      templateId: template.id || null,
      installerType: installerType || null,
    });
  }

  if (installerType === "steamcmd-native") {
    validateSteamCmdTemplate(template);
  }

  if (installerType === "direct-download" || installerType === "archive-download" || installerType === "java-runtime") {
    const hasDownloads = Boolean(template.downloadSource?.type) || (Array.isArray(template.downloads) && template.downloads.length > 0);
    if (!hasDownloads) {
      throw new MarketplaceManifestError("Download-based template is missing download metadata.", "MARKETPLACE_MANIFEST_INVALID", {
        templateId: template.id || null,
        installerType,
      });
    }
  }

  return {
    installerType,
    supported: installerType !== "no-install",
  };
}

function validateMarketplaceCatalog(templates = []) {
  const seen = new Set();
  const errors = [];
  const results = [];

  for (const template of templates) {
    try {
      if (seen.has(template?.id)) {
        throw new MarketplaceManifestError("Marketplace template IDs must be unique.", "MARKETPLACE_MANIFEST_INVALID", { templateId: template?.id || null });
      }
      seen.add(template?.id);
      results.push({ templateId: template?.id, ...validateMarketplaceTemplate(template) });
    } catch (error) {
      errors.push({
        templateId: template?.id || null,
        code: error.code || "MARKETPLACE_MANIFEST_INVALID",
        message: error.message,
        details: error.details || {},
      });
    }
  }

  return {
    valid: errors.length === 0,
    results,
    errors,
  };
}

module.exports = {
  LEGACY_INSTALLER_TYPE_MAP,
  MarketplaceManifestError,
  SUPPORTED_INSTALLER_TYPES,
  getTemplateInstallerType,
  normalizeInstallerType,
  validateMarketplaceCatalog,
  validateMarketplaceTemplate,
};
