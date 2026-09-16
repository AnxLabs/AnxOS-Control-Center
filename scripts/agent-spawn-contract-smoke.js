const assert = require("assert");
const Module = require("module");

// V2-A spawn-contract regression smoke (docs/v2/V2A_DECISIONS.md Decision 1):
// the desktop refuses to spawn an agent without the canonical env triple, and
// the agent-side spawn evaluation is loud for standalone/legacy starts.

const originalLoad = Module._load;
let agentControlService;
try {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return { app: null };
    return originalLoad.call(this, request, parent, isMain);
  };
  agentControlService = require("../src/services/agentControlService");
} finally {
  Module._load = originalLoad;
}

const { evaluateSpawnEnvironment, emitSpawnDiagnostic } = require("../agent/src/services/enrollmentService");

function main() {
  const assertSpawn = agentControlService._test.assertAgentSpawnContractEnvironment;

  // 1. Missing canonical env triple is refused before any spawn.
  assert.throws(
    () => assertSpawn({}),
    (error) => {
      assert.strictEqual(error.code, "AGENT_SPAWN_CONTRACT_VIOLATED");
      assert.deepStrictEqual(
        new Set(error.details.missingSpawnEnv),
        new Set(["ANXHUB_CONFIG_DIR", "AGENT_IDENTITY_PATH", "AGENT_INSTANCE_ROOT"]),
      );
      return true;
    },
    "A spawn without the canonical env triple must be refused.",
  );
  assert.throws(
    () => assertSpawn({ ANXHUB_CONFIG_DIR: "C:\\config", AGENT_IDENTITY_PATH: "C:\\config\\device-identity.json" }),
    (error) => {
      assert.strictEqual(error.code, "AGENT_SPAWN_CONTRACT_VIOLATED");
      assert.deepStrictEqual(error.details.missingSpawnEnv, ["AGENT_INSTANCE_ROOT"]);
      return true;
    },
    "A spawn missing only the instance root must still be refused (no stray-root fallback).",
  );

  // 2. A complete canonical spawn env passes.
  const canonicalEnv = {
    ANXHUB_CONFIG_DIR: "C:\\app\\config",
    AGENT_IDENTITY_PATH: "C:\\app\\agent\\device-identity.json",
    AGENT_INSTANCE_ROOT: "C:\\app\\agent\\instances",
  };
  assert.strictEqual(assertSpawn(canonicalEnv), true, "A complete canonical spawn env must pass.");

  // 3. Blank values count as missing.
  assert.throws(
    () => assertSpawn({ ...canonicalEnv, ANXHUB_CONFIG_DIR: "   " }),
    (error) => error.code === "AGENT_SPAWN_CONTRACT_VIOLATED",
    "Blank canonical env values must not satisfy the contract.",
  );

  // 4. Agent-side evaluation: standalone starts are loud and actionable, and
  // legacy AnxHub bindings are called out instead of being silently trusted.
  const standalone = evaluateSpawnEnvironment({});
  assert.strictEqual(standalone.spawnContract, "standalone");
  assert.strictEqual(standalone.canonical, false);
  assert.match(standalone.diagnostic, /ANXHUB_CONFIG_DIR/);
  assert.match(standalone.diagnostic, /enroll/i);
  const legacy = evaluateSpawnEnvironment({ ANXHUB_CONFIG_DIR: "/home/user/.anxhub/AnxHub/config" });
  assert.strictEqual(legacy.spawnContract, "legacy-anxhub");
  assert.match(legacy.diagnostic, /legacy AnxHub/i);
  const desktop = evaluateSpawnEnvironment({ ANXHUB_CONFIG_DIR: "/home/user/.config/anxos-control-center/config" });
  assert.strictEqual(desktop.spawnContract, "desktop");
  assert.strictEqual(desktop.canonical, true);
  assert.strictEqual(desktop.diagnostic, null);
  // Emitting the diagnostics must never throw (used at agent startup).
  emitSpawnDiagnostic(standalone);
  emitSpawnDiagnostic(legacy);
  emitSpawnDiagnostic(desktop);

  console.log("agent:spawn-contract:smoke passed");
}

try {
  main();
} catch (error) {
  console.error("agent:spawn-contract:smoke FAILED:", error);
  process.exitCode = 1;
}
