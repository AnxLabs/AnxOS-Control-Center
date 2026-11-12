"use strict";

// Talks to the AnxNet host process (src/anxnet/host.js) over its local pipe,
// starting the host when it isn't running. Used by the desktop main process.

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const net = require("net");
const path = require("path");

const { jsonLineReader, sendJsonLine } = require("./frames");
const { pipePathFor, tokenPathFor } = require("./host");

const HOST_SCRIPT = path.join(__dirname, "bin", "anxnet-host.js");

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

class AnxNetHostClient extends EventEmitter {
  constructor({ dataDir, spawnHost = true, hostArgs = [], execPath = process.execPath, env = {} }) {
    super();
    this.dataDir = dataDir;
    this.pipePath = pipePathFor(dataDir);
    this.spawnHost = spawnHost;
    this.hostArgs = hostArgs;
    this.execPath = execPath;
    this.env = env;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  readToken() {
    try { return fs.readFileSync(tokenPathFor(this.dataDir), "utf8").trim(); } catch { return null; }
  }

  async tryConnect() {
    const token = this.readToken();
    if (!token) return false;
    const socket = net.connect(this.pipePath);
    const ok = await new Promise((resolve) => {
      socket.once("connect", () => resolve(true));
      socket.once("error", () => resolve(false));
    });
    if (!ok) { socket.destroy(); return false; }
    this.attach(socket, token);
    try {
      await this.call("ping", {}, 3000);
      return true;
    } catch {
      socket.destroy();
      return false;
    }
  }

  attach(socket, token) {
    this.socket = socket;
    this.token = token;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      for (const { reject } of this.pending.values()) reject(error("ANXNET_HOST_DISCONNECTED", "Lost the connection to AnxNet."));
      this.pending.clear();
      this.emit("disconnected");
    });
    jsonLineReader(socket, (message) => {
      if (message.event) { this.emit(message.event, message.data); return; }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else entry.resolve(message.result);
    });
  }

  // Connect to a running host, or start one (detached, so it outlives this
  // process) and connect to it.
  async connect() {
    if (this.socket && !this.socket.destroyed) return this;
    if (await this.tryConnect()) return this;
    if (!this.spawnHost) throw error("ANXNET_HOST_NOT_RUNNING", "AnxNet isn't running.");
    const child = spawn(this.execPath, [HOST_SCRIPT, "--data-dir", this.dataDir, ...this.hostArgs], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...this.env },
    });
    child.unref();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (await this.tryConnect()) return this;
    }
    throw error("ANXNET_HOST_START_FAILED", "AnxNet's background process didn't start.");
  }

  call(method, params = {}, timeoutMs = 30000) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(error("ANXNET_HOST_DISCONNECTED", "Not connected to AnxNet."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(error("ANXNET_HOST_TIMEOUT", "AnxNet didn't answer in time.")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sendJsonLine(this.socket, { id, token: this.token, method, params });
    });
  }

  disconnect() {
    this.socket?.destroy();
    this.socket = null;
  }
}

module.exports = { AnxNetHostClient, HOST_SCRIPT };
