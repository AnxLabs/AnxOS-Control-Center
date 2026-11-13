// Run as a child of PowerShell 7 by windows-signing-coverage-smoke (W7): reads
// one signed file's Authenticode signature through each of the three readers
// and prints their statuses as JSON.
"use strict";
const path = require("path");
const root = path.resolve(__dirname, "..", "..");
const { readAuthenticode } = require(path.join(root, "scripts", "sign-nsis-toolsets.js"));
const { readSignatures } = require(path.join(root, "scripts", "windows-signature-coverage.js"));
const { verifyInstallerSignature } = require(path.join(root, "src", "shared", "installerSignature.js"));

(async () => {
  const target = process.argv[2];
  const out = { inheritedPSModulePath: Boolean(process.env.PSModulePath) };
  try { out.signNsis = readAuthenticode(target).status; } catch (error) { out.signNsis = `error: ${error.message}`; }
  try { out.coverage = readSignatures([target])[0].status; } catch (error) { out.coverage = `error: ${error.message}`; }
  try { await verifyInstallerSignature(target); out.updater = "verified"; } catch (error) { out.updater = error.details?.status || `error: ${error.code}`; }
  console.log(JSON.stringify(out));
})();
