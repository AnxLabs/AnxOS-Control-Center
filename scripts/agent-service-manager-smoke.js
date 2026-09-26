#!/usr/bin/env node
// Headless Agent service-manager smoke.
//
// Unit-level against the injectable command-runner seam (no live systemd, no
// root, runs on any platform): system/user/none unit detection, the generated
// user-unit content for a source install (real ExecStart targets, env defaults
// before the EnvironmentFile, mode 0600 where the FS supports it), --user vs
// system command shapes, package-managed and privilege refusals, override-file
// key preservation, and the guarantee that uninstall removes only the unit
// file — never configuration, instances, or backups.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createServiceManager } = require("../agent/src/services/agentServiceManager");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-service-smoke-"));
const xdgRoot = path.join(smokeRoot, "xdg");
const configDir = path.join(smokeRoot, "config");
const instanceRoot = path.join(smokeRoot, "instances");
const backupRoot = path.join(smokeRoot, "backups");
const logDir = path.join(smokeRoot, "logs");
const overridePath = path.join(smokeRoot, "override", "agent.env");
const fixtureNode = path.join(smokeRoot, "fixture-bin", "node");
const fixtureServer = path.join(smokeRoot, "fixture-agent", "server.js");
const userUnitPath = path.join(xdgRoot, "systemd", "user", "anxos-agent.service");
const packageUnitPath = path.join(smokeRoot, "pkg-unit", "anxos-agent.service");
const missingSystemUnitPath = path.join(smokeRoot, "never-created-system-unit", "anxos-agent.service");

