"use strict";

// Is a public route really ready? A gateway port that accepts a connection
// only proves the gateway is up. For Minecraft (Java) servers this does a
// real Server List Ping through the route and reads the server's status
// (version, players), which proves the game answered. For other TCP games
// it connects and holds the connection: a gateway that can't reach the game
// closes it. UDP can't be confirmed without the game's own client.
// Every result says it was tested from this computer only.

const net = require("net");

function varint(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < Math.min(buffer.length, offset + 5); index += 1) {
    const byte = buffer[index];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, next: index + 1 };
    shift += 7;
  }
  return null;
}

function packet(id, body) {
  const content = Buffer.concat([varint(id), body]);
  return Buffer.concat([varint(content.length), content]);
}

function mcString(text) {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([varint(bytes.length), bytes]);
}

// Server List Ping (handshake + status request), as a Minecraft client does
// before joining. Resolves the parsed status JSON or rejects.
function minecraftStatus(host, port, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("No status answer.")); }, timeoutMs);
    const fail = (message) => { clearTimeout(timer); socket.destroy(); reject(new Error(message)); };
    socket.once("error", (error) => fail(error.code || error.message));
    socket.once("close", () => fail("The connection closed before the server answered."));
    socket.once("connect", () => {
      const portBuffer = Buffer.alloc(2);
      portBuffer.writeUInt16BE(port);
      socket.write(packet(0x00, Buffer.concat([varint(767), mcString(host), portBuffer, varint(1)])));
      socket.write(packet(0x00, Buffer.alloc(0)));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 256 * 1024) return fail("The answer was too large.");
      const length = readVarint(buffer, 0);
      if (!length || buffer.length < length.next + length.value) return undefined;
      const id = readVarint(buffer, length.next);
      if (!id || id.value !== 0x00) return fail("That port didn't answer like a Minecraft server.");
      const size = readVarint(buffer, id.next);
      if (!size) return fail("That port didn't answer like a Minecraft server.");
      try {
        const status = JSON.parse(buffer.subarray(size.next, size.next + size.value).toString("utf8"));
        clearTimeout(timer);
        socket.removeAllListeners("close");
        socket.destroy();
        resolve(status);
      } catch {
        fail("That port didn't answer like a Minecraft server.");
      }
      return undefined;
    });
  });
}

function holdTest(host, port, holdMs = 1500, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.once("error", (error) => done({ ok: false, reason: `Couldn't connect to ${host}:${port} (${error.code || error.message}).` }));
    socket.once("close", () => done({ ok: false, reason: "The gateway accepted the connection but couldn't reach the server." }));
    socket.once("connect", () => setTimeout(() => done({ ok: true, level: "connection", reason: `${host}:${port} stayed connected to the server through the gateway (tested from this computer).` }), holdMs));
    setTimeout(() => done({ ok: false, reason: "No answer from the gateway." }), timeoutMs);
  });
}

async function testPublicRoute(route, { minecraft = false } = {}) {
  if (!route) return { tested: false, ok: false, reason: "No public route." };
  if (route.protocol !== "tcp") return { tested: false, ok: false, reason: "UDP routes can't be confirmed without a game client." };
  if (minecraft) {
    try {
      const status = await minecraftStatus(route.publicHost, route.publicPort);
      const players = status?.players ? `${status.players.online ?? "?"}/${status.players.max ?? "?"} players` : "status received";
      return { tested: true, ok: true, level: "game", reason: `${route.publicHost}:${route.publicPort} answered as a Minecraft server (${status?.version?.name || "unknown version"}, ${players}), tested from this computer.` };
    } catch (error) {
      // Fall back to a connection test, and say the game didn't confirm.
      const held = await holdTest(route.publicHost, route.publicPort);
      return held.ok
        ? { tested: true, ok: false, level: "connection", reason: `The gateway reaches the server's port, but it didn't answer a Minecraft status request (${error.message}).` }
        : { tested: true, ...held };
    }
  }
  return { tested: true, ...(await holdTest(route.publicHost, route.publicPort)) };
}

module.exports = { minecraftStatus, testPublicRoute, _test: { packet, varint, readVarint, mcString } };
