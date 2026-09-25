const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const websiteRoot = path.join(root, "website");

function read(file) {
  return fs.readFileSync(path.join(websiteRoot, file), "utf8");
}

const index = read("index.html");
const activate = read("activate.html");
const forgot = read("forgot-password.html");
const reset = read("reset-password.html");
const signin = read("signin/index.html");
const signup = read("signup/index.html");
const account = read("account/index.html");
const profile = read("profile/index.html");
const activateRoute = read("activate/index.html");
const forgotRoute = read("forgot-password/index.html");
const resetRoute = read("reset-password/index.html");
const downloadRoute = read("download/index.html");
const downloadHtmlRoute = read("download.html");
const downloadsRoute = read("downloads/index.html");
const featuresRoute = read("features/index.html");
const gettingStartedRoute = read("getting-started/index.html");
const systemRequirementsRoute = read("system-requirements/index.html");
const windowsInstallationRoute = read("windows-installation/index.html");
const securityPrivacyRoute = read("security-privacy/index.html");
const faqRoute = read("faq/index.html");
const installRoute = read("install/index.html");
const releaseNotes = read("release-notes.html");
const releaseRoute = read("release/index.html");
const changelogRoute = read("changelog/index.html");
const accountHtml = read("account.html");
const profileHtml = read("profile.html");
const robots = read("robots.txt");
const sitemap = read("sitemap.xml");
const manifest = read("site.webmanifest");
const redirects = read("_redirects");
const websiteReadme = read("README.md");
const config = read("config.js");
const accountConfig = read("account-config.js");
const site = read("site.js");
const styles = read("styles.css");
const rootPackage = fs.readFileSync(path.join(root, "package.json"), "utf8");

const officialOrigin = "https://anxoscontrolcenter.org";
const oldPagesOrigin = "https://anxos-control-center.pages.dev";
const removedBrandingFiles = [
  "anxos-logo.jpg",
  "anxhub-icon.svg",
  "neon-core-favicon-512.png",
];
const localAssetPattern = /(?:src|href|content)=["']([^"']+\.(?:png|svg|ico|jpg|jpeg|webmanifest)(?:\?[^"']*)?)["']/gi;
const quotedAssetPattern = /["']([^"']*(?:\/?assets\/|\/?favicon\.ico)[^"']+\.(?:png|svg|ico|jpg|jpeg|webmanifest)(?:\?[^"']*)?)["']/gi;
const cssAssetPattern = /url\(["']?([^"')]+\.(?:png|svg|ico|jpg|jpeg)(?:\?[^"')]+)?)["']?\)/gi;

function walkFiles(dir, predicate, output = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, output);
      return;
    }
    if (predicate(fullPath)) output.push(fullPath);
  });
  return output;
}

function relativeWebsitePath(filePath) {
  return path.relative(websiteRoot, filePath).replace(/\\/g, "/");
}

function routeCandidates(file) {
  if (file === "index.html") return ["/", "/index.html"];
  if (file.endsWith("/index.html")) {
    const route = `/${file.slice(0, -"index.html".length)}`;
    return [route.slice(0, -1), route];
  }
  return [`/${file}`];
}

function extractAssetReferences(file, source) {
  const refs = [];
  const extension = path.extname(file);
  const patterns = extension === ".css"
    ? [cssAssetPattern]
    : extension === ".html" || extension === ".svg"
      ? [localAssetPattern, quotedAssetPattern]
      : [quotedAssetPattern];
  patterns.forEach((pattern) => {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const ref = match[1];
      if (!ref || ref.startsWith("data:") || ref.startsWith("#")) continue;
      refs.push(ref);
    }
  });
  return Array.from(new Set(refs));
}

function localPathFromUrl(value, route = "/") {
  const base = new URL(route || "/", officialOrigin);
  const url = new URL(value, base);
  if (url.origin !== officialOrigin) return null;
  return decodeURIComponent(url.pathname);
}

function assertAssetPathExists(ref, sourceFile, route) {
  const pathname = localPathFromUrl(ref, route);
  if (!pathname) return;
  const target = path.join(websiteRoot, pathname);
  assert(fs.existsSync(target), `${sourceFile} references missing local asset ${ref} resolved as ${pathname}${route ? ` from ${route}` : ""}.`);
}

