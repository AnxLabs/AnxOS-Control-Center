#!/usr/bin/env node
"use strict";

// Runs an AnxNet edge (relay and/or public game gateway) on a machine the
// network owner controls. It only serves the networks listed in its config
// file and never starts by itself.
//
//   node src/anxnet/bin/anxnet-edge.js --config edge.json
//   node src/anxnet/bin/anxnet-edge.js --config edge.json --check
//
// --check validates the file, prints what the edge would do and which ports
// the server's firewall must allow, and exits without listening or creating
// a key. A normal start runs the same check first and refuses a bad config.
//
// edge.json:
// {
//   "dataDir": "/var/lib/anxnet-edge",          // edge key (0600)
//   "listenHost": "0.0.0.0", "port": 47700,
//   "networks": [{ "networkId": "net-...", "ownerPublicKey": "<base64 SPKI>" }],
//   "relay":   { "enabled": true },
//   "gateway": { "enabled": false, "publicHost": "203.0.113.10", "portRange": [30000, 30099] }
// }
//
// The owner adds this edge to the network from AnxOS (Computers > AnxNet >
// Relay and gateway) with the host, port and the fingerprint printed below.

const fs = require("fs");
const path = require("path");
const { AnxNetEdge } = require("../edge");
const { fileStore } = require("../node");
const { validateEdgeConfig } = require("../edgeConfig");

function readConfig(argv) {
  const index = argv.indexOf("--config");
  if (index < 0 || !argv[index + 1]) {
    console.error("Usage: anxnet-edge --config edge.json [--check]");
    process.exit(2);
  }
  const file = argv[index + 1];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(error.code === "ENOENT" ? `No config file at ${file}.` : `${file} is not valid JSON: ${error.message}`);
  }
}

function report(check) {
  for (const warning of check.warnings) console.log(`Warning: ${warning}`);
  if (!check.ok) {
    for (const problem of check.errors) console.error(`Problem: ${problem}`);
    return;
  }
  const { summary } = check;
  console.log(`Listen: ${summary.listen}`);
  console.log(`Relay: ${summary.relay ? "on" : "off"}`);
  console.log(`Gateway: ${summary.gateway ? `on, ${summary.gateway.publicHost} ports ${summary.gateway.portRange.join("-")}` : "off"}`);
  console.log(`Networks: ${summary.networks.join(", ")}`);
  console.log(`Firewall must allow: ${summary.firewall.join("; ")}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const config = readConfig(argv);
  const check = validateEdgeConfig(config);
  report(check);
  if (!check.ok) process.exit(1);
  if (argv.includes("--check")) {
    console.log("Config OK. Nothing was started.");
    return;
  }
  const edge = new AnxNetEdge({ ...config, keyStore: fileStore(path.join(config.dataDir, "edge.key")) });
  const info = await edge.start();
  console.log(`AnxNet edge listening on ${config.listenHost || "0.0.0.0"}:${info.port}`);
  console.log(`Fingerprint (add this in AnxOS): ${info.fingerprint}`);
  const shutdown = () => edge.stop().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
