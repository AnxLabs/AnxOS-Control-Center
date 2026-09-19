const assert = require("assert");

// V2-D publisher-trust smoke (roadmap V2-D bullets 7-8;
// docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md §3 item 5; the gap recorded in
// docs/KNOWN_LIMITATIONS.md "Two V2-D roadmap items remain missing").
//
// Hermetic: no network, no agent, no electron. The pure policy is exercised
// directly, and the two real integration points are exercised through the
// services' _test seams over the shipped catalog / a real provider selection
// shape, so the verdicts asserted here are the verdicts production computes.

const {
  TRUST_CODES,
  TRUST_MESSAGES,
  TRUST_VERDICTS,
  classifyPublisher,
  describeTrustVerdict,
  evaluatePublisherTrust,
  isExecutableEntry,
  normalizeIntegrityHash,
  resolveIntegrity,
} = require("../src/shared/publisherTrustPolicy");
const marketplaceService = require("../src/services/marketplaceService");
const marketplaceInstallService = require("../src/services/marketplaceInstallService");

const SHA256 = "sha256:" + "a".repeat(64);
const SHA256_OTHER = "sha256:" + "b".repeat(64);
const SHA512 = "sha512:" + "c".repeat(128);
const VALID_ATTESTATION = { scheme: "cosign", signer: "anxos-release@example", verified: true };

function evaluate(entry, facts) {
  return evaluatePublisherTrust(entry, facts);
}

// ---------------------------------------------------------------------------
// 1. The verdict table is exactly the contracted set, and every verdict is
//    reachable. A policy that answered one value for everything could not pass.
// ---------------------------------------------------------------------------
assert.deepStrictEqual(
  { ...TRUST_VERDICTS },
  {
    VERIFIED: "verified",
    UNVERIFIED_PUBLISHER: "unverified-publisher",
    UNSIGNED_EXECUTABLE: "unsigned-executable",
    HASH_MISMATCH: "hash-mismatch",
    UNKNOWN: "unknown",
  },
  "The trust verdict vocabulary must be exactly the contracted five.",
);
assert.deepStrictEqual(
  Object.values(TRUST_MESSAGES).map((message) => message.title),
  ["Verified publisher", "Unverified publisher", "Unsigned executable content", "Integrity check failed", "Publisher trust unknown"],
  "Every verdict must have operator-facing copy.",
);

// verified — first-party publisher AND an established integrity match.
const firstPartyVerified = evaluate(
  { id: "paper", kind: "template", provenance: { source: "anxos-catalog" }, checksum: SHA256 },
  { computedHash: SHA256, executable: true },
);
assert.strictEqual(firstPartyVerified.verdict, TRUST_VERDICTS.VERIFIED, "First-party + matching hash must be verified.");
assert.strictEqual(firstPartyVerified.code, TRUST_CODES.VERIFIED_FIRST_PARTY);
assert.strictEqual(firstPartyVerified.verified, true);
assert.strictEqual(firstPartyVerified.integrity.established, true);
assert.strictEqual(firstPartyVerified.allowInstall, true);
assert.strictEqual(firstPartyVerified.severity, "ok");

// verified — a signed/attested third-party source with an established match.
const signedVerified = evaluate(
  { id: "community-pack", kind: "pack", provider: "modrinth", author: "Some Author" },
  { computedHash: SHA256, declaredHash: SHA256, executable: true, attestation: VALID_ATTESTATION },
);
assert.strictEqual(signedVerified.verdict, TRUST_VERDICTS.VERIFIED, "A verified attestation + matching hash must be verified.");
assert.strictEqual(signedVerified.code, TRUST_CODES.VERIFIED_SIGNED);
assert.strictEqual(signedVerified.publisherKind, "signed");

// unverified-publisher — an identifiable third-party publisher.
const thirdParty = evaluate({ id: "sodium", kind: "pack", provider: "modrinth" }, { executable: true, computedHash: SHA512, declaredHash: SHA512 });
assert.strictEqual(thirdParty.verdict, TRUST_VERDICTS.UNVERIFIED_PUBLISHER, "A third-party publisher must be named as unverified.");
assert.strictEqual(thirdParty.code, TRUST_CODES.UNVERIFIED_PUBLISHER);
assert.strictEqual(thirdParty.verified, false, "An integrity match must NOT promote a third-party publisher to verified.");
assert.strictEqual(thirdParty.requiresReview, true);

