#!/usr/bin/env node
"use strict";

// Phase 8 drag-and-drop upload on the Files page: FileService.uploadContent
// writing to this PC (a disposable folder). Nothing outside that folder is
// touched.
//   D1 every byte value survives (binary content, not text)
//   D2 an existing name is refused unless replace was confirmed; with
//      replace the file is swapped whole (temp file then rename)
//   D3 names that could leave the folder or hide control characters are
//      refused before anything is written
//   D4 content over 100 MB and non-base64 content are refused
//   D5 IPC, preload and the permission matrix carry files:uploadContent at
//      files:write

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anx-files-drop-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(temp, "config");
  fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
  const folder = path.join(temp, "folder");
  fs.mkdirSync(folder);
  const { FileService } = require("../src/services/fileService");
  const service = new FileService();
  const transfers = [];
  service.emitTransfer = (event) => transfers.push(event);
  const local = (extra) => ({ providerType: "renderer-local", storageId: "local", directoryPath: folder, ...extra });

  try {
    // D1
    const bytes = Buffer.from(Array.from({ length: 256 * 4 }, (_, index) => index % 256));
    const result = await service.uploadContent(local({ name: "every-byte.bin", contentBase64: bytes.toString("base64") }));
    assert.strictEqual(result.uploaded, true);
    assert.ok(fs.readFileSync(path.join(folder, "every-byte.bin")).equals(bytes), "the file on disk matches byte for byte");
    assert.deepStrictEqual(transfers.map((event) => event.status), ["running", "complete"], "the upload shows in Transfers");
    console.log("PASS D1 binary content is written byte for byte");

    // D2
    await assert.rejects(service.uploadContent(local({ name: "every-byte.bin", contentBase64: Buffer.from("new").toString("base64") })), (error) => error.code === "FILES_CONFLICT");
    assert.ok(fs.readFileSync(path.join(folder, "every-byte.bin")).equals(bytes), "a refused upload leaves the existing file alone");
    await service.uploadContent(local({ name: "every-byte.bin", contentBase64: Buffer.from("replacement").toString("base64"), conflictPolicy: "replace" }));
    assert.strictEqual(fs.readFileSync(path.join(folder, "every-byte.bin"), "utf8"), "replacement");
    assert.deepStrictEqual(fs.readdirSync(folder).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
    console.log("PASS D2 no silent overwrite; replace swaps the whole file");

    // D3
    for (const name of ["../escape.txt", "sub/inner.txt", "..\\escape.txt", "..", ".", "", "bad\u0001name.txt", "x".repeat(256)]) {
      await assert.rejects(service.uploadContent(local({ name, contentBase64: "aGk=" })), (error) => error.code === "FILES_INVALID_NAME", `refused: ${JSON.stringify(name.slice(0, 20))}`);
    }
    assert.ok(!fs.existsSync(path.join(temp, "escape.txt")), "nothing was written outside the folder");
    console.log("PASS D3 names that would leave the folder are refused");

    // D4
    await assert.rejects(service.uploadContent(local({ name: "big.bin", contentBase64: "A".repeat(Math.ceil((100 * 1024 * 1024) / 3) * 4 + 8) })), (error) => error.code === "FILES_TOO_LARGE");
    await assert.rejects(service.uploadContent(local({ name: "odd.bin", contentBase64: "not base64!" })), (error) => error.code === "FILES_INVALID_CONTENT");
    assert.deepStrictEqual(fs.readdirSync(folder).sort(), ["every-byte.bin"], "refused uploads write nothing");
    console.log("PASS D4 oversized and malformed content is refused");

    // D5
    const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.match(read("src/ipc/filesIpc.js"), /"files:uploadContent"[\s\S]{0,80}requirePermission\("files:write"/);
    assert.match(read("preload.js"), /uploadContent: \(payload\) => ipcRenderer\.invoke\("files:uploadContent", payload\)/);
    assert.match(read("test-helpers/permission-matrix.js"), /"files:uploadContent"/);
    console.log("PASS D5 files:uploadContent is wired at files:write");
    console.log("Files drop upload smoke: 5 checks passed.");
  } finally {
    service.dispose?.();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
