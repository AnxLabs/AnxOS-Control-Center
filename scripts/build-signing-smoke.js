const assert = require("assert");
const fs = require("fs");

const builder = fs.readFileSync("scripts/electron-builder-config.js", "utf8");
const signing = fs.readFileSync("scripts/azure-signing-config.js", "utf8");
const wrapper = fs.readFileSync("scripts/run-electron-builder.js", "utf8");
const verifier = fs.readFileSync("scripts/verify-windows-signatures.js", "utf8");

assert(builder.includes("module.exports = createElectronBuilderConfig()"));
  assert(!builder.includes("module.exports.REQUIRED_AZURE_ENV"));
  assert(signing.includes("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"));
  assert(wrapper.includes('shell: process.platform === "win32"'));
  assert(wrapper.includes("fail release signature verification"), "Packaging must truthfully report that unsigned Windows builds fail release verification.");
  assert(wrapper.includes("Windows Azure Trusted Signing"), "Packaging must report the Azure signing mode.");
  assert(verifier.includes('verify", "/pa", "/v"'));
  assert(verifier.includes("signtool candidates"));
  assert(verifier.includes("Authenticode verification passed"));
  assert(verifier.includes("Windows release signing is mandatory"), "Signature verification must treat signing as mandatory for release.");
  console.log("Build signing smoke checks passed.");
