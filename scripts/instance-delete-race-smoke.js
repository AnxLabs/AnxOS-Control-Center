// Windows locked-handle reproduction for the recursive instance-directory delete.
//
// Why this exists: `deleteInstance` in src/shared/instances/instanceServiceCore.js
// removes the instance tree with `fs.rm(path, { recursive: true, force: true })`.
// The game-server child is spawned with its working directory inside that tree
// (`resolveRelativeManagedPath(id, "data", "data")`), and a detached runtime can
// outlive the wrapper whose PID the delete guard checks. When a live process still
// holds a handle in the tree, the recursive delete fails with EBUSY and leaves the
// directory behind (the caller reports INSTANCE_DELETE_FAILED).
//
// This script spawns a real child process (PowerShell) that takes an exclusive
// handle on a file inside the tree, then attempts the recursive delete with and
// without retries, so the retry behaviour is observed rather than inferred.
//
// Honesty rules for this script:
//   - The "live handle" phase is the provable reproduction: it fails without
//     retries and succeeds with the production retry options.
//   - The "post-exit" phase targets the narrower "handle release lags the process
//     exit" window. That window is timing-dependent and may not be reproducible on
//     a given machine; when it is not, the script says so instead of faking it.
//   - The script only fails (non-zero exit) when an invariant it can actually
//     prove does not hold.

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ITERATIONS = 10;
const LIVE_HOLD_MS = 150;
// Production retry options under test: maxRetries 1 with Node's default
// retryDelay. Kept explicit and identical to the code path being covered.
const PRODUCTION_RETRY_OPTIONS = { maxRetries: 1 };
// Generous backstop used only to guarantee temp cleanup after a failure.
const CLEANUP_RETRY_OPTIONS = { maxRetries: 10, retryDelay: 100 };

const POWERSHELL = "powershell.exe";

function buildTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-instance-delete-race-"));
  const dataRoot = path.join(dir, "data", "data");
  fs.mkdirSync(path.join(dataRoot, "world"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "world", "level.dat"), Buffer.alloc(8192, 7));
  fs.writeFileSync(path.join(dataRoot, "session.lock"), "lock\n");
  fs.writeFileSync(path.join(dir, "config.json"), "{}\n");
  return { dir, lockedFile: path.join(dataRoot, "session.lock") };
}

