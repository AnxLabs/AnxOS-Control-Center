// V2-D catalog export/import (roadmap V2-D bullet 8 /
// docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md §3, see also
// docs/KNOWN_LIMITATIONS.md "Two V2-D roadmap items remain missing").
//
// OFFLINE INSTALLATION LIMITS — what an imported catalog can and cannot do
// without network access. These are returned in every import result so the UI
// can show them, and they are the honest statement of what import does NOT
// establish:
//
//   1. NO-DOWNLOAD-VERIFICATION  Import never fetches the package payload, so
//      no hash can be computed for it. An imported executable entry therefore
//      carries no established integrity: the trust verdict for such an entry
//      is `unsigned-executable` (first-party publisher, unknown bytes) or
//      `unverified-publisher` (third-party publisher) — never `verified`. The
//      declared `checksum` is recorded verbatim; it is not a verification.
//   2. NO-PROVIDER-METADATA  Provider-backed entries (Modrinth, CurseForge,
//      SteamCMD) cannot resolve projects, versions, file ids or download URLs
//      offline. Their provider fields are recorded verbatim and must be
//      re-resolved online before an install can proceed.
//   3. NO-ATTESTATION-VERIFICATION  There is no public-key infrastructure in
//      this repository. A document that claims `attestation.verified: true`
//      is NOT trusted on that basis: import re-evaluates the claim against the
//      facts actually present and refuses any entry that declares itself
//      `verified` without justifying it.
//   4. NO-DEPENDENCY-PROBE  Host runtime requirements (Java, Docker, SteamCMD,
//      .NET) are not probed at import time. A declared requirement is a
//      statement by the publisher; the install-time dependency check still
//      decides whether the host satisfies it.
//   5. NO-CERTIFICATION-REFRESH  Server-compatibility certifications
//      (config/marketplace-server-certifications.json) are not part of the
//      transfer document. Imported entries are re-evaluated against the local
//      registry on the next online read.
//   6. NO-IMAGE-TRANSFER  Screenshots and other referenced assets are not
//      embedded. An imported entry that references an asset URL will show it
//      only when that URL is reachable.
//   7. NO-VERIFICATION-TRANSFER  A publisher-verified entry cannot be
//      re-established offline: a document cannot prove anything about bytes it
//      does not contain, so an entry that declares itself `verified` without
//      the facts to justify it is refused outright (UNJUSTIFIED_VERIFIED_TRUST)
//      rather than imported with a softer label. Re-verify online after import.
//
// What import DOES guarantee: the document is structurally validated, every
// entry is validated with the same manifest policy the live curated catalog
// uses (marketplaceInstallerRegistry.validateMarketplaceTemplate for templates,
// marketplaceDependencies.assertKnownDependencyId for dependencies), entries
// that are already present and identical are left unchanged, and entries that
// duplicate or conflict with an existing catalog entry are refused rather than
// silently overwriting it.

const {
  getTemplateInstallerType,
  validateMarketplaceTemplate,
} = require("./marketplaceInstallerRegistry");
const { assertKnownDependencyId } = require("../shared/marketplaceDependencies");
const {
  TRUST_VERDICTS,
  evaluatePublisherTrust,
} = require("../shared/publisherTrustPolicy");

const CATALOG_TRANSFER_SCHEMA_VERSION = 1;
const CATALOG_DOCUMENT_TYPE = "anxos.marketplace.catalog-transfer";

// Bounded document size. 2 MiB is ~100x the shipped curated catalog
// (config/marketplace-templates.json is about 60 KB), so a legitimate export
// never approaches it while a hostile or corrupted document is refused before
// any parsing work scales with it.
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_ENTRY_BYTES = 128 * 1024;
const MAX_ID_LENGTH = 64;

const ENTRY_KINDS = Object.freeze(["template", "dependency"]);
const ENTRY_KIND_SET = new Set(ENTRY_KINDS);

class CatalogTransferError extends Error {
  constructor(message, code = "CATALOG_TRANSFER_ERROR", details = {}) {
    super(message);
    this.name = "CatalogTransferError";
    this.code = code;
    this.details = details;
  }
}

