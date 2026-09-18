// V2-E scheduled restarts smoke: hermetic checks of the restart schedule
// service (injected clock + fake executors, no real instances) plus a
// route-layer pass over the agent REST contract.
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const service = require("../agent/src/services/restartScheduleService");
const { handleInstances } = require("../agent/src/routes/instances");

const HOUR_MS = 60 * 60 * 1000;

function makeHarness(startMs) {
  const state = {
    clockMs: startMs,
    running: new Set(),
    warns: [],
    restarts: [],
    // Durable-job seam (Y2): jobs keyed by instance, plus a one-shot query
    // fault switch to exercise the fail-closed path.
    jobsByInstance: new Map(),
    jobQueryError: null,
    // One-shot hook fired inside restartInstance so a test can commit a
    // concurrent CRUD mutation while the tick is mid-flight (Y1).
    onRestart: null,
  };
  const executors = {
    now: () => state.clockMs,
    isInstanceRunning: async (instanceId) => state.running.has(instanceId),
    warnInstance: async (instanceId, message) => {
      state.warns.push({ instanceId, message, at: state.clockMs });
      return { id: instanceId, sent: true };
    },
    restartInstance: async (instanceId) => {
      state.restarts.push({ instanceId, at: state.clockMs });
      if (state.onRestart) {
        const hook = state.onRestart;
        state.onRestart = null;
        await hook(instanceId);
      }
      return { id: instanceId, state: "Running" };
    },
    listInstanceJobs: async (instanceId) => {
      if (state.jobQueryError) {
        throw state.jobQueryError;
      }
      const jobs = state.jobsByInstance.get(instanceId) || [];
      return { jobs, total: jobs.length };
    },
  };
  return { state, executors };
}

async function readStore(root) {
  return JSON.parse(await fs.readFile(path.join(root, "schedules.json"), "utf8"));
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

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anxos-restart-schedule-"));
  const { state, executors } = makeHarness(1_700_000_000_000);
  service.configureRestartScheduleService({ root, ...executors });

  // --- 1. CRUD persists, list contract, validation -------------------------
  const createdInterval = await service.createRestartSchedule({
    instanceId: "server-a",
    type: "interval",
    intervalHours: 6,
    warnMinutes: 5,
    enabled: true,
  });
  assert(createdInterval.schedule.id, "Created schedule must have an id.");
  assert.strictEqual(createdInterval.schedule.instanceId, "server-a");
  assert.strictEqual(createdInterval.schedule.type, "interval");
  assert.strictEqual(createdInterval.schedule.intervalHours, 6);
  assert.strictEqual(createdInterval.schedule.warnMinutes, 5);
  assert.strictEqual(createdInterval.schedule.enabled, true);
  assert.strictEqual(Date.parse(createdInterval.schedule.nextRunAt), state.clockMs + 6 * HOUR_MS);

  const createdDaily = await service.createRestartSchedule({
    instanceId: "server-b",
    type: "daily",
    dailyTime: "03:30",
  });
  assert.strictEqual(createdDaily.schedule.type, "daily");
  assert.strictEqual(createdDaily.schedule.warnMinutes, service.DEFAULT_WARN_MINUTES, "warnMinutes must default to 5.");
  const dailyNext = new Date(createdDaily.schedule.nextRunAt);
  assert.strictEqual(dailyNext.getHours(), 3, "Daily schedule must target the configured hour.");
  assert.strictEqual(dailyNext.getMinutes(), 30);
  assert(dailyNext.getTime() > state.clockMs, "Daily next run must be in the future.");

  let listed = await service.listRestartSchedules();
  assert.strictEqual(listed.schedules.length, 2, "Both schedules must be listed.");
  listed = await service.listRestartSchedules("server-a");
  assert.strictEqual(listed.schedules.length, 1);
  assert.strictEqual(listed.schedules[0].id, createdInterval.schedule.id);

  const store = await readStore(root);
  assert.strictEqual(store.schemaVersion, service.RESTART_SCHEDULE_SCHEMA_VERSION);
  assert.strictEqual(store.schedules.length, 2, "Schedules must persist to the dedicated store file.");

  const disabledUpdate = await service.updateRestartSchedule(createdInterval.schedule.id, {
    enabled: false,
    warnMinutes: 10,
  });
  assert.strictEqual(disabledUpdate.schedule.enabled, false, "Update must be able to disable a schedule.");
  assert.strictEqual(disabledUpdate.schedule.warnMinutes, 10);
  const reEnabled = await service.updateRestartSchedule(createdInterval.schedule.id, { enabled: true, warnMinutes: 5 });
  assert.strictEqual(reEnabled.schedule.enabled, true, "Update must be able to re-enable a schedule.");
  assert.strictEqual(reEnabled.schedule.warnMinutes, 5, "Update must restore the warning window.");
  assert(Date.parse(reEnabled.schedule.nextRunAt) > state.clockMs, "Re-enabled schedule must be re-anchored in the future.");

  await expectError("INVALID_INSTANCE_ID", () => service.createRestartSchedule({ instanceId: "bad id!" }));
  await expectError("INVALID_RESTART_INTERVAL", () => service.createRestartSchedule({ instanceId: "server-a", intervalHours: 0 }));
  await expectError("INVALID_RESTART_DAILY_TIME", () => service.createRestartSchedule({ instanceId: "server-a", type: "daily", dailyTime: "24:61" }));
  await expectError("INVALID_RESTART_WARN_MINUTES", () => service.createRestartSchedule({ instanceId: "server-a", intervalHours: 2, warnMinutes: 0 }));
  await expectError("RESTART_SCHEDULE_NOT_FOUND", () => service.deleteRestartSchedule("rs0000000000000000000000"));

  // --- 2. Warn minutes respected, then restart fires exactly once ----------
  state.running.add("server-a");
  const due = Date.parse(createdInterval.schedule.nextRunAt);
  const warnLogFor = (instanceId) => state.warns.filter((entry) => entry.instanceId === instanceId);

  state.clockMs = due - 5 * 60 * 1000 - 60 * 1000;
  await service.runDueSchedules();
  assert.strictEqual(warnLogFor("server-a").length, 0, "No warning before the warn threshold.");
  assert.strictEqual(state.restarts.length, 0);

  state.clockMs = due - 5 * 60 * 1000 + 1000;
  await service.runDueSchedules();
  assert.strictEqual(warnLogFor("server-a").length, 1, "Long warning must fire at warnMinutes before the restart.");
  assert(/5 minute/.test(warnLogFor("server-a")[0].message), "Long warning must state the lead time.");
  assert.strictEqual(state.restarts.length, 0);

  state.clockMs = due - 59 * 1000;
  await service.runDueSchedules();
  assert.strictEqual(warnLogFor("server-a").length, 2, "Short warning must fire one minute before the restart.");
  assert(/1 minute/.test(warnLogFor("server-a")[1].message), "Short warning must state the one-minute lead.");
  assert.strictEqual(state.restarts.length, 0);

  state.clockMs = due + 1000;
  await service.runDueSchedules();
  assert.strictEqual(state.restarts.length, 1, "The due restart must fire once.");
  assert.strictEqual(state.restarts[0].instanceId, "server-a");
  const afterRestart = (await service.listRestartSchedules("server-a")).schedules[0];
  assert(afterRestart.lastRunAt, "The restart must be recorded on the schedule.");
  assert.strictEqual(afterRestart.lastError, null);
  assert.strictEqual(Date.parse(afterRestart.nextRunAt), due + 6 * HOUR_MS, "Next run must advance by the interval.");

  state.clockMs = due + 61 * 1000;
  await service.runDueSchedules();
  assert.strictEqual(state.restarts.length, 1, "The next tick must not double-fire the restart.");
  assert.strictEqual(warnLogFor("server-a").length, 2, "Warnings must not repeat after the restart.");

  // Concurrent evaluation shares one tick: still exactly one restart.
  state.clockMs = due + 6 * HOUR_MS + 1000;
  await Promise.all([service.runDueSchedules(), service.runDueSchedules()]);
  assert.strictEqual(state.restarts.length, 2, "A second due restart fires once even under concurrent ticks.");

  // --- 3. Cold-start fallback: overdue tick still warns before restarting --
  state.running.add("server-c");
  const cold = await service.createRestartSchedule({ instanceId: "server-c", intervalHours: 1, warnMinutes: 5 });
  const coldDue = Date.parse(cold.schedule.nextRunAt);
  state.clockMs = coldDue + 2 * HOUR_MS;
  await service.runDueSchedules();
  const coldWarns = warnLogFor("server-c");
  assert.strictEqual(coldWarns.length, 2, "An overdue tick must deliver both warnings before restarting.");
  assert(/5 minute/.test(coldWarns[0].message) && /1 minute/.test(coldWarns[1].message));
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-c").length, 1);

  // --- 4. Short warn window: warnMinutes=1 sends only the one-minute warn --
  state.running.add("server-e");
  const tight = await service.createRestartSchedule({ instanceId: "server-e", intervalHours: 2, warnMinutes: 1 });
  const tightDue = Date.parse(tight.schedule.nextRunAt);
  state.clockMs = tightDue - 30 * 1000;
  await service.runDueSchedules();
  const tightWarns = warnLogFor("server-e");
  assert.strictEqual(tightWarns.length, 1, "A one-minute warn window must only send the short warning.");
  assert(/1 minute/.test(tightWarns[0].message));
  state.clockMs = tightDue + 1000;
  await service.runDueSchedules();
  assert.strictEqual(warnLogFor("server-e").length, 1, "The short warning must not repeat at the restart tick.");
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-e").length, 1);

  // --- 5. A stopped instance is skipped, never started ---------------------
  const stopped = await service.createRestartSchedule({ instanceId: "server-d", intervalHours: 1, warnMinutes: 5 });
  const stoppedDue = Date.parse(stopped.schedule.nextRunAt);
  state.clockMs = stoppedDue + 1000;
  await service.runDueSchedules();
  const stoppedRecord = (await service.listRestartSchedules("server-d")).schedules[0];
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-d").length, 0, "Stopped instances must not be restarted.");
  assert.strictEqual(warnLogFor("server-d").length, 0, "Stopped instances must not be warned.");
  assert.strictEqual(stoppedRecord.skipReason, "INSTANCE_NOT_RUNNING");
  assert(stoppedRecord.skippedAt, "The skip must be recorded.");
  assert.strictEqual(Date.parse(stoppedRecord.nextRunAt), stoppedDue + HOUR_MS, "Skipped schedules keep their cadence.");

  state.clockMs = stoppedDue + HOUR_MS + 1000;
  await service.runDueSchedules();
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-d").length, 0, "The skip must not retry as a restart.");

  // --- 6. Disabled schedules never fire ------------------------------------
  const dormant = await service.createRestartSchedule({ instanceId: "server-f", intervalHours: 1, warnMinutes: 5, enabled: false });
  const dormantNext = Date.parse(dormant.schedule.nextRunAt);
  state.clockMs = dormantNext + 5 * HOUR_MS;
  await service.runDueSchedules();
  const dormantRecord = (await service.listRestartSchedules("server-f")).schedules[0];
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-f").length, 0);
  assert.strictEqual(warnLogFor("server-f").length, 0);
  assert.strictEqual(Date.parse(dormantRecord.nextRunAt), dormantNext, "Disabled schedules are left untouched.");

  // --- 7. Tick-vs-CRUD merge (Y1): a create/update/delete committed while the
  // tick is executing a restart must survive the tick's final write ----------
  state.running.add("server-g");
  const mergeTarget = await service.createRestartSchedule({ instanceId: "server-g", intervalHours: 1, warnMinutes: 5 });
  const mergeDue = Date.parse(mergeTarget.schedule.nextRunAt);
  // A second due schedule deleted mid-tick must NOT be resurrected by the
  // snapshot write.
  const mergeDeleteTarget = await service.createRestartSchedule({ instanceId: "server-g2", intervalHours: 1, warnMinutes: 5 });
  state.onRestart = async () => {
    await service.createRestartSchedule({ instanceId: "server-h", intervalHours: 2, warnMinutes: 5 });
    await service.updateRestartSchedule(mergeTarget.schedule.id, { enabled: false });
    await service.deleteRestartSchedule(mergeDeleteTarget.schedule.id);
  };
  state.clockMs = mergeDue + 1000;
  await service.runDueSchedules();
  const mergedList = (await service.listRestartSchedules()).schedules;
  assert(mergedList.some((schedule) => schedule.instanceId === "server-h"), "A schedule created mid-tick must not be clobbered by the tick write.");
  const mergedTarget = mergedList.find((schedule) => schedule.id === mergeTarget.schedule.id);
  assert(mergedTarget.lastRunAt, "The tick must still record the restart it performed on the evaluated schedule.");
  assert.strictEqual(mergedTarget.enabled, false, "A concurrent disable must win over the tick's stale structural snapshot.");
  assert.strictEqual(Date.parse(mergedTarget.nextRunAt), mergeDue + HOUR_MS, "The tick must still own nextRunAt on an evaluated schedule.");
  assert(!mergedList.some((schedule) => schedule.id === mergeDeleteTarget.schedule.id), "A schedule deleted mid-tick must stay deleted (no resurrection).");

  // --- 8. Busy-instance skip (Y2): a non-terminal durable job blocks the
  // restart, a terminal job does not, and cadence is preserved --------------
  state.running.add("server-i");
  const busy = await service.createRestartSchedule({ instanceId: "server-i", intervalHours: 2, warnMinutes: 5 });
  const busyDue = Date.parse(busy.schedule.nextRunAt);
  state.jobsByInstance.set("server-i", [
    { id: "job_00000000000000000000000000000001", type: "instance.update", state: "succeeded" },
  ]);
  state.clockMs = busyDue + 1000;
  await service.runDueSchedules();
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-i").length, 1, "A terminal job must not block the restart.");
  const afterTerminal = (await service.listRestartSchedules("server-i")).schedules[0];
  assert.strictEqual(Date.parse(afterTerminal.nextRunAt), busyDue + 2 * HOUR_MS);

  // Non-terminal job: the due cycle is skipped, not queued behind the job.
  const busyDue2 = Date.parse(afterTerminal.nextRunAt);
  state.jobsByInstance.set("server-i", [
    { id: "job_00000000000000000000000000000002", type: "instance.steamcmdUpdate", state: "running" },
  ]);
  state.clockMs = busyDue2 + 1000;
  await service.runDueSchedules();
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-i").length, 1, "A busy instance must not be restarted.");
  const busyRecord = (await service.listRestartSchedules("server-i")).schedules[0];
  assert.strictEqual(busyRecord.skipReason, service.SKIP_REASON.INSTANCE_BUSY);
  assert(busyRecord.skippedAt, "The busy skip must be recorded.");
  assert(/instance\.steamcmdUpdate/.test(busyRecord.lastError || ""), "The blocking job type must be recorded.");
  assert(/job_00000000000000000000000000000002/.test(busyRecord.lastError || ""), "The blocking job id must be recorded.");
  assert.strictEqual(Date.parse(busyRecord.nextRunAt), busyDue2 + 2 * HOUR_MS, "A busy skip must keep cadence.");

  // The job clears: the next due cycle restarts normally, proving the skipped
  // restart was not quietly queued and fired late.
  state.jobsByInstance.set("server-i", []);
  const busyDue3 = Date.parse(busyRecord.nextRunAt);
  state.clockMs = busyDue3 + 1000;
  await service.runDueSchedules();
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-i").length, 2, "The next free cycle must restart normally.");

  // --- 9. Job-query failure is fail-closed (skip + record + keep cadence) ---
  state.running.add("server-k");
  const fault = await service.createRestartSchedule({ instanceId: "server-k", intervalHours: 3, warnMinutes: 5 });
  const faultDue = Date.parse(fault.schedule.nextRunAt);
  const queryError = new Error("JOB_STORE_READ_FAILED");
  queryError.code = "JOB_STORE_READ_FAILED";
  state.jobQueryError = queryError;
  state.clockMs = faultDue + 1000;
  await service.runDueSchedules();
  assert.strictEqual(state.restarts.filter((entry) => entry.instanceId === "server-k").length, 0, "A failed job query must not restart the instance.");
  const faultRecord = (await service.listRestartSchedules("server-k")).schedules[0];
  assert.strictEqual(faultRecord.skipReason, service.SKIP_REASON.JOB_QUERY_FAILED);
  assert.strictEqual(faultRecord.lastError, "JOB_STORE_READ_FAILED");
  assert.strictEqual(Date.parse(faultRecord.nextRunAt), faultDue + 3 * HOUR_MS, "A fail-closed skip must keep cadence.");
  state.jobQueryError = null;

  // --- 10. Route layer: REST contract over the same service ----------------
  const routeRequest = (method, pathname, body = null) => handleInstances(
    { method, body: body === null ? undefined : JSON.stringify(body) },
    { pathname, searchParams: new URLSearchParams() },
  );

  const createResponse = await routeRequest("POST", "/api/v1/instances/server-a/restart-schedules", {
    type: "interval",
    intervalHours: 12,
    warnMinutes: 15,
  });
  assert.strictEqual(createResponse.statusCode, 201, "Create route must answer 201.");
  const routeSchedule = createResponse.body.schedule;
  assert.strictEqual(routeSchedule.instanceId, "server-a");
  assert.strictEqual(routeSchedule.intervalHours, 12);

  const listResponse = await routeRequest("GET", "/api/v1/instances/server-a/restart-schedules");
  assert.strictEqual(listResponse.statusCode, 200);
  assert(listResponse.body.schedules.some((schedule) => schedule.id === routeSchedule.id), "List route must include the created schedule.");

  const updateResponse = await routeRequest("PATCH", `/api/v1/instances/server-a/restart-schedules/${routeSchedule.id}`, { enabled: false });
  assert.strictEqual(updateResponse.statusCode, 200);
  assert.strictEqual(updateResponse.body.schedule.enabled, false);

  const evaluateResponse = await routeRequest("POST", "/api/v1/instances/server-a/restart-schedules/evaluate");
  assert.strictEqual(evaluateResponse.statusCode, 200);
  assert(Number.isInteger(evaluateResponse.body.evaluated), "Evaluate route must report the evaluated schedule count.");

  const deleteResponse = await routeRequest("DELETE", `/api/v1/instances/server-a/restart-schedules/${routeSchedule.id}`);
  assert.strictEqual(deleteResponse.statusCode, 200);
  assert.strictEqual(deleteResponse.body.deleted, true);

  const missingResponse = await routeRequest("GET", "/api/v1/instances/server-a/restart-schedules");
  assert.strictEqual(missingResponse.statusCode, 200);
  assert(Array.isArray(missingResponse.body.schedules));

  const invalidResponse = await routeRequest("POST", "/api/v1/instances/bad%20id/restart-schedules", { intervalHours: 2 });
  assert.strictEqual(invalidResponse.statusCode, 400);
  assert.strictEqual(invalidResponse.body.error.code, "INVALID_INSTANCE_ID");

  const notFoundResponse = await routeRequest("DELETE", `/api/v1/instances/server-a/restart-schedules/${routeSchedule.id}`);
  assert.strictEqual(notFoundResponse.statusCode, 404);
  assert.strictEqual(notFoundResponse.body.error.code, "RESTART_SCHEDULE_NOT_FOUND");

  // Cross-instance scope guard (P1 review finding): a schedule belonging to
  // server-b must not be retimed or deleted through server-a's path, even
  // though the caller's permissions cover server-a.
  const otherCreate = await routeRequest("POST", "/api/v1/instances/server-b/restart-schedules", { intervalHours: 3 });
  assert.strictEqual(otherCreate.statusCode, 201);
  const otherSchedule = otherCreate.body.schedule;
  const crossUpdate = await routeRequest("PATCH", `/api/v1/instances/server-a/restart-schedules/${otherSchedule.id}`, { enabled: false });
  assert.strictEqual(crossUpdate.statusCode, 404, "Another instance's schedule must not be reachable through this instance's path.");
  const crossDelete = await routeRequest("DELETE", `/api/v1/instances/server-a/restart-schedules/${otherSchedule.id}`);
  assert.strictEqual(crossDelete.statusCode, 404, "Another instance's schedule must not be deletable through this instance's path.");
  const otherStillThere = await routeRequest("GET", "/api/v1/instances/server-b/restart-schedules");
  assert(otherStillThere.body.schedules.some((schedule) => schedule.id === otherSchedule.id && schedule.enabled !== false), "The out-of-scope schedule must be untouched.");
  const otherDelete = await routeRequest("DELETE", `/api/v1/instances/server-b/restart-schedules/${otherSchedule.id}`);
  assert.strictEqual(otherDelete.statusCode, 200, "The owning instance's path must still delete its own schedule.");

  service.stopRestartScheduler();
  console.log("restart-schedule-smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
