// Shared packaging helper for the Local Agent runtime dependency closure.
//
// The packaged Agent lives at resources/local-agent-runtime and requires its
// external packages from resources/local-agent-runtime/node_modules. This
// module walks the runtime source graph (the manifest entry point plus every
// relative require it reaches across agent/src, src/shared and src/services)
// and resolves each external module strictly inside the runtime root, so a
// module that only happens to resolve from the repository tree can never be
// reported as packaged. prepare-agent-runtime-dependencies.js uses the same
// walk to stage the closure before electron-builder runs,
// packaging-artifact-smoke.js uses it to prove a built runtime contains the
// closure, and local-agent-runtime-smoke.js uses it to prove the repository
// source graph is fully declared.
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const BUILTIN_MODULES = new Set(Module.builtinModules);
const DEFAULT_ENTRYPOINT = path.join("agent", "src", "server.js");

// The packaged Agent is hosted by Electron (ELECTRON_RUN_AS_NODE=1), and the
// Electron binary itself provides require("electron") to that child process.
// It is not (and must not be) an npm package in the runtime tree: build 203
// shipped without it and was healthy.
const HOST_PROVIDED_MODULES = ["electron"];

function isBuiltinModule(specifier) {
  return specifier.startsWith("node:") || BUILTIN_MODULES.has(specifier);
}

function packageNameOf(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Requires inside comments are not loadable dependencies. This is the same
// string-preserving comment strip used by packaging-artifact-smoke.js; a plain
// regex would otherwise report commented examples as missing packages.
function stripSourceComments(source) {
  const output = [];
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; index += 1; continue; }
      if (char === "/" && next === "*") { state = "block"; index += 1; continue; }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      output.push(char);
    } else if (state === "line") {
      if (char === "\n") { state = "code"; output.push(char); }
    } else if (state === "block") {
      if (char === "*" && next === "/") { state = "code"; index += 1; }
      else if (char === "\n") output.push(char);
    } else {
      output.push(char);
      if (char === "\\") { output.push(next || ""); index += 1; }
      else if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) state = "code";
    }
  }
  return output.join("");
}