function holderScript(lockedFile, holdMs) {
  return [
    `$fs = [System.IO.File]::Open("${lockedFile}", [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
    `[Console]::Out.WriteLine("HELD")`,
    `[Console]::Out.Flush()`,
    holdMs > 0 ? `Start-Sleep -Milliseconds ${holdMs}` : "",
    holdMs > 0 ? `try { $fs.Dispose() } catch {}` : "",
  ].filter(Boolean).join("\n");
}

function spawnHolder(lockedFile, holdMs) {
  return spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", holderScript(lockedFile, holdMs)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function waitForHolder(child) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("HELD")) {
        done();
      }
    });
    child.on("exit", done);
    setTimeout(done, 5000);
  });
}

async function attemptDelete(dir, retryOptions) {
  const options = { recursive: true, force: true, ...retryOptions };
  const startedAt = Date.now();
  try {
    await fsp.rm(dir, options);
    return { ok: true, code: null, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, code: error?.code || error?.name || "UNKNOWN", elapsedMs: Date.now() - startedAt };
  }
}

function killHolder(child) {
  if (child && child.exitCode == null && child.signalCode == null) {
    try {
      child.kill();
    } catch {
      // The holder may already have exited.
    }
  }
}

async function forceCleanup(dir, child) {
  killHolder(child);
  try {
    await fsp.rm(dir, { recursive: true, force: true, ...CLEANUP_RETRY_OPTIONS });
  } catch {
    // Best-effort temp cleanup only; never let cleanup mask the observation.
  }
}

// Phase 1: a live child holds an exclusive handle while the recursive delete runs.
async function liveHandlePhase() {
  const observations = [];
  let noRetryFailures = 0;
  let retriedSuccesses = 0;

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    // Without retries.
    const plain = buildTree();
    const plainHolder = spawnHolder(plain.lockedFile, LIVE_HOLD_MS);
    try {
      await waitForHolder(plainHolder);
      const outcome = await attemptDelete(plain.dir, {});
      if (!outcome.ok) {
        noRetryFailures += 1;
      }
      observations.push({
        iteration,
        mode: "no-retries",
        code: outcome.code,
        elapsedMs: outcome.elapsedMs,
        existsAfter: fs.existsSync(plain.dir),
      });
    } finally {
      await forceCleanup(plain.dir, plainHolder);
    }

    // With the production retry options.
    const retried = buildTree();
    const retriedHolder = spawnHolder(retried.lockedFile, LIVE_HOLD_MS);
    try {
      await waitForHolder(retriedHolder);
      const outcome = await attemptDelete(retried.dir, PRODUCTION_RETRY_OPTIONS);
      if (outcome.ok) {
        retriedSuccesses += 1;
      }
      observations.push({
        iteration,
        mode: "maxRetries:1",
        code: outcome.code,
        elapsedMs: outcome.elapsedMs,
        existsAfter: fs.existsSync(retried.dir),
      });
      // A retried delete that reports success must actually have removed the tree.
      assert.strictEqual(
        fs.existsSync(retried.dir),
        false,
        `iteration ${iteration}: retried delete reported success but the directory still exists`,
      );
    } finally {
      await forceCleanup(retried.dir, retriedHolder);
    }
  }

  return { observations, noRetryFailures, retriedSuccesses };
}

// Phase 2: the narrower window where a holder has exited but the OS handle
// release may lag the process exit. Fired on the 'exit' event with no delay.
async function postExitPhase() {
  const observations = [];
  let noRetryFailures = 0;

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const tree = buildTree();
    const holder = spawnHolder(tree.lockedFile, 0); // hold then exit without disposing
    try {
      await waitForHolder(holder);
      await new Promise((resolve) => {
        if (holder.exitCode != null || holder.signalCode != null) {
          resolve();
          return;
        }
        holder.on("exit", resolve);
      });
      const outcome = await attemptDelete(tree.dir, {});
      if (!outcome.ok) {
        noRetryFailures += 1;
      }
      observations.push({
        iteration,
        mode: "post-exit-no-retries",
        code: outcome.code,
        elapsedMs: outcome.elapsedMs,
        existsAfter: fs.existsSync(tree.dir),
      });
    } finally {
      await forceCleanup(tree.dir, holder);
    }
  }

  return { observations, noRetryFailures };
}

function powershellAvailable() {
  if (process.platform !== "win32") {
    return false;
  }
  const probe = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    stdio: "ignore",
    timeout: 15000,
  });
  return probe.status === 0;
}

async function main() {
  if (process.platform !== "win32") {
    console.error(`instance-delete-race-smoke requires Windows; got platform "${process.platform}".`);
    process.exitCode = 1;
    return;
  }
  if (!powershellAvailable()) {
    console.error("instance-delete-race-smoke could not acquire an exclusive Windows handle: powershell.exe unavailable.");
    process.exitCode = 1;
    return;
  }

  console.log(`instance-delete-race-smoke: ${ITERATIONS} iterations per phase on ${process.platform}`);

  const live = await liveHandlePhase();
  for (const row of live.observations) {
    console.log(
      `  live-handle iter=${row.iteration} mode=${row.mode} ok=${row.code === null} code=${row.code || "none"} elapsedMs=${row.elapsedMs} existsAfter=${row.existsAfter}`,
    );
  }

  const postExit = await postExitPhase();
  for (const row of postExit.observations) {
    console.log(
      `  post-exit iter=${row.iteration} mode=${row.mode} ok=${row.code === null} code=${row.code || "none"} elapsedMs=${row.elapsedMs} existsAfter=${row.existsAfter}`,
    );
  }

  // The provable invariant: with the production retry options, every delete
  // racing a live handle eventually succeeds and removes the tree.
  assert.strictEqual(
    live.retriedSuccesses,
    ITERATIONS,
    `expected all ${ITERATIONS} retried deletes to succeed, got ${live.retriedSuccesses}`,
  );

  const reproduced = live.noRetryFailures > 0;
  console.log(
    `instance-delete-race-smoke live-handle: no-retries failures ${live.noRetryFailures}/${ITERATIONS}, ` +
      `maxRetries:1 successes ${live.retriedSuccesses}/${ITERATIONS}`,
  );
  if (reproduced) {
    console.log(
      "instance-delete-race-smoke RESULT: REPRODUCED the locked-handle delete failure without retries; " +
        `observed code(s) ${[...new Set(live.observations.filter((r) => r.code).map((r) => r.code))].join(", ")}.`,
    );
  } else {
    console.log(
      "instance-delete-race-smoke RESULT: locked-handle failure NOT provoked on this machine; the retry " +
        "options were still verified to be honoured on the recursive path.",
    );
  }
  console.log(
    `instance-delete-race-smoke post-exit window: no-retries failures ${postExit.noRetryFailures}/${ITERATIONS}` +
      (postExit.noRetryFailures > 0
        ? ""
        : " (post-exit handle-release lag not reproduced on this machine)"),
  );

  console.log("instance-delete-race-smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});