const { EventEmitter } = require("events");
const { app, autoUpdater, BrowserWindow, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { openExternalUrl } = require("./externalUrlService");
const { OFFICIAL_SITE_ORIGIN } = require("../shared/officialSite");
const { sanitize } = require("../shared/redaction");
const { getReleaseInfo } = require("../shared/releaseConfig");

const DEFAULT_UPDATE_REPOSITORY = "bungopam-byte/AnxOS-Control-Center-Releases";
const UPDATE_REPOSITORY = normalizeUpdateRepository(process.env.ANXOS_UPDATE_REPOSITORY) || DEFAULT_UPDATE_REPOSITORY;
const UPDATE_RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=20`;
const UPDATE_LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const WEBSITE_CONFIG_URLS = [
  process.env.ANXOS_WEBSITE_CONFIG_URL,
  `${OFFICIAL_SITE_ORIGIN}/config.js`,
].filter(isProductionSafeMetadataUrl);
const UPDATE_MANIFEST_URLS = [
  process.env.ANXOS_UPDATE_MANIFEST_URL,
  process.env.ANXHUB_UPDATE_MANIFEST_URL,
  `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/update-manifest.json`,
].filter(isProductionSafeMetadataUrl);
const UPDATE_STATUS_CHANNEL = "updates:status";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_STORE_SCHEMA_VERSION = 2;

function normalizeUpdateRepository(value) {
  const repository = String(value || "").trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : "";
}

function isLocalMetadataHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || /^10\./.test(normalized)
    || /^192\.168\./.test(normalized)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized);
}

function isProductionSafeMetadataUrl(value) {
  if (!value) return false;
  if (app?.isPackaged !== true) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !isLocalMetadataHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[+-]/)[0];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if ((leftParts[index] || 0) > (rightParts[index] || 0)) return 1;
    if ((leftParts[index] || 0) < (rightParts[index] || 0)) return -1;
  }
  return 0;
}

function normalizeBuild(value) {
  const build = Number.parseInt(value, 10);
  if (Number.isInteger(build) && build >= 0) return build;
  const parsed = String(value || "").match(/\bbuild[-_. ]?(\d+)\b/i)?.[1];
  if (parsed) return normalizeBuild(parsed);
  return null;
}

function extractReleaseBuild(...values) {
  for (const value of values) {
    const build = normalizeBuild(value);
    if (build !== null) return build;
  }
  return null;
}

function compareReleaseBuilds(left, right) {
  const versionCompare = compareVersions(left?.version, right?.version);
  if (versionCompare !== 0) return versionCompare;
  return (normalizeBuild(left?.build) || 0) - (normalizeBuild(right?.build) || 0);
}

function formatReleaseLabel(version, build, channel = "") {
  const parts = [];
  if (version) parts.push(`Version ${version}`);
  if (normalizeBuild(build) !== null) parts.push(`Build ${normalizeBuild(build)}`);
  if (channel) parts.push(channel);
  return parts.join(" ");
}

function sanitizeFileName(value) {
  return String(value || "AnxOS-Control-Center-update.exe").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function normalizeSha256(value) {
  const digest = String(value || "").trim();
  const prefixed = digest.match(/^sha256:([a-f0-9]{64})$/i);
  if (prefixed) return prefixed[1].toLowerCase();
  return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

function normalizeAssetPlatform(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (platform === "windows" || platform === "win32") return "win32";
  if (platform === "linux") return "linux";
  if (platform === "macos" || platform === "mac" || platform === "darwin") return "darwin";
  return null;
}

function normalizeAssetArchitecture(value) {
  const architecture = String(value || "").trim().toLowerCase();
  if (architecture === "amd64" || architecture === "x86_64" || architecture === "x64") return "x64";
  if (architecture === "aarch64" || architecture === "arm64") return "arm64";
  return architecture || null;
}

function inferAssetPlatform(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized.endsWith(".exe")) return "win32";
  if (normalized.endsWith(".deb") || normalized.endsWith(".appimage")) return "linux";
  if (normalized.endsWith(".dmg")) return "darwin";
  return null;
}

function createDownloadPath(directory, fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const candidate = path.join(directory, `${stem}${suffix}${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw Object.assign(new Error("A unique update download filename could not be allocated."), { code: "UPDATE_DOWNLOAD_NAME_EXHAUSTED" });
}

function getUpdateDownloadDirectory() {
  return app?.getPath?.("downloads") || os.tmpdir();
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function verifyUpdateArtifact(filePath, asset = {}) {
  const expectedSha256 = normalizeSha256(asset.sha256);
  if (!expectedSha256) {
    throw Object.assign(new Error("Update metadata does not include a SHA-256 checksum."), { code: "UPDATE_CHECKSUM_REQUIRED" });
  }
  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (error) {
    throw Object.assign(new Error("The downloaded update is no longer available."), { code: "UPDATE_ARTIFACT_MISSING", cause: error });
  }
  const expectedSize = Number(asset.size || 0);
  if (!stats.isFile() || (expectedSize > 0 && stats.size !== expectedSize)) {
    throw Object.assign(new Error("The downloaded update size no longer matches its release metadata."), { code: "UPDATE_ARTIFACT_SIZE_MISMATCH" });
  }
  if (await sha256File(filePath) !== expectedSha256) {
    throw Object.assign(new Error("The downloaded update checksum no longer matches its release metadata."), { code: "UPDATE_CHECKSUM_MISMATCH" });
  }
  return true;
}

function getRequestModule(url) {
  return String(url || "").startsWith("http://") ? http : https;
}

function resolveRedirectUrl(location, currentUrl) {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return location;
  }
}

function isGitHubDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

function isBlockedDownloadStatus(statusCode) {
  return statusCode === 401 || statusCode === 403 || statusCode === 404;
}

function safeLogUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

function normalizeManifestAsset(asset) {
  const downloadUrl = asset?.browser_download_url || asset?.downloadUrl || asset?.url;
  if (!downloadUrl) return null;
  return {
    name: asset.name || path.basename(new URL(downloadUrl).pathname) || "AnxOS-Control-Center-update",
    size: Number(asset.size || 0),
    browser_download_url: downloadUrl,
    platform: normalizeAssetPlatform(asset.platform),
    architecture: normalizeAssetArchitecture(asset.architecture || asset.arch),
    sha256: normalizeSha256(asset.sha256 || asset.checksum || asset.digest),
  };
}

function hasSupportedUpdateAsset(release) {
  return Boolean(pickUpdateAsset(release));
}

function pickLatestPublishedRelease(releases) {
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft)
    .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0))
    .find(hasSupportedUpdateAsset) || null;
}

