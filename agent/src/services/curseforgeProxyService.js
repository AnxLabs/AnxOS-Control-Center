const crypto = require("crypto");
const fs = require("fs");
const { Readable } = require("stream");

const CURSEFORGE_API = "https://api.curseforge.com/v1";
const USER_AGENT = "AnxOS-Agent/0.1 (+https://anxos.local)";
const API_KEY_ENV = ["CURSEFORGE_API_KEY"];
const API_KEY_ENV_ALIASES = ["CF_API_KEY", "ANXHUB_CURSEFORGE_API_KEY"];
const API_KEY_FILE_ENV = ["CURSEFORGE_API_KEY_FILE", "CF_API_KEY_FILE", "ANXHUB_CURSEFORGE_API_KEY_FILE"];
const ALLOWED_API_PATHS = [
  /^\/mods\/search$/,
  /^\/mods\/\d+$/,
  /^\/mods\/\d+\/files$/,
  /^\/mods\/\d+\/files\/\d+$/,
  /^\/mods\/\d+\/files\/\d+\/download-url$/,
  /^\/minecraft\/version$/,
  /^\/minecraft\/modloader$/,
];
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "media.forgecdn.net",
]);
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

class CurseForgeProxyError extends Error {
  constructor(message, code = "CURSEFORGE_PROXY_ERROR", details = {}, statusCode = 500) {
    super(message);
    this.name = "CurseForgeProxyError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

function cleanSecretValue(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function readSecretFile(filePath) {
  const cleanPath = cleanSecretValue(filePath);
  if (!cleanPath) return "";
  return cleanSecretValue(fs.readFileSync(cleanPath, "utf8"));
}

function resolveApiKey() {
  for (const envName of API_KEY_ENV) {
    const value = cleanSecretValue(process.env[envName]);
    if (value) return { key: value, source: "environment" };
  }
  for (const envName of API_KEY_ENV_ALIASES) {
    const value = cleanSecretValue(process.env[envName]);
    if (value) return { key: value, source: "environment-alias" };
  }
  for (const envName of API_KEY_FILE_ENV) {
    const value = cleanSecretValue(process.env[envName]);
    if (value) return { key: readSecretFile(value), source: "protected-file" };
  }
  return { key: "", source: null };
}

function fingerprint(value) {
  return value ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 12) : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonBody(request) {
  if (!request.body) return {};
  try {
    return JSON.parse(request.body);
  } catch {
    throw new CurseForgeProxyError("Request body must be valid JSON.", "CURSEFORGE_INVALID_REQUEST_BODY", {}, 400);
  }
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function buildCdnRequestHeaders(context = {}) {
  return {
    "User-Agent": USER_AGENT,
    ...(context.range ? { Range: context.range } : {}),
  };
}

async function withRetry(operation, context = {}) {
  const attempts = Math.max(1, Number(context.attempts) || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation(attempt);
      if (!RETRY_STATUSES.has(Number(result?.status)) || attempt >= attempts) {
        return result;
      }
      lastError = new CurseForgeProxyError("CurseForge request returned a transient status.", "CURSEFORGE_TRANSIENT_STATUS", {
        status: result.status,
        path: context.path || null,
        attempt,
      }, result.status);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !["AbortError", "TimeoutError"].includes(error?.name)) {
        throw error;
      }
    }
    await delay((Number(context.delayMs) || 500) * attempt);
  }
  throw lastError;
}

function getCurseForgeProxyStatus() {
  try {
    const resolved = resolveApiKey();
    return {
      configured: Boolean(resolved.key),
      source: resolved.source,
      fingerprint: fingerprint(resolved.key),
    };
  } catch (error) {
    return {
      configured: false,
      source: null,
      fingerprint: null,
      errorCode: error?.code || error?.name || "CURSEFORGE_KEY_UNREADABLE",
    };
  }
}

function requireApiKey() {
  const resolved = resolveApiKey();
  if (!resolved.key) {
    throw new CurseForgeProxyError("CurseForge integration is not configured on this Agent.", "CURSEFORGE_CONFIGURATION_MISSING", {
      provider: "curseforge",
      source: null,
    }, 503);
  }
  return resolved;
}

function assertAllowedApiPath(pathname) {
  const cleanPath = String(pathname || "").trim();
  if (!ALLOWED_API_PATHS.some((pattern) => pattern.test(cleanPath))) {
    throw new CurseForgeProxyError("CurseForge API path is not allowed.", "CURSEFORGE_PROXY_PATH_DENIED", { path: cleanPath }, 400);
  }
  return cleanPath;
}

function buildApiUrl(url) {
  const pathname = assertAllowedApiPath(url.searchParams.get("path") || "");
  const target = new URL(`${CURSEFORGE_API}${pathname}`);
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "path" && value !== "") {
      target.searchParams.set(key, value);
    }
  }
  return target;
}

