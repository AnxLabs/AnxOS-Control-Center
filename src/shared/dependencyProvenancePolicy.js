// V2-I dependency provenance, update trust and extension-execution policy.
//
// WHAT THIS MODULE IS
// A pure, dependency-free, deterministic policy answering three questions the
// V2-I queue item asks ("Review package provenance, update trust, extension
// execution and dependency vulnerability handling"):
//
//   1. PROVENANCE — may AnxOS describe this dependency/package as a *trusted*
//      artifact, given only the facts actually known at the call site
//      (declared name/version, source/registry, a declared or computed
//      integrity fact, direct vs transitive, pinned vs ranged, whether it ships
//      executable content, whether it is first-party)?
//   2. UPDATE TRUST — is a proposed dependency update *safe* to describe as
//      safe? An update whose target has no integrity fact is NEVER `safe`;
//      `unknown` is a valid and expected answer.
//   3. EXTENSION EXECUTION — may AnxOS execute third-party executable content
//      from a dependency or extension at all? Deny by default.
//
// The dependency-vulnerability question is deliberately NOT answered here: the
// repository has no advisory data it can verify, so the service layer
// (src/services/dependencyService.js) reports advisory status as UNKNOWN with
// its reason instead of inventing a clean bill of health.
//
// ONE TRUST IDIOM (not two)
// This module deliberately reuses the publisher-trust vocabulary and helpers
// from src/shared/publisherTrustPolicy.js rather than inventing a second set:
//   - the verdict strings are literally TRUST_VERDICTS (verified /
//     unverified-publisher / unsigned-executable / hash-mismatch / unknown);
//   - `normalizeIntegrityHash` (hex/object forms) is reused for integrity;
//   - FIRST_PARTY_SOURCES and ATTESTATION_SCHEMES are reused so "first-party"
//     and "a verified attestation" mean the same thing on both surfaces.
// The dependency-only additions are SRI ("sha512-<base64>") integrity parsing
// and the update/extension rules. The two modules still duplicate the small
// isVerifiedAttestation / message-table / buildVerdict shapes; see the report
// recommendation to lift a shared `trustVocabulary.js` if a third surface ever
// appears.
//
// FAIL CLOSED. `verified` requires BOTH a trusted identity (first-party, or an
// explicit attestation reported verified) AND an *established* integrity match
// (a declared and an independently computed hash, same algorithm, equal value).
// A lockfile-recorded hash alone is a declaration, not a verification, so it is
// never enough on its own. An entry whose provenance cannot be established is
// never `trusted`.

"use strict";

const {
  ATTESTATION_SCHEMES,
  FIRST_PARTY_SOURCES,
  TRUST_VERDICTS,
  normalizeIntegrityHash,
} = require("./publisherTrustPolicy");

// The dependency surface speaks the publisher-trust vocabulary verbatim.
const DEPENDENCY_PROVENANCE_VERDICTS = TRUST_VERDICTS;

const DEPENDENCY_PROVENANCE_CODES = Object.freeze({
  VERIFIED_FIRST_PARTY: "DEPENDENCY_PROVENANCE_VERIFIED_FIRST_PARTY",
  VERIFIED_SIGNED: "DEPENDENCY_PROVENANCE_VERIFIED_SIGNED",
  UNVERIFIED_PUBLISHER: "DEPENDENCY_PROVENANCE_UNVERIFIED_PUBLISHER",
  UNSIGNED_EXECUTABLE: "DEPENDENCY_PROVENANCE_UNSIGNED_EXECUTABLE",
  HASH_MISMATCH: "DEPENDENCY_PROVENANCE_HASH_MISMATCH",
  UNKNOWN: "DEPENDENCY_PROVENANCE_UNKNOWN",
});

// Scopes AnxOS owns. A package under one of these scopes is first-party by
// construction (the same set the publisher policy calls first-party).
const FIRST_PARTY_DEPENDENCY_SCOPES = Object.freeze(["@anxos/"]);

