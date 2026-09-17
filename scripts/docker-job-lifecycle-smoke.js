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

  // 6. Degenerate docker job types fail closed: bare, missing action or
  // namespace, and extra segments must all be rejected.
  for (const bad of ["docker.", "docker..", "docker..x", "docker.x", "docker.container", "docker.container.start.extra"]) {
    await assert.rejects(
      () => mintDockerJob({ type: bad, run: async () => ({}) }),
      (error) => error.code === "INVALID_DOCKER_JOB_TYPE",
      `Degenerate docker job type must be rejected: ${bad}`,
    );
  }

  // 7. Wave-2 durable-job wiring: compose/images/volumes/networks/cleanup
  // lifecycle operations mint the same durable jobs containers do.
  let composeRuns = 0;
  const mintComposeStart = (key) => mintDockerJob({
    type: "docker.compose.start",
    target: { projectName: "stack-01" },
    idempotencyKey: key,
    run: async () => {
      composeRuns += 1;
      return { up: true };
    },
  });
  const composeFirst = await mintComposeStart("compose:stack-01:v1");
  assert.strictEqual(composeFirst.job.type, "docker.compose.start", "Compose start must mint a docker.compose.start job.");
  assert.strictEqual(composeFirst.job.target.projectName, "stack-01", "Compose targets must persist the project name.");
  const composeSecond = await mintComposeStart("compose:stack-01:v1");
  assert.strictEqual(composeSecond.job.id, composeFirst.job.id, "A keyed compose repeat must return the original job.");
  assert.strictEqual(composeRuns, 1, "A deduped compose call must not re-run the operation.");

  const connectJob = await mintDockerJob({
    type: "docker.network.connect",
    target: { networkId: "net-01", containerId: "web-01" },
    idempotencyKey: "netconnect:net-01:web-01:v1",
    run: async () => ({ connected: true }),
  });
  assert.strictEqual(connectJob.job.type, "docker.network.connect", "Network connect must ride the durable job store.");

  // Destructive refusal applies to every Wave-2 destructive family.
  for (const [type, target] of [
    ["docker.volume.delete", { volumeId: "data-01" }],
    ["docker.volume.prune", { scope: "unused-volumes" }],
    ["docker.image.prune", { scope: "unused-images" }],
    ["docker.network.delete", { networkId: "net-01" }],
    ["docker.network.prune", { scope: "unused-networks" }],
    ["docker.compose.down", { projectName: "stack-01" }],
    ["docker.cleanup.run", { kind: "volumes" }],
  ]) {
    await assert.rejects(
      () => mintDockerJob({ type, target, idempotencyKey: "never-replayable", run: async () => ({}) }),
      (error) => error.code === "DESTRUCTIVE_IDEMPOTENCY_REFUSED" && error.statusCode === 400,
      `Destructive docker job must refuse idempotency keys: ${type}`,
    );
  }

  console.log("docker:job-lifecycle:smoke passed");
}

main().catch((error) => {
  console.error("docker:job-lifecycle:smoke FAILED:", error);
  process.exitCode = 1;
});