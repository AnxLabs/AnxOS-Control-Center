"use strict";

// playit process detection: a process counts as playit only when its own
// image is a playit binary. Shells, editors and scripts whose command lines
// merely mention playit (a path, a config file, a script name) must not.
// Run: node scripts/playit-process-detection-smoke.js

const assert = require("assert");
const { isPlayitProcessImage, filterPlayitCommandLines } = require("../src/services/playitService");

const playit = [
  "playit",
  "playit.exe",
  "PLAYIT.EXE",
  "playitd",
  "playitd.exe",
  "playit-agent",
  "C:\\Program Files\\playit_gg\\bin\\playit.exe",
  "\"C:\\Program Files\\playit_gg\\bin\\playitd.exe\"",
  "/usr/local/bin/playit",
  "/opt/playit/playit-agent",
];
const notPlayit = [
  "",
  null,
  "bash.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "node.exe",
  "powershell.exe",
  "notepad.exe",
  "playit-probe.js",
  "playit.toml",
  "playit_gg",
  "C:\\Program Files\\playit_gg\\uninstall.exe",
  "myplayit.exe",
  "playit.exe.bak",
  "/home/anx/playit.yml",
];

for (const value of playit) assert.strictEqual(isPlayitProcessImage(value), true, `${JSON.stringify(value)} is a playit process image`);
for (const value of notPlayit) assert.strictEqual(isPlayitProcessImage(value), false, `${JSON.stringify(value)} is not a playit process image`);

const pgrepOutput = [
  "1201 /usr/local/bin/playit --secret_path /etc/playit/playit.toml",
  "1302 playitd",
  "1403 nano /etc/playit/playit.toml",
  "1504 bash -c node playit-probe.js",
  "1605 grep playit",
  "1706 /usr/bin/python3 /opt/scripts/check_playit.py",
  "",
].join("\n");
assert.deepStrictEqual(filterPlayitCommandLines(pgrepOutput), [
  "1201 /usr/local/bin/playit --secret_path /etc/playit/playit.toml",
  "1302 playitd",
], "only real playit executables survive the pgrep filter");
assert.deepStrictEqual(filterPlayitCommandLines(""), []);
assert.deepStrictEqual(filterPlayitCommandLines("1504 bash -c node playit-probe.js"), [], "a script mentioning playit is not playit");

console.log("playit process detection smoke passed.");