// unsigned-executable — trusted publisher, executable content, no integrity.
const unsigned = evaluate({ id: "minecraft-vanilla", kind: "template", provenance: { source: "anxos-catalog" } }, { executable: true });
assert.strictEqual(unsigned.verdict, TRUST_VERDICTS.UNSIGNED_EXECUTABLE, "First-party executable content with no hash must be unsigned-executable.");
assert.strictEqual(unsigned.code, TRUST_CODES.UNSIGNED_EXECUTABLE);
assert.strictEqual(unsigned.verified, false);

// hash-mismatch — a declared/computed disagreement always wins.
const mismatch = evaluate(
  { id: "tampered", kind: "pack", provider: "modrinth", checksum: SHA256 },
  { computedHash: SHA256_OTHER, executable: true, attestation: VALID_ATTESTATION },
);
assert.strictEqual(mismatch.verdict, TRUST_VERDICTS.HASH_MISMATCH, "A hash disagreement must beat every other fact.");
assert.strictEqual(mismatch.code, TRUST_CODES.HASH_MISMATCH);
assert.strictEqual(mismatch.verified, false);
assert.strictEqual(mismatch.allowInstall, false, "A hash mismatch must recommend against installation.");
assert.strictEqual(mismatch.severity, "critical");

// unknown — nothing to evaluate.
const nothing = evaluate({ id: "mystery" }, {});
assert.strictEqual(nothing.verdict, TRUST_VERDICTS.UNKNOWN, "No publisher and no integrity facts must stay unknown.");
assert.strictEqual(nothing.code, TRUST_CODES.UNKNOWN);
assert.strictEqual(nothing.verified, false);
const emptyEntry = evaluate({}, {});
assert.strictEqual(emptyEntry.verdict, TRUST_VERDICTS.UNKNOWN, "An empty entry must stay unknown, never verified.");

const reachable = new Set([
  firstPartyVerified.verdict,
  signedVerified.verdict,
  thirdParty.verdict,
  unsigned.verdict,
  mismatch.verdict,
  nothing.verdict,
]);
assert.strictEqual(reachable.size, 5, "All five verdicts must be reachable from this suite.");

// ---------------------------------------------------------------------------
// 2. FAIL CLOSED. An entry whose integrity cannot be established is never
//    verified, however trusted its publisher is.
// ---------------------------------------------------------------------------
const firstPartyNoFacts = evaluate({ id: "a", kind: "template", provenance: { source: "anxos-catalog" } }, { executable: true });
assert.notStrictEqual(firstPartyNoFacts.verdict, TRUST_VERDICTS.VERIFIED, "No integrity facts at all must never be verified.");
assert.strictEqual(firstPartyNoFacts.integrity.reasonCode, "INTEGRITY_FACTS_INCOMPLETE");

const declaredOnly = evaluate(
  { id: "b", kind: "template", provenance: { source: "anxos-catalog" }, checksum: SHA256 },
  { executable: true },
);
assert.notStrictEqual(declaredOnly.verdict, TRUST_VERDICTS.VERIFIED, "A declared hash with nothing to compare it to must never be verified.");
assert.strictEqual(declaredOnly.integrity.established, false);
assert.strictEqual(declaredOnly.integrity.comparable, false);

const computedOnly = evaluate(
  { id: "c", kind: "template", provenance: { source: "anxos-catalog" } },
  { computedHash: SHA256, executable: true },
);
assert.notStrictEqual(computedOnly.verdict, TRUST_VERDICTS.VERIFIED, "A computed hash without a declaration must never be verified.");

const crossAlgorithm = evaluate(
  { id: "d", kind: "template", provenance: { source: "anxos-catalog" }, checksum: SHA256 },
  { computedHash: SHA512, executable: true },
);
assert.notStrictEqual(crossAlgorithm.verdict, TRUST_VERDICTS.VERIFIED, "A cross-algorithm pair must never be treated as a match.");
assert.strictEqual(crossAlgorithm.integrity.reasonCode, "INTEGRITY_ALGORITHM_MISMATCH");
assert.notStrictEqual(crossAlgorithm.verdict, TRUST_VERDICTS.HASH_MISMATCH, "Differing algorithms are incomparable, not a proven mismatch.");