// Operator-facing copy. Same shape and severity ladder as TRUST_MESSAGES so the
// renderer has one rendering path, with dependency wording.
const DEPENDENCY_PROVENANCE_MESSAGES = Object.freeze({
  [DEPENDENCY_PROVENANCE_VERDICTS.VERIFIED]: Object.freeze({
    severity: "ok",
    title: "Verified dependency",
    body: "AnxOS recognizes this dependency as first-party (or attestation-verified) and an independently computed integrity hash matches the declaration.",
    action: "This dependency may be described as trusted.",
    requiresReview: false,
    allowInstall: true,
  }),
  [DEPENDENCY_PROVENANCE_VERDICTS.UNVERIFIED_PUBLISHER]: Object.freeze({
    severity: "warning",
    title: "Unverified dependency publisher",
    body: "AnxOS cannot verify who published this dependency. It is not first-party, and no trusted attestation covers it.",
    action: "Review the package source before relying on it. An integrity declaration alone does not establish publisher trust.",
    requiresReview: true,
    allowInstall: true,
  }),
  [DEPENDENCY_PROVENANCE_VERDICTS.UNSIGNED_EXECUTABLE]: Object.freeze({
    severity: "warning",
    title: "Unsigned executable dependency",
    body: "This dependency ships executable content but carries no integrity fact AnxOS can verify.",
    action: "No integrity evidence is available for this dependency. Review it before executing anything from it.",
    requiresReview: true,
    allowInstall: true,
  }),
  [DEPENDENCY_PROVENANCE_VERDICTS.HASH_MISMATCH]: Object.freeze({
    severity: "critical",
    title: "Dependency integrity check failed",
    body: "The dependency does not match the integrity hash it declares.",
    action: "Do not use this dependency. Re-resolve it or choose another source.",
    requiresReview: true,
    allowInstall: false,
  }),
  [DEPENDENCY_PROVENANCE_VERDICTS.UNKNOWN]: Object.freeze({
    severity: "warning",
    title: "Dependency provenance unknown",
    body: "AnxOS found no publisher identity and no integrity facts to evaluate for this dependency.",
    action: "Treat this dependency as unverified and review it before relying on it.",
    requiresReview: true,
    allowInstall: true,
  }),
});

const DEPENDENCY_UPDATE_VERDICTS = Object.freeze({
  SAFE: "safe",
  REVIEW_REQUIRED: "review-required",
  UNKNOWN: "unknown",
  REFUSED: "refused",
});

const DEPENDENCY_UPDATE_CODES = Object.freeze({
  SAFE: "DEPENDENCY_UPDATE_SAFE",
  MAJOR_BOUNDARY: "DEPENDENCY_UPDATE_MAJOR_BOUNDARY",
  UNPINNED_TARGET: "DEPENDENCY_UPDATE_UNPINNED_TARGET",
  INTEGRITY_UNKNOWN: "DEPENDENCY_UPDATE_INTEGRITY_UNKNOWN",
  SOURCE_CHANGED: "DEPENDENCY_UPDATE_SOURCE_CHANGED",
});

const EXTENSION_DENIAL_CODES = Object.freeze({
  UNTRUSTED_PUBLISHER: "EXTENSION_UNTRUSTED_PUBLISHER",
  INTEGRITY_UNVERIFIED: "EXTENSION_INTEGRITY_UNVERIFIED",
  INTEGRITY_MISMATCH: "EXTENSION_INTEGRITY_MISMATCH",
  CAPABILITY_NOT_GRANTED: "EXTENSION_CAPABILITY_NOT_GRANTED",
});

// Capabilities an extension may only use with an explicit, per-flag grant.
// The grant gate is the boundary; a trust refusal can never be lifted by a
// grant (see policeExtensionExecution).
const EXTENSION_GATED_CAPABILITIES = Object.freeze([
  { key: "postInstallScript", label: "post-install script execution" },
  { key: "requiresElevation", label: "host privilege elevation" },
  { key: "networkAccess", label: "network access" },
  { key: "writesOutsideWorkspace", label: "writes outside the workspace" },
]);

const EXTENSION_GATED_CAPABILITY_SET = new Set(EXTENSION_GATED_CAPABILITIES.map((entry) => entry.key));
const ATTESTATION_SCHEME_SET = new Set(ATTESTATION_SCHEMES);
const FIRST_PARTY_SOURCE_SET = new Set(FIRST_PARTY_SOURCES);

// --- integrity -----------------------------------------------------------------

const SRI_PATTERN = /^([a-z0-9]+)-([A-Za-z0-9+/=]+)$/;