function buildEndpointApiUrl(pathname, params = {}) {
  const target = new URL(`${CURSEFORGE_API}${assertAllowedApiPath(pathname)}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  });
  return target;
}

function getSearchParams(url, allowedKeys = []) {
  return Object.fromEntries(allowedKeys
    .map((key) => [key, url.searchParams.get(key)])
    .filter(([, value]) => value !== null && value !== ""));
}

function validateDownloadUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new CurseForgeProxyError("CurseForge download URL is invalid.", "CURSEFORGE_INVALID_DOWNLOAD_URL", {}, 400);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!["https:", "http:"].includes(parsed.protocol) || (!ALLOWED_DOWNLOAD_HOSTS.has(hostname) && !hostname.endsWith(".curseforge.com"))) {
    throw new CurseForgeProxyError("CurseForge download URL is not allowed.", "CURSEFORGE_UNSAFE_URL", { hostname }, 400);
  }
  return parsed;
}

async function fetchDownloadWithRedirects(url, context = {}) {
  let current = validateDownloadUrl(url);
  const maxRedirects = 5;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetchWithTimeout(current, {
      redirect: "manual",
      headers: buildCdnRequestHeaders(context),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      response.redirectCount = redirectCount;
      response.finalUrl = String(current);
      response.finalHostname = current.hostname;
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      response.redirectCount = redirectCount;
      response.finalUrl = String(current);
      response.finalHostname = current.hostname;
      return response;
    }
    current = validateDownloadUrl(new URL(location, current).toString());
  }
  throw new CurseForgeProxyError("CurseForge download exceeded the redirect limit.", "CURSEFORGE_DOWNLOAD_REDIRECT_LIMIT", {
    projectId: context.projectId || null,
    fileId: context.fileId || null,
    redirectLimit: maxRedirects,
  }, 508);
}

async function fetchCurseForgeApi(url) {
  const resolved = requireApiKey();
  const target = buildApiUrl(url);
  return fetchCurseForgeApiUrl(target, resolved);
}

async function fetchCurseForgeApiUrl(target, resolved = requireApiKey()) {
  const response = await withRetry(() => fetchWithTimeout(target, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "x-api-key": resolved.key,
    },
  }), { path: target.pathname });
  const body = await response.text();
  if (Buffer.byteLength(body || "", "utf8") > MAX_JSON_BYTES) {
    throw new CurseForgeProxyError("CurseForge API response exceeded the Agent size limit.", "CURSEFORGE_RESPONSE_TOO_LARGE", {
      path: target.pathname,
      maxBytes: MAX_JSON_BYTES,
    }, 502);
  }
  if (!response.ok) {
    throw new CurseForgeProxyError("CurseForge API request failed.", "CURSEFORGE_REQUEST_FAILED", {
      status: response.status,
      body: body.slice(0, 1000),
      path: target.pathname,
    }, response.status);
  }
  return {
    statusCode: 200,
    body: JSON.parse(body),
  };
}

async function fetchCurseForgeEndpoint(pathname, params = {}) {
  return fetchCurseForgeApiUrl(buildEndpointApiUrl(pathname, params));
}

async function fetchCurseForgeDownload(url) {
  requireApiKey();
  const target = validateDownloadUrl(url.searchParams.get("url") || "");
  const context = {
    projectId: url.searchParams.get("projectId") || null,
    fileId: url.searchParams.get("fileId") || null,
  };
  const response = await fetchDownloadWithRedirects(target, context);
  console.info("[AnxOS Agent][CurseForge] Download response.", {
    hostname: response.finalHostname || target.hostname,
    status: response.status,
    redirectCount: response.redirectCount || 0,
    projectId: context.projectId,
    fileId: context.fileId,
    authenticatedApiLookup: true,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CurseForgeProxyError("CurseForge download request failed.", "CURSEFORGE_DOWNLOAD_FAILED", {
      status: response.status,
      body: body.slice(0, 1000),
      hostname: response.finalHostname || target.hostname,
      redirectCount: response.redirectCount || 0,
      projectId: context.projectId,
      fileId: context.fileId,
    }, response.status);
  }
  return {
    statusCode: 200,
    stream: Readable.fromWeb(response.body),
    headers: {
      "Content-Type": response.headers.get("content-type") || "application/octet-stream",
      ...(response.headers.get("content-length") ? { "Content-Length": response.headers.get("content-length") } : {}),
      "X-AnxOS-CurseForge-Authenticated": "true",
    },
  };
}

async function fetchCurseForgeDownloadPost(request) {
  const body = readJsonBody(request);
  let downloadUrl = cleanSecretValue(body.url || body.downloadUrl);
  const projectId = String(body.projectId || "");
  const fileId = String(body.fileId || "");
  if (!downloadUrl && projectId && fileId) {
    const payload = await fetchCurseForgeEndpoint(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/download-url`);
    downloadUrl = typeof payload.body?.data === "string" ? payload.body.data : "";
  }
  const url = new URL("http://agent.local/api/v1/marketplace/curseforge/download");
  url.searchParams.set("url", downloadUrl);
  if (projectId) url.searchParams.set("projectId", projectId);
  if (fileId) url.searchParams.set("fileId", fileId);
  return fetchCurseForgeDownload(url);
}

