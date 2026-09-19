// V2-D publisher-trust policy (docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md §3
// item 5, roadmap V2-D bullets 7-8).
//
// Pure, dependency-free, deterministic policy: it answers one question for a
// catalog entry, pack, template or dependency — "may AnxOS describe this
// content as a verified publisher artifact?" — from the entry plus the
// integrity facts that are actually known at the call site.
//
// Design rules, in priority order:
//
//   1. FAIL CLOSED. `verified` requires BOTH (a) a trusted publisher identity
//      (first-party, or an explicit attestation that says it was verified) AND
//      (b) an established integrity match (a declared hash that equals a
//      computed hash with the same algorithm). An entry whose integrity cannot
//      be established is NEVER `verified`, even when the publisher is AnxOS.
//   2. A hash match alone is NOT publisher trust. A self-declared hash that
//      matches says "the bytes match the declaration"; it says nothing about
//      who made the declaration. Without a trusted publisher identity the
//      verdict is `unverified-publisher`.
//   3. An unverifiable third-party publisher is named as such
//      (`unverified-publisher`) rather than folded into a generic unknown.
//   4. Nothing to check at all is `unknown` — never `verified`.
//
// There is no public-key / attestation infrastructure in this repository. The
// `signed` branch below is reachable only when a caller supplies attestation
// facts (for example a Sigstore/cosign result verified out of band). It is
// implemented and tested so the seam exists, and it is deliberately not
// fabricated when the repo has nothing to check against.

const TRUST_VERDICTS = Object.freeze({
  VERIFIED: "verified",
  UNVERIFIED_PUBLISHER: "unverified-publisher",
  UNSIGNED_EXECUTABLE: "unsigned-executable",
  HASH_MISMATCH: "hash-mismatch",
  UNKNOWN: "unknown",
});

const TRUST_CODES = Object.freeze({
  VERIFIED_FIRST_PARTY: "TRUST_VERIFIED_FIRST_PARTY",
  VERIFIED_SIGNED: "TRUST_VERIFIED_SIGNED",
  UNVERIFIED_PUBLISHER: "TRUST_UNVERIFIED_PUBLISHER",
  UNSIGNED_EXECUTABLE: "TRUST_UNSIGNED_EXECUTABLE",
  HASH_MISMATCH: "TRUST_HASH_MISMATCH",
  UNKNOWN: "TRUST_UNKNOWN",
});

// Publishers AnxOS itself owns. `anxhub` is intentionally NOT listed: it is a
// local-session / default-provider name in this repo, not a signing identity,
// so content that only says `provider: "anxhub"` is treated as an unverifiable
// third party rather than silently promoted to first-party.
const FIRST_PARTY_SOURCES = Object.freeze(["anxos", "anxos-catalog", "anxos-control-center", "first-party", "bundled", "curated"]);

// Attestation schemes that, when a caller reports them verified, count as a
// trusted publisher identity. An unknown scheme string never counts.
const ATTESTATION_SCHEMES = Object.freeze(["sigstore", "cosign", "minisign", "gpg", "anxos-attestation"]);

// Installer types that run third-party executable content on the target host.
const EXECUTABLE_INSTALLER_TYPES = Object.freeze([
  "archive-download",
  "curseforge",
  "direct-download",
  "docker-image",
  "java-runtime",
  "provider-download",
  "steamcmd-native",
]);

const EXECUTABLE_INSTALLER_TYPE_SET = new Set(EXECUTABLE_INSTALLER_TYPES);
const FIRST_PARTY_SOURCE_SET = new Set(FIRST_PARTY_SOURCES);
const ATTESTATION_SCHEME_SET = new Set(ATTESTATION_SCHEMES);

const HASH_ALGORITHMS = Object.freeze(["sha256", "sha512", "sha1"]);
const HASH_PATTERN = /^([a-z0-9]+):([a-f0-9]{16,128})$/i;

