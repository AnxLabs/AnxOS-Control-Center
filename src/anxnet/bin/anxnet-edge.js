#!/usr/bin/env node
"use strict";

// Runs an AnxNet edge (relay and/or public game gateway) on a machine the
// network owner controls. It only serves the networks listed in its config
// file and never starts by itself.
//
//   node src/anxnet/bin/anxnet-edge.js --config edge.json
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

function readConfig() {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1]) {
    console.error("Usage: anxnet-edge --config edge.json");
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(process.argv[index + 1], "utf8"));
}

async function main() {
  const config = readConfig();
  if (!config.dataDir) throw new Error("Set dataDir in the config file.");
  if (!Array.isArray(config.networks) || !config.networks.length) throw new Error("List at least one network the edge serves.");
  const edge = new AnxNetEdge({ ...config, keyStore: fileStore(path.join(config.dataDir, "edge.key")) });
  const info = await edge.start();
  console.log(`AnxNet edge listening on ${config.listenHost || "0.0.0.0"}:${info.port}`);
  console.log(`Fingerprint (add this in AnxOS): ${info.fingerprint}`);
  console.log(`Relay: ${edge.options.relay.enabled ? "on" : "off"}; gateway: ${edge.options.gateway.enabled ? `on, ports ${edge.options.gateway.portRange.join("-")}` : "off"}`);
  const shutdown = () => edge.stop().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
