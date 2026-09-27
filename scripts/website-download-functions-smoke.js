const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "website", "functions", "api", "download", "latest", "[platform].js"), "utf8");
const worker = fs.readFileSync(path.join(__dirname, "..", "website", "_worker.js"), "utf8");
const releaseWorkflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "windows-release.yml"), "utf8");
const canonicalRepository = "AnxLabs/AnxOS-Control-Center-Releases";
const sourceRepository = "AnxLabs/AnxOS-Control-Center";
const workflowReleaseTargets = [...releaseWorkflow.matchAll(/^\s*ANXOS_RELEASE_REPOSITORY:\s*(\S+)\s*$/gm)].map((match) => match[1]);
const binaryPublishStart = releaseWorkflow.indexOf("- name: Publish tagged release");
const binaryPublishEnd = releaseWorkflow.indexOf("- name: Publish source-repository release pointer", binaryPublishStart);
const binaryPublishBlock = releaseWorkflow.slice(binaryPublishStart, binaryPublishEnd);
for (const route of ["windows", "windows-portable", "linux-appimage", "linux-deb", "linux-agent-deb"]) {
  assert(new RegExp(`(?:^|[\\s"'])${route}(?:["'\\s:]|$)`).test(source), `Function must define ${route} asset routing.`);
}
assert(source.includes("status: 302") && source.includes("location: asset.browser_download_url"), "Routes must return redirects to the verified release asset.");
assert(source.includes("ANXOS_RELEASE_REPOSITORY") && source.includes("ANXOS_GITHUB_REPOSITORY"), "Repository configuration must support the documented environment variables.");
assert(source.includes(canonicalRepository) && worker.includes(canonicalRepository), "Every serverless download route must use the canonical release-only repository.");
assert(!source.includes("github.com/[^/]+/[^/]+") && !worker.includes("github.com/[^/]+/[^/]+"), "Serverless routes must not use a generic GitHub repository asset allowlist.");
assert(!source.includes("bungopam-byte/AnxOS-Control-Center-Releases") && !worker.includes("bungopam-byte/AnxOS-Control-Center-Releases"), "The legacy owner must not remain a serverless routing default.");
assert(releaseWorkflow.includes(`ANXOS_RELEASE_REPOSITORY: ${canonicalRepository}`), "The Windows release workflow must publish binaries only to the canonical release repository.");
assert(!releaseWorkflow.includes("bungopam-byte/AnxOS-Control-Center-Releases"), "The Windows release workflow must not regress to the obsolete release owner.");
assert(workflowReleaseTargets.length > 0 && workflowReleaseTargets.every((target) => target === canonicalRepository), "Every Windows binary release target must be the exact canonical release repository.");
assert(!workflowReleaseTargets.includes(sourceRepository), "The source repository must never become the Windows binary release target.");
assert(binaryPublishStart >= 0 && binaryPublishEnd > binaryPublishStart, "The binary publish workflow block must remain identifiable.");
assert(!binaryPublishBlock.includes("--clobber"), "The Windows release workflow must never overwrite an existing release asset.");
assert(binaryPublishBlock.includes("refusing to replace immutable release assets") && binaryPublishBlock.includes("exit 1"), "An existing binary release must fail closed before publication.");
assert(!binaryPublishBlock.includes("gh release edit") && !binaryPublishBlock.includes("gh release upload"), "The immutable binary release path must not edit metadata or upload into an existing release.");
assert(!source.includes("index.html") && !source.includes("text/html"), "API functions must not use the SPA fallback.");
assert(worker.includes("env.ASSETS.fetch(request)") && worker.includes("api\\/download\\/latest"), "Pages worker must route API requests before static assets.");
function extractMatchers(fileSource, variableName, label) {
  const declaration = `const ${variableName} = {`;
  const start = fileSource.indexOf(declaration);
  assert(start >= 0, `${label} must declare ${variableName}.`);
  const open = start + declaration.length - 1;
  let depth = 0;
  let close = -1;
  for (let index = open; index < fileSource.length; index += 1) {
    if (fileSource[index] === "{") depth += 1;
    if (fileSource[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  assert(close > open, `${label} matcher object must be balanced.`);
  const literal = fileSource.slice(open, close + 1);
  const matchers = new Function(`"use strict"; return ${literal};`)();
  assert(matchers && typeof matchers === "object", `${label} matchers must evaluate to an object.`);
  return { matchers, literal };
}

const functionMatchers = extractMatchers(source, "PLATFORM_ASSETS", "Page Function");
const workerMatchers = extractMatchers(worker, "ASSET_MATCHERS", "Pages worker");
assert.strictEqual(
  functionMatchers.literal.replace(/\s+/g, " "),
  workerMatchers.literal.replace(/\s+/g, " "),
  "Both serverless implementations must keep identical matcher definitions."
);
assert(/unsupported_platform"\s*\}\s*,\s*404/.test(source) && /unsupported_platform"\s*\}\s*,\s*404/.test(worker), "Unsupported slugs must keep returning the unsupported_platform 404 JSON.");

// Real release asset order (v2.0-build205-rc3, per the GitHub release expanded assets).
const releaseAssetOrder = [
  "AnxOS-Agent-2.0-build205.deb",
  "AnxOS-Agent-2.0-build205.deb.sha256",
  "AnxOS-Control-Center-2.0-build205-portable.exe",
  "AnxOS-Control-Center-2.0-build205.AppImage",
  "AnxOS-Control-Center-2.0-build205.deb",
  "AnxOS-Control-Center-Setup-2.0-build205.exe",
  "AnxOS-Control-Center-Setup-2.0-build205.exe.blockmap",
  "latest-linux.yml",
  "latest.yml",
  "rc-validate.log",
  "SHA256SUMS",
  "update-manifest.json",
];
const firstMatch = (matchers, slug, names) => names.find((name) => matchers[slug] && matchers[slug](name)) || null;

for (const [label, matchers] of [["Page Function", functionMatchers.matchers], ["Pages worker", workerMatchers.matchers]]) {
  assert.deepStrictEqual(Object.keys(matchers).sort(), ["linux-agent-deb", "linux-appimage", "linux-deb", "windows", "windows-portable"], `${label} must route exactly the supported platform slugs.`);
  assert.strictEqual(firstMatch(matchers, "linux-deb", releaseAssetOrder), "AnxOS-Control-Center-2.0-build205.deb", `${label} linux-deb must select the Control Center desktop .deb in real release order.`);
  assert.strictEqual(firstMatch(matchers, "linux-agent-deb", releaseAssetOrder), "AnxOS-Agent-2.0-build205.deb", `${label} linux-agent-deb must select the Agent .deb in real release order.`);
  assert.strictEqual(firstMatch(matchers, "windows", releaseAssetOrder), "AnxOS-Control-Center-Setup-2.0-build205.exe", `${label} windows must select the Setup executable.`);
  assert.strictEqual(firstMatch(matchers, "windows-portable", releaseAssetOrder), "AnxOS-Control-Center-2.0-build205-portable.exe", `${label} windows-portable must select the portable executable.`);
  assert.strictEqual(firstMatch(matchers, "linux-appimage", releaseAssetOrder), "AnxOS-Control-Center-2.0-build205.AppImage", `${label} linux-appimage must select the AppImage.`);
  assert.strictEqual(matchers.nonsense, undefined, `${label} must not route unsupported slugs.`);
  assert.strictEqual(matchers["linux-deb"]("AnxOS-Agent-2.0-build205.deb"), false, `${label} linux-deb must never match the Agent .deb.`);
  assert.strictEqual(matchers["linux-agent-deb"]("AnxOS-Control-Center-2.0-build205.deb"), false, `${label} linux-agent-deb must never match the Control Center .deb.`);
  assert.strictEqual(matchers["linux-deb"]("AnxOS-Agent-2.0-build205.deb.sha256"), false, `${label} linux-deb must not match .deb checksum files.`);
  assert.strictEqual(matchers["linux-agent-deb"]("AnxOS-Agent-2.0-build205.deb.sha256"), false, `${label} linux-agent-deb must not match .deb checksum files.`);
  assert.strictEqual(matchers.windows("AnxOS-Control-Center-2.0-build205-portable.exe"), false, `${label} windows must not match the portable build.`);
  assert.strictEqual(matchers["windows-portable"]("AnxOS-Control-Center-Setup-2.0-build205.exe"), false, `${label} windows-portable must not match the Setup build.`);
  assert.strictEqual(matchers["linux-appimage"]("AnxOS-Control-Center-2.0-build205.deb"), false, `${label} linux-appimage must not match .deb assets.`);
}
console.log("website download function smoke: PASS");