// Normalize an npm SRI string ("sha512-<base64>"), an "alg:hex" string, a
// {algorithm,value} object, or a bare 64-char hex sha256 into
// { algorithm, value, encoding }. SRI and hex are kept distinct because their
// value encodings are not comparable; the hex/object forms are delegated to
// publisherTrustPolicy.normalizeIntegrityHash so both surfaces parse them the
// same way.
function normalizeDependencyIntegrity(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const normalized = normalizeIntegrityHash(raw);
    return normalized ? { ...normalized, encoding: "hex" } : null;
  }
  const text = String(raw).trim();
  if (!text) {
    return null;
  }
  // A lockfile may carry several space-separated hashes; the first is canonical.
  const first = text.split(/\s+/)[0];
  const sri = first.match(SRI_PATTERN);
  if (sri) {
    return { algorithm: sri[1].toLowerCase(), value: sri[2], encoding: "base64" };
  }
  const hex = normalizeIntegrityHash(first);
  return hex ? { ...hex, encoding: "hex" } : null;
}

function readDeclaredDependencyIntegrity(entry, facts) {
  if (facts.declaredHash !== undefined && facts.declaredHash !== null) return facts.declaredHash;
  return entry?.integrity
    ?? entry?.declaredHash
    ?? entry?.provenance?.integrity
    ?? entry?.provenance?.hash
    ?? null;
}

// Integrity is established ONLY by a declared + computed pair that share an
// algorithm and value encoding and are equal. A declared value with nothing to
// compare it against is recorded as INTEGRITY_DECLARED_ONLY and is not
// established — a lockfile hash pins the resolution, it does not verify bytes.
function resolveDependencyIntegrity(entry, facts) {
  const declared = normalizeDependencyIntegrity(readDeclaredDependencyIntegrity(entry, facts));
  const computed = normalizeDependencyIntegrity(facts.computedHash);
  const evidence = [
    { source: "declared-integrity", algorithm: declared?.algorithm || null, encoding: declared?.encoding || null, present: Boolean(declared) },
    { source: "computed-integrity", algorithm: computed?.algorithm || null, encoding: computed?.encoding || null, present: Boolean(computed) },
  ];

  if (!declared && !computed) {
    return { established: false, mismatch: false, comparable: false, reasonCode: "INTEGRITY_FACTS_ABSENT", declared, computed, evidence };
  }
  if (declared && !computed) {
    return { established: false, mismatch: false, comparable: false, reasonCode: "INTEGRITY_DECLARED_ONLY", declared, computed, evidence };
  }
  if (!declared && computed) {
    return { established: false, mismatch: false, comparable: false, reasonCode: "INTEGRITY_COMPUTED_ONLY", declared, computed, evidence };
  }
  if (declared.algorithm !== computed.algorithm || declared.encoding !== computed.encoding) {
    return { established: false, mismatch: false, comparable: false, reasonCode: "INTEGRITY_NOT_COMPARABLE", declared, computed, evidence };
  }
  const match = declared.value === computed.value;
  return {
    established: match,
    mismatch: !match,
    comparable: true,
    reasonCode: match ? "INTEGRITY_MATCH" : "INTEGRITY_VALUE_MISMATCH",
    declared,
    computed,
    evidence,
  };
}

// --- publisher identity --------------------------------------------------------

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function readSourceHost(sourceUrl) {
  const url = nonEmptyString(sourceUrl) ? String(sourceUrl).trim() : "";
  if (!url) return null;
  const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function isVerifiedAttestation(attestation) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return false;
  }
  if (attestation.verified !== true) return false;
  const scheme = String(attestation.scheme || "").trim().toLowerCase();
  const signer = String(attestation.signer || attestation.identity || "").trim();
  return ATTESTATION_SCHEME_SET.has(scheme) && signer !== "";
}

function isFirstPartyDependency(entry, facts) {
  if (facts.firstParty === true || entry?.firstParty === true) return true;
  const name = String(entry?.name || entry?.packageName || "").trim().toLowerCase();
  if (FIRST_PARTY_DEPENDENCY_SCOPES.some((scope) => name.startsWith(scope))) return true;
  const candidates = [facts.source, facts.registry, entry?.source, entry?.registry, entry?.author, entry?.publisher]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  return candidates.some((value) => FIRST_PARTY_SOURCE_SET.has(value));
}