const signedNoHash = evaluate({ id: "e", kind: "pack" }, { executable: true, attestation: VALID_ATTESTATION });
assert.notStrictEqual(signedNoHash.verdict, TRUST_VERDICTS.VERIFIED, "Even an attested publisher needs an established integrity match.");

const unverifiedClaim = evaluate({ id: "f", kind: "pack" }, { executable: true, attestation: { scheme: "cosign", signer: "x", verified: false } });
assert.strictEqual(unverifiedClaim.publisherKind, "none", "An unverified attestation must not count as a publisher identity.");
const unknownScheme = evaluate({ id: "g", kind: "pack" }, { executable: true, attestation: { scheme: "made-up", signer: "x", verified: true } });
assert.strictEqual(unknownScheme.publisherKind, "none", "An unknown attestation scheme must not count as a publisher identity.");
const emptySigner = evaluate({ id: "h", kind: "pack" }, { executable: true, attestation: { scheme: "cosign", signer: "", verified: true } });
assert.strictEqual(emptySigner.publisherKind, "none", "An attestation with no signer must not count.");

const selfDeclaredHashNoPublisher = evaluate({ id: "i", kind: "pack", checksum: SHA256 }, { computedHash: SHA256, executable: true });
assert.strictEqual(selfDeclaredHashNoPublisher.verdict, TRUST_VERDICTS.UNVERIFIED_PUBLISHER, "A self-declared matching hash with no publisher identity must not be verified.");

// `anxhub` is a local-session/default-provider name, not a signing identity.
const anxhub = evaluate({ id: "j", kind: "pack", provider: "anxhub" }, { executable: true });
assert.strictEqual(anxhub.publisherKind, "third-party", "anxhub must not be silently promoted to a first-party publisher.");
assert.strictEqual(anxhub.verified, false);

// Positive control: the policy is not a blanket rejecter.
assert(firstPartyVerified.verified === true, "POSITIVE CONTROL: at least one input must reach verified.");
assert(firstPartyVerified.allowInstall === true, "POSITIVE CONTROL: at least one input must be install-allowed.");
assert(TRUST_MESSAGES[TRUST_VERDICTS.VERIFIED].severity === "ok", "POSITIVE CONTROL: verified must not be a warning.");

// ---------------------------------------------------------------------------
// 3. Helpers.
// ---------------------------------------------------------------------------
assert.deepStrictEqual(normalizeIntegrityHash("SHA256:" + "A".repeat(64)), { algorithm: "sha256", value: "a".repeat(64) }, "A prefixed hash must normalize case-insensitively.");
assert.deepStrictEqual(normalizeIntegrityHash("a".repeat(64)), { algorithm: "sha256", value: "a".repeat(64) }, "A bare 64-hex string is a sha256.");
assert.deepStrictEqual(normalizeIntegrityHash({ algorithm: "sha512", value: "C".repeat(128) }), { algorithm: "sha512", value: "c".repeat(128) });
assert.strictEqual(normalizeIntegrityHash(null), null);
assert.strictEqual(normalizeIntegrityHash("not-a-hash"), null);
assert.strictEqual(normalizeIntegrityHash("sha256:zzzz"), null, "Non-hex content is not a hash.");
assert.strictEqual(normalizeIntegrityHash("a".repeat(40)), null, "A bare sha1-length string is ambiguous and must be refused, not guessed.");
assert.strictEqual(resolveIntegrity({ checksum: SHA256 }, { computedHash: SHA256 }).reasonCode, "INTEGRITY_MATCH");
assert.strictEqual(evaluatePublisherTrust({ id: "x", provider: "anxos" }, {}).publisherKind, "first-party");

assert.strictEqual(isExecutableEntry({ installerType: "direct-download" }), true);
assert.strictEqual(isExecutableEntry({ installerType: "no-install" }), false);
assert.strictEqual(isExecutableEntry({ runtime: "docker" }), true);
assert.strictEqual(isExecutableEntry({ kind: "dependency" }), true);
assert.strictEqual(isExecutableEntry({ kind: "template", downloadSource: { type: "local-import" } }), false);
assert.strictEqual(isExecutableEntry({ kind: "template", downloadSource: { type: "direct-download" } }), true);
assert.strictEqual(isExecutableEntry({ executable: true }, { executable: false }), false, "Caller-supplied facts must override entry introspection.");

