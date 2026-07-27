const fs = require("fs");
const path = require("path");

const MODRINTH_API = "https://api.modrinth.com/v2";
const USER_AGENT = "AnxOS-Control-Center/1.0 (+https://anxos.local)";
const projectMetadataCache = new Map();

class ModrinthProviderError extends Error {
  constructor(message, code = "MODRINTH_ERROR", details = {}) {
    super(message);
    this.name = "ModrinthProviderError";
    this.code = code;
    this.details = details;
  }
}

function serializeError(error, context = {}) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    ...context,
    name: error?.name || null,
    code: error?.code || null,
    message: error?.message || null,
    stack: error?.stack || null,
    status: details.status || error?.status || error?.statusCode || null,
    responseBody: details.body || details.responseBody || null,
    url: details.url || context.url || null,
    invalidUrl: details.invalidUrl || null,
    details,
  };
}

function truncateForLog(value, maxLength = 4000) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function friendlyHttpMessage(provider, label, status, body = "") {
  const detail = (() => {
    try {
      const parsed = JSON.parse(body);
      return parsed.description || parsed.error || parsed.message || "";
    } catch {
      return String(body || "").trim().slice(0, 240);
    }
  })();
  const prefix = `${provider} ${label}`;
  if (status === 401) return `${prefix}: 401 Invalid API key.`;
  if (status === 403) return `${prefix}: 403 Forbidden.`;
  if (status === 404) return `${prefix}: 404 Project not found.`;
  if (status === 429) return `${prefix}: 429 Rate limited. Try again later.`;
  return `${prefix}: HTTP ${status}${detail ? ` - ${detail}` : ""}`;
}

function logProviderFailure(error, context = {}) {
  console.error("[Marketplace][Modrinth] Provider request failed.", serializeError(error, context));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientError(error) {
  const status = error?.details?.status || error?.status || error?.statusCode;
  const code = error?.code || "";
  const name = error?.name || "";
  return isTransientStatus(status) ||
    ["MODRINTH_NETWORK_FAILED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
    ["AbortError", "TimeoutError"].includes(name);
}

async function withRetry(operation, context = {}) {
  const attempts = Math.max(1, Number(context.attempts) || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientError(error)) {
        throw error;
      }
      logProviderFailure(error, {
        label: context.label || null,
        url: context.url || null,
        attempt,
        nextAttempt: attempt + 1,
      });
      await delay((Number(context.delayMs) || 500) * attempt);
    }
  }
  throw lastError;
}

function assertProviderMetadata(projectIdOrSlug, context = "Modrinth project") {
  if (!projectIdOrSlug) {
    throw new ModrinthProviderError(`${context}: Invalid provider metadata. Missing providerProjectId.`, "INVALID_PROVIDER_METADATA", {
      projectIdOrSlug,
    });
  }
}

function normalizeLoader(loader) {
  return String(loader || "").trim().toLowerCase();
}

function normalizeSide(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["required", "optional", "unsupported"].includes(normalized) ? normalized : "unknown";
}

function isServerCapableProject(project = {}) {
  const side = normalizeSide(project.server_side);
  return side === "required" || side === "optional" || side === "unknown";
}

function shouldInstallProjectFile(project = {}, options = {}) {
  if (options.allowClientFiles) {
    return true;
  }
  return isServerCapableProject(project);
}

function buildSearchFacets(minecraftVersion, loader) {
  const facets = [["project_type:modpack"]];
  if (minecraftVersion) {
    facets.push([`versions:${minecraftVersion}`]);
  }
  if (loader) {
    facets.push([`categories:${normalizeLoader(loader)}`]);
  }
  facets.push(["server_side:required", "server_side:optional"]);
  return facets;
}

