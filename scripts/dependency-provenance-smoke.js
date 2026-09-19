// V2-I dependency provenance / update trust / extension execution smoke.
//
// Hermetic: reads the repository's own package.json + package-lock.json (real
// manifest, real facts), the in-tree advisory triage record, and the pure policy
// modules. No network, no writes, no agent, no clock. Advisory status must be
// either "recorded" (from the triage record) or "unknown" — this smoke fails if
// any code path claims a dependency is advisory-clean, or if the report ever
// asserts a verified advisory feed it does not have.
//
// A positive control is included: the policy must be able to return `verified`
// (so a policy that refuses everything fails) AND must never mark a
// fact-free entry trusted (so a policy that accepts everything fails).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const policy = require("../src/shared/dependencyProvenancePolicy");
const dependencyService = require("../src/services/dependencyService");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lockfile = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

function testProvenanceVerdicts() {
  const V = policy.DEPENDENCY_PROVENANCE_VERDICTS;
  const seen = new Set();
  const record = (verdict, label) => {
    seen.add(verdict.verdict);
    return verdict;
  };

  // (a) No facts at all: fail closed -> unknown, never trusted.
  const noFacts = record(policy.evaluateDependencyProvenance({}, {}), "no facts");
  assert.strictEqual(noFacts.verdict, V.UNKNOWN, "An entry with no facts at all must be unknown, never trusted.");
  assert.strictEqual(noFacts.trusted, false, "An unknown entry must not be trusted.");

  // (b) A bare name/version is not a publisher identity and carries no integrity.
  const bareName = record(policy.evaluateDependencyProvenance({ name: "left-pad", version: "1.0.0" }, {}), "bare name");
  assert.strictEqual(bareName.verdict, V.UNKNOWN, "A package name alone must not be treated as a publisher identity.");

  // (c) POSITIVE CONTROL: first-party + established integrity match -> verified.
  const firstParty = record(policy.evaluateDependencyProvenance(
    { name: "@anxos/example", version: "1.0.0", integrity: "sha512-AAAA" },
    { firstParty: true, declaredHash: "sha512-AAAA", computedHash: "sha512-AAAA", source: "npm" },
  ), "first-party");
  assert.strictEqual(firstParty.verdict, V.VERIFIED, "First-party with an established integrity match must be verified.");
  assert.strictEqual(firstParty.trusted, true, "A verified entry must be trusted.");

  // (d) Attestation-verified third party + established integrity -> verified.
  const signed = record(policy.evaluateDependencyProvenance(
    { name: "third-party-lib", version: "2.0.0", integrity: "sha512-BBBB" },
    {
      source: "registry.npmjs.org",
      declaredHash: "sha512-BBBB",
      computedHash: "sha512-BBBB",
      attestation: { scheme: "sigstore", signer: "vendor@example.com", verified: true },
    },
  ), "signed");
  assert.strictEqual(signed.verdict, V.VERIFIED, "A verified attestation with an integrity match must be verified.");

  // (e) Third party with a recorded lockfile hash: NOT trusted.
  const thirdParty = record(policy.evaluateDependencyProvenance(
    { name: "left-pad", version: "1.0.0", integrity: "sha512-CCCC" },
    { source: "registry.npmjs.org" },
  ), "third-party");
  assert.strictEqual(thirdParty.verdict, V.UNVERIFIED_PUBLISHER, "A third-party dependency must never be verified.");
  assert.strictEqual(thirdParty.trusted, false, "A third-party dependency must not be trusted.");

  // (f) Executable content from a trusted publisher with no integrity fact ->
  //     unsigned-executable. (A third-party executable with no integrity is
  //     named unverified-publisher first, mirroring publisher trust ordering.)
  const executable = record(policy.evaluateDependencyProvenance(
    { name: "@anxos/ssh2-shim", hasInstallScript: true },
    { firstParty: true },
  ), "executable");
  assert.strictEqual(executable.verdict, V.UNSIGNED_EXECUTABLE, "Executable content without integrity must be unsigned-executable.");
  assert.strictEqual(executable.trusted, false, "Executable content without integrity must not be trusted.");
  const thirdPartyExecutable = policy.evaluateDependencyProvenance(
    { name: "ssh2", hasInstallScript: true },
    { source: "registry.npmjs.org" },
  );
  assert.strictEqual(thirdPartyExecutable.verdict, V.UNVERIFIED_PUBLISHER, "A third-party executable must still be named unverified-publisher.");
  assert.strictEqual(thirdPartyExecutable.trusted, false, "A third-party executable must not be trusted.");

  // (g) Integrity mismatch -> hash-mismatch, deny, never trusted.
  const mismatch = record(policy.evaluateDependencyProvenance(
    { name: "@anxos/example", version: "1.0.0" },
    { firstParty: true, declaredHash: "sha512-DDDD", computedHash: "sha512-EEEE", source: "npm" },
  ), "mismatch");
  assert.strictEqual(mismatch.verdict, V.HASH_MISMATCH, "A declared/computed integrity disagreement must be hash-mismatch.");
  assert.strictEqual(mismatch.trusted, false, "A hash mismatch must not be trusted.");
  assert.strictEqual(mismatch.allowInstall, false, "A hash mismatch must not be allowed.");

  // Every verdict in the vocabulary must be reachable (a policy that refuses or
  // accepts everything cannot reach all five).
  const expected = [V.VERIFIED, V.UNVERIFIED_PUBLISHER, V.UNSIGNED_EXECUTABLE, V.HASH_MISMATCH, V.UNKNOWN];
  for (const verdict of expected) {
    assert(seen.has(verdict), `Provenance verdict "${verdict}" must be reachable.`);
  }

  // Trusted is exactly `verified`; nothing else may ever be trusted.
  for (const verdict of [noFacts, bareName, thirdParty, executable, mismatch]) {
    assert.strictEqual(verdict.trusted, false, `Verdict "${verdict.verdict}" must not be trusted.`);
  }

  // SRI vs hex integrity parsing stays distinct and comparable only within an encoding.
  const sri = policy.normalizeDependencyIntegrity("sha512-AbC+/= ");
  assert.strictEqual(sri.algorithm, "sha512", "SRI algorithm must parse.");
  assert.strictEqual(sri.encoding, "base64", "SRI encoding must be base64.");
  const hex = policy.normalizeDependencyIntegrity(`sha256:${"a".repeat(64)}`);
  assert.strictEqual(hex.encoding, "hex", "hex integrity must be tagged hex.");
  const declaredOnly = policy.resolveDependencyIntegrity({ integrity: "sha512-AAAA" }, {});
  assert.strictEqual(declaredOnly.established, false, "A lockfile-recorded hash alone must not count as established integrity.");
  assert.strictEqual(declaredOnly.reasonCode, "INTEGRITY_DECLARED_ONLY", "Declared-only integrity must be named as such.");

  return { seen: [...seen], firstParty, thirdParty, executable, mismatch, noFacts };
}

