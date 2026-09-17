const assert = require("assert");

// Pin runtime roots before service modules load (eb13b83 job-store leak
// lesson): the dependency path reaches the agent config and runtime-pin
// services.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-dependency-abort-listener-");

const dependencyService = require("../agent/src/services/dependencyService");

async function main() {
  let handler = null;
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener: (_event, nextHandler) => { handler = nextHandler; added += 1; },
    removeEventListener: (_event, nextHandler) => {
      assert.strictEqual(nextHandler, handler, "Dependency runner should remove the same abort handler it registered.");
      removed += 1;
    },
  };
  const result = await dependencyService._test.runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { signal });
  assert.strictEqual(result.ok, true, "Dependency command fixture should complete normally.");
  assert.deepStrictEqual({ added, removed }, { added: 1, removed: 1 }, "A completed command must release its operation abort listener.");

  let abortedAdded = 0;
  const alreadyAborted = {
    aborted: true,
    addEventListener: () => { abortedAdded += 1; },
    removeEventListener: () => {},
  };
  const abortedResult = await dependencyService._test.runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: alreadyAborted });
  assert.strictEqual(abortedAdded, 0, "An already-aborted signal must not retain a new listener.");
  assert.strictEqual(abortedResult.ok, false, "An already-aborted dependency command should be terminated.");
  console.log("Dependency abort listener smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
