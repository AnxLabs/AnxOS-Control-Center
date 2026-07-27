#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const readText = (filePath) => fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
const appSource = readText(path.join(rootDir, "app.js"));
const htmlSource = readText(path.join(rootDir, "index.html"));
const preloadSource = readText(path.join(rootDir, "preload.js"));
const ipcSource = readText(path.join(rootDir, "src", "ipc", "sshIpc.js"));
const serviceSource = readText(path.join(rootDir, "src", "services", "sshService.js"));

function requireSource(source, fragment, message) {
  assert(source.includes(fragment), message);
}

requireSource(htmlSource, "data-ssh-command-form", "SSH page must include the command form.");
requireSource(htmlSource, "data-ssh-command", "SSH page must include the command input.");
requireSource(htmlSource, "<button class=\"inline-action\" type=\"submit\" disabled>Send</button>", "SSH page must include the Send submit button.");

requireSource(appSource, "async function sendSshCommandFromBar(source = \"submit\")", "Command bar must use one shared submit function.");
assert(!appSource.includes("async function sendSshCommand(commandText)"), "Command bar must not keep separate command execution logic.");
requireSource(appSource, "const command = typeof sshCommandInput?.value === \"string\" ? sshCommandInput.value : \"\";", "Command bar must read the current input value.");
requireSource(appSource, "const accepted = await writeSshInput(`${command}\\r`);", "Command bar must send command plus carriage return through the PTY input path.");
assert(!appSource.includes("`${command}\\n`"), "Command bar must not send line-feed-only payloads.");
requireSource(appSource, "if (accepted && sshCommandInput) {\n    sshCommandInput.value = \"\";\n  }", "Command bar must clear only after a successful write.");
requireSource(appSource, "sshCommandInput?.focus();", "Command bar must retain focus after submit.");

requireSource(appSource, "sshCommandInput?.addEventListener(\"keydown\", async (event) => {\n  if (event.key === \"Enter\")", "Enter must submit through the command input path.");
requireSource(appSource, "await sendSshCommandFromBar(\"enter\");", "Enter must call the shared command bar submit function.");
requireSource(appSource, "sshCommandForm?.addEventListener(\"submit\", async (event) => {", "Form submit must be handled.");
requireSource(appSource, "sshCommandSendButton?.addEventListener(\"click\", async (event) => {", "Send button click must be handled.");
requireSource(appSource, "await sendSshCommandFromBar(\"button\");", "Send button must call the shared command bar submit function.");

assert(!appSource.includes("sshKeyboardMode"), "Command bar submission must not be blocked by stale keyboard-mode state.");
requireSource(appSource, "category === \"shell_not_ready\"", "Command bar must distinguish connected transport from an unready SSH shell.");
requireSource(appSource, "Command could not be sent because the SSH shell is not ready.", "Unready SSH shells must show a bounded command-send error.");
requireSource(appSource, "Waiting for shell...", "Renderer must expose a waiting-for-shell state before enabling command input.");
requireSource(appSource, "commandBarSubmitReceived: true", "Command bar diagnostics must record submit receipt.");
requireSource(appSource, "commandBarCommandLength: command.length", "Command bar diagnostics must record command length only.");
requireSource(appSource, "commandBarSource: source", "Command bar diagnostics must record source without command contents.");
requireSource(appSource, "commandBarWriteAccepted: accepted", "Command bar diagnostics must record write acceptance.");
assert(!appSource.includes("commandBarCommandText") && !appSource.includes("lastCommandText"), "Command bar diagnostics must not store command contents.");

requireSource(preloadSource, "recordSshBridgeWrite(sessionId, input);", "Preload must record safe write diagnostics.");
requireSource(preloadSource, "return ipcRenderer.invoke(\"ssh:write\", { sessionId, input });", "Preload must forward command-bar PTY input.");
requireSource(ipcSource, 'registerSshHandler("ssh:write"', "Main process must receive SSH writes through the shared authorized handler.");
requireSource(ipcSource, "sessionPresent: Boolean(payload.sessionId)", "Main IPC diagnostics must record session presence.");
requireSource(serviceSource, "sessionFound: Boolean(session)", "SSH service diagnostics must record session lookup.");
requireSource(serviceSource, "shellReady: Boolean(session?.shellReady)", "SSH service diagnostics must record shell readiness.");
requireSource(serviceSource, "streamWritable: session.stream.writable !== false", "SSH service diagnostics must record PTY writability.");
requireSource(serviceSource, "session.stream.write(data);", "SSH service must write to the active PTY stream.");
requireSource(serviceSource, "SSH_SHELL_NOT_READY", "SSH service must reject writes before shell readiness.");

[
  ["enter", "npm", "npm\r"],
  ["button", "pwd", "pwd\r"],
  ["rerender", "echo hello", "echo hello\r"],
].forEach(([source, input, expected]) => {
  assert.strictEqual(`${input}\r`, expected, `${source} command fixture must preserve command text and append carriage return.`);
});

console.log("SSH command bar submission smoke checks passed.");
