"use strict";

// A disposable stand-in for a Paper Minecraft server, for UI tests that need
// a real Agent-owned process with a console: it prints Paper-style log lines,
// answers "list", "say" and "stop" on stdin, and writes nothing outside its
// own data folder. It never downloads or runs Minecraft.

function fakeServerSource(softwareLabel, port) {
  return `const SOFTWARE_LABEL = ${JSON.stringify(softwareLabel)};
const readline = require("readline");
// The game port: answers a Minecraft Server List Ping (handshake + status
// request) with a status like a real server; any other first message gets
// "fake-minecraft" and is then echoed, for plain connectivity tests.
const varint = (value) => { const out = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value); return Buffer.from(out); };
require("net").createServer((socket) => {
  socket.on("error", () => {});
  let mode = null;
  socket.on("data", (data) => {
    // A Minecraft handshake starts with a short packet length, then packet id 0.
    if (mode === null) mode = data.length >= 3 && data[0] < 0x80 && data[0] + 1 <= data.length && data[1] === 0x00 ? "status" : "echo";
    if (mode === "status") {
      const json = Buffer.from(JSON.stringify({ version: { name: "Paper 1.21.1", protocol: 767 }, players: { online: 0, max: 20 }, description: { text: "AnxOS test server" } }));
      const body = Buffer.concat([varint(0), varint(json.length), json]);
      socket.end(Buffer.concat([varint(body.length), body]));
      return;
    }
    if (!socket.greeted) { socket.greeted = true; socket.write("fake-minecraft\\n"); return; }
    socket.write(data);
  });
}).on("error", () => {}).listen(${Number(port)}, "127.0.0.1");
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (level, message) => console.log("[" + stamp() + " " + level + "]: " + message);
log("INFO", "Starting minecraft server version 1.21.1");
log("INFO", "Loading properties");
log("INFO", "This server is running " + SOFTWARE_LABEL + " version 1.21.1-130 (MC: 1.21.1)");
log("INFO", "Default game type: SURVIVAL");
log("INFO", "Preparing level \\"world\\"");
setTimeout(() => log("INFO", "Done (1.234s)! For help, type \\"help\\""), 300);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = String(line).trim();
  if (command === "list") log("INFO", "There are 0 of a max of 20 players online: ");
  else if (command.startsWith("say ")) log("INFO", "[Server] " + command.slice(4));
  else if (command === "stop") { log("INFO", "Stopping the server"); setTimeout(() => process.exit(0), 100); }
  else if (command) log("INFO", "Unknown or incomplete command, see below for error");
});
process.on("SIGTERM", () => { log("INFO", "Stopping the server"); process.exit(0); });
setInterval(() => {}, 60000);
`;
}

const SERVER_PROPERTIES = [
  "#Minecraft server properties",
  "motd=A disposable AnxOS test server",
  "max-players=20",
  "difficulty=easy",
  "gamemode=survival",
  "level-name=world",
  "white-list=false",
  "online-mode=true",
  "pvp=true",
  "server-port=25599",
  "",
].join("\n");

function fakeMinecraftInstance(options = {}) {
  const id = options.id || "survival-test";
  const software = options.serverSoftware || "paper";
  const softwareLabel = software.charAt(0).toUpperCase() + software.slice(1);
  return {
    config: {
      id,
      displayName: options.displayName || "Survival Test",
      type: "custom-command",
      tags: ["minecraft"],
      templateId: "minecraft-paper",
      serverSoftware: options.serverSoftware || "paper",
      minecraftVersion: options.minecraftVersion || "1.21.1",
      executable: "node",
      args: ["fake-server.js"],
      ports: [options.port || 25599],
      memoryLimit: "2G",
      state: "Stopped",
    },
    files: {
      "fake-server.js": fakeServerSource(softwareLabel, options.port || 25599),
      "server.properties": SERVER_PROPERTIES,
      "eula.txt": "eula=true\n",
      "plugins/.keep": "",
      "world/level.dat": "fake level data",
      ...(options.files || {}),
    },
  };
}

module.exports = { fakeMinecraftInstance };
