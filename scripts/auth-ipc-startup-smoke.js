#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const securityIpc = fs.readFileSync(path.join(root, "src", "ipc", "securityIpc.js"), "utf8");
const accountIpc = fs.readFileSync(path.join(root, "src", "ipc", "accountAuthIpc.js"), "utf8");

const readyBlock = main.slice(
  main.indexOf("app.whenReady().then(async () => {"),
  main.indexOf("app.on(\"window-all-closed\""),
);

assert(readyBlock, "Main process must define the desktop ready bootstrap.");
assert(
  readyBlock.indexOf("registerAccountAuthIpc();") < readyBlock.indexOf("createWindow();"),
  "Account IPC must be registered before the main renderer is created.",
);
assert(
  readyBlock.indexOf("registerSecurityIpc();") < readyBlock.indexOf("createWindow();"),
  "Local security IPC must be registered before the main renderer is created.",
);
assert(
  readyBlock.indexOf("registerAccountAuthIpc();") < readyBlock.indexOf("recoverIncompleteInstallations()"),
  "Account IPC registration must not wait for instance recovery.",
);
assert(
  readyBlock.indexOf("registerSecurityIpc();") < readyBlock.indexOf("recoverIncompleteInstallations()"),
  "Security IPC registration must not wait for instance recovery.",
);
assert(
  !readyBlock.includes("await localInstanceService.recoverIncompleteInstallations()"),
  "Instance recovery must not block renderer-critical IPC registration.",
);
assert(preload.includes('login: (payload) => ipcRenderer.invoke("security:login", payload)'), "Preload must expose the local security login channel.");
assert(preload.includes('restore: () => invokeAccount("account:restore")'), "Preload must expose the account restoration channel.");
assert(securityIpc.includes('ipcMain.handle("security:login"'), "Main security IPC must register the local login handler.");
assert(accountIpc.includes('ipcMain.handle("account:restore"'), "Main account IPC must register the restoration handler.");

console.log("Auth IPC startup smoke checks passed.");