// Identity classes: "first-party", "signed", "third-party", "none". A package
// NAME is not a publisher identity — only a source/registry/author is.
function classifyDependencyPublisher(entry, facts) {
  const attestation = facts.attestation || entry?.attestation || entry?.provenance?.attestation || entry?.provenance?.signature || null;
  if (isVerifiedAttestation(attestation)) {
    return {
      kind: "signed",
      identity: String(attestation.signer || attestation.identity || "").trim(),
      scheme: String(attestation.scheme).trim().toLowerCase(),
    };
  }
  if (isFirstPartyDependency(entry || {}, facts || {})) {
    return { kind: "first-party", identity: String(entry?.name || "first-party").trim(), scheme: null };
  }
  const host = readSourceHost(facts.sourceUrl || entry?.resolved || entry?.sourceUrl || entry?.url);
  const identity = String(
    facts.registry
    || facts.source
    || entry?.registry
    || entry?.source
    || entry?.author
    || entry?.publisher
    || host
    || "",
  ).trim().toLowerCase();
  if (identity) return { kind: "third-party", identity, scheme: null };
  return { kind: "none", identity: "", scheme: null };
}

// --- executable content --------------------------------------------------------

// Whether the dependency ships content AnxOS would execute. An explicit
// boolean from the caller wins; otherwise a lockfile/descriptor install script
// or binary/installer marker makes it executable.
function isExecutableDependency(entry, facts = {}) {
  if (typeof facts.executable === "boolean") return facts.executable;
  if (typeof entry?.executable === "boolean") return entry.executable;
  if (entry?.hasInstallScript === true || entry?.requiresBuild === true) return true;
  if (Array.isArray(entry?.bin) && entry.bin.length > 0) return true;
  if (entry?.bin && typeof entry.bin === "object" && Object.keys(entry.bin).length > 0) return true;
  if (Array.isArray(entry?.installScript) && entry.installScript.length > 0) return true;
  const installerType = String(entry?.installerType || entry?.installer?.type || "").trim().toLowerCase();
  if (installerType && installerType !== "none" && installerType !== "local-import") return true;
  return false;
}

function buildProvenanceVerdict(verdict, code, reason, details = {}) {
  const message = DEPENDENCY_PROVENANCE_MESSAGES[verdict];
  return {
    verdict,
    code,
    label: message.title,
    reason,
    operatorTitle: message.title,
    operatorMessage: message.body,
    operatorAction: message.action,
    severity: message.severity,
    requiresReview: message.requiresReview,
    allowInstall: message.allowInstall,
    trusted: verdict === DEPENDENCY_PROVENANCE_VERDICTS.VERIFIED,
    publisher: details.publisher || null,
    publisherKind: details.publisherKind || "none",
    executable: Boolean(details.executable),
    integrity: {
      established: Boolean(details.integrity?.established),
      comparable: Boolean(details.integrity?.comparable),
      mismatch: Boolean(details.integrity?.mismatch),
      declared: details.integrity?.declared || null,
      computed: details.integrity?.computed || null,
      reasonCode: details.integrity?.reasonCode || "INTEGRITY_FACTS_ABSENT",
      evidence: Array.isArray(details.integrity?.evidence) ? details.integrity.evidence : [],
    },
  };
}

