#!/usr/bin/env node
// Stages the Local Agent runtime's external dependency closure into
// resources/agent-runtime-node-modules so electron-builder's extraResources
// copies exactly the packages the packaged Agent can require. The closure is
// computed from the runtime source graph (see agent-runtime-dependency-closure.js)
// and resolved with real Node resolution against this repository's
// node_modules, preserving each package's physical relative path so nested
// (deduped) dependencies keep resolving after the copy.
//
// Run automatically by scripts/run-electron-builder.js before every packaging
// run; also available as `npm run agent-runtime:prepare`.
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const {
  HOST_PROVIDED_MODULES,
  collectRuntimeBareSpecifiers,
  readPackageJson,
} = require("./agent-runtime-dependency-closure");

const root = path.resolve(__dirname, "..");
const repositoryModules = path.join(root, "node_modules");
const stageRoot = path.join(root, "resources", "agent-runtime-node-modules");

function isInsideDirectory(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveFrom(filePath, specifier) {
  return Module.createRequire(filePath).resolve(specifier);
}

// Walks up from a resolved file to the package.json that owns it, refusing any
// package that lives outside this repository's node_modules.
function findRepositoryPackageDir(resolvedFile) {
  let directory = path.dirname(resolvedFile);
  while (isInsideDirectory(root, directory)) {
    if (fs.existsSync(path.join(directory, "package.json"))) {
      return isInsideDirectory(repositoryModules, directory) ? directory : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

// Copies a package tree without nested node_modules (each dependency is queued
// and copied explicitly), source maps, VCS metadata, logs, and package
// development trees (test suites, examples, CI metadata), mirroring the
// runtime manifest's excluded patterns. Symlinks are skipped rather than
// followed so the staged tree stays self-contained.
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".github", "test", "tests", "examples"]);

function copyPackageTree(sourceDir, targetDir, skipped) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      skipped.push(sourcePath);
      continue;
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        skipped.push(sourcePath);
        continue;
      }
      copyPackageTree(sourcePath, targetPath, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".map") || entry.name.endsWith(".log")) {
      skipped.push(sourcePath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function stage() {
  const collected = collectRuntimeBareSpecifiers(root);
  if (collected.relativeMissing.length) {
    throw new Error(`The Agent runtime source graph has missing relative requires:\n${collected.relativeMissing.map((entry) => `- ${entry.chain}`).join("\n")}`);
  }

  const hostProvided = new Set(HOST_PROVIDED_MODULES);
  const queue = [];
  for (const record of collected.specifiers) {
    if (hostProvided.has(record.package)) continue;
    queue.push({ specifier: record.name, fromFile: path.join(root, record.files[0]), chain: record.chains[0] || record.name });
  }

  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });

  const staged = new Map();
  const skipped = [];
  while (queue.length) {
    const { specifier, fromFile, chain } = queue.shift();
    let resolved;
    try {
      resolved = resolveFrom(fromFile, specifier);
    } catch (error) {
      throw new Error(`The Agent runtime requires '${specifier}' but it does not resolve (require chain: ${chain}). Install dependencies before packaging.`);
    }
    const packageDir = findRepositoryPackageDir(resolved);
    if (!packageDir) {
      throw new Error(`The Agent runtime requires '${specifier}' but it resolved outside this repository's node_modules (require chain: ${chain}).`);
    }
    const relativePath = path.relative(repositoryModules, packageDir).split(path.sep).join("/");
    if (staged.has(relativePath)) continue;
    const packageJson = readPackageJson(packageDir);
    if (!packageJson.name) {
      throw new Error(`The Agent runtime requires '${specifier}' but ${relativePath} has no readable package.json.`);
    }
    copyPackageTree(packageDir, path.join(stageRoot, relativePath), skipped);
    staged.set(relativePath, { name: packageJson.name, version: packageJson.version || null });
    for (const dependency of Object.keys(packageJson.dependencies || {})) {
      queue.push({
        specifier: dependency,
        fromFile: path.join(packageDir, "package.json"),
        chain: `${chain} -> ${packageJson.name} -> ${dependency}`,
      });
    }
  }

  if (staged.size === 0) {
    throw new Error("No Agent runtime dependencies were staged; refusing to publish an empty runtime node_modules tree.");
  }

  const summary = [...staged.values()].map((entry) => `${entry.name}@${entry.version}`).sort().join(", ");
  console.log(`Staged ${staged.size} Agent runtime dependency package(s) into ${path.relative(root, stageRoot)}: ${summary}.`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} non-runtime entr${skipped.length === 1 ? "y" : "ies"} while staging (nested node_modules, source maps, VCS metadata, logs).`);
  }
}

try {
  stage();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
