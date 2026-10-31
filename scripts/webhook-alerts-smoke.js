// Server alerts: the Agent posts crash, scheduled restart and update events to
// one Discord/HTTPS webhook per node. Hermetic: a fake transport replaces the
// network, a real Node workload crashes, and the real scheduler runs.
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-webhook-alerts-"));
const instanceRoot = path.join(base, "instances");
fs.mkdirSync(instanceRoot, { recursive: true });
process.env.AGENT_INSTANCE_ROOT = instanceRoot;
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);

const notifications = require("../agent/src/services/notificationService");
const instanceService = require("../agent/src/services/instances/instanceService");
const scheduleService = require("../agent/src/services/restartScheduleService");
const { handleNotifications } = require("../agent/src/routes/notifications");

const DISCORD_URL = "https://discord.com/api/webhooks/123456/SECRET-TOKEN-abc";
const sent = [];
let clockMs = Date.parse("2026-10-31T12:00:00Z");
let transportStatus = 204;
notifications.configureNotificationService({
  root: path.join(base, "notifications"),
  now: () => clockMs,
  reset: true,
  transport: async (url, body) => {
    sent.push({ url, body });
    if (transportStatus instanceof Error) throw transportStatus;
    return { status: transportStatus };
  },
});

async function validationChecks() {
  for (const [url, code] of [
    ["http://discord.com/api/webhooks/1/x", "NOTIFICATION_WEBHOOK_INVALID"],
    ["https://user:pass@example.com/hook", "NOTIFICATION_WEBHOOK_INVALID"],
    ["https://127.0.0.1/hook", "NOTIFICATION_WEBHOOK_HOST_NOT_ALLOWED"],
    ["https://[::1]/hook", "NOTIFICATION_WEBHOOK_HOST_NOT_ALLOWED"],
    ["https://localhost/hook", "NOTIFICATION_WEBHOOK_HOST_NOT_ALLOWED"],
    ["https://nas.local/hook", "NOTIFICATION_WEBHOOK_HOST_NOT_ALLOWED"],
    ["https://intranet/hook", "NOTIFICATION_WEBHOOK_HOST_NOT_ALLOWED"],
    ["file:///etc/passwd", "NOTIFICATION_WEBHOOK_INVALID"],
  ]) {
    await assert.rejects(notifications.saveNotificationSettings({ url }), (error) => error.code === code, `Refused: ${url}`);
  }
  await assert.rejects(notifications.saveNotificationSettings({ events: ["instance.crashed", "rm -rf"] }), (error) => error.code === "NOTIFICATION_EVENTS_INVALID");
  await assert.rejects(notifications.sendTestNotification(), (error) => error.code === "NOTIFICATION_WEBHOOK_NOT_CONFIGURED");
}

async function settingsChecks() {
  const saved = await notifications.saveNotificationSettings({ url: DISCORD_URL, events: ["instance.crashed", "update.failed", "restart.scheduled.completed"] });
  assert.strictEqual(saved.configured, true);
  assert.strictEqual(saved.format, "discord");
  assert.strictEqual(saved.urlHint, "https://discord.com/…");
  const read = await notifications.getNotificationSettings();
  assert(!JSON.stringify(read).includes("SECRET-TOKEN") && !JSON.stringify(read).includes("123456"), "Reads never return the webhook URL or its token.");
  const routeRead = await handleNotifications({ method: "GET" }, new URL("http://agent/api/v1/notifications/webhook"));
  assert.strictEqual(routeRead.statusCode, 200);
  assert(!JSON.stringify(routeRead.body).includes("SECRET-TOKEN"), "The REST read is masked too.");
  const stored = fs.readFileSync(path.join(base, "notifications", "webhook.json"), "utf8");
  assert(stored.includes("SECRET-TOKEN"), "The Agent keeps the URL in its own store.");
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(path.join(base, "notifications", "webhook.json")).mode & 0o777, 0o600, "The store is readable only by the Agent user.");
  }
  const kept = await notifications.saveNotificationSettings({ enabled: true });
  assert.strictEqual(kept.configured, true, "Saving without a URL keeps the stored webhook.");

  const test = await notifications.sendTestNotification();
  assert.strictEqual(test.delivery.ok, true);
  assert.deepStrictEqual(sent.at(-1).body.allowed_mentions, { parse: [] }, "Discord messages can never ping anyone.");
  assert.strictEqual(sent.at(-1).url, DISCORD_URL);
}

