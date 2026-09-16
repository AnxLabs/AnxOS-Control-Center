const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-C container-job lifecycle smoke (docs/v2/V2C_CONTAINERS_WAVE1.md §3.3):
// state-changing Docker operations ride the durable V2-A job store, a keyed
// repeat dedupes onto the original job, destructive Docker operations refuse
// idempotency keys (never replayed), and job records persist under
// jobs/<jobId>.json. Hermetic — no Docker engine required.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-docker-job-"));
const engine = require("../src/shared/instances/jobLifecycle");
engine.configureJobLifecycle({ getRoot: () => path.join(root, "jobs") });

const {
  DESTRUCTIVE_DOCKER_JOB_TYPES,
  mintDockerJob,
} = require("../agent/src/services/dockerJobService");

async function main() {
  // 1. The destructive docker set is pinned exactly as the Wave-1 contract
  // requires; adding a type must be a deliberate, tested decision.
  assert.deepStrictEqual(
    new Set([...DESTRUCTIVE_DOCKER_JOB_TYPES]),
    new Set([
      "docker.container.delete",
      "docker.image.delete",
      "docker.image.prune",
      "docker.volume.delete",
      "docker.volume.prune",
      "docker.network.delete",
      "docker.network.prune",
      "docker.compose.down",
      "docker.cleanup.run",
    ]),
    "The destructive docker set must enumerate exactly the contracted types.",
  );

  // 2. Non-destructive keyed lifecycle mints a durable job and dedupes.
  let runCount = 0;
  const mintStart = (key) => mintDockerJob({
    type: "docker.container.start",
    target: { containerId: "web-01" },
    idempotencyKey: key,
    run: async () => {
      runCount += 1;
      return { started: true };
    },
  });
  const first = await mintStart("start:web-01:v1");
  assert.strictEqual(first.job.type, "docker.container.start", "The job must carry the docker job type.");
  assert.strictEqual(first.job.target.containerId, "web-01", "Docker targets must persist container identity.");
  assert.strictEqual(first.job.state, "succeeded", "The docker job must settle succeeded.");
  assert(fs.existsSync(path.join(root, "jobs", `${first.job.id}.json`)), "Docker jobs must persist under jobs/<jobId>.json.");
  const second = await mintStart("start:web-01:v1");
  assert.strictEqual(second.job.id, first.job.id, "A keyed repeat must return the original job.");
  assert.strictEqual(second.deduped, true, "A keyed repeat must be reported as deduped.");
  assert.strictEqual(runCount, 1, "A deduped call must not re-execute the operation.");
  assert.strictEqual(second.result.started, true, "The deduped caller receives the original result.");

  // 3. Destructive Docker ops refuse idempotency keys (non-replay stance).
  await assert.rejects(
    () => mintDockerJob({
      type: "docker.container.delete",
      target: { containerId: "web-01" },
      idempotencyKey: "delete:web-01:v1",
      run: async () => ({ deleted: true }),
    }),
    (error) => error.code === "DESTRUCTIVE_IDEMPOTENCY_REFUSED" && error.statusCode === 400,
    "Destructive docker jobs must refuse idempotency keys.",
  );

  // 4. Destructive ops still mint fresh durable jobs without a key.
  const deletion = await mintDockerJob({
    type: "docker.container.delete",
    target: { containerId: "web-01" },
    run: async () => ({ deleted: true }),
  });
  assert.strictEqual(deletion.job.state, "succeeded", "The destructive docker job must settle succeeded.");
  assert.strictEqual(deletion.result.deleted, true, "The destructive operation result must be returned.");
  const listed = await engine.listJobs({ type: "docker.container.delete" });
  assert.strictEqual(listed.jobs.length, 1, "Exactly one destructive docker job record must exist.");

  // 5. Non-docker job types are refused by the wrapper (fail closed).
  await assert.rejects(
    () => mintDockerJob({ type: "instance.start", run: async () => ({}) }),
    (error) => error.code === "INVALID_DOCKER_JOB_TYPE",
    "Non-docker job types must be refused by the docker job wrapper.",
  );

  console.log("docker:job-lifecycle:smoke passed");
}

main().catch((error) => {
  console.error("docker:job-lifecycle:smoke FAILED:", error);
  process.exitCode = 1;
});