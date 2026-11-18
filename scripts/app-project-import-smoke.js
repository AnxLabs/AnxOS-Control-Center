#!/usr/bin/env node
"use strict";

// Build 214: deploying your own Node.js or Python project from a .zip.
//   P1 a Node.js project is read with its single top folder removed, version
//      control folders skipped, and package.json "main" chosen to start
//   P2 every hostile or broken archive is refused before anything is sent:
//      a path that leaves the folder, an absolute path, a backslash name, a
//      link, two names differing only in case, a missing start file, a file
//      that is not a zip, and a file name other than .zip
//   P3 packages AnxOS cannot install are refused with a clear message:
//      Node.js dependencies without node_modules, a Python requirements.txt
//   P4 the instance runs the chosen file in data/app with the user's
//      arguments (node; python on Windows, python3 elsewhere), and an import
//      card never gets a starter file written into it
//      (the Python dependency is detected with "python" on Windows)
//   P5 a file chosen for one card is never used by another
//   P6 a secret the user types (the Discord bot token) is taken out of the
//      install request before anything else reads it; only declared names are
//      accepted, a required one must be given, and the Python bot card is
//      unavailable with its reason
// Run: node scripts/app-project-import-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { zipBuffer } = require("../test-helpers/zip-writer");
const { inspectProjectArchive } = require("../src/shared/projectArchiveImport");
const marketplaceService = require("../src/services/marketplaceService");

const templates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketplace-templates.json"), "utf8"));
const template = (id) => templates.find((entry) => entry.id === id);

async function refused(entries, kind, pattern, label) {
  await assert.rejects(inspectProjectArchive(Buffer.isBuffer(entries) ? entries : zipBuffer(entries), "project.zip", kind), (error) => {
    assert.match(`${error.code} ${error.message}`, pattern, label);
    return true;
  }, label);
}