function testUpdateTrust() {
  const U = policy.DEPENDENCY_UPDATE_VERDICTS;

  // POSITIVE CONTROL: pinned, same source, no boundary, integrity available -> safe.
  const safe = policy.evaluateDependencyUpdate(
    { version: "1.2.0", source: "npm" },
    { version: "1.2.5", source: "npm", integrity: "sha512-AAAA" },
    { pinnedTarget: true },
  );
  assert.strictEqual(safe.verdict, U.SAFE, "A pinned same-major update with an integrity fact must be safe.");
  assert.strictEqual(safe.safe, true, "The safe verdict must report safe: true.");

  // THE GUARD: no integrity fact -> unknown, never safe.
  const noIntegrity = policy.evaluateDependencyUpdate(
    { version: "1.2.0", source: "npm" },
    { version: "1.2.5", source: "npm" },
    { pinnedTarget: true },
  );
  assert.strictEqual(noIntegrity.verdict, U.UNKNOWN, "An update with no integrity fact must be unknown.");
  assert.strictEqual(noIntegrity.safe, false, "An update with no integrity fact must never be safe.");
  assert.strictEqual(noIntegrity.code, policy.DEPENDENCY_UPDATE_CODES.INTEGRITY_UNKNOWN, "The no-integrity case must carry INTEGRITY_UNKNOWN.");

  // A major-boundary update with no integrity fact is NOT reported safe.
  const majorNoIntegrity = policy.evaluateDependencyUpdate(
    { version: "1.2.0", source: "npm" },
    { version: "2.0.0", source: "npm" },
    { pinnedTarget: true },
  );
  assert.strictEqual(majorNoIntegrity.safe, false, "A major-boundary update without integrity must not be safe.");
  assert.strictEqual(majorNoIntegrity.verdict, U.UNKNOWN, "A major-boundary update without integrity must be unknown, not safe.");

  // A major boundary WITH integrity still requires review.
  const major = policy.evaluateDependencyUpdate(
    { version: "1.2.0", source: "npm" },
    { version: "2.0.0", source: "npm", integrity: "sha512-AAAA" },
    { pinnedTarget: true },
  );
  assert.strictEqual(major.verdict, U.REVIEW_REQUIRED, "A major-boundary update must require review even with integrity.");
  assert.strictEqual(major.safe, false, "A major-boundary update must not be safe.");

  // 0.x minor moves are breaking boundaries too.
  assert.strictEqual(policy.crossesMajorBoundary("0.1.0", "0.2.0"), true, "A 0.x minor move must count as a boundary.");

  // An unpinned target requires review even with integrity.
  const unpinned = policy.evaluateDependencyUpdate(
    { version: "1.2.0", source: "npm" },
    { version: "1.3.0", source: "npm", integrity: "sha512-AAAA" },
    { pinnedTarget: false },
  );
  assert.strictEqual(unpinned.verdict, U.REVIEW_REQUIRED, "An unpinned target must require review.");
  assert.strictEqual(unpinned.safe, false, "An unpinned target must not be safe.");

  // A source change is refused outright.
  const changed = policy.evaluateDependencyUpdate(
    { version: "1.2.0", source: "registry.npmjs.org" },
    { version: "1.2.5", source: "evil.example.com", integrity: "sha512-AAAA" },
    { pinnedTarget: true },
  );
  assert.strictEqual(changed.verdict, U.REFUSED, "A source change must be refused.");
  assert.strictEqual(changed.safe, false, "A source change must not be safe.");

  // Exhaustive safety invariant: safe only when all four facts hold.
  const versions = ["1.2.0", "1.2.5", "2.0.0"];
  for (const currentVersion of versions) {
    for (const targetVersion of versions) {
      for (const pinnedTarget of [true, false]) {
        for (const withIntegrity of [true, false]) {
          for (const sourceChanged of [true, false]) {
            const verdict = policy.evaluateDependencyUpdate(
              { version: currentVersion, source: "npm" },
              { version: targetVersion, source: sourceChanged ? "other" : "npm", integrity: withIntegrity ? "sha512-AAAA" : undefined },
              { pinnedTarget, sourceChanged },
            );
            if (verdict.safe) {
              assert.strictEqual(withIntegrity, true, "safe must require an integrity fact.");
              assert.strictEqual(sourceChanged, false, "safe must require an unchanged source.");
              assert.strictEqual(pinnedTarget, true, "safe must require a pinned target.");
              assert.strictEqual(policy.crossesMajorBoundary(currentVersion, targetVersion), false, "safe must not cross a major boundary.");
            }
          }
        }
      }
    }
  }

  return { safe, noIntegrity, majorNoIntegrity, major, unpinned, changed };
}

