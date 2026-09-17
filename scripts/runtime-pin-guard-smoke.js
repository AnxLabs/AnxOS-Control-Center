// V2-D runtime pin guard smoke (docs/MASTER_ROADMAP.md V2-D acceptance gate:
// "Updating one runtime does not break a pinned reference workload").
//
// Hermetic: every runtime root is pinned into one per-run temp tree via
// test-helpers/pin-agent-roots.js BEFORE any service module loads, and the
// dependency service runs entirely on injected command/access seams (same
// pattern as dependency-smoke.js) so no real runtime, installer, or machine
// state is touched.
//
// Covers:
//   1. pin creation when a check resolves a runtime for a workload
//   2. store persistence round-trip (disk content + re-read)
//   3. a workload updating its OWN pinned runtime stays allowed + pin refresh
//   4. cross-workload install/update refused (RUNTIME_PINNED_BY_OTHER_WORKLOAD
//      naming the pinned workload) before any install command runs
//   5. no-op resolution creates the requester's own pin without refusing
//   6. explicit unpin through the runtime-pins API, then install allowed
//   7. corrupt store quarantined exactly once (COPYFILE_EXCL) and installs
//      fail closed while the store is unreadable
//   8. newer store schema refused

const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Pin every leak-prone root first (eb13b83 lesson): this must run before the
// agent service modules are required.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const smokeRoot = pinAgentRoots("anx-runtime-pin-guard-smoke-");

const runtimePinService = require("../agent/src/services/runtimePinService");
const dependencyService = require("../agent/src/services/dependencyService");
const { handleDependencies } = require("../agent/src/routes/dependencies");

const isWindows = process.platform === "win32";
const PIN_ROOT = path.join(smokeRoot, "runtime-pins");
const STORE_PATH = path.join(PIN_ROOT, "runtime-pins.json");
const QUARANTINE_PATH = `${STORE_PATH}.corrupt`;
const FIXED_NOW_MS = 1735689600000;
const FIXED_NOW_ISO = new Date(FIXED_NOW_MS).toISOString();
const PINS_URL = "http://agent.local/api/v1/dependencies/runtime-pins";

