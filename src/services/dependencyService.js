// V2-I dependency surface: provenance verdicts + honest advisory status for the
// application's own dependency tree.
//
// WHAT THIS IS (and what it is not)
// This module enumerates the DIRECT dependencies declared in this repository's
// own manifest (package.json) with the facts the repository actually has — the
// declared range, the resolved version and resolution URL recorded in
// package-lock.json, the lockfile integrity hash, whether the package ships
// executable content, and whether it is first-party — and computes a typed
// provenance verdict per dependency via src/shared/dependencyProvenancePolicy.js.
//
// It does NOT install, resolve, fetch or execute anything. It is a read-only
// report surface.
//
// It is NOT the Agent's host-dependency catalog
// (agent/src/services/dependencyService.js), which detects OS-level
// dependencies (Java, Docker, SteamCMD) on a target node. The two share a
// filename only; this one owns npm-package provenance for the application tree.
//
// ADVISORY STATUS — WHAT IS ACTUALLY KNOWABLE
// There is NO live advisory feed in this repository: no npm audit export, no
// advisory database, no lockfile-recorded advisory identifiers, and no network
// call is made here. The ONLY advisory data is a human-triaged scan record,
// docs/v2/SECURITY_TRIAGE_RECORD.md, which lists the advisories one Mimosa scan
// matched and the disposition for each.
//
// That record is used, and its limits are reported rather than papered over:
//   - a package WITH a record entry reports status "recorded" with the advisory
//     IDs and the triage disposition — but never "affected" or "fixed", because
//     AnxOS cannot confirm whether the installed version falls in an affected
//     range (the record carries no range);
//   - a package WITHOUT an entry reports status "unknown". Absence of an entry
//     is NOT a clean bill of health: the record covers only what one scan
//     matched, not what is safe;
//   - if the record is missing or unparsable, every package is "unknown".
//
// No function here will ever emit "clean", "none", "advisory-free" or
// "no advisories".

"use strict";

const fs = require("fs");
const path = require("path");
const {
  DEPENDENCY_PROVENANCE_VERDICTS,
  evaluateDependencyProvenance,
  isExactVersion,
} = require("../shared/dependencyProvenancePolicy");

// No live advisory feed exists. This stays null until a verified feed is added.
const ADVISORY_FEED = null;

const ADVISORY_TRIAGE_RELATIVE_PATH = path.join("docs", "v2", "SECURITY_TRIAGE_RECORD.md");

const ADVISORY_UNKNOWN_REASON = "No verified dependency advisory feed is available in this repository, and this "
  + "package has no entry in the available triage record. Absence of an entry is not a clean bill of health, so "
  + "advisory status is UNKNOWN.";

const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..", "..");

// A section of package.json that declares directly-installed dependencies.
const MANIFEST_DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]);

const GHSA_PATTERN = /GHSA-[a-z0-9-]+/gi;

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// "js-yaml (direct)" -> "js-yaml"; "@scope/pkg (transitive)" -> "@scope/pkg".
function normalizeAdvisoryPackageName(cell) {
  return String(cell || "").replace(/\([^)]*\)/g, "").trim().toLowerCase();
}

/**
 * Parse the dependency-advisory table out of the triage record markdown.
 * Pure: takes text, returns a structured artifact. Fragile by nature (markdown),
 * so an unparsable section yields present:false with a parseError and callers
 * fall back to UNKNOWN rather than to a clean bill of health.
 */
function parseAdvisoryTriageRecord(markdownText) {
  const text = String(markdownText || "");
  const artifact = {
    present: false,
    path: ADVISORY_TRIAGE_RELATIVE_PATH,
    scanSeal: null,
    scannedAt: null,
    entries: [],
    notes: null,
    parseError: null,
  };
  if (!text.trim()) {
    artifact.parseError = "artifact-empty";
    return artifact;
  }

  const sealMatch = text.match(/sealed `(sha256:[a-f0-9]{64})`/i);
  artifact.scanSeal = sealMatch ? sealMatch[1].toLowerCase() : null;
  const atMatch = text.match(/completed\s+(\d{4}-\d{2}-\d{2})/i);
  artifact.scannedAt = atMatch ? atMatch[1] : null;

  const sectionMatch = text.match(/##\s+Dependency advisories[^\n]*\n([\s\S]*?)(?:\n##\s|$)/i);
  if (!sectionMatch) {
    artifact.parseError = "dependency-advisories-section-not-found";
    return artifact;
  }
  const section = sectionMatch[1];

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const normalize = (value) => value.replace(/[: ]/g, "");
    if (/^-+$/.test(normalize(cells[0]))) continue;
    if (/^package$/i.test(cells[0])) continue;
    const name = normalizeAdvisoryPackageName(cells[0]);
    if (!name) continue;
    const advisories = [...cells[1].matchAll(GHSA_PATTERN)].map((match) => match[0]);
    artifact.entries.push({
      package: name,
      advisories,
      disposition: cells[2] || null,
    });
  }

  const notesMatch = section.match(/^\s*([A-Za-z][^\n]*devDeps[^\n]*)\s*$/m);
  artifact.notes = notesMatch ? notesMatch[1].trim() : null;
  artifact.present = artifact.entries.length > 0;
  if (!artifact.present && !artifact.parseError) {
    artifact.parseError = "no-advisory-entries-parsed";
  }
  return artifact;
}