function testExtensionExecution() {
  const D = policy.EXTENSION_DENIAL_CODES;

  // Deny by default: a bare extension request is refused, naming why.
  const bare = policy.policeExtensionExecution({ id: "ext-1", kind: "extension" });
  assert.strictEqual(bare.allowed, false, "Extension execution must be denied by default.");
  const bareCodes = bare.denials.map((denial) => denial.code);
  assert(bareCodes.includes(D.UNTRUSTED_PUBLISHER), "A bare extension must be refused for an untrusted publisher.");
  assert(bareCodes.includes(D.INTEGRITY_UNVERIFIED), "A bare extension must be refused for unverified integrity.");

  // A grant can never lift a trust or integrity refusal.
  const thirdPartyGranted = policy.policeExtensionExecution({
    id: "ext-2",
    kind: "extension",
    source: "registry.npmjs.org",
    declaredHash: "sha512-AAAA",
    computedHash: "sha512-AAAA",
    postInstallScript: true,
    requiresElevation: true,
    policyGrant: { postInstallScript: true, requiresElevation: true },
  });
  assert.strictEqual(thirdPartyGranted.allowed, false, "A grant must not lift a third-party trust refusal.");
  assert(
    thirdPartyGranted.denials.some((denial) => denial.code === D.UNTRUSTED_PUBLISHER),
    "A third-party extension must be refused for an untrusted publisher even with a full grant.",
  );

  // Gated capabilities are denied without an explicit per-flag grant.
  const firstPartyNoGrant = policy.policeExtensionExecution({
    id: "@anxos/extension",
    kind: "extension",
    firstParty: true,
    declaredHash: "sha512-AAAA",
    computedHash: "sha512-AAAA",
    postInstallScript: true,
  });
  assert.strictEqual(firstPartyNoGrant.allowed, false, "A gated capability without a grant must be denied.");
  assert(
    firstPartyNoGrant.denials.some((denial) => denial.code === D.CAPABILITY_NOT_GRANTED && denial.capability === "postInstallScript"),
    "The missing grant must be named as the denial.",
  );

  // POSITIVE CONTROL: first-party + established integrity + explicit grant -> allowed.
  const allowed = policy.policeExtensionExecution({
    id: "@anxos/extension",
    kind: "extension",
    firstParty: true,
    declaredHash: "sha512-AAAA",
    computedHash: "sha512-AAAA",
    postInstallScript: true,
    policyGrant: { postInstallScript: true },
  });
  assert.strictEqual(allowed.allowed, true, "A first-party extension with established integrity and a grant must be allowed.");

  // Throwing form carries the typed code.
  assert.throws(
    () => policy.assertExtensionExecutionAllowed({ id: "ext-3" }),
    (error) => error.code === D.UNTRUSTED_PUBLISHER || error.code === D.INTEGRITY_UNVERIFIED,
    "assertExtensionExecutionAllowed must throw a typed refusal.",
  );

  return { bare, thirdPartyGranted, firstPartyNoGrant, allowed };
}

