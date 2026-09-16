const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// V2-C route-level contract smoke: drives the real `handleDocker` dispatcher
// against a stubbed docker engine (require-cache patch, same pattern as
// agent-spawn-contract-smoke) so the create/start/delete branches — including
// the durable-job wrapping and target identity — are proven hermetically.
// Real engine operations remain the sandbox/live-acceptance step.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-docker-route-"));
const jobsRoot = path.join(root, "jobs");
const engine = require("../src/shared/instances/jobLifecycle");
engine.configureJobLifecycle({ getRoot: () => jobsRoot });

const calls = { create: 0, start: 0, delete: 0 };
const stubDockerService = {
  createContainer: async (payload) => {
    calls.create += 1;
    return { id: "container-mock-1", name: payload.name, image: payload.image };
  },
  startContainer: async (id) => { calls.start += 1; return { id, status: "running" }; },
  stopContainer: async (id) => ({ id, status: "stopped" }),
  restartContainer: async (id) => ({ id, status: "restarted" }),
  deleteContainer: async (id) => { calls.delete += 1; return { deleted: id }; },
  pullImage: async (image) => ({ image, status: "pulled" }),
};

const originalLoad = Module._load;
let dockerRoutes;
try {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "../services/dockerService") {
      return stubDockerService;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  dockerRoutes = require("../agent/src/routes/docker");
} finally {
  Module._load = originalLoad;
}

const { handleDocker } = dockerRoutes;
const BASE = "http://127.0.0.1:47131";
const post = (p, body) => ({ method: "POST", body: body ? JSON.stringify(body) : "" });
const del = (p) => ({ method: "DELETE", body: "" });

async function main() {
  // 1. Create: the branch mints a durable job carrying the requested name.
  const created = await handleDocker(post("/api/v1/docker/containers", { name: "web-01", image: "nginx:stable", idempotencyKey: "create:web-01:v1", jobTimeoutMs: 5000 }), new URL(`${BASE}/api/v1/docker/containers`));
  assert.strictEqual(created.statusCode, 201, "Create must return 201.");
  assert.strictEqual(created.body.id, "container-mock-1", "The engine result must be returned.");
  assert.strictEqual(created.body.job.type, "docker.container.create", "The response must attach the durable job.");
  assert.strictEqual(created.body.job.target.requestedId, "web-01", "The created container name must ride the job target.");
  assert.strictEqual(created.body.job.idempotencyKey, "create:web-01:v1", "The idempotency key must reach the job.");
  assert(fs.existsSync(path.join(jobsRoot, `${created.body.job.id}.json`)), "The create job must persist under jobs/.");
  assert.strictEqual(calls.create, 1, "The engine must run exactly once.");

  // 2. A keyed repeat dedupes onto the original job; the engine never re-runs.
  const repeated = await handleDocker(post("/api/v1/docker/containers", { name: "web-01", image: "nginx:stable", idempotencyKey: "create:web-01:v1", jobTimeoutMs: 5000 }), new URL(`${BASE}/api/v1/docker/containers`));
  assert.strictEqual(repeated.statusCode, 201, "A deduped create must still return 201.");
  assert.strictEqual(repeated.body.job.id, created.body.job.id, "The deduped call must return the original job.");
  assert.strictEqual(calls.create, 1, "A deduped create must not re-execute the engine.");

  // 3. Start: container identity rides the durable job target.
  const started = await handleDocker(post("/api/v1/docker/containers/web-01/start"), new URL(`${BASE}/api/v1/docker/containers/web-01/start`));
  assert.strictEqual(started.statusCode, 200, "Start must return 200.");
  assert.strictEqual(started.body.status, "running", "The engine result must be returned.");
  assert.strictEqual(started.body.job.type, "docker.container.start", "Start must attach a durable job.");
  assert.strictEqual(started.body.job.target.containerId, "web-01", "The container id must ride the job target.");
  assert.strictEqual(calls.start, 1, "Start must execute the engine once.");

  // 4. Delete: destructive delete mints a fresh durable job for a repeat call.
  const deleted = await handleDocker(del("/api/v1/docker/containers/web-01"), new URL(`${BASE}/api/v1/docker/containers/web-01`));
  assert.strictEqual(deleted.statusCode, 200, "Delete must return 200.");
  assert.strictEqual(deleted.body.deleted, "web-01", "The delete result must be returned.");
  assert.strictEqual(deleted.body.job.type, "docker.container.delete", "Delete must attach a durable job.");
  assert.strictEqual(calls.delete, 1, "Delete must execute the engine once.");
  const deletedAgain = await handleDocker(del("/api/v1/docker/containers/web-01"), new URL(`${BASE}/api/v1/docker/containers/web-01`));
  assert.strictEqual(calls.delete, 2, "A repeat delete is an explicit new destructive request (never replayed as a cached result).");
  assert.notStrictEqual(deletedAgain.body.job.id, deleted.body.job.id, "Each destructive request must mint a fresh job.");

  // 5. The store kept the expected job types.
  const types = new Set((await engine.listJobs()).jobs.map((job) => job.type));
  for (const type of ["docker.container.create", "docker.container.start", "docker.container.delete"]) {
    assert(types.has(type), `Store must contain a ${type} job.`);
  }

  console.log("docker:route-io:smoke passed");
}

main().catch((error) => {
  console.error("docker:route-io:smoke FAILED:", error);
  process.exitCode = 1;
});