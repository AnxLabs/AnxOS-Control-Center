const assert = require("assert");
const fs = require("fs");
const path = require("path");

// V2-D package-metadata contract smoke (docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md
// §3.1): versioned package fields (packageVersion / checksum / provenance) are
// enforced when present, remain opt-in for the shipped Marketplace 1.x catalog,
// and invalid metadata fails closed with distinct codes. Hermetic — no network.

const {
  MarketplaceManifestError,
  validateMarketplaceCatalog,
  validateMarketplaceTemplate,
} = require("../src/services/marketplaceInstallerRegistry");

const ROOT = path.join(__dirname, "..");

function validTemplate(overrides = {}) {
  return {
    id: "valid-v2-package",
    displayName: "V2 Package",
    category: "Applications",
    installerType: "direct-download",
    downloadSource: { type: "direct-download" },
    packageVersion: "2.1.0",
    checksum: `sha256:${"a".repeat(64)}`,
    provenance: { source: "anxos-catalog", author: "AnxOS" },
    ...overrides,
  };
}

function main() {
  // 1. A well-formed v2 package template validates.
  const valid = validateMarketplaceTemplate(validTemplate());
  assert.strictEqual(valid.supported, true, "A valid v2 package template must be supported.");
  assert.strictEqual(valid.installerType, "direct-download");

  // 2. A malformed checksum fails closed with a distinct code.
  assert.throws(
    () => validateMarketplaceTemplate(validTemplate({ checksum: "md5:abc123" })),
    (error) => error instanceof MarketplaceManifestError && error.code === "PACKAGE_CHECKSUM_INVALID",
    "A non-sha256 checksum must be rejected.",
  );
  assert.throws(
    () => validateMarketplaceTemplate(validTemplate({ checksum: "sha256:zz" })),
    (error) => error.code === "PACKAGE_CHECKSUM_INVALID",
    "A short sha256 checksum must be rejected.",
  );

  // 3. A malformed packageVersion fails closed.
  assert.throws(
    () => validateMarketplaceTemplate(validTemplate({ packageVersion: "not-a-version" })),
    (error) => error.code === "PACKAGE_VERSION_INVALID",
    "A non-semver packageVersion must be rejected.",
  );

  // 4. Provenance without a source fails closed.
  assert.throws(
    () => validateMarketplaceTemplate(validTemplate({ provenance: { author: "anon" } })),
    (error) => error.code === "PACKAGE_PROVENANCE_INVALID",
    "Provenance without a source must be rejected.",
  );

  // 5. The v2 fields are opt-in: omitting them is valid.
  const plain = validateMarketplaceTemplate(validTemplate({
    packageVersion: undefined,
    checksum: undefined,
    provenance: undefined,
  }));
  assert.strictEqual(plain.supported, true, "Marketplace 1.x templates without v2 fields must stay valid.");

  // 6. The shipped catalog must not trip the new opt-in rules.
  const raw = fs.readFileSync(path.join(ROOT, "config", "marketplace-templates.json"), "utf8");
  const catalog = JSON.parse(raw);
  const result = validateMarketplaceCatalog(catalog);
  const v2Violations = result.errors.filter((error) => /^PACKAGE_(VERSION|CHECKSUM|PROVENANCE)_INVALID$/.test(error.code));
  assert.deepStrictEqual(v2Violations, [], "The shipped catalog must not violate any v2 package-metadata rule.");

  console.log("marketplace:template-metadata:smoke passed");
}

try {
  main();
} catch (error) {
  console.error("marketplace:template-metadata:smoke FAILED:", error);
  process.exitCode = 1;
}