for (const verdict of Object.values(TRUST_VERDICTS)) {
  const described = describeTrustVerdict(verdict);
  assert.strictEqual(described.verdict, verdict);
  assert(described.title && described.body && described.action, `Verdict ${verdict} must have complete operator text.`);
}
assert.strictEqual(describeTrustVerdict("bogus").verdict, "bogus");
assert.strictEqual(describeTrustVerdict("bogus").title, "Publisher trust unknown", "An unknown verdict key must fall back to the unknown copy, never to a passing message.");
assert.strictEqual(describeTrustVerdict(undefined).allowInstall, true);

// Copy isolation: mutating a returned message must not corrupt the policy.
const described = describeTrustVerdict(TRUST_VERDICTS.VERIFIED);
described.title = "tampered";
assert.strictEqual(describeTrustVerdict(TRUST_VERDICTS.VERIFIED).title, "Verified publisher", "Operator copy must not be mutable through the returned object.");

// ---------------------------------------------------------------------------
// 4. REAL INTEGRATION. The verdict is computed for real entries at the two
//    marketplace install boundaries, over the facts those paths actually hold.
// ---------------------------------------------------------------------------
const catalog = marketplaceService.listTemplates();
assert(catalog.templates.length > 0, "The shipped catalog must not be empty.");
const realTemplate = catalog.templates.find((template) => template.id === "minecraft-vanilla") || catalog.templates[0];
assert.strictEqual(realTemplate.provenance.source, "anxos-catalog", "A shipped template must declare the curated provenance source.");
assert.strictEqual(realTemplate.checksum, null, "The shipped catalog declares no checksum today — the integration must not pretend otherwise.");

const realVerdict = marketplaceService._test.evaluateInstallPublisherTrust(realTemplate, { installerType: realTemplate.installerType });
assert.strictEqual(realVerdict.verdict, TRUST_VERDICTS.UNSIGNED_EXECUTABLE, `A shipped executable template with no checksum must be unsigned-executable (got ${realVerdict.verdict}).`);
assert.strictEqual(realVerdict.code, TRUST_CODES.UNSIGNED_EXECUTABLE);
assert.strictEqual(realVerdict.verified, false, "A shipped template must NOT be reported as a verified publisher today.");
assert.strictEqual(realVerdict.publisherKind, "first-party");
assert.strictEqual(realVerdict.executable, true);
assert.strictEqual(realVerdict.requiresReview, true);
assert.strictEqual(realVerdict.integrity.established, false);
assert.strictEqual(realVerdict.integrity.computed, null, "This path does not hash downloads, so no computed hash may be invented.");
assert(realVerdict.operatorMessage && realVerdict.operatorAction, "The integration verdict must carry renderable operator text.");

// Every shipped template resolves to a non-verified verdict (nothing in the
// catalog can be verified today) — the fail-closed guarantee at scale.
for (const template of catalog.templates) {
  const verdict = marketplaceService._test.evaluateInstallPublisherTrust(template, { installerType: template.installerType });
  assert.notStrictEqual(verdict.verdict, TRUST_VERDICTS.VERIFIED, `Shipped template ${template.id} must not be reported as verified.`);
  assert.strictEqual(verdict.verified, false, `Shipped template ${template.id} must not claim verified.`);
}

// Executable vs non-executable classification flows through from the catalog.
const disabledTemplate = { id: "coming-soon", provenance: { source: "anxos-catalog" }, comingSoon: true };
assert.strictEqual(marketplaceService._test.evaluateInstallPublisherTrust(disabledTemplate, { installerType: "no-install" }).verdict, TRUST_VERDICTS.UNKNOWN,
  "A non-executable first-party entry must be unknown, never verified.");

// Provider pack integration: a real provider identity is a third party.
const modrinthVerdict = marketplaceInstallService._test.evaluatePackPublisherTrust("modrinth", {
  providerProjectId: "sodium",
  modrinthSelectedVersion: { files: [{ url: "https://cdn.modrinth.com/data/x.jar", hashes: { sha1: "1".repeat(40), sha512: "2".repeat(128) } }] },
});
assert.strictEqual(modrinthVerdict.verdict, TRUST_VERDICTS.UNVERIFIED_PUBLISHER, "A Modrinth pack must be an unverified publisher.");
assert.strictEqual(modrinthVerdict.verified, false);
assert.strictEqual(modrinthVerdict.integrity.established, false, "Provider per-file hashes must not be treated as an established integrity match.");
assert.deepStrictEqual(modrinthVerdict.integrity.declared, { algorithm: "sha512", value: "2".repeat(128) }, "The provider's declared hash must be recorded as evidence.");
assert.strictEqual(modrinthVerdict.integrity.computed, null, "The pack archive is never hashed here, so the computed hash must stay null.");
assert.strictEqual(marketplaceInstallService._test.resolveProviderPackDeclaredHash("curseforge", {}), null, "CurseForge publishes no per-file hash.");
assert.strictEqual(marketplaceInstallService._test.evaluatePackPublisherTrust("curseforge", { providerProjectId: "123" }).verdict, TRUST_VERDICTS.UNVERIFIED_PUBLISHER);

