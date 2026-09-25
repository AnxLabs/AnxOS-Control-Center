const assert = require("assert");

// V2-D catalog export/import smoke (roadmap V2-D bullet 8; the shipped state and
// its honest limits are recorded in docs/KNOWN_LIMITATIONS.md "Publisher trust
// and catalog export/import are shipped, with honesty caveats").
//
// Hermetic: no network, no agent, no electron, no filesystem. Everything is
// driven through the service's public functions, and the fixtures are validated
// by the same manifest policy the live curated catalog uses.

const {
  CATALOG_DOCUMENT_TYPE,
  CATALOG_TRANSFER_SCHEMA_VERSION,
  MAX_DOCUMENT_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  OFFLINE_INSTALL_LIMITS,
  buildCatalogExport,
  exportCatalog,
  getOfflineInstallLimits,
  importCatalog,
  stableStringify,
} = require("../src/services/catalogTransferService");
const { TRUST_VERDICTS } = require("../src/shared/publisherTrustPolicy");

function templateFixture(id, overrides = {}) {
  return {
    id,
    displayName: `Smoke ${id}`,
    category: "Utilities",
    version: "1.0.0",
    packageVersion: "1.0.0",
    installerType: "direct-download",
    provenance: { source: "anxos-catalog" },
    checksum: null,
    downloads: [{ type: "url", url: `https://example.invalid/${id}.zip`, destination: `${id}.zip` }],
    ...overrides,
  };
}

const TEMPLATE_A = templateFixture("smoke-alpha");
const TEMPLATE_B = templateFixture("smoke-beta");
const DEPENDENCY = { kind: "dependency", id: "java", content: { id: "java" } };

// ---------------------------------------------------------------------------
// 1. Contract shape: versioned document, self-describing limits, stable key
//    order, deterministic bytes.
// ---------------------------------------------------------------------------
assert.strictEqual(CATALOG_TRANSFER_SCHEMA_VERSION, 1, "The transfer schema version is the contracted v1.");
assert.strictEqual(CATALOG_DOCUMENT_TYPE, "anxos.marketplace.catalog-transfer");
assert.deepStrictEqual([MAX_DOCUMENT_BYTES, MAX_ENTRIES, MAX_ENTRY_BYTES], [2 * 1024 * 1024, 500, 128 * 1024], "The document bounds must be the documented ones.");

const exported = exportCatalog({ catalog: [TEMPLATE_A, TEMPLATE_B], userEntries: [templateFixture("smoke-user")], entries: [DEPENDENCY] });
assert.deepStrictEqual(
  Object.keys(JSON.parse(exported.json)),
  ["documentType", "entries", "entryCount", "limits", "schemaVersion"],
  "Export keys must be in stable sorted order so an export is diffable.",
);
assert.strictEqual(exported.document.schemaVersion, CATALOG_TRANSFER_SCHEMA_VERSION);
assert.strictEqual(exported.document.documentType, CATALOG_DOCUMENT_TYPE);
assert.strictEqual(exported.entryCount, 4, "The curated catalog, user entries and extra entries must all be exported.");
assert.strictEqual(exported.document.limits.length, OFFLINE_INSTALL_LIMITS.length, "The document must carry the offline limits.");
assert.strictEqual(exported.bytes, Buffer.byteLength(exported.json, "utf8"));

// Determinism: same content, different input order and different key insertion
// order, must serialize byte-identically.
const reordered = exportCatalog({
  catalog: [TEMPLATE_B, TEMPLATE_A].map((template) => {
    const reversed = {};
    for (const key of Object.keys(template).reverse()) reversed[key] = template[key];
    return reversed;
  }),
  userEntries: [templateFixture("smoke-user")],
  entries: [DEPENDENCY],
});
assert.strictEqual(reordered.json, exported.json, "Input order and key insertion order must not change the exported bytes.");

// `exportedAt` is opt-in so a default export stays byte-stable.
assert.strictEqual(exported.document.exportedAt, undefined, "A default export must not embed a timestamp that would break diffability.");
const stampedA = exportCatalog({ catalog: [TEMPLATE_A] });
const stampedB = exportCatalog({ catalog: [TEMPLATE_A], now: "2026-01-02T03:04:05.000Z" });
assert.strictEqual(stampedA.json.includes("exportedAt"), false, "A default export must not embed a timestamp.");
assert.strictEqual(stampedB.json.includes("exportedAt"), true, "An explicit options.now must be the only thing that adds a timestamp.");
assert.strictEqual(stampedB.document.exportedAt, "2026-01-02T03:04:05.000Z");
const stampedWithoutTime = { ...stampedB.document };
delete stampedWithoutTime.exportedAt;
assert.strictEqual(stableStringify(stampedWithoutTime), stampedA.json, "The timestamp must be the only difference a caller-supplied time introduces.");
assert.strictEqual(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}', "stableStringify must sort recursively and preserve array order.");
assert.strictEqual(stableStringify({ a: undefined, b: 1 }), '{"b":1}', "Undefined fields must be dropped, not serialized as null.");

