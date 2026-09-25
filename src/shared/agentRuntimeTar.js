const zlib = require("zlib");

const BLOCK_SIZE = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const DEFAULT_FILE_MODE = 0o644;

// Minimal, dependency-free ustar writer/reader. The Agent runtime payload is a
// few megabytes of JavaScript, so a deterministic in-memory tar (fixed mtime,
// fixed uid/gid) gzipped with zlib is simpler and more portable than shelling
// out to tar(1) from the Electron main process.
function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  const slice = bytes.subarray(0, length);
  slice.copy(buffer, offset);
  return slice.length;
}

function writeOctal(buffer, offset, length, value) {
  const text = Math.max(0, Math.trunc(Number(value) || 0)).toString(8);
  const padded = text.padStart(length - 1, "0").slice(-(length - 1));
  writeString(buffer, offset, length, `${padded}\0`);
}

function splitTarPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength <= NAME_MAX) return { name: normalized, prefix: "" };
  for (let index = normalized.length - 1; index > 0; index -= 1) {
    if (normalized[index] !== "/") continue;
    const prefix = normalized.slice(0, index);
    const name = normalized.slice(index + 1);
    if (Buffer.byteLength(name, "utf8") <= NAME_MAX && Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX) {
      return { name, prefix };
    }
  }
  throw Object.assign(new Error(`Agent runtime payload path cannot be stored in a ustar archive: ${normalized}`), {
    code: "AGENT_RUNTIME_TAR_PATH_TOO_LONG",
  });
}

function createTarHeader(entry) {
  const { name, prefix } = splitTarPath(entry.relativePath);
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode ?? DEFAULT_FILE_MODE);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, Buffer.isBuffer(entry.content) ? entry.content.length : Number(entry.size) || 0);
  writeOctal(header, 136, 12, 0);
  // Checksum is computed with the checksum field filled with spaces, then
  // written as 6 octal digits, NUL, space.
  writeString(header, 148, 8, "        ");
  header[156] = 0x30; // typeflag '0' = regular file
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "anxos");
  writeString(header, 297, 32, "anxos");
  if (prefix) writeString(header, 345, 155, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20;
  return header;
}

function buildTarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.alloc(0);
    blocks.push(createTarHeader({ ...entry, size: content.length }));
    blocks.push(content);
    const remainder = content.length % BLOCK_SIZE;
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK_SIZE - remainder, 0));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(blocks);
}

function createTarGz(entries) {
  return zlib.gzipSync(buildTarArchive(entries), { level: 6 });
}

// Reader used by tests and diagnostics to verify a produced archive without
// depending on the platform tar binary.
function readTarEntries(archive) {
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive || "");
  const entries = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const readField = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "").trim();
    const name = readField(0, 100);
    const prefix = readField(345, 155);
    const sizeText = readField(124, 12);
    const size = sizeText ? parseInt(sizeText, 8) || 0 : 0;
    const checksumText = readField(148, 8);
    const expectedChecksum = checksumText ? parseInt(checksumText, 8) : null;
    const checksumBuffer = Buffer.from(header);
    checksumBuffer.fill(0x20, 148, 156);
    let actualChecksum = 0;
    for (const byte of checksumBuffer) actualChecksum += byte;
    if (expectedChecksum !== null && expectedChecksum !== actualChecksum) {
      throw Object.assign(new Error(`Tar header checksum mismatch at offset ${offset}.`), { code: "AGENT_RUNTIME_TAR_CHECKSUM_MISMATCH" });
    }
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const contentStart = offset + BLOCK_SIZE;
    entries.push({ relativePath, size, content: buffer.subarray(contentStart, contentStart + size) });
    offset = contentStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return entries;
}

module.exports = {
  BLOCK_SIZE,
  buildTarArchive,
  createTarGz,
  readTarEntries,
};