// Operator-facing copy. The renderer must display these strings verbatim; this
// is the single source of truth for trust wording so the UI cannot invent a
// softer phrasing than the policy decided.
const TRUST_MESSAGES = Object.freeze({
  [TRUST_VERDICTS.VERIFIED]: Object.freeze({
    severity: "ok",
    title: "Verified publisher",
    body: "AnxOS recognizes this publisher and the integrity hash matches the declared value.",
    action: "You can install this package.",
    requiresReview: false,
    allowInstall: true,
  }),
  [TRUST_VERDICTS.UNVERIFIED_PUBLISHER]: Object.freeze({
    severity: "warning",
    title: "Unverified publisher",
    body: "AnxOS cannot verify who published this content. It is not first-party, and no trusted attestation covers it.",
    action: "Review the publisher and source before installing. Install only if you trust them.",
    requiresReview: true,
    allowInstall: true,
  }),
  [TRUST_VERDICTS.UNSIGNED_EXECUTABLE]: Object.freeze({
    severity: "warning",
    title: "Unsigned executable content",
    body: "This package runs executable content on your host but carries no integrity hash that AnxOS can verify.",
    action: "No integrity evidence is available for this package. Review the publisher before installing.",
    requiresReview: true,
    allowInstall: true,
  }),
  [TRUST_VERDICTS.HASH_MISMATCH]: Object.freeze({
    severity: "critical",
    title: "Integrity check failed",
    body: "The content does not match the integrity hash the package declares.",
    action: "Do not install this package. Re-download it or choose another source.",
    requiresReview: true,
    allowInstall: false,
  }),
  [TRUST_VERDICTS.UNKNOWN]: Object.freeze({
    severity: "warning",
    title: "Publisher trust unknown",
    body: "AnxOS found no publisher identity and no integrity facts to evaluate for this entry.",
    action: "Treat this entry as unverified and review it before installing.",
    requiresReview: true,
    allowInstall: true,
  }),
});

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Normalize a hash declaration into { algorithm, value } or null. Accepts
// "sha256:<hex>", a { algorithm, value } object, or a bare sha256-length hex
// string (assumed sha256 only when it is exactly 64 hex characters).
function normalizeIntegrityHash(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const algorithm = String(raw.algorithm || raw.algo || "").trim().toLowerCase();
    const value = String(raw.value ?? raw.hash ?? raw.digest ?? "").trim().toLowerCase();
    if (!algorithm || !/^[a-f0-9]+$/.test(value)) {
      return null;
    }
    return { algorithm, value };
  }
  const text = String(raw).trim();
  if (!text) {
    return null;
  }
  const match = text.match(HASH_PATTERN);
  if (match) {
    return { algorithm: match[1].toLowerCase(), value: match[2].toLowerCase() };
  }
  if (/^[a-f0-9]{64}$/i.test(text)) {
    return { algorithm: "sha256", value: text.toLowerCase() };
  }
  return null;
}

function readDeclaredHash(entry, facts) {
  if (facts.declaredHash !== undefined && facts.declaredHash !== null) {
    return facts.declaredHash;
  }
  return entry?.checksum
    ?? entry?.hash
    ?? entry?.provenance?.checksum
    ?? entry?.provenance?.hash
    ?? null;
}