// ---------------------------------------------------------------------------
// 2. Round trip: export -> import is lossless for realistic entries.
// ---------------------------------------------------------------------------
const roundTrip = importCatalog(exported.json, { existingEntries: [] });
assert.deepStrictEqual(roundTrip.counts, { considered: 4, accepted: 4, rejected: 0, unchanged: 0 }, "A clean document must import every entry.");
assert.deepStrictEqual(roundTrip.rejected, []);
assert.deepStrictEqual(roundTrip.schemaVersion, CATALOG_TRANSFER_SCHEMA_VERSION);
assert.deepStrictEqual(roundTrip.documentVersion, 1);
const importedById = new Map(roundTrip.accepted.map((entry) => [entry.id, entry]));
assert.deepStrictEqual(importedById.get("smoke-alpha").content, TEMPLATE_A, "Imported content must be byte-identical to the exported content.");
assert.deepStrictEqual(importedById.get("smoke-beta").content, TEMPLATE_B);
assert.deepStrictEqual(importedById.get("java").content, { id: "java" });
assert.strictEqual(importedById.get("java").kind, "dependency");
// Import refuses to trust the exporting instance's verdict: it recomputes.
for (const entry of roundTrip.accepted) {
  assert.notStrictEqual(entry.trust.verdict, TRUST_VERDICTS.VERIFIED, `Imported entry ${entry.id} must never be verified offline.`);
  assert.strictEqual(entry.trust.verified, false);
  assert(entry.trust.title && entry.trust.message && entry.trust.action, "Each imported entry must carry renderable trust text.");
}
assert.strictEqual(roundTrip.accepted.length, 4, "POSITIVE CONTROL: a validator that rejected everything could not import this document.");

// ---------------------------------------------------------------------------
// 3. A newer schema version is refused explicitly (never partially imported).
// ---------------------------------------------------------------------------
for (const newerVersion of [2, 7, CATALOG_TRANSFER_SCHEMA_VERSION + 1]) {
  const newer = { ...buildCatalogExport({ catalog: [TEMPLATE_A] }), schemaVersion: newerVersion };
  assert.throws(
    () => importCatalog(newer, { existingEntries: [] }),
    (error) => error.code === "CATALOG_SCHEMA_UNSUPPORTED" && error.details.documentVersion === newerVersion && error.details.supportedVersion === CATALOG_TRANSFER_SCHEMA_VERSION,
    `A schemaVersion ${newerVersion} document must be refused with CATALOG_SCHEMA_UNSUPPORTED.`,
  );
}
assert.throws(() => importCatalog({ documentType: CATALOG_DOCUMENT_TYPE, entries: [] }, {}), (error) => error.code === "CATALOG_DOCUMENT_INVALID", "A document with no schemaVersion must be refused.");
assert.throws(() => importCatalog({ documentType: CATALOG_DOCUMENT_TYPE, schemaVersion: 1, entries: {} }, {}), (error) => error.code === "CATALOG_DOCUMENT_INVALID", "A non-array entries field must be refused.");
assert.throws(() => importCatalog({ documentType: "other", schemaVersion: 1, entries: [] }, {}), (error) => error.code === "CATALOG_DOCUMENT_INVALID", "A foreign documentType must be refused.");
assert.throws(() => importCatalog("{ not json", {}), (error) => error.code === "CATALOG_DOCUMENT_UNPARSEABLE");

// ---------------------------------------------------------------------------
// 4. Duplicate and conflicting entries are refused, never silently overwritten.
// ---------------------------------------------------------------------------
const duplicateDoc = {
  documentType: CATALOG_DOCUMENT_TYPE,
  schemaVersion: 1,
  entries: [
    { kind: "template", id: "smoke-alpha", content: TEMPLATE_A },
    { kind: "template", id: "smoke-alpha", content: templateFixture("smoke-alpha", { displayName: "Hijacked" }) },
  ],
};
const duplicateResult = importCatalog(duplicateDoc, { existingEntries: [] });
assert.strictEqual(duplicateResult.counts.accepted, 1, "The first occurrence of a duplicated entry must be the one used.");
assert.strictEqual(duplicateResult.counts.rejected, 1);
assert.strictEqual(duplicateResult.rejected[0].code, "DUPLICATE_ENTRY_IN_DOCUMENT", "A repeated kind+id inside one document must be refused.");
assert.strictEqual(duplicateResult.accepted[0].content.displayName, "Smoke smoke-alpha", "The first occurrence must not be overwritten by the later one.");

