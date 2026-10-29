#!/usr/bin/env node
"use strict";

// Marketplace browsing: every card on a search page resolves its installable
// version. CurseForge goes through the hosted proxy (90 requests a minute per
// IP) and Modrinth downloads the pack's whole version list. Re-resolving all
// 24 cards on every visit made browsing slow and CurseForge soon
// CURSEFORGE_RATE_LIMITED. Card selections are now cached for a while per
// provider, shared while in flight, never cached when they fail, and resolved
// with a bounded fan-out. Every provider call is stubbed; nothing goes online.
// Run: node scripts/marketplace-card-cache-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-cf-card-cache-"));
process.env.ANXHUB_CONFIG_DIR = root;
const jobLifecycle = require("../src/shared/instances/jobLifecycle");
jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(root, "jobs") });

const curseforgeProvider = require("../src/services/providers/curseforgeProvider");
const modrinthProvider = require("../src/services/providers/modrinthProvider");
const marketplace = require("../src/services/marketplaceInstallService");

const originalModrinthResolveVersion = modrinthProvider.resolveVersion;

const page = (count) => ({ results: Array.from({ length: count }, (_, index) => ({ providerProjectId: String(1000 + index), name: `Pack ${index}` })) });
// Client pack file advertising its dedicated server pack (id + 1).
const file = (projectId, id = Number(projectId) * 10) => ({ id, projectId: Number(projectId), fileName: `pack-${projectId}-${id}.zip`, minecraftVersions: ["1.20.1"], loaders: ["forge"], releaseType: 1, serverPackFileId: Number(projectId) * 10 + 1 });

async function main() {
  const original = { getMod: curseforgeProvider.getMod, resolveFile: curseforgeProvider.resolveFile, getFile: curseforgeProvider.getFile };
  const calls = { resolveFile: 0 };
  let inFlight = 0;
  let peak = 0;
  let failProject = null;
  curseforgeProvider.getMod = async (projectId) => ({ id: Number(projectId), name: `Pack ${projectId}` });
  curseforgeProvider.resolveFile = async (projectId) => {
    calls.resolveFile += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (String(projectId) === failProject) throw Object.assign(new Error("rate limited"), { code: "CURSEFORGE_RATE_LIMITED" });
    return file(projectId);
  };
  curseforgeProvider.getFile = async (projectId, fileId) => file(projectId, Number(fileId));
  try {
    marketplace._test.clearMarketplaceCardSelectionCache();
    const payload = { minecraftVersion: "1.20.1", loader: "forge" };

    // C1: a page resolves every card once, never more than the bound at a time.
    let result = await marketplace._test.enrichCurseForgeSearchResults(page(24), payload, {});
    assert.strictEqual(result.results.length, 24);
    assert.strictEqual(calls.resolveFile, 24, "one lookup per card on the first visit");
    assert.ok(peak <= marketplace._test.CURSEFORGE_ENRICH_CONCURRENCY_LIMIT, `at most ${marketplace._test.CURSEFORGE_ENRICH_CONCURRENCY_LIMIT} lookups at once (peak ${peak})`);
    assert.ok(result.results.every((card) => card.serverCompatibility?.state !== "unknown"), "cards resolve normally");
    console.log(`PASS C1 a page of 24 cards resolves each once with at most ${peak} lookups in flight`);

    // C2: revisiting the page reuses the resolved cards.
    result = await marketplace._test.enrichCurseForgeSearchResults(page(24), payload, {});
    assert.strictEqual(calls.resolveFile, 24, "revisiting the page makes no new proxy lookups");
    console.log("PASS C2 revisiting a page makes no new CurseForge lookups");

    // C3: a different filter is a different selection.
    await marketplace._test.enrichCurseForgeSearchResults(page(2), { minecraftVersion: "1.21.1", loader: "neoforge" }, {});
    assert.strictEqual(calls.resolveFile, 26, "another Minecraft version or loader is resolved on its own");
    console.log("PASS C3 a different version or loader is resolved separately");

    // C4: failures are not cached; the next visit retries that card.
    marketplace._test.clearMarketplaceCardSelectionCache();
    calls.resolveFile = 0;
    failProject = "1000";
    result = await marketplace._test.enrichCurseForgeSearchResults(page(1), payload, {});
    assert.strictEqual(result.results[0].serverCompatibility.state, "unknown", "a failed card shows Compatibility Unknown");
    failProject = null;
    result = await marketplace._test.enrichCurseForgeSearchResults(page(1), payload, {});
    assert.strictEqual(calls.resolveFile, 2, "a failed lookup is retried on the next visit");
    assert.notStrictEqual(result.results[0].serverCompatibility?.state, "unknown", "and the card resolves once the proxy answers");
    console.log("PASS C4 a failed card lookup is not cached and is retried");

    // M1: Modrinth cards are resolved once per page and reused on revisit.
    marketplace._test.clearMarketplaceCardSelectionCache();
    let modrinthCalls = 0;
    modrinthProvider.resolveVersion = async (projectId) => {
      modrinthCalls += 1;
      return { id: `v-${projectId}`, projectId, minecraftVersions: ["1.20.1"], loaders: ["fabric"], versionType: "release", files: [] };
    };
    const modrinthPage = page(24);
    await marketplace._test.enrichModrinthSearchResults(modrinthPage, { minecraftVersion: "1.20.1", loader: "fabric" });
    assert.strictEqual(modrinthCalls, 24, "one version lookup per Modrinth card on the first visit");
    await marketplace._test.enrichModrinthSearchResults(modrinthPage, { minecraftVersion: "1.20.1", loader: "fabric" });
    assert.strictEqual(modrinthCalls, 24, "revisiting a Modrinth page makes no new version lookups");
    console.log("PASS M1 Modrinth cards are resolved once and reused on revisit");

    // M2: the providers never share entries for the same project id.
    await marketplace._test.enrichCurseForgeSearchResults(page(1), payload, {});
    const curseForgeAfter = calls.resolveFile;
    await marketplace._test.enrichModrinthSearchResults(page(1), payload);
    assert.strictEqual(modrinthCalls, 25, "a Modrinth card is not served from a CurseForge entry with the same id");
    assert.strictEqual(calls.resolveFile, curseForgeAfter);
    console.log("PASS M2 CurseForge and Modrinth cards are cached separately");
  } finally {
    Object.assign(curseforgeProvider, original);
    modrinthProvider.resolveVersion = originalModrinthResolveVersion;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log("marketplace card cache smoke passed (6 checks).");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
