#!/usr/bin/env node
// Package-managed Agent update (packageAgentUpdateService via
// remoteAgentUpdateService.updateRemoteAgent), against a simulated node:
//   P1  update succeeds: verify both packages, back up, install, verify build
//   P2  servers run under the Agent: refused before anything is downloaded
//   P3  downloaded package digest differs from SHA256SUMS: nothing installed
//   P4  package names the wrong version: nothing installed
//   P5  sudo needs a password: stops after verification with the exact command
//   P6  new Agent never reports the build: previous package reinstalled, healthy
//   P7  no verified rollback package for the installed build: refused up front
//   P8  already on the target build: no download, no install
//   P9  cannot tell whether servers run: refused
//   P10 generated shell commands parse in bash (bash -n)
//   P11 apt would change other packages: refused before install
//   P12 needrestart is suspended and list-only; deferred restarts reported
//   P13 apt busy and nothing changed: reported, no rollback attempted
//   P14 update helper: no user-folder download, helper installs, digest checked
//   P15 helper reports a digest that differs from SHA256SUMS: rolled back
//   P16 helper refuses (servers running): mapped code, nothing to roll back
//   P17 helper install verifies badly: helper rollback to the replaced build
//   P18 password sudo with the helper not permitted: anxos-update hint
//   P19 helper command refuses anything but a build string
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-package-agent-update-"));
const remoteServicePath = path.join(__dirname, "..", "src", "services", "remoteAgentUpdateService.js");
const originalModuleLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => smokeRoot, isPackaged: false } };
  if (parent?.filename === remoteServicePath) {
    if (request === "./diagnosticsService") return { log: () => {}, logError: () => {} };
    if (request === "./nodeService") return { getNode: () => null };
    if (request === "./applicationHostService") return { APPLICATION_HOST_NODE_ID: "application-host" };
    if (request === "./sshService") return { SshService: class StubSshService {} };
    if (request === "./localAgentRuntimeService") return { getBundledLocalAgentRuntime: () => ({ exists: false }), getBundledLocalAgentVersion: () => null };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
let updateRemoteAgent;
try {
  ({ updateRemoteAgent } = require(remoteServicePath));
} finally {
  Module._load = originalModuleLoad;
}
const { _test: pkg } = require("../src/services/packageAgentUpdateService");

const TARGET = "2.0-build213";
const INSTALLED = "2.0-build212";
const DIGEST = { [TARGET]: "a".repeat(64), [INSTALLED]: "b".repeat(64) };
const keyProfile = { id: "key-profile", displayName: "VPS key", username: "debian", nodeId: "node-key", authType: "privateKey" };
const systemDiscovery = "--- exec ---\n\n--- system-exec ---\n{ path=/usr/lib/anxos-agent/node/bin/node ; argv[]=/usr/lib/anxos-agent/node/bin/node /usr/lib/anxos-agent/agent/src/server.js ; ignore_errors=no }\n--- system-active ---\nactive\n--- system-enabled ---\nenabled\n--- ps ---\n/usr/lib/anxos-agent/node/bin/node /usr/lib/anxos-agent/agent/src/server.js\n--- node ---\n/usr/bin/node\n";

// A simulated node: answers each command the service sends by its markers.
function simulatedNode(overrides = {}) {
  const node = {
    installed: INSTALLED,
    sudo: "ok",
    children: "0",
    arch: "amd64",
    digest: { ...DIGEST },
    versions: { [TARGET]: TARGET, [INSTALLED]: INSTALLED },
    installSucceeds: true,
    reportsTargetAfterInstall: true,
    helper: "missing",
    simulateChanges: "anxos-agent",
    aptBusy: false,
    deferred: "",
    helperDigest: null,
    helperRefusal: null,
    calls: [],
    ...overrides,
  };
  node.runner = async (profileId, command) => {
    node.calls.push(command);
    if (command.includes("--- hostname ---")) {
      return { code: 0, stdout: "--- user ---\nnot-found\n--- system ---\nloaded\n--- hostname ---\nvps\n--- agents ---\n\"deviceId\":\"device-key\"\n", stderr: "" };
    }
    if (command.includes("ExecStart")) return { code: 0, stdout: systemDiscovery, stderr: "" };
    if (command.includes("ARCH=$(dpkg --print-architecture")) {
      return { code: 0, stdout: `ARCH=${node.arch}\nINSTALLED=${node.installed}\nSUDO=${node.sudo}\nHELPER=${node.helper}\nNEEDRESTART=yes\nCURL=yes\nCHILDREN=${node.children}\nENV=ANXHUB_CONFIG_DIR=/var/lib/anxos-agent/config AGENT_HOST=127.0.0.1\nHOME=/home/debian\nHOMEFREE_KB=900000\n`, stderr: "" };
    }
    for (const prefix of ["NEW", "OLD"]) {
      if (command.includes(`${prefix}_SHA256=`)) {
        const build = prefix === "NEW" ? TARGET : INSTALLED;
        const version = node.versions[build];
        return { code: 0, stdout: `${prefix}_SHA256=${node.digest[build]}\n${prefix}_PACKAGE=anxos-agent\n${prefix}_VERSION=${version}\n${prefix}_ARCH=amd64\n${prefix}_RELEASE=${version}\n${prefix}_PATH=/home/debian/.anxos-agent-package-update/x/AnxOS-Agent-${build}.deb\n`, stderr: "" };
      }
    }
    if (command.includes("apt-get -s ")) {
      return { code: 0, stdout: `SIMULATE_EXIT=0\nCHANGES=${node.simulateChanges} \n`, stderr: "" };
    }
    if (command.includes("update-helper install ")) {
      if (node.helperRefusal) return { code: 0, stdout: `ERROR=${node.helperRefusal}\nMESSAGE=refused for the test\nHELPER_EXIT=2\n`, stderr: "" };
      node.installed = TARGET;
      return { code: 0, stdout: `SHA256=${node.helperDigest || DIGEST[TARGET]}\nBACKUP_PATH=/var/lib/anxos-agent-update/backups/x.tgz\nINSTALL_EXIT=0\nINSTALLED=${TARGET}\nPREVIOUS=${INSTALLED}\nDEFERRED_RESTARTS=${node.deferred}\nACTIVE=active\nRESULT=installed\nHELPER_EXIT=0\n`, stderr: "" };
    }
    if (command.includes("update-helper rollback ")) {
      node.installed = INSTALLED;
      return { code: 0, stdout: `SHA256=${DIGEST[INSTALLED]}\nINSTALL_EXIT=0\nINSTALLED=${INSTALLED}\nACTIVE=active\nRESULT=rolled-back\nHELPER_EXIT=0\n`, stderr: "" };
    }
    if (command.includes("agent-state-backup.tgz")) return { code: 0, stdout: "BACKUP_PATH=/home/debian/.anxos-agent-package-update/x/agent-state-backup.tgz\n", stderr: "" };
    if (command.includes("apt-get install")) {
      const rollingBack = command.includes("--allow-downgrades");
      if (node.aptBusy && !rollingBack) {
        return { code: 0, stdout: `INSTALL_EXIT=100\nINSTALLED=${node.installed}\nACTIVE=active\nAPT_BUSY=yes\nLOG: E: Could not get lock /var/lib/dpkg/lock-frontend\n`, stderr: "" };
      }
      if (rollingBack) node.installed = INSTALLED;
      else if (node.installSucceeds) node.installed = TARGET;
      return { code: 0, stdout: `INSTALL_EXIT=${rollingBack || node.installSucceeds ? 0 : 100}\nINSTALLED=${node.installed}\nACTIVE=active\nDEFERRED_RESTARTS=${node.deferred}\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${command.slice(0, 80)}`);
  };
  node.healthProbe = async () => {
    const reported = node.installed === TARGET && !node.reportsTargetAfterInstall ? INSTALLED : node.installed;
    return { connected: true, networkInventoryOk: true, agentVersion: "0.1.0", agentArtifactVersion: reported };
  };
  return node;
}

const fetched = [];
const fetchText = async (url) => {
  fetched.push(url);
  const tag = url.match(/download\/(v[^/]+)\/SHA256SUMS$/)?.[1];
  const build = tag?.slice(1);
  if (!DIGEST[build]) throw Object.assign(new Error("HTTP 404"), { status: 404 });
  return `${DIGEST[build]}  AnxOS-Agent-${build}.deb\n${"c".repeat(64)}  AnxOS-Control-Center-Setup-${build}.exe\n`;
};

function options(node, extra = {}) {
  return {
    resolveNode: async () => ({ id: "node-key", displayName: "VPS", platform: "linux", hostname: "vps", agentIdentity: { deviceId: "device-key" } }),
    sshService: { getProfileForNode: () => keyProfile },
    runner: node.runner,
    healthProbe: node.healthProbe,
    bundledBuild: TARGET,
    bundledVersion: "0.1.0",
    updateDir: path.join(smokeRoot, "agent-updates"),
    sleep: async () => {},
    verifyAttempts: 2,
    verifyDelayMs: 0,
    fetchText,
    ...extra,
  };
}

async function expectFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the update to fail");
}

const pushCommands = (calls) => calls.filter((command) => /tar -xzf -|SWAP_OK|systemctl --user stop/.test(command));
const installs = (calls) => calls.filter((command) => command.includes("apt-get install"));
const helperCalls = (calls, action) => calls.filter((command) => command.includes(`update-helper ${action} `));

(async () => {
  // P1
  {
    const node = simulatedNode();
    const result = await updateRemoteAgent("node-key", options(node));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.updated, true);
    assert.strictEqual(result.method, "package");
    assert.strictEqual(node.installed, TARGET);
    const order = node.calls.map((command) => (command.includes("NEW_SHA256") ? "new" : command.includes("OLD_SHA256") ? "old" : command.includes("--print-architecture") ? "preflight" : command.includes("agent-state-backup") ? "backup" : command.includes("apt-get install") ? "install" : null)).filter(Boolean);
    assert.deepStrictEqual(order, ["preflight", "new", "old", "backup", "install"], "verify both packages, back up, then install");
    assert.deepStrictEqual(pushCommands(node.calls), [], "no runtime push into a package install");
    assert(fetched.some((url) => url.endsWith(`/v${TARGET}/SHA256SUMS`)) && fetched.some((url) => url.endsWith(`/v${INSTALLED}/SHA256SUMS`)), "digests come from the Desktop's own read of both releases");
    const stepStates = Object.fromEntries(result.steps.map((step) => [step.id, step.state]));
    assert.strictEqual(stepStates.workloads, "complete");
    assert.strictEqual(stepStates.verify, "complete");
    const record = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));
    assert.strictEqual(record.status, "updated");
    assert.strictEqual(record.targetBuild, TARGET);
    console.log("  ok P1 update succeeds");
  }

  // P2
  {
    const node = simulatedNode({ children: "2" });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_SERVERS_RUNNING");
    assert(/Docker containers/.test(error.message));
    assert(!node.calls.some((command) => command.includes("_SHA256=")), "nothing downloaded");
    assert.deepStrictEqual(installs(node.calls), []);
    console.log("  ok P2 running servers block the update");
  }

  // P3
  {
    const node = simulatedNode({ digest: { ...DIGEST, [TARGET]: "d".repeat(64) } });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "AGENT_PACKAGE_VERIFICATION_FAILED");
    assert(/SHA-256/.test(error.message));
    assert.deepStrictEqual(installs(node.calls), []);
    console.log("  ok P3 checksum mismatch refused");
  }

  // P4
  {
    const node = simulatedNode({ versions: { [TARGET]: "2.0-build199", [INSTALLED]: INSTALLED } });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "AGENT_PACKAGE_VERIFICATION_FAILED");
    assert(/version 2\.0-build199/.test(error.message));
    assert.deepStrictEqual(installs(node.calls), []);
    console.log("  ok P4 wrong package identity refused");
  }

  // P5
  {
    const node = simulatedNode({ sudo: "password" });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_SUDO_REQUIRED");
    assert.strictEqual(error.details.manualCommand, `sudo apt-get install /home/debian/.anxos-agent-package-update/x/AnxOS-Agent-${TARGET}.deb`);
    assert(error.message.includes(error.details.manualCommand));
    assert.deepStrictEqual(installs(node.calls), []);
    assert(!node.calls.some((command) => command.includes("sudo -n tar")), "no privileged backup without sudo");
    console.log("  ok P5 password sudo stops with the exact command");
  }

  // P6
  {
    const node = simulatedNode({ reportsTargetAfterInstall: false });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_VERIFY_FAILED");
    assert(/reinstalled 2\.0-build212 and it is healthy again/.test(error.message), error.message);
    assert.strictEqual(node.installed, INSTALLED);
    const rollbackInstall = installs(node.calls).find((command) => command.includes("--allow-downgrades"));
    assert(rollbackInstall && rollbackInstall.includes(`AnxOS-Agent-${INSTALLED}.deb`), "rollback reinstalls the verified previous package");
    const record = JSON.parse(fs.readFileSync(error.details.recordPath, "utf8"));
    assert.strictEqual(record.status, "rolled-back");
    console.log("  ok P6 failed verification rolls back");
  }

  // P7
  {
    const node = simulatedNode({ installed: "2.0-build210" });
    node.healthProbe = async () => ({ connected: true, networkInventoryOk: true, agentArtifactVersion: "2.0-build210" });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_ROLLBACK_UNAVAILABLE");
    assert.deepStrictEqual(installs(node.calls), []);
    assert(!node.calls.some((command) => command.includes("NEW_SHA256=")), "nothing downloaded");
    console.log("  ok P7 no rollback package refused up front");
  }

  // P8
  {
    const node = simulatedNode({ installed: TARGET });
    node.healthProbe = async () => ({ connected: true, networkInventoryOk: true, agentArtifactVersion: TARGET });
    const result = await updateRemoteAgent("node-key", options(node));
    assert.strictEqual(result.upToDate, true);
    assert.strictEqual(result.updated, false);
    assert(!node.calls.some((command) => command.includes("_SHA256=")));
    assert.deepStrictEqual(installs(node.calls), []);
    console.log("  ok P8 up-to-date node left alone");
  }

  // P9
  {
    const node = simulatedNode({ children: "unknown" });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_WORKLOADS_UNKNOWN");
    assert.deepStrictEqual(installs(node.calls), []);
    console.log("  ok P9 unknown workloads refused");
  }

  // P10
  {
    const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
    if (bash.status === 0) {
      const scripts = [
        pkg.buildPreflightCommand("anxos-agent"),
        pkg.buildDownloadCommand({ dir: "/home/u/.anxos-agent-package-update/s", url: "https://example.invalid/AnxOS-Agent-2.0-build213.deb", fileName: "AnxOS-Agent-2.0-build213.deb", prefix: "NEW" }),
        pkg.buildBackupCommand({ dir: "/home/u/.anxos-agent-package-update/s", env: { ANXHUB_CONFIG_DIR: "/srv/anxos/agent-config", AGENT_IDENTITY_PATH: "/srv/anxos/agent-device-identity.json" } }),
        pkg.buildInstallCommand("/home/u/x.deb", { allowDowngrade: true }),
        pkg.buildSimulateCommand("/home/u/x.deb"),
        pkg.buildHelperCommand("install", "2.0-build215"),
        pkg.buildHelperCommand("rollback", "2.0-build214"),
      ];
      for (const script of scripts) {
        const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
        assert.strictEqual(parsed.status, 0, `generated script does not parse: ${parsed.stderr}\n${script}`);
      }
      const markers = pkg.parseMarkers("ARCH=amd64\nnoise\nCHILDREN=0\n");
      assert.deepStrictEqual(markers, { ARCH: "amd64", CHILDREN: "0" });
      assert.strictEqual(pkg.parseSha256Sums(`${"e".repeat(64)}  AnxOS-Agent-2.0-build213.deb\n`).get("AnxOS-Agent-2.0-build213.deb"), "e".repeat(64));
      console.log("  ok P10 generated commands parse in bash");
    } else {
      console.log("  skip P10 (bash not available)");
    }
  }

  // P11
  {
    const node = simulatedNode({ simulateChanges: "anxos-agent libc6 openssl" });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "AGENT_PACKAGE_OTHER_CHANGES");
    assert(/libc6, openssl/.test(error.message), error.message);
    assert.deepStrictEqual(installs(node.calls), []);
    assert.strictEqual(node.installed, INSTALLED);
    console.log("  ok P11 other package changes refused before install");
  }

  // P12
  {
    const node = simulatedNode({ deferred: "docker.service,cron.service" });
    const result = await updateRemoteAgent("node-key", options(node));
    const install = installs(node.calls)[0];
    assert(/NEEDRESTART_SUSPEND=1/.test(install) && /NEEDRESTART_MODE=l/.test(install), "needrestart suspended and list-only");
    assert(/--no-install-recommends/.test(install), "no recommended packages pulled in");
    assert(/needrestart -b -r l/.test(install), "restarts are listed, never performed");
    assert.deepStrictEqual(result.deferredRestarts, ["docker.service", "cron.service"]);
    assert(/Not restarted .*docker\.service, cron\.service/.test(result.steps.find((step) => step.id === "swap").message));
    console.log("  ok P12 needrestart suspended; deferred restarts reported");
  }

  // P13
  {
    const node = simulatedNode({ aptBusy: true });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "AGENT_PACKAGE_APT_BUSY");
    assert(/still installed and running/.test(error.message));
    assert(!installs(node.calls).some((command) => command.includes("--allow-downgrades")), "no rollback when nothing changed");
    const record = JSON.parse(fs.readFileSync(error.details.recordPath, "utf8"));
    assert.strictEqual(record.status, "not-applied");
    console.log("  ok P13 apt busy reported without a rollback");
  }

  // P14
  {
    const node = simulatedNode({ helper: "ok", sudo: "password" });
    const result = await updateRemoteAgent("node-key", options(node));
    assert.strictEqual(result.updated, true);
    assert.strictEqual(result.privilege, "update-helper");
    assert.strictEqual(result.verifiedBuild, TARGET);
    assert.deepStrictEqual(installs(node.calls), [], "no apt-get through the SSH user's sudo");
    assert(!node.calls.some((command) => command.includes("_SHA256=")), "the helper downloads; nothing in the user's folder");
    assert.strictEqual(helperCalls(node.calls, "install").length, 1);
    assert(helperCalls(node.calls, "install")[0].includes(`sudo -n /usr/lib/anxos-agent/update-helper install '${TARGET}'`));
    console.log("  ok P14 update helper installs without a sudo password");
  }

  // P15
  {
    const node = simulatedNode({ helper: "ok", helperDigest: "f".repeat(64) });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_VERIFY_FAILED");
    assert(/did not match this Desktop's SHA256SUMS/.test(error.message), error.message);
    assert.strictEqual(helperCalls(node.calls, "rollback").length, 1);
    assert(helperCalls(node.calls, "rollback")[0].includes(`'${INSTALLED}'`));
    assert.strictEqual(node.installed, INSTALLED);
    console.log("  ok P15 helper digest mismatch rolled back");
  }

  // P16
  {
    const node = simulatedNode({ helper: "ok", helperRefusal: "SERVERS_RUNNING" });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_SERVERS_RUNNING");
    assert.strictEqual(helperCalls(node.calls, "rollback").length, 0, "nothing to roll back");
    console.log("  ok P16 helper refusal mapped, no rollback");
  }

  // P17
  {
    const node = simulatedNode({ helper: "ok", reportsTargetAfterInstall: false });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_VERIFY_FAILED");
    assert(/reinstalled 2\.0-build212 through the update helper and it is healthy again/.test(error.message), error.message);
    assert.strictEqual(helperCalls(node.calls, "rollback").length, 1);
    console.log("  ok P17 helper rollback after failed verification");
  }

  // P18
  {
    const node = simulatedNode({ sudo: "password", helper: "not-permitted" });
    const error = await expectFailure(updateRemoteAgent("node-key", options(node)));
    assert.strictEqual(error.code, "REMOTE_AGENT_UPDATE_SUDO_REQUIRED");
    assert(/usermod -aG anxos-update debian/.test(error.message), error.message);
    console.log("  ok P18 password sudo explains the update helper");
  }

  // P19
  {
    for (const bad of ["2.0-build215; rm -rf /", "../../etc/passwd", "2.0-build215 --allow-downgrades", "", "latest"]) {
      assert.throws(() => pkg.buildHelperCommand("install", bad), /invalid build/);
    }
    assert.throws(() => pkg.buildHelperCommand("purge", "2.0-build215"), /invalid build/);
    console.log("  ok P19 helper command takes a build string only");
  }

  fs.rmSync(smokeRoot, { recursive: true, force: true });
  console.log("Package Agent update smoke passed (19 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