const OFFLINE_INSTALL_LIMITS = Object.freeze([
  Object.freeze({
    code: "NO-DOWNLOAD-VERIFICATION",
    title: "Package payloads are not verified offline",
    detail: "Import does not fetch or hash the package payload, so an imported executable entry is never `verified`. Apply an integrity hash and re-verify online before relying on it.",
  }),
  Object.freeze({
    code: "NO-PROVIDER-METADATA",
    title: "Provider metadata cannot be fetched offline",
    detail: "Modrinth, CurseForge and SteamCMD projects, versions, file ids and download URLs are recorded verbatim and must be re-resolved online before install.",
  }),
  Object.freeze({
    code: "NO-ATTESTATION-VERIFICATION",
    title: "Attestations are not cryptographically verified",
    detail: "This build has no public-key infrastructure. A claimed signature is re-evaluated against the facts in the document and never trusted on the claim alone.",
  }),
  Object.freeze({
    code: "NO-DEPENDENCY-PROBE",
    title: "Host dependencies are not probed at import",
    detail: "Declared runtime requirements (Java, Docker, SteamCMD, .NET) are statements by the publisher; the install-time dependency check still decides.",
  }),
  Object.freeze({
    code: "NO-CERTIFICATION-REFRESH",
    title: "Server certifications are not transferred",
    detail: "config/marketplace-server-certifications.json is not part of the document; imported entries are re-evaluated against the local registry on the next online read.",
  }),
  Object.freeze({
    code: "NO-IMAGE-TRANSFER",
    title: "Referenced assets are not embedded",
    detail: "Screenshots and other referenced assets are not transferred; they resolve only while their URLs are reachable.",
  }),
  Object.freeze({
    code: "NO-VERIFICATION-TRANSFER",
    title: "Publisher verification does not survive transfer",
    detail: "A document cannot prove anything about bytes it does not contain, so an entry that declares a verified publisher without justifying it is refused. Re-verify online after import.",
  }),
]);

function getOfflineInstallLimits() {
  return OFFLINE_INSTALL_LIMITS.map((limit) => ({ ...limit }));
}

// Deterministic serialization: object keys are sorted recursively and array
// order is preserved. Combined with the entry sort in buildCatalogExport this
// makes an export byte-stable, so two exports of the same catalog diff cleanly.
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function compareEntries(left, right) {
  const kindDelta = String(left.kind).localeCompare(String(right.kind));
  return kindDelta !== 0 ? kindDelta : String(left.id).localeCompare(String(right.id));
}

// Trust facts a transfer client can actually offer for one entry. `computedHash`
// is deliberately always null: nothing is downloaded during export or import.
function buildEntryTrustFacts(entry = {}) {
  const templateLike = entry.kind === "template";
  return {
    provider: entry.provider || entry.content?.provider || entry.content?.provenance?.source || "",
    sourceUrl: entry.sourceUrl || entry.content?.sourceUrl || entry.content?.url || "",
    executable: entry.executable !== undefined
      ? Boolean(entry.executable)
      : templateLike
        ? getTemplateInstallerType(entry.content || {}) !== "no-install"
        : true,
    declaredHash: entry.declaredHash !== undefined ? entry.declaredHash : entry.content?.checksum ?? null,
    computedHash: null,
    attestation: entry.attestation || entry.content?.provenance?.attestation || null,
  };
}

function evaluateEntryTrust(entry = {}) {
  return evaluatePublisherTrust(entry.content || entry, buildEntryTrustFacts(entry));
}

