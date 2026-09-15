const PLATFORM_ASSETS = {
  windows: (name) => /\.exe$/i.test(name) && /setup/i.test(name),
  "windows-portable": (name) => /\.exe$/i.test(name) && /portable/i.test(name),
  "linux-appimage": (name) => /\.appimage$/i.test(name),
  "linux-deb": (name) => /\.deb$/i.test(name),
};
const OFFICIAL_RELEASE_REPOSITORY = "AnxLabs/AnxOS-Control-Center-Releases";

function repositoryFromEnv(env) {
  const value = env.ANXOS_RELEASE_REPOSITORY || env.ANXOS_GITHUB_REPOSITORY || OFFICIAL_RELEASE_REPOSITORY;
  const match = String(value).trim().match(/^([^/]+)\/([^/]+)$/);
  return match && `${match[1]}/${match[2]}` === OFFICIAL_RELEASE_REPOSITORY ? { owner: match[1], repo: match[2] } : null;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequestGet({ request, params, env }) {
  const select = PLATFORM_ASSETS[String(params.platform || "").toLowerCase()];
  if (!select) return json({ error: "unsupported_platform" }, 404);
  const repository = repositoryFromEnv(env || {});
  if (!repository) return json({ error: "release_repository_not_configured" }, 500);

  let allowPrerelease = false;
  try {
    allowPrerelease = ["1", "true", "yes"].includes(String(new URL(request.url).searchParams.get("prerelease") || "").toLowerCase());
  } catch {}

  const apiUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases?per_page=20`;
  let releases;
  try {
    const response = await fetch(apiUrl, { headers: { accept: "application/vnd.github+json", "user-agent": "AnxOS-website-downloads" } });
    if (!response.ok) return json({ error: "release_source_unavailable", status: response.status }, 502);
    releases = await response.json();
  } catch {
    return json({ error: "release_source_unavailable" }, 502);
  }

  // Stable/latest downloads resolve only non-pre-release releases; RCs are served
  // only when a caller explicitly opts in with ?prerelease=1.
  const release = (Array.isArray(releases) ? releases : [])
    .filter((candidate) => candidate && !candidate.draft && (allowPrerelease || !candidate.prerelease))
    .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0))
    .find((candidate) => (candidate.assets || []).some((asset) => select(asset.name || "") && String(asset.browser_download_url || "").startsWith(`https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/`)));
  const asset = release?.assets?.find((candidate) => select(candidate.name || "") && String(candidate.browser_download_url || "").startsWith(`https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/`));
  if (!asset) return json({ error: "release_asset_unavailable" }, 404);
  return new Response(null, {
    status: 302,
    headers: { location: asset.browser_download_url, "cache-control": "no-store" },
  });
}

