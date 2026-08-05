// deno-lint-ignore-file no-explicit-any
// AnxOS-controlled CurseForge marketplace proxy.
//
// This function is the only place the private CurseForge API key is used. It never returns
// the key to callers, never logs it, and only forwards narrowly-scoped, validated requests to
// the official CurseForge API. Desktop clients call this function through the existing
// "hosted proxy" contract in src/services/providers/curseforgeProvider.js.

const CURSEFORGE_API = "$2a$10$nyLi1lwui6V5DB.adMRDBeO5CrDIwN8wqtW3XnO148xsmtfTfvK0e";
const USER_AGENT = "AnxOS-Marketplace-Proxy/1.0 (+https://anxoscontrolcenter.org)";
const MINECRAFT_GAME_ID = 432;
const MODPACK_CLASS_ID = 4471;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://anxoscontrolcenter.org",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];
const configuredAllowedOrigins = (Deno.env.get("ANXOS_ALLOWED_ORIGINS") || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredAllowedOrigins]));

const curseForgeApiKey = Deno.env.get("CURSEFORGE_API_KEY") || "";

// Only these CurseForge API paths may be requested through the generic passthrough route.
// This intentionally excludes account, mod-upload, and any endpoint not needed for browsing,
// installing, or displaying modpacks so the proxy cannot be used as an open relay.
const ALLOWED_API_PATHS: RegExp[] = [
  /^\/games\/\d+$/,
  /^\/categories$/,
  /^\/mods\/search$/,
  /^\/mods\/\d+$/,
  /^\/mods\/\d+\/files$/,
  /^\/mods\/\d+\/files\/\d+$/,
  /^\/mods\/\d+\/files\/\d+\/download-url$/,
  /^\/minecraft\/version$/,
  /^\/minecraft\/modloader$/,
];

// CurseForge only ever serves files from these CDN hosts. Any download URL outside this
// allowlist (including a URL supplied directly by a caller) is rejected.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "media.forgecdn.net",
]);

const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 768 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// Best-effort, per-isolate rate limiting. Supabase Edge Functions can run multiple isolates,
// so this is a defense-in-depth layer, not a substitute for platform/CDN-level rate limiting.
// See docs/CURSEFORGE_MARKETPLACE_PROXY_DEPLOYMENT.md for production hardening guidance.
const API_RATE_LIMIT = { windowMs: 60_000, max: 90 };
const DOWNLOAD_RATE_LIMIT = { windowMs: 10 * 60_000, max: 12 };
const MAX_CONCURRENT_DOWNLOADS = 25;
const rateBuckets = new Map<string, number[]>();
let activeDownloads = 0;

class MarketplaceProxyError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 500) {
    super(message);
    this.name = "MarketplaceProxyError";
    this.code = code;
    this.status = status;
  }
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("cf-connecting-ip") || "unknown";
}

function checkRateLimit(key: string, limit: { windowMs: number; max: number }) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < limit.windowMs);
  bucket.push(now);
  rateBuckets.set(key, bucket);
  if (bucket.length > limit.max) {
    throw new MarketplaceProxyError("Too many CurseForge Marketplace requests. Please wait and try again.", "CURSEFORGE_RATE_LIMITED", 429);
  }
}

function auditEvent(event: string, request: Request, extra: Record<string, unknown> = {}) {
  // Structured, secret-free audit line. Supabase captures function logs for later review.
  console.info(JSON.stringify({
    event,
    ip: clientIp(request),
    method: request.method,
    at: new Date().toISOString(),
    ...extra,
  }));
}

function requireConfigured() {
  if (!curseForgeApiKey) {
    throw new MarketplaceProxyError("CurseForge Marketplace is not configured. Contact the AnxOS owner.", "CURSEFORGE_AUTH_CONFIGURATION_MISSING", 503);
  }
}