function normalizeManifestRelease(manifest, sourceUrl) {
  const rawAssets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const latestVersion = normalizeVersion(manifest?.version || manifest?.tag_name || manifest?.name);
  const build = extractReleaseBuild(manifest?.build, manifest?.buildNumber, manifest?.tag_name, manifest?.name);
  const channel = manifest?.channel || "";
  const releaseLabel = manifest?.releaseLabel || formatReleaseLabel(latestVersion, build, channel);
  return {
    tag_name: latestVersion ? `v${latestVersion}` : null,
    name: manifest?.name || releaseLabel || (latestVersion ? `v${latestVersion}` : "AnxOS update"),
    version: latestVersion || null,
    build,
    channel,
    releaseLabel,
    body: manifest?.body || manifest?.notes || manifest?.releaseNotes || "",
    html_url: manifest?.html_url || manifest?.releaseUrl || sourceUrl,
    published_at: manifest?.published_at || manifest?.publishedAt || null,
    assets: rawAssets.map(normalizeManifestAsset).filter(Boolean),
  };
}

function extractConfigString(configText, key) {
  const pattern = new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`);
  return configText.match(pattern)?.[1] || "";
}

function parseWebsiteConfigRelease(configText, sourceUrl) {
  const latestVersion = normalizeVersion(extractConfigString(configText, "latestVersion") || extractConfigString(configText, "releaseTag"));
  if (!latestVersion) return null;

  const releaseUrl = extractConfigString(configText, "releaseUrl") || `${sourceUrl.replace(/\/[^/]*$/, "")}/release-notes.html`;
  const releaseDate = extractConfigString(configText, "releaseDate") || null;
  const build = normalizeBuild(extractConfigString(configText, "build") || extractConfigString(configText, "buildNumber"));
  const channel = extractConfigString(configText, "channel");
  const releaseLabel = extractConfigString(configText, "releaseLabel") || formatReleaseLabel(latestVersion, build, channel);
  const assetMatches = [...String(configText || "").matchAll(/fileName\s*:\s*["']([^"']+)["'][\s\S]{0,300}?url\s*:\s*["']([^"']+)["']/g)];
  const assets = assetMatches.map((match) => ({
    name: match[1],
    size: 10 * 1024 * 1024,
    browser_download_url: match[2],
  }));

  return {
    tag_name: `v${latestVersion}`,
    name: releaseLabel || `v${latestVersion}`,
    version: latestVersion,
    build,
    channel,
    releaseLabel,
    body: "",
    html_url: releaseUrl,
    published_at: releaseDate,
    assets,
  };
}

function pickUpdateAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const viableAssets = assets.filter((asset) => {
    const name = String(asset?.name || "").toLowerCase();
    const downloadUrl = String(asset?.browser_download_url || "");
    const size = Number(asset?.size || 0);
    const platform = normalizeAssetPlatform(asset?.platform) || inferAssetPlatform(name);
    const architecture = normalizeAssetArchitecture(asset?.architecture || asset?.arch);
    return downloadUrl
      && size > 5 * 1024 * 1024
      && platform === process.platform
      && (!architecture || architecture === process.arch)
      && (name.endsWith(".exe") || name.endsWith(".appimage") || name.endsWith(".deb") || name.endsWith(".dmg"));
  });
  const platformMatchers = process.platform === "win32"
    ? [/setup.*\.exe$/i, /installer.*\.exe$/i, /control-center-setup.*\.exe$/i, /portable.*\.exe$/i, /win.*\.exe$/i, /\.exe$/i]
    : process.platform === "linux"
      ? [/\.deb$/i, /\.appimage$/i]
      : [/\.dmg$/i, /\.zip$/i];
  for (const matcher of platformMatchers) {
    const match = viableAssets.find((asset) => matcher.test(asset.name || ""));
    if (match) return match;
  }
  return null;
}

class UpdateManager extends EventEmitter {
  constructor() {
    super();
    this.state = {
      status: "idle",
      latest: null,
      downloadedPath: null,
      downloadInFlight: false,
      checkInFlight: false,
      lastCheckedAt: null,
      error: null,
      progress: null,
    };
    this.logs = [];
    this.skippedVersions = new Set();
    this.pendingInstall = null;
    this.notifiedVersions = new Set();
    this.interval = null;
    this.storePath = "";
    this.storeError = null;
    this.activeDownload = null;
    this.activeRequests = new Set();
  }

  initialize() {
    this.storePath = path.join(app.getPath("userData"), "config", "updates.json");
    this.loadStore();
    this.reconcilePendingInstall();
    this.bindAutoUpdaterEvents();
    this.log("UpdateManager initialized.", { autoUpdaterAvailable: Boolean(autoUpdater) });
  }

  bindAutoUpdaterEvents() {
    if (!autoUpdater) return;
    autoUpdater.on("checking-for-update", () => this.log("autoUpdater checking-for-update."));
    autoUpdater.on("update-available", (info) => this.log("autoUpdater update-available.", info));
    autoUpdater.on("update-not-available", (info) => this.log("autoUpdater update-not-available.", info));
    autoUpdater.on("update-downloaded", (event, releaseNotes, releaseName) => this.log("autoUpdater update-downloaded.", { releaseName, releaseNotes: Boolean(releaseNotes) }));
    autoUpdater.on("error", (error) => this.log("autoUpdater error.", { message: error?.message || String(error) }, "error"));
  }

  start() {
    this.check({ silent: true, source: "startup" }).catch(() => {});
    this.interval = setInterval(() => {
      this.check({ silent: true, source: "periodic" }).catch(() => {});
    }, UPDATE_CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const request of this.activeRequests) request.destroy(Object.assign(new Error("Update request cancelled during shutdown."), { code: "UPDATE_CANCELLED" }));
    this.activeRequests.clear();
    this.activeDownload?.abort();
  }

  loadStore() {
    this.storeError = null;
    if (!fs.existsSync(this.storePath)) {
      this.skippedVersions = new Set();
      this.pendingInstall = null;
      return;
    }
    let store;
    try {
      store = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
    } catch (error) {
      const backupPath = `${this.storePath}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.storePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
      this.skippedVersions = new Set();
      this.pendingInstall = null;
      this.storeError = {
        code: "UPDATE_STORE_CORRUPT",
        message: "Saved update preferences are unreadable. The original file was preserved for recovery.",
        causeCode: error?.code || "INVALID_JSON",
      };
      this.state.error = this.storeError.message;
      return;
    }
    const schemaVersion = Number.isInteger(store?.schemaVersion) ? store.schemaVersion : 0;
    if (schemaVersion > UPDATE_STORE_SCHEMA_VERSION) {
      this.skippedVersions = new Set();
      this.storeError = {
        code: "UPDATE_STORE_SCHEMA_UNSUPPORTED",
        message: "Saved update preferences were created by a newer application version.",
        schemaVersion,
        supportedSchemaVersion: UPDATE_STORE_SCHEMA_VERSION,
      };
      this.state.error = this.storeError.message;
      return;
    }
    this.skippedVersions = new Set(Array.isArray(store.skippedVersions) ? store.skippedVersions.map(normalizeVersion).filter(Boolean) : []);
    this.pendingInstall = store.pendingInstall && typeof store.pendingInstall === "object" ? sanitize(store.pendingInstall) : null;
    if (schemaVersion < UPDATE_STORE_SCHEMA_VERSION) {
      const backupPath = `${this.storePath}.schema-v${schemaVersion}.backup`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(this.storePath, backupPath, fs.constants.COPYFILE_EXCL);
      this.saveStore();
    }
  }

  saveStore() {
    if (this.storeError) {
      throw Object.assign(new Error(this.storeError.message), {
        code: this.storeError.code,
        details: this.storeError,
      });
    }
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ schemaVersion: UPDATE_STORE_SCHEMA_VERSION, skippedVersions: [...this.skippedVersions], pendingInstall: this.pendingInstall }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.storePath);
  }

  reconcilePendingInstall() {
    if (!this.pendingInstall || this.storeError) return this.pendingInstall;
    const current = getReleaseInfo();
    const target = { version: this.pendingInstall.targetVersion, build: this.pendingInstall.targetBuild };
    const reachedTarget = target.version && Number.isInteger(Number(target.build))
      && compareReleaseBuilds(current, target) >= 0;
    if (reachedTarget && this.pendingInstall.status !== "launch-confirmed") {
      this.pendingInstall = { ...this.pendingInstall, status: "launch-confirmed", confirmedAt: new Date().toISOString(), guidance: null };
      this.saveStore();
    } else if (!reachedTarget && this.pendingInstall.status === "handed-off") {
      this.pendingInstall = {
        ...this.pendingInstall,
        status: "handoff-unconfirmed",
        checkedAt: new Date().toISOString(),
        guidance: "The previous version is still running. Retry the verified installer or reinstall the recorded previous version; user data is stored outside application binaries.",
      };
      this.saveStore();
    }
    return this.pendingInstall;
  }

  log(message, details = {}, level = "info") {
    const safeDetails = sanitize(details);
    if (safeDetails && typeof safeDetails === "object" && !Array.isArray(safeDetails)) delete safeDetails.stack;
    const entry = sanitize({ at: new Date().toISOString(), level, message, details: safeDetails });
    this.logs.push(entry);
    this.logs = this.logs.slice(-250);
    const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    logger("[Updates]", entry.message, entry.details);
  }

  emitStatus(type, payload = {}) {
    const message = { type, state: this.getState(), ...payload };
    (BrowserWindow?.getAllWindows?.() || []).forEach((window) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        try {
          window.webContents.send(UPDATE_STATUS_CHANNEL, message);
        } catch {
          // The renderer can disappear between the liveness check and send during shutdown or failed launches.
        }
      }
    });
    this.emit("status", message);
  }

  getState() {
    return {
      ...this.state,
      skippedVersions: [...this.skippedVersions],
      pendingInstall: this.pendingInstall,
      storeError: this.storeError,
      logs: this.logs,
    };
  }

  requestText(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const request = getRequestModule(url).get(url, {
        headers: {
          ...headers,
          "User-Agent": `AnxOS-Control-Center/${app.getVersion()}`,
        },
      }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          this.requestText(resolveRedirectUrl(response.headers.location, url), headers).then(resolve, reject);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(`Update metadata request failed with HTTP ${response.statusCode}: ${body.slice(0, 240)}`);
            error.statusCode = response.statusCode;
            reject(error);
            return;
          }
          resolve(body);
        });
      });
      this.activeRequests.add(request);
      const releaseRequest = () => this.activeRequests.delete(request);
      request.once("close", releaseRequest);
      request.setTimeout(15000, () => request.destroy(new Error("Update metadata request timed out.")));
      request.on("error", reject);
    });
  }

  async requestJson(url) {
    const body = await this.requestText(url, { "Accept": "application/vnd.github+json" });
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`Update metadata response was not valid JSON: ${error.message}`);
    }
  }

  resolveUpdateResult(release, sourceUrl) {
    const currentRelease = getReleaseInfo();
    const latestVersion = normalizeVersion(release?.version || release?.tag_name || release?.name);
    const latestBuild = extractReleaseBuild(release?.build, release?.buildNumber, release?.tag_name, release?.name);
    const currentVersion = currentRelease.version;
    const currentBuild = currentRelease.build;
    const asset = pickUpdateAsset(release);
    const releaseKey = latestBuild === null ? latestVersion : `${latestVersion}-build${latestBuild}`;
    const skipped = releaseKey ? this.skippedVersions.has(releaseKey) : false;
    const hasUpdate = Boolean(latestVersion && compareReleaseBuilds({ version: latestVersion, build: latestBuild }, { version: currentVersion, build: currentBuild }) > 0 && asset);
    const latestLabel = release?.releaseLabel || formatReleaseLabel(latestVersion, latestBuild, release?.channel || "");
    const currentLabel = currentRelease.compactLabel;
    return {
      hasUpdate,
      skipped,
      currentVersion: currentLabel,
      currentReleaseVersion: currentVersion,
      currentBuild,
      latestVersion: latestLabel || latestVersion || null,
      latestReleaseVersion: latestVersion || null,
      latestBuild,
      channel: release?.channel || null,
      releaseKey,
      releaseName: release?.name || release?.tag_name || null,
      releaseDate: release?.published_at || null,
      releaseNotes: release?.body || "",
      releaseUrl: release?.html_url || sourceUrl || `https://github.com/${UPDATE_REPOSITORY}/releases`,
      publishedAt: release?.published_at || null,
      sourceUrl,
      asset: asset ? {
        name: asset.name,
        size: asset.size,
        downloadUrl: asset.browser_download_url,
        platform: normalizeAssetPlatform(asset.platform) || inferAssetPlatform(asset.name),
        architecture: normalizeAssetArchitecture(asset.architecture || asset.arch),
        sha256: normalizeSha256(asset.sha256 || asset.checksum || asset.digest),
      } : null,
    };
  }

  async check(options = {}) {
    if (this.state.checkInFlight) {
      this.log("Update check already running.", { source: options.source || "manual" }, "warn");
      return this.getState();
    }
    this.state.checkInFlight = true;
    this.state.status = "checking";
    this.state.error = null;
    this.log("Checking for updates.", { source: options.source || "manual", silent: Boolean(options.silent) });
    this.emitStatus("checking");
    const checkedSources = [];
    try {
      let release = null;
      let sourceUrl = "";
      for (const manifestUrl of UPDATE_MANIFEST_URLS) {
        try {
          checkedSources.push(manifestUrl);
          release = normalizeManifestRelease(await this.requestJson(manifestUrl), manifestUrl);
          sourceUrl = manifestUrl;
          break;
        } catch (error) {
          this.log("Update manifest check failed.", { message: error?.message || String(error), url: safeLogUrl(manifestUrl) }, "warn");
        }
      }
      try {
        if (!release) {
          checkedSources.push(UPDATE_RELEASES_URL);
          release = pickLatestPublishedRelease(await this.requestJson(UPDATE_RELEASES_URL));
          sourceUrl = UPDATE_RELEASES_URL;
        }
      } catch (error) {
        this.log("GitHub release check failed.", { message: error?.message || String(error), url: safeLogUrl(UPDATE_RELEASES_URL) }, error?.statusCode === 404 ? "warn" : "error");
      }
      if (!release) {
        try {
          checkedSources.push(UPDATE_LATEST_RELEASE_URL);
          release = await this.requestJson(UPDATE_LATEST_RELEASE_URL);
          sourceUrl = UPDATE_LATEST_RELEASE_URL;
        } catch (error) {
          this.log("GitHub latest release check failed.", { message: error?.message || String(error), url: safeLogUrl(UPDATE_LATEST_RELEASE_URL) }, error?.statusCode === 404 ? "warn" : "error");
        }
      }
      if (!release) {
        for (const websiteConfigUrl of WEBSITE_CONFIG_URLS) {
          try {
            checkedSources.push(websiteConfigUrl);
            release = parseWebsiteConfigRelease(await this.requestText(websiteConfigUrl), websiteConfigUrl);
            if (release) {
              sourceUrl = websiteConfigUrl;
              break;
            }
          } catch (error) {
            this.log("Website update config check failed.", { message: error?.message || String(error), url: safeLogUrl(websiteConfigUrl) }, "warn");
          }
        }
      }
      if (!release) {
        this.state.status = "unavailable";
        this.state.latest = { hasUpdate: false, releaseUnavailable: true, message: "No update release is published yet.", checkedSources };
        this.state.lastCheckedAt = new Date().toISOString();
        this.state.checkInFlight = false;
        this.log("No update release is published yet.", { checkedSources }, "warn");
        this.emitStatus("unavailable", { update: this.state.latest });
        return this.state.latest;
      }
      const result = this.resolveUpdateResult(release, sourceUrl);
      this.state.latest = result;
      this.state.lastCheckedAt = new Date().toISOString();
      if (result.hasUpdate) {
        this.state.status = result.skipped ? "skipped" : "available";
        this.log("Update available.", { latestVersion: result.latestVersion, skipped: result.skipped, asset: result.asset?.name || null });
        const shouldNotify = !result.skipped && (!this.notifiedVersions.has(result.latestVersion) || options.forceNotify);
        if (shouldNotify) this.notifiedVersions.add(result.latestVersion);
        this.state.checkInFlight = false;
        this.emitStatus("available", { update: result, notify: shouldNotify });
      } else {
        this.state.status = "up-to-date";
        this.state.checkInFlight = false;
        this.log("No updates available.", { currentVersion: result.currentVersion, latestVersion: result.latestVersion });
        this.emitStatus("not-available", { update: result });
      }
      return result;
    } catch (error) {
      this.state.status = "error";
      this.state.checkInFlight = false;
      this.state.error = error?.message || "Update check failed.";
      this.log("Update check failed.", { code: error?.code || "UPDATE_CHECK_FAILED", message: this.state.error }, "error");
      this.emitStatus("error", { message: this.state.error });
      return { hasUpdate: false, error: this.state.error };
    } finally {
      this.state.checkInFlight = false;
    }
  }

  downloadFile(url, destinationPath, options = {}) {
    return new Promise((resolve, reject) => {
      const expectedSha256 = normalizeSha256(options.sha256);
      if (!expectedSha256) {
        reject(Object.assign(new Error("Update metadata does not include a SHA-256 checksum."), { code: "UPDATE_CHECKSUM_REQUIRED" }));
        return;
      }
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.part`;
      const expectedSize = Number(options.size || 0);
      const controller = new AbortController();
      this.activeDownload = controller;
      let settled = false;
      let currentRequest = null;
      let currentResponse = null;
      let fileStream = null;
      const cleanupPartial = () => fs.rmSync(tempPath, { force: true });
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        if (this.activeDownload === controller) this.activeDownload = null;
        fs.rm(tempPath, { force: true }, () => reject(error));
      };
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        if (this.activeDownload === controller) this.activeDownload = null;
        resolve(destinationPath);
      };
      controller.signal.addEventListener("abort", () => {
        const error = Object.assign(new Error("Update download was cancelled."), { code: "UPDATE_CANCELLED" });
        currentRequest?.destroy(error);
        currentResponse?.destroy(error);
        fileStream?.destroy(error);
        finishReject(error);
      }, { once: true });

      const beginRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          finishReject(new Error("Too many redirects while downloading update."));
          return;
        }
        currentRequest = getRequestModule(requestUrl).get(requestUrl, {
          headers: {
            "Accept": "application/octet-stream",
            "User-Agent": `AnxOS-Control-Center/${app?.getVersion?.() || "unknown"}`,
          },
        }, (response) => {
          currentResponse = response;
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume();
            beginRequest(resolveRedirectUrl(response.headers.location, requestUrl), redirectCount + 1);
            return;
          }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            if (body.length < 512) body += chunk;
          });
          response.on("end", () => {
            const blockedOriginalGitHubDownload = isBlockedDownloadStatus(response.statusCode) && isGitHubDownloadUrl(url);
            const blockedRedirectedGitHubDownload = isBlockedDownloadStatus(response.statusCode) && isGitHubDownloadUrl(requestUrl);
            const suffix = blockedOriginalGitHubDownload || blockedRedirectedGitHubDownload
              ? " The release asset is not publicly downloadable by the desktop app. Open the release in your browser, or publish/mirror the release assets to public storage."
              : "";
            finishReject(new Error(`Update download failed with HTTP ${response.statusCode}.${suffix}${body ? ` ${body.slice(0, 160)}` : ""}`));
          });
          return;
        }
        const totalBytes = Number.parseInt(response.headers["content-length"], 10) || 0;
        let receivedBytes = 0;
        const digest = crypto.createHash("sha256");
        fileStream = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          digest.update(chunk);
          options.onProgress?.({ receivedBytes, totalBytes: expectedSize || totalBytes, percent: (expectedSize || totalBytes) > 0 ? Math.round((receivedBytes / (expectedSize || totalBytes)) * 100) : null });
        });
        response.on("error", finishReject);
        response.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(() => {
            const requiredBytes = expectedSize || totalBytes;
            if (requiredBytes > 0 && receivedBytes !== requiredBytes) {
              finishReject(new Error(`Update download was incomplete (${receivedBytes} of ${requiredBytes} bytes).`));
              return;
            }
            const actualSha256 = digest.digest("hex");
            if (!expectedSha256 || actualSha256 !== expectedSha256) {
              finishReject(Object.assign(new Error(expectedSha256 ? "Update checksum verification failed." : "Update metadata does not include a SHA-256 checksum."), {
                code: expectedSha256 ? "UPDATE_CHECKSUM_MISMATCH" : "UPDATE_CHECKSUM_REQUIRED",
              }));
              return;
            }
            fs.link(tempPath, destinationPath, (linkError) => {
              if (linkError) {
                finishReject(Object.assign(new Error(linkError.code === "EEXIST" ? "The update destination already exists." : `Update download could not be committed: ${linkError.message}`), { code: "UPDATE_DOWNLOAD_COMMIT_FAILED" }));
                return;
              }
              cleanupPartial();
              finishResolve();
            });
          });
        });
        fileStream.on("error", finishReject);
        });
        currentRequest.setTimeout(120000, () => currentRequest.destroy(new Error("Update download timed out.")));
        currentRequest.on("error", finishReject);
      };
      beginRequest(url);
    });
  }

  async download() {
    if (this.state.downloadInFlight) {
      this.log("Download request ignored; update is already downloading.", {}, "warn");
      return { downloading: true, state: this.getState() };
    }
    const update = this.state.latest?.hasUpdate ? this.state.latest : await this.check({ silent: false, source: "download" });
    if (!update?.hasUpdate || !update.asset?.downloadUrl) {
      return { downloaded: false, message: "No update is available.", state: this.getState() };
    }
    this.state.downloadInFlight = true;
    this.state.downloadedPath = null;
    this.state.status = "downloading";
    this.state.progress = { receivedBytes: 0, totalBytes: update.asset.size || 0, percent: 0 };
    const destinationPath = createDownloadPath(getUpdateDownloadDirectory(), sanitizeFileName(update.asset.name));
    this.log("Download started.", { asset: update.asset.name, destinationPath });
    this.emitStatus("download-started", { update, path: destinationPath });
    try {
      const downloadedPath = await this.downloadFile(update.asset.downloadUrl, destinationPath, {
        size: update.asset.size,
        sha256: update.asset.sha256,
        onProgress: (progress) => {
          this.state.progress = progress;
          this.log("Download progress.", progress);
          this.emitStatus("download-progress", { progress });
        },
      });
      this.state.downloadInFlight = false;
      this.state.downloadedPath = downloadedPath;
      this.state.status = "downloaded";
      this.state.progress = { ...this.state.progress, percent: 100 };
      this.log("Download completed.", { path: downloadedPath });
      this.emitStatus("downloaded", { update, path: downloadedPath });
      return { downloaded: true, path: downloadedPath, update, state: this.getState() };
    } catch (error) {
      this.state.downloadInFlight = false;
      this.state.status = "error";
      this.state.error = error?.message || "Update download failed.";
      this.log("Download failed.", { code: error?.code || "UPDATE_DOWNLOAD_FAILED", message: this.state.error }, "error");
      this.emitStatus("download-error", { message: this.state.error });
      return { downloaded: false, error: this.state.error, state: this.getState() };
    } finally {
      this.state.downloadInFlight = false;
    }
  }

  async install() {
    if (!this.state.downloadedPath) return { installed: false, message: "No downloaded update is ready." };
    if (this.pendingInstall && ["handoff-pending", "handed-off"].includes(this.pendingInstall.status)) {
      return { installed: false, alreadyRequested: true, pendingInstall: this.pendingInstall, state: this.getState() };
    }
    try {
      await verifyUpdateArtifact(this.state.downloadedPath, this.state.latest?.asset);
      const previous = getReleaseInfo();
      this.pendingInstall = sanitize({
        status: "handoff-pending",
        previousVersion: previous.version,
        previousBuild: previous.build,
        targetVersion: this.state.latest?.latestReleaseVersion || this.state.latest?.version || null,
        targetBuild: this.state.latest?.latestBuild ?? null,
        artifactName: this.state.latest?.asset?.name || path.basename(this.state.downloadedPath),
        sha256: this.state.latest?.asset?.sha256 || null,
        requestedAt: new Date().toISOString(),
      });
      this.saveStore();
      this.log("Install requested.", { path: this.state.downloadedPath });
      const launchError = await shell.openPath(this.state.downloadedPath);
      if (launchError) throw Object.assign(new Error(`The update installer could not be opened: ${launchError}`), { code: "UPDATE_INSTALLER_OPEN_FAILED" });
      this.pendingInstall = { ...this.pendingInstall, status: "handed-off", handedOffAt: new Date().toISOString() };
      this.saveStore();
      this.log("Install handoff completed.", { path: this.state.downloadedPath });
      return { installed: true };
    } catch (error) {
      if (this.pendingInstall?.status === "handoff-pending") {
        this.pendingInstall = { ...this.pendingInstall, status: "handoff-failed", failedAt: new Date().toISOString(), errorCode: error?.code || "UPDATE_INSTALL_FAILED" };
        try { this.saveStore(); } catch {}
      }
      this.state.status = "error";
      this.state.error = error?.message || "The update installer could not be opened.";
      this.log("Install handoff failed.", { code: error?.code || "UPDATE_INSTALL_FAILED", message: this.state.error }, "error");
      this.emitStatus("install-error", { code: error?.code || "UPDATE_INSTALL_FAILED", message: this.state.error });
      return { installed: false, code: error?.code || "UPDATE_INSTALL_FAILED", error: this.state.error, state: this.getState() };
    }
  }

  async openRelease() {
    const releaseUrl = this.state.latest?.releaseUrl || `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
    await openExternalUrl(releaseUrl, { source: "updates-release" });
    return { opened: true };
  }

  async openDownload() {
    const downloadUrl = this.state.latest?.asset?.downloadUrl || this.state.latest?.releaseUrl || `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
    await openExternalUrl(downloadUrl, { source: "updates-download" });
    return { opened: true };
  }

  skip(version) {
    const target = this.state.latest?.releaseKey || normalizeVersion(version || this.state.latest?.latestReleaseVersion || this.state.latest?.latestVersion);
    if (target) {
      if (this.storeError) {
        throw Object.assign(new Error(this.storeError.message), {
          code: this.storeError.code,
          details: this.storeError,
        });
      }
      this.skippedVersions.add(target);
      this.saveStore();
      this.state.status = "skipped";
      if (this.state.latest && (this.state.latest.releaseKey === target || normalizeVersion(this.state.latest.latestVersion) === target)) {
        this.state.latest = { ...this.state.latest, skipped: true };
      }
      this.log("Skipped update version.", { version: target });
      this.emitStatus("skipped", { version: target });
    }
    return this.getState();
  }
}

module.exports = {
  UPDATE_STATUS_CHANNEL,
  UPDATE_STORE_SCHEMA_VERSION,
  UpdateManager,
  compareVersions,
  compareReleaseBuilds,
  extractReleaseBuild,
  formatReleaseLabel,
  normalizeVersion,
  pickLatestPublishedRelease,
  parseWebsiteConfigRelease,
  pickUpdateAsset,
  resolveRedirectUrl,
  verifyUpdateArtifact,
};