// Canonical export entry. `content` is the entry definition verbatim (so a
// re-import can rebuild the catalog item); `trust` is the policy verdict for
// that content and is informational — import recomputes it from scratch.
function normalizeExportEntry(entry = {}, kind = null) {
  const resolvedKind = String(kind || entry.kind || entry.entryType || "").trim().toLowerCase();
  if (!ENTRY_KIND_SET.has(resolvedKind)) {
    throw new CatalogTransferError(
      `Catalog export entry has an unsupported kind "${resolvedKind || "(missing)"}".`,
      "CATALOG_ENTRY_KIND_UNSUPPORTED",
      { kind: resolvedKind || null },
    );
  }
  const content = cloneJson(resolvedKind === "template" ? entry.content || entry.template || entry : entry.content || entry) || {};
  const id = String(entry.id || content.id || "").trim();
  if (!id) {
    throw new CatalogTransferError("Catalog export entry is missing an id.", "CATALOG_ENTRY_ID_MISSING", { kind: resolvedKind });
  }
  const trust = evaluateEntryTrust({ ...entry, kind: resolvedKind, content });
  const normalized = {
    kind: resolvedKind,
    id,
    content,
    trust: {
      verdict: trust.verdict,
      code: trust.code,
      verified: trust.verified,
      requiresReview: trust.requiresReview,
    },
  };
  const size = byteLength(stableStringify(normalized));
  if (size > MAX_ENTRY_BYTES) {
    throw new CatalogTransferError(
      `Catalog entry "${id}" exceeds the ${MAX_ENTRY_BYTES}-byte entry limit.`,
      "CATALOG_ENTRY_TOO_LARGE",
      { kind: resolvedKind, id, bytes: size, maxBytes: MAX_ENTRY_BYTES },
    );
  }
  return normalized;
}

function buildCatalogExport(options = {}) {
  const curated = Array.isArray(options.catalog) ? options.catalog : [];
  const userEntries = Array.isArray(options.userEntries) ? options.userEntries : [];
  const extra = Array.isArray(options.entries) ? options.entries : [];

  const entries = [
    ...curated.map((entry) => normalizeExportEntry(entry, "template")),
    ...userEntries.map((entry) => normalizeExportEntry(entry, "template")),
    ...extra.map((entry) => normalizeExportEntry(entry)),
  ].sort(compareEntries);

  const document = {
    documentType: CATALOG_DOCUMENT_TYPE,
    schemaVersion: CATALOG_TRANSFER_SCHEMA_VERSION,
    entryCount: entries.length,
    limits: getOfflineInstallLimits(),
    entries,
  };
  // `exportedAt` is opt-in. Omitting it by default keeps an export byte-stable
  // across runs (diffable); pass options.now when an audit timestamp is needed.
  if (options.now !== undefined && options.now !== null) {
    document.exportedAt = new Date(options.now).toISOString();
  }
  if (isPlainObject(options.source)) {
    document.source = cloneJson(options.source);
  }
  return document;
}

function exportCatalog(options = {}) {
  const document = buildCatalogExport(options);
  const json = stableStringify(document);
  const bytes = byteLength(json);
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new CatalogTransferError(
      `Catalog export exceeds the ${MAX_DOCUMENT_BYTES}-byte document limit.`,
      "CATALOG_DOCUMENT_TOO_LARGE",
      { bytes, maxBytes: MAX_DOCUMENT_BYTES, entryCount: document.entryCount },
    );
  }
  return {
    document,
    json,
    bytes,
    entryCount: document.entryCount,
    schemaVersion: CATALOG_TRANSFER_SCHEMA_VERSION,
    limits: getOfflineInstallLimits(),
  };
}

function requireBoundedDocument(input) {
  if (typeof input === "string") {
    const bytes = byteLength(input);
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new CatalogTransferError(
        `Catalog document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit.`,
        "CATALOG_DOCUMENT_TOO_LARGE",
        { bytes, maxBytes: MAX_DOCUMENT_BYTES },
      );
    }
    try {
      return { document: JSON.parse(input), bytes };
    } catch (error) {
      throw new CatalogTransferError("Catalog document is not valid JSON.", "CATALOG_DOCUMENT_UNPARSEABLE", {
        message: error?.message || null,
      });
    }
  }
  if (!isPlainObject(input)) {
    throw new CatalogTransferError("Catalog document must be a JSON object.", "CATALOG_DOCUMENT_INVALID", {
      receivedType: Array.isArray(input) ? "array" : typeof input,
    });
  }
  const serialized = stableStringify(input);
  const bytes = byteLength(serialized);
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new CatalogTransferError(
      `Catalog document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit.`,
      "CATALOG_DOCUMENT_TOO_LARGE",
      { bytes, maxBytes: MAX_DOCUMENT_BYTES },
    );
  }
  return { document: input, bytes };
}

