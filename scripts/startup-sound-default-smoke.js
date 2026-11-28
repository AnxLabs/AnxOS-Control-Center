// Build 217: the startup sound is off by default, and a saved choice is kept.
// Playing the sound starts Chromium's audio service (about 84 MB), which stays
// for the whole session, so a new install must stay silent until the user
// turns the sound on. An upgrade must never change a value the user saved.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.join(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxhost-startup-sound-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
const prefs = require("../src/services/settingsPreferenceService");

function writeSettingsFile(settings) {
  fs.mkdirSync(path.dirname(prefs.getSettingsPath()), { recursive: true });
  fs.writeFileSync(prefs.getSettingsPath(), JSON.stringify({ schemaVersion: prefs.SETTINGS_SCHEMA_VERSION, settings }));
}

// Pulls one top-level function or const out of app.js so the renderer's real
// code is tested, not a copy of it.
const appSource = fs.readFileSync(path.join(repo, "app.js"), "utf8");
function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert(start >= 0, `app.js should define ${name}`);
  let depth = 0;
  for (let index = appSource.indexOf("{", start); index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] === "}") {
      depth -= 1;
      if (depth === 0) return appSource.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}
function extractDefaultSettings() {
  const start = appSource.indexOf("const DEFAULT_SETTINGS = {");
  assert(start >= 0, "app.js should define DEFAULT_SETTINGS");
  const end = appSource.indexOf("\n};", start);
  // Only the startup keys matter here; other values reference constants.
  const body = appSource.slice(start, end).split(/\r?\n/).filter((line) => /"startup\.sound(Volume)?"/.test(line)).join("\n");
  return `const DEFAULT_SETTINGS = {\n${body}\n};`;
}

function rendererWith(stored) {
  const storage = new Map();
  if (stored !== undefined) storage.set("anxos.settings.v1", JSON.stringify(stored));
  const sandbox = {
    window: { localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null) } },
    SETTINGS_STORAGE_KEY: "anxos.settings.v1",
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractDefaultSettings()}\n${extractFunction("readStoredSettings")}\n${extractFunction("isStartupSoundEnabled")}\nthis.isStartupSoundEnabled = isStartupSoundEnabled;`, sandbox);
  return sandbox.isStartupSoundEnabled();
}

const results = [];
function check(id, label, fn) {
  fn();
  results.push(id);
  console.log(`${id} ${label}`);
}

try {
  check("SS1", "a new install has the startup sound off (main process)", () => {
    const fresh = prefs.readPreferences();
    assert.strictEqual(fresh.settings["startup.sound"], false);
    assert.strictEqual(prefs.SETTING_DEFINITIONS["startup.sound"].default, false);
  });

  check("SS2", "a saved 'on' survives the upgrade (main process)", () => {
    writeSettingsFile({ "startup.sound": true, "startup.soundVolume": 70 });
    const read = prefs.readPreferences();
    assert.strictEqual(read.settings["startup.sound"], true);
    assert.strictEqual(read.settings["startup.soundVolume"], 70);
    const onDisk = JSON.parse(fs.readFileSync(prefs.getSettingsPath(), "utf8"));
    assert.strictEqual(onDisk.settings["startup.sound"], true, "reading must not rewrite a saved choice");
  });

  check("SS3", "a saved 'off' stays off, and the user can still turn it on", () => {
    writeSettingsFile({ "startup.sound": false });
    assert.strictEqual(prefs.readPreferences().settings["startup.sound"], false);
    const saved = prefs.updatePreferences({ "startup.sound": true });
    assert.strictEqual(saved.settings["startup.sound"], true);
    assert.strictEqual(prefs.readPreferences().settings["startup.sound"], true);
  });

  check("SS4", "a settings file without the key uses the new default; the legacy key is honoured", () => {
    writeSettingsFile({ "interface.guidedMode": false });
    assert.strictEqual(prefs.readPreferences().settings["startup.sound"], false);
    fs.writeFileSync(prefs.getSettingsPath(), JSON.stringify({ "general.startupSound": true }));
    assert.strictEqual(prefs.readPreferences().settings["startup.sound"], true);
  });

  check("SS5", "the startup screen plays nothing unless the saved value is on (renderer)", () => {
    assert.strictEqual(rendererWith(undefined), false, "first launch");
    assert.strictEqual(rendererWith({}), false, "empty saved settings");
    assert.strictEqual(rendererWith({ "interface.guidedMode": false }), false, "settings without the key");
    assert.strictEqual(rendererWith({ "startup.sound": true }), true, "saved on");
    assert.strictEqual(rendererWith({ "startup.sound": false }), false, "saved off");
    assert.strictEqual(rendererWith({ "general.startupSound": true }), true, "legacy key on");
    assert.strictEqual(rendererWith({ "startup.sound": "yes" }), false, "a non-boolean value is not 'on'");
  });

  check("SS6", "the audio element does not load before the sound is played; the toggle is still in Settings", () => {
    const html = fs.readFileSync(path.join(repo, "index.html"), "utf8");
    const audio = html.match(/<audio[^>]*data-startup-audio[^>]*>/);
    assert(audio, "index.html should keep the startup audio element");
    assert.match(audio[0], /preload="none"/);
    assert.match(html, /data-setting="startup\.sound"/);
    assert.match(html, /data-setting="startup\.soundVolume"/);
  });

  console.log(`startup-sound-default smoke passed (${results.length} checks).`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