async function probeCurseForgeCdn(projects = [], options = {}) {
  const fetchEndpoint = options.fetchEndpoint || fetchCurseForgeEndpoint;
  const fetchDownload = options.fetchDownload || fetchDownloadWithRedirects;
  const candidates = [];
  for (const project of projects.slice(0, 8)) {
    for (const fileIndex of (Array.isArray(project?.latestFilesIndexes) ? project.latestFilesIndexes : []).slice(0, 3)) {
      const projectId = project?.id;
      const fileId = fileIndex?.fileId || fileIndex?.fileID;
      if (projectId && fileId) {
        candidates.push({ projectId, fileId });
      }
    }
  }

  if (candidates.length === 0) {
    throw new CurseForgeProxyError("CurseForge CDN probe did not find a probe file.", "CURSEFORGE_CDN_PROBE_UNAVAILABLE", {}, 502);
  }

  let lastFailure = null;
  for (const candidate of candidates.slice(0, 12)) {
    try {
      const download = await fetchEndpoint(`/mods/${candidate.projectId}/files/${candidate.fileId}/download-url`);
      const downloadUrl = typeof download.body?.data === "string" ? download.body.data : "";
      if (!downloadUrl) {
        continue;
      }
      const response = await fetchDownload(downloadUrl, candidate);
      response.body?.cancel?.();
      if (response.ok) {
        return {
          status: response.status,
          hostname: response.finalHostname || null,
          projectId: candidate.projectId,
          fileId: candidate.fileId,
        };
      }
      lastFailure = {
        status: response.status,
        hostname: response.finalHostname || null,
        projectId: candidate.projectId,
        fileId: candidate.fileId,
      };
      if (![403, 404, 410].includes(response.status)) {
        break;
      }
    } catch (error) {
      lastFailure = {
        status: error?.details?.status || error?.statusCode || null,
        hostname: error?.details?.hostname || null,
        projectId: candidate.projectId,
        fileId: candidate.fileId,
        errorCode: error?.code || null,
      };
      if (![403, 404, 410].includes(Number(lastFailure.status))) {
        break;
      }
    }
  }

  throw new CurseForgeProxyError("CurseForge CDN probe failed.", "CURSEFORGE_CDN_PROBE_FAILED", lastFailure || {}, lastFailure?.status || 502);
}

