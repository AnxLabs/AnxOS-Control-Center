const fs = require("fs");
const path = require("path");

const AGENT_RUNTIME_MANIFEST = path.join("config", "local-agent-runtime.json");

// The bundled runtime manifest is the single source of truth for what an Agent
// runtime contains; package.json extraResources publishes the same paths into
// resources/local-agent-runtime for packaged builds. node_modules is the staged
// dependency closure (scripts/prepare-agent-runtime-dependencies.js), not the
// repository tree, so enumerating it yields exactly the packages the Agent
// requires. These fallbacks exist so a stripped development checkout still
// resolves the same payload shape.
const FALLBACK_INCLUDED_PATHS = [
  "agent/package.json",
  "agent/src",
  "src/shared",
  "src/services",
  "node_modules",
  "config/agent.example.json",
  "config/marketplace-templates.json",
];

const FALLBACK_EXCLUDED_PATTERNS = [
  ".env",
  ".env.*",
  "*.log",
  "*.map",
  ".git",
  "node_modules/.cache",
  "test",
  "tests",
];

function readAgentRuntimeManifest(runtimeRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeRoot, AGENT_RUNTIME_MANIFEST), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}

function normalizeIncludedPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || normalized.includes(":")) return null;
  return normalized;
}

// Exclusion semantics, deliberately small and explicit:
// - "segment" patterns ("test", "tests", ".git") match any path segment;
// - "*.ext" matches the basename suffix;
// - "name.*" matches the basename prefix;
// - patterns containing "/" match a relative path or a nested path suffix.
function matchesExcludedPattern(relativePath, patterns) {
  const normalized = String(relativePath || "").split(path.sep).join("/");
  const segments = normalized.split("/");
  const base = segments[segments.length - 1] || "";
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    const pattern = String(raw || "").trim().replace(/\/+$/, "");
    if (!pattern) continue;
    if (pattern.includes("/")) {
      if (normalized === pattern || normalized.endsWith(`/${pattern}`) || normalized.includes(`/${pattern}/`)) return true;
      continue;
    }
    if (pattern.startsWith("*.")) {
      if (base.endsWith(pattern.slice(1))) return true;
      continue;
    }
    if (pattern.endsWith(".*")) {
      if (base.startsWith(pattern.slice(0, -1))) return true;
      continue;
    }
    if (segments.includes(pattern)) return true;
  }
  return false;
}

// Enumerates the files a bundled Agent runtime payload contains for the given
// runtime root. Files are returned sorted by relative path so payloads and
// their hashes are deterministic across machines.
function enumerateRuntimePayload(runtimeRoot) {
  const resolvedRoot = path.resolve(String(runtimeRoot || ""));
  const manifest = readAgentRuntimeManifest(resolvedRoot);
  const manifestIncluded = Array.isArray(manifest?.includedPaths) ? manifest.includedPaths : null;
  const includedPaths = (manifestIncluded && manifestIncluded.length ? manifestIncluded : FALLBACK_INCLUDED_PATHS)
    .map(normalizeIncludedPath)
    .filter(Boolean);
  if (includedPaths.length === 0) {
    throw Object.assign(new Error("The Agent runtime manifest does not list any included paths."), { code: "AGENT_RUNTIME_MANIFEST_INVALID" });
  }
  const excludedPatterns = (Array.isArray(manifest?.excludedPatterns) && manifest.excludedPatterns.length
    ? manifest.excludedPatterns
    : FALLBACK_EXCLUDED_PATTERNS
  ).map(String);

  // Explicitly included paths are trusted over exclusions, so the manifest's
  // node_modules entry is enumerated even when an exclusion pattern would
  // otherwise match files inside it.
  const explicitlyIncluded = new Set(includedPaths);
  const isExcluded = (relativePath) => {
    if (explicitlyIncluded.has(relativePath)) return false;
    return matchesExcludedPattern(relativePath, excludedPatterns);
  };

  const files = [];
  const missing = [];
  const walk = (absolutePath, relativePath) => {
    let stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch {
      missing.push(relativePath);
      return;
    }
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(absolutePath).sort();
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRelative = `${relativePath}/${entry}`;
        if (isExcluded(childRelative)) continue;
        walk(path.join(absolutePath, entry), childRelative);
      }
      return;
    }
    if (!stats.isFile()) return;
    if (isExcluded(relativePath)) return;
    files.push({
      relativePath,
      absolutePath,
      size: stats.size,
      mode: stats.mode & 0o777,
    });
  };

  for (const included of includedPaths) {
    walk(path.join(resolvedRoot, included), included);
  }

  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));

  return {
    runtimeRoot: resolvedRoot,
    manifestPath: manifest ? path.join(resolvedRoot, AGENT_RUNTIME_MANIFEST) : null,
    includedPaths,
    excludedPatterns,
    files,
    missing,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

module.exports = {
  AGENT_RUNTIME_MANIFEST,
  FALLBACK_EXCLUDED_PATTERNS,
  FALLBACK_INCLUDED_PATHS,
  enumerateRuntimePayload,
  matchesExcludedPattern,
  readAgentRuntimeManifest,
};