function testDependencyReport() {
  const report = dependencyService.buildDependencyProvenanceReport({ rootDir: ROOT });
  assert.strictEqual(report.ok, true, "The real dependency report must build.");
  assert(report.summary.directDependencies >= 7, "The report must enumerate the real direct dependencies from the manifest.");
  assert(report.summary.directDependencies === dependencyService.parseManifestDependencies(manifest).length, "The report count must match the manifest.");

  const names = report.dependencies.map((dependency) => dependency.name);
  for (const expected of ["@xterm/xterm", "js-yaml", "ssh2"]) {
    assert(names.includes(expected), `The report must include real direct dependency ${expected}.`);
  }

  // No live advisory feed exists; the ONLY advisory source is the in-tree
  // triage record, and its absence-of-an-entry is never reported clean.
  assert.strictEqual(report.advisory.status, "triage-record-only", "The report must name the triage-record-only advisory state.");
  assert.strictEqual(report.advisory.verified, false, "Advisory data must never be reported as verified.");
  assert.strictEqual(report.advisory.feed, null, "No advisory feed exists in-tree, so feed must be null.");
  assert(report.advisory.reason.length > 20, "The advisory state must carry a reason.");
  assert.strictEqual(report.advisory.artifact.present, true, "The in-tree triage record must be read and parsed.");
  assert(/SECURITY_TRIAGE_RECORD\.md$/.test(report.advisory.artifact.path), "The advisory artifact path must be named.");
  assert.strictEqual(report.summary.advisory.clean, 0, "No dependency may ever be reported advisory-clean.");
  for (const dependency of report.dependencies) {
    assert(
      dependency.advisory.status === "recorded" || dependency.advisory.status === "unknown",
      `${dependency.name} advisory status must be recorded or unknown, never clean.`,
    );
    assert.strictEqual(dependency.advisory.verified, false, `${dependency.name} advisory data must not be reported verified.`);
  }

  // js-yaml has a REAL recorded entry with GHSA ids from the triage record.
  const jsYamlAdvisory = report.dependencies.find((dependency) => dependency.name === "js-yaml").advisory;
  assert.strictEqual(jsYamlAdvisory.status, "recorded", "js-yaml must report its recorded advisory from the triage record.");
  assert(jsYamlAdvisory.advisories.includes("GHSA-5p4m-2wfm-xmqj"), "The recorded js-yaml advisory id must be surfaced.");

  // A package with no entry is UNKNOWN, not clean.
  const bcryptAdvisory = report.dependencies.find((dependency) => dependency.name === "bcryptjs").advisory;
  assert.strictEqual(bcryptAdvisory.status, "unknown", "A package absent from the triage record must be unknown, not clean.");
  assert.strictEqual(bcryptAdvisory.code, "ADVISORY_NOT_IN_TRIAGE_RECORD", "An absent entry must name that absence explicitly.");

  const serialized = JSON.stringify(report);
  assert(
    !/no advisories|advisory-free|vulnerability-free|"status":"clean"/i.test(serialized),
    "The report must never claim a clean advisory bill of health.",
  );

  // Every dependency carries a vocabulary verdict; trusted is exactly `verified`.
  const V = policy.DEPENDENCY_PROVENANCE_VERDICTS;
  const vocabulary = new Set(Object.values(V));
  for (const dependency of report.dependencies) {
    assert(vocabulary.has(dependency.verdict), `${dependency.name} verdict must be in the provenance vocabulary.`);
    assert.strictEqual(dependency.trusted, dependency.verdict === V.VERIFIED, `${dependency.name} trusted must match the verified verdict.`);
    assert.strictEqual(dependency.direct, true, `${dependency.name} must be reported as a direct dependency.`);
  }

  // Real facts: the lockfile has integrity, but nothing independently verified it.
  const jsYaml = report.dependencies.find((dependency) => dependency.name === "js-yaml");
  const lockEntry = lockfile.packages["node_modules/js-yaml"];
  assert.strictEqual(jsYaml.resolvedVersion, lockEntry.version, "js-yaml resolved version must come from the real lockfile.");
  assert.strictEqual(jsYaml.integrity.present, true, "js-yaml must report a lockfile integrity fact.");
  assert.strictEqual(jsYaml.integrity.independentlyVerified, false, "A lockfile hash alone must not be reported as independently verified.");
  assert.strictEqual(jsYaml.verdict, V.UNVERIFIED_PUBLISHER, "A third-party npm dependency must be unverified-publisher.");

  // ssh2 ships executable content in the real lockfile.
  const ssh2 = report.dependencies.find((dependency) => dependency.name === "ssh2");
  assert.strictEqual(ssh2.executable, true, "ssh2 ships an install script and must be reported executable.");

  // The policy must not accept everything: at least one real dependency is not trusted.
  assert(report.summary.unverified >= 1, "At least one real dependency must be reported unverified (policy must not accept everything).");

  // The parser reads the real record, including entries for packages that are
  // transitive (not direct) so their existence is visible without being
  // attributed to a direct dependency.
  const parsed = dependencyService.parseAdvisoryTriageRecord(
    fs.readFileSync(path.join(ROOT, dependencyService.ADVISORY_TRIAGE_RELATIVE_PATH), "utf8"),
  );
  assert.strictEqual(parsed.present, true, "The triage record must parse to a present artifact.");
  assert(parsed.entries.some((entry) => entry.package === "js-yaml"), "The parsed artifact must include js-yaml.");
  assert(parsed.entries.some((entry) => entry.package === "dompurify"), "The parsed artifact must include the transitive dompurify entry.");
  assert.strictEqual(dependencyService.parseAdvisoryTriageRecord("").present, false, "An empty artifact must not parse as present.");

  // Negative control: an unavailable artifact degrades every dependency to
  // UNKNOWN, never to clean.
  const noArtifact = dependencyService.buildDependencyProvenanceReport({
    rootDir: ROOT,
    advisoryArtifact: { present: false, path: "docs/v2/SECURITY_TRIAGE_RECORD.md", entries: [], parseError: "smoke-negative-control" },
  });
  assert.strictEqual(noArtifact.advisory.artifact.present, false, "An unavailable artifact must be reported as absent.");
  assert.strictEqual(noArtifact.summary.advisory.clean, 0, "An unavailable artifact must not produce a clean advisory count.");
  for (const dependency of noArtifact.dependencies) {
    assert.strictEqual(dependency.advisory.status, "unknown", `${dependency.name} must be unknown when the artifact is unavailable.`);
    assert.strictEqual(dependency.advisory.code, "ADVISORY_ARTIFACT_UNAVAILABLE", "An unavailable artifact must be named.");
  }

  return report;
}