function assertWebsiteBrandingAssetsResolve() {
  const websiteFiles = walkFiles(websiteRoot, (file) => /\.(?:html|js|css|json|webmanifest|svg)$/.test(file));
  websiteFiles.forEach((filePath) => {
    const file = relativeWebsitePath(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    removedBrandingFiles.forEach((removedFile) => {
      assert(!source.includes(removedFile), `${file} must not reference removed branding asset ${removedFile}.`);
    });
    extractAssetReferences(file, source).forEach((ref) => {
      if (/^https?:\/\//i.test(ref)) {
        assertAssetPathExists(ref, file);
        return;
      }
      if (file.endsWith(".html")) {
        routeCandidates(file).forEach((route) => {
          assertAssetPathExists(ref, file, route);
          if (!route.endsWith(".html") && route !== "/") assertAssetPathExists(ref, file, `${route}/`);
        });
        return;
      }
      const sourceDir = `/${path.dirname(file).replace(/^\.$/, "")}/`.replace("//", "/");
      assertAssetPathExists(ref, file, sourceDir);
    });
  });

  assert(config.includes('logoPath: "/assets/anxos-logo.png"'), "Shared website config must inject the canonical root-safe Neon Core logo path.");
  assert(site.includes("function rootSafeAssetPath") && site.includes("rootSafeAssetPath(config.logoPath)"), "Shared website renderer must normalize injected logo paths.");
}

["index.html", "download/index.html", "features/index.html", "getting-started/index.html", "system-requirements/index.html", "windows-installation/index.html", "security-privacy/index.html", "faq/index.html", "signin/index.html", "signup/index.html", "account/index.html", "profile/index.html", "activate/index.html", "forgot-password/index.html", "reset-password/index.html", "release-notes.html"].forEach((file) => {
  const html = read(file);
  assert(html.includes("data-site-menu-toggle"), `${file} must expose the mobile navigation toggle.`);
  assert(html.includes("data-site-nav"), `${file} must expose the mobile navigation target.`);
  assert(html.includes('data-auth-nav="signed-out" hidden') && html.includes('data-auth-nav="signed-in"') && html.includes('data-auth-action="signout"'), `${file} must expose auth-aware navigation.`);
  assert(html.includes('rel="canonical"'), `${file} must declare a canonical URL.`);
  assert(html.includes('rel="icon"') && html.includes('apple-touch-icon') && html.includes('site.webmanifest'), `${file} must declare favicon and app icons.`);
});

assert(config.includes(`siteUrl: "${officialOrigin}"`) && accountConfig.includes(`siteUrl: "${officialOrigin}"`), "Website configs must use the official domain.");
assert(rootPackage.includes(`"homepage": "${officialOrigin}"`), "Package metadata should expose the official homepage.");
assert(index.includes(`<meta property="og:url" content="${officialOrigin}/">`) && index.includes("assets/social-preview.png"), "Homepage must expose canonical Open Graph metadata.");
assert(releaseNotes.includes(`<meta property="og:url" content="${officialOrigin}/release-notes.html">`), "Release notes must expose page-specific Open Graph URL.");
assert(site.includes("release-note-card--latest") && site.includes("Current release") && !site.includes("empty.innerHTML"), "Release notes must highlight the current release and render empty states with text nodes.");
assert(index.includes('name="twitter:card" content="summary_large_image"'), "Homepage must include Twitter/X card metadata.");
assert(!fs.existsSync(path.join(websiteRoot, "assets", "social-preview.svg")), "Website should not ship unused social preview source assets.");
assert(fs.existsSync(path.join(websiteRoot, "favicon.ico")), "Website must include favicon.ico.");
["favicon.svg", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "social-preview.png"].forEach((file) => {
  assert(fs.existsSync(path.join(websiteRoot, "assets", file)), `Website asset ${file} must exist.`);
});
assert(manifest.includes("AnxOS Control Center") && manifest.includes("/assets/icon-192.png"), "Web manifest must include app icon metadata.");
assertWebsiteBrandingAssetsResolve();
assert(robots.includes(`Sitemap: ${officialOrigin}/sitemap.xml`) && robots.includes("Disallow: /activate") && robots.includes("Disallow: /signin") && robots.includes("Disallow: /reset-password"), "Robots rules must expose sitemap and exclude account routes.");
assert(sitemap.includes(`<loc>${officialOrigin}/</loc>`) && sitemap.includes(`<loc>${officialOrigin}/release-notes.html</loc>`) && sitemap.includes(`<loc>${officialOrigin}/download</loc>`) && sitemap.includes(`<loc>${officialOrigin}/features</loc>`) && sitemap.includes(`<loc>${officialOrigin}/getting-started</loc>`) && sitemap.includes(`<loc>${officialOrigin}/system-requirements</loc>`) && sitemap.includes(`<loc>${officialOrigin}/windows-installation</loc>`) && sitemap.includes(`<loc>${officialOrigin}/security-privacy</loc>`) && sitemap.includes(`<loc>${officialOrigin}/faq</loc>`) && !sitemap.includes("activate"), "Sitemap must include only public canonical pages.");
assert(redirects.includes("/sign-in /signin 301") && redirects.includes("/changelog /release-notes.html 301") && redirects.includes("/device-login /activate 301") && !redirects.includes("/* /index.html"), "Cloudflare redirects must cover clean aliases without a broad SPA fallback.");
assert(downloadsRoute.includes('window.location.replace("/download" + window.location.search)') && installRoute.includes('window.location.replace("/getting-started" + window.location.search)'), "Static alias routes must preserve query strings while redirecting to canonical routes.");
assert(downloadHtmlRoute.includes("Download AnxOS for Windows") && downloadHtmlRoute.includes('data-download-page') && !downloadHtmlRoute.includes('window.location.replace("/download"'), "Download HTML compatibility route must render visible content instead of self-redirecting.");
assert(releaseRoute.includes('window.location.replace("/release-notes.html" + window.location.search)') && changelogRoute.includes('window.location.replace("/release-notes.html" + window.location.search)'), "Release alias routes must preserve query strings while redirecting to release notes.");
assert([signin, signup, account, profile, activateRoute, forgotRoute, resetRoute, activate, forgot, reset].every((html) => html.includes('name="robots" content="noindex,nofollow"')), "Account and activation pages must be excluded from indexing.");
assert(signin.includes('data-auth-view="loading"') && signup.includes('data-auth-view="loading"') && signup.includes('data-auth-view="signed-in"'), "Auth sign-in and sign-up pages must avoid loading-state flicker and handle existing sessions.");
assert(site.includes("function applyAuthRouteMessages") && site.includes('params.get("created") === "1"') && site.includes('params.get("verified") === "1"'), "Auth redirects must show friendly created and verified messages.");
assert(site.includes("function applyAccountNavigationState") && site.includes("accountNavKeyFromHref") && styles.includes('.account-nav__item[aria-current="page"]'), "Account/profile navigation must expose active state for clean routes and section deep links.");
assert(accountHtml.includes('name="robots" content="noindex,nofollow"') && profileHtml.includes('name="robots" content="noindex,nofollow"'), "Account clean URL HTML files must be excluded from indexing.");
assert(accountHtml.includes('data-account-route="account"') && profileHtml.includes('data-account-route="profile"'), "Cloudflare clean URL HTML files must serve the real account/profile pages.");
assert(!accountHtml.includes('window.location.replace("/account"') && !profileHtml.includes('window.location.replace("/profile"'), "Cloudflare clean URL HTML files must not self-redirect.");
assert(index.includes("© 2026 AnxOS Control Center") && index.includes("anxoscontrolcenter.org") && index.includes("/getting-started"), "Homepage footer must include copyright, official domain, and Getting Started links.");
assert(!index.includes('href="/release-notes.html">Release</a>') && !index.includes('href="/getting-started">Install</a>'), "Homepage navigation must not include duplicate release or install aliases.");
assert(site.includes("function applyActiveNavigation") && styles.includes('.site-nav a[aria-current="page"]'), "Website shell must apply visible active navigation state.");
assert(index.includes("First server workflow") && index.includes("Prepare Node") && index.includes("Node Health"), "Homepage must include honest Getting Started workflow copy.");
assert(index.includes("Windows desktop, Linux packages") && index.includes("This PC or a connected Agent node") && index.includes("Your hardware, VPS, NAS, or server"), "Homepage hero must explain supported platforms, Agent management, and hosting responsibility.");
assert(downloadRoute.includes(`<link rel="canonical" href="${officialOrigin}/download">`) && downloadRoute.includes("data-download-status") && downloadRoute.includes("data-download-page") && downloadRoute.includes("data-primary-download"), "Download must be a clean direct route with the dynamic download workspace.");
assert(downloadRoute.includes('href="/windows-installation"') && downloadHtmlRoute.includes('href="/windows-installation"') && site.includes('"/windows-installation"'), "Download installation help links must use the clean Windows installation route.");
assert(downloadRoute.includes('href="/system-requirements"') && downloadHtmlRoute.includes('href="/system-requirements"') && site.includes('"/system-requirements"'), "Download system requirements links must use the clean dedicated route.");
assert(downloadRoute.includes('src="/site.js"') && downloadRoute.includes('src="/release-download-service.js"') && downloadRoute.includes('href="/styles.css"'), "Download route assets must be root-safe.");
assert(featuresRoute.includes(`<link rel="canonical" href="${officialOrigin}/features">`) && featuresRoute.includes("Built for server work"), "Features must be a clean direct route.");
assert(index.includes("Run Everything on Your Own PC") && featuresRoute.includes("Run Everything on Your Own PC"), "Website must explain the Local Agent on the homepage and features route.");
assert(index.includes("The AnxOS Local Agent securely connects the desktop app to services running on your computer.") && featuresRoute.includes("Normal Windows users do not need Anx's Debian server."), "Local Agent copy must be beginner-friendly and make local ownership clear.");
["Runs Locally", "Automatic Setup", "Starts with Windows", "No Token Copying", "Remote Servers Optional", "Easy Repair and Updates"].forEach((label) => {
  assert(index.includes(label) && featuresRoute.includes(label), `Local Agent feature card ${label} must appear on public website pages.`);
});
assert(gettingStartedRoute.includes(`<link rel="canonical" href="${officialOrigin}/getting-started">`) && gettingStartedRoute.includes("First server workflow"), "Getting Started must be a clean direct route.");
assert(systemRequirementsRoute.includes(`<link rel="canonical" href="${officialOrigin}/system-requirements">`) && systemRequirementsRoute.includes("System Requirements"), "System Requirements must be a clean direct route.");
["Windows 11, 64-bit", "64-bit Intel or AMD processor", "4 GB RAM", "2 GB free storage", "Administrator access", "8 GB RAM or more", "SSD storage", "Hardware virtualization", "AnxOS itself does not provide game-server hosting capacity", "computer must remain powered on", "Playit, Tailscale, Cloudflare Tunnel, or router port forwarding"].forEach((copy) => {
  assert(systemRequirementsRoute.includes(copy), `System Requirements page must include: ${copy}`);
});
assert(windowsInstallationRoute.includes(`<link rel="canonical" href="${officialOrigin}/windows-installation">`) && windowsInstallationRoute.includes("Install AnxOS and Prepare This PC"), "Windows Installation must be a clean direct route.");
["Download the Windows installer", "Open the installer", "SmartScreen warning", "Launch AnxOS Control Center", "Complete onboarding", "Install the Local Agent", "Allow administrator permission", "scan dependencies", "Install required dependencies", "Open Marketplace", "Create your first server"].forEach((copy) => {
  assert(windowsInstallationRoute.includes(copy), `Windows installation guide must include step: ${copy}`);
});
["Local Agent installation failure", "Administrator permission denied", "Agent offline", "Port already in use", "Antivirus quarantine", "Docker restart required", "Windows restart required"].forEach((copy) => {
  assert(windowsInstallationRoute.includes(copy), `Windows installation guide must include troubleshooting: ${copy}`);
});
assert(!windowsInstallationRoute.includes("edit internal JSON") && !windowsInstallationRoute.includes("copy an Agent token"), "Windows installation guide must avoid internal JSON and token-copying instructions.");
assert(securityPrivacyRoute.includes(`<link rel="canonical" href="${officialOrigin}/security-privacy">`) && securityPrivacyRoute.includes("Security and Privacy"), "Security and Privacy must be a clean direct route.");
["The Local Agent runs on your own computer", "intended to perform actions requested through AnxOS", "Local pairing is configured automatically", "Remote access is not enabled by default", "Logs and diagnostics are designed to sanitize secrets", "You can stop the Local Agent service or uninstall the Agent", "Installing server software can open local services, expose ports, create firewall prompts, or download third-party software"].forEach((copy) => {
  assert(securityPrivacyRoute.includes(copy), `Security and Privacy page must include: ${copy}`);
});
assert(!/guarantee|guaranteed|military-grade|zero[- ]knowledge/i.test(securityPrivacyRoute), "Security and Privacy page must not make unsupported security or legal guarantees.");
assert(faqRoute.includes(`<link rel="canonical" href="${officialOrigin}/faq">`) && faqRoute.includes("Common Questions"), "FAQ must be a clean direct route.");
[
  "Do I need Anx's Debian server?",
  "Does AnxOS host the server for me?",
  "Does my PC need to stay on?",
  "Can I use a remote server instead?",
  "Can I manage both my PC and a remote server?",
  "Does the Local Agent start with Windows?",
  "Do I need Node.js?",
  "Do I need to copy an Agent token?",
  "Can I uninstall the Local Agent?",
  "Where are my instances stored?",
  "Why does Windows show a blue SmartScreen warning?",
  "Is macOS supported?",
  "Which Linux distributions are supported?",
  "Can AnxOS install Java, SteamCMD, and other dependencies?",
  "How do I let friends join my server?",
].forEach((question) => {
  assert(faqRoute.includes(question), `FAQ must include question: ${question}`);
});
["Local Agent on their own Windows PC", "does not provide hosting capacity", "This PC alongside remote servers", "managed runtime", "Local pairing is handled automatically", "Public Access options such as Playit, Tailscale, Cloudflare Tunnel, or manual port forwarding"].forEach((copy) => {
  assert(faqRoute.includes(copy), `FAQ must include answer copy: ${copy}`);
});
["index.html", "download/index.html", "download.html", "features/index.html", "getting-started/index.html", "system-requirements/index.html", "windows-installation/index.html", "security-privacy/index.html"].forEach((file) => {
  assert(read(file).includes('href="/security-privacy"'), `${file} public footer should link to the public security and privacy page.`);
  assert(read(file).includes('href="/faq"'), `${file} public footer should link to the public FAQ page.`);
});
assert(signin.includes('data-auth-form="signin"') && signin.includes(`<link rel="canonical" href="${officialOrigin}/signin">`), "Sign-in must be a clean direct route.");
assert(signup.includes('data-auth-form="signup"') && signup.includes(`<link rel="canonical" href="${officialOrigin}/signup">`), "Sign-up must be a clean direct route.");
assert(account.includes('data-account-route="account"') && account.includes(`<link rel="canonical" href="${officialOrigin}/account">`), "Account must be a clean direct route.");
assert(profile.includes('data-account-route="profile"') && profile.includes(`<link rel="canonical" href="${officialOrigin}/profile">`), "Profile must be a clean direct route.");
assert(activateRoute.includes('data-standalone-route="activate"') && activateRoute.includes(`<link rel="canonical" href="${officialOrigin}/activate">`), "Activation must be a clean direct route.");
assert(read("device.html").includes('window.location.replace(`/activate${query}`)') && read("device-login.html").includes('window.location.replace(`/activate${query}`)'), "Legacy device activation pages must preserve query strings when redirecting to /activate.");
assert(forgotRoute.includes('data-auth-form="forgot"') && forgotRoute.includes(`<link rel="canonical" href="${officialOrigin}/forgot-password">`), "Forgot-password must be a clean direct route.");
assert(resetRoute.includes('data-auth-form="reset"') && resetRoute.includes(`<link rel="canonical" href="${officialOrigin}/reset-password">`), "Reset-password must be a clean direct route.");
assert(!index.includes("window.location.hash") && !index.includes("location.hash"), "Homepage must not include inline hash routing.");
assert(!index.includes('href="#signin"') && !index.includes('href="#signup"') && !index.includes('href="#account"') && !index.includes('href="#profile"'), "Homepage must not link to hash-based account routes.");
assert(site.includes("function redirectLegacyHashRoutes") && site.includes('"account-security": "/account?section=security"') && site.includes('download: "/download"') && site.includes('changelog: "/release-notes.html"'), "Shared legacy normalizer must convert old hash URLs on every website page.");
assert(site.includes('legacyPagesHost = "anxos-control-center.pages.dev"') && site.includes("window.location.replace(next.toString())"), "Website should canonicalize stale Pages host links to the official domain.");
assert(!site.includes("if (document.body?.dataset?.standaloneRoute) return false;"), "Legacy hash cleanup must run on standalone clean routes.");
assert(!site.includes("window.location.hash =") && !site.includes('addEventListener("hashchange"') && site.includes("async function applyRouteState()"), "Website must use pathname route state instead of hash routing.");
assert(!site.includes("hashParams") && !site.includes("hash.indexOf"), "Website query parsing must use clean route query strings.");
["index.html", "download/index.html", "download.html", "downloads/index.html", "features/index.html", "getting-started/index.html", "setup/index.html", "system-requirements/index.html", "windows-installation/index.html", "security-privacy/index.html", "faq/index.html", "install/index.html", "signin/index.html", "signup/index.html", "account/index.html", "profile/index.html", "activate/index.html", "forgot-password/index.html", "reset-password/index.html", "release/index.html", "changelog/index.html", "release-notes.html"].forEach((file) => {
  const html = read(file);
  const hashLinks = Array.from(html.matchAll(/\s(?:href|src)=["']([^"']*#[^"']*)["']/g))
    .map((match) => match[1])
    .filter((value) => !value.startsWith("#icon-"));
  assert.strictEqual(hashLinks.length, 0, `${file} must not contain hash-fragment website links: ${hashLinks.join(", ")}`);
});

const deployedWebsiteText = fs.readdirSync(websiteRoot)
  .filter((file) => fs.statSync(path.join(websiteRoot, file)).isFile() && file !== "README.md")
  .map((file) => `${file}\n${read(file)}`)
  .join("\n");
assert(!deployedWebsiteText.includes(oldPagesOrigin), "Public website files must not hardcode the old Pages URL.");
assert(websiteReadme.includes("CNAME") && websiteReadme.includes("anxos-control-center.pages.dev") && websiteReadme.includes("permanent `301`"), "Website README must document the Cloudflare www redirect setup.");

assert(!index.includes("8 players"), "Homepage must not show fake player counts.");
assert(!index.includes("[11:57:42]"), "Homepage must not show fake timestamped console output.");
assert(index.includes("Live health appears after you connect an Agent"), "Homepage preview should be honest about live data.");
assert(index.includes("Runtime Dependencies") && index.includes("Prepare Node"), "Homepage should mention runtime dependency management.");

assert(index.includes("data-download-status"), "Downloads page should expose release metadata status.");
assert(site.includes("loadLatestRelease") && site.includes("renderDownloadFailure"), "Downloads should discover GitHub Releases and handle missing release metadata.");
assert(site.includes("function showDownloadStartupFallback") && site.includes("function initializeWebsite"), "Website startup must have a top-level error boundary.");
assert(config.includes("githubReleasesApiUrl") && config.includes("stableDownloadEndpoints") && config.includes("AnxOS-Control-Center-Releases") && !config.includes("downloads:"), "Website config should use runtime release discovery from the public release repository instead of static artifact URLs.");
assert(fs.existsSync(path.join(websiteRoot, "release-download-service.js")), "Website must ship the reusable release download service.");
assert(site.includes("No downloadable release is currently available.") && site.includes("Download information is temporarily unavailable. Please try again shortly."), "Download failures must clear loading placeholders with a complete visible unavailable state.");
assert(site.includes('node.setAttribute("aria-disabled", "true")'), "Unavailable download/config links should become disabled, not dead # links.");
assert(site.includes("friendlyAccountDataError") && site.includes("ACCOUNT_NETWORK_OR_CORS") && site.includes("refreshAccountSection"), "Account overview should classify protected endpoint failures and refresh sections independently.");
assert(site.includes('authorization: `Bearer ${accessToken}`') && site.includes("apikey: accountConfig.supabaseAnonKey"), "Protected account requests must include bearer auth and Supabase anon apikey.");
assert(site.includes("waitForAuthRestoration") && site.includes("authInitializationPromise"), "Protected account requests must wait for bounded auth restoration.");
assert(site.includes("/api/auth/device/lookup") && site.includes("requireAuth: false"), "Device-code review must use public lookup with the Supabase anon apikey.");
assert(site.includes("requireSignedInForDeviceAction"), "Device approval and denial must require a signed-in account after public review.");
assert(site.includes("renderDeviceSummary(null)") && site.includes("Waiting for code"), "Failed device lookups must reset the requesting-device panel.");
assert(!site.includes('setDeviceMessage(friendlyAuthError(error), "error")'), "Device activation should not show raw fetch/auth-only errors.");
assert(!site.includes("window.location.hostname === \"www.anxoscontrolcenter.org\""), "www redirects should be handled by Cloudflare, not application JavaScript.");
["index.html", "download/index.html", "download.html", "downloads/index.html", "features/index.html", "getting-started/index.html", "system-requirements/index.html", "windows-installation/index.html", "security-privacy/index.html", "faq/index.html", "install/index.html", "signin/index.html", "signup/index.html", "account/index.html", "profile/index.html", "activate/index.html", "forgot-password/index.html", "reset-password/index.html", "release/index.html", "changelog/index.html", "release-notes.html"].forEach((file) => {
  assert(!read(file).includes('href="#"'), `${file} must not ship dead # fallback links.`);
});

assert(index.includes('id="not-found"') && !site.includes('window.location.hash = "not-found"'), "Website must not route unsupported paths by writing hash fragments.");
assert(activate.includes('data-standalone-route="activate"') && forgot.includes('data-auth-form="forgot"') && reset.includes('data-auth-form="reset"'), "Cloudflare clean URL HTML files must serve real activation and recovery pages.");
assert(site.includes('selectedState = "loading"'), "Sign-in route should show loading state instead of flashing signed-out UI while auth initializes.");
assert(site.includes("initialize-timeout-fallback") && site.includes('authState = "signed-out"'), "Auth-dependent navigation must not stay permanently hidden after a failed session restore.");
assert(site.includes("normalizeReturnTarget") && site.includes("parsed.origin !== window.location.origin"), "Return destinations must be same-origin validated.");
assert(site.includes("redirectToSignInForCurrentRoute") && site.includes("/signin?"), "Authenticated routes must redirect signed-out users to clean sign-in routes.");
assert(site.includes("WEBSITE_DEBUG") && site.includes("if (!WEBSITE_DEBUG) return;"), "Verbose website auth logging must be opt-in.");
assert(account.includes("data-confirm-modal") && activateRoute.includes("data-confirm-modal"), "Account and activation pages should expose the shared confirmation modal.");
assert(site.includes("function confirmUserAction") && site.includes("Approve this desktop app?") && site.includes("Sign out all desktop sessions?"), "Security-sensitive website actions should use branded confirmation copy.");
assert(!/window\.(?:prompt|alert|confirm)|\b(?:prompt|alert|confirm)\(/.test(site), "Website should not use raw browser prompt, alert, or confirm dialogs.");
assert(site.includes('document.body.classList.add("has-open-modal")') && site.includes('document.body.style.overflow = "hidden"') && site.includes('event.key !== "Tab"'), "Website confirmation modal must lock background scroll and trap keyboard focus.");

assert(signup.includes('name="passwordConfirm"') && resetRoute.includes('name="passwordConfirm"'), "Create account and reset forms should include password confirmation.");
assert(site.includes('setMessage("signup", "Passwords do not match.", "error")'), "Sign-up should validate password confirmation before network calls.");
assert(activateRoute.includes("Opening this page never approves a device automatically."), "Activation page must explicitly avoid auto-approval ambiguity.");
assert(activateRoute.includes('autocomplete="one-time-code"') && activateRoute.includes('autocapitalize="characters"') && activateRoute.includes('spellcheck="false"'), "Activation code input must support mobile/paste ergonomics.");

assert(styles.includes(".site-menu-button") && styles.includes(".site-nav.is-open"), "Website CSS must include mobile menu states.");
assert(styles.includes("@media (prefers-reduced-motion: reduce)"), "Website must respect reduced-motion preference.");
assert(styles.includes(".download-status") && styles.includes(".account-unavailable") && styles.includes(".section-heading"), "Website must style honest loading/unavailable states and aligned download headings.");
assert(styles.includes(".site-footer nav") && styles.includes(".steps--detailed"), "Website CSS must support footer and Getting Started responsive polish.");
assert(styles.includes(".confirm-modal") && styles.includes("max-height: calc(100dvh - 36px)") && styles.includes("overscroll-behavior: contain"), "Website confirmation modal must remain viewport-safe on short screens.");

console.log("Website production smoke checks passed.");