// Integrity is "established" only when a declared and a computed hash exist,
// use the same normalized algorithm, and match. Differing algorithms are NOT
// compared (the policy refuses to guess across algorithms) and never count as
// a match.
function resolveIntegrity(entry, facts) {
  const declared = normalizeIntegrityHash(readDeclaredHash(entry, facts));
  const computed = normalizeIntegrityHash(facts.computedHash);
  const evidence = [{
    source: "declared-integrity",
    algorithm: declared?.algorithm || null,
    present: Boolean(declared),
  }, {
    source: "computed-integrity",
    algorithm: computed?.algorithm || null,
    present: Boolean(computed),
  }];

  if (!declared || !computed) {
    return {
      established: false,
      mismatch: false,
      comparable: false,
      reasonCode: "INTEGRITY_FACTS_INCOMPLETE",
      declared,
      computed,
      evidence,
    };
  }
  if (declared.algorithm !== computed.algorithm) {
    return {
      established: false,
      mismatch: false,
      comparable: false,
      reasonCode: "INTEGRITY_ALGORITHM_MISMATCH",
      declared,
      computed,
      evidence,
    };
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

function readProvider(entry, facts) {
  return String(
    facts.provider
    || entry?.provider
    || entry?.provenance?.source
    || entry?.source
    || "",
  ).trim().toLowerCase();
}

function readSourceHost(sourceUrl) {
  const url = nonEmptyString(sourceUrl) ? String(sourceUrl).trim() : "";
  if (!url) {
    return null;
  }
  const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function isVerifiedAttestation(attestation) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return false;
  }
  if (attestation.verified !== true) {
    return false;
  }
  const scheme = String(attestation.scheme || "").trim().toLowerCase();
  const signer = String(attestation.signer || attestation.identity || "").trim();
  return ATTESTATION_SCHEME_SET.has(scheme) && signer !== "";
}

// Publisher identity classes: "first-party", "signed", "third-party", "none".
// Order matters: a verified attestation outranks a first-party provenance
// string (a signed third-party artifact is trusted; an unsigned first-party
// artifact is still covered by rule 1 above only when integrity is known).
function classifyPublisher(entry, facts) {
  const attestation = facts.attestation || entry?.attestation || entry?.provenance?.attestation || entry?.provenance?.signature || null;
  if (isVerifiedAttestation(attestation)) {
    return {
      kind: "signed",
      identity: String(attestation.signer || attestation.identity || "").trim(),
      scheme: String(attestation.scheme).trim().toLowerCase(),
    };
  }

  const provider = readProvider(entry, facts);
  const author = String(entry?.author || entry?.publisher || "").trim().toLowerCase();
  if (FIRST_PARTY_SOURCE_SET.has(provider) || FIRST_PARTY_SOURCE_SET.has(author) || entry?.firstParty === true) {
    return {
      kind: "first-party",
      identity: FIRST_PARTY_SOURCE_SET.has(provider) ? provider : (author || "first-party"),
      scheme: null,
    };
  }

  const host = readSourceHost(facts.sourceUrl || entry?.sourceUrl || entry?.url);
  const identity = provider || author || host || "";
  if (identity) {
    return { kind: "third-party", identity, scheme: null };
  }
  return { kind: "none", identity: "", scheme: null };
}

function readKind(entry) {
  return String(entry?.kind || entry?.type || entry?.entryType || "").trim().toLowerCase();
}

// Whether the entry carries content AnxOS would run on the target host. An
// explicit boolean from the caller wins (the install paths derive it from the
// installer registry, which is the authoritative classifier); otherwise the
// entry's own shape is inspected.
function isExecutableEntry(entry, facts = {}) {
  if (typeof facts.executable === "boolean") {
    return facts.executable;
  }
  if (typeof entry?.executable === "boolean") {
    return entry.executable;
  }
  const kind = readKind(entry);
  if (kind === "dependency") {
    return true;
  }
  if (entry?.runtime === "docker" || entry?.startupType === "docker-image") {
    return true;
  }
  if (Array.isArray(entry?.downloads) && entry.downloads.length > 0) {
    return true;
  }
  if (Array.isArray(entry?.installScript) && entry.installScript.length > 0) {
    return true;
  }
  const installerType = String(
    entry?.installerType
    || entry?.installType
    || entry?.installer?.type
    || entry?.downloadSource?.type
    || "",
  ).trim().toLowerCase();
  if (EXECUTABLE_INSTALLER_TYPE_SET.has(installerType)) {
    return true;
  }
  const sourceType = String(entry?.downloadSource?.type || "").trim().toLowerCase();
  if (sourceType && sourceType !== "local-import") {
    return true;
  }
  if (entry?.installer && typeof entry.installer === "object" && !Array.isArray(entry.installer)) {
    return true;
  }
  return false;
}

function buildVerdict(verdict, code, reason, details = {}) {
  const message = TRUST_MESSAGES[verdict];
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
    verified: verdict === TRUST_VERDICTS.VERIFIED,
    publisher: details.publisher || null,
    publisherKind: details.publisherKind || "none",
    executable: Boolean(details.executable),
    integrity: {
      established: Boolean(details.integrity?.established),
      comparable: Boolean(details.integrity?.comparable),
      mismatch: Boolean(details.integrity?.mismatch),
      declared: details.integrity?.declared || null,
      computed: details.integrity?.computed || null,
      reasonCode: details.integrity?.reasonCode || "INTEGRITY_FACTS_INCOMPLETE",
      evidence: Array.isArray(details.integrity?.evidence) ? details.integrity.evidence : [],
    },
  };
}