function testIntegrationPoint() {
  const catalog = dependencyService.getDependencyCatalog({ rootDir: ROOT });
  assert.strictEqual(catalog.ok, true, "The dependency catalog entry point must build a report.");

  // A real named dependency gets a real verdict through the integration surface.
  const jsYaml = dependencyService.dependencyProvenanceFor("js-yaml", { rootDir: ROOT });
  assert.strictEqual(jsYaml.ok, true, "A real dependency must resolve through the integration surface.");
  assert.strictEqual(jsYaml.dependency.resolvedVersion, lockfile.packages["node_modules/js-yaml"].version, "The integration verdict must use the real lockfile version.");
  assert.strictEqual(jsYaml.dependency.verdict, policy.DEPENDENCY_PROVENANCE_VERDICTS.UNVERIFIED_PUBLISHER, "The integration verdict must be computed, not assumed.");
  assert.strictEqual(jsYaml.advisory.status, "triage-record-only", "The integration surface must report the advisory state.");
  assert.strictEqual(jsYaml.dependency.advisory.status, "recorded", "The integration dependency must carry its recorded advisory.");

  const missing = dependencyService.dependencyProvenanceFor("definitely-not-a-dependency", { rootDir: ROOT });
  assert.strictEqual(missing.ok, false, "An undeclared dependency must not resolve.");
  assert.strictEqual(missing.code, "DEPENDENCY_NOT_DECLARED", "An undeclared dependency must be named as such.");

  return { catalog, jsYaml };
}

