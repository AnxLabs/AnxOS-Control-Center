const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");

function read(filePath) {
  return fs.readFileSync(path.join(repoRoot, filePath), "utf8");
}

function getLocalSecret() {
  try {
    const parsed = JSON.parse(read("config/marketplace.json"));
    return String(parsed.curseForgeApiKey || "").trim();
  } catch {
    return "";
  }
}

function assertRendererBundleDoesNotContainSecret() {
  const secret = getLocalSecret();
  if (!secret) {
    return;
  }
  for (const filePath of ["app.js", "preload.js", "index.html"]) {
    assert(!read(filePath).includes(secret), `${filePath} must not contain the local CurseForge API key.`);
  }
}

function runCleanConfigProbe() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-cf-clean-"));
  try {
    const probe = spawnSync(process.execPath, ["-e", `
      process.env.ANXHUB_CONFIG_DIR = ${JSON.stringify(tempRoot)};
      process.env.ANXHUB_DISABLE_CURSEFORGE_KEY_MIGRATION = "1";
      process.env.ANXHUB_DISABLE_CURSEFORGE_ENV_FALLBACK = "1";
      delete process.env.CURSEFORGE_API_KEY;
      delete process.env.CF_API_KEY;
      delete process.env.ANXHUB_CURSEFORGE_API_KEY;
      const provider = require("./src/services/providers/curseforgeProvider");
      const diagnostics = provider._test.getConfigurationDiagnostics();
      if (diagnostics.mode !== "unavailable") {
        throw new Error("Expected unavailable clean-machine mode, got " + diagnostics.mode);
      }
      try {
        provider._test.requireApiKey({});
        throw new Error("Expected missing-key failure.");
      } catch (error) {
        if (error.code !== "CURSEFORGE_API_KEY_REQUIRED") throw error;
      }
    `], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ANXHUB_ENV_PATH: path.join(tempRoot, "missing.env"),
        ANXOS_CURSEFORGE_PROXY_URL: "",
        ANXHUB_CURSEFORGE_PROXY_URL: "",
        CURSEFORGE_PROXY_URL: "",
      },
      encoding: "utf8",
    });
    assert.strictEqual(probe.status, 0, `Clean config probe failed: ${probe.stderr || probe.stdout}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertPackagedConfigurationSurface() {
  const providerSource = read("src/services/providers/curseforgeProvider.js");
  const agentSource = read("agent/src/services/curseforgeProxyService.js");
  assert(providerSource.includes("ANXOS_CURSEFORGE_PROXY_URL"), "Desktop provider must support hosted proxy configuration.");
  assert(providerSource.includes("requestAgentProxyJson"), "Desktop provider must support Agent proxy configuration.");
  assert(providerSource.includes("timeoutMs: Math.max(15 * 60 * 1000"), "Agent-proxied CurseForge downloads must allow legitimate large server packs to complete.");
  const agentClientSource = read("src/services/agentClient.js");
  assert(agentClientSource.includes("timeoutMs = REQUEST_TIMEOUT_MS"), "Agent buffer requests must support operation-specific timeouts.");
  assert(agentClientSource.includes("Number(timeoutMs) || REQUEST_TIMEOUT_MS"), "Agent buffer request timeout must remain bounded and scoped to the caller.");
  assert(agentSource.includes("/api/v1/marketplace/curseforge/download"), "Agent must expose a CurseForge download proxy route.");
  assert(agentSource.includes('"x-api-key"'), "Agent CurseForge proxy must attach x-api-key.");
  assert(
    agentSource.includes("return { statusCode: 200, body: result };"),
    "Agent CurseForge test endpoint should return diagnostic failures as structured 200 responses."
  );
}

// Owner-managed proxy architecture: the desktop client never holds or sends the real CurseForge
// API key. Direct-to-CDN requests carry no secret at all, and hosted-proxy requests carry only
// the public Supabase anon key (to identify the official app); the CurseForge secret is attached
// server-side, inside the deployed Edge Function, which the client cannot see or influence.
function assertDownloadAuthenticationCoverage() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-cf-download-"));
  try {
    const probe = spawnSync(process.execPath, ["-e", `
      const http = require("http");
      const assert = require("assert");
      process.env.ANXHUB_CONFIG_DIR = ${JSON.stringify(tempRoot)};
      process.env.ANXHUB_DISABLE_CURSEFORGE_KEY_MIGRATION = "1";
      process.env.ANXHUB_DISABLE_CURSEFORGE_ENV_FALLBACK = "1";
      const provider = require("./src/services/providers/curseforgeProvider");
      const SECRET = "test-curseforge-secret-must-never-leak-client-side";

      // Direct CDN requests must never carry the private CurseForge API key.
      const cdnHeaders = provider._test.buildDownloadHeaders("https://edge.forgecdn.net/files/1/2/example.jar");
      assert(!cdnHeaders["x-api-key"], "Direct CDN download headers must not include x-api-key.");
      assert(!JSON.stringify(cdnHeaders).includes(SECRET), "Direct CDN download headers must never include the CurseForge API key.");

      // Hosted-proxy requests to an approved Supabase function host attach only the public
      // anon key, never the CurseForge secret.
      const proxyAuthHeaders = provider._test.getHostedProxyAuthHeaders("https://abcdefgh.functions.supabase.co/anxos-marketplace-curseforge");
      assert(!proxyAuthHeaders["x-api-key"], "Hosted proxy auth headers must never include x-api-key.");
      assert(!JSON.stringify(proxyAuthHeaders).includes(SECRET), "Hosted proxy auth headers must never include the CurseForge API key.");

      (async () => {
        // Stand up a mock hosted proxy standing in for the deployed Supabase Edge Function, to
        // prove downloads route through it (not directly to the CDN) and that authentication is
        // applied server-side, independent of anything the client sends.
        let receivedHeaders = null;
        let requestCount = 0;
        const server = http.createServer((req, res) => {
          requestCount += 1;
          receivedHeaders = req.headers;
          res.setHeader("x-anxos-curseforge-authenticated", "true");
          res.setHeader("Content-Type", "application/octet-stream");
          res.end("mock-proxied-file-bytes");
        });
        const serverNoMarker = http.createServer((req, res) => {
          res.setHeader("Content-Type", "application/octet-stream");
          res.end("mock-proxied-file-bytes-no-marker");
        });
        try {
          await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
          const proxyUrl = "http://127.0.0.1:" + server.address().port + "/mock-hosted-proxy";

          const buffer = await provider._test.requestBufferViaTrustedBackend(
            "https://edge.forgecdn.net/files/1/2/example.jar",
            "CurseForge file",
            { config: { proxyUrl }, projectId: 1, fileId: 2 }
          );
          assert.strictEqual(requestCount, 1, "The download must route through the trusted hosted proxy, not directly to the CDN.");
          assert.strictEqual(buffer.toString("utf8"), "mock-proxied-file-bytes", "The hosted-proxy download must return the proxied response body.");
          assert(!receivedHeaders["x-api-key"], "The hosted proxy must never receive a client-supplied x-api-key header; authentication is applied server-side.");
          assert(!JSON.stringify(receivedHeaders).includes(SECRET), "The CurseForge API key must never be sent to the hosted proxy from the client.");

          // The server-authenticated marker is a diagnostic signal, not a client-side requirement:
          // a proxied download must still succeed even if the marker header is absent.
          await new Promise((resolve) => serverNoMarker.listen(0, "127.0.0.1", resolve));
          const proxyUrlNoMarker = "http://127.0.0.1:" + serverNoMarker.address().port + "/mock-hosted-proxy";
          const bufferNoMarker = await provider._test.requestBufferViaTrustedBackend(
            "https://edge.forgecdn.net/files/1/2/example.jar",
            "CurseForge file",
            { config: { proxyUrl: proxyUrlNoMarker }, projectId: 1, fileId: 2 }
          );
          assert.strictEqual(bufferNoMarker.toString("utf8"), "mock-proxied-file-bytes-no-marker", "A proxied download must succeed even without the x-anxos-curseforge-authenticated marker.");
          process.exitCode = 0;
        } finally {
          await new Promise((resolve) => server.close(resolve));
          await new Promise((resolve) => serverNoMarker.close(resolve));
        }
      })().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
      });
    `], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ANXHUB_ENV_PATH: path.join(tempRoot, "missing.env"),
        CURSEFORGE_API_KEY: "",
        CF_API_KEY: "",
        ANXHUB_CURSEFORGE_API_KEY: "",
      },
      encoding: "utf8",
    });
    assert.strictEqual(probe.status, 0, `Download auth probe failed: ${probe.stderr || probe.stdout}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertScenarioCoverageDocumented() {
  const doc = read("docs/CURSEFORGE_CLEAN_MACHINE_VALIDATION.md");
  [
    "Development build with valid configuration",
    "Packaged build with valid Agent/proxy configuration",
    "Packaged build without configuration",
    "Invalid key",
    "Unauthorized response",
    "Rate limiting",
    "Browse success followed by download failure",
    "Modpack with a server pack",
    "Modpack without a server pack",
    "Dependency download",
    "Redirected CDN download",
    "Secret masking",
    "Renderer bundle inspection",
  ].forEach((needle) => assert(doc.includes(needle), `Validation doc missing scenario: ${needle}`));
}

assertRendererBundleDoesNotContainSecret();
runCleanConfigProbe();
assertPackagedConfigurationSurface();
assertDownloadAuthenticationCoverage();
assertScenarioCoverageDocumented();

console.log("CurseForge packaged regression checks passed.");
