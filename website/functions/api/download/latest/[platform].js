// Not used while website/_worker.js exists (Pages then ignores /functions).
// Kept in step with the worker's download route: same matchers, same cache
// and fallbacks for GitHub's shared-IP rate limit (see _worker.js).
const PLATFORM_ASSETS = {
  windows: (name) => /\.exe$/i.test(name) && /setup/i.test(name),
  "windows-portable": (name) => /\.exe$/i.test(name) && /portable/i.test(name),
  "linux-appimage": (name) => /\.appimage$/i.test(name),
  "linux-deb": (name) => /\.deb$/i.test(name) && /control-center/i.test(name),
  "linux-agent-deb": (name) => /\.deb$/i.test(name) && /agent/i.test(name),
};
const OFFICIAL_RELEASE_REPOSITORY = "AnxLabs/AnxOS-Control-Center-Releases";
const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/`;
const RELEASES_FRESH_MS = 5 * 60 * 1000;
const RELEASES_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASES_CACHE_PATH = "/__anx-cache/github-releases-v1";

function repositoryFromEnv(env) {
  const value = env.ANXOS_RELEASE_REPOSITORY || env.ANXOS_GITHUB_REPOSITORY || OFFICIAL_RELEASE_REPOSITORY;
  const match = String(value).trim().match(/^([^/]+)\/([^/]+)$/);
  return match && `${match[1]}/${match[2]}` === OFFICIAL_RELEASE_REPOSITORY ? { owner: match[1], repo: match[2] } : null;
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function isOfficialAssetUrl(value) {
  return String(value || "").startsWith(RELEASE_DOWNLOAD_PREFIX);
}

async function loadReleases(request, env, repository, waitUntil) {
  const now = Date.now();
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(RELEASES_CACHE_PATH, request.url).toString());
  let cached = null;
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      const fetchedAt = Number(hit?.headers.get("x-anx-fetched-at"));
      if (hit && Number.isFinite(fetchedAt)) cached = { fetchedAt, releases: await hit.json() };
    } catch {}
  }
  if (cached && now - cached.fetchedAt < RELEASES_FRESH_MS) return { releases: cached.releases };
  const headers = { accept: "application/vnd.github+json", "user-agent": "AnxHost-website-downloads" };
  if (env.ANXOS_GITHUB_TOKEN) headers.authorization = `Bearer ${env.ANXOS_GITHUB_TOKEN}`;
  let status = 0;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/releases?per_page=20`, { headers });
    status = response.status;
    if (response.ok) {
      const releases = await response.json();
      if (Array.isArray(releases)) {
        if (cache) {
          const write = cache.put(cacheKey, new Response(JSON.stringify(releases), {
            headers: { "content-type": "application/json", "cache-control": `max-age=${Math.floor(RELEASES_STALE_MS / 1000)}`, "x-anx-fetched-at": String(now) },
          })).catch(() => {});
          if (typeof waitUntil === "function") waitUntil(write);
          else await write;
        }
        return { releases };
      }
    }
  } catch {}
  if (cached && now - cached.fetchedAt < RELEASES_STALE_MS) return { releases: cached.releases };
  return { error: "release_source_unavailable", status };
}

async function stableAssetFromConfig(request, env, select) {
  try {
    if (!env.ASSETS) return null;
    const response = await env.ASSETS.fetch(new Request(new URL("/config.js", request.url).toString()));
    if (!response.ok) return null;
    for (const match of (await response.text()).matchAll(/url:\s*"([^"]+)"/g)) {
      const fileName = decodeURIComponent(match[1].split("/").pop() || "");
      if (isOfficialAssetUrl(match[1]) && select(fileName)) return match[1];
    }
  } catch {}
  return null;
}

export async function onRequestGet({ request, params, env, waitUntil }) {
  const select = PLATFORM_ASSETS[String(params.platform || "").toLowerCase()];
  if (!select) return json({ error: "unsupported_platform" }, 404);
  const repository = repositoryFromEnv(env || {});
  if (!repository) return json({ error: "release_repository_not_configured" }, 500);

  let allowPrerelease = false;
  try {
    allowPrerelease = ["1", "true", "yes"].includes(String(new URL(request.url).searchParams.get("prerelease") || "").toLowerCase());
  } catch {}

  const loaded = await loadReleases(request, env || {}, repository, waitUntil);
  // Stable/latest downloads resolve only non-pre-release releases; RCs are served
  // only when a caller explicitly opts in with ?prerelease=1.
  const release = (Array.isArray(loaded.releases) ? loaded.releases : [])
    .filter((candidate) => candidate && !candidate.draft && (allowPrerelease || !candidate.prerelease))
    .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0))
    .find((candidate) => (candidate.assets || []).some((asset) => select(asset.name || "") && isOfficialAssetUrl(asset.browser_download_url)));
  const asset = release?.assets?.find((candidate) => select(candidate.name || "") && isOfficialAssetUrl(candidate.browser_download_url));
  if (asset) {
    return new Response(null, {
      status: 302,
      headers: { location: asset.browser_download_url, "cache-control": "no-store" },
    });
  }
  const fallback = loaded.error && !allowPrerelease ? await stableAssetFromConfig(request, env || {}, select) : null;
  if (fallback) return new Response(null, { status: 302, headers: { location: fallback, "cache-control": "no-store" } });
  if (loaded.error) return json({ error: loaded.error, status: loaded.status }, 503, { "retry-after": "60" });
  return json({ error: "release_asset_unavailable" }, 404);
}
