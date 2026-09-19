const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-operation-cancellation-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
const longOperations = require("../src/shared/longOperationService");
const { FileService } = require("../src/services/fileService");

async function main() {
  const fileService = Object.create(FileService.prototype);
  fileService.transferControllers = new Map();
  fileService.emitTransfer = () => {};
  const controller = fileService.createTransferController("cancel-file-transfer", { nodeId: "node-a", path: "/tmp/file", type: "download" });
  const stream = new EventEmitter();
  let destroyedWith = null;
  stream.destroy = (error) => { destroyedWith = error; stream.emit("close"); };
  fileService.attachTransferStream(controller, stream);
  await longOperations.cancelOperation(controller.id);
  assert.strictEqual(controller.canceled, true, "File cancellation should update the underlying transfer controller.");
  assert.strictEqual(destroyedWith?.code, "FILES_TRANSFER_CANCELED", "File cancellation should destroy the real stream with a stable cancellation error.");

  const marketplace = require("../src/services/marketplaceService");
  const abortController = new AbortController();
  marketplace._test.registerCancellationSmokeRecord("cancel-marketplace-download", abortController);
  await longOperations.cancelOperation("cancel-marketplace-download");
  assert.strictEqual(abortController.signal.aborted, true, "Marketplace cancellation should abort the real HTTP controller.");

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("Operation domain cancellation smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
