(function attachReleaseDownloadService(globalScope) {
  "use strict";

  const CACHE_TTL_MS = 10 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 9000;
  const SOURCE_ARCHIVE_NAMES = new Set(["Source code (zip)", "Source code (tar.gz)"]);
  const ARTIFACT_ORDER = ["windows-setup", "windows-portable", "windows-msi", "linux-appimage", "linux-deb"];
  const CHECKSUM_PATTERN = /(^sha256sums$|^checksums\.txt$|\.sha256$|sha256)/i;
  const OFFICIAL_RELEASE_REPOSITORY = Object.freeze({ owner: "AnxLabs", repo: "AnxOS-Control-Center-Releases" });

  function isOfficialRepository(repository) {
    return repository?.owner === OFFICIAL_RELEASE_REPOSITORY.owner && repository?.repo === OFFICIAL_RELEASE_REPOSITORY.repo;
  }

  function trim(value) {
    return String(value || "").trim();
  }

  function parseRepositoryUrl(repositoryUrl) {
    try {
      const parsed = new URL(repositoryUrl);
      if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
      const [owner, repo] = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (!owner || !repo) return null;
      const repository = { owner, repo: repo.replace(/\.git$/i, ""), repositoryUrl: `https://github.com/${owner}/${repo.replace(/\.git$/i, "")}` };
      return isOfficialRepository(repository) ? repository : null;
    } catch {
      return null;
    }
  }

  function repositoryFromConfig(config = {}, repositoryUrl = "") {
    const configured = config.releaseRepository || {};
    const owner = trim(configured.owner);
    const repo = trim(configured.repo).replace(/\.git$/i, "");
    if (owner && repo) {
      const repository = { owner, repo, repositoryUrl: `https://github.com/${owner}/${repo}` };
      return isOfficialRepository(repository) ? repository : null;
    }
    return parseRepositoryUrl(repositoryUrl || config.repositoryUrl);
  }

  function githubApiUrl(repository) {
    return `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases?per_page=20`;
  }

  function isExpectedAssetUrl(value, repository) {
    try {
      const parsed = new URL(value);
      const releasePrefix = `/${OFFICIAL_RELEASE_REPOSITORY.owner}/${OFFICIAL_RELEASE_REPOSITORY.repo}/releases/download/`;
      return isOfficialRepository(repository) && parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.pathname.startsWith(releasePrefix);
    } catch {
      return false;
    }
  }

  function formatBytes(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let amount = value;
    let unitIndex = 0;
    while (amount >= 1024 && unitIndex < units.length - 1) {
      amount /= 1024;
      unitIndex += 1;
    }
    return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function parseReleaseIdentity(release, fallback = {}) {
    const haystack = [release?.tag_name, release?.name, ...(release?.assets || []).map((asset) => asset?.name)].filter(Boolean).join(" ");
    const versionMatch = haystack.match(/(?:^|[^0-9])v?(\d+\.\d+(?:\.\d+)?)(?:[^0-9]|$)/i);
    const buildMatch = haystack.match(/build[-_ ]?(\d+)/i);
    const bodyChannel = String(release?.body || "").match(/channel\s*[:=-]\s*([^\n\r]+)/i);
    return {
      version: versionMatch?.[1] || trim(fallback.latestVersion),
      buildNumber: buildMatch?.[1] || trim(fallback.buildNumber || fallback.build),
      channel: trim(bodyChannel?.[1]) || trim(fallback.channel) || (release?.prerelease ? "Prerelease" : "Stable"),
    };
  }

  function inferArchitecture(fileName) {
    const name = String(fileName || "").toLowerCase();
    if (/(^|[-_.])(?:x64|x86_64|amd64)([-_.]|$)/.test(name)) return "x64";
    if (/(^|[-_.])(?:arm64|aarch64)([-_.]|$)/.test(name)) return "arm64";
    if (/(^|[-_.])(?:ia32|x86|i386)([-_.]|$)/.test(name)) return "x86";
    return "";
  }

  function classifyAsset(asset) {
    const fileName = trim(asset?.name);
    const lower = fileName.toLowerCase();
    if (!fileName || SOURCE_ARCHIVE_NAMES.has(fileName)) return null;
    if (CHECKSUM_PATTERN.test(fileName)) {
      return { checksum: true, fileName };
    }
    if (!asset?.browser_download_url) return null;
    if (lower.endsWith(".exe") && lower.includes("setup")) {
      return { platform: "windows", packageType: "setup", installerType: "Windows Setup", key: "windows-setup" };
    }
    if (lower.endsWith(".exe") && lower.includes("portable")) {
      return { platform: "windows", packageType: "portable", installerType: "Windows Portable", key: "windows-portable" };
    }
    if (lower.endsWith(".msi")) {
      return { platform: "windows", packageType: "msi", installerType: "Windows MSI", key: "windows-msi" };
    }
    if (lower.endsWith(".appimage")) {
      return { platform: "linux", packageType: "appimage", installerType: "Linux AppImage", key: "linux-appimage" };
    }
    if (lower.endsWith(".deb")) {
      return { platform: "linux", packageType: "deb", installerType: "Linux .deb", key: "linux-deb" };
    }
    return null;
  }

  function checksumForAsset(asset, checksumAssets) {
    const exact = checksumAssets.find((checksum) => checksum.fileName.toLowerCase() === `${asset.fileName.toLowerCase()}.sha256`);
    return exact || checksumAssets.find((checksum) => /sha256sums|checksums/i.test(checksum.fileName)) || checksumAssets[0] || null;
  }

  function normalizeRelease(release, options = {}) {
    const repository = parseRepositoryUrl(options.repositoryUrl);
    if (!repository || !release || release.draft) return null;
    const checksumAssets = [];
    const assets = [];
    (Array.isArray(release.assets) ? release.assets : []).forEach((asset) => {
      const classification = classifyAsset(asset);
      if (!classification) return;
      if (classification.checksum) {
        if (asset.browser_download_url && isExpectedAssetUrl(asset.browser_download_url, repository)) {
          checksumAssets.push({
            fileName: classification.fileName,
            fileSize: Number(asset.size) || 0,
            fileSizeLabel: formatBytes(asset.size),
            downloadUrl: asset.browser_download_url,
          });
        }
        return;
      }
      if (!isExpectedAssetUrl(asset.browser_download_url, repository)) return;
      assets.push({
        key: classification.key,
        platform: classification.platform,
        packageType: classification.packageType,
        installerType: classification.installerType,
        architecture: inferArchitecture(asset.name),
        fileName: asset.name,
        fileSize: Number(asset.size) || 0,
        fileSizeLabel: formatBytes(asset.size),
        downloadUrl: asset.browser_download_url,
      });
    });
    assets.sort((left, right) => ARTIFACT_ORDER.indexOf(left.key) - ARTIFACT_ORDER.indexOf(right.key));
    assets.forEach((asset) => {
      asset.checksumAsset = checksumForAsset(asset, checksumAssets);
    });
    const identity = parseReleaseIdentity(release, options.config || {});
    return {
      repository,
      tagName: trim(release.tag_name),
      title: trim(release.name) || trim(release.tag_name),
      version: identity.version,
      buildNumber: identity.buildNumber,
      channel: identity.channel,
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at || "",
      releaseNotesUrl: release.html_url || `${repository.repositoryUrl}/releases/tag/${encodeURIComponent(trim(release.tag_name))}`,
      releaseBody: trim(release.body),
      assets,
      checksumAssets,
    };
  }

  function latestPublishedRelease(releases, options = {}) {
    const normalized = (Array.isArray(releases) ? releases : [])
      .filter((release) => release && !release.draft && (options.allowPrerelease || !release.prerelease))
      .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0))
      .map((release) => normalizeRelease(release, options))
      .find((release) => release && release.assets.length > 0);
    return normalized || null;
  }

  function publishedReleases(releases, options = {}) {
    return (Array.isArray(releases) ? releases : [])
      .filter((release) => release && !release.draft && (options.allowPrerelease || !release.prerelease))
      .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0));
  }

  function preferredAssetForPlatform(release, platform) {
    const assets = release?.assets || [];
    const os = String(platform || detectPlatform()).toLowerCase();
    if (os === "windows") {
      return assets.find((asset) => asset.key === "windows-setup") ||
        assets.find((asset) => asset.key === "windows-msi") ||
        assets.find((asset) => asset.key === "windows-portable") ||
        null;
    }
    if (os === "linux") {
      return assets.find((asset) => asset.key === "linux-appimage") ||
        assets.find((asset) => asset.key === "linux-deb") ||
        null;
    }
    return null;
  }

  function detectPlatform() {
    const uaPlatform = trim(globalScope.navigator?.userAgentData?.platform || globalScope.navigator?.platform).toLowerCase();
    const ua = trim(globalScope.navigator?.userAgent).toLowerCase();
    const value = `${uaPlatform} ${ua}`;
    if (/win/.test(value)) return "windows";
    if (/linux|x11/.test(value)) return "linux";
    if (/mac|darwin|iphone|ipad/.test(value)) return "macos";
    return "unknown";
  }

  function cacheKey(repository) {
    return `anxos.latestRelease.${repository.owner}.${repository.repo}`;
  }

  function readCachedRelease(repository) {
    try {
      const raw = globalScope.sessionStorage?.getItem(cacheKey(repository));
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached?.release || Date.now() - Number(cached.cachedAt || 0) > CACHE_TTL_MS) return null;
      return cached.release;
    } catch {
      return null;
    }
  }

  function writeCachedRelease(repository, release) {
    try {
      globalScope.sessionStorage?.setItem(cacheKey(repository), JSON.stringify({ cachedAt: Date.now(), release }));
    } catch {}
  }

  function releaseDebugEnabled() {
    try {
      return new URLSearchParams(globalScope.location?.search || "").has("debug") ||
        globalScope.localStorage?.getItem?.("anxos.releaseDebug") === "1";
    } catch {
      return false;
    }
  }

  function logReleaseDiagnostic(operation, details) {
    if (!releaseDebugEnabled() || typeof globalScope.console?.debug !== "function") return;
    globalScope.console.debug("[AnxOS][Downloads]", operation, details);
  }

  async function fetchJsonWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = globalScope.setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
    try {
      const response = await globalScope.fetch(url, {
        headers: { accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        const error = new Error("GitHub release API returned invalid JSON.");
        error.code = "INVALID_RELEASE_JSON";
        throw error;
      }
      if (!response.ok) {
        const error = new Error(payload?.message || `GitHub release API failed with HTTP ${response.status}.`);
        error.code = response.status === 404 ? "GITHUB_RELEASE_SOURCE_NOT_FOUND" : response.status === 403 ? "GITHUB_RATE_LIMITED" : `GITHUB_HTTP_${response.status}`;
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error("GitHub release API request timed out.");
        timeoutError.code = "RELEASE_API_TIMEOUT";
        throw timeoutError;
      }
      if (error instanceof TypeError && /fetch|network|failed/i.test(error.message || "")) {
        const networkError = new Error("AnxOS could not reach the release service.");
        networkError.code = "RELEASE_NETWORK_ERROR";
        throw networkError;
      }
      throw error;
    } finally {
      globalScope.clearTimeout(timeout);
    }
  }

  async function loadLatestRelease(options = {}) {
    const config = options.config || globalScope.ANXOS_DOWNLOAD_CONFIG || {};
    const allowPrerelease = Boolean(options.allowPrerelease) || (typeof globalScope.location?.search === "string" && new URLSearchParams(globalScope.location.search).has("prerelease"));
    const repository = repositoryFromConfig(config, options.repositoryUrl);
    if (!repository) {
      const error = new Error("Official GitHub repository is not configured.");
      error.code = "REPOSITORY_NOT_CONFIGURED";
      throw error;
    }
    if (!options.force) {
      const cached = readCachedRelease(repository);
      if (cached) return cached;
    }
    const releases = await fetchJsonWithTimeout(options.apiUrl || githubApiUrl(repository), options);
    const published = publishedReleases(releases, { allowPrerelease });
    logReleaseDiagnostic("release-source", {
      repository: `${repository.owner}/${repository.repo}`,
      publishedReleases: published.length,
      totalReleases: Array.isArray(releases) ? releases.length : 0,
    });
    if (published.length === 0) {
      const error = new Error("No published AnxOS release is available yet.");
      error.code = "NO_PUBLISHED_RELEASE";
      throw error;
    }
    const release = published
      .map((candidate) => normalizeRelease(candidate, { repositoryUrl: repository.repositoryUrl, config }))
      .find((candidate) => candidate && candidate.assets.length > 0);
    logReleaseDiagnostic("release-assets", {
      repository: `${repository.owner}/${repository.repo}`,
      validAssets: release?.assets?.length || 0,
    });
    if (!release) {
      const error = new Error("The latest release does not contain a supported installer.");
      error.code = "NO_SUPPORTED_INSTALLER";
      throw error;
    }
    writeCachedRelease(repository, release);
    return release;
  }

  const api = {
    ARTIFACT_ORDER,
    CACHE_TTL_MS,
    OFFICIAL_RELEASE_REPOSITORY,
    classifyAsset,
    detectPlatform,
    formatBytes,
    githubApiUrl,
    isExpectedAssetUrl,
    latestPublishedRelease,
    loadLatestRelease,
    normalizeRelease,
    parseRepositoryUrl,
    publishedReleases,
    repositoryFromConfig,
    preferredAssetForPlatform,
  };

  globalScope.AnxOSReleaseDownloads = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