async function fetchWithTimeout(url: string | URL, options: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || REQUEST_TIMEOUT_MS));
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function assertAllowedApiPath(pathname: string) {
  const clean = String(pathname || "").trim();
  if (!clean || !ALLOWED_API_PATHS.some((pattern) => pattern.test(clean))) {
    throw new MarketplaceProxyError("This CurseForge resource is not supported.", "CURSEFORGE_PROXY_PATH_DENIED", 400);
  }
  return clean;
}

function buildCurseForgeUrl(pathname: string, params: Record<string, string | null | undefined> = {}) {
  const target = new URL(`${CURSEFORGE_API}${assertAllowedApiPath(pathname)}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  }
  return target;
}

function classifyUpstreamError(status: number, body: string, context: { modpack?: boolean; file?: boolean } = {}) {
  if (status === 404 && context.file) return new MarketplaceProxyError("The requested CurseForge file was not found.", "CURSEFORGE_FILE_NOT_FOUND", 404);
  if (status === 404 && context.modpack) return new MarketplaceProxyError("The requested CurseForge modpack was not found.", "CURSEFORGE_MODPACK_NOT_FOUND", 404);
  if (status === 401 || status === 403) return new MarketplaceProxyError("CurseForge Marketplace is not configured correctly. Contact the AnxOS owner.", "CURSEFORGE_AUTH_CONFIGURATION_MISSING", 503);
  if (status === 429) return new MarketplaceProxyError("CurseForge is rate limiting Marketplace requests. Please wait and try again.", "CURSEFORGE_RATE_LIMITED", 429);
  return new MarketplaceProxyError("CurseForge returned an unexpected error.", "CURSEFORGE_UPSTREAM_ERROR", 502);
}

async function fetchCurseForgeJson(pathname: string, params: Record<string, string | null | undefined> = {}, context: { modpack?: boolean; file?: boolean } = {}) {
  requireConfigured();
  const target = buildCurseForgeUrl(pathname, params);
  let response: Response;
  try {
    response = await fetchWithTimeout(target, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, "x-api-key": curseForgeApiKey },
    });
  } catch (error) {
    throw new MarketplaceProxyError("Could not reach CurseForge. Try again shortly.", "CURSEFORGE_UPSTREAM_ERROR", 502);
  }
  const text = await response.text();
  if (Buffer_byteLength(text) > MAX_JSON_BYTES) {
    throw new MarketplaceProxyError("CurseForge response exceeded the Marketplace proxy size limit.", "CURSEFORGE_INVALID_RESPONSE", 502);
  }
  if (!response.ok) {
    throw classifyUpstreamError(response.status, text, context);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MarketplaceProxyError("CurseForge returned an invalid response.", "CURSEFORGE_INVALID_RESPONSE", 502);
  }
}

function Buffer_byteLength(text: string) {
  return new TextEncoder().encode(text).length;
}

function validateDownloadUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new MarketplaceProxyError("The CurseForge download URL is invalid.", "CURSEFORGE_DOWNLOAD_UNAVAILABLE", 502);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!["https:", "http:"].includes(parsed.protocol) || (!ALLOWED_DOWNLOAD_HOSTS.has(hostname) && !hostname.endsWith(".curseforge.com"))) {
    throw new MarketplaceProxyError("The CurseForge download URL is not allowed.", "CURSEFORGE_DOWNLOAD_UNAVAILABLE", 502);
  }
  return parsed;
}

async function resolveDownloadUrl(rawUrl: string, projectId: string, fileId: string) {
  if (rawUrl) return validateDownloadUrl(rawUrl);
  if (projectId && fileId) {
    const payload = await fetchCurseForgeJson(`/mods/${projectId}/files/${fileId}/download-url`, {}, { file: true });
    const resolved = typeof payload?.data === "string" ? payload.data : "";
    if (!resolved) throw new MarketplaceProxyError("CurseForge did not provide a download URL for this file.", "CURSEFORGE_DOWNLOAD_UNAVAILABLE", 502);
    return validateDownloadUrl(resolved);
  }
  throw new MarketplaceProxyError("A download URL or projectId/fileId pair is required.", "CURSEFORGE_DOWNLOAD_UNAVAILABLE", 400);
}

async function fetchDownloadWithRedirects(url: URL) {
  let current = url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchWithTimeout(current, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      timeoutMs: DOWNLOAD_CONNECT_TIMEOUT_MS,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return response;
    current = validateDownloadUrl(new URL(location, current).toString());
  }
  throw new MarketplaceProxyError("CurseForge download exceeded the redirect limit.", "CURSEFORGE_DOWNLOAD_FAILED", 502);
}

function boundedDownloadStream(body: ReadableStream<Uint8Array>) {
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) {
            controller.error(new MarketplaceProxyError("CurseForge file exceeded the Marketplace proxy size limit.", "CURSEFORGE_DOWNLOAD_FAILED", 502));
            reader.cancel().catch(() => {});
            return;
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

async function handleDownload(request: Request, rawUrl: string, projectId: string, fileId: string) {
  requireConfigured();
  checkRateLimit(`download:${clientIp(request)}`, DOWNLOAD_RATE_LIMIT);
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    throw new MarketplaceProxyError("Too many CurseForge downloads are in progress. Try again shortly.", "CURSEFORGE_RATE_LIMITED", 429);
  }
  const target = await resolveDownloadUrl(rawUrl, projectId, fileId);
  activeDownloads += 1;
  let response: Response;
  try {
    response = await fetchDownloadWithRedirects(target);
  } catch (error) {
    activeDownloads -= 1;
    if (error instanceof MarketplaceProxyError) throw error;
    throw new MarketplaceProxyError("The CurseForge download could not be started.", "CURSEFORGE_DOWNLOAD_FAILED", 502);
  }
  if (!response.ok || !response.body) {
    activeDownloads -= 1;
    throw new MarketplaceProxyError("The CurseForge download failed.", "CURSEFORGE_DOWNLOAD_FAILED", response.status || 502);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    activeDownloads -= 1;
    response.body.cancel().catch(() => {});
    throw new MarketplaceProxyError("CurseForge file exceeded the Marketplace proxy size limit.", "CURSEFORGE_DOWNLOAD_FAILED", 502);
  }
  auditEvent("curseforge_download_started", request, { projectId: projectId || null, fileId: fileId || null, hostname: target.hostname });
  const stream = boundedDownloadStream(response.body);
  const wrapped = stream.pipeThrough(new TransformStream({
    flush() {
      activeDownloads = Math.max(0, activeDownloads - 1);
    },
  }));
  return new Response(wrapped, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      "Content-Type": response.headers.get("content-type") || "application/octet-stream",
      ...(response.headers.get("content-length") ? { "Content-Length": response.headers.get("content-length")! } : {}),
      "Cache-Control": "no-store",
      "X-AnxOS-CurseForge-Authenticated": "true",
    },
  });
}

function getSearchParams(url: URL, allowedKeys: string[]) {
  const result: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") result[key] = value;
  }
  return result;
}

function requireNumericParam(value: string | null, name: string) {
  if (!value || !/^\d+$/.test(value)) {
    throw new MarketplaceProxyError(`${name} must be numeric.`, "CURSEFORGE_PROXY_PATH_DENIED", 400);
  }
  return value;
}

function normalizeRoute(pathname: string) {
  return pathname
    .replace(/^\/functions\/v1\/anxos-marketplace-curseforge/, "")
    .replace(/^\/anxos-marketplace-curseforge/, "")
    .replace(/\/+$/, "") || "/";
}

async function readJson(request: Request) {
  if (request.method === "GET") return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const url = new URL(request.url);
  const route = normalizeRoute(url.pathname);

  try {
    checkRateLimit(`api:${clientIp(request)}`, API_RATE_LIMIT);

    // --- Status (no secrets returned) ---
    if (request.method === "GET" && (route === "/api/v1/marketplace/curseforge/status" || route === "/api/marketplace/curseforge/status")) {
      return json(request, { configured: Boolean(curseForgeApiKey) });
    }

    // --- Existing hosted-proxy contract used by the desktop app today ---
    if (request.method === "GET" && route === "/api/v1/marketplace/curseforge/api") {
      const pathname = url.searchParams.get("path") || "";
      const params = Object.fromEntries(url.searchParams.entries());
      delete params.path;
      const context = { modpack: /^\/mods\/\d+$/.test(pathname), file: /files\/\d+/.test(pathname) };
      const data = await fetchCurseForgeJson(pathname, params, context);
      return json(request, data);
    }
    if ((request.method === "GET" || request.method === "POST") && route === "/api/v1/marketplace/curseforge/download") {
      const body = request.method === "POST" ? await readJson(request) : {};
      const rawUrl = String(url.searchParams.get("url") || (body as any).url || (body as any).downloadUrl || "");
      const projectId = String(url.searchParams.get("projectId") || (body as any).projectId || "");
      const fileId = String(url.searchParams.get("fileId") || (body as any).fileId || "");
      return await handleDownload(request, rawUrl, projectId, fileId);
    }

    // --- Narrow, resource-scoped aliases matching the suggested Marketplace proxy API ---
    if (request.method === "GET" && route === "/api/marketplace/curseforge/games") {
      return json(request, await fetchCurseForgeJson(`/games/${MINECRAFT_GAME_ID}`));
    }
    if (request.method === "GET" && route === "/api/marketplace/curseforge/categories") {
      return json(request, await fetchCurseForgeJson("/categories", { gameId: String(MINECRAFT_GAME_ID), classId: String(MODPACK_CLASS_ID) }));
    }
    if (request.method === "GET" && route === "/api/marketplace/curseforge/modpacks") {
      const params = getSearchParams(url, ["searchFilter", "gameVersion", "modLoaderType", "sortField", "sortOrder", "index", "pageSize"]);
      return json(request, await fetchCurseForgeJson("/mods/search", { ...params, gameId: String(MINECRAFT_GAME_ID), classId: String(MODPACK_CLASS_ID) }));
    }
    const modpackMatch = route.match(/^\/api\/marketplace\/curseforge\/modpacks\/(\d+)$/);
    if (request.method === "GET" && modpackMatch) {
      return json(request, await fetchCurseForgeJson(`/mods/${requireNumericParam(modpackMatch[1], "modId")}`, {}, { modpack: true }));
    }
    const modpackFilesMatch = route.match(/^\/api\/marketplace\/curseforge\/modpacks\/(\d+)\/files$/);
    if (request.method === "GET" && modpackFilesMatch) {
      const params = getSearchParams(url, ["gameVersion", "modLoaderType", "pageSize", "index"]);
      return json(request, await fetchCurseForgeJson(`/mods/${requireNumericParam(modpackFilesMatch[1], "modId")}/files`, params, { modpack: true }));
    }
    const fileMatch = route.match(/^\/api\/marketplace\/curseforge\/files\/(\d+)$/);
    if (request.method === "GET" && fileMatch) {
      const modId = requireNumericParam(url.searchParams.get("modId"), "modId");
      return json(request, await fetchCurseForgeJson(`/mods/${modId}/files/${requireNumericParam(fileMatch[1], "fileId")}`, {}, { file: true }));
    }
    if (request.method === "POST" && route === "/api/marketplace/curseforge/download") {
      const body = await readJson(request);
      const rawUrl = String((body as any).url || (body as any).downloadUrl || "");
      const projectId = String((body as any).projectId || (body as any).modId || "");
      const fileId = String((body as any).fileId || "");
      return await handleDownload(request, rawUrl, projectId, fileId);
    }

    throw new MarketplaceProxyError("This Marketplace proxy path does not exist.", "CURSEFORGE_PROXY_PATH_DENIED", 404);
  } catch (error: unknown) {
    const proxyError = error instanceof MarketplaceProxyError
      ? error
      : new MarketplaceProxyError("CurseForge Marketplace request failed.", "CURSEFORGE_UPSTREAM_ERROR", 502);
    auditEvent("curseforge_proxy_error", request, { code: proxyError.code, status: proxyError.status, route });
    return json(request, { code: proxyError.code, message: proxyError.message }, proxyError.status);
  }
});