// classifyPublisher is consistent with the verdicts above.
assert.strictEqual(classifyPublisher({ provider: "modrinth" }, {}).kind, "third-party");
assert.strictEqual(classifyPublisher({ provenance: { source: "anxos-catalog" } }, {}).kind, "first-party");
assert.strictEqual(classifyPublisher({ author: "AnxOS" }, {}).kind, "first-party");
assert.strictEqual(classifyPublisher({ author: "Community" }, {}).kind, "third-party");
assert.strictEqual(classifyPublisher({}, {}).kind, "none");

console.log("publisher-trust-smoke (policy) passed: 5/5 verdicts reachable, fail-closed on incomplete integrity, operator copy complete.");

// ---------------------------------------------------------------------------
// 5. REAL INSTALL-PATH INTEGRATION. Drives the production `installTemplate`
//    executor against a real curated catalog entry with the Agent stubbed out,
//    then reads the verdict back through the EXISTING Marketplace downloads
//    read path — proving the verdict is computed and persisted in production
//    code, not merely available as a pure function.
// ---------------------------------------------------------------------------
async function assertVerdictReachesInstallPath() {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const agentClient = require("../src/services/agentClient");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-publisher-trust-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
  const jobLifecycle = require("../src/shared/instances/jobLifecycle");
  jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(root, "jobs") });

  const patchedMethods = [
    "createInstance", "listInstances", "createInstanceFolder", "writeInstanceFile",
    "readInstanceFile", "updateInstance", "getInstanceStatus", "startInstance",
    "deleteInstance", "checkDependencies", "installDependencies",
  ];
  const original = {};
  patchedMethods.forEach((name) => { original[name] = agentClient[name]; });

  const instanceId = "publisher-trust-smoke";
  const instances = new Map();
  const files = new Map();
  const currentInstance = (id) => instances.get(id);

  try {
    agentClient.createInstance = async (payload) => {
      instances.set(payload.id, { ...payload, state: "Stopped", pid: null });
      return { instance: currentInstance(payload.id) };
    };
    agentClient.listInstances = async () => ({ root: "/mock/instances", instances: [...instances.values()] });
    agentClient.createInstanceFolder = async () => ({ ok: true });
    agentClient.writeInstanceFile = async (id, filePath, content) => {
      files.set(`${id}:${filePath}`, content);
      return { path: filePath, size: String(content || "").length };
    };
    agentClient.readInstanceFile = async (id, filePath) => ({ path: filePath, content: files.get(`${id}:${filePath}`) ?? "" });
    agentClient.updateInstance = async (id, patch) => {
      const next = { ...currentInstance(id), ...patch };
      instances.set(id, next);
      return { instance: next };
    };
    agentClient.getInstanceStatus = async (id) => ({ instance: currentInstance(id) });
    agentClient.startInstance = async (id) => ({ instance: currentInstance(id) });
    agentClient.deleteInstance = async () => ({ ok: true });
    agentClient.checkDependencies = async () => ({ ok: true, dependencies: [], missingDependencyIds: [] });
    agentClient.installDependencies = async () => ({ ok: true, results: [], dependencies: [], missingDependencyIds: [] });

    const result = await marketplaceService.installTemplate({
      templateId: "discord-js",
      options: { id: instanceId, name: "Publisher Trust Smoke", memory: "512M", start: false },
    });

    // The executor's own return value carries the verdict.
    assert(result.trust, "installTemplate must return the evaluated trust verdict.");
    assert.strictEqual(result.trust.verdict, TRUST_VERDICTS.UNSIGNED_EXECUTABLE, `A real curated install must report unsigned-executable, got ${result.trust.verdict}.`);
    assert.strictEqual(result.trust.verified, false, "A real curated install must not claim a verified publisher.");
    assert.strictEqual(result.trust.publisherKind, "first-party");
    assert.strictEqual(result.trust.integrity.computed, null, "The install path must not invent a computed hash.");
    assert(result.trust.operatorTitle && result.trust.operatorMessage && result.trust.operatorAction, "The install result must carry renderable operator text.");

    // The progress stream the renderer already consumes names the verdict.
    const trustStep = (result.progress || []).find((step) => step.label === "Validate publisher trust");
    assert(trustStep, "The install progress stream must report the publisher-trust step.");
    assert.match(trustStep.detail, /Unsigned executable content/, "The progress step must carry the verdict's operator copy.");

    // The verdict is persisted on the install record and readable through the
    // EXISTING Marketplace downloads surface (no new IPC channel).
    const downloads = marketplaceService.getDownloads().downloads.filter((record) => record.templateId === "discord-js");
    assert(downloads.length >= 1, "The install must be visible through the existing downloads read path.");
    const trustRecords = downloads.filter((record) => record.trustVerdict);
    assert.strictEqual(trustRecords.length, 1, "Exactly the install task record must carry the trust verdict.");
    assert.strictEqual(trustRecords[0].templateId, "discord-js");
    assert.strictEqual(trustRecords[0].stage, "Completed", "The trust verdict must ride the real install task record.");
    assert.strictEqual(trustRecords[0].trustVerdict.verdict, TRUST_VERDICTS.UNSIGNED_EXECUTABLE, "The persisted verdict must match the returned one.");
    assert.strictEqual(trustRecords[0].trustVerdict.code, TRUST_CODES.UNSIGNED_EXECUTABLE);
    assert.strictEqual(trustRecords[0].trustVerdict.requiresReview, true, "The persisted verdict must ask for review.");

    // The record does not leak the executor's AbortController into the read
    // surface (the existing sanitizer contract is preserved).
    assert.strictEqual(downloads[0].controller, undefined, "Trust integration must not break download sanitization.");

    // -----------------------------------------------------------------------
    // Provider-pack path: the verdict rides the provider install operation
    // metadata, which the SAME existing downloads read path surfaces. Driven
    // through the production operation helpers — the network install itself is
    // not executed here (that needs provider access and a live Agent), so this
    // proves the wiring and the read surface, not a live pack download.
    // -----------------------------------------------------------------------
    const packVerdict = marketplaceInstallService._test.evaluatePackPublisherTrust("modrinth", {
      providerProjectId: "sodium",
      modrinthSelectedVersion: { files: [{ url: "https://cdn.modrinth.com/data/sodium.jar", hashes: { sha512: "2".repeat(128) } }] },
    });
    assert.strictEqual(packVerdict.verdict, TRUST_VERDICTS.UNVERIFIED_PUBLISHER);
    const operation = marketplaceInstallService._test.createProviderInstallOperation(
      { providerProjectId: "sodium", name: "Trust Smoke Pack" },
      { nodeId: "publisher-trust-smoke-node", instanceId: "publisher-trust-smoke-pack" },
    );
    marketplaceInstallService._test.updateProviderInstallOperation(operation.operation.id, { trustVerdict: packVerdict });
    const surfaced = marketplaceService.getDownloads("publisher-trust-smoke-node").downloads.find((record) => record.id === operation.operation.id);
    assert(surfaced, "A provider install operation must be visible through the existing downloads read path.");
    assert(surfaced.trustVerdict, "A provider install must carry the trust verdict on its persisted operation metadata.");
    assert.strictEqual(surfaced.trustVerdict.verdict, TRUST_VERDICTS.UNVERIFIED_PUBLISHER, "The provider verdict must survive persistence.");
    assert.strictEqual(surfaced.trustVerdict.requiresReview, true);
  } finally {
    patchedMethods.forEach((name) => { agentClient[name] = original[name]; });
  }
}

assertVerdictReachesInstallPath()
  .then(() => {
    console.log("publisher-trust-smoke passed: 5/5 verdicts reachable, fail-closed on incomplete integrity, operator copy complete, real integration verdicts = unsigned-executable (curated template) / unverified-publisher (provider pack), and the verdict reaches the production install path + existing downloads read surface.");
  })
  .catch((error) => {
    console.error("publisher-trust-smoke FAILED:", error);
    process.exitCode = 1;
  });