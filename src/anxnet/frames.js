"use strict";

// The AnxNet multiplexer: many TCP streams, UDP flows and control messages
// over one secure byte stream (TLS, directly or through a relay or gateway).
// Frame: type (1 byte) | id (4 bytes) | length (2 bytes) | payload.
// Payloads are at most 65535 bytes and the parser holds at most one frame,
// so a peer cannot make it buffer without bound.

const { EventEmitter } = require("events");

const TYPES = Object.freeze({ OPEN: 1, DATA: 2, CLOSE: 3, DGRAM: 4, PING: 5, PONG: 6, CTRL: 7 });
const HEADER = 7;
const MAX_PAYLOAD = 65535;

function encode(type, id, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  if (body.length > MAX_PAYLOAD) throw new Error("ANXNET_FRAME_TOO_LARGE");
  const header = Buffer.allocUnsafe(HEADER);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(id >>> 0, 1);
  header.writeUInt16BE(body.length, 5);
  return Buffer.concat([header, body]);
}

// Wraps a duplex stream; emits "frame" ({ type, id, payload }) and "error".
class FrameReader extends EventEmitter {
  constructor(stream) {
    super();
    this.buffer = Buffer.alloc(0);
    stream.on("data", (chunk) => this.push(chunk));
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEADER) {
      const type = this.buffer.readUInt8(0);
      if (type < 1 || type > 7) {
        this.buffer = Buffer.alloc(0);
        this.emit("error", Object.assign(new Error("Unknown frame type."), { code: "ANXNET_FRAME_INVALID" }));
        return;
      }
      const length = this.buffer.readUInt16BE(5);
      if (this.buffer.length < HEADER + length) return;
      const id = this.buffer.readUInt32BE(1);
      const payload = this.buffer.subarray(HEADER, HEADER + length);
      this.buffer = this.buffer.subarray(HEADER + length);
      this.emit("frame", { type, id, payload });
    }
  }
}

// Split a large buffer into frame-sized DATA payloads.
function* chunks(buffer, size = 16 * 1024) {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}

// UDP flows carried in DGRAM frames: flow id (4 bytes) is the frame id;
// the payload is the datagram itself.

// JSON lines for control channels that run before the multiplexer.
function jsonLineReader(stream, onMessage, { maxLineBytes = 256 * 1024 } = {}) {
  let pending = "";
  const handler = (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > maxLineBytes) {
      stream.destroy(Object.assign(new Error("Control message too large."), { code: "ANXNET_CONTROL_TOO_LARGE" }));
      return;
    }
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { stream.destroy(Object.assign(new Error("Bad control message."), { code: "ANXNET_CONTROL_INVALID" })); return; }
      onMessage(message);
    }
  };
  stream.on("data", handler);
  return () => stream.off("data", handler);
}

function sendJsonLine(stream, message) {
  if (!stream.destroyed) stream.write(`${JSON.stringify(message)}\n`);
}

module.exports = { FrameReader, MAX_PAYLOAD, TYPES, chunks, encode, jsonLineReader, sendJsonLine };