const conflictResult = importCatalog(
  { documentType: CATALOG_DOCUMENT_TYPE, schemaVersion: 1, entries: [{ kind: "template", id: "smoke-alpha", content: TEMPLATE_A }] },
  { existingEntries: [{ kind: "template", id: "smoke-alpha", content: templateFixture("smoke-alpha", { displayName: "Already Installed" }) }] },
);
assert.strictEqual(conflictResult.counts.accepted, 0, "A conflicting entry must not be imported.");
assert.strictEqual(conflictResult.counts.rejected, 1);
assert.strictEqual(conflictResult.counts.unchanged, 0);
assert.strictEqual(conflictResult.rejected[0].code, "CATALOG_ENTRY_CONFLICT", "Different content for an existing kind+id must be a conflict.");
assert.match(conflictResult.rejected[0].message, /already exists in this catalog with different content/);

const unchangedResult = importCatalog(
  { documentType: CATALOG_DOCUMENT_TYPE, schemaVersion: 1, entries: [{ kind: "template", id: "smoke-alpha", content: TEMPLATE_A }] },
  { existingEntries: [{ kind: "template", id: "smoke-alpha", content: TEMPLATE_A }] },
);
assert.deepStrictEqual(unchangedResult.counts, { considered: 1, accepted: 0, rejected: 0, unchanged: 1 }, "An identical existing entry must be unchanged, not a conflict and not re-imported.");
assert.strictEqual(unchangedResult.unchanged[0].id, "smoke-alpha");

// ---------------------------------------------------------------------------
// 5. Bounded document size and bounded entry size.
// ---------------------------------------------------------------------------
const oversizeDoc = { documentType: CATALOG_DOCUMENT_TYPE, schemaVersion: 1, entries: [], padding: "x".repeat(MAX_DOCUMENT_BYTES + 1) };
assert.throws(() => importCatalog(JSON.stringify(oversizeDoc), {}), (error) => error.code === "CATALOG_DOCUMENT_TOO_LARGE" && error.details.bytes > MAX_DOCUMENT_BYTES, "An oversized document must be refused.");
assert.throws(() => importCatalog(oversizeDoc, {}), (error) => error.code === "CATALOG_DOCUMENT_TOO_LARGE", "An oversized in-memory object must be refused too.");
assert.throws(
  () => importCatalog({ documentType: CATALOG_DOCUMENT_TYPE, schemaVersion: 1, entries: new Array(MAX_ENTRIES + 1).fill(null).map((_, index) => ({ kind: "template", id: `t${index}`, content: {} })) }, {}),
  (error) => error.code === "CATALOG_ENTRY_LIMIT_EXCEEDED" && error.details.maxEntries === MAX_ENTRIES,
  "A document over the entry limit must be refused before per-entry work.",
);
assert.throws(() => importCatalog([], {}), (error) => error.code === "CATALOG_DOCUMENT_INVALID", "A non-object document must be refused.");
assert.throws(
  () => exportCatalog({ catalog: [templateFixture("smoke-huge", { notes: "y".repeat(MAX_ENTRY_BYTES + 1024) })] }),
  (error) => error.code === "CATALOG_ENTRY_TOO_LARGE",
  "An export containing an oversized entry must be refused.",
);

// ---------------------------------------------------------------------------
// 6. Import never grants trust the facts do not justify.
// ---------------------------------------------------------------------------
const claimedVerified = {
  documentType: CATALOG_DOCUMENT_TYPE,
  schemaVersion: 1,
  entries: [{
    kind: "template",
    id: "smoke-claimed",
    content: templateFixture("smoke-claimed", {
      checksum: `sha256:${"a".repeat(64)}`,
      provenance: { source: "anxos-catalog", attestation: { scheme: "cosign", signer: "somebody", verified: true } },
    }),
    trust: { verdict: "verified", code: "TRUST_VERIFIED_SIGNED", verified: true },
  }],
};
const claimedResult = importCatalog(claimedVerified, { existingEntries: [] });
assert.strictEqual(claimedResult.counts.accepted, 0, "An entry declaring verified without justifying it must not be imported.");
assert.strictEqual(claimedResult.rejected[0].code, "UNJUSTIFIED_VERIFIED_TRUST");
assert.strictEqual(claimedResult.rejected[0].details.evaluatedVerdict, TRUST_VERDICTS.UNSIGNED_EXECUTABLE, "The re-evaluated verdict must be the honest offline one.");
assert.strictEqual(claimedResult.rejected[0].details.declaredVerdict, "verified");