function requireSupportedSchema(document) {
  const version = document?.schemaVersion;
  if (!Number.isInteger(version) || version < 1) {
    throw new CatalogTransferError("Catalog document has no valid schemaVersion.", "CATALOG_DOCUMENT_INVALID", {
      schemaVersion: version === undefined ? null : version,
    });
  }
  if (version > CATALOG_TRANSFER_SCHEMA_VERSION) {
    // Explicit refusal: a document written by a newer build may carry fields
    // this build would silently drop. Importing it partially would be worse
    // than refusing it.
    throw new CatalogTransferError(
      `Catalog document schemaVersion ${version} is newer than the supported version ${CATALOG_TRANSFER_SCHEMA_VERSION}. Update AnxOS before importing this catalog.`,
      "CATALOG_SCHEMA_UNSUPPORTED",
      { documentVersion: version, supportedVersion: CATALOG_TRANSFER_SCHEMA_VERSION },
    );
  }
  return version;
}

function validateTemplateEntryContent(content = {}) {
  const metadata = validateMarketplaceTemplate(content);
  return { installerType: metadata.installerType };
}

function validateDependencyEntryContent(id) {
  assertKnownDependencyId(id);
  return { installerType: "dependency" };
}

function contentFingerprint(content) {
  return stableStringify(content === undefined ? null : content);
}

