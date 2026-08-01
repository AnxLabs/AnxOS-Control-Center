#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runtimePaths = require("../src/shared/bundledRuntimePaths");
const java = require("../src/shared/minecraftJavaRuntime");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-runtime-bundle-smoke-"));
try {
  const java17 = path.join(root, "java", "17", "bin", "java.exe");
  const java21 = path.join(root, "java", "21", "bin", "java.exe");
  const java8 = path.join(root, "java", "8", "bin", "java.exe");
  const java16 = path.join(root, "java", "16", "bin", "java.exe");
  const dotnet = path.join(root, "dotnet", "8", "dotnet.exe");
  const steamcmd = path.join(root, "steamcmd", "steamcmd.exe");
  for (const target of [java8, java16, java17, java21, dotnet, steamcmd]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
  fs.writeFileSync(path.join(root, "bundle-manifest.json"), "{}");
  const options = { platform: "win32", environment: { ANXOS_BUNDLED_RUNTIME_ROOT: root, PATH: "system-path" } };
  assert.strictEqual(runtimePaths.resolveRoot(options), root);
  assert.strictEqual(runtimePaths.resolveExecutable("steamcmd", options), steamcmd);
  assert.deepStrictEqual(runtimePaths.executableCandidates("java-17", options), [java17]);
  const environment = runtimePaths.buildRuntimeEnvironment(options.environment, options);
  assert.strictEqual(environment.DOTNET_ROOT, path.join(root, "dotnet", "8"));
  assert(environment.PATH.startsWith(path.join(root, "steamcmd")));
  const candidates = java.collectJavaCandidates("win32", options.environment);
  assert(candidates.includes(java8) && candidates.includes(java16) && candidates.includes(java17) && candidates.includes(java21));

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "windows-runtime-bundle.json"), "utf8"));
  assert.deepStrictEqual(manifest.artifacts.map((entry) => entry.id), ["java-8", "java-16", "java-17", "java-21", "dotnet-8", "steamcmd"]);
  for (const artifact of manifest.artifacts) {
    assert(/^https:\/\//.test(artifact.url), `${artifact.id} must use HTTPS.`);
    assert(/^[a-f0-9]{64}$|^[a-f0-9]{128}$/.test(artifact.checksum), `${artifact.id} must have a SHA-256 or SHA-512 checksum.`);
  }
  console.log("Bundled runtime smoke checks passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