/**
 * Read + parse the in-tree advisory triage record. Any failure yields a
 * non-present artifact; it never throws, because the report must always be
 * buildable and must degrade to UNKNOWN.
 */
function loadAdvisoryArtifact(rootDir = DEFAULT_ROOT_DIR) {
  const absolutePath = path.join(path.resolve(rootDir), ADVISORY_TRIAGE_RELATIVE_PATH);
  try {
    return { ...parseAdvisoryTriageRecord(fs.readFileSync(absolutePath, "utf8")), absolutePath };
  } catch (error) {
    return {
      present: false,
      path: ADVISORY_TRIAGE_RELATIVE_PATH,
      absolutePath,
      scanSeal: null,
      scannedAt: null,
      entries: [],
      notes: null,
      parseError: `artifact-unavailable: ${error?.message || "unknown error"}`,
    };
  }
}

function findAdvisoryEntry(artifact, name) {
  if (!artifact?.present) return null;
  const normalized = String(name || "").trim().toLowerCase();
  return artifact.entries.find((entry) => entry.package === normalized) || null;
}

// Per-dependency advisory status: "recorded" when the triage record lists the
// package, otherwise "unknown". Never "clean".
function resolveDependencyAdvisory(artifact, name) {
  const entry = findAdvisoryEntry(artifact, name);
  if (entry) {
    const advisories = entry.advisories.length > 0 ? entry.advisories.join(", ") : "an unnamed advisory";
    return {
      status: "recorded",
      code: "TRIAGE_RECORDED_ADVISORY",
      verified: false,
      advisories: entry.advisories,
      disposition: entry.disposition,
      artifactPath: artifact.path,
      reason: `The in-tree triage record (${artifact.path}) lists ${advisories} for this package with disposition: `
        + `${entry.disposition || "not stated"}. This is a human-reviewed scan record, not a live feed, and it carries `
        + "no affected version range, so AnxOS cannot confirm whether the installed version is affected.",
    };
  }
  return {
    status: "unknown",
    code: artifact?.present ? "ADVISORY_NOT_IN_TRIAGE_RECORD" : "ADVISORY_ARTIFACT_UNAVAILABLE",
    verified: false,
    advisories: [],
    disposition: null,
    artifactPath: artifact?.path || ADVISORY_TRIAGE_RELATIVE_PATH,
    reason: artifact?.present
      ? ADVISORY_UNKNOWN_REASON
      : `The advisory triage record could not be read or parsed (${artifact?.parseError || "unknown reason"}), so `
        + "advisory status is UNKNOWN.",
  };
}

function describeAdvisoryStatus(artifact) {
  return {
    status: "triage-record-only",
    code: artifact?.present ? "TRIAGE_RECORD_ONLY" : "NO_ADVISORY_DATA",
    verified: false,
    feed: ADVISORY_FEED,
    artifact: {
      path: artifact?.path || ADVISORY_TRIAGE_RELATIVE_PATH,
      present: Boolean(artifact?.present),
      scanSeal: artifact?.scanSeal || null,
      scannedAt: artifact?.scannedAt || null,
      entryCount: artifact?.entries?.length || 0,
      parseError: artifact?.parseError || null,
      notes: artifact?.notes || null,
    },
    reason: "AnxOS has no live dependency advisory feed. The only advisory data is a human-triaged scan record "
      + `(${artifact?.path || ADVISORY_TRIAGE_RELATIVE_PATH}), which lists the advisories one scan matched and carries `
      + "no affected version ranges. A package with no entry is NOT reported clean; its status is UNKNOWN, because "
      + "absence of an entry is not a clean bill of health.",
  };
}

