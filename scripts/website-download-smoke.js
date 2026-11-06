const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const websiteRoot = path.join(root, "website");
const service = require(path.join(websiteRoot, "release-download-service.js"));
const publicOwner = "AnxLabs";
const publicRepo = "AnxOS-Control-Center-Releases";
const publicRepository = `${publicOwner}/${publicRepo}`;
const publicRepositoryUrl = `https://github.com/${publicRepository}`;
const privateSourceRepositoryUrl = "https://github.com/AnxLabs/AnxOS-Control-Center";
const legacyRepositoryUrl = "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases";

function readWebsite(file) {
  return fs.readFileSync(path.join(websiteRoot, file), "utf8");
}

function makeAsset(name, size = 1024, urlName = name, owner = publicOwner, repo = publicRepo, digest = `sha256:${"ab".repeat(32)}`) {
  return {
    name,
    size,
    digest,
    browser_download_url: `https://github.com/${owner}/${repo}/releases/download/v1.7-build142/${encodeURIComponent(urlName)}`,
  };
}

function sampleReleases() {
  return [
    {
      draft: true,
      prerelease: false,
      tag_name: "v9.9-build999",
      name: "Draft release",
      published_at: "2026-07-14T00:00:00Z",
      html_url: `${publicRepositoryUrl}/releases/tag/v9.9-build999`,
      assets: [makeAsset("AnxOS-Control-Center-Setup-9.9-build999.exe")],
    },
    {
      draft: false,
      prerelease: false,
      tag_name: "v1.7-build142",
      name: "AnxOS Version 1.7 build142",
      body: "Channel: Private Alpha\n\n<script>alert(1)</script>\nUse official assets only.",
      published_at: "2026-07-13T12:00:00Z",
      html_url: `${publicRepositoryUrl}/releases/tag/v1.7-build142`,
      assets: [
        makeAsset("AnxOS-Control-Center-Setup-1.7-build142.exe", 80 * 1024 * 1024),
        makeAsset("AnxOS-Control-Center-1.7-build142-portable.exe", 78 * 1024 * 1024),
        makeAsset("AnxOS-Control-Center-1.7-build142.AppImage", 92 * 1024 * 1024),
        makeAsset("AnxOS-Control-Center-1.7-build142.deb", 84 * 1024 * 1024),
        makeAsset("SHA256SUMS", 512),
        makeAsset("AnxOS-Control-Center-evil.exe", 1, "AnxOS-Control-Center-evil.exe", "other", "repo"),
        { name: "Source code (zip)", browser_download_url: `${publicRepositoryUrl}/archive/refs/tags/v1.7-build142.zip` },
      ],
    },
    {
      draft: false,
      prerelease: true,
      tag_name: "v1.9-build200",
      name: "AnxOS Version 1.9 build200 RC",
      body: "Channel: Private Alpha\n\nRelease candidate for acceptance testing.",
      published_at: "2026-09-15T09:00:00Z",
      html_url: `${publicRepositoryUrl}/releases/tag/v1.9-build200`,
      assets: [
        makeAsset("AnxOS-Control-Center-Setup-1.9-build200.exe", 80 * 1024 * 1024),
        makeAsset("AnxOS-Control-Center-1.9-build200-portable.exe", 78 * 1024 * 1024),
        makeAsset("AnxOS-Control-Center-1.9-build200.AppImage", 92 * 1024 * 1024),
        makeAsset("AnxOS-Control-Center-1.9-build200.deb", 84 * 1024 * 1024),
      ],
    },
  ];
}