async function notifyChecks() {
  sent.length = 0;
  notifications.notify("update.succeeded", { instanceId: "a", message: "not selected" });
  notifications.notify("update.failed", { instanceId: "a", message: "AnxOS: update failed" });
  notifications.notify("update.failed", { instanceId: "a", message: "again within a minute" });
  notifications.notify("made.up", { instanceId: "a" });
  await notifications.flushNotifications();
  assert.deepStrictEqual(sent.map((entry) => entry.body.content), ["AnxOS: update failed"], "Only selected events are sent, once per minute per instance.");
  clockMs += 61 * 1000;
  notifications.notify("update.failed", { instanceId: "a", message: "after a minute" });
  await notifications.flushNotifications();
  assert.strictEqual(sent.length, 2);

  transportStatus = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
  clockMs += 61 * 1000;
  notifications.notify("update.failed", { instanceId: "a", message: "unreachable" });
  await notifications.flushNotifications();
  assert.deepStrictEqual({ ok: (await notifications.getNotificationSettings()).lastDelivery.ok, error: (await notifications.getNotificationSettings()).lastDelivery.error }, { ok: false, error: "ECONNREFUSED" }, "Delivery failures are recorded, never thrown.");
  transportStatus = 204;

  await notifications.saveNotificationSettings({ enabled: false });
  clockMs += 61 * 1000;
  sent.length = 0;
  notifications.notify("update.failed", { instanceId: "a", message: "paused" });
  await notifications.flushNotifications();
  assert.strictEqual(sent.length, 0, "Paused alerts send nothing.");
  await notifications.saveNotificationSettings({ enabled: true });

  await notifications.saveNotificationSettings({ url: "https://hooks.example.com/anxos" });
  clockMs += 61 * 1000;
  notifications.notify("instance.crashed", { instanceId: "b", message: "generic" });
  await notifications.flushNotifications();
  assert.deepStrictEqual({ source: sent.at(-1).body.source, event: sent.at(-1).body.event, instanceId: sent.at(-1).body.instanceId }, { source: "anxos-agent", event: "instance.crashed", instanceId: "b" }, "Non-Discord webhooks get a JSON event.");
}

async function crashEventChecks() {
  sent.length = 0;
  clockMs += 61 * 1000;
  await instanceService.createInstance({ id: "crashy", displayName: "Crashy Server", type: "custom-command", executable: process.execPath, args: ["-e", "console.log('Server started'); setTimeout(() => process.exit(3), 300)"], startupTimeoutMs: 10000 });
  await instanceService.startInstance("crashy");
  for (let attempt = 0; attempt < 80 && !sent.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await notifications.flushNotifications();
  }
  assert.strictEqual(sent.length, 1, "An unexpected exit raises a crash alert.");
  assert.strictEqual(sent[0].body.event, "instance.crashed");
  assert.match(sent[0].body.message, /Crashy Server stopped unexpectedly \(exit code 3/);

  sent.length = 0;
  clockMs += 61 * 1000;
  await instanceService.createInstance({ id: "calm", displayName: "Calm", type: "custom-command", executable: process.execPath, args: ["-e", "console.log('Server started'); setInterval(() => {}, 1000)"], startupTimeoutMs: 10000, shutdownTimeoutMs: 5000 });
  await instanceService.startInstance("calm");
  await instanceService.stopInstance("calm", { timeoutMs: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await notifications.flushNotifications();
  assert.strictEqual(sent.length, 0, "A requested stop is not a crash.");
}

async function scheduleEventChecks() {
  sent.length = 0;
  clockMs += 61 * 1000;
  scheduleService.configureRestartScheduleService({
    root: path.join(base, "schedules"),
    now: () => clockMs,
    isInstanceRunning: async () => true,
    warnInstance: async () => {},
    listInstanceJobs: async () => ({ jobs: [] }),
    restartInstance: async () => ({}),
  });
  await notifications.saveNotificationSettings({ events: ["restart.scheduled.completed"] });
  const schedule = (await scheduleService.createRestartSchedule({ instanceId: "calm", intervalHours: 1, warnMinutes: 1 })).schedule;
  clockMs = Date.parse(schedule.nextRunAt) + 1000;
  await scheduleService.runDueSchedules();
  await notifications.flushNotifications();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].body.message, /scheduled restart of calm completed/);
}

function contractChecks() {
  const server = fs.readFileSync("agent/src/server.js", "utf8");
  assert(server.includes('return method === "GET" ? "system:read" : "agent:manage";'), "Alert writes need agent:manage.");
  const ipc = fs.readFileSync("src/ipc/webhookAlertsIpc.js", "utf8");
  assert(ipc.includes('requirePermission("settings:write", payload.nodeId);') && !/audit\([^)]*url:/.test(ipc), "Desktop writes are settings:write and never audit the URL.");
  const ui = fs.readFileSync("app.js", "utf8");
  assert(ui.includes('elements.url.value = "";'), "The URL field is never refilled from the Agent.");
  assert(fs.readFileSync("index.html", "utf8").includes('type="password" autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/..." data-webhook-alerts-url'));
}

async function main() {
  await validationChecks();
  await settingsChecks();
  await notifyChecks();
  await crashEventChecks();
  await scheduleEventChecks();
  contractChecks();
  await instanceService.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  console.log("Webhook alerts smoke checks passed.");
}

main().catch(async (error) => {
  console.error(error);
  await instanceService.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  process.exit(1);
});