const honestDeclared = importCatalog(
  { ...claimedVerified, entries: [{ ...claimedVerified.entries[0], trust: { verdict: "unsigned-executable", code: "TRUST_UNSIGNED_EXECUTABLE" } }] },
  { existingEntries: [] },
);
assert.strictEqual(honestDeclared.counts.accepted, 1, "The same entry with an honest declaration must import.");
assert.strictEqual(honestDeclared.accepted[0].trust.verdict, TRUST_VERDICTS.UNSIGNED_EXECUTABLE, "A declared attestation + checksum must not become verified offline.");
assert.strictEqual(honestDeclared.accepted[0].trust.verified, false);
assert.strictEqual(honestDeclared.warnings.length, 1, "A non-verified import must raise a review warning.");

// Claims of verified from PASTED JSON are subject to the same rule (UPPERCASE key is not honoured).
const noiseClaim = importCatalog(
  { ...claimedVerified, entries: [{ ...claimedVerified.entries[0], trust: { Verified: true, verdict: "VERIFIED" } }] },
  { existingEntries: [] },
);
assert.strictEqual(noiseClaim.counts.accepted, 0, "A case-variant verified claim must still be refused.");
assert.strictEqual(noiseClaim.rejected[0].code, "UNJUSTIFIED_VERIFIED_TRUST");

// ---------------------------------------------------------------------------
// 7. Every field is validated with the live catalog's own policy.
// ---------------------------------------------------------------------------
const invalidResult = importCatalog(
  {
    documentType: CATALOG_DOCUMENT_TYPE,
    schemaVersion: 1,
    entries: [
      { kind: "template", id: "smoke-no-name", content: { id: "smoke-no-name", category: "Utilities", installerType: "direct-download", downloads: [{}] } },
      { kind: "template", id: "no-ports", content: templateFixture("no-ports", { defaultPorts: [0] }) },
      { kind: "dependency", id: "not-a-dependency", content: { id: "not-a-dependency" } },
      { kind: "widget", id: "wrong-kind", content: {} },
      { kind: "template", id: "BAD ID!", content: templateFixture("bad-id") },
    ],
  },
  { existingEntries: [] },
);
assert.strictEqual(invalidResult.counts.accepted, 0, "No invalid entry may be accepted.");
assert.strictEqual(invalidResult.counts.rejected, 5);
const rejectCodes = invalidResult.rejected.map((entry) => entry.code);
assert.deepStrictEqual(rejectCodes, [
  "MARKETPLACE_MANIFEST_INVALID",
  "PORT_INVALID",
  "DEPENDENCY_UNSUPPORTED",
  "CATALOG_ENTRY_KIND_UNSUPPORTED",
  "CATALOG_ENTRY_ID_INVALID",
], `Rejection codes must come from the live validators, got ${JSON.stringify(rejectCodes)}`);

// ---------------------------------------------------------------------------
// 8. Offline installation limits are documented and returned in the result.
// ---------------------------------------------------------------------------
const limits = getOfflineInstallLimits();
assert.strictEqual(limits.length, OFFLINE_INSTALL_LIMITS.length);
assert(limits.length >= 6, "The offline limits list must cover the documented gaps.");
for (const limit of limits) {
  assert(limit.code && limit.title && limit.detail, `Offline limit ${limit.code} must be self-describing.`);
}
assert.deepStrictEqual(
  limits.map((limit) => limit.code),
  ["NO-DOWNLOAD-VERIFICATION", "NO-PROVIDER-METADATA", "NO-ATTESTATION-VERIFICATION", "NO-DEPENDENCY-PROBE", "NO-CERTIFICATION-REFRESH", "NO-IMAGE-TRANSFER", "NO-VERIFICATION-TRANSFER"],
  "The offline limits must be exactly the documented set.",
);
assert.match(limits.find((limit) => limit.code === "NO-DOWNLOAD-VERIFICATION").detail, /never `verified`/);
assert.match(limits.find((limit) => limit.code === "NO-PROVIDER-METADATA").detail, /re-resolved online/);
assert.deepStrictEqual(roundTrip.offlineLimits.map((limit) => limit.code), limits.map((limit) => limit.code), "The import result must return the offline limits for the UI.");
assert(limits !== getOfflineInstallLimits(), "The limits must be returned as copies so a caller cannot mutate the policy list.");

console.log(`catalog-transfer-smoke passed: ${exported.entryCount}-entry round trip byte-identical, schema/newer/oversize/over-count refused, duplicates + conflicts refused (R1: first occurrence wins, R2: different content is a conflict), ${limits.length} offline limits returned.`);