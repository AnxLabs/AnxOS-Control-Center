const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");

// Isolate this process from any real local AnxOS config/agent state (e.g. a developer's own
// saved CurseForge API key), so hosted-proxy precedence checks below are deterministic.
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-curseforge-proxy-smoke-"));
process.env.ANXHUB_CONFIG_DIR = path.join(sandboxRoot, "config");
process.env.ANXOS_LOG_DIR = path.join(sandboxRoot, "logs");
process.env.ANXHUB_DISABLE_CURSEFORGE_ENV_FALLBACK = "1";
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

// Static checks: the Supabase Edge Function runs on Deno, which is not installed in this
// environment, so it cannot be executed locally. These assertions verify the required security
// controls and error-code contract are present in the deployed source, mirroring the approach
// used for the existing anxos-account function in account-system-smoke.js.
function assertMarketplaceProxyFunction() {
  const fn = read("supabase/functions/anxos-marketplace-curseforge/index.ts");

  assert(fn.includes('Deno.env.get("CURSEFORGE_API_KEY")'), "Proxy must read the CurseForge API key only from a server-side secret.");
  assert(!/CURSEFORGE_API_KEY\s*=\s*["'][^"']+["']/.test(fn), "Proxy source must not contain a hardcoded CurseForge API key.");
  assert(fn.includes("CURSEFORGE_AUTH_CONFIGURATION_MISSING") && fn.includes("requireConfigured"), "Proxy must fail safely with a structured code when the secret is missing.");
  assert(fn.includes("ALLOWED_API_PATHS") && fn.includes("assertAllowedApiPath"), "Proxy must allowlist CurseForge API paths.");
  assert(fn.includes("ALLOWED_DOWNLOAD_HOSTS") && fn.includes("validateDownloadUrl"), "Proxy must allowlist CurseForge CDN download hosts.");
  assert(fn.includes("MAX_DOWNLOAD_BYTES") && fn.includes("MAX_JSON_BYTES"), "Proxy must bound response and download sizes.");
  assert(fn.includes("REQUEST_TIMEOUT_MS") && fn.includes("fetchWithTimeout"), "Proxy must apply request timeouts.");
  assert(fn.includes("checkRateLimit") && fn.includes("CURSEFORGE_RATE_LIMITED"), "Proxy must rate limit requests with a structured error code.");
  assert(fn.includes("CURSEFORGE_FILE_NOT_FOUND") && fn.includes("CURSEFORGE_MODPACK_NOT_FOUND"), "Proxy must classify not-found errors distinctly.");
  assert(fn.includes("CURSEFORGE_UPSTREAM_ERROR") && fn.includes("CURSEFORGE_DOWNLOAD_FAILED") && fn.includes("CURSEFORGE_DOWNLOAD_UNAVAILABLE"), "Proxy must expose the required stable error codes.");
  assert(fn.includes("code: proxyError.code, message: proxyError.message"), "Proxy errors must use the flat {code, message} contract used across AnxOS backend functions.");
  assert(fn.includes('"/api/v1/marketplace/curseforge/api"') && fn.includes('"/api/v1/marketplace/curseforge/download"'), "Proxy must implement the existing desktop hosted-proxy contract.");
  assert(fn.includes("x-api-key") && !fn.includes("apiKey: curseForgeApiKey,"), "Proxy must forward the CurseForge key upstream without echoing it back to callers.");
  const keyUsageLines = fn.split("\n").filter((line) => line.includes("curseForgeApiKey"));
  const safeKeyUsagePattern = /const curseForgeApiKey|!curseForgeApiKey|Boolean\(curseForgeApiKey\)|"x-api-key":\s*curseForgeApiKey/;
  assert(keyUsageLines.every((line) => safeKeyUsagePattern.test(line)), "Proxy must never return or log the raw CurseForge API key.");
  assert(fn.includes("auditEvent") && !fn.match(/auditEvent\([^;]*curseForgeApiKey/), "Proxy audit logging must never include the CurseForge API key.");
}

function assertBundledMarketplaceConfig() {
  const config = read("website/marketplace-config.js");
  assert(config.includes("window.ANXOS_MARKETPLACE_CONFIG"), "Bundled marketplace config must expose a public config object.");
  assert(config.includes("curseforgeProxyUrl"), "Bundled marketplace config must expose a public hosted proxy URL.");
  assert(!/CURSEFORGE_API_KEY|curseForgeApiKey\s*:/.test(config), "Bundled marketplace config must never contain a CurseForge API key.");
}

function assertPackaging() {
  const pkg = JSON.parse(read("package.json"));
  assert(Array.isArray(pkg.build?.files) && pkg.build.files.includes("website/marketplace-config.js"), "Packaged builds must bundle website/marketplace-config.js.");
  assert(pkg.scripts["curseforge:marketplace-proxy:smoke"], "package.json must register this smoke test.");
}

// Runtime checks against the desktop provider's exported _test helpers.
function assertDesktopProviderIntegration() {
  const curseforgeProvider = require(path.join(root, "src/services/providers/curseforgeProvider.js"));
  const { _test } = curseforgeProvider;

  assert(typeof _test.getBundledMarketplaceProxyUrl === "function", "Provider must expose a bundled hosted-proxy URL resolver.");
  const bundledUrl = _test.getBundledMarketplaceProxyUrl();
  assert(typeof bundledUrl === "string" && /^https:\/\/.+functions\.supabase\.co\/anxos-marketplace-curseforge$/.test(bundledUrl), "Bundled hosted-proxy URL must point at the deployed Supabase Edge Function.");

  assert(typeof _test.getHostedProxyUrl === "function", "Provider must expose getHostedProxyUrl for testing.");
  const explicitOverride = _test.getHostedProxyUrl({ proxyUrl: "https://example.test/override" });
  assert(explicitOverride === "https://example.test/override", "getHostedProxyUrl must return an explicit owner override.");
  assert(_test.getHostedProxyUrl({}) === "", "getHostedProxyUrl must not itself apply the bundled default (that is resolveEffectiveHostedProxyUrl's job).");

  assert(typeof _test.resolveEffectiveHostedProxyUrl === "function", "Provider must expose resolveEffectiveHostedProxyUrl for testing.");
  const resolvedDefault = _test.resolveEffectiveHostedProxyUrl({});
  assert(resolvedDefault === bundledUrl, "resolveEffectiveHostedProxyUrl must fall back to the bundled default when nothing else is configured.");
  const resolvedOverride = _test.resolveEffectiveHostedProxyUrl({ proxyUrl: "https://example.test/override" });
  assert(resolvedOverride === "https://example.test/override", "resolveEffectiveHostedProxyUrl must still prefer an explicit owner override.");
  const disabled = _test.resolveEffectiveHostedProxyUrl({ disableHostedProxy: true });
  assert(disabled === "", "resolveEffectiveHostedProxyUrl must allow disabling the hosted proxy entirely.");

  assert(typeof _test.getHostedProxyAuthHeaders === "function", "Provider must expose getHostedProxyAuthHeaders for testing.");
  const supabaseHeaders = _test.getHostedProxyAuthHeaders(bundledUrl);
  assert(typeof supabaseHeaders.apikey === "string" && supabaseHeaders.apikey.length > 0, "Requests to the Supabase-hosted proxy must include the public anon apikey header.");
  assert(String(supabaseHeaders.Authorization || "").startsWith("Bearer "), "Requests to the Supabase-hosted proxy must include a Bearer authorization header.");
  const untrustedHeaders = _test.getHostedProxyAuthHeaders("https://not-supabase.example.com/proxy");
  assert(Object.keys(untrustedHeaders).length === 0, "Auth headers must only be attached for approved Supabase function hosts.");

  assert(typeof _test.parseHostedProxyErrorBody === "function", "Provider must expose parseHostedProxyErrorBody for testing.");
  const parsed = _test.parseHostedProxyErrorBody(JSON.stringify({ code: "CURSEFORGE_RATE_LIMITED", message: "Too many requests." }));
  assert(parsed.code === "CURSEFORGE_RATE_LIMITED" && parsed.message === "Too many requests.", "Provider must parse the backend's flat {code, message} error contract.");

  assert(typeof _test.migrateAwayFromLegacyLocalApiKey === "function", "Provider must expose the legacy API key migration for testing.");
}

function assertRendererErrorHandling() {
  const rendererScript = read("app.js");
  assert(rendererScript.includes("CURSEFORGE_MARKETPLACE_UNAVAILABLE_MESSAGE") && rendererScript.includes("CurseForge Marketplace is temporarily unavailable. Please check your internet connection and try again."), "Renderer must show the required offline/unavailable message.");
  assert(rendererScript.includes("isCurseForgeServiceUnavailableError") && rendererScript.includes("isCurseForgeRateLimitedError"), "Renderer must classify service-unavailable and rate-limited CurseForge errors distinctly from configuration errors.");
  assert(rendererScript.includes('canUseSettingsCapability("canManageMarketplaceSettings")'), "Renderer must gate the Settings recovery action behind the owner-only marketplace settings capability.");
  assert(!/title: "CurseForge API key needs attention"[\s\S]{0,40}message:[\s\S]{0,400}action: "open-settings"[\s\S]{0,120}\};\s*\n\s*setMarketplaceProviderStatus\("CurseForge API key needs attention", "error"\);\s*\n\s*showToast\("CurseForge API key needs attention", "warning"\);\s*\n\s*\} else \{/.test(rendererScript), "Renderer must not unconditionally offer the CurseForge Settings action to every user.");
}

function assertInstallErrorCode() {
  const installService = read("src/services/marketplaceInstallService.js");
  assert(installService.includes('"CURSEFORGE_INSTALL_FAILED"'), "Install pipeline must expose a stable CurseForge-specific fallback error code.");
}

assertMarketplaceProxyFunction();
assertBundledMarketplaceConfig();
assertPackaging();
assertDesktopProviderIntegration();
assertRendererErrorHandling();
assertInstallErrorCode();

console.log("CurseForge Marketplace proxy smoke checks passed.");
