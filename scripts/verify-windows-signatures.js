#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getAzureSigningConfig } = require("./azure-signing-config");

if (process.platform !== "win32") process.exit(0);

const dist = path.resolve(process.cwd(), "dist");
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filePath);
    else if (entry.isFile() && filePath.toLowerCase().endsWith(".exe")) files.push(filePath);
  }
}
walk(dist);
if (files.length === 0) {
  console.error("No Windows executables were generated for signature verification.");
  process.exit(1);
}

function numericVersion(value) {
  return String(value).split(/[._-]/).map((part) => Number.parseInt(part, 10) || 0);
}
function compareVersions(a, b) {
  const left = numericVersion(a);
  const right = numericVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}
function collectSdkCandidates(root) {
  const candidates = [];
  if (!root || !fs.existsSync(root)) return candidates;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && /[\\/]x64[\\/]signtool\.exe$/i.test(filePath)) candidates.push({ path: filePath, arch: "x64", version: path.basename(path.dirname(path.dirname(filePath))) });
      else if (entry.isFile() && /[\\/]x86[\\/]signtool\.exe$/i.test(filePath)) candidates.push({ path: filePath, arch: "x86", version: path.basename(path.dirname(path.dirname(filePath))) });
    }
  }
  walk(root);
  return candidates;
}
function resolveSignTool(environment = process.env) {
  const candidates = [];
  if (environment.SIGNTOOL_PATH && fs.existsSync(environment.SIGNTOOL_PATH)) candidates.push({ path: environment.SIGNTOOL_PATH, arch: "explicit", version: "" });
  const result = spawnSync("where.exe", ["signtool.exe"], { encoding: "utf8", windowsHide: true });
  String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((candidate) => candidates.push({ path: candidate, arch: /[\\/]x64[\\/]/i.test(candidate) ? "x64" : "x86", version: "PATH" }));
  const roots = [environment.WindowsSdkDir, "C:\\Program Files (x86)\\Windows Kits\\10\\bin", "C:\\Program Files\\Windows Kits\\10\\bin"].filter(Boolean);
  roots.forEach((root) => candidates.push(...collectSdkCandidates(root)));
  const unique = [...new Map(candidates.map((candidate) => [candidate.path.toLowerCase(), candidate])).values()];
  console.log(`signtool candidates (${unique.length}):`);
  unique.forEach((candidate) => console.log(`- ${candidate.path} [${candidate.arch}, ${candidate.version}]`));
  unique.sort((a, b) => (a.arch === "x64" ? 1 : 0) - (b.arch === "x64" ? 1 : 0) || compareVersions(b.version, a.version));
  return unique[0]?.path || null;
}

const signTool = resolveSignTool();
console.log(`Windows signature verifier: ${signTool || "signtool.exe not found"}`);
if (!signTool) {
  console.error("Windows SDK signtool.exe is required for Authenticode verification.");
  process.exit(1);
}

const signingExpected = Boolean(getAzureSigningConfig());
if (!signingExpected) {
  console.error("Windows release signing is mandatory. No Azure Trusted Signing configuration was provided; refusing to verify an unsigned Windows build for release.");
  process.exit(1);
}
const failures = [];
for (const filePath of files) {
  const result = spawnSync(signTool, ["verify", "/pa", "/v", filePath], { encoding: "utf8", windowsHide: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const valid = result.status === 0 && /Successfully verified/i.test(output);
  const passed = valid;
  console.log(`${passed ? "PASS" : "FAIL"}: ${filePath}`);
  if (output) console.log(output);
  if (!passed) failures.push(filePath);
}

if (failures.length > 0) {
  console.error(`Authenticode verification failed for ${failures.length} executable(s).`);
  failures.forEach((filePath) => console.error(`- ${filePath}`));
  process.exit(1);
}
console.log(`Authenticode verification passed for ${files.length} executable(s).`);