function main() {
  const provenance = testProvenanceVerdicts();
  const update = testUpdateTrust();
  const extension = testExtensionExecution();
  const report = testDependencyReport();
  const integration = testIntegrationPoint();

  console.log("Dependency provenance smoke passed.");
  console.log("provenance verdicts reachable:", provenance.seen.sort().join(", "));
  console.log("positive control (trusted):", provenance.firstParty.verdict, "| fact-free:", provenance.noFacts.verdict);
  console.log("update: safe=", update.safe.verdict, "| no-integrity=", update.noIntegrity.verdict, "| major-no-integrity=", update.majorNoIntegrity.verdict, "| source-change=", update.changed.verdict);
  console.log("extension: default-denied=", !extension.bare.allowed, "| grant-cannot-lift=", !extension.thirdPartyGranted.allowed, "| positive-control-allowed=", extension.allowed.allowed);
  console.log("advisory:", report.advisory.status, `(${report.advisory.code})`);
  console.log("direct dependencies:", report.summary.directDependencies, "| byVerdict:", JSON.stringify(report.summary.byVerdict));
  for (const dependency of report.dependencies) {
    console.log(`  ${dependency.name.padEnd(18)} ${String(dependency.resolvedVersion).padEnd(10)} ${dependency.verdict.padEnd(20)} executable=${dependency.executable} advisory=${dependency.advisory.status}`);
  }
  console.log("integration: js-yaml ->", integration.jsYaml.dependency.verdict, "| catalog direct =", integration.catalog.summary.directDependencies);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
