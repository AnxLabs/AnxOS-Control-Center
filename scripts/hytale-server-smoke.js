#!/usr/bin/env node
"use strict";

// Hytale dedicated server support. The template installs HytaleServer.jar from
// Hypixel Studios' official Maven repository (checked against its .sha1), and
// a generated launcher runs Hytale's own bootstrap on the first start (account
// sign-in, then the official server files) before handing over to the official
// start.sh. Readiness comes from Hytale's log lines because its QUIC port is UDP.
// Run: node scripts/hytale-server-smoke.js

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const templates = require("../config/marketplace-templates.json");
const agentClient = require("../src/services/agentClient");
const marketplaceService = require("../src/services/marketplaceService");
const instanceService = require("../src/shared/instances/instanceServiceCore");

const template = templates.find((entry) => entry.id === "hytale");
let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };

const MAVEN = "https://maven.hytale.com/release/com/hypixel/hytale/Server";
const METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<metadata><groupId>com.hypixel.hytale</groupId><artifactId>Server</artifactId><versioning>
<latest>0.7.5</latest><release>0.7.5</release>
<versions><version>0.6.9</version><version>0.7.4</version><version>0.7.5</version></versions>
</versioning></metadata>`;
const JAR = Buffer.from("fake hytale server jar");
const JAR_SHA1 = crypto.createHash("sha1").update(JAR).digest("hex");

function installFetch(routes, requests) {
  global.fetch = async (url) => {
    requests.push(String(url));
    const route = routes[String(url)];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return new Response(route, { status: 200 });
  };
}

function launcherScript() {
  return template.configFiles.find((file) => file.path === "server/anxos-hytale-start.sh").lines.join("\n") + "\n";
}

(async () => {
  const originalFetch = global.fetch;

  // H1: the template is a real, Linux-only, installable definition.
  assert.ok(template, "the hytale template exists");
  assert.notStrictEqual(template.disabled, true);
  assert.notStrictEqual(template.comingSoon, true);
  assert.strictEqual(marketplaceService._test.validateMarketplaceTemplate(template).installerType, "direct-download");
  assert.deepStrictEqual(template.defaultPorts, [5520]);
  assert.deepStrictEqual(template.downloads.map((download) => [download.resolver, download.destination]), [["hytale-maven", "server/HytaleServer.jar"]]);
  const windows = marketplaceService._test.resolveTemplateForPlatform(template, "windows");
  assert.strictEqual(windows.disabled, true, "Windows nodes are refused, not half-supported");
  const linux = marketplaceService._test.resolveTemplateForPlatform(template, "linux");
  assert.notStrictEqual(linux.disabled, true);
  const payload = marketplaceService._test.buildInstancePayload(linux, { name: "Hytale Smoke", port: 5520, memory: "6G" }, [5520]);
  assert.strictEqual(payload.executable, "bash");
  assert.deepStrictEqual(payload.args, ["./anxos-hytale-start.sh", "--bind", "0.0.0.0:5520"]);
  assert.strictEqual(payload.workingDirectory, "data/server");
  assert.ok(payload.startupTimeoutMs >= 600000, "the first start leaves time for the account sign-in (the device code is valid for 10 minutes)");
  const jvmOptions = template.configFiles.find((file) => file.path === "server/jvm.options");
  assert.match(marketplaceService._test.buildConfigFileContent(jvmOptions, linux, { memory: "6G" }, [5520]), /^-Xmx6G$/m);
  assert.strictEqual(
    marketplaceService._test.buildConfigFileContent(template.configFiles[0], linux, { memory: "6G" }, [5520]),
    launcherScript(),
    "the launcher contains no {placeholder} that template expansion would rewrite",
  );
  pass("H1 the template installs on Linux nodes, refuses Windows nodes, and starts the generated launcher on the chosen UDP port");

  // H2: the resolver reads only the official repository and pins the checksum.
  let requests = [];
  installFetch({
    [`${MAVEN}/maven-metadata.xml`]: METADATA,
    [`${MAVEN}/0.7.5/Server-0.7.5.jar.sha1`]: `${JAR_SHA1}\n`,
  }, requests);
  const download = template.downloads[0];
  const resolved = await marketplaceService._test.resolveDownloadUrl(download, {}, {});
  assert.deepStrictEqual(resolved, { url: `${MAVEN}/0.7.5/Server-0.7.5.jar`, version: "0.7.5", sha1: JAR_SHA1, javaMinimum: 25 });
  assert.ok(requests.every((url) => url.startsWith("https://maven.hytale.com/")), "only the official repository is contacted");
  await assert.rejects(
    () => marketplaceService._test.resolveDownloadUrl(download, { version: "0.7.4" }, {}),
    (error) => error.code === "DOWNLOAD_RESOLVE_FAILED" && /checksum lookup/.test(error.message),
    "a listed version whose .sha1 is unavailable is refused, not installed unverified",
  );
  pass("H2 the resolver takes the release version and SHA-1 from maven.hytale.com and refuses a version without one");

  // H3: unlisted or malformed versions never reach a download URL.
  requests = [];
  installFetch({ [`${MAVEN}/maven-metadata.xml`]: METADATA }, requests);
  for (const version of ["0.9.9", "../../evil", "0.7.5/../x"]) {
    await assert.rejects(
      () => marketplaceService._test.resolveDownloadUrl(template.downloads[0], { version }, {}),
      (error) => error.code === "DOWNLOAD_RESOLVE_FAILED",
      `version ${version} must be refused`,
    );
  }
  assert.ok(requests.every((url) => url.endsWith("maven-metadata.xml")), "no artifact URL is requested for a refused version");
  await assert.rejects(
    () => marketplaceService._test.resolveDownloadUrl({ ...template.downloads[0], patchline: "nightly" }, {}, {}),
    (error) => error.code === "INVALID_TEMPLATE_CATALOG",
  );
  installFetch({
    [`${MAVEN}/maven-metadata.xml`]: METADATA,
    [`${MAVEN}/0.7.5/Server-0.7.5.jar.sha1`]: "not-a-digest",
  }, requests);
  await assert.rejects(() => marketplaceService._test.resolveDownloadUrl(template.downloads[0], {}, {}), /checksum is malformed/);
  pass("H3 unlisted versions, unknown patchlines and malformed checksums are refused");

  // H4: the downloaded JAR is written only when its SHA-1 matches.
  const writes = [];
  agentClient.writeInstanceFile = async (instanceId, filePath, content) => { writes.push({ instanceId, filePath, bytes: Buffer.from(content, "base64") }); return { ok: true }; };
  agentClient.readInstanceFile = async () => ({ content: "" });
  const routes = {
    [`${MAVEN}/maven-metadata.xml`]: METADATA,
    [`${MAVEN}/0.7.5/Server-0.7.5.jar.sha1`]: JAR_SHA1,
    [`${MAVEN}/0.7.5/Server-0.7.5.jar`]: JAR,
  };
  installFetch(routes, requests);
  const normalized = marketplaceService._test.normalizeTemplateDownloads(template)[0];
  const progress = [];
  const ok = await marketplaceService._test.downloadOneToInstance(template, normalized, {}, "hytale-smoke", progress, null, null, null);
  assert.strictEqual(ok.downloaded, true);
  assert.deepStrictEqual(writes.map((write) => [write.filePath, write.bytes.equals(JAR)]), [["server/HytaleServer.jar", true]]);
  assert.strictEqual(ok.metadata.serverVersion, "0.7.5");
  routes[`${MAVEN}/0.7.5/Server-0.7.5.jar`] = Buffer.from("tampered jar");
  writes.length = 0;
  await assert.rejects(
    () => marketplaceService._test.downloadOneToInstance(template, normalized, {}, "hytale-smoke", [], null, null, null),
    (error) => error.code === "DOWNLOAD_CHECKSUM_MISMATCH" && error.details?.expectedSha1 === JAR_SHA1,
  );
  assert.deepStrictEqual(writes, [], "a JAR that fails verification is never written to the instance");
  pass("H4 the JAR is written only when it matches the publisher's SHA-1");

  // H5: family, world scope and readiness.
  const config = { id: "hytale-smoke", templateId: "hytale", displayName: "Hytale Dedicated Server", type: "custom-command", tags: ["hytale", "game-server"] };
  assert.deepStrictEqual(instanceService.getWorldScopeCandidates(config), ["server/Server/universe"]);
  const ready = instanceService.hytaleReadinessUpdate;
  const booted = "[HytaleServer] Hytale Server Booted! [Multiplayer, Fresh Universe] took 873ms";
  assert.strictEqual(ready(booted, { layoutInstalled: false }), null, "the bootstrap's own boot line is not readiness");
  assert.strictEqual(ready("Authentication successful! Mode: OAUTH_DEVICE", { layoutInstalled: false }), null);
  assert.deepStrictEqual(ready(booted, { layoutInstalled: true }), { readinessState: "ready", healthState: "healthy", failureReason: null });
  const authRequired = { readinessState: "degraded", healthState: "degraded", failureReason: "HYTALE_AUTH_REQUIRED" };
  assert.deepStrictEqual(ready("WARN [HytaleServer] No server tokens configured. Use /auth login to authenticate.", { layoutInstalled: true }), authRequired);
  assert.deepStrictEqual(ready(`${booted}\nWARN No server tokens configured. Use /auth login to authenticate.`, { layoutInstalled: true }), authRequired, "a boot without credentials is degraded, never ready");
  assert.deepStrictEqual(ready("Authentication successful! Mode: OAUTH_DEVICE", { layoutInstalled: true }), { readinessState: "ready", healthState: "healthy", failureReason: null });
  assert.strictEqual(ready("[PluginManager] Server started plugin X", { layoutInstalled: true }), null);
  const core = fs.readFileSync(path.join(ROOT, "src", "shared", "instances", "instanceServiceCore.js"), "utf8");
  const stdoutHandler = core.slice(core.indexOf("child.stdout.on(\"data\""), core.indexOf("child.stderr.on(\"data\""));
  assert.ok(stdoutHandler.indexOf("updateHytaleReadiness(") > 0 && stdoutHandler.indexOf("updateHytaleReadiness(") < stdoutHandler.indexOf("Server marked as running"), "Hytale output never reaches the generic readiness regex");
  pass("H5 Hytale is its own family with universe/ world backups and log-based readiness (unauthenticated = degraded)");

  // H5b: the Marketplace card's installed-version line names Minecraft only
  // for Minecraft servers (Build 208 acceptance showed "Minecraft 0.7.5" on
  // the installed Hytale card).
  const ui = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const versionLine = ui.slice(ui.indexOf("function getMarketplaceInstalledInstanceVersion("), ui.indexOf("function getMarketplaceInstalledProviderVersionId("));
  assert.match(versionLine, /version\.isMinecraft \? `Minecraft \$\{version\.gameVersion\}` : version\.gameVersion/, "only Minecraft servers get the Minecraft prefix");
  assert.doesNotMatch(versionLine, /"Unknown version" \? `Minecraft/, "the Minecraft prefix must not be unconditional");
  pass("H5b the installed Marketplace card labels a Hytale version without \"Minecraft\"");

  // H5c: opening the Marketplace page loads the node's instances, so an
  // installed template is shown as installed. Acceptance saw the installed
  // Hytale server listed as "Available" both in a freshly opened Marketplace
  // window and in the main window when it started on the Marketplace page.
  const showPageSource = ui.slice(ui.indexOf("function showPage("), ui.indexOf("function showPage(") + 12000);
  assert.match(showPageSource, /safePageName === "marketplace"\) \{[^}]*refreshMarketplace\(\);[^}]*refreshInstances\(\{ background: true, refreshMetrics: false \}\)/, "opening the Marketplace page must load instances");
  const workspaceContext = ui.slice(ui.indexOf("async function applyWorkspaceWindowContext("), ui.indexOf("document.title = \"Create Server — AnxOS Control Center\";"));
  assert.ok(workspaceContext.indexOf("showPage(\"marketplace\")") > 0, "the Marketplace window opens through showPage, so it loads instances too");
  const snapshotRender = ui.slice(ui.indexOf("function renderInstancesSnapshot("), ui.indexOf("function renderInstancesSnapshot(") + 6000);
  assert.match(snapshotRender, /getActivePageName\(\) === "marketplace"\)\s*\{\s*renderMarketplaceTemplates\(\);/, "a loaded instance list re-renders the Marketplace cards");
  pass("H5c opening the Marketplace (main window or its own window) loads instances so installed templates show as installed");

  // H6: the launcher itself (needs bash with mkfifo; Linux nodes only).
  if (process.platform === "win32") {
    console.log("SKIP H6 launcher run needs a Linux shell (verify on a Linux node: node scripts/hytale-server-smoke.js)");
  } else {
    runLauncherChecks();
    pass("H6 the launcher picks Java 25, signs in, runs 'update download', then execs start.sh with the bind argument");
  }

  global.fetch = originalFetch;
  console.log(`hytale server smoke passed (${results} checks).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

function runLauncherChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-hytale-"));
  const binDir = path.join(dir, "fakebin");
  fs.mkdirSync(binDir);
  const javaPath = path.join(binDir, "java");
  // Fake Java 25: bootstrap prints Hytale's real lines, waits for the
  // 'update download' command on stdin, then writes the official layout.
  fs.writeFileSync(javaPath, [
    "#!/usr/bin/env bash",
    "if [ \"$1\" = \"-version\" ]; then echo 'openjdk version \"25.0.3\" 2026-04-21' >&2; exit 0; fi",
    "case \" $* \" in *\" --bootstrap \"*)",
    "  echo '[HytaleServer] Hytale Server Booted! [Multiplayer, Fresh Universe]'",
    "  echo 'Visit: https://oauth.accounts.hytale.com/oauth2/device/verify'",
    "  sleep 1; echo 'Authentication successful! Mode: OAUTH_DEVICE'",
    "  read -r -t 20 command || exit 9",
    "  [ \"$command\" = 'update download' ] || exit 10",
    "  mkdir -p Server && echo jar > Server/HytaleServer.jar && echo zip > Assets.zip",
    "  printf '#!/usr/bin/env bash\\necho \"START_SH $*\"\\n' > start.sh",
    "  exit 0 ;;",
    "esac",
    "exit 11",
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "HytaleServer.jar"), "bootstrap jar");
  fs.writeFileSync(path.join(dir, "anxos-hytale-start.sh"), launcherScript());
  const run = childProcess.spawnSync("bash", ["./anxos-hytale-start.sh", "--bind", "0.0.0.0:5520"], {
    cwd: dir,
    env: { ...process.env, ANXOS_HYTALE_JAVA: javaPath },
    input: "",
    encoding: "utf8",
    timeout: 60000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.strictEqual(run.status, 0, output);
  assert.match(output, /\[AnxOS\] Java: openjdk version "25/);
  assert.match(output, /Authentication successful/);
  assert.match(output, /START_SH --bind 0\.0\.0\.0:5520/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "permissions.json"), "utf8"), "{}\n");
  assert.strictEqual(fs.existsSync(path.join(dir, ".anxos-bootstrap.in")), false, "the console FIFO is removed");

  // Second start: the layout exists, so start.sh runs directly.
  const again = childProcess.spawnSync("bash", ["./anxos-hytale-start.sh", "--bind", "0.0.0.0:5521"], { cwd: dir, env: { ...process.env, ANXOS_HYTALE_JAVA: javaPath }, input: "", encoding: "utf8", timeout: 30000 });
  assert.strictEqual(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /First start/);
  assert.match(again.stdout, /START_SH --bind 0\.0\.0\.0:5521/);

  // No Java 25 anywhere: a clear refusal instead of a confusing JVM error.
  fs.writeFileSync(javaPath, "#!/usr/bin/env bash\necho 'openjdk version \"21.0.4\"' >&2\n", { mode: 0o755 });
  const old = childProcess.spawnSync("bash", ["./anxos-hytale-start.sh"], { cwd: dir, env: { PATH: `${binDir}:/usr/bin:/bin`, ANXOS_HYTALE_JAVA: javaPath, HOME: dir }, input: "", encoding: "utf8", timeout: 30000 });
  const systemJvms = fs.existsSync("/usr/lib/jvm") ? fs.readdirSync("/usr/lib/jvm") : [];
  // A node with a system Java 25 legitimately falls through to it.
  if (!systemJvms.some((name) => /25/.test(name))) {
    assert.strictEqual(old.status, 3, old.stderr);
    assert.match(old.stderr, /needs Java 25/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
