#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(rootDir, "preload.js"), "utf8");
const ipcSource = fs.readFileSync(path.join(rootDir, "src", "ipc", "sshIpc.js"), "utf8");
const serviceSource = fs.readFileSync(path.join(rootDir, "src", "services", "sshService.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");

assert(htmlSource.includes("node_modules/@xterm/xterm/lib/xterm.js"), "SSH page must load xterm.");
assert(htmlSource.includes("data-ssh-xterm"), "SSH page must expose an xterm surface inside the terminal window.");
assert(appSource.includes("function ensureSshXterm"), "Renderer must initialize xterm for SSH.");
assert(appSource.includes("function bindSshXtermInput") && appSource.includes("terminal.onData((data) => {") && appSource.includes("writeSshInput(data);"), "xterm onData must send emitted data directly to the active PTY.");
assert(appSource.includes("focusSshTerminalInput") && appSource.includes("window.requestAnimationFrame(focusSshTerminalInput);"), "SSH terminal should focus after a successful connection.");
assert(appSource.includes("sshTerminalWindow?.addEventListener(\"click\"") && appSource.includes("focusSshTerminalInput();"), "Clicking inside SSH should focus the terminal.");
assert(preloadSource.includes("write: (sessionId, input) => {") && preloadSource.includes("recordSshBridgeWrite(sessionId, input);") && preloadSource.includes("return ipcRenderer.invoke(\"ssh:write\", { sessionId, input });"), "Preload must expose SSH input writing.");
assert(ipcSource.includes("registerSshHandler(\"ssh:write\"") && ipcSource.includes("sshService.write(payload.sessionId, payload.input)"), "Main IPC must route SSH input through the SSH domain wrapper to the service.");
assert(ipcSource.includes("ipcMain.handle(channel"), "SSH domain registration must delegate to Electron IPC exactly once.");
assert(serviceSource.includes("session.stream.write(data);"), "SSH service must write input to the active PTY stream.");
assert(serviceSource.includes("client.shell(") && serviceSource.includes('term: "xterm-256color"'), "SSH service must allocate an xterm-compatible PTY.");

[
  "echo hello",
  "\r",
  "sdawdsada",
  "\u007f\u007f\u007f",
  "\t",
  "\u001b[A",
  "\u001b[B",
  "\u001b[C",
  "\u001b[D",
  "\u0003",
  "\u0004",
  "\u000c",
].forEach((data) => {
  assert.strictEqual(typeof data, "string", "Terminal data fixtures must stay raw strings.");
});

assert(!appSource.includes("const arrowMap = {"), "Renderer must not manually reconstruct arrow-key escape sequences.");
assert(!appSource.includes("navigationKeyMap"), "Renderer must not manually reconstruct navigation-key escape sequences.");
assert(!/event\.key\s*===\s*["']Backspace["'][\s\S]{0,180}writeSshInput/.test(appSource), "Renderer must not manually translate Backspace outside xterm.");
assert(!/event\.key\s*===\s*["']Delete["'][\s\S]{0,180}writeSshInput/.test(appSource), "Renderer must not manually translate Delete outside xterm.");
assert(!/String\.fromCharCode\(event\.key\.toUpperCase\(\)\.charCodeAt\(0\)\s*-\s*64\)/.test(appSource), "Renderer must not manually reconstruct Ctrl+letter input.");

assert(appSource.includes("sshXtermInputDisposable?.dispose?.();") && appSource.includes("sshXtermInputDisposable = terminal.onData"), "Reopening SSH must replace the input subscription without duplicate listeners.");
assert(appSource.includes("sshXtermSessionId !== session.id"), "xterm input must reject stale SSH session bindings.");
assert(appSource.includes("terminal.options.disableStdin = !(session && session.status === \"connected\" && session.shellReady !== false)"), "Disconnected and shell-not-ready sessions must disable terminal input safely.");
assert(serviceSource.includes("SSH_STREAM_NOT_WRITABLE"), "SSH service must reject input when the PTY stream is no longer writable.");

console.log("SSH interactive input smoke checks passed.");