// The single provenance entry point. Pure: same (entry, facts) always yields the
// same verdict object; no I/O, clock, randomness or environment reads.
//
// entry: { name, version, range, source, registry, resolved, integrity,
//          hasInstallScript, bin, firstParty, attestation, ... }
// facts: { source, registry, sourceUrl, declaredHash, computedHash, attestation,
//          firstParty, executable }
function evaluateDependencyProvenance(entry = {}, facts = {}) {
  const publisher = classifyDependencyPublisher(entry || {}, facts || {});
  const integrity = resolveDependencyIntegrity(entry || {}, facts || {});
  const executable = isExecutableDependency(entry || {}, facts || {});
  const details = { publisher: publisher.identity || null, publisherKind: publisher.kind, executable, integrity };

  // 1. A declared/computed disagreement is always the verdict. Never trusted.
  if (integrity.mismatch) {
    return buildProvenanceVerdict(
      DEPENDENCY_PROVENANCE_VERDICTS.HASH_MISMATCH,
      DEPENDENCY_PROVENANCE_CODES.HASH_MISMATCH,
      `Declared ${integrity.declared.algorithm} integrity does not match the computed value for this dependency.`,
      details,
    );
  }

  // 2. Trusted requires a trusted identity AND an established integrity match.
  if (integrity.established && publisher.kind === "signed") {
    return buildProvenanceVerdict(
      DEPENDENCY_PROVENANCE_VERDICTS.VERIFIED,
      DEPENDENCY_PROVENANCE_CODES.VERIFIED_SIGNED,
      `Attestation verified by ${publisher.identity} and the integrity hash matches.`,
      details,
    );
  }
  if (integrity.established && publisher.kind === "first-party") {
    return buildProvenanceVerdict(
      DEPENDENCY_PROVENANCE_VERDICTS.VERIFIED,
      DEPENDENCY_PROVENANCE_CODES.VERIFIED_FIRST_PARTY,
      `First-party dependency (${publisher.identity}) and the integrity hash matches.`,
      details,
    );
  }

  // 3. An identifiable but unverifiable publisher is named as such, whether or
  //    not a declared hash happened to be recorded (a declaration is not trust).
  if (publisher.kind === "third-party") {
    return buildProvenanceVerdict(
      DEPENDENCY_PROVENANCE_VERDICTS.UNVERIFIED_PUBLISHER,
      DEPENDENCY_PROVENANCE_CODES.UNVERIFIED_PUBLISHER,
      integrity.established
        ? `Publisher "${publisher.identity}" is not first-party and carries no verified attestation; an integrity match alone does not establish publisher trust.`
        : `Publisher "${publisher.identity}" is not first-party and carries no verified attestation.`,
      details,
    );
  }

  // 4. Integrity established but no publisher identity to attribute it to.
  if (integrity.established) {
    return buildProvenanceVerdict(
      DEPENDENCY_PROVENANCE_VERDICTS.UNVERIFIED_PUBLISHER,
      DEPENDENCY_PROVENANCE_CODES.UNVERIFIED_PUBLISHER,
      "The integrity hash matches, but no publisher identity is present to attribute the declaration to.",
      details,
    );
  }

  // 5. Executable content with no established integrity: unsigned.
  if (executable) {
    return buildProvenanceVerdict(
      DEPENDENCY_PROVENANCE_VERDICTS.UNSIGNED_EXECUTABLE,
      DEPENDENCY_PROVENANCE_CODES.UNSIGNED_EXECUTABLE,
      publisher.kind === "first-party" || publisher.kind === "signed"
        ? `Executable dependency from ${publisher.identity || "a trusted publisher"} carries no verifiable integrity hash.`
        : "Executable dependency carries no verifiable integrity hash.",
      details,
    );
  }

  // 6. Nothing to check: no publisher identity and no established integrity.
  return buildProvenanceVerdict(
    DEPENDENCY_PROVENANCE_VERDICTS.UNKNOWN,
    DEPENDENCY_PROVENANCE_CODES.UNKNOWN,
    "No publisher identity and no integrity facts are available for this dependency.",
    details,
  );
}

function describeDependencyProvenanceVerdict(verdict) {
  const key = typeof verdict === "string" ? verdict : verdict?.verdict;
  const message = DEPENDENCY_PROVENANCE_MESSAGES[key];
  if (!message) {
    return {
      verdict: key || null,
      severity: "warning",
      title: DEPENDENCY_PROVENANCE_MESSAGES[DEPENDENCY_PROVENANCE_VERDICTS.UNKNOWN].title,
      body: DEPENDENCY_PROVENANCE_MESSAGES[DEPENDENCY_PROVENANCE_VERDICTS.UNKNOWN].body,
      action: DEPENDENCY_PROVENANCE_MESSAGES[DEPENDENCY_PROVENANCE_VERDICTS.UNKNOWN].action,
      requiresReview: true,
      allowInstall: true,
    };
  }
  return { verdict: key, ...message };
}

// --- update trust --------------------------------------------------------------

function parseVersionParts(value) {
  const text = String(value ?? "").trim().replace(/^[=v]/, "");
  const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10) || 0,
    minor: Number.parseInt(match[2] ?? "0", 10) || 0,
    patch: Number.parseInt(match[3] ?? "0", 10) || 0,
  };
}

// A 1.x -> 2.x move is a major boundary; for 0.x, a minor move (0.1 -> 0.2) is
// also breaking per semver, so it counts as a boundary too.
function crossesMajorBoundary(currentVersion, targetVersion) {
  const current = parseVersionParts(currentVersion);
  const target = parseVersionParts(targetVersion);
  if (!current || !target) return null;
  if (current.major !== target.major) return true;
  if (current.major === 0 && current.minor !== target.minor) return true;
  return false;
}

