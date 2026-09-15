const DEFAULT_RELEASE_REPOSITORY = "AnxLabs/AnxOS-Control-Center-Releases";
const REQUEST_TIMEOUT_MS = 9000;

function repositoryFromEnv(env = {}) {
  const value = String(env.ANXOS_RELEASE_REPOSITORY || env.ANXOS_GITHUB_REPOSITORY || DEFAULT_RELEASE_REPOSITORY).trim();
  const [owner, repo] = value.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/i, "").split("/");
  if (`${owner}/${repo}` !== DEFAULT_RELEASE_REPOSITORY) return null;
  return { owner, repo, repositoryUrl: `https://github.com/${owner}/${repo}` };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=300" : "no-store",
      ...headers,
    },
  });
}

function isExpectedAssetUrl(value, repository) {
  try {
    const parsed = new URL(value);
    return `${repository?.owner}/${repository?.repo}` === DEFAULT_RELEASE_REPOSITORY &&
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith(`/${repository.owner}/${repository.repo}/releases/download/`);
  } catch {
    return false;
  }
}

function classifyAssetName(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower || lower === "source code (zip)" || lower === "source code (tar.gz)") return "";
  if (lower.endsWith(".exe") && lower.includes("setup")) return "windows";
  if (lower.endsWith(".exe") && lower.includes("portable")) return "windows-portable";
  if (lower.endsWith(".msi")) return "windows";
  if (lower.endsWith(".appimage")) return "linux-appimage";
  if (lower.endsWith(".deb")) return "linux-deb";
  return "";
}

// Stable download routes must treat release candidates as non-promoted. An RC is
// published with the pre-release flag, so it is never selected by stable/latest until
// an explicit promotion flips it to a public stable release. This keeps the newest
// published, non-pre-release build as the only stable "latest".
function pickReleaseWithInstaller(releases, { allowPrerelease = false } = {}) {
  return (Array.isArray(releases) ? releases : [])
    .filter((candidate) => candidate && !candidate.draft && (allowPrerelease || !candidate.prerelease))
    .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0))
    .find((candidate) => Array.isArray(candidate.assets) && candidate.assets.some((asset) => classifyAssetName(asset?.name))) || null;
}

async function fetchLatestRelease(env = {}, options = {}) {
  const repository = repositoryFromEnv(env);
  if (!repository) {
    throw Object.assign(new Error("GitHub repository is not configured."), { code: "REPOSITORY_NOT_CONFIGURED" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/releases?per_page=20`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "anxos-download-router" },
      signal: controller.signal,
    });
    const text = await response.text();
    let releases;
    try {
      releases = text ? JSON.parse(text) : [];
    } catch {
      throw Object.assign(new Error("GitHub release API returned invalid JSON."), { code: "INVALID_RELEASE_JSON" });
    }
    if (!response.ok) {
      const code = response.status === 404 ? "GITHUB_RELEASE_SOURCE_NOT_FOUND" : response.status === 403 ? "GITHUB_RATE_LIMITED" : `GITHUB_HTTP_${response.status}`;
      throw Object.assign(new Error(releases?.message || `GitHub release API failed with HTTP ${response.status}.`), { code, status: response.status });
    }
    const published = (Array.isArray(releases) ? releases : [])
      .filter((candidate) => candidate && !candidate.draft)
      .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0));
    if (!published.length) {
      throw Object.assign(new Error("No published AnxOS release is available yet."), { code: "NO_PUBLISHED_RELEASE" });
    }
    const release = pickReleaseWithInstaller(published, { allowPrerelease: Boolean(options.allowPrerelease) });
    if (!release) {
      throw Object.assign(new Error("The latest release does not contain a supported installer."), { code: "NO_SUPPORTED_INSTALLER" });
    }
    return { repository, release };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("GitHub release API request timed out."), { code: "RELEASE_API_TIMEOUT" });
    }
    if (error instanceof TypeError && /fetch|network|failed/i.test(error.message || "")) {
      throw Object.assign(new Error("AnxOS could not reach the release service."), { code: "RELEASE_NETWORK_ERROR" });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function findArtifact(release, repository, artifactType) {
  const matches = (release.assets || [])
    .filter((asset) => classifyAssetName(asset?.name) === artifactType)
    .filter((asset) => asset.browser_download_url && isExpectedAssetUrl(asset.browser_download_url, repository));
  if (artifactType === "windows") {
    return matches.find((asset) => /setup/i.test(asset.name)) || matches[0] || null;
  }
  return matches[0] || null;
}

function wantsPrerelease(request) {
  try {
    return ["1", "true", "yes"].includes(String(new URL(request.url).searchParams.get("prerelease") || "").toLowerCase());
  } catch {
    return false;
  }
}

async function redirectLatestArtifact(request, env, artifactType, options = {}) {
  try {
    const allowPrerelease = Boolean(options.allowPrerelease) || wantsPrerelease(request);
    const { repository, release } = await fetchLatestRelease(env, { allowPrerelease });
    const asset = findArtifact(release, repository, artifactType);
    if (!asset) {
      return json({
        error: {
          code: "ARTIFACT_NOT_FOUND",
          message: "The requested AnxOS download artifact is not available in the latest published release.",
          artifactType,
        },
      }, 404);
    }
    return Response.redirect(asset.browser_download_url, 302);
  } catch (error) {
    return json({
      error: {
        code: error?.code || "RELEASE_LOOKUP_FAILED",
        message: error?.message || "Latest release could not be resolved.",
        artifactType,
      },
    }, error?.status && error.status >= 400 && error.status < 500 ? 502 : 503);
  }
}

export {
  DEFAULT_RELEASE_REPOSITORY,
  classifyAssetName,
  findArtifact,
  isExpectedAssetUrl,
  json,
  pickReleaseWithInstaller,
  redirectLatestArtifact,
  repositoryFromEnv,
};
