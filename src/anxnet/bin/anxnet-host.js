#!/usr/bin/env node
"use strict";

// AnxNet background process for this computer. Started by AnxOS (detached,
// as the signed-in user, never as a system service), or by hand for headless
// use:
//   node src/anxnet/bin/anxnet-host.js --data-dir <folder> [--key-file <0600 file>]
//     [--listen-host 0.0.0.0] [--listen-port 47710] [--stay-alive]
// One host runs per data folder; a second one exits with code 3.

const fs = require("fs");
const { startHost } = require("../host");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const dataDir = argument("--data-dir");
  if (!dataDir) { console.error("Usage: anxnet-host --data-dir <folder>"); process.exit(2); }
  const keyFile = argument("--key-file");
  let keyPem = null;
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(require("path").join(dataDir, "anxnet-settings.json"), "utf8")); } catch {}
  if (keyFile) keyPem = fs.readFileSync(keyFile, "utf8");
  const listenHost = argument("--listen-host", settings.listenHost || "0.0.0.0");
  const listenPort = Number(argument("--listen-port", settings.listenPort ?? 47710));
  await startHost({
    dataDir,
    keyPem,
    stayAlive: process.argv.includes("--stay-alive"),
    nodeOptions: {
      listenHost: ["0.0.0.0", "127.0.0.1"].includes(listenHost) ? listenHost : "0.0.0.0",
      listenPort: Number.isInteger(listenPort) ? listenPort : 47710,
      directInbound: settings.directInbound !== false,
      dnsHost: settings.dnsHost || "127.77.0.1",
      dnsPort: Number(argument("--dns-port", Number.isInteger(settings.dnsPort) ? settings.dnsPort : 5353)),
    },
    onStopped: () => setTimeout(() => process.exit(0), 50),
  });
  const shutdown = () => process.exit(0);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  if (error.code === "ANXNET_HOST_RUNNING") process.exit(3);
  console.error(error.message);
  process.exit(1);
});