function isExactVersion(value) {
  const text = String(value ?? "").trim().replace(/^[=v]/, "");
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text);
}

// Evaluate whether a proposed update may be described as `safe`.
//
// facts:
//   pinnedTarget   boolean  (target version pinned exactly)
//   integrity      the target's declared integrity fact, if any
//   integrityAvailable boolean (alternative to supplying `integrity`)
//   sourceChanged  boolean  (the update resolves from a different source)
//
// Rule order is deliberate: a source change is refused first; a missing
// integrity fact is UNKNOWN (never safe) before any "looks fine" path; a major
// boundary or an unpinned target needs review; only then is it safe.
function evaluateDependencyUpdate(current = {}, target = {}, facts = {}) {
  const currentVersion = current.version ?? current.resolvedVersion ?? current.range ?? null;
  const targetVersion = target.version ?? target.resolvedVersion ?? target.range ?? null;
  const boundary = crossesMajorBoundary(currentVersion, targetVersion);
  const pinned = typeof facts.pinnedTarget === "boolean"
    ? facts.pinnedTarget
    : (target.pinned === true || isExactVersion(targetVersion));
  const integrityFact = facts.integrity !== undefined && facts.integrity !== null
    ? normalizeDependencyIntegrity(facts.integrity)
    : normalizeDependencyIntegrity(target.integrity);
  const integrityAvailable = typeof facts.integrityAvailable === "boolean"
    ? facts.integrityAvailable
    : Boolean(integrityFact);
  const sourceChanged = facts.sourceChanged === true
    || (nonEmptyString(current.source) && nonEmptyString(target.source)
      && String(current.source).trim() !== String(target.source).trim());

  const base = {
    currentVersion: currentVersion === null ? null : String(currentVersion),
    targetVersion: targetVersion === null ? null : String(targetVersion),
    pinned,
    majorBoundary: boundary,
    sourceChanged,
    integrityAvailable,
    integrity: integrityFact,
  };

  if (sourceChanged) {
    return {
      ...base,
      verdict: DEPENDENCY_UPDATE_VERDICTS.REFUSED,
      code: DEPENDENCY_UPDATE_CODES.SOURCE_CHANGED,
      safe: false,
      requiresReview: true,
      reason: "The update resolves from a different source than the installed dependency; provenance would be invalidated, so AnxOS refuses to call it safe.",
    };
  }

  if (!integrityAvailable) {
    return {
      ...base,
      verdict: DEPENDENCY_UPDATE_VERDICTS.UNKNOWN,
      code: DEPENDENCY_UPDATE_CODES.INTEGRITY_UNKNOWN,
      safe: false,
      requiresReview: true,
      reason: "No integrity fact is available for the target version, so AnxOS cannot describe this update as safe.",
    };
  }

  if (boundary === true) {
    return {
      ...base,
      verdict: DEPENDENCY_UPDATE_VERDICTS.REVIEW_REQUIRED,
      code: DEPENDENCY_UPDATE_CODES.MAJOR_BOUNDARY,
      safe: false,
      requiresReview: true,
      reason: "The update crosses a major (breaking) version boundary and requires review.",
    };
  }

  if (!pinned) {
    return {
      ...base,
      verdict: DEPENDENCY_UPDATE_VERDICTS.REVIEW_REQUIRED,
      code: DEPENDENCY_UPDATE_CODES.UNPINNED_TARGET,
      safe: false,
      requiresReview: true,
      reason: "The target version is not pinned, so the resolved artifact could change without review.",
    };
  }

  return {
    ...base,
    verdict: DEPENDENCY_UPDATE_VERDICTS.SAFE,
    code: DEPENDENCY_UPDATE_CODES.SAFE,
    safe: true,
    requiresReview: false,
    reason: "The target is pinned, the source is unchanged, no major boundary is crossed, and an integrity fact is available.",
  };
}

// --- extension execution (deny by default) ------------------------------------

// What must be true before AnxOS executes anything from a dependency or
// extension:
//   1. the publisher must be first-party or attestation-verified (a grant can
//      never lift this), AND
//   2. an integrity fact must be established, with no mismatch (a grant can
//      never lift this), AND
//   3. every gated capability must carry an explicit per-flag policyGrant.
//
// Returns the same { allowed, flags, denials } shape as the docker policy gate
// so callers have one refusal idiom.
function detectExtensionFlags(payload = {}) {
  const flags = [];
  for (const capability of EXTENSION_GATED_CAPABILITIES) {
    if (payload[capability.key] === true) {
      flags.push({ key: capability.key, label: capability.label });
    }
  }
  return flags;
}

