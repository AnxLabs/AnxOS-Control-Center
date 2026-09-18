// Shared Agent-readiness wait for smokes that spawn a real Agent process.
//
// WHY THIS EXISTS
// Nine smokes each had their own readiness loop, and the loops shared two
// defects that made the gate untrustworthy:
//
//  1. The poll budget silently doubled as a boot-latency test. 60-120 attempts
//     at 100 ms is 6-12 seconds, which is ample on an idle machine and NOT ample
//     on a loaded one, so suites failed intermittently for no product reason.
//     Observed during a frozen-commit audit: node:independent-health:smoke
//     failed at 152/252 and agent:api-authorization:smoke failed at 44/254 while
//     other agents were working, and each passed in isolation. A gate that
//     fails for environmental reasons is worse than no gate, because it trains
//     everyone to ignore it.
//  2. The failure message hid the cause. "X did not become ready" is the same
//     text whether the Agent is still booting, crashed on a bind error, or the
//     port is already in use. The harness must say which, because that
//     difference decides whether you debug the product or the fixture.
//
// Waiting longer is not "weakening the test": these assertions are about what
// the Agent DOES once up, not about how fast it boots. The deliberate
// short-budget cases (a probe that must time out, a closed port that must look
// offline) stay at their call sites with a comment, because there the tight
// budget IS the assertion.
//
// WHAT IT DOES NOT DO
// It does not start or stop the child, and it does not make a genuinely broken
// Agent pass: if the child exits, the wait fails immediately and reports why.

const DEFAULT_ATTEMPTS = 300; // 30 s at the default interval
const DEFAULT_INTERVAL_MS = 100;

/**
 * Wait until `probe()` reports readiness.
 *
 * @param {object} options
 * @param {() => Promise<boolean>} options.probe        returns true when ready
 * @param {string} options.label                        used in failure messages
 * @param {number} [options.attempts]                   poll attempts (default 300)
 * @param {number} [options.intervalMs]                 delay between polls
 * @param {import("child_process").ChildProcess} [options.child]  fast-fail if it exits
 * @param {() => string} [options.stderr]               returns captured child stderr
 * @returns {Promise<void>}
 */
async function waitForAgentReady(options = {}) {
  const {
    probe,
    label = "Agent",
    attempts = DEFAULT_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    child = null,
    stderr = null,
  } = options;

  if (typeof probe !== "function") {
    throw new Error("waitForAgentReady requires a probe function.");
  }

  const stderrTail = () => {
    if (typeof stderr !== "function") return "";
    try {
      return String(stderr() || "").slice(-800);
    } catch {
      return "";
    }
  };

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A dead child can never become ready, so waiting the full budget would
    // turn a crash into a 30-second timeout that reports the wrong thing.
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `${label} exited before becoming ready (code=${child.exitCode} signal=${child.signalCode}).` +
        (stderrTail() ? ` stderr: ${stderrTail()}` : ""),
      );
    }
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `${label} did not become ready within ${attempts * intervalMs} ms` +
    ` (last probe error: ${lastError || "none"})` +
    (stderrTail() ? `. stderr: ${stderrTail()}` : ""),
  );
}

module.exports = { DEFAULT_ATTEMPTS, DEFAULT_INTERVAL_MS, waitForAgentReady };