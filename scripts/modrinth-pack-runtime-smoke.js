#!/usr/bin/env node
"use strict";

// A Modrinth .mrpack holds mods and settings only, never the server runtime.
// Since Build 193 provider packs deferred the runtime to "whatever the pack
// ships", so every real Modrinth pack failed with SERVER_PACK_RUNTIME_UNRESOLVED
// (found by scripts/marketplace-modpack-real-install.js). The install now
// installs the runtime the pack declares in modrinth.index.json.
//   R1 the declared runtime is read from the pack's dependencies; anything
//      undeclared or malformed is refused, never guessed
//   R2 a pack that brought a launch script or a server jar keeps it; one that
//      brought only an installer jar (or nothing) does not
//   R3 the declared Fabric runtime is downloaded from Fabric's own metadata
//      for the declared Minecraft and loader versions and written to the server
//   R4 an undeclared runtime or a loader other than the selected one is
//      refused with SERVER_PACK_RUNTIME_UNRESOLVED before anything is downloaded
//   R5 the provider install calls this for Modrinth packs only, before the
//      server-pack runtime is resolved
// Run: node scripts/modrinth-pack-runtime-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const agentClient = require("../src/services/agentClient");
const service = require("../src/services/marketplaceInstallService");

const { resolveModrinthDeclaredRuntime, providerPackShipsRuntime, installModrinthDeclaredRuntime } = service._test;

