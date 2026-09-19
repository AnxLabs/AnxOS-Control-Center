// V2-G wave 5 agent self-update smoke: hermetic checks of the Linux agent
// self-update helper (pinned file system roots plus injected command
// executor / copy / rename seams — no real systemd, no real agent) and of the
// agent-side agentUpdate capability report.
//
// Windows flows are intentionally excluded from this smoke: the scheduled
// task swap, PowerShell inspection and elevation paths are not exercised
// here. Only the Windows mechanism STRING in the capability report is pinned,
// because the desktop's Windows update path has its own dedicated flows.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const selfUpdate = require("../src/shared/linuxAgentSelfUpdate");
const { _test: healthTest } = require("../agent/src/routes/health");

const NEW_VERSION = "2.0.0";
const OLD_VERSION = "1.0.0";
const OLD_MARKER = "// OLD RUNTIME";
const NEW_MARKER = "// NEW RUNTIME";

function writeAgentTree(root, version, marker) {
  fs.mkdirSync(path.join(root, "agent", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "agent", "package.json"), `${JSON.stringify({ name: "anxos-agent", version }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "agent", "src", "server.js"), `${marker}\n`);
}

function readServerMarker(root) {
  return fs.readFileSync(path.join(root, "agent", "src", "server.js"), "utf8").trim();
}

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listSiblings(runtimeRoot, prefix) {
  const parent = path.dirname(runtimeRoot);
  const base = path.basename(runtimeRoot);
  return fs.existsSync(parent)
    ? fs.readdirSync(parent).filter((name) => name.startsWith(`${base}${prefix}`))
    : [];
}

// Builds pinned roots and a fake command executor that stands in for systemd:
// the systemd-run call simulates the transient unit by running the module's
// canonical swap logic and writing the same result marker the generated sh
// script writes.
function makeHarness({ swapStatus = "complete", writeResult = true, scheduleFails = false, scheduleTimesOut = false, failPublish = false, copyFails = false } = {}) {
  const root = makeTempRoot("anxos-agent-self-update-");
  const runtimeRoot = path.join(root, "runtime", "live");
  const sourceRoot = path.join(root, "runtime", "source");
  const updateDir = path.join(root, "update");
  writeAgentTree(runtimeRoot, OLD_VERSION, OLD_MARKER);
  writeAgentTree(sourceRoot, NEW_VERSION, NEW_MARKER);
  const state = { root, runtimeRoot, sourceRoot, updateDir, commands: [], scheduled: null };

  state.runCommand = async (file, args, options = {}) => {
    state.commands.push({ file, args, timeoutMs: options.timeoutMs || null });
    if (file === "systemd-run") {
      if (scheduleFails) return { ok: false, code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" };
      if (scheduleTimesOut) return { ok: false, code: null, stdout: "", stderr: "", timedOut: true };
      const info = state.scheduled;
      assert(info, "The flow must publish the swap artifacts before scheduling the unit.");
      try {
        if (failPublish) {
          let renames = 0;
          selfUpdate.swapLinuxAgentRuntime({
            runtimeRoot,
            stagedRoot: info.stagedRoot,
            backupRoot: info.backupRoot,
            rename: (from, to) => {
              renames += 1;
              if (renames === 2) throw new Error("simulated publish failure");
              fs.renameSync(from, to);
            },
          });
        } else {
          selfUpdate.swapLinuxAgentRuntime({ runtimeRoot, stagedRoot: info.stagedRoot, backupRoot: info.backupRoot });
        }
        if (writeResult) fs.writeFileSync(info.resultPath, `${swapStatus}\n`);
      } catch {
        if (writeResult) fs.writeFileSync(info.resultPath, `${selfUpdate.SWAP_STATUS.FAILED_ROLLED_BACK}\n`);
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    if (file === "systemctl") {
      assert(args.includes("is-active"), `Unexpected systemctl subcommand: ${args.join(" ")}`);
      return { ok: true, code: 0, stdout: "active", stderr: "" };
    }
    throw new Error(`Unexpected command in harness: ${file}`);
  };

  state.run = () => selfUpdate.runLinuxAgentSelfUpdate({
    runtimeRoot,
    sourceRoot,
    sourceVersion: NEW_VERSION,
    installedVersion: OLD_VERSION,
    updateDir,
    unitName: selfUpdate.LINUX_AGENT_UNIT_NAME,
    reason: "agent-self-update-smoke",
    swapTimeoutMs: 12345,
    restartPollDelayMs: 0,
    runCommand: state.runCommand,
    copyTree: copyFails
      ? () => {
        throw new Error("simulated staging failure");
      }
      : undefined,
    onScheduled: (info) => {
      state.scheduled = info;
    },
  });
  return state;
}

function cleanupRoots(states) {
  states.forEach((state) => fs.rmSync(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

async function expectError(code, run) {
  try {
    await run();
  } catch (error) {
    assert.strictEqual(error.code, code, `Expected ${code}, got ${error.code || error.message}.`);
    return error;
  }
  throw new Error(`Expected error ${code} but the call succeeded.`);
}

function assertRecord(state, status) {
  const record = JSON.parse(fs.readFileSync(path.join(state.updateDir, "last-linux-update.json"), "utf8"));
  assert.strictEqual(record.status, status, `The update record must record ${status}.`);
  assert.strictEqual(record.mechanism, "linux-systemd");
  assert.strictEqual(record.fromVersion, OLD_VERSION);
  assert.strictEqual(record.toVersion, NEW_VERSION);
  return record;
}

async function main() {
  // --- 1. Capability report: agentUpdate mechanism matches the platform ----
  assert.deepStrictEqual(
    healthTest.getAgentUpdateCapability("win32"),
    { supported: true, mechanism: "windows-scheduled-task" },
    "Windows must report the scheduled-task swap mechanism.",
  );
  assert.deepStrictEqual(
    healthTest.getAgentUpdateCapability("linux", true),
    { supported: true, mechanism: "linux-systemd" },
    "Linux with systemd must report the systemd mechanism.",
  );
  assert.deepStrictEqual(
    healthTest.getAgentUpdateCapability("linux", false),
    { supported: false, mechanism: null },
    "Linux without systemd must not claim self-update support.",
  );
  assert.deepStrictEqual(
    healthTest.getAgentUpdateCapability("darwin"),
    { supported: false, mechanism: null },
    "Unsupported platforms must not claim self-update support.",
  );
  assert.strictEqual(
    healthTest.buildAgentCapabilities({ platform: "win32" }).agentUpdate.mechanism,
    "windows-scheduled-task",
    "The health capabilities payload must carry agentUpdate for Windows.",
  );
  assert("agentUpdate" in healthTest.buildAgentCapabilities({ platform: "linux" }), "The health capabilities payload must carry agentUpdate for Linux.");

  // --- 2. Plan and post-exit swap script generation ------------------------
  const plan = selfUpdate.buildLinuxAgentUpdatePlan();
  assert.deepStrictEqual(
    plan.map((step) => step.id),
    selfUpdate.UPDATE_PLAN_STEP_IDS,
    "The update plan must match the canonical ordered step ids.",
  );
  assert(plan.every((step) => step.label && step.state === "pending"), "Plan steps must start pending with labels.");

  const script = selfUpdate.buildPostExitSwapScript({
    runtimeRoot: "/opt/anx/live",
    stagedRoot: "/opt/anx/live.update-1",
    backupRoot: "/opt/anx/live.backup-1",
    resultPath: "/home/u/update/swap.result",
  });
  const stopAt = script.indexOf('systemctl --user stop "$UNIT"');
  const backupAt = script.indexOf('mv "$RUNTIME" "$BACKUP"');
  const publishAt = script.indexOf('mv "$STAGED" "$RUNTIME"');
  const startAt = script.indexOf('systemctl --user start "$UNIT"');
  const restoreAt = script.indexOf('mv "$BACKUP" "$RUNTIME"');
  assert(stopAt >= 0 && backupAt > stopAt, "The script must stop the agent before moving the current runtime to the backup path.");
  assert(publishAt > backupAt, "The script must take the backup BEFORE publishing the staged runtime.");
  assert(startAt > publishAt, "The script must restart the unit after the swap.");
  assert(restoreAt > publishAt, "The script must contain a rollback branch that restores the backup after a failed publish.");
  assert(script.includes(selfUpdate.SWAP_STATUS.COMPLETE) && script.includes(selfUpdate.SWAP_STATUS.FAILED_ROLLED_BACK), "The script must write complete/rolled-back result markers.");
  assert(script.includes("'/opt/anx/live'"), "Paths must be shell-quoted in the script.");

  // --- 3. Swap semantics: backup-before-swap, atomic publish, rollback -----
  const swapStates = [];
  {
    const root = makeTempRoot("anxos-agent-self-update-swap-");
    swapStates.push({ root });
    const runtimeRoot = path.join(root, "live");
    const stagedRoot = path.join(root, "staged");
    const backupRoot = path.join(root, "backup");
    writeAgentTree(runtimeRoot, OLD_VERSION, OLD_MARKER);
    writeAgentTree(stagedRoot, NEW_VERSION, NEW_MARKER);

    const swapResult = selfUpdate.swapLinuxAgentRuntime({ runtimeRoot, stagedRoot, backupRoot });
    assert.strictEqual(swapResult.swapped, true);
    assert.strictEqual(swapResult.backupPreserved, true, "A successful swap must preserve the previous runtime at the backup path.");
    assert.strictEqual(readServerMarker(runtimeRoot), NEW_MARKER, "The live runtime must contain the staged content after the swap.");
    assert.strictEqual(readServerMarker(backupRoot), OLD_MARKER, "The backup must contain the previous runtime content.");

    // Mid-swap failure on a fresh set: the backup rename succeeds, the
    // publish rename fails, and the module must roll the backup back so the
    // previous runtime stays live. The rename seam fails deterministically on
    // the publish call (the second rename).
    const liveRoot = path.join(root, "live-rollback");
    const stagedTwice = path.join(root, "staged-rollback");
    const backupTwice = path.join(root, "backup-rollback");
    writeAgentTree(liveRoot, OLD_VERSION, OLD_MARKER);
    writeAgentTree(stagedTwice, NEW_VERSION, NEW_MARKER);
    let renameCalls = 0;
    const rollbackError = await expectError("LINUX_AGENT_SWAP_FAILED", () => selfUpdate.swapLinuxAgentRuntime({
      runtimeRoot: liveRoot,
      stagedRoot: stagedTwice,
      backupRoot: backupTwice,
      rename: (from, to) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("simulated publish failure");
        fs.renameSync(from, to);
      },
    }));
    assert.strictEqual(renameCalls, 3, "The swap must attempt backup, publish and rollback renames.");
    assert.strictEqual(rollbackError.rolledBack, true, "A failed publish must be reported as rolled back.");
    assert.strictEqual(readServerMarker(liveRoot), OLD_MARKER, "The previous runtime must be restored from the backup after a failed publish.");
    assert.strictEqual(fs.existsSync(backupTwice), false, "The rollback must consume the backup (it became the live runtime again).");
    assert.strictEqual(listSiblings(liveRoot, ".update-").length, 0);

    // A missing staged tree must be refused BEFORE the previous runtime is
    // touched (no backup rename, no rollback needed).
    const missingStagedError = await expectError("LINUX_AGENT_SWAP_STAGED_MISSING", () => selfUpdate.swapLinuxAgentRuntime({ runtimeRoot: liveRoot, stagedRoot: path.join(root, "does-not-exist"), backupRoot: backupTwice }));
    assert.strictEqual(missingStagedError.rolledBack, false);
    assert.strictEqual(readServerMarker(liveRoot), OLD_MARKER, "The live runtime must stay untouched when the staged tree is missing.");
    assert.strictEqual(fs.existsSync(backupTwice), false);

    // A failed backup rename must leave the live runtime untouched.
    await expectError("LINUX_AGENT_SWAP_BACKUP_FAILED", () => selfUpdate.swapLinuxAgentRuntime({
      runtimeRoot: liveRoot,
      stagedRoot: stagedTwice,
      backupRoot: backupTwice,
      rename: () => {
        throw new Error("simulated backup failure");
      },
    }));
    assert.strictEqual(readServerMarker(liveRoot), OLD_MARKER);
  }

  // --- 4. Full update flow: happy path --------------------------------------
  {
    const state = makeHarness();
    const result = await state.run();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.swapped, true);
    assert.strictEqual(result.mechanism, "linux-systemd");
    assert.strictEqual(result.unitName, "anxos-agent.service");
    assert.strictEqual(result.pinnedVersion, NEW_VERSION);

    // The scheduled command must be the systemd-run transient unit with the
    // swap timeout propagated, and the restart confirmation must come AFTER
    // the swap (command order is the progress contract).
    assert.strictEqual(state.commands[0].file, "systemd-run");
    assert.strictEqual(state.commands[0].timeoutMs, 12345, "The systemd-run call must carry the swap timeout.");
    const runArgs = state.commands[0].args;
    assert(runArgs.includes("--user") && runArgs.includes("--collect") && runArgs.includes("--wait"), "The swap unit must run as a user transient unit that is waited on and collected.");
    assert(String(runArgs[runArgs.indexOf("--unit") + 1]).startsWith("anxos-agent-update-"), "The transient unit must use the anxos-agent-update- prefix.");
    assert(runArgs.includes("/bin/sh"), "The swap script must run under /bin/sh.");
    const scriptPath = runArgs[runArgs.length - 1];
    assert.strictEqual(scriptPath, state.scheduled.scriptPath);
    assert(fs.existsSync(scriptPath), "The generated swap script must exist before scheduling.");
    assert.strictEqual(state.commands[1].file, "systemctl", "The restart confirmation must follow the swap.");
    assert(state.commands[1].args.includes("is-active"));

    // Filesystem outcome: staged content live, previous runtime preserved in
    // the backup sibling, no leftover staging/temp directories.
    assert.strictEqual(readServerMarker(state.runtimeRoot), NEW_MARKER);
    assert.strictEqual(readServerMarker(result.backupRoot), OLD_MARKER);
    assert.strictEqual(listSiblings(state.runtimeRoot, ".update-").length, 0, "Staging must be consumed by the swap (temp+rename, no leftovers).");
    assert.deepStrictEqual(listSiblings(state.runtimeRoot, ".backup-"), [path.basename(result.backupRoot)], "Exactly the swap backup must remain next to the runtime.");

    // Steps recorded in canonical order, all complete.
    assert.deepStrictEqual(
      result.steps.map((step) => step.id),
      selfUpdate.UPDATE_PLAN_STEP_IDS,
      "The flow must record every canonical plan step.",
    );
    assert(result.steps.every((step) => step.state === "complete"), `All steps must complete: ${JSON.stringify(result.steps)}`);
    assert(result.steps.find((step) => step.id === "swap").message.includes(result.backupRoot), "The swap step must record where the previous runtime was preserved.");

    const record = assertRecord(state, "complete");
    assert.strictEqual(record.backupRoot, result.backupRoot);
    cleanupRoots([state]);
  }

  // --- 5. Failure paths ------------------------------------------------------
  {
    // Publish failure inside the unit: the flow must report the rollback, the
    // previous runtime must still be live, and no restart confirmation may
    // run after the failed swap.
    const state = makeHarness({ failPublish: true });
    const error = await expectError("LINUX_AGENT_SWAP_FAILED", () => state.run());
    assert.strictEqual(error.details.rolledBack, true, "A failed-rolled-back swap must be reported with rolledBack=true.");
    assert.strictEqual(readServerMarker(state.runtimeRoot), OLD_MARKER, "The previous runtime must still be live after the rolled-back swap.");
    assert.strictEqual(listSiblings(state.runtimeRoot, ".backup-").length, 0, "The rollback must have restored the backup over the live runtime.");
    assertRecord(state, "failed");
    assert(state.commands.every((entry) => entry.file !== "systemctl"), "No restart confirmation may follow a failed swap.");
    const swapStep = error.steps.find((step) => step.id === "swap");
    assert.strictEqual(swapStep.state, "failed", "The swap step must be marked failed.");
    cleanupRoots([state]);
  }
  {
    // systemd-run unavailable: scheduling fails, the staged tree stays for a
    // retry, and the failure is recorded.
    const state = makeHarness({ scheduleFails: true });
    await expectError("LINUX_AGENT_SWAP_SCHEDULE_FAILED", () => state.run());
    assert.strictEqual(listSiblings(state.runtimeRoot, ".update-").length, 1, "The staged runtime must remain for a retry when scheduling fails.");
    assertRecord(state, "failed");
    cleanupRoots([state]);
  }
  {
    // Swap unit exceeds the timeout: reported distinctly, never retried
    // silently.
    const state = makeHarness({ scheduleTimesOut: true });
    await expectError("LINUX_AGENT_SWAP_TIMEOUT", () => state.run());
    assertRecord(state, "failed");
    cleanupRoots([state]);
  }
  {
    // Unit finished without writing a result marker: outcome must be treated
    // as unknown, not success.
    const state = makeHarness({ writeResult: false });
    await expectError("LINUX_AGENT_SWAP_OUTCOME_UNKNOWN", () => state.run());
    assertRecord(state, "failed");
    cleanupRoots([state]);
  }
  {
    // Unit reported a restart failure: swap must not count as complete.
    const state = makeHarness({ swapStatus: selfUpdate.SWAP_STATUS.FAILED_RESTART });
    const error = await expectError("LINUX_AGENT_SWAP_FAILED", () => state.run());
    assert.strictEqual(error.details.swapStatus, selfUpdate.SWAP_STATUS.FAILED_RESTART);
    assert.strictEqual(error.details.rolledBack, false);
    assertRecord(state, "failed");
    cleanupRoots([state]);
  }
  {
    // Staging failure: temp tree cleaned up, nothing published, recorded.
    const state = makeHarness({ copyFails: true });
    await expectError("LINUX_AGENT_STAGE_FAILED", () => state.run());
    assert.strictEqual(listSiblings(state.runtimeRoot, ".update-").length, 0, "A failed staging attempt must leave no temp or staged directories behind.");
    assert.strictEqual(readServerMarker(state.runtimeRoot), OLD_MARKER, "The live runtime must stay untouched when staging fails.");
    assertRecord(state, "failed");
    cleanupRoots([state]);
  }
  {
    // Missing required roots are rejected before anything runs.
    const state = makeHarness();
    await expectError("LINUX_AGENT_UPDATE_INVALID_OPTIONS", () => selfUpdate.runLinuxAgentSelfUpdate({
      sourceRoot: state.sourceRoot,
      updateDir: state.updateDir,
      runCommand: state.runCommand,
    }));
    cleanupRoots([state]);
  }

  cleanupRoots(swapStates);
  console.log("agent-self-update-smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