// Enumerate the direct dependencies declared in a manifest. Pure: takes the
// parsed manifest, returns descriptors; no I/O.
function parseManifestDependencies(manifest = {}) {
  const entries = [];
  const seen = new Set();
  for (const section of MANIFEST_DEPENDENCY_SECTIONS) {
    const block = manifest && typeof manifest[section] === "object" && manifest[section] !== null
      ? manifest[section]
      : {};
    for (const [name, range] of Object.entries(block)) {
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({
        name,
        declaredRange: String(range ?? ""),
        section,
        direct: true,
        pinned: isExactVersion(range) && !/[\^~><*|xX]/.test(String(range ?? "")),
      });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

// Lockfile v2/v3 store resolved packages under `packages["node_modules/<name>"]`;
// v1 stored them under `dependencies`. Support both so the report degrades
// honestly rather than reporting every dependency as unresolved.
function resolveLockfileEntry(lockfile = {}, name) {
  const direct = lockfile?.packages?.[`node_modules/${name}`];
  if (direct && typeof direct === "object") return direct;
  const nested = lockfile?.packages?.[`node_modules/${name}/node_modules`];
  if (nested && typeof nested === "object") return nested;
  const legacy = lockfile?.dependencies?.[name];
  if (legacy && typeof legacy === "object") return legacy;
  return null;
}

function registryHostFromResolved(resolved) {
  if (typeof resolved !== "string" || !resolved.trim()) return null;
  const match = resolved.trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Build the dependency provenance report for a repository tree.
 *
 * options.rootDir      absolute path (defaults to the repository root)
 * options.manifest     pre-parsed manifest (skips the file read)
 * options.lockfile     pre-parsed lockfile (skips the file read)
 * options.advisoryArtifact  pre-parsed advisory artifact (skips the file read)
 * options.generatedAt  caller-supplied timestamp; null by default so the report
 *                      is deterministic for hermetic assertions
 */
function buildDependencyProvenanceReport(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : DEFAULT_ROOT_DIR;
  const evidence = {
    manifestPath: path.join(rootDir, "package.json"),
    lockfilePath: path.join(rootDir, "package-lock.json"),
    lockfileAvailable: false,
  };

  const artifact = options.advisoryArtifact !== undefined
    ? options.advisoryArtifact
    : loadAdvisoryArtifact(rootDir);
  const advisory = describeAdvisoryStatus(artifact);

  let manifest = options.manifest;
  let lockfile = options.lockfile;
  try {
    if (manifest === undefined) manifest = readJsonFile(evidence.manifestPath);
    if (lockfile === undefined) {
      lockfile = readJsonFile(evidence.lockfilePath);
      evidence.lockfileAvailable = true;
    } else {
      evidence.lockfileAvailable = lockfile !== null && lockfile !== undefined;
    }
  } catch (error) {
    return {
      ok: false,
      code: "DEPENDENCY_MANIFEST_UNAVAILABLE",
      reason: `Could not read the dependency manifest at ${evidence.manifestPath}: ${error?.message || "unknown error"}`,
      rootDir,
      generatedAt: options.generatedAt ?? null,
      advisory,
      dependencies: [],
      summary: { directDependencies: 0, byVerdict: {}, trusted: 0, unverified: 0, executable: 0, advisory: { recorded: 0, unknown: 0, clean: 0 } },
      evidence,
    };
  }

  const lockfileEntries = lockfile && typeof lockfile === "object" ? lockfile : {};
  const dependencies = parseManifestDependencies(manifest).map((descriptor) => {
    const lockEntry = resolveLockfileEntry(lockfileEntries, descriptor.name);
    const resolvedVersion = lockEntry?.version ? String(lockEntry.version) : null;
    const resolvedUrl = lockEntry?.resolved ? String(lockEntry.resolved) : null;
    const registryHost = registryHostFromResolved(resolvedUrl);
    const integrity = lockEntry?.integrity ? String(lockEntry.integrity) : null;
    const executable = lockEntry?.hasInstallScript === true
      || lockEntry?.requiresBuild === true
      || (lockEntry?.bin !== undefined && lockEntry?.bin !== null);
    const firstParty = descriptor.name.startsWith("@anxos/");

    const verdict = evaluateDependencyProvenance({
      name: descriptor.name,
      version: resolvedVersion,
      range: descriptor.declaredRange,
      resolved: resolvedUrl,
      integrity,
      hasInstallScript: lockEntry?.hasInstallScript === true,
      requiresBuild: lockEntry?.requiresBuild === true,
      bin: lockEntry?.bin,
      firstParty,
    }, {
      source: registryHost || "npm",
      registry: registryHost || "npm",
      sourceUrl: resolvedUrl,
      executable,
      firstParty,
    });

    return {
      name: descriptor.name,
      section: descriptor.section,
      direct: true,
      declaredRange: descriptor.declaredRange,
      pinned: descriptor.pinned,
      resolvedVersion,
      resolved: resolvedUrl,
      registryHost,
      integrity: {
        present: Boolean(integrity),
        algorithm: verdict.integrity.declared?.algorithm || null,
        encoding: verdict.integrity.declared?.encoding || null,
        independentlyVerified: verdict.integrity.established,
        reasonCode: verdict.integrity.reasonCode,
      },
      executable: Boolean(verdict.executable),
      firstParty: Boolean(verdict.publisherKind === "first-party"),
      verdict: verdict.verdict,
      code: verdict.code,
      trusted: verdict.trusted,
      severity: verdict.severity,
      requiresReview: verdict.requiresReview,
      publisher: verdict.publisher,
      publisherKind: verdict.publisherKind,
      reason: verdict.reason,
      advisory: resolveDependencyAdvisory(artifact, descriptor.name),
    };
  });

  const byVerdict = {};
  for (const dependency of dependencies) {
    byVerdict[dependency.verdict] = (byVerdict[dependency.verdict] || 0) + 1;
  }
  const advisoryCounts = {
    recorded: dependencies.filter((dependency) => dependency.advisory.status === "recorded").length,
    unknown: dependencies.filter((dependency) => dependency.advisory.status === "unknown").length,
    clean: 0,
  };

  return {
    ok: true,
    source: "package.json",
    rootDir,
    generatedAt: options.generatedAt ?? null,
    advisory,
    dependencies,
    summary: {
      directDependencies: dependencies.length,
      byVerdict,
      trusted: dependencies.filter((dependency) => dependency.trusted).length,
      unverified: dependencies.filter((dependency) => !dependency.trusted).length,
      executable: dependencies.filter((dependency) => dependency.executable).length,
      unresolved: dependencies.filter((dependency) => dependency.resolvedVersion === null).length,
      lockfilePackageCount: lockfileEntries?.packages && typeof lockfileEntries.packages === "object"
        ? Math.max(0, Object.keys(lockfileEntries.packages).length - 1)
        : null,
      advisory: advisoryCounts,
    },
    evidence,
  };
}

/**
 * The dependency catalog entry point. Named for parity with the Agent's host
 * dependency catalog so a caller wiring this in has one obvious function to
 * call; it returns the provenance report above, never host-dependency state.
 */
function getDependencyCatalog(options = {}) {
  return buildDependencyProvenanceReport(options);
}

// Provenance verdict for ONE real, named dependency from the repository tree.
// This is the integration proof surface: it resolves the dependency from the
// real lockfile and computes a verdict, rather than exercising the pure policy.
function dependencyProvenanceFor(name, options = {}) {
  const report = buildDependencyProvenanceReport(options);
  if (!report.ok) return report;
  const dependency = report.dependencies.find((entry) => entry.name === name) || null;
  if (!dependency) {
    return {
      ok: false,
      code: "DEPENDENCY_NOT_DECLARED",
      reason: `Dependency "${name}" is not a direct dependency declared in the repository manifest.`,
      advisory: report.advisory,
    };
  }
  return { ok: true, advisory: report.advisory, dependency };
}

module.exports = {
  ADVISORY_TRIAGE_RELATIVE_PATH,
  ADVISORY_UNKNOWN_REASON,
  MANIFEST_DEPENDENCY_SECTIONS,
  buildDependencyProvenanceReport,
  dependencyProvenanceFor,
  describeAdvisoryStatus,
  findAdvisoryEntry,
  getDependencyCatalog,
  loadAdvisoryArtifact,
  parseAdvisoryTriageRecord,
  parseManifestDependencies,
  registryHostFromResolved,
  resolveDependencyAdvisory,
  resolveLockfileEntry,
  // Re-exported so a caller gets the provenance vocabulary from the surface it
  // already imports, without reaching into src/shared directly.
  DEPENDENCY_PROVENANCE_VERDICTS,
  _internal: { readJsonFile },
};