// Fake runtime state shared by the command seams. `java -version` reports
// state.javaVersion; a fake winget/apt install flips java onto PATH at
// updatedJavaVersion so post-install verification sees the new version.
function createRuntimeHooks(initial = {}) {
  const state = {
    javaOnPath: initial.javaOnPath ?? false,
    javaVersion: initial.javaVersion ?? "21.0.5",
    updatedJavaVersion: initial.updatedJavaVersion ?? "21.0.6",
    installCommandCount: 0,
  };
  const normalize = (value) => path.basename(String(value)).replace(/\.(?:exe|cmd|bat|com)$/i, "");
  const hooks = {
    accessExecutable(filePath) {
      const normalized = normalize(filePath);
      if (normalized === "java" && state.javaOnPath) return;
      if (!isWindows && (normalized === "sudo" || normalized === "apt-get")) return;
      throw new Error(`not executable: ${normalized}`);
    },
    async commandRunner(command, args = []) {
      const normalized = normalize(command);
      if (normalized === "java") {
        if (!state.javaOnPath) {
          return { ok: false, exitCode: 1, stdout: "", stderr: "", errorMessage: "java is not on PATH" };
        }
        return { ok: true, exitCode: 0, stdout: "", stderr: `openjdk version "${state.javaVersion}"` };
      }
      const installTriggered = (isWindows && normalized === "winget" && args.includes("install"))
        || (!isWindows && normalized === "sudo" && args.some((arg) => normalize(arg) === "apt-get"));
      if (installTriggered) {
        state.installCommandCount += 1;
        state.javaOnPath = true;
        state.javaVersion = state.updatedJavaVersion;
      }
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
    readFileText(filePath) {
      if (filePath === "/etc/os-release") {
        return "ID=debian\nID_LIKE=debian\nPRETTY_NAME=\"Debian GNU/Linux 13\"\nVERSION_ID=\"13\"\n";
      }
      throw new Error(`Unexpected read: ${filePath}`);
    },
    windowsInstaller: () => ({ method: "winget", packageId: "EclipseAdoptium.Temurin.21.JRE" }),
    windowsInstallerCommand: () => "C:\\anx-fake\\winget.exe",
  };
  return { state, hooks };
}

async function pinsFor(filter = {}) {
  return runtimePinService.listRuntimePins(filter);
}

function findPin(pins, instanceId) {
  return pins.find((pin) => pin.instanceId === instanceId) || null;
}

async function unpinViaRoute(payload) {
  return handleDependencies(
    { method: "DELETE", body: JSON.stringify(payload) },
    new URL(PINS_URL),
  );
}

async function run() {
  runtimePinService.configureRuntimePinService({ root: PIN_ROOT, now: () => FIXED_NOW_MS });

  // --- 1. Pin creation on resolve -----------------------------------------
  const { state, hooks } = createRuntimeHooks({ javaOnPath: true, javaVersion: "21.0.5" });
  dependencyService.__setTestHooks(hooks);
  const check = await dependencyService.checkDependencies({ dependencyIds: ["java"], instanceId: "mc-ref-a", nodeId: "node-1" });
  assert.strictEqual(check.ok, true, "Fake Java 21 must resolve as installed.");

  let pins = await pinsFor();
  assert.strictEqual(pins.length, 1, "A workload-specific check must create exactly one runtime pin.");
  assert.deepStrictEqual(pins[0], {
    dependencyId: "java",
    instanceId: "mc-ref-a",
    resolvedVersion: "21.0.5",
    nodeId: "node-1",
    pinnedAt: FIXED_NOW_ISO,
    updatedAt: FIXED_NOW_ISO,
    source: "dependency-resolution",
  }, "The pin must record dependency, resolved version, workload, node, and time.");

  // --- 2. Persistence round-trip ------------------------------------------
  const onDisk = JSON.parse(await fsp.readFile(STORE_PATH, "utf8"));
  assert.strictEqual(onDisk.schemaVersion, 1, "The store must carry a schema version.");
  assert.strictEqual(onDisk.pins[0].instanceId, "mc-ref-a", "The pin must survive a disk round-trip.");
  assert.strictEqual((await pinsFor({ dependencyId: "java", instanceId: "mc-ref-a" })).length, 1, "Filtered re-read must see the persisted pin.");

  // --- 3. Own-workload update stays allowed and refreshes the pin ---------
  state.javaVersion = "16.0.2"; // below the registry minVersion (17) -> update-required
  const ownInstall = await dependencyService.installDependencies({ dependencyIds: ["java"], instanceId: "mc-ref-a", nodeId: "node-1" });
  assert.strictEqual(ownInstall.ok, true, "A workload updating its own pinned runtime must be allowed.");
  assert.strictEqual(ownInstall.results[0].after.version, "21.0.6", "The fake installer must resolve the updated version.");
  pins = await pinsFor({ dependencyId: "java", instanceId: "mc-ref-a" });
  assert.strictEqual(pins[0].resolvedVersion, "21.0.6", "The pin must be refreshed to the resolved update version.");
  assert.strictEqual(pins[0].pinnedAt, FIXED_NOW_ISO, "Pinned-at must keep the original creation time.");
  assert.strictEqual(pins[0].source, "dependency-install", "A verified install must mark the pin source.");

  // --- 4. Cross-workload install/update refused ---------------------------
  state.javaVersion = "16.0.2"; // change pending again
  const commandsBeforeRefusal = state.installCommandCount;
  await assert.rejects(
    () => dependencyService.installDependencies({ dependencyIds: ["java"], instanceId: "mc-ref-b", nodeId: "node-1" }),
    (error) => error.code === "RUNTIME_PINNED_BY_OTHER_WORKLOAD"
      && error.statusCode === 409
      && error.details.pinnedWorkload.instanceId === "mc-ref-a"
      && error.message.includes("mc-ref-a")
      && /unpin/i.test(error.message),
    "A cross-workload install must be refused, naming the pinned workload and the unpin action.",
  );
  await assert.rejects(
    () => dependencyService.installDependencies({ dependencyIds: ["java"], nodeId: "node-1" }),
    (error) => error.code === "RUNTIME_PINNED_BY_OTHER_WORKLOAD",
    "An unattributed install must fail closed while any pin exists.",
  );
  assert.strictEqual(state.installCommandCount, commandsBeforeRefusal, "The refusal must happen before any install command runs.");
  pins = await pinsFor({ dependencyId: "java" });
  assert(findPin(pins, "mc-ref-a")?.resolvedVersion === "21.0.6", "The pinned workload's pin must be untouched by the refusal.");
  assert.strictEqual(findPin(pins, "mc-ref-b"), null, "A refused requester must not gain a pin.");

  // --- 5. No-op resolution creates the requester's own pin ----------------
  state.javaVersion = "21.0.6"; // already satisfied: nothing changes on the node
  const noopInstall = await dependencyService.installDependencies({ dependencyIds: ["java"], instanceId: "mc-ref-b", nodeId: "node-1" });
  assert.strictEqual(noopInstall.results[0].changed, false, "An already-satisfied dependency must resolve as a no-op.");
  assert.strictEqual(findPin(await pinsFor({ dependencyId: "java" }), "mc-ref-b")?.resolvedVersion, "21.0.6", "The no-op resolution must pin the requester.");

  // --- 6. Explicit unpin through the API, then install allowed ------------
  const unpinResponse = await unpinViaRoute({ dependencyId: "java", instanceId: "mc-ref-a" });
  assert.strictEqual(unpinResponse.statusCode, 200, "The unpin route must accept the request.");
  assert.strictEqual(unpinResponse.body.removed, true, "Unpinning an existing pin must report removal.");
  const listResponse = await handleDependencies({ method: "GET", body: "" }, new URL(`${PINS_URL}?dependencyId=java`));
  assert.strictEqual(listResponse.statusCode, 200);
  assert.deepStrictEqual(listResponse.body.pins.map((pin) => pin.instanceId), ["mc-ref-b"], "The pin list must reflect the unpin.");
  const missingTarget = await unpinViaRoute({ dependencyId: "java" });
  assert.strictEqual(missingTarget.statusCode, 400, "A dependency-wide unpin requires the explicit all flag.");
  state.javaVersion = "16.0.2"; // change pending: the guard must consult the remaining pin
  await assert.rejects(
    () => dependencyService.installDependencies({ dependencyIds: ["java"], instanceId: "mc-ref-c", nodeId: "node-1" }),
    (error) => error.code === "RUNTIME_PINNED_BY_OTHER_WORKLOAD" && error.details.pinnedWorkload.instanceId === "mc-ref-b",
    "Remaining other-workload pins must still be honoured.",
  );
  const unpinRest = await unpinViaRoute({ dependencyId: "java", instanceId: "mc-ref-b" });
  assert.strictEqual(unpinRest.body.removed, true);
  assert.strictEqual((await unpinViaRoute({ dependencyId: "java", instanceId: "mc-ref-b" })).body.removed, false, "Unpinning twice must stay idempotent.");
  state.javaVersion = "16.0.2";
  const freedInstall = await dependencyService.installDependencies({ dependencyIds: ["java"], instanceId: "mc-ref-c", nodeId: "node-1" });
  assert.strictEqual(freedInstall.ok, true, "After explicit unpinning the install must proceed.");
  assert.strictEqual(findPin(await pinsFor({ dependencyId: "java" }), "mc-ref-c")?.resolvedVersion, "21.0.6", "The freed install must pin the new resolution.");

  // --- 7. Corrupt store: quarantine once, installs fail closed ------------
  await fsp.writeFile(STORE_PATH, "{not-json-first", "utf8");
  await assert.rejects(() => pinsFor(), (error) => error.code === "RUNTIME_PIN_STORE_CORRUPT", "A corrupt store must surface a structured error.");
  assert.strictEqual(await fsp.readFile(QUARANTINE_PATH, "utf8"), "{not-json-first", "The first corruption must be quarantined verbatim.");
  state.javaVersion = "16.0.2";
  await assert.rejects(
    () => dependencyService.installDependencies({ dependencyIds: ["java"], instanceId: "mc-ref-c", nodeId: "node-1" }),
    (error) => error.code === "RUNTIME_PIN_STORE_CORRUPT",
    "Installs must fail closed while the pin store is unreadable.",
  );
  await fsp.writeFile(STORE_PATH, "{not-json-second", "utf8");
  await assert.rejects(() => pinsFor(), (error) => error.code === "RUNTIME_PIN_STORE_CORRUPT");
  assert.strictEqual(await fsp.readFile(QUARANTINE_PATH, "utf8"), "{not-json-first", "COPYFILE_EXCL must preserve the first quarantine instead of overwriting it.");

  // --- 8. Newer store schema refused --------------------------------------
  await fsp.writeFile(STORE_PATH, `${JSON.stringify({ schemaVersion: 99, pins: [] })}\n`, "utf8");
  await assert.rejects(() => pinsFor(), (error) => error.code === "RUNTIME_PIN_SCHEMA_UNSUPPORTED", "A newer schema must be refused, not silently trusted.");

  // Restore production seams so this process cannot leak configuration into
  // any later module use.
  runtimePinService.configureRuntimePinService({ root: null, now: null });
  dependencyService.__setTestHooks({});

  console.log("runtime-pin-guard-smoke passed");
}

run().catch((error) => {
  console.error("runtime-pin-guard-smoke failed:", error);
  process.exitCode = 1;
});
