const ASSET_MATCHERS = {
  windows: (name) => /\.exe$/i.test(name) && /setup/i.test(name),
  "windows-portable": (name) => /\.exe$/i.test(name) && /portable/i.test(name),
  "linux-appimage": (name) => /\.appimage$/i.test(name),
  "linux-deb": (name) => /\.deb$/i.test(name) && /control-center/i.test(name),
  "linux-agent-deb": (name) => /\.deb$/i.test(name) && /agent/i.test(name),
};
const OFFICIAL_RELEASE_REPOSITORY = "AnxLabs/AnxOS-Control-Center-Releases";
const RELEASE_LIST_PAGE_SIZE = 100;
const MAX_RELEASE_LIST_PAGES = 5;
const NON_STABLE_MARKER = /(?:^|[^a-z0-9])rc\d*(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])(?:alpha|beta|preview)(?:[^a-z0-9]|$)|release[\s-]*candidate|private[\s-]*alpha|public[\s-]*alpha/i;

function assetHasChecksum(asset, release) {
  const digest = String(asset?.digest || asset?.sha256 || asset?.checksum || "").trim();
  if (/^(?:sha256:)?[a-f0-9]{64}$/i.test(digest)) return true;
  const name = String(asset?.name || "");
  return Boolean(name) && (release?.assets || []).some((item) => String(item?.name || "") === `${name}.sha256`);
}

function compareDownloadIdentityDesc(left, right) {
  const versionOf = (release) => {
    const match = String(release?.tag_name || release?.name || "").match(/(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2])] : [0, 0];
  };
  const buildOf = (release) => {
    const match = [release?.tag_name, release?.name].join(" ").match(/build[-_. ]?(\d+)/i);
    return match ? Number(match[1]) : 0;
  };
  const leftVersion = versionOf(left);
  const rightVersion = versionOf(right);
  if (leftVersion[0] !== rightVersion[0]) return rightVersion[0] - leftVersion[0];
  if (leftVersion[1] !== rightVersion[1]) return rightVersion[1] - leftVersion[1];
  return buildOf(right) - buildOf(left);
}

function nextReleasePageUrl(linkHeader, currentUrl) {
  const match = String(linkHeader || "").match(/<([^>]+)>;\s*rel="next"/i);
  if (!match) return "";
  try {
    const next = new URL(match[1]);
    const current = new URL(currentUrl);
    if (next.origin !== current.origin || !next.pathname.endsWith("/releases")) return "";
    const page = Number(next.searchParams.get("page"));
    if (!Number.isInteger(page) || page < 1 || page > MAX_RELEASE_LIST_PAGES) return "";
    return next.toString();
  } catch {
    return "";
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function latestDownload(request, env, platform) {
  const select = ASSET_MATCHERS[platform];
  if (!select) return json({ error: "unsupported_platform" }, 404);
  let allowPrerelease = false;
  try {
    allowPrerelease = ["1", "true", "yes"].includes(String(new URL(request.url).searchParams.get("prerelease") || "").toLowerCase());
  } catch {}
  const configured = env.ANXOS_RELEASE_REPOSITORY || env.ANXOS_GITHUB_REPOSITORY || OFFICIAL_RELEASE_REPOSITORY;
  const match = String(configured).trim().match(/^([^/]+)\/([^/]+)$/);
  if (!match || `${match[1]}/${match[2]}` !== OFFICIAL_RELEASE_REPOSITORY) return json({ error: "release_repository_not_configured" }, 500);
  const releases = [];
  let pageUrl = `https://api.github.com/repos/${match[1]}/${match[2]}/releases?per_page=${RELEASE_LIST_PAGE_SIZE}&page=1`;
  const seenPages = new Set();
  for (let page = 0; pageUrl && !seenPages.has(pageUrl) && page < MAX_RELEASE_LIST_PAGES; page += 1) {
    seenPages.add(pageUrl);
    const response = await fetch(pageUrl, { headers: { accept: "application/vnd.github+json", "user-agent": "AnxOS-website-downloads" } });
    if (!response.ok) return json({ error: "release_source_unavailable", status: response.status }, 502);
    const batch = await response.json();
    const pageReleases = Array.isArray(batch) ? batch : [];
    releases.push(...pageReleases);
    if (pageReleases.length < RELEASE_LIST_PAGE_SIZE) break;
    pageUrl = nextReleasePageUrl(response.headers?.get?.("link") || "", pageUrl);
  }
  // Stable/latest downloads must not treat an alpha or RC as stable from GitHub's
  // prerelease flag or list order. A prerelease is served only with ?prerelease=1.
  // Keep NON_STABLE_MARKER identical to src/shared/releaseChannelSelection.js.
  const release = releases
    .filter((item) => {
      if (!item || item.draft) return false;
      if (allowPrerelease) return true;
      if (item.prerelease === true) return false;
      const identity = [item.tag_name, item.tagName, item.name, item.releaseLabel, item.channel].map((value) => (typeof value === "string" ? value : "")).join("\n");
      if (NON_STABLE_MARKER.test(identity)) return false;
      const channel = String(item.channel || "").trim().toLowerCase();
      return !channel || channel === "stable";
    })
    .sort(compareDownloadIdentityDesc)
    .find((item) => (item.assets || []).some((candidate) => select(candidate.name || "") && assetHasChecksum(candidate, item) && String(candidate.browser_download_url || "").startsWith(`https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/`)));
  const asset = release?.assets?.find((candidate) => select(candidate.name || "") && assetHasChecksum(candidate, release) && String(candidate.browser_download_url || "").startsWith(`https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/`));
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