for (const dir of [configDir, instanceRoot, backupRoot, logDir, path.dirname(fixtureNode), path.dirname(fixtureServer)]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(fixtureNode, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
fs.writeFileSync(fixtureServer, "// fixture agent entry point\n", "utf8");

const baseEnv = {
  XDG_CONFIG_HOME: xdgRoot,
  ANXHUB_CONFIG_DIR: configDir,
  AGENT_INSTANCE_ROOT: instanceRoot,
  AGENT_BACKUP_ROOT: backupRoot,
  ANXOS_LOG_DIR: logDir,
  AGENT_ENV_OVERRIDE_PATH: overridePath,
};

function makeRunner(responses = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const key = args.join(" ");
    if (Object.prototype.hasOwnProperty.call(responses, key)) {
      return typeof responses[key] === "function" ? responses[key]() : responses[key];
    }
    if (key === "--version") return { ok: true, code: 0, stdout: "systemd 255\n", stderr: "" };
    if (args[0] === "is-enabled" || args[1] === "is-enabled") return { ok: true, code: 0, stdout: "enabled\n", stderr: "" };
    if (args[0] === "is-active" || args[1] === "is-active") return { ok: true, code: 0, stdout: "active\n", stderr: "" };
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function makeManager(overrides = {}) {
  const { runner, calls } = makeRunner(overrides.responses || {});
  const manager = createServiceManager({
    platform: overrides.platform || "linux",
    env: { ...baseEnv, ...(overrides.env || {}) },
    runner,
    homeDir: path.join(smokeRoot, "home"),
    xdgConfigHome: xdgRoot,
    systemUnitPaths: overrides.systemUnitPaths || [missingSystemUnitPath],
    isRoot: overrides.isRoot || (() => false),
    nodeExecutable: fixtureNode,
    serverScript: fixtureServer,
    runtimeConfig: {},
  });
  return { manager, calls };
}

function hasCommand(calls, args) {
  return calls.some((call) => JSON.stringify(call.args) === JSON.stringify(args));
}

function assertNoDataPathTouched(values, label) {
  for (const call of values) {
    const text = `${call.command || ""} ${call.args.join(" ")}`;
    assert(!/rm\b|unlink/i.test(text), `${label}: no command may delete files (${text}).`);
    for (const sensitive of [configDir, instanceRoot, backupRoot, logDir]) {
      assert(!text.includes(sensitive), `${label}: no command may touch data path ${sensitive} (${text}).`);
    }
  }
}

async function main() {
  // --- detection: none / system / user ------------------------------------
  const noneDetection = makeManager();
  assert.deepStrictEqual(noneDetection.manager.resolveMode(), { mode: "none", unitPath: null }, "a machine with no unit must detect mode=none.");
  const noneStatus = await noneDetection.manager.status();
  assert.strictEqual(noneStatus.supported, true, "linux service status must be supported.");
  assert.strictEqual(noneStatus.installed, false, "mode=none must report not installed.");
  assert.strictEqual(noneStatus.state, "not-installed", "mode=none must report not-installed.");
  await assert.rejects(
    async () => noneDetection.manager.start(),
    (error) => error.code === "SERVICE_NOT_INSTALLED",
    "lifecycle without a unit must refuse with SERVICE_NOT_INSTALLED.",
  );

  fs.mkdirSync(path.dirname(packageUnitPath), { recursive: true });
  fs.writeFileSync(packageUnitPath, "[Unit]\nDescription=AnxOS Agent\n", "utf8");
  const systemDetection = makeManager({ systemUnitPaths: [packageUnitPath] });
  assert.strictEqual(systemDetection.manager.resolveMode().mode, "system", "a package unit must detect mode=system.");
  const systemStatus = await systemDetection.manager.status();
  assert.strictEqual(systemStatus.privilege.rootRequired, true, "a system unit must report that root is required.");
  assert.strictEqual(systemStatus.enabled, true, "status must parse is-enabled output.");
  assert.strictEqual(systemStatus.active, true, "status must parse is-active output.");

  fs.mkdirSync(path.dirname(userUnitPath), { recursive: true });
  fs.writeFileSync(userUnitPath, "[Unit]\nDescription=AnxOS Agent\n", "utf8");
  const userDetection = makeManager();
  assert.strictEqual(userDetection.manager.resolveMode().mode, "user", "a user unit must detect mode=user.");

  // --- unit content for a source install ----------------------------------
  const sourceManager = makeManager().manager;
  const unitText = sourceManager.buildUserUnit();
  assert(fs.existsSync(fixtureServer), "the ExecStart server script must be a real file.");
  assert(fs.existsSync(fixtureNode), "the ExecStart node executable must be a real file.");
  const unitQuote = (value) => `"${String(value).replace(/([\\"])/g, "\\$1")}"`;
  assert(unitText.includes(`ExecStart=${unitQuote(fixtureNode)} ${unitQuote(fixtureServer)}`), "ExecStart must quote the real node executable and server script.");
  const environmentLines = unitText.split("\n").filter((line) => line.startsWith("Environment="));
  const environmentFileIndex = unitText.split("\n").findIndex((line) => line.startsWith("EnvironmentFile="));
  const execStartIndex = unitText.split("\n").findIndex((line) => line.startsWith("ExecStart="));
  assert(environmentLines.length >= 7, "the unit must set the Agent env defaults.");
  assert(unitText.includes("EnvironmentFile=-" + overridePath), "the override file must be read with a leading '-' so the unit stays valid before it exists.");
  assert(environmentLines.every((line) => unitText.split("\n").indexOf(line) < environmentFileIndex), "EnvironmentFile must be ordered after the env defaults so overrides win.");
  assert(environmentFileIndex < execStartIndex, "EnvironmentFile must be read before ExecStart.");
  assert(unitText.includes('AGENT_HOST=127.0.0.1'), "the unit must default the bind host to loopback.");
  assert(unitText.includes("AGENT_PORT=47131"), "the unit must default the Agent port.");
  assert(unitText.includes(unitQuote(`ANXHUB_CONFIG_DIR=${configDir}`)), "the unit must point the Agent at the stable config dir.");
  assert(unitText.includes(unitQuote(`AGENT_INSTANCE_ROOT=${instanceRoot}`)), "the unit must point the Agent at the stable instance root.");
  assert(unitText.includes(unitQuote(`ANXOS_LOG_DIR=${logDir}`)), "the unit must point the Agent at the stable log dir.");
  assert(unitText.includes("WantedBy=default.target"), "a user unit must be wanted by default.target.");

  // --- newline injection cannot add directives to the unit -----------------
  // F4: a newline in any embedded value would start a new systemd directive or
  // continuation line. AGENT_HOST is rejected through the same shape rules
  // setBindingOverride uses; every other value is stripped before quoting.
  const hostileHost = makeManager({ env: { AGENT_HOST: "10.0.0.5\nRestart=always\nExecStart=/bin/sh -c evil" } });
  assert.throws(
    () => hostileHost.manager.buildUserUnit(),
    (error) => error.code === "AGENT_BIND_HOST_INVALID" && /AGENT_HOST/.test(error.message),
    "a newline-bearing AGENT_HOST must be rejected before a unit is written.",
  );

  const baselineLineCount = unitText.split("\n").length;
  const hostileLogDir = `${logDir}\nRestart=always`;
  const injectedUnit = makeManager({ env: { ANXOS_LOG_DIR: hostileLogDir } }).manager.buildUserUnit();
  assert.strictEqual(injectedUnit.split("\n").length, baselineLineCount, "a newline-bearing value must not change the generated unit line count.");
  assert(!injectedUnit.split("\n").some((line) => line.trim() === "Restart=always"), "a newline-bearing value must not inject a directive line.");
  assert.strictEqual(injectedUnit.split("\n").filter((line) => line.startsWith("Environment=")).length, environmentLines.length, "a newline-bearing value must not add Environment lines.");
  assert(injectedUnit.includes(unitQuote(`ANXOS_LOG_DIR=${logDir}Restart=always`)), "the CR/LF must be stripped inside the quoted single line.");

  const hostileConfigDir = `${configDir}\nExecStart=/bin/sh -c evil`;
  const execStartUnit = makeManager({ env: { ANXHUB_CONFIG_DIR: hostileConfigDir } }).manager.buildUserUnit();
  assert.strictEqual(execStartUnit.split("\n").filter((line) => line.startsWith("ExecStart=")).length, 1, "exactly one ExecStart directive may exist.");
  assert(!execStartUnit.split("\n").some((line) => line.startsWith("ExecStart=/bin/sh")), "a newline-bearing config dir must not inject an ExecStart directive.");
  assert(execStartUnit.includes(unitQuote(`ANXHUB_CONFIG_DIR=${configDir}ExecStart=/bin/sh -c evil`)), "the CR/LF must be stripped inside the quoted config-dir value.");

  const hostileOverrideUnit = makeManager({ env: { AGENT_ENV_OVERRIDE_PATH: `${overridePath}\nRestart=always` } }).manager.buildUserUnit();
  assert.strictEqual(hostileOverrideUnit.split("\n").length, baselineLineCount, "a newline-bearing override path must not change the unit line count.");
  assert(!hostileOverrideUnit.split("\n").some((line) => line.trim() === "Restart=always"), "a newline-bearing override path must not inject a directive line.");
  assert(hostileOverrideUnit.includes(`EnvironmentFile=-${overridePath}Restart=always`), "the CR/LF must be stripped from the EnvironmentFile path.");

  // A wildcard/loopback bind is a valid unit value even though
  // setBindingOverride refuses it for interactive confirmation; the unit
  // generator applies only the shared shape rules.
  const wildcardUnit = makeManager({ env: { AGENT_HOST: "0.0.0.0" } }).manager.buildUserUnit();
  assert(wildcardUnit.includes("AGENT_HOST=0.0.0.0"), "a wildcard bind must remain a valid unit value.");
  const { quoteUnitValue, validateHostShape } = require("../agent/src/services/agentServiceManager")._test;
  assert.strictEqual(quoteUnitValue("a\nb\rc"), '"abc"', "quoteUnitValue must strip CR/LF before quoting.");
  assert.strictEqual(quoteUnitValue('x"y\\z'), '"x\\"y\\\\z"', "quoteUnitValue must still escape quotes and backslashes.");
  const hostileShape = validateHostShape("bad host\nRestart=always");
  assert.strictEqual(hostileShape.ok, false, "the shared host shape check must reject whitespace/newlines.");
  assert.strictEqual(hostileShape.reason, "malformed", "the shape rejection reason must be malformed.");

  // --- install writes 0600 and drives the user systemctl commands ---------
  fs.rmSync(userUnitPath, { force: true });
  const installLeg = makeManager();
  const installResult = await installLeg.manager.install();
  assert.strictEqual(installResult.action, "install", "install must report its action.");
  assert.strictEqual(installResult.changed, true, "install must report a change.");
  assert(fs.existsSync(userUnitPath), "install must write the user unit.");
  assert.strictEqual(fs.readFileSync(userUnitPath, "utf8"), unitText, "the installed unit must match the generated content.");
  if (process.platform === "win32") {
    console.log("SKIP: POSIX mode 0600 assertion is not enforceable on win32 (install still writes with mode 0600 requested).");
  } else {
    assert.strictEqual(fs.statSync(userUnitPath).mode & 0o777, 0o600, "the installed unit file must be mode 0600.");
  }
  assert(hasCommand(installLeg.calls, ["--version"]), "install must probe systemctl availability first.");
  assert(hasCommand(installLeg.calls, ["--user", "daemon-reload"]), "a user install must daemon-reload the user manager.");
  assert(hasCommand(installLeg.calls, ["--user", "enable", "--now", "anxos-agent.service"]), "a user install must enable --now the user unit.");

  // --- lifecycle command shapes: --user vs system -------------------------
  const userLifecycle = makeManager();
  await userLifecycle.manager.start();
  await userLifecycle.manager.stop();
  await userLifecycle.manager.restart();
  assert(hasCommand(userLifecycle.calls, ["--user", "start", "anxos-agent.service"]), "user start must use --user.");
  assert(hasCommand(userLifecycle.calls, ["--user", "stop", "anxos-agent.service"]), "user stop must use --user.");
  assert(hasCommand(userLifecycle.calls, ["--user", "restart", "anxos-agent.service"]), "user restart must use --user.");

  const systemLifecycle = makeManager({ systemUnitPaths: [packageUnitPath], isRoot: () => true });
  await systemLifecycle.manager.start();
  assert(hasCommand(systemLifecycle.calls, ["start", "anxos-agent.service"]), "root system start must not use --user.");
  assert(!systemLifecycle.calls.some((call) => call.args.includes("--user")), "root system lifecycle must never pass --user.");

  // --- refusals: package-managed and non-root system operations -----------
  const refusalLeg = makeManager({ systemUnitPaths: [packageUnitPath] });
  await assert.rejects(
    async () => refusalLeg.manager.install(),
    (error) => error.code === "SERVICE_MANAGED_BY_PACKAGE",
    "install must refuse a package-managed system unit.",
  );
  await assert.rejects(
    async () => refusalLeg.manager.uninstall(),
    (error) => error.code === "SERVICE_MANAGED_BY_PACKAGE",
    "uninstall must refuse a package-managed system unit.",
  );
  await assert.rejects(
    async () => refusalLeg.manager.stop(),
    (error) => error.code === "SERVICE_PRIVILEGE_REQUIRED",
    "a non-root system lifecycle must refuse.",
  );
  await assert.rejects(
    async () => refusalLeg.manager.setBindingOverride("10.0.0.5"),
    (error) => error.code === "SERVICE_PRIVILEGE_REQUIRED",
    "a non-root bind override on a system unit must refuse.",
  );
  assertNoDataPathTouched(refusalLeg.calls, "refusal leg");

  // --- binding override preserves unrelated keys and clears cleanly -------
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  fs.writeFileSync(overridePath, "# operator note\nAGENT_HOST=10.0.0.9\nFOO=bar\n\nBAZ=qux\n", { mode: 0o600 });
  const overrideLeg = makeManager();
  const firstSet = overrideLeg.manager.setBindingOverride("10.0.0.5");
  assert.strictEqual(firstSet.host, "10.0.0.5", "the override must report the applied host.");
  let overrideText = fs.readFileSync(overridePath, "utf8");
  assert(overrideText.includes("# operator note"), "the override rewrite must preserve comments.");
  assert(overrideText.includes("FOO=bar") && overrideText.includes("BAZ=qux"), "the override rewrite must preserve unrelated keys.");
  assert(overrideText.includes("AGENT_HOST=10.0.0.5"), "the override must write the requested bind host.");
  assert.strictEqual(overrideText.match(/AGENT_HOST=/g).length, 1, "the override must not duplicate AGENT_HOST.");
  assert(!/\n[ \t]*\n/.test(overrideText), "the override rewrite must not leave blank lines between entries.");
  assert(
    overrideText.indexOf("# operator note") < overrideText.indexOf("AGENT_HOST=10.0.0.5")
      && overrideText.indexOf("AGENT_HOST=10.0.0.5") < overrideText.indexOf("FOO=bar")
      && overrideText.indexOf("FOO=bar") < overrideText.indexOf("BAZ=qux"),
    "the override rewrite must preserve entry ordering.",
  );

  const { serializeEnvEntries } = require("../agent/src/services/agentServiceManager")._test;
  assert.strictEqual(
    serializeEnvEntries([
      { type: "raw", text: "# note" },
      { type: "raw", text: "" },
      { type: "entry", key: "A", value: "1" },
      { type: "raw", text: "   " },
      { type: "entry", key: "B", value: "2" },
      { type: "raw", text: "" },
    ]),
    "# note\nA=1\nB=2\n",
    "serialization must drop blank lines while preserving comments and ordering.",
  );

  overrideLeg.manager.setBindingOverride("10.0.0.6");
  overrideText = fs.readFileSync(overridePath, "utf8");
  assert(overrideText.includes("AGENT_HOST=10.0.0.6") && !overrideText.includes("10.0.0.5"), "a second override must replace the previous host.");
  assert.strictEqual(overrideLeg.manager.readBindingOverride().agentHost, "10.0.0.6", "readBindingOverride must report the effective host.");

  for (const invalid of ["127.0.0.1", "0.0.0.0", "", "bad host", "10.0.0.5/24"]) {
    assert.throws(
      () => overrideLeg.manager.setBindingOverride(invalid),
      (error) => error.code === "AGENT_BIND_HOST_INVALID",
      `the bind override must refuse ${JSON.stringify(invalid)}.`,
    );
  }

  const cleared = overrideLeg.manager.clearBindingOverride();
  assert.strictEqual(cleared.cleared, true, "clearBindingOverride must report the clear.");
  overrideText = fs.readFileSync(overridePath, "utf8");
  assert(!overrideText.includes("AGENT_HOST="), "clearBindingOverride must remove AGENT_HOST.");
  assert(overrideText.includes("FOO=bar") && overrideText.includes("# operator note"), "clearBindingOverride must preserve unrelated content.");

  fs.writeFileSync(overridePath, "AGENT_HOST=10.0.0.7\n", { mode: 0o600 });
  const removed = overrideLeg.manager.clearBindingOverride();
  assert.strictEqual(removed.removedFile, true, "clearing the last key must remove the override file.");
  assert(!fs.existsSync(overridePath), "the empty override file must be removed.");

  // --- uninstall removes only the unit file -------------------------------
  const sentinels = [
    path.join(configDir, "sentinel-config.txt"),
    path.join(instanceRoot, "sentinel-instance.txt"),
    path.join(backupRoot, "sentinel-backup.txt"),
    path.join(logDir, "sentinel-log.txt"),
  ];
  sentinels.forEach((sentinel) => fs.writeFileSync(sentinel, "preserve-me", "utf8"));
  const removals = [];
  const { runner: uninstallRunner, calls: uninstallCalls } = makeRunner();
  const uninstallManager = createServiceManager({
    platform: "linux",
    env: { ...baseEnv },
    runner: uninstallRunner,
    fileSystem: {
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      chmodSync: fs.chmodSync,
      rmSync: (target, options) => { removals.push(target); return fs.rmSync(target, options); },
    },
    homeDir: path.join(smokeRoot, "home"),
    xdgConfigHome: xdgRoot,
    systemUnitPaths: [missingSystemUnitPath],
    isRoot: () => false,
    nodeExecutable: fixtureNode,
    serverScript: fixtureServer,
    runtimeConfig: {},
  });
  const uninstallResult = await uninstallManager.uninstall();
  assert.strictEqual(uninstallResult.removed, true, "uninstall must remove the user unit.");
  assert.strictEqual(uninstallResult.dataPreserved, true, "uninstall must declare data preserved.");
  assert.deepStrictEqual(removals, [userUnitPath], "uninstall must remove exactly the unit file.");
  assert(hasCommand(uninstallCalls, ["--user", "disable", "--now", "anxos-agent.service"]), "uninstall must disable --now the unit.");
  assertNoDataPathTouched(uninstallCalls, "uninstall leg");
  sentinels.forEach((sentinel) => assert.strictEqual(fs.readFileSync(sentinel, "utf8"), "preserve-me", `uninstall must leave ${path.basename(sentinel)} untouched.`));
  assert(!fs.existsSync(userUnitPath), "the user unit must be gone after uninstall.");

  // --- unsupported platform and missing systemctl are explicit ------------
  const windowsManager = createServiceManager({ platform: "win32", env: { ...baseEnv }, runner: async () => ({ ok: true }), homeDir: path.join(smokeRoot, "home"), xdgConfigHome: xdgRoot });
  const windowsStatus = await windowsManager.status();
  assert.strictEqual(windowsStatus.supported, false, "a non-linux platform must report unsupported status.");
  assert.strictEqual(windowsStatus.mode, "unsupported", "a non-linux platform must report mode=unsupported.");
  await assert.rejects(
    async () => windowsManager.install(),
    (error) => error.code === "PLATFORM_UNSUPPORTED",
    "install must refuse on a non-linux platform.",
  );

  fs.writeFileSync(userUnitPath, "[Unit]\nDescription=AnxOS Agent\n", "utf8");
  const missingSystemctl = makeManager({ responses: { "is-enabled anxos-agent.service": { ok: false, code: null, errorCode: "ENOENT", stdout: "", stderr: "" }, "--user is-enabled anxos-agent.service": { ok: false, code: null, errorCode: "ENOENT", stdout: "", stderr: "" } } });
  const missingStatus = await missingSystemctl.manager.status();
  assert.strictEqual(missingStatus.supported, false, "a missing systemctl must be reported as unsupported, not as not-enabled.");
  assert.strictEqual(missingStatus.state, "unsupported", "a missing systemctl must produce the unsupported state.");

  console.log("agent:service:smoke passed — detection, unit content, newline-injection refusal, command shapes, refusals, override preservation, data-safe uninstall");
}

main().catch((error) => {
  console.error("agent:service:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});