async function testCurseForgeConnectivity() {
  const checkedAt = new Date().toISOString();
  const status = getCurseForgeProxyStatus();
  const result = {
    ok: false,
    checkedAt,
    status,
    api: { ok: false, status: null, errorCode: null },
    cdn: { ok: false, status: null, errorCode: null, hostname: null },
  };

  try {
    await fetchCurseForgeEndpoint("/minecraft/modloader");
    result.api = { ok: true, status: 200, errorCode: null };
  } catch (error) {
    result.api = { ok: false, status: error?.details?.status || error?.statusCode || null, errorCode: error?.code || "CURSEFORGE_API_TEST_FAILED" };
    result.errorCode = result.api.errorCode;
    return { statusCode: 200, body: result };
  }

  try {
    const search = await fetchCurseForgeEndpoint("/mods/search", {
      gameId: 432,
      classId: 4471,
      pageSize: 8,
      sortField: 2,
      sortOrder: "desc",
    });
    requireApiKey();
    const probe = await probeCurseForgeCdn(Array.isArray(search.body?.data) ? search.body.data : []);
    result.cdn = { ok: true, status: probe.status, errorCode: null, hostname: probe.hostname };
    result.ok = true;
    return { statusCode: 200, body: result };
  } catch (error) {
    result.cdn = {
      ok: false,
      status: error?.details?.status || error?.statusCode || null,
      errorCode: error?.code || "CURSEFORGE_CDN_TEST_FAILED",
      hostname: error?.details?.hostname || null,
    };
    result.errorCode = result.cdn.errorCode;
    return { statusCode: 200, body: result };
  }
}

async function routeExplicitEndpoint(request, url) {
  const pathname = url.pathname;
  const projectMatch = pathname.match(/^\/api\/v1\/marketplace\/curseforge\/projects\/(\d+)$/);
  if (request.method === "GET" && projectMatch) {
    return fetchCurseForgeEndpoint(`/mods/${projectMatch[1]}`);
  }

  const filesMatch = pathname.match(/^\/api\/v1\/marketplace\/curseforge\/projects\/(\d+)\/files$/);
  if (request.method === "GET" && filesMatch) {
    return fetchCurseForgeEndpoint(`/mods/${filesMatch[1]}/files`, getSearchParams(url, ["gameVersion", "modLoaderType", "pageSize", "index"]));
  }

  const fileMatch = pathname.match(/^\/api\/v1\/marketplace\/curseforge\/files\/(\d+)$/);
  if (request.method === "GET" && fileMatch) {
    const projectId = url.searchParams.get("projectId");
    if (!/^\d+$/.test(String(projectId || ""))) {
      throw new CurseForgeProxyError("CurseForge file lookup requires a numeric projectId.", "CURSEFORGE_PROJECT_ID_REQUIRED", {}, 400);
    }
    return fetchCurseForgeEndpoint(`/mods/${projectId}/files/${fileMatch[1]}`);
  }

  return null;
}

async function handleCurseForgeProxy(request, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/marketplace/curseforge/status") {
      return { statusCode: 200, body: getCurseForgeProxyStatus() };
    }
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/v1/marketplace/curseforge/test") {
      return await testCurseForgeConnectivity();
    }
    if (request.method === "GET" && url.pathname === "/api/v1/marketplace/curseforge/search") {
      return await fetchCurseForgeEndpoint("/mods/search", getSearchParams(url, ["gameId", "classId", "searchFilter", "gameVersion", "modLoaderType", "sortField", "sortOrder", "index", "pageSize"]));
    }
    const endpointResult = await routeExplicitEndpoint(request, url);
    if (endpointResult) {
      return endpointResult;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/marketplace/curseforge/api") {
      return await fetchCurseForgeApi(url);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/marketplace/curseforge/download") {
      return await fetchCurseForgeDownload(url);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/marketplace/curseforge/download") {
      return await fetchCurseForgeDownloadPost(request);
    }
    return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Request failed." } } };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      body: {
        error: {
          code: error.code || "CURSEFORGE_PROXY_FAILED",
          message: error.message || "CurseForge proxy request failed.",
          details: error.details || null,
        },
      },
    };
  }
}

module.exports = {
  _test: {
    buildCdnRequestHeaders,
    probeCurseForgeCdn,
  },
  getCurseForgeProxyStatus,
  handleCurseForgeProxy,
};
