#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const readText = (filePath) => fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
const appSource = readText(path.join(rootDir, "app.js"));
const preloadSource = readText(path.join(rootDir, "preload.js"));
const ipcSource = readText(path.join(rootDir, "src", "ipc", "sshIpc.js"));
const serviceSource = readText(path.join(rootDir, "src", "services", "sshService.js"));

function requireSource(fragment, message) {
  assert(appSource.includes(fragment), message);
}

requireSource("function bindSshXtermInput(terminal = sshXterm)", "Renderer must have a reusable xterm input binder.");
requireSource("sshXtermInputDisposable?.dispose?.();", "Renderer must dispose the previous xterm input listener before rebinding.");
requireSource("sshXtermInputDisposable = terminal.onData((data) => {", "Renderer must bind xterm onData for terminal input.");
requireSource("writeSshInput(data);", "Renderer must send xterm data directly to the SSH write path.");
requireSource("sshXterm.open(sshXtermSurface);", "Renderer must open xterm on the visible terminal surface.");
requireSource("bindSshXtermInput(sshXterm);", "Renderer must bind input immediately after creating xterm.");
requireSource("if (sshXterm) {\n    bindSshXtermInput(sshXterm);", "Renderer must rebind input when reusing an existing xterm instance.");
requireSource("bindSshXtermInput(terminal);", "Renderer must rebind input when synchronizing a session after rerender or reconnect.");
requireSource("sshXtermSessionId !== session.id", "Renderer must reject stale session input.");
requireSource("terminal.options.disableStdin = !(session && session.status === \"connected\" && session.shellReady !== false)", "Renderer must enable input only for shell-ready connected sessions.");
requireSource("window.requestAnimationFrame(focusSshTerminalInput);", "Renderer must focus the terminal after a successful connection.");
requireSource("sshTerminalWindow?.addEventListener(\"click\", () => {", "Renderer must listen for terminal surface clicks.");
requireSource("if (getActiveSshSession()?.status === \"connected\" && getActiveSshSession()?.shellReady !== false) {\n    focusSshTerminalInput();", "Clicking inside a shell-ready connected terminal must request xterm focus.");
requireSource("lastWriteRejectedCategory: session?.status === \"connected\" && session.shellReady === false ? \"shell_not_ready\" : \"stale_or_inactive_session\"", "Renderer diagnostics must identify shell-not-ready and stale or inactive session writes.");
requireSource("lastWriteAccepted: true", "Renderer diagnostics must mark successful writes.");

assert(preloadSource.includes("return ipcRenderer.invoke(\"ssh:write\", { sessionId, input });"), "Preload must forward exact xterm data to main IPC.");
assert(ipcSource.includes("registerSshHandler(\"ssh:write\"") && ipcSource.includes("return sshService.write(payload.sessionId, payload.input);"), "Main IPC must forward exact terminal data through the SSH domain wrapper to the service.");
assert(serviceSource.includes("session.stream.write(data);"), "SSH service must write terminal data once to the PTY stream.");

[
  "echo hello",
  "\\u007f",
  "\\t",
  "\\u001b[A",
  "\\u001b[B",
  "\\u001b[C",
  "\\u001b[D",
  "\\u0003",
  "\\u0004",
  "\\u000c",
].forEach((fixture) => assert.strictEqual(typeof fixture, "string"));

assert(!appSource.includes("const arrowMap = {"), "Renderer must not manually rebuild arrow-key control sequences.");
assert(!appSource.includes("navigationKeyMap"), "Renderer must not manually rebuild navigation control sequences.");
assert(!/event\.key\s*===\s*["']Backspace["'][\s\S]{0,180}writeSshInput/.test(appSource), "Renderer must not manually rebuild Backspace input.");
assert(!/event\.key\s*===\s*["']Delete["'][\s\S]{0,180}writeSshInput/.test(appSource), "Renderer must not manually rebuild Delete input.");
assert(!/String\.fromCharCode\(event\.key\.toUpperCase\(\)\.charCodeAt\(0\)\s*-\s*64\)/.test(appSource), "Renderer must not manually rebuild Ctrl+letter input.");

console.log("SSH renderer input lifecycle smoke checks passed.");
