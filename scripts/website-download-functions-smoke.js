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
for (const route of ["windows", "windows-portable", "linux-appimage", "linux-deb"]) {
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
console.log("website download function smoke: PASS");
