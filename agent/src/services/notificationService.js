// Server alerts: the Agent posts selected events (crashes, scheduled restarts,
// SteamCMD updates) to one Discord or generic HTTPS webhook per node.
//
// The webhook URL carries its own credential (Discord's token is part of the
// path), so it is stored mode 0600 next to the other Agent stores and is never
// returned: reads report only a masked hint. Delivery is fire-and-forget with a
// short timeout and per-event rate limits, so an unreachable webhook can never
// slow down or block an instance lifecycle action.

const fs = require("fs/promises");
const https = require("https");
const net = require("net");
const path = require("path");

const { getConfig } = require("../config");

const NOTIFICATION_SCHEMA_VERSION = 1;
const NOTIFICATION_EVENTS = Object.freeze([
  "instance.crashed",
  "restart.scheduled.completed",
  "restart.scheduled.failed",
  "update.succeeded",
  "update.failed",
]);
const DEFAULT_EVENTS = Object.freeze(["instance.crashed", "restart.scheduled.failed", "update.succeeded", "update.failed"]);
const DELIVERY_TIMEOUT_MS = 5000;
const MAX_URL_LENGTH = 2048;
const MAX_MESSAGE_LENGTH = 1800;
// At most one message per event and instance per minute, and a node-wide cap,
// so a crash loop cannot flood a channel.
const PER_KEY_INTERVAL_MS = 60 * 1000;
const GLOBAL_LIMIT_PER_MINUTE = 20;
const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

let configuredRoot = null;
let transport = null;
let clock = () => Date.now();
const lastSentByKey = new Map();
let recentSends = [];
let lastDelivery = null;
const pendingDeliveries = new Set();

function createNotificationError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

// Test seams: a temp root, a fake transport (no network) and a clock.
function configureNotificationService(overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, "root")) configuredRoot = overrides.root ? path.resolve(overrides.root) : null;
  if (Object.prototype.hasOwnProperty.call(overrides, "transport")) transport = overrides.transport || null;
  if (Object.prototype.hasOwnProperty.call(overrides, "now")) clock = overrides.now || (() => Date.now());
  if (overrides.reset) {
    lastSentByKey.clear();
    recentSends = [];
    lastDelivery = null;
  }
}

function getRoot() {
  if (configuredRoot) return configuredRoot;
  return path.resolve(process.env.AGENT_NOTIFICATION_ROOT || path.join(path.dirname(getConfig().instanceRoot), "notifications"));
}

function settingsPath() {
  return path.join(getRoot(), "webhook.json");
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), "utf8"));
    if (Number(parsed?.schemaVersion) > NOTIFICATION_SCHEMA_VERSION) throw createNotificationError("NOTIFICATION_SCHEMA_UNSUPPORTED", 409);
    return {
      url: typeof parsed?.url === "string" ? parsed.url : null,
      enabled: parsed?.enabled !== false,
      events: Array.isArray(parsed?.events) ? parsed.events.filter((event) => NOTIFICATION_EVENTS.includes(event)) : [...DEFAULT_EVENTS],
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { url: null, enabled: true, events: [...DEFAULT_EVENTS], updatedAt: null };
    if (error?.code === "NOTIFICATION_SCHEMA_UNSUPPORTED") throw error;
    throw createNotificationError("NOTIFICATION_STORE_CORRUPT", 500);
  }
}

async function writeSettings(settings) {
  await fs.mkdir(getRoot(), { recursive: true, mode: 0o700 });
  const target = settingsPath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: NOTIFICATION_SCHEMA_VERSION, ...settings }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
}

// HTTPS only, a DNS host name (no IP literals, no localhost), no embedded
// credentials. This keeps the webhook from being pointed at the Agent's own
// host or local network services.
function validateWebhookUrl(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_URL_LENGTH) throw createNotificationError("NOTIFICATION_WEBHOOK_INVALID");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw createNotificationError("NOTIFICATION_WEBHOOK_INVALID");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw createNotificationError("NOTIFICATION_WEBHOOK_INVALID");
  if (!host || net.isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".")) {
    throw createNotificationError("NOTIFICATION_WEBHOOK_HOST_NOT_ALLOWED");
  }
  return parsed.toString();
}

function maskWebhookUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/…`;
  } catch {
    return "configured";
  }
}

function publicSettings(settings) {
  return {
    configured: Boolean(settings.url),
    urlHint: maskWebhookUrl(settings.url),
    format: settings.url && DISCORD_HOSTS.has(new URL(settings.url).hostname.toLowerCase()) ? "discord" : settings.url ? "generic" : null,
    enabled: settings.enabled,
    events: settings.events,
    availableEvents: [...NOTIFICATION_EVENTS],
    updatedAt: settings.updatedAt,
    lastDelivery,
  };
}

async function getNotificationSettings() {
  return publicSettings(await readSettings());
}

async function saveNotificationSettings(payload = {}) {
  const current = await readSettings();
  const next = { ...current };
  if (payload.url !== undefined) next.url = payload.url === null || payload.url === "" ? null : validateWebhookUrl(payload.url);
  if (payload.enabled !== undefined) next.enabled = payload.enabled !== false;
  if (payload.events !== undefined) {
    if (!Array.isArray(payload.events) || payload.events.some((event) => !NOTIFICATION_EVENTS.includes(event))) {
      throw createNotificationError("NOTIFICATION_EVENTS_INVALID");
    }
    next.events = [...new Set(payload.events)];
  }
  next.updatedAt = new Date(clock()).toISOString();
  await writeSettings(next);
  return publicSettings(next);
}

function buildBody(url, event, details) {
  const message = String(details.message || event).slice(0, MAX_MESSAGE_LENGTH);
  const at = new Date(clock()).toISOString();
  if (DISCORD_HOSTS.has(new URL(url).hostname.toLowerCase())) {
    // allowed_mentions: none, so instance names can never ping a channel.
    return { username: "AnxOS", content: message, allowed_mentions: { parse: [] } };
  }
  return { source: "anxos-agent", event, instanceId: details.instanceId || null, message, at };
}

function postJson(url, body) {
  if (transport) return transport(url, body);
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = https.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": payload.length, "user-agent": "AnxOS-Agent" },
      timeout: DELIVERY_TIMEOUT_MS,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode }));
    });
    request.once("timeout", () => request.destroy(createNotificationError("NOTIFICATION_DELIVERY_TIMEOUT", 504)));
    request.once("error", reject);
    request.end(payload);
  });
}

async function deliver(url, event, details) {
  const at = new Date(clock()).toISOString();
  try {
    const response = await postJson(url, buildBody(url, event, details));
    const ok = Number(response?.status) >= 200 && Number(response?.status) < 300;
    lastDelivery = { at, event, ok, status: Number(response?.status) || null, error: ok ? null : "NOTIFICATION_DELIVERY_REJECTED" };
  } catch (error) {
    lastDelivery = { at, event, ok: false, status: null, error: error?.code || "NOTIFICATION_DELIVERY_FAILED" };
  }
  return lastDelivery;
}

function allowSend(key) {
  const atMs = clock();
  recentSends = recentSends.filter((sentAt) => atMs - sentAt < 60 * 1000);
  if (recentSends.length >= GLOBAL_LIMIT_PER_MINUTE) return false;
  if (atMs - (lastSentByKey.get(key) || -Infinity) < PER_KEY_INTERVAL_MS) return false;
  lastSentByKey.set(key, atMs);
  recentSends.push(atMs);
  return true;
}

// Alerts are handled one after another in the order they were raised, so the
// rate limit always keeps the first alert of a burst (a concurrent settings
// read could otherwise let a later one finish first and take the slot).
let notifyQueue = Promise.resolve();

// Never throws and never waits for the network: callers are lifecycle paths.
function notify(event, details = {}) {
  if (!NOTIFICATION_EVENTS.includes(event)) return;
  const delivery = notifyQueue.then(async () => {
    const settings = await readSettings().catch(() => null);
    if (!settings?.url || !settings.enabled || !settings.events.includes(event)) return;
    if (!allowSend(`${event}:${details.instanceId || "node"}`)) return;
    await deliver(settings.url, event, details);
  }).catch(() => {});
  notifyQueue = delivery;
  pendingDeliveries.add(delivery);
  delivery.finally(() => pendingDeliveries.delete(delivery));
}

async function sendTestNotification() {
  const settings = await readSettings();
  if (!settings.url) throw createNotificationError("NOTIFICATION_WEBHOOK_NOT_CONFIGURED", 409);
  return { delivery: await deliver(settings.url, "test", { message: "AnxOS test alert: this webhook will receive server alerts from this node." }) };
}

// Test seam: settle fire-and-forget deliveries.
async function flushNotifications() {
  await Promise.all([...pendingDeliveries]);
}

module.exports = {
  NOTIFICATION_EVENTS,
  configureNotificationService,
  flushNotifications,
  getNotificationSettings,
  notify,
  saveNotificationSettings,
  sendTestNotification,
  validateWebhookUrl,
};
