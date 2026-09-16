const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// Adversarial-input smoke for the docker route surface: hostile methods,
// non-JSON bodies, traversal-shaped ids, invalid idempotency keys, and null
// payloads must fail closed (or be tolerated) — never crash or escape.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-docker-hostile-"));
const engine = require("../src/shared/instances/jobLifecycle");
engine.configureJobLifecycle({ getRoot: () => path.join(root, "jobs") });

const calls = { create: 0 };
const stubDockerService = {
  createContainer: async (payload) => { calls.create += 1; return { id: "mock-1", name: payload?.name }; },
};
const originalLoad = Module._load;
let handleDocker;
try {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "../services/dockerService") return stubDockerService;
    return originalLoad.call(this, request, parent, isMain);
  };
  handleDocker = require("../agent/src/routes/docker").handleDocker;
} finally {
  Module._load = originalLoad;
}

const BASE = "http://127.0.0.1:47131";
const u = (p) => new URL(`${BASE}${p}`);

async function main() {
  // 1. Wrong method on capabilities is a clean 404, not a crash.
  const badMethod = await handleDocker({ method: "GETTRASH", body: "" }, u("/api/v1/docker/capabilities"));
  assert.strictEqual(badMethod.statusCode, 404, "Unknown methods must 404.");

  // 2. Non-JSON body on a parsing route is a 400 INVALID_JSON.
  const badJson = await handleDocker({ method: "POST", body: "{ nope" }, u("/api/v1/docker/containers"));
  assert.strictEqual(badJson.statusCode, 400, "Malformed JSON bodies must 400.");
  assert.strictEqual(badJson.body?.error?.code, "INVALID_JSON", "Malformed JSON must carry INVALID_JSON.");

  // 3. A JSON 'null' body must not crash create (treated as empty payload).
  const nullBody = await handleDocker({ method: "POST", body: "null" }, u("/api/v1/docker/containers"));
  assert.strictEqual(nullBody.statusCode, 201, "A null JSON body must be tolerated as an empty payload.");
  assert.strictEqual(calls.create, 1, "The engine must receive the tolerated payload.");

  // 4. Traversal-shaped container ids are refused (404), never decoded/passed.
  for (const target of ["/api/v1/docker/containers/%2F..%2F..%2Fetc%2Fpasswd/start", "/api/v1/docker/containers/a%2Fb/stop", "/api/v1/docker/containers/..%2Fx/delete"]) {
    const method = target.endsWith("/delete") ? "DELETE" : "POST";
    const resp = await handleDocker({ method, body: "" }, u(target));
    assert.strictEqual(resp.statusCode, 404, `Traversal-shaped id must 404: ${target}`);
  }

  // 5. An invalid idempotency key is a 400 from the job engine (fail closed).
  const badKey = await handleDocker({ method: "POST", body: JSON.stringify({ name: "web-01", idempotencyKey: "bad key with spaces" }) }, u("/api/v1/docker/containers"));
  assert.strictEqual(badKey.statusCode, 400, "Invalid idempotency keys must 400.");
  assert.strictEqual(badKey.body?.error?.code, "INVALID_IDEMPOTENCY_KEY", "Invalid keys must carry the engine code.");
  assert.strictEqual(calls.create, 1, "A rejected key must never reach the engine.");

  console.log("docker:hostile-input:smoke passed");
}

main().catch((error) => {
  console.error("docker:hostile-input:smoke FAILED:", error);
  process.exitCode = 1;
});