function policeExtensionExecution(payload = {}) {
  const entry = payload.dependency || payload.extension || payload;
  const facts = {
    source: payload.source ?? entry?.source,
    registry: payload.registry ?? entry?.registry,
    sourceUrl: payload.sourceUrl ?? entry?.resolved ?? entry?.url,
    declaredHash: payload.declaredHash ?? entry?.integrity,
    computedHash: payload.computedHash,
    attestation: payload.attestation ?? entry?.attestation,
    firstParty: payload.firstParty,
    executable: true,
  };
  const publisher = classifyDependencyPublisher(entry || {}, facts);
  const integrity = resolveDependencyIntegrity(entry || {}, facts);
  const flags = detectExtensionFlags(payload);
  const grant = payload.policyGrant && typeof payload.policyGrant === "object" ? payload.policyGrant : {};

  // 1. Capability gate: deny by default, lifted only by an explicit grant.
  const denials = flags
    .filter((flag) => grant[flag.key] !== true)
    .map((flag) => ({
      key: `extensionCapability:${flag.key}`,
      code: EXTENSION_DENIAL_CODES.CAPABILITY_NOT_GRANTED,
      capability: flag.key,
      label: `${flag.label} is not granted for this extension.`,
      statusCode: 403,
      liftableByGrant: true,
    }));

  // 2. Trust and integrity refusals are appended AFTER the grant filter and are
  //    never liftable by a grant.
  if (integrity.mismatch) {
    denials.push({
      key: "extensionIntegrity:mismatch",
      code: EXTENSION_DENIAL_CODES.INTEGRITY_MISMATCH,
      capability: "integrity",
      label: "The extension does not match its declared integrity hash.",
      statusCode: 403,
      liftableByGrant: false,
    });
  } else if (!integrity.established) {
    denials.push({
      key: "extensionIntegrity:unverified",
      code: EXTENSION_DENIAL_CODES.INTEGRITY_UNVERIFIED,
      capability: "integrity",
      label: "No established integrity fact exists for the extension, so AnxOS refuses to execute it.",
      statusCode: 403,
      liftableByGrant: false,
    });
  }

  if (publisher.kind !== "first-party" && publisher.kind !== "signed") {
    denials.push({
      key: "extensionPublisher:untrusted",
      code: EXTENSION_DENIAL_CODES.UNTRUSTED_PUBLISHER,
      capability: "publisher",
      label: publisher.kind === "none"
        ? "The extension has no publisher identity, so AnxOS refuses to execute it."
        : `Extension publisher "${publisher.identity}" is not first-party or attestation-verified, so AnxOS refuses to execute it.`,
      statusCode: 403,
      liftableByGrant: false,
    });
  }

  return {
    allowed: denials.length === 0,
    flags,
    denials,
    publisher,
    integrity,
  };
}

// Throwing form, mirroring assertWorkloadTrust.
function assertExtensionExecutionAllowed(payload = {}) {
  const verdict = policeExtensionExecution(payload);
  if (verdict.allowed) return verdict;
  const primary = verdict.denials[0];
  const error = new Error(primary.label);
  error.code = primary.code;
  error.statusCode = primary.statusCode;
  error.extensionVerdict = verdict;
  error.denials = verdict.denials;
  throw error;
}

module.exports = {
  ATTESTATION_SCHEMES,
  DEPENDENCY_PROVENANCE_CODES,
  DEPENDENCY_PROVENANCE_MESSAGES,
  DEPENDENCY_PROVENANCE_VERDICTS,
  DEPENDENCY_UPDATE_CODES,
  DEPENDENCY_UPDATE_VERDICTS,
  EXTENSION_DENIAL_CODES,
  EXTENSION_GATED_CAPABILITIES,
  FIRST_PARTY_DEPENDENCY_SCOPES,
  assertExtensionExecutionAllowed,
  classifyDependencyPublisher,
  crossesMajorBoundary,
  describeDependencyProvenanceVerdict,
  detectExtensionFlags,
  evaluateDependencyProvenance,
  evaluateDependencyUpdate,
  isExactVersion,
  isExecutableDependency,
  normalizeDependencyIntegrity,
  policeExtensionExecution,
  resolveDependencyIntegrity,
};
