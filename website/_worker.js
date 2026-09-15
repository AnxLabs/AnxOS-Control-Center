const ASSET_MATCHERS = {
  windows: (name) => /\.exe$/i.test(name) && /setup/i.test(name),
  "windows-portable": (name) => /\.exe$/i.test(name) && /portable/i.test(name),
  "linux-appimage": (name) => /\.appimage$/i.test(name),
  "linux-deb": (name) => /\.deb$/i.test(name),
};
const OFFICIAL_RELEASE_REPOSITORY = "AnxLabs/AnxOS-Control-Center-Releases";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function latestDownload(request, env, platform) {
  const select = ASSET_MATCHERS[platform];
  if (!select) return json({ error: "unsupported_platform" }, 404);
  const configured = env.ANXOS_RELEASE_REPOSITORY || env.ANXOS_GITHUB_REPOSITORY || OFFICIAL_RELEASE_REPOSITORY;
  const match = String(configured).trim().match(/^([^/]+)\/([^/]+)$/);
  if (!match || `${match[1]}/${match[2]}` !== OFFICIAL_RELEASE_REPOSITORY) return json({ error: "release_repository_not_configured" }, 500);
  const response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/releases?per_page=20`, { headers: { accept: "application/vnd.github+json", "user-agent": "AnxOS-website-downloads" } });
  if (!response.ok) return json({ error: "release_source_unavailable", status: response.status }, 502);
  const releases = await response.json();
  const asset = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft)
    .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0))
    .flatMap((release) => release.assets || [])
    .find((candidate) => select(candidate.name || "") && String(candidate.browser_download_url || "").startsWith(`https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/`));
  if (!asset) return json({ error: "release_asset_unavailable" }, 404);
  return new Response(null, { status: 302, headers: { location: asset.browser_download_url, "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/download\/latest\/([^/]+)\/?$/);
    if (request.method === "GET" && match) return latestDownload(request, env, match[1].toLowerCase());
    return env.ASSETS.fetch(request);
  },
};