// The single entry point. Pure: same (entry, facts) always yields the same
// verdict object, with no I/O, clock, randomness or environment reads.
//
// facts:
//   declaredHash  {algorithm,value} | "sha256:<hex>" | null   (falls back to entry.checksum/hash/provenance.checksum)
//   computedHash  {algorithm,value} | "sha256:<hex>" | null
//   provider      string
//   sourceUrl     string
//   attestation   {scheme, signer, verified:true} | null
//   executable    boolean (caller-derived; overrides entry introspection)
function evaluatePublisherTrust(entry = {}, facts = {}) {
  const publisher = classifyPublisher(entry || {}, facts || {});
  const integrity = resolveIntegrity(entry || {}, facts || {});
  const executable = isExecutableEntry(entry || {}, facts || {});
  const details = { publisher: publisher.identity || null, publisherKind: publisher.kind, executable, integrity };

  // 1. A declared/computed disagreement is always the verdict, whatever the
  //    publisher claims. Never verified.
  if (integrity.mismatch) {
    return buildVerdict(
      TRUST_VERDICTS.HASH_MISMATCH,
      TRUST_CODES.HASH_MISMATCH,
      `Declared ${integrity.declared.algorithm} hash does not match the computed hash for this entry.`,
      details,
    );
  }

  // 2. Verified requires a trusted publisher AND an established integrity match.
  if (integrity.established && publisher.kind === "signed") {
    return buildVerdict(
      TRUST_VERDICTS.VERIFIED,
      TRUST_CODES.VERIFIED_SIGNED,
      `Attestation verified by ${publisher.identity} and the integrity hash matches.`,
      details,
    );
  }
  if (integrity.established && publisher.kind === "first-party") {
    return buildVerdict(
      TRUST_VERDICTS.VERIFIED,
      TRUST_CODES.VERIFIED_FIRST_PARTY,
      `First-party publisher (${publisher.identity}) and the integrity hash matches.`,
      details,
    );
  }

  // 3. An identifiable but unverifiable publisher is named as such, whether or
  //    not a self-declared hash happened to match.
  if (publisher.kind === "third-party") {
    return buildVerdict(
      TRUST_VERDICTS.UNVERIFIED_PUBLISHER,
      TRUST_CODES.UNVERIFIED_PUBLISHER,
      integrity.established
        ? `Publisher "${publisher.identity}" is not first-party and carries no verified attestation; an integrity match alone does not establish publisher trust.`
        : `Publisher "${publisher.identity}" is not first-party and carries no verified attestation.`,
      details,
    );
  }

  // 4. Integrity established but no trusted publisher identity at all: a
  //    self-declared hash is not a publisher.
  if (integrity.established) {
    return buildVerdict(
      TRUST_VERDICTS.UNVERIFIED_PUBLISHER,
      TRUST_CODES.UNVERIFIED_PUBLISHER,
      "The integrity hash matches, but no publisher identity is present to attribute the declaration to.",
      details,
    );
  }

  // 5. Executable content with no established integrity: unsigned.
  if (executable) {
    return buildVerdict(
      TRUST_VERDICTS.UNSIGNED_EXECUTABLE,
      TRUST_CODES.UNSIGNED_EXECUTABLE,
      publisher.kind === "first-party" || publisher.kind === "signed"
        ? `Executable content from ${publisher.identity || "a trusted publisher"} carries no verifiable integrity hash.`
        : "Executable content carries no verifiable integrity hash.",
      details,
    );
  }

  // 6. Nothing to check: no publisher identity and no integrity facts.
  return buildVerdict(
    TRUST_VERDICTS.UNKNOWN,
    TRUST_CODES.UNKNOWN,
    "No publisher identity and no integrity facts are available for this entry.",
    details,
  );
}

// The exact operator text for a verdict, or for a verdict object. Returns a
// copy so a caller cannot mutate the policy's frozen copy.
function describeTrustVerdict(verdict) {
  const key = typeof verdict === "string" ? verdict : verdict?.verdict;
  const message = TRUST_MESSAGES[key];
  if (!message) {
    return {
      verdict: key || null,
      severity: "warning",
      title: "Publisher trust unknown",
      body: TRUST_MESSAGES[TRUST_VERDICTS.UNKNOWN].body,
      action: TRUST_MESSAGES[TRUST_VERDICTS.UNKNOWN].action,
      requiresReview: true,
      allowInstall: true,
    };
  }
  return { verdict: key, ...message };
}

module.exports = {
  ATTESTATION_SCHEMES,
  EXECUTABLE_INSTALLER_TYPES,
  FIRST_PARTY_SOURCES,
  TRUST_CODES,
  TRUST_MESSAGES,
  TRUST_VERDICTS,
  classifyPublisher,
  describeTrustVerdict,
  evaluatePublisherTrust,
  isExecutableEntry,
  normalizeIntegrityHash,
  resolveIntegrity,
};