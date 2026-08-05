const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");

// Isolate this process from any real local AnxOS config/agent state.
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-curseforge-hosted-proxy-endpoint-"));
process.env.ANXHUB_CONFIG_DIR = path.join(sandboxRoot, "config");
process.env.ANXOS_LOG_DIR = path.join(sandboxRoot, "logs");
process.env.ANXHUB_DISABLE_CURSEFORGE_ENV_FALLBACK = "1";
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const { _test } = require(path.join(root, "src/services/providers/curseforgeProvider.js"));

function check(proxyUrl, expected, label) {
  const endpoint = String(_test.buildHostedProxyEndpoint(proxyUrl, "/api/v1/marketplace/curseforge/api"));
  assert.strictEqual(endpoint, expected, `${label}: expected "${expected}" but got "${endpoint}"`);
}

// Regression coverage: a Supabase Edge Function URL has a real path segment (the function
// slug). This must be preserved, not replaced, by endpoint construction.
check(
  "https://example.supabase.co/anxos-marketplace-curseforge",
  "https://example.supabase.co/anxos-marketplace-curseforge/api/v1/marketplace/curseforge/api",
  "function-slug base URL",
);

// Trailing slash on the base URL must not duplicate or drop path segments.
check(
  "https://example.supabase.co/anxos-marketplace-curseforge/",
  "https://example.supabase.co/anxos-marketplace-curseforge/api/v1/marketplace/curseforge/api",
  "function-slug base URL with trailing slash",
);

// Bare localhost origins (used by other smoke tests' mock servers) must keep working with no
// spurious leading path segment.
check(
  "http://127.0.0.1:54321",
  "http://127.0.0.1:54321/api/v1/marketplace/curseforge/api",
  "bare localhost origin, no trailing slash",
);
check(
  "http://127.0.0.1:54321/",
  "http://127.0.0.1:54321/api/v1/marketplace/curseforge/api",
  "bare localhost origin, trailing slash",
);

// A real production HTTPS URL matching the deployed AnxOS Supabase project.
check(
  "https://arqfbxstobusuamlizyq.functions.supabase.co/anxos-marketplace-curseforge",
  "https://arqfbxstobusuamlizyq.functions.supabase.co/anxos-marketplace-curseforge/api/v1/marketplace/curseforge/api",
  "real deployed production URL",
);

// Any pre-existing query string on the configured base URL must be dropped, not merged, to
// avoid ambiguous precedence with query params the caller sets afterward.
{
  const endpoint = _test.buildHostedProxyEndpoint("https://example.supabase.co/anxos-marketplace-curseforge?ignored=1", "/api/v1/marketplace/curseforge/api");
  assert.strictEqual(endpoint.search, "", "Pre-existing query params on the base URL must be discarded.");
  assert.strictEqual(String(endpoint), "https://example.supabase.co/anxos-marketplace-curseforge/api/v1/marketplace/curseforge/api");
}

// The download sub-path must resolve the same way as the JSON API sub-path.
{
  const endpoint = String(_test.buildHostedProxyEndpoint("https://example.supabase.co/anxos-marketplace-curseforge", "/api/v1/marketplace/curseforge/download"));
  assert.strictEqual(endpoint, "https://example.supabase.co/anxos-marketplace-curseforge/api/v1/marketplace/curseforge/download");
}

console.log("CurseForge hosted-proxy endpoint path-preservation smoke checks passed.");