function createUrl(pathname, params = {}) {
  const url = new URL(`${MODRINTH_API}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  });
  return url;
}

async function requestJson(url, label) {
  try {
    return await withRetry(async () => {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": USER_AGENT,
        },
      });
      const body = await response.text();
      console.info("[Marketplace][Modrinth] HTTP response.", {
        label,
        url: String(url),
        status: response.status,
        ok: response.ok,
        bodyBytes: Buffer.byteLength(body || "", "utf8"),
      });
      if (!response.ok) {
        throw new ModrinthProviderError(friendlyHttpMessage("Modrinth", label, response.status, body), "MODRINTH_REQUEST_FAILED", {
          status: response.status,
          body: truncateForLog(body),
          url: String(url),
        });
      }
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new ModrinthProviderError(`${label} returned invalid JSON.`, "MODRINTH_INVALID_JSON", {
          message: error.message,
          body: truncateForLog(body),
          url: String(url),
        });
      }
    }, { label, url: String(url) });
  } catch (error) {
    const effectiveError = error instanceof ModrinthProviderError
      ? error
      : new ModrinthProviderError(`${label}: Network timeout or connection failure - ${error?.message || "request failed"}`, "MODRINTH_NETWORK_FAILED", {
        url: String(url),
        message: error?.message || "request failed",
        stack: error?.stack || null,
      });
    logProviderFailure(effectiveError, { label, url: String(url) });
    throw effectiveError;
  }
}

function validateDownloadUrl(url, label = "Modrinth file") {
  const rawUrl = String(url || "").trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new ModrinthProviderError(`${label} has an invalid download URL.`, "MODRINTH_INVALID_DOWNLOAD_URL", {
      invalidUrl: rawUrl || String(url),
      message: error?.message || "Invalid URL",
      stack: error?.stack || null,
    });
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new ModrinthProviderError(`${label} has an unsafe download URL.`, "MODRINTH_UNSAFE_URL", { url: rawUrl });
  }
  return parsed;
}

async function requestBuffer(url, label) {
  const parsed = validateDownloadUrl(url, label);
  try {
    return await withRetry(async () => {
      const response = await fetch(parsed, {
        headers: {
          "User-Agent": USER_AGENT,
        },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ModrinthProviderError(friendlyHttpMessage("Modrinth", label, response.status, body), "MODRINTH_DOWNLOAD_FAILED", {
          status: response.status,
          body: truncateForLog(body),
          url,
        });
      }
      return Buffer.from(await response.arrayBuffer());
    }, { label, url });
  } catch (error) {
    const effectiveError = error instanceof ModrinthProviderError
      ? error
      : new ModrinthProviderError(`${label}: Network timeout or connection failure - ${error?.message || "request failed"}`, "MODRINTH_NETWORK_FAILED", {
        url,
        message: error?.message || "request failed",
        stack: error?.stack || null,
      });
    logProviderFailure(effectiveError, { label, url });
    throw effectiveError;
  }
}

function normalizeProject(project = {}) {
  const projectType = project.project_type || project.projectType || "project";
  const slug = project.slug || project.project_id || project.id || "";
  const projectUrl = slug ? `https://modrinth.com/${encodeURIComponent(projectType)}/${encodeURIComponent(slug)}` : null;
  return {
    id: project.project_id || project.id,
    slug: project.slug,
    name: project.title || project.name || project.slug || project.id,
    projectType,
    websiteUrl: projectUrl,
    projectUrl,
    description: project.description || "",
    iconUrl: project.icon_url || null,
    author: project.author || project.team || "Modrinth",
    downloads: project.downloads || 0,
    provider: "modrinth",
    providerProjectId: project.project_id || project.id || project.slug,
    minecraftVersions: project.versions || project.game_versions || [],
    loaders: project.categories || project.loaders || [],
    serverSide: project.server_side || null,
    clientSide: project.client_side || null,
    updatedAt: project.date_modified || project.updated || null,
    raw: project,
  };
}

function normalizeVersion(version = {}) {
  const files = Array.isArray(version.files) ? version.files : [];
  const primary = files.find((file) => file.primary) || files[0] || null;
  return {
    id: version.id,
    projectId: version.project_id,
    name: version.name || version.version_number || version.id,
    versionNumber: version.version_number || version.name || version.id,
    minecraftVersions: version.game_versions || [],
    loaders: version.loaders || [],
    type: version.version_type || "release",
    datePublished: version.date_published || null,
    files,
    primaryFile: primary,
    dependencies: Array.isArray(version.dependencies) ? version.dependencies : [],
    raw: version,
  };
}

function versionMatches(version, minecraftVersion, loader) {
  const gameVersions = Array.isArray(version.game_versions) ? version.game_versions : version.minecraftVersions || [];
  const loaders = (version.loaders || []).map(normalizeLoader);
  return (!minecraftVersion || gameVersions.includes(minecraftVersion)) &&
    (!loader || loaders.includes(normalizeLoader(loader)));
}

function getVersionReleaseRank(version = {}) {
  const type = String(version.type || version.version_type || "").trim().toLowerCase();
  if (type === "release") return 0;
  if (type === "beta") return 1;
  if (type === "alpha") return 2;
  return 3;
}

function selectBestVersion(versions = [], selection = {}) {
  return (Array.isArray(versions) ? versions : [])
    .filter((version) => versionMatches(version, selection.minecraftVersion || selection.version || "", selection.loader || ""))
    .sort((left, right) => {
      const rank = getVersionReleaseRank(left) - getVersionReleaseRank(right);
      if (rank !== 0) return rank;
      return String(right.datePublished || right.date_published || "").localeCompare(String(left.datePublished || left.date_published || ""));
    })[0] || null;
}

function normalizeSearchOptions(queryOrOptions = "", minecraftVersion = "", loader = "") {
  if (queryOrOptions && typeof queryOrOptions === "object") {
    return {
      query: queryOrOptions.query || "",
      minecraftVersion: queryOrOptions.minecraftVersion || queryOrOptions.version || "",
      loader: queryOrOptions.loader || "",
      mode: queryOrOptions.mode || "featured",
      offset: Math.max(Number.parseInt(queryOrOptions.offset, 10) || 0, 0),
      limit: Math.min(Math.max(Number.parseInt(queryOrOptions.limit, 10) || 25, 1), 100),
    };
  }
  return {
    query: queryOrOptions || "",
    minecraftVersion,
    loader,
    mode: "featured",
    offset: 0,
    limit: 25,
  };
}

function getSearchIndex(mode, query) {
  if (query) return "relevance";
  if (mode === "trending") return "downloads";
  if (mode === "updated") return "updated";
  return "follows";
}

async function searchModpacks(queryOrOptions = "", minecraftVersion = "", loader = "") {
  const options = normalizeSearchOptions(queryOrOptions, minecraftVersion, loader);
  const url = createUrl("/search", {
    query: options.query,
    index: getSearchIndex(options.mode, options.query),
    offset: options.offset,
    limit: options.limit,
    facets: buildSearchFacets(options.minecraftVersion, options.loader),
  });
  console.info("[Marketplace][Modrinth] Search request.", {
    provider: "modrinth",
    mode: options.mode,
    query: options.query,
    minecraftVersion: options.minecraftVersion,
    loader: options.loader,
    offset: options.offset,
    limit: options.limit,
    url: String(url),
  });
  const payload = await requestJson(url, "Modrinth search");
  const rawHits = Array.isArray(payload.hits) ? payload.hits : [];
  const filtered = rawHits.filter(isServerCapableProject);
  const results = filtered.map(normalizeProject);
  const diagnostics = {
    provider: "modrinth",
    url: String(url),
    apiCount: rawHits.length,
    filteredCount: filtered.length,
    parsedCount: results.length,
    totalHits: payload.total_hits || 0,
    zeroReason: rawHits.length === 0
      ? "api_returned_zero"
      : filtered.length === 0
        ? "filters_removed_all"
        : results.length === 0
          ? "parser_produced_zero"
          : null,
  };
  console.info("[Marketplace][Modrinth] Search parsed.", diagnostics);
  return {
    provider: "modrinth",
    mode: options.mode,
    offset: options.offset,
    limit: options.limit,
    total: payload.total_hits || results.length,
    nextOffset: options.offset + results.length,
    hasMore: options.offset + results.length < (payload.total_hits || 0),
    diagnostics,
    results,
  };
}

async function getProject(projectIdOrSlug) {
  assertProviderMetadata(projectIdOrSlug, "Modrinth project");
  const cacheKey = String(projectIdOrSlug);
  if (projectMetadataCache.has(cacheKey)) {
    return projectMetadataCache.get(cacheKey);
  }
  const project = await requestJson(createUrl(`/project/${encodeURIComponent(projectIdOrSlug)}`), "Modrinth project");
  const normalized = normalizeProject(project);
  projectMetadataCache.set(cacheKey, normalized);
  if (normalized.id) projectMetadataCache.set(String(normalized.id), normalized);
  if (normalized.slug) projectMetadataCache.set(String(normalized.slug), normalized);
  return normalized;
}

async function getVersions(projectIdOrSlug, minecraftVersion = "", loader = "") {
  assertProviderMetadata(projectIdOrSlug, "Modrinth versions");
  const params = {};
  if (minecraftVersion) {
    params.game_versions = JSON.stringify([minecraftVersion]);
  }
  if (loader) {
    params.loaders = JSON.stringify([normalizeLoader(loader)]);
  }
  const versions = await requestJson(createUrl(`/project/${encodeURIComponent(projectIdOrSlug)}/version`, params), "Modrinth versions");
  return (Array.isArray(versions) ? versions : []).map(normalizeVersion);
}

async function getVersion(versionId) {
  if (!versionId) {
    throw new ModrinthProviderError("Modrinth version id is required.", "MODRINTH_VERSION_REQUIRED");
  }
  return normalizeVersion(await requestJson(createUrl(`/version/${encodeURIComponent(versionId)}`), "Modrinth version"));
}

async function resolveVersion(projectIdOrSlug, minecraftVersion = "", loader = "", requestedVersionId = "") {
  if (requestedVersionId && requestedVersionId !== "latest") {
    const version = await getVersion(requestedVersionId);
    if (versionMatches(version.raw || version, minecraftVersion, loader)) {
      return version;
    }
    throw new ModrinthProviderError("Requested Modrinth version does not match the selected Minecraft version or loader.", "MODRINTH_VERSION_MISMATCH", {
      projectId: projectIdOrSlug,
      versionId: requestedVersionId,
      requestedMinecraftVersion: minecraftVersion || null,
      requestedLoader: loader || null,
      versionMinecraftVersions: version.minecraftVersions || [],
      versionLoaders: version.loaders || [],
    });
  }
  const versions = await getVersions(projectIdOrSlug, minecraftVersion, loader);
  const release = selectBestVersion(versions, { minecraftVersion, loader });
  if (!release) {
    throw new ModrinthProviderError("No compatible Modrinth server version was found.", "MODRINTH_VERSION_NOT_FOUND");
  }
  return release;
}

async function resolveDependencies(version, minecraftVersion = "", loader = "", options = {}, state = null) {
  const resolved = state || {
    seenProjects: new Set(),
    seenVersions: new Set(),
    dependencies: [],
  };
  const dependencyRows = Array.isArray(version?.dependencies) ? version.dependencies : [];
  for (const dependency of dependencyRows) {
    if (!["required", "optional"].includes(dependency.dependency_type)) {
      continue;
    }
    let childVersion = null;
    if (dependency.version_id && !resolved.seenVersions.has(dependency.version_id)) {
      childVersion = await getVersion(dependency.version_id);
    } else if (dependency.project_id && !resolved.seenProjects.has(dependency.project_id)) {
      childVersion = await resolveVersion(dependency.project_id, minecraftVersion, loader);
    }
    if (!childVersion) {
      continue;
    }
    const project = await getProject(childVersion.projectId || dependency.project_id);
    if (!shouldInstallProjectFile(project.raw || project, options)) {
      continue;
    }
    resolved.seenProjects.add(childVersion.projectId || dependency.project_id);
    resolved.seenVersions.add(childVersion.id);
    resolved.dependencies.push({ version: childVersion, project, dependencyType: dependency.dependency_type });
    await resolveDependencies(childVersion, minecraftVersion, loader, options, resolved);
  }
  return resolved.dependencies;
}

async function downloadVersionFiles(version, destination, options = {}) {
  const files = (Array.isArray(version?.files) ? version.files : []).filter((file) => file?.url);
  const downloads = [];
  for (const file of files) {
    const buffer = await requestBuffer(file.url, file.filename || "Modrinth file");
    const parsedUrl = validateDownloadUrl(file.url, file.filename || "Modrinth file");
    const record = {
      fileName: file.filename || path.basename(parsedUrl.pathname) || "modrinth-file.jar",
      url: file.url,
      hashes: file.hashes || {},
      size: file.size || buffer.length,
      buffer,
    };
    downloads.push(record);
    if (destination) {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, record.fileName), buffer);
    }
    if (options.primaryOnly) {
      break;
    }
  }
  return downloads;
}

module.exports = {
  _test: {
    buildSearchFacets,
    friendlyHttpMessage,
    isTransientError,
    isServerCapableProject,
    normalizeProject,
    normalizeSide,
    normalizeVersion,
    shouldInstallProjectFile,
    getVersionReleaseRank,
    selectBestVersion,
    versionMatches,
    withRetry,
  },
  ModrinthProviderError,
  downloadVersionFiles,
  getProject,
  getVersion,
  getVersions,
  resolveDependencies,
  resolveVersion,
  searchModpacks,
};