function mockFetchJson(payload, ok = true, status = 200) {
  global.fetch = async () => ({
    ok,
    status,
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function main() {
  const canonicalRepository = service.repositoryFromConfig({
    releaseRepository: { owner: publicOwner, repo: publicRepo },
  });
  const canonicalAssetUrl = makeAsset("AnxOS-Control-Center-Setup-1.7-build142.exe").browser_download_url;
  assert.strictEqual(canonicalRepository?.repositoryUrl, publicRepositoryUrl, "Canonical AnxLabs release repository configuration must be accepted.");
  assert.strictEqual(service.isExpectedAssetUrl(canonicalAssetUrl, canonicalRepository), true, "Canonical AnxLabs release assets must be accepted.");
  assert.strictEqual(service.isExpectedAssetUrl(`${privateSourceRepositoryUrl}/releases/download/v1.7-build142/source.exe`, canonicalRepository), false, "Source repository binaries must be rejected.");
  assert.strictEqual(service.isExpectedAssetUrl("https://github.com/other/repo/releases/download/v1/test.exe", canonicalRepository), false, "Unrelated GitHub release assets must be rejected.");
  assert.strictEqual(service.isExpectedAssetUrl("not a URL", canonicalRepository), false, "Malformed release asset URLs must be rejected.");
  assert.strictEqual(service.repositoryFromConfig({ repositoryUrl: legacyRepositoryUrl }), null, "The legacy owner must not be treated as the canonical release repository.");

  const normalized = service.latestPublishedRelease(sampleReleases(), {
    repositoryUrl: publicRepositoryUrl,
    config: { channel: "Private Alpha" },
  });

  assert(normalized, "Latest published release should normalize.");
  assert.strictEqual(normalized.version, "1.7", "Version should be parsed from release metadata.");
  assert.strictEqual(normalized.buildNumber, "142", "Build number should be parsed from release metadata.");
  assert.strictEqual(normalized.channel, "Private Alpha", "Channel should be parsed from release body or fallback config.");
  assert.strictEqual(normalized.assets.length, 4, "Only real installer assets from the expected repository should be exposed.");
  assert(normalized.assets.some((asset) => asset.key === "windows-setup"), "Windows Setup should be detected.");
  assert(normalized.assets.some((asset) => asset.key === "windows-portable"), "Windows Portable should be detected.");
  assert(normalized.assets.some((asset) => asset.key === "linux-appimage"), "Linux AppImage should be detected.");
  assert(normalized.assets.some((asset) => asset.key === "linux-deb"), "Linux .deb should be detected.");
  assert.strictEqual(normalized.checksumAssets[0].fileName, "SHA256SUMS", "Checksum manifest should be detected.");
  assert(normalized.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)), "Each offered installer must carry its own SHA-256.");
  assert(normalized.assets.every((asset) => !asset.checksumAsset || asset.checksumAsset.fileName === `${asset.fileName}.sha256`), "An installer may only reference its own sidecar, not another asset's checksum.");
  assert(!normalized.assets.some((asset) => /evil/i.test(asset.fileName)), "Unexpected GitHub repositories must be rejected.");
  assert.strictEqual(service.preferredAssetForPlatform(normalized, "windows").key, "windows-setup", "Windows should prefer Setup.");
  assert.strictEqual(service.preferredAssetForPlatform(normalized, "linux").key, "linux-appimage", "Linux should prefer AppImage.");
  assert.strictEqual(service.preferredAssetForPlatform(normalized, "macos"), null, "macOS should not receive a fake download.");

  const missingLinux = service.latestPublishedRelease([{
    draft: false,
    tag_name: "v1.0-build1",
    published_at: "2026-01-01T00:00:00Z",
    html_url: `${publicRepositoryUrl}/releases/tag/v1.0-build1`,
    assets: [makeAsset("AnxOS-Control-Center-Setup-1.0-build1.exe")],
  }], { repositoryUrl: publicRepositoryUrl, config: {} });
  assert.strictEqual(service.preferredAssetForPlatform(missingLinux, "linux"), null, "Missing platform should remain unavailable.");

  mockFetchJson(sampleReleases());
  const loaded = await service.loadLatestRelease({
    force: true,
    config: {
      releaseRepository: { owner: publicOwner, repo: publicRepo },
      repositoryUrl: privateSourceRepositoryUrl,
      channel: "Private Alpha",
    },
  });
  assert.strictEqual(loaded.tagName, "v1.7-build142", "Release loader should use mocked GitHub API data.");
  assert.strictEqual(loaded.repository.repositoryUrl, publicRepositoryUrl, "Release loader should prefer the public release repository over the source repository URL.");
  mockFetchJson("not json");
  await assert.rejects(
    service.loadLatestRelease({ repositoryUrl: publicRepositoryUrl, force: true }),
    /invalid JSON/i,
    "Invalid GitHub JSON should be reported."
  );
  mockFetchJson({ message: "rate limit" }, false, 403);
  await assert.rejects(
    service.loadLatestRelease({ repositoryUrl: publicRepositoryUrl, force: true }),
    /rate limit/i,
    "GitHub API failure should be reported."
  );
  mockFetchJson({ message: "not found" }, false, 404);
  await assert.rejects(
    service.loadLatestRelease({ repositoryUrl: publicRepositoryUrl, force: true }),
    (error) => error.code === "GITHUB_RELEASE_SOURCE_NOT_FOUND",
    "GitHub 404 should be categorized as a missing release source."
  );
  mockFetchJson([]);
  await assert.rejects(
    service.loadLatestRelease({ repositoryUrl: publicRepositoryUrl, force: true }),
    (error) => error.code === "NO_PUBLISHED_RELEASE",
    "An empty release list should be reported as no published release."
  );
  mockFetchJson([{ draft: false, tag_name: "v1.0-build1", published_at: "2026-01-01T00:00:00Z", assets: [makeAsset("README.txt")] }]);
  await assert.rejects(
    service.loadLatestRelease({ repositoryUrl: publicRepositoryUrl, force: true }),
    (error) => error.code === "NO_SUPPORTED_INSTALLER",
    "Published releases without supported installers should be categorized clearly."
  );
  global.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(
    service.loadLatestRelease({ repositoryUrl: publicRepositoryUrl, force: true }),
    (error) => error.code === "RELEASE_NETWORK_ERROR",
    "Network failures should be categorized without exposing raw browser errors."
  );

  const download = readWebsite("download/index.html");
  const downloadHtml = readWebsite("download.html");
  const index = readWebsite("index.html");
  const releaseNotes = readWebsite("release-notes.html");
  const gettingStarted = readWebsite("getting-started/index.html");
  const site = readWebsite("site.js");
  const config = readWebsite("config.js");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "windows-release.yml"), "utf8");
  assert(download.includes('data-download-page') && download.includes('data-primary-download'), "/download should render the dynamic download workspace.");
  assert(download.includes("Download AnxOS for Windows") && download.includes("Windows installer"), "/download should make the Windows installer the primary normal-user path.");
  assert(download.includes("<dt>Version</dt>") && !download.includes("<dt>Stable</dt>") && downloadHtml.includes("<dt>Version</dt>"), "/download release metadata must not call private-alpha builds stable.");
  assert(download.includes("Portable Version") && download.includes("View Release Notes") && download.includes("Installation Help") && download.includes("System Requirements"), "/download should keep secondary download and help options visible.");
  assert(download.includes('href="/windows-installation"') && downloadHtml.includes('href="/windows-installation"'), "/download should link installation help to the clean Windows installation route.");
  assert(download.includes('href="/system-requirements"') && downloadHtml.includes('href="/system-requirements"'), "/download should link system requirements to the clean dedicated route.");
  assert(download.includes('id="system-requirements"') && download.includes('id="install-help"'), "/download should expose clean anchors for requirements and installation help.");
  assert(download.includes('rel="canonical" href="https://anxoscontrolcenter.org/download"'), "/download should expose canonical metadata.");
  assert(downloadHtml.includes('data-download-page') && downloadHtml.includes("Download AnxOS for Windows"), "/download.html should serve visible compatibility content, not a blank redirect shell.");
  assert(!downloadHtml.includes('window.location.replace("/download"'), "/download.html must not redirect to itself through Cloudflare extensionless routing.");
  for (const html of [download, downloadHtml]) {
    assert(html.includes('src="/site.js"') && html.includes('src="/release-download-service.js"') && html.includes('href="/styles.css"'), "Download pages must use root-safe script and stylesheet paths.");
    assert(!html.includes('src="site.js"') && !html.includes('src="release-download-service.js"') && !html.includes('href="styles.css"'), "Download pages must not use route-relative assets.");
    assert(html.includes("<header") && html.includes("<main") && html.includes("<footer"), "Download pages must contain visible page structure before JavaScript executes.");
    assert(!/body[^>]*(hidden|display:\s*none|visibility:\s*hidden|opacity:\s*0)/i.test(html), "Download pages must not hide the full document by default.");
  }
  assert(index.includes('href="/download"') && releaseNotes.includes('href="/download"') && gettingStarted.includes('href="/download"'), "Public CTAs should point to the domain download route.");
  assert(!/AnxOS-Control-Center-Setup-1\.7-build142\.exe/.test(`${download}\n${index}\n${releaseNotes}\n${gettingStarted}\n${site}\n${config}`), "Website download logic must not hardcode an obsolete installer filename.");
  assert(!/releases\/download\/v1\.7-build142/.test(`${download}\n${index}\n${releaseNotes}\n${gettingStarted}\n${site}\n${config}`), "Website download logic must not hardcode an obsolete release asset URL.");
  assert(site.includes("textContent = release.releaseBody") && !site.includes("innerHTML = release.releaseBody"), "Release text should be rendered safely.");
  assert(site.includes('heading.textContent = windowsSetup ? "Windows installer ready"') && site.includes('"Download AnxOS for Windows"'), "Download renderer should prefer the Windows setup asset for the primary CTA.");
  assert(site.includes("windowsPortable") && site.includes("Portable Version") && site.includes("Installation Help") && site.includes("System Requirements"), "Download renderer should expose portable, release notes, help, and requirements actions.");
  assert(site.includes("function showDownloadStartupFallback") && site.includes("function initializeWebsite") && site.includes("try {"), "Website startup should have a top-level download failure boundary.");
  assert(site.includes("Download information could not be loaded right now."), "Release initialization failure should show a visitor-safe error message.");
  assert(site.includes("No downloadable release is currently available.") && site.includes("Unavailable") && site.includes("Download information is temporarily unavailable. Please try again shortly."), "Failed release loading should clear loading placeholders and show a complete visible error state.");
  assert(site.includes('button.addEventListener("click", () =>') && site.includes("applyDownloads({ force: true })") && site.includes("setDownloadLinksLoading()"), "Retry should reset loading state and force a fresh release lookup.");
  assert(site.includes("isExpectedAssetUrl") || fs.readFileSync(path.join(websiteRoot, "release-download-service.js"), "utf8").includes("isExpectedAssetUrl"), "Download URLs should be allowlisted.");
  assert(config.includes("releaseRepository") && config.includes(publicRepo) && config.includes(`https://api.github.com/repos/${publicRepository}/releases?per_page=100&page=1`), "Config should use the public release-only repository.");
  assert(!new RegExp(`${privateSourceRepositoryUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/releases|["'])`).test(config), "Browser release discovery must not use the private source repository.");
  assert(!/GITHUB_TOKEN|GH_TOKEN|PERSONAL_ACCESS_TOKEN|ANXOS_RELEASE_REPO_TOKEN/.test(`${download}\n${downloadHtml}\n${site}\n${config}\n${fs.readFileSync(path.join(websiteRoot, "release-download-service.js"), "utf8")}`), "Frontend download code must not contain GitHub tokens or token variable names.");
  assert(config.includes("githubReleasesApiUrl") && config.includes("stableDownloadEndpoints") && config.includes("releaseAssets"), "Config should contain release discovery settings and public release asset fallback metadata.");
  assert(workflow.includes("sha256sum * > SHA256SUMS") && workflow.includes("update-manifest.json") && workflow.includes("ANXOS_RELEASE_REPO_TOKEN") && workflow.includes(publicRepository), "Release workflow should publish checksummed artifacts and updater metadata to the public release repository using a server-side secret.");

  const functionsHelper = await import(pathToFileURL(path.join(root, "functions", "_shared", "release-download.mjs")).href);
  assert.strictEqual(functionsHelper.DEFAULT_RELEASE_REPOSITORY, publicRepository, "Pages Functions should default to the public release repository.");
  assert.strictEqual(functionsHelper.repositoryFromEnv({ ANXOS_RELEASE_REPOSITORY: publicRepository })?.repositoryUrl, publicRepositoryUrl, "Pages Functions must accept the canonical repository.");
  assert.strictEqual(functionsHelper.repositoryFromEnv({ ANXOS_RELEASE_REPOSITORY: "AnxLabs/AnxOS-Control-Center" }), null, "Pages Functions must reject the source repository.");
  assert.strictEqual(functionsHelper.repositoryFromEnv({ ANXOS_RELEASE_REPOSITORY: "other/repo" }), null, "Pages Functions must reject unrelated repositories.");
  assert.strictEqual(functionsHelper.repositoryFromEnv({ ANXOS_RELEASE_REPOSITORY: "malformed" }), null, "Pages Functions must reject malformed repository configuration.");
  assert.strictEqual(functionsHelper.repositoryFromEnv({ ANXOS_RELEASE_REPOSITORY: "bungopam-byte/AnxOS-Control-Center-Releases" }), null, "Pages Functions must reject the legacy owner as non-canonical.");
  assert.strictEqual(functionsHelper.classifyAssetName("AnxOS-Control-Center-Setup-1.7-build142.exe"), "windows", "Redirect helper should classify Windows setup.");
  assert.strictEqual(functionsHelper.classifyAssetName("AnxOS-Control-Center-1.7-build142-portable.exe"), "windows-portable", "Redirect helper should classify Windows portable.");
  assert.strictEqual(functionsHelper.classifyAssetName("AnxOS-Control-Center-1.7-build142.AppImage"), "linux-appimage", "Redirect helper should classify AppImage.");
  assert.strictEqual(functionsHelper.classifyAssetName("AnxOS-Control-Center-1.7-build142.deb"), "linux-deb", "Redirect helper should classify .deb.");
  const artifact = functionsHelper.findArtifact(sampleReleases()[1], functionsHelper.repositoryFromEnv({}), "linux-deb");
  assert(artifact?.browser_download_url.endsWith(".deb"), "Redirect helper should select the requested artifact only.");
  assert.strictEqual(functionsHelper.findArtifact(sampleReleases()[1], functionsHelper.repositoryFromEnv({}), "macos"), null, "Redirect helper must not redirect missing artifacts.");
  mockFetchJson(sampleReleases());
  const redirectResponse = await functionsHelper.redirectLatestArtifact(new Request("https://anxoscontrolcenter.org/api/download/latest/windows"), {}, "windows");
  assert.strictEqual(redirectResponse.status, 302, "Stable endpoint helper should redirect when the artifact exists.");
  assert(redirectResponse.headers.get("location").includes("AnxOS-Control-Center-Setup-1.7-build142.exe"), "Stable endpoint helper should redirect to the matching setup asset.");
  const missingResponse = await functionsHelper.redirectLatestArtifact(new Request("https://anxoscontrolcenter.org/api/download/latest/macos"), {}, "macos");
  assert.strictEqual(missingResponse.status, 404, "Stable endpoint helper should return JSON 404 when the artifact is missing.");
  assert.match(await missingResponse.text(), /ARTIFACT_NOT_FOUND/, "Missing artifact response should be structured JSON.");

  // RCs are published as pre-releases and must never be served as the stable latest.
  const stableRedirect = await functionsHelper.redirectLatestArtifact(new Request("https://anxoscontrolcenter.org/api/download/latest/windows"), {}, "windows");
  assert.strictEqual(stableRedirect.status, 302, "Stable endpoint must redirect when a stable build exists.");
  assert(!stableRedirect.headers.get("location").includes("build200"), "Stable endpoint must not redirect to a pre-release RC.");
  const rcRedirect = await functionsHelper.redirectLatestArtifact(new Request("https://anxoscontrolcenter.org/api/download/latest/windows?prerelease=1"), {}, "windows");
  assert(rcRedirect.headers.get("location").includes("AnxOS-Control-Center-Setup-1.9-build200.exe"), "Explicit prerelease request must resolve the RC.");
  const clientStable = service.latestPublishedRelease(sampleReleases(), { repositoryUrl: publicRepositoryUrl, config: { channel: "Private Alpha" } });
  assert.strictEqual(clientStable.tagName, "v1.7-build142", "Client renderer stable latest must ignore the newer pre-release RC.");
  const clientRc = service.latestPublishedRelease(sampleReleases(), { repositoryUrl: publicRepositoryUrl, config: { channel: "Private Alpha" }, allowPrerelease: true });
  assert.strictEqual(clientRc.tagName, "v1.9-build200", "Client renderer must expose an RC when allowPrerelease is explicitly requested.");

  const misflaggedRc = {
    draft: false,
    prerelease: false,
    tag_name: "v2.0-build205-rc3",
    name: "v2.0-build205-rc3",
    channel: "Private Alpha",
    published_at: "2026-11-06T00:00:00Z",
    html_url: `${publicRepositoryUrl}/releases/tag/v2.0-build205-rc3`,
    assets: [makeAsset("AnxOS-Control-Center-Setup-2.0-build205-rc3.exe", 80 * 1024 * 1024)],
  };
  const flaggedAlpha = {
    draft: false,
    prerelease: true,
    tag_name: "v2.0-build209",
    name: "v2.0-build209",
    published_at: "2026-10-31T19:39:54Z",
    html_url: `${publicRepositoryUrl}/releases/tag/v2.0-build209`,
    assets: [makeAsset("AnxOS-Control-Center-Setup-2.0-build209.exe", 80 * 1024 * 1024)],
  };
  mockFetchJson([misflaggedRc, flaggedAlpha, ...sampleReleases()].reverse());
  const misflaggedRedirect = await functionsHelper.redirectLatestArtifact(new Request("https://anxoscontrolcenter.org/api/download/latest/windows"), {}, "windows");
  assert.strictEqual(misflaggedRedirect.status, 302, "A stable artifact must still resolve when a mis-flagged RC is also published.");
  assert(misflaggedRedirect.headers.get("location").includes("AnxOS-Control-Center-Setup-1.7-build142.exe"), "Stable download must ignore a newer RC that GitHub marked prerelease=false.");
  assert(!misflaggedRedirect.headers.get("location").includes("build205"), "Stable download must not redirect to the mis-flagged RC.");
  assert(!misflaggedRedirect.headers.get("location").includes("build209"), "Stable download must not redirect to a prerelease alpha.");
  mockFetchJson([misflaggedRc, flaggedAlpha]);
  const blockedRedirect = await functionsHelper.redirectLatestArtifact(new Request("https://anxoscontrolcenter.org/api/download/latest/windows"), {}, "windows");
  assert.notStrictEqual(blockedRedirect.status, 302, "Stable download must fail closed when every published release is an alpha or RC.");
  const blockedBody = await blockedRedirect.text();
  assert(!blockedBody.includes("build205-rc3"), "The fail-closed response must not point at the mis-flagged RC.");
  assert.match(blockedBody, /NO_SUPPORTED_INSTALLER/, "The fail-closed response must explain that no stable installer is available.");
  assert.strictEqual(service.latestPublishedRelease([misflaggedRc, flaggedAlpha, ...sampleReleases()], { repositoryUrl: publicRepositoryUrl })?.tagName, "v1.7-build142");
  assert.strictEqual(service.latestPublishedRelease([...sampleReleases()].reverse().concat(misflaggedRc), { repositoryUrl: publicRepositoryUrl })?.tagName, "v1.7-build142", "Website stable selection must not depend on list order.");
  assert.strictEqual(service.latestPublishedRelease([misflaggedRc, flaggedAlpha], { repositoryUrl: publicRepositoryUrl }), null, "Website stable selection must not fall back to an alpha or RC.");
  const checksumlessStable = {
    draft: false,
    prerelease: false,
    tag_name: "v1.8-build150",
    name: "v1.8-build150",
    published_at: "2026-12-01T00:00:00Z",
    html_url: `${publicRepositoryUrl}/releases/tag/v1.8-build150`,
    assets: [{ ...makeAsset("AnxOS-Control-Center-Setup-1.8-build150.exe", 80 * 1024 * 1024), digest: "" }],
  };
  assert.strictEqual(
    service.latestPublishedRelease([checksumlessStable, ...sampleReleases()], { repositoryUrl: publicRepositoryUrl })?.tagName,
    "v1.7-build142",
    "A newer stable release without a SHA-256 must not replace a checksummed stable release.",
  );

  const stableOnLaterPage = sampleReleases()[1];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    draft: false,
    prerelease: false,
    tag_name: `v8.0-build${index}-rc1`,
    name: `v8.0-build${index}-rc1`,
    assets: [makeAsset(`AnxOS-Control-Center-Setup-8.0-build${index}-rc1.exe`, 80 * 1024 * 1024)],
  }));
  const fetchedPages = [];
  global.fetch = async (url) => {
    fetchedPages.push(String(url));
    const page = new URL(url).searchParams.get("page");
    const body = page === "2" ? [stableOnLaterPage] : firstPage;
    const link = page === "2" ? "" : `<${String(url).replace("page=1", "page=2")}>; rel="next"`;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "link" ? link : "") },
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
  const pagedRedirect = await functionsHelper.redirectLatestArtifact(new Request("https://anxoscontrolcenter.org/api/download/latest/windows"), {}, "windows");
  assert.strictEqual(pagedRedirect.status, 302, "Stable download must keep reading after a full page of release candidates.");
  assert(pagedRedirect.headers.get("location").includes("AnxOS-Control-Center-Setup-1.7-build142.exe"), "The stable release on the second page must be the download.");
  assert(!pagedRedirect.headers.get("location").includes("-rc1"), "A full first page of RC tags must not become the stable download.");
  assert(fetchedPages.some((url) => url.includes("page=2")), "the download route must request the next release page.");

  const workerModule = await import(pathToFileURL(path.join(websiteRoot, "_worker.js")).href);
  const pagesModule = await import(pathToFileURL(path.join(websiteRoot, "functions", "api", "download", "latest", "[platform].js")).href);
  const digested = (name) => makeAsset(name, 80 * 1024 * 1024);
  const undigested = (name) => {
    const asset = makeAsset(name, 80 * 1024 * 1024);
    delete asset.digest;
    return asset;
  };
  const githubRelease = (tag, assets, publishedAt) => ({
    draft: false,
    prerelease: false,
    tag_name: tag,
    name: tag,
    published_at: publishedAt,
    html_url: `${publicRepositoryUrl}/releases/tag/${tag}`,
    assets,
  });
  const notesAndAgentRelease = githubRelease("v2.0-build210", [
    digested("notes.txt"),
    digested("AnxOS-Agent-2.0-build210.deb"),
    undigested("AnxOS-Control-Center-Setup-2.0-build210.exe"),
  ], "2026-12-02T00:00:00Z");
  const linuxOnlyChecksumRelease = githubRelease("v2.0-build211", [
    digested("AnxOS-Control-Center-2.0-build211.AppImage"),
    undigested("AnxOS-Control-Center-Setup-2.0-build211.exe"),
  ], "2026-12-03T00:00:00Z");
  const mismatchedSidecarRelease = githubRelease("v2.0-build212", [
    undigested("AnxOS-Control-Center-Setup-2.0-build212.exe"),
    digested("notes.txt.sha256"),
    digested("AnxOS-Agent-2.0-build212.deb.sha256"),
  ], "2026-12-04T00:00:00Z");
  const olderValidWindows = sampleReleases()[1];
  const browserOptions = { repositoryUrl: publicRepositoryUrl, platform: "windows" };

  const notesSelection = service.latestPublishedRelease([notesAndAgentRelease], browserOptions);
  assert.strictEqual(notesSelection, null, "Checksummed notes or Agent packages must not authorize a checksum-less Windows installer.");
  const linuxSelection = service.latestPublishedRelease([linuxOnlyChecksumRelease], { repositoryUrl: publicRepositoryUrl });
  assert(!linuxSelection.assets.some((asset) => asset.fileName.includes("Setup-2.0-build211")), "A checksummed Linux installer must not keep a checksum-less Windows installer in the offered set.");
  assert(linuxSelection.assets.some((asset) => asset.key === "linux-appimage" && asset.sha256), "The Linux installer with its own digest must remain offered.");
  assert.strictEqual(service.preferredAssetForPlatform(linuxSelection, "windows"), null, "Windows preference must not fall back to the checksum-less setup.");
  const mismatchedSelection = service.latestPublishedRelease([mismatchedSidecarRelease], browserOptions);
  assert.strictEqual(mismatchedSelection, null, "A sidecar for a different file must not authorize the Windows installer.");
  const matchingSidecarName = "AnxOS-Control-Center-Setup-1.7-build143.exe";
  const matchingSidecarRelease = githubRelease("v1.7-build143", [
    undigested(matchingSidecarName),
    { name: `${matchingSidecarName}.sha256`, size: 96, browser_download_url: `${publicRepositoryUrl}/releases/download/v1.7-build143/${matchingSidecarName}.sha256` },
    digested("notes.txt.sha256"),
  ], "2026-07-01T00:00:00Z");
  const matchingSidecar = service.latestPublishedRelease([matchingSidecarRelease], browserOptions);
  const matchingSetup = matchingSidecar?.assets?.find((asset) => asset.key === "windows-setup");
  assert(matchingSetup && matchingSetup.checksumAsset?.fileName === `${matchingSidecarName}.sha256`, "The installer's own .sha256 sidecar is matching integrity evidence.");
  assert.notStrictEqual(matchingSetup?.checksumAsset?.fileName, "notes.txt.sha256");
  const olderWindows = service.latestPublishedRelease([linuxOnlyChecksumRelease, notesAndAgentRelease, olderValidWindows], browserOptions);
  assert.strictEqual(olderWindows.tagName, "v1.7-build142", "A newer checksum-less Windows release must lose to an older release whose Windows installer has its own checksum.");
  const olderSetup = olderWindows.assets.find((asset) => asset.key === "windows-setup");
  assert(olderSetup.fileName.includes("1.7-build142") && olderSetup.sha256, "The offered Windows setup must be the older checksummed installer.");
  const validWindows = service.latestPublishedRelease(sampleReleases(), browserOptions);
  assert.strictEqual(validWindows.tagName, "v1.7-build142");
  assert(validWindows.assets.find((asset) => asset.key === "windows-setup").sha256, "A normal checksummed Windows setup must still be selected.");

  async function mockReleaseFetch(releases) {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "" },
      text: async () => JSON.stringify(releases),
      json: async () => JSON.parse(JSON.stringify(releases)),
    });
  }
  async function assertRedirect(label, releases, platform, acceptName, rejectName) {
    await mockReleaseFetch(releases);
    const routes = [
      ["functions", await functionsHelper.redirectLatestArtifact(new Request(`https://anxoscontrolcenter.org/api/download/latest/${platform}`), {}, platform)],
      ["worker", await workerModule.default.fetch(new Request(`https://anxoscontrolcenter.org/api/download/latest/${platform}`), {})],
      ["pages", await pagesModule.onRequestGet({ request: new Request(`https://anxoscontrolcenter.org/api/download/latest/${platform}`), params: { platform }, env: {} })],
    ];
    for (const [route, response] of routes) {
      const location = response.headers.get("location") || "";
      if (acceptName) {
        assert.strictEqual(response.status, 302, `${label} ${route} must redirect to the checksummed installer.`);
        assert(location.includes(acceptName), `${label} ${route} must offer ${acceptName}.`);
      } else {
        assert.notStrictEqual(response.status, 302, `${label} ${route} must not redirect to an installer without its own checksum.`);
      }
      if (rejectName) assert(!location.includes(rejectName), `${label} ${route} must not offer ${rejectName}.`);
    }
    await mockReleaseFetch(releases);
    const loaded = await service.loadLatestRelease({
      force: true,
      platform,
      repositoryUrl: publicRepositoryUrl,
      config: { releaseRepository: { owner: publicOwner, repo: publicRepo } },
    }).catch((error) => error);
    if (acceptName) {
      assert.strictEqual(loaded.tagName, "v1.7-build142", `${label} fallback loader must select the checksummed Windows release.`);
      const setup = loaded.assets.find((asset) => asset.key === "windows-setup");
      assert(setup && setup.fileName.includes(acceptName) && setup.sha256, `${label} fallback loader must return that Windows installer and its digest.`);
    } else if (platform === "windows") {
      const setup = loaded?.assets?.find((asset) => asset.key === "windows-setup");
      assert(!setup, `${label} fallback loader must not offer the checksum-less Windows installer.`);
    }
  }
  await assertRedirect("notes-or-agent", [notesAndAgentRelease], "windows", "", "Setup-2.0-build210.exe");
  await assertRedirect("linux-only-checksum", [linuxOnlyChecksumRelease], "windows", "", "Setup-2.0-build211.exe");
  await assertRedirect("mismatched-sidecar", [mismatchedSidecarRelease], "windows", "", "Setup-2.0-build212.exe");
  await assertRedirect("older-valid-windows", [linuxOnlyChecksumRelease, notesAndAgentRelease, olderValidWindows], "windows", "AnxOS-Control-Center-Setup-1.7-build142.exe", "build21");
  await assertRedirect("valid-windows", sampleReleases(), "windows", "AnxOS-Control-Center-Setup-1.7-build142.exe", "");

  console.log("Website download smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