async function main() {
  // P1
  const node = await inspectProjectArchive(zipBuffer([
    { name: "my-bot/", data: "" },
    { name: "my-bot/package.json", data: JSON.stringify({ name: "my-bot", main: "src/start.js", dependencies: { ws: "^8" } }) },
    { name: "my-bot/src/start.js", data: "console.log('hi')" },
    { name: "my-bot/node_modules/ws/index.js", data: "module.exports = {}" },
    { name: "my-bot/.git/config", data: "[core]" },
  ]), "my-bot.zip", "node-application");
  assert.strictEqual(node.entry, "src/start.js", "package.json main is started");
  assert.strictEqual(node.rootFolder, "my-bot", "the single top folder is removed");
  assert.deepStrictEqual(node.files.map((file) => file.path).sort(), ["node_modules/ws/index.js", "package.json", "src/start.js"], "version control folders are not copied");
  const python = await inspectProjectArchive(zipBuffer([{ name: "app.py", data: "print('hi')" }, { name: "requirements.txt", data: "# standard library only\n" }]), "p.zip", "python-application");
  assert.strictEqual(python.entry, "app.py");
  console.log("PASS P1 a project is read with its top folder removed and the right start file");

  // P2
  await refused([{ name: "../evil.js", data: "x" }, { name: "package.json", data: "{}" }], "node-application", /leaves its folder/, "a path that leaves the folder");
  await refused([{ name: "/etc/passwd", data: "x" }], "node-application", /absolute path/, "an absolute path");
  await refused([{ name: "C:/x.js", data: "x" }], "node-application", /absolute path/, "a drive path");
  await refused([{ name: "a\\..\\b.js", data: "x" }], "node-application", /unsafe name/, "a backslash name");
  await refused([{ name: "package.json", data: "{}" }, { name: "index.js", data: "x" }, { name: "link", data: "/etc", mode: 0o120777 }], "node-application", /link/, "a symbolic link");
  await refused([{ name: "package.json", data: "{}" }, { name: "index.js", data: "x" }, { name: "Index.js", data: "y" }], "node-application", /letter case/, "names differing only in case");
  await refused([{ name: "package.json", data: "{}" }, { name: "readme.md", data: "x" }], "node-application", /none of index\.js/, "no start file");
  await refused([{ name: "package.json", data: JSON.stringify({ main: "gone.js" }) }], "node-application", /does not contain it/, "a missing main file");
  await refused([{ name: "readme.md", data: "x" }], "python-application", /none of main\.py/, "no Python start file");
  await refused([{ name: "index.js", data: "x" }], "node-application", /no package\.json/, "not a Node.js project");
  await refused(Buffer.from("not a zip at all"), "node-application", /not a \.zip/, "not a zip");
  await assert.rejects(inspectProjectArchive(zipBuffer([{ name: "index.js", data: "x" }]), "project.tar", "node-application"), /Choose a \.zip/);
  console.log("PASS P2 hostile and broken archives are refused before anything is sent");

  // P3
  await refused([{ name: "package.json", data: JSON.stringify({ dependencies: { express: "^5", ws: "^8" } }) }, { name: "index.js", data: "x" }], "node-application", /NODE_APP_DEPENDENCIES_MISSING.*npm install --omit=dev/, "dependencies without node_modules");
  await refused([{ name: "main.py", data: "import requests" }, { name: "requirements.txt", data: "requests==2.32\n# comment\nflask\n" }], "python-application", /PYTHON_APP_PACKAGES_UNSUPPORTED.*2 packages/, "Python packages");
  console.log("PASS P3 packages AnxOS cannot install are refused with a clear message");

  // P4
  const build = marketplaceService._test.buildInstancePayload;
  const nodePayload = build(template("node-app-import"), { name: "My Bot", applicationEntry: "src/start.js", programArguments: "--level \"very high\"", memory: "256M" }, [3001]);
  assert.strictEqual(nodePayload.type, "node-app");
  assert.strictEqual(nodePayload.workingDirectory, "data/app");
  assert.strictEqual(nodePayload.executable, "node");
  assert.deepStrictEqual(nodePayload.args, ["src/start.js", "--level", "very high"], "the chosen file then the user's arguments");
  assert.strictEqual(nodePayload.environment.PORT, "3001", "the chosen port is passed as PORT");
  assert.strictEqual(nodePayload.readinessMode, null, "an app with a port is ready on its port");
  const windowsPython = build({ ...template("python-app-import"), targetPlatform: "windows" }, { name: "Py", applicationEntry: "main.py" }, []);
  assert.strictEqual(windowsPython.executable, "python", "Windows starts python (python3 is usually the Store stub)");
  assert.strictEqual(windowsPython.readinessMode, "process", "an app without a port is ready once it keeps running");
  assert.strictEqual(build({ ...template("python-app-import"), targetPlatform: "linux" }, { name: "Py", applicationEntry: "main.py" }, []).executable, "python3");
  assert.throws(() => build(template("node-app-import"), { name: "x" }, []), /zip file again/, "no checked archive, no instance");
  for (const id of ["node-app-import", "python-app-import"]) {
    assert.strictEqual(marketplaceService._test.generatedFileForTemplate(template(id), { name: "x" }, [3000]), null, `${id} never gets a starter file`);
  }
  assert.ok(marketplaceService._test.generatedFileForTemplate(template("node-app"), { name: "x" }, [3000]), "the starter card still writes its starter file");
  // The Python dependency is detected with "python" on Windows: "python3"
  // there is usually the Microsoft Store stub, so the check always failed.
  const { DEPENDENCY_REGISTRY } = require("../src/shared/marketplaceDependencies");
  assert.deepStrictEqual(DEPENDENCY_REGISTRY.python.windowsCommands, ["python"]);
  assert.strictEqual(DEPENDENCY_REGISTRY.python.windowsVersionCommand.command, "python");
  console.log("PASS P4 the imported project runs its chosen file in data/app with the user's arguments");

  // P5
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-app-import-"));
  try {
    const archive = path.join(root, "project.zip");
    fs.writeFileSync(archive, zipBuffer([{ name: "package.json", data: "{}" }, { name: "index.js", data: "x" }]));
    const chosen = marketplaceService.rememberApplicationFile(archive, "node-application");
    const loaded = await marketplaceService._test.loadSelectedApplicationFile(chosen.token, "node-application");
    assert.strictEqual(loaded.entry, "index.js");
    await assert.rejects(marketplaceService._test.loadSelectedApplicationFile(chosen.token, "python-application"), /zip file again/, "a Node.js file is not used for the Python card");
    await assert.rejects(marketplaceService._test.loadSelectedApplicationFile(chosen.token, "java-application"), /\.jar file again/, "nor for the Java card");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("PASS P5 a file chosen for one card is never used by another");

  // P6
  const take = marketplaceService._test.takeUserSecrets;
  const bot = template("discord-js");
  const request = { templateId: "discord-js", options: { name: "Bot", userSecrets: { DISCORD_TOKEN: "  abc.def  " } } };
  const taken = take(bot, request);
  assert.deepStrictEqual(taken.values, { DISCORD_TOKEN: "abc.def" });
  assert.ok(!JSON.stringify(taken.payload).includes("abc.def"), "the request passed on carries no secret");
  assert.ok(request.options.userSecrets, "the caller's object is not modified");
  assert.throws(() => take(bot, { options: { userSecrets: {} } }), (error) => error.code === "USER_SECRET_REQUIRED" && /bot token/.test(error.message));
  assert.throws(() => take(bot, { options: { userSecrets: { DISCORD_TOKEN: "a", OTHER: "b" } } }), (error) => error.code === "USER_SECRET_NOT_DECLARED");
  assert.throws(() => take(bot, { options: { userSecrets: { DISCORD_TOKEN: "a\nb" } } }), (error) => error.code === "USER_SECRET_INVALID");
  assert.throws(() => take(template("node-app-import"), { options: { userSecrets: { DISCORD_TOKEN: "a" } } }), (error) => error.code === "USER_SECRET_NOT_DECLARED", "a card that declares none accepts none");
  assert.deepStrictEqual(take(template("node-app-import"), { options: { name: "x" } }).values, {});
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "marketplaceService.js"), "utf8");
  const executor = source.slice(source.indexOf("async function executeInstallTemplate"));
  assert.ok(executor.indexOf("takeUserSecrets(") < executor.indexOf("console.info("), "secrets are taken out before the first log line");
  assert.strictEqual(template("python-discord-bot").disabled, true, "the Python bot card is unavailable");
  assert.match(template("python-discord-bot").comingSoonMessage, /does not install Python packages/);
  console.log("PASS P6 a typed bot token is taken out of the request first; only declared secrets are accepted");
  console.log("App project import smoke passed (6 checks).");
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