async function main() {
  // R1
  assert.deepStrictEqual(resolveModrinthDeclaredRuntime({ minecraft: "1.21.1", "fabric-loader": "0.16.10" }), { loader: "fabric", minecraftVersion: "1.21.1", loaderVersion: "0.16.10" });
  assert.deepStrictEqual(resolveModrinthDeclaredRuntime({ minecraft: "1.20.1", "quilt-loader": "0.26.0" }), { loader: "quilt", minecraftVersion: "1.20.1", loaderVersion: "0.26.0" });
  assert.deepStrictEqual(resolveModrinthDeclaredRuntime({ minecraft: "1.21.1", neoforge: "21.1.77" }), { loader: "neoforge", minecraftVersion: "1.21.1", loaderVersion: "21.1.77" });
  assert.deepStrictEqual(resolveModrinthDeclaredRuntime({ minecraft: "1.20.1", forge: "47.3.0" }), { loader: "forge", minecraftVersion: "1.20.1", loaderVersion: "47.3.0" });
  assert.deepStrictEqual(resolveModrinthDeclaredRuntime({ minecraft: "1.21.1" }), { loader: "vanilla", minecraftVersion: "1.21.1", loaderVersion: "" });
  for (const bad of [null, {}, { "fabric-loader": "0.16.10" }, { minecraft: "1.21.1/../x", "fabric-loader": "0.16.10" }, { minecraft: "1.21.1", "fabric-loader": "0.16 && x" }]) {
    assert.strictEqual(resolveModrinthDeclaredRuntime(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  console.log("PASS R1 the declared runtime is read from the pack, never guessed");

  const original = { listInstanceFiles: agentClient.listInstanceFiles, writeInstanceFile: agentClient.writeInstanceFile };
  const previousFetch = global.fetch;
  const listing = (names) => async () => ({ entries: names.map((name) => ({ name, type: "file" })) });
  try {
    // R2
    agentClient.listInstanceFiles = listing(["eula.txt", "server.properties"]);
    assert.strictEqual(await providerPackShipsRuntime("i", { type: "jar" }, {}), false, "mods only: no runtime");
    agentClient.listInstanceFiles = listing(["forge-1.20.1-47.3.0-installer.jar"]);
    assert.strictEqual(await providerPackShipsRuntime("i", { type: "jar" }, {}), false, "an installer jar is not a runtime");
    agentClient.listInstanceFiles = listing(["fabric-server.jar"]);
    assert.strictEqual(await providerPackShipsRuntime("i", { type: "jar" }, {}), true, "a server jar is kept");
    assert.strictEqual(await providerPackShipsRuntime("i", { type: "script", path: "run.sh" }, {}), true, "a launch script is kept");
    console.log("PASS R2 a runtime the pack brought is kept; an installer or nothing is not a runtime");

    // R3
    const requests = [];
    const writes = [];
    global.fetch = async (url) => {
      requests.push(String(url));
      if (/\/v2\/versions\/loader$/.test(url)) return new Response(JSON.stringify([{ version: "0.17.0", stable: true }, { version: "0.16.10", stable: true }]));
      if (/\/v2\/versions\/installer$/.test(url)) return new Response(JSON.stringify([{ version: "1.0.3", stable: true }]));
      if (/\/server\/jar$/.test(url)) return new Response(Buffer.from("PK fabric server launcher"));
      return new Response("unexpected", { status: 404 });
    };
    agentClient.writeInstanceFile = async (instanceId, filePath, content, options) => {
      writes.push({ instanceId, filePath, bytes: Buffer.from(content, "base64").length, encoding: options?.encoding });
      return { ok: true };
    };
    const runtime = await installModrinthDeclaredRuntime("pack-1", { minecraft: "1.21.1", "fabric-loader": "0.16.10" }, { loader: "fabric" }, {}, {});
    assert.deepStrictEqual(runtime, { loader: "fabric", minecraftVersion: "1.21.1", loaderVersion: "0.16.10", serverJar: "fabric-server.jar" });
    const jarUrl = requests.find((url) => /\/server\/jar$/.test(url));
    assert.strictEqual(jarUrl, "https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.10/1.0.3/server/jar", "the declared Minecraft and loader versions, not the newest loader");
    assert.deepStrictEqual(writes, [{ instanceId: "pack-1", filePath: "fabric-server.jar", bytes: 25, encoding: "base64" }]);
    console.log("PASS R3 the declared Fabric runtime is downloaded for its declared versions and written");

    // R4
    requests.length = 0;
    writes.length = 0;
    await assert.rejects(installModrinthDeclaredRuntime("pack-2", { "fabric-loader": "0.16.10" }, {}, {}, {}), (error) => error.code === "SERVER_PACK_RUNTIME_UNRESOLVED");
    await assert.rejects(installModrinthDeclaredRuntime("pack-3", { minecraft: "1.21.1", "fabric-loader": "0.16.10" }, { loader: "forge" }, {}, {}), (error) => error.code === "SERVER_PACK_RUNTIME_UNRESOLVED" && /fabric/.test(error.message));
    assert.deepStrictEqual([requests, writes], [[], []], "nothing is downloaded or written for a refused runtime");
    console.log("PASS R4 an undeclared or mismatched runtime is refused before any download");
  } finally {
    global.fetch = previousFetch;
    Object.assign(agentClient, original);
  }

  // R5
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "marketplaceInstallService.js"), "utf8");
  const body = source.slice(source.indexOf("async function continueProviderPackInstall"), source.indexOf("function shouldResolveProviderServerPackRuntime"));
  const guard = body.indexOf('provider === "modrinth" && serverInfo.providerRuntimeDeferred && !(await providerPackShipsRuntime(');
  assert.ok(guard > 0, "the provider install checks for a runtime the Modrinth pack brought");
  assert.ok(guard < body.indexOf("let serverPackRuntime ="), "the declared runtime is installed before the server-pack runtime is resolved");
  assert.ok(/packDependencies = index\.dependencies/.test(source), "the pack's declared dependencies are kept from modrinth.index.json");
  console.log("PASS R5 the provider install installs the declared runtime for Modrinth packs before resolving the runtime");

  // R6: the start command names the jar the pack runs. It was built before
  // the runtime was known ("-jar server.jar"), and the Agent's start-time jar
  // repair keeps the jar already in the arguments, so the server crash-looped
  // on "Unable to access jarfile server.jar" in the real Modrinth install.
  const { replaceJavaJarArgument } = service._test;
  assert.deepStrictEqual(replaceJavaJarArgument(["-Xmx4G", "-jar", "server.jar", "nogui"], "fabric-server.jar"), ["-Xmx4G", "-jar", "fabric-server.jar", "nogui"]);
  assert.strictEqual(replaceJavaJarArgument(["-Xmx4G", "-jar", "fabric-server.jar", "nogui"], "fabric-server.jar"), null, "nothing to change");
  assert.strictEqual(replaceJavaJarArgument(["run.sh"], "fabric-server.jar"), null, "a command without -jar is left alone");
  assert.ok(/\.\.\.\(jarArgs \? \{ args: jarArgs \} : \{\}\)/.test(body), "the activation patch carries the corrected arguments");
  console.log("PASS R6 the activated start command names the jar the pack runs");
  console.log("Modrinth pack runtime smoke passed (6 checks).");
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