// Import a catalog document.
//
// Throws (typed CatalogTransferError) only for whole-document failures: too
// large, unparseable, wrong documentType, missing/unsupported schemaVersion, a
// non-array entries field, or an entry count over the limit. Per-entry problems
// are reported in `rejected` and never abort the whole import.
function importCatalog(input, options = {}) {
  const { document, bytes } = requireBoundedDocument(input);
  const documentVersion = requireSupportedSchema(document);

  if (document.documentType !== CATALOG_DOCUMENT_TYPE) {
    throw new CatalogTransferError(
      `Catalog document type "${document.documentType || "(missing)"}" is not supported.`,
      "CATALOG_DOCUMENT_INVALID",
      { documentType: document.documentType || null, expected: CATALOG_DOCUMENT_TYPE },
    );
  }
  if (!Array.isArray(document.entries)) {
    throw new CatalogTransferError("Catalog document entries must be an array.", "CATALOG_DOCUMENT_INVALID", {
      receivedType: typeof document.entries,
    });
  }
  if (document.entries.length > MAX_ENTRIES) {
    throw new CatalogTransferError(
      `Catalog document declares ${document.entries.length} entries, over the ${MAX_ENTRIES}-entry limit.`,
      "CATALOG_ENTRY_LIMIT_EXCEEDED",
      { entryCount: document.entries.length, maxEntries: MAX_ENTRIES },
    );
  }

  // Existing catalog: an entry is a conflict when the same kind+id already
  // exists with different content, and unchanged when it is byte-identical.
  // The rule is documented here and must not be "last write wins".
  const existing = new Map();
  for (const entry of Array.isArray(options.existingEntries) ? options.existingEntries : []) {
    const kind = String(entry?.kind || "template").trim().toLowerCase();
    const id = String(entry?.id || entry?.content?.id || "").trim();
    if (!id) continue;
    const content = cloneJson(kind === "template" ? entry.content || entry.template || entry : entry.content || entry) || {};
    existing.set(`${kind}:${id}`, contentFingerprint(content));
  }

  const seen = new Set();
  const accepted = [];
  const rejected = [];
  const unchanged = [];
  const warnings = [];

  for (const rawEntry of document.entries) {
    const kind = String(rawEntry?.kind || "").trim().toLowerCase();
    const id = String(rawEntry?.id || rawEntry?.content?.id || "").trim();
    const label = { kind: kind || null, id: id || null };

    if (!ENTRY_KIND_SET.has(kind)) {
      rejected.push({ ...label, code: "CATALOG_ENTRY_KIND_UNSUPPORTED", message: `Unsupported entry kind "${kind || "(missing)"}".` });
      continue;
    }
    if (!id || id.length > MAX_ID_LENGTH || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      rejected.push({ ...label, code: "CATALOG_ENTRY_ID_INVALID", message: `Entry id "${id || "(missing)"}" is invalid.` });
      continue;
    }

    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      // Documented duplicate rule: the first occurrence wins; a repeated
      // kind+id inside one document is refused rather than merged.
      rejected.push({ ...label, code: "DUPLICATE_ENTRY_IN_DOCUMENT", message: `Entry ${key} appears more than once in this document; the first occurrence was used.` });
      continue;
    }

    const content = cloneJson(rawEntry?.content) || {};
    if (!isPlainObject(content)) {
      rejected.push({ ...label, code: "CATALOG_ENTRY_INVALID", message: `Entry ${key} content must be an object.` });
      continue;
    }

    try {
      if (kind === "template") {
        validateTemplateEntryContent(content);
      } else {
        validateDependencyEntryContent(content.id || id);
      }
    } catch (error) {
      rejected.push({
        ...label,
        code: error?.code || "CATALOG_ENTRY_INVALID",
        message: error?.message || `Entry ${key} failed catalog validation.`,
      });
      continue;
    }

    // Duplicate/conflict rule: refuse rather than silently overwrite.
    if (existing.has(key)) {
      const same = existing.get(key) === contentFingerprint(content);
      if (same) {
        seen.add(key);
        unchanged.push({ ...label });
        continue;
      }
      rejected.push({
        ...label,
        code: "CATALOG_ENTRY_CONFLICT",
        message: `Entry ${key} already exists in this catalog with different content. Remove the existing entry first, or import it under a different id.`,
      });
      continue;
    }

    const trust = evaluateEntryTrust({ ...rawEntry, kind, id, content });

    // A document may claim anything; import trusts only the recomputed verdict.
    // An entry that declares itself verified without the facts to back it is
    // refused outright instead of being imported with a softer label.
    const declaredVerdict = String(rawEntry?.trust?.verdict || "").trim().toLowerCase();
    if (declaredVerdict === TRUST_VERDICTS.VERIFIED && trust.verdict !== TRUST_VERDICTS.VERIFIED) {
      rejected.push({
        ...label,
        code: "UNJUSTIFIED_VERIFIED_TRUST",
        message: `Entry ${key} declares a verified publisher, but the facts in this document do not establish it (evaluated: ${trust.verdict}).`,
        details: { declaredVerdict, evaluatedVerdict: trust.verdict, evaluatedCode: trust.code },
      });
      continue;
    }

    seen.add(key);
    accepted.push({
      kind,
      id,
      content,
      trust: {
        verdict: trust.verdict,
        code: trust.code,
        verified: trust.verified,
        requiresReview: trust.requiresReview,
        title: trust.operatorTitle,
        message: trust.operatorMessage,
        action: trust.operatorAction,
      },
    });
    if (trust.verdict !== TRUST_VERDICTS.VERIFIED) {
      warnings.push({
        kind,
        id,
        code: trust.code,
        message: trust.operatorMessage,
      });
    }
  }

  return {
    schemaVersion: CATALOG_TRANSFER_SCHEMA_VERSION,
    documentVersion,
    documentBytes: bytes,
    accepted,
    rejected,
    unchanged,
    warnings,
    offlineLimits: getOfflineInstallLimits(),
    counts: {
      considered: document.entries.length,
      accepted: accepted.length,
      rejected: rejected.length,
      unchanged: unchanged.length,
    },
  };
}

module.exports = {
  CATALOG_DOCUMENT_TYPE,
  CATALOG_TRANSFER_SCHEMA_VERSION,
  MAX_DOCUMENT_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  OFFLINE_INSTALL_LIMITS,
  CatalogTransferError,
  buildCatalogExport,
  exportCatalog,
  getOfflineInstallLimits,
  importCatalog,
  stableStringify,
};