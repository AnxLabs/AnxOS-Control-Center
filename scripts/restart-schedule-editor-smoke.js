// Restart schedule editor: one dialog for create and edit, validated against
// the Agent's schedule contract, and an Edit action that retimes an existing
// schedule through the Agent. The validator is executed verbatim from app.js.
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

function validatorChecks() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunction("validateRestartScheduleForm")}\nthis.validate = validateRestartScheduleForm;`, context);
  const { validate } = context;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(plain(validate({ type: "interval", intervalHours: "6", warnMinutes: "10" })), { type: "interval", intervalHours: 6, warnMinutes: 10 });
  assert.deepStrictEqual(plain(validate({ type: "daily", dailyTime: "04:30", warnMinutes: "5", autoUpdateSteam: true })), { type: "daily", dailyTime: "04:30", warnMinutes: 5, autoUpdateSteam: true });
  assert.deepStrictEqual(plain(validate({ type: "interval", intervalHours: 1, warnMinutes: 1, autoUpdateSteam: false })).autoUpdateSteam, false, "An unchecked auto-update box is sent as false.");
  assert.strictEqual("autoUpdateSteam" in plain(validate({ type: "interval", intervalHours: 1, warnMinutes: 1 })), false, "Non-SteamCMD instances never send the auto-update field.");
  for (const [input, pattern] of [
    [{ type: "interval", intervalHours: "0", warnMinutes: "5" }, /1 to 720/],
    [{ type: "interval", intervalHours: "721", warnMinutes: "5" }, /1 to 720/],
    [{ type: "interval", intervalHours: "2.5", warnMinutes: "5" }, /whole number/],
    [{ type: "daily", dailyTime: "24:00", warnMinutes: "5" }, /HH:MM/],
    [{ type: "daily", dailyTime: "", warnMinutes: "5" }, /HH:MM/],
    [{ type: "interval", intervalHours: "4", warnMinutes: "0" }, /1 to 1440/],
    [{ type: "interval", intervalHours: "4", warnMinutes: "1441" }, /1 to 1440/],
  ]) {
    assert.throws(() => validate(input), pattern, `Rejected: ${JSON.stringify(input)}`);
  }
}

async function agentRetimeChecks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-schedule-editor-"));
  process.env.AGENT_INSTANCE_ROOT = root;
  const service = require("../agent/src/services/restartScheduleService");
  let clockMs = Date.parse("2026-10-31T10:00:00Z");
  service.configureRestartScheduleService({ root, now: () => clockMs, isInstanceRunning: async () => true, warnInstance: async () => {}, restartInstance: async () => ({}), listInstanceJobs: async () => ({ jobs: [] }) });
  const created = (await service.createRestartSchedule({ instanceId: "editor-target", intervalHours: 24, warnMinutes: 5 })).schedule;
  clockMs += 60 * 1000;
  const edited = (await service.updateRestartSchedule(created.id, { type: "daily", dailyTime: "04:00", warnMinutes: 15 }, { instanceScope: "editor-target" })).schedule;
  assert.strictEqual(edited.type, "daily");
  assert.strictEqual(edited.intervalHours, null);
  assert.strictEqual(edited.warnMinutes, 15);
  assert.notStrictEqual(edited.nextRunAt, created.nextRunAt, "Editing the timing re-anchors the next run.");
  assert.strictEqual(new Date(edited.nextRunAt).getHours(), 4, "The next run lands on the new daily time.");
  await fsp.rm(root, { recursive: true, force: true });
}

function contractChecks() {
  const configure = extractFunction("configureRestartSchedule");
  const editEntry = extractFunction("editRestartScheduleEntry");
  const render = extractFunction("renderInstanceRestartSchedules");
  assert(configure.includes("createRestartScheduleDialog({ instance: selectedInstance })"), "New schedules use the single dialog.");
  assert(!configure.includes("promptBackupText"), "New schedules no longer chain separate prompts.");
  assert(editEntry.includes("createRestartScheduleDialog({ instance: selectedInstance, schedule })") && editEntry.includes("updateRestartSchedule("), "Edit opens the dialog prefilled and saves through the Agent.");
  assert(render.includes('editButton.textContent = "Edit"') && render.includes("editRestartScheduleEntry(schedule)"), "Each schedule row offers Edit.");
  const dialog = extractFunction("createRestartScheduleDialog");
  assert(dialog.includes("isSteamCmdUpdateInstance(instance)"), "The auto-update option appears only for SteamCMD instances.");
  assert(dialog.includes("activateModal(overlay"), "The dialog uses the shared modal focus handling.");
}

async function main() {
  validatorChecks();
  await agentRetimeChecks();
  contractChecks();
  console.log("Restart schedule editor smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