function requireRequests(source) {
  return [...stripSourceComments(source).matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

function resolveRelativeFile(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  return [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")]
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function toRuntimePath(runtimeRoot, filePath) {
  return path.relative(runtimeRoot, filePath).split(path.sep).join("/");
}

// Walks the runtime source graph and returns every external (non-builtin,
// non-relative) module specifier it can require, with the requiring files and
// representative require chains for diagnostics.
function collectRuntimeBareSpecifiers(runtimeRoot, options = {}) {
  const root = path.resolve(runtimeRoot);
  const entrypoint = path.join(root, options.entrypoint || DEFAULT_ENTRYPOINT);
  const visited = new Set();
  const specifiers = new Map();
  const relativeMissing = [];

  const walk = (filePath, chain) => {
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath)) return;
    visited.add(resolvedPath);
    if (path.extname(resolvedPath) !== ".js") return;
    let source;
    try {
      source = fs.readFileSync(resolvedPath, "utf8");
    } catch {
      return;
    }
    for (const request of requireRequests(source)) {
      if (request.startsWith(".")) {
        const dependency = resolveRelativeFile(resolvedPath, request);
        if (dependency) walk(dependency, chain.concat(toRuntimePath(root, resolvedPath)));
        else relativeMissing.push({ file: toRuntimePath(root, resolvedPath), request, chain: chain.concat(toRuntimePath(root, resolvedPath), request).join(" -> ") });
        continue;
      }
      if (isBuiltinModule(request)) continue;
      if (!specifiers.has(request)) specifiers.set(request, { name: request, files: new Set(), chains: [] });
      const record = specifiers.get(request);
      record.files.add(toRuntimePath(root, resolvedPath));
      if (record.chains.length < 3) record.chains.push(chain.concat(toRuntimePath(root, resolvedPath), request).join(" -> "));
    }
  };

  walk(entrypoint, []);

  return {
    runtimeRoot: root,
    entrypoint: toRuntimePath(root, entrypoint),
    filesWalked: visited.size,
    relativeMissing,
    specifiers: [...specifiers.values()].map((record) => ({
      name: record.name,
      package: packageNameOf(record.name),
      files: [...record.files],
      chains: record.chains,
    })),
  };
}

// Resolves a specifier from a real requiring file and rejects any resolution
// that lands outside the runtime root, so an escape into the repository tree
// is reported as missing rather than as packaged.
function resolveConfined(runtimeRoot, fromFile, specifier) {
  let resolved;
  try {
    resolved = Module.createRequire(fromFile).resolve(specifier);
  } catch {
    return null;
  }
  return isInside(runtimeRoot, resolved) ? resolved : null;
}

function findPackageRootWithin(runtimeRoot, resolvedFile) {
  let directory = path.dirname(resolvedFile);
  while (isInside(runtimeRoot, directory)) {
    if (fs.existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

function readPackageJson(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

// Resolves the complete package closure of the runtime sources against the
// runtime tree itself. Reports every package that is required (directly or as
// a declared dependency of a resolved package) but absent from the tree.
// Optional dependencies are deliberately not required: they are native or
// performance-only bindings (ssh2's cpu-features/nan) whose absence is
// supported by the packages themselves, and their prebuilt binaries are not
// portable between build and install machines.
function resolveRuntimeClosure(runtimeRoot, options = {}) {
  const root = path.resolve(runtimeRoot);
  const hostProvided = new Set(options.hostProvided || HOST_PROVIDED_MODULES);
  const collected = collectRuntimeBareSpecifiers(root, options);
  const packages = new Map();
  const missing = new Map();
  const queue = [];

  const firstRequiringFile = (specifier) => {
    const record = collected.specifiers.find((entry) => entry.name === specifier);
    return record && record.files.length ? path.join(root, record.files[0]) : path.join(root, collected.entrypoint);
  };

  for (const record of collected.specifiers) {
    if (hostProvided.has(record.package)) continue;
    queue.push({
      name: record.name,
      fromFile: firstRequiringFile(record.name),
      chain: record.chains[0] || record.name,
      optional: false,
    });
  }

  while (queue.length) {
    const { name, fromFile, chain, optional } = queue.shift();
    const resolved = resolveConfined(root, fromFile, name);
    if (!resolved) {
      if (!optional && !missing.has(name)) missing.set(name, { name, chain });
      continue;
    }
    const packageDir = findPackageRootWithin(root, resolved);
    if (!packageDir) {
      if (!optional && !missing.has(name)) missing.set(name, { name, chain: `${chain} (resolved outside any package: ${toRuntimePath(root, resolved)})` });
      continue;
    }
    const relativePath = toRuntimePath(root, packageDir);
    if (packages.has(relativePath)) continue;
    const packageJson = readPackageJson(packageDir);
    packages.set(relativePath, {
      name: packageJson.name || packageNameOf(name),
      version: packageJson.version || null,
      relativePath,
    });
    for (const dependency of Object.keys(packageJson.dependencies || {})) {
      queue.push({
        name: dependency,
        fromFile: path.join(packageDir, "package.json"),
        chain: `${chain} -> ${packageJson.name || relativePath} -> ${dependency}`,
        optional: false,
      });
    }
  }

  return {
    runtimeRoot: root,
    entrypoint: collected.entrypoint,
    filesWalked: collected.filesWalked,
    relativeMissing: collected.relativeMissing,
    hostProvided: [...hostProvided].sort(),
    packages: [...packages.values()].sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)),
    missing: [...missing.values()],
  };
}

module.exports = {
  DEFAULT_ENTRYPOINT,
  HOST_PROVIDED_MODULES,
  collectRuntimeBareSpecifiers,
  isBuiltinModule,
  isInside,
  packageNameOf,
  readPackageJson,
  resolveRuntimeClosure,
  stripSourceComments,
};
