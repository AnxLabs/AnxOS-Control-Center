const assert = require("assert");

// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-archive-safety-");

const marketplace = require("../src/services/marketplaceInstallService")._test;

for (const unsafePath of ["/etc/passwd", "C:\\Windows\\system.ini", "../outside", "folder/../../outside"]) {
  assert.throws(() => marketplace.safeArchivePath(unsafePath), (error) => error?.code === "ARCHIVE_PATH_UNSAFE", `Archive path must be rejected: ${unsafePath}`);
}
assert.strictEqual(marketplace.safeArchivePath("config/server.toml"), "config/server.toml");

assert.throws(
  () => marketplace.validateZipDirectory({ files: [{ path: "huge.bin", type: "File", compressedSize: 1024, uncompressedSize: 9 * 1024 * 1024 * 1024 }] }),
  (error) => error?.code === "ARCHIVE_LIMIT_EXCEEDED",
  "Oversized expanded entries must be rejected before extraction.",
);
assert.throws(
  () => marketplace.validateZipDirectory({ files: [{ path: "bomb.bin", type: "File", compressedSize: 1024, uncompressedSize: 32 * 1024 * 1024 }] }),
  (error) => error?.code === "ARCHIVE_COMPRESSION_UNSAFE",
  "Unsafe compression ratios must be rejected before extraction.",
);

async function main() {
  let canceled = false;
  const oversizedHeaderResponse = {
    headers: { get: () => String(1024) },
    body: { cancel: async () => { canceled = true; } },
  };
  await assert.rejects(
    () => marketplace.readBoundedResponseBuffer(oversizedHeaderResponse, { label: "Test", maxBytes: 128 }),
    (error) => error?.code === "DOWNLOAD_TOO_LARGE",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(canceled, true, "Oversized declared downloads must cancel the response body.");

  let streamCanceled = false;
  let reads = 0;
  const reader = {
    read: async () => (++reads === 1 ? { done: false, value: Buffer.alloc(80) } : { done: false, value: Buffer.alloc(80) }),
    cancel: async () => { streamCanceled = true; },
    releaseLock: () => {},
  };
  await assert.rejects(
    () => marketplace.readBoundedResponseBuffer({ headers: { get: () => null }, body: { getReader: () => reader } }, { label: "Test", maxBytes: 128 }),
    (error) => error?.code === "DOWNLOAD_TOO_LARGE" && error?.details?.receivedBytes === 160,
  );
  assert.strictEqual(streamCanceled, true, "Downloads crossing the runtime limit must cancel their reader.");
  const controller = new AbortController();
  let abortedReaderCanceled = false;
  const abortingReader = {
    read: async () => {
      controller.abort();
      return { done: false, value: Buffer.alloc(8) };
    },
    cancel: async () => { abortedReaderCanceled = true; },
    releaseLock: () => {},
  };
  await assert.rejects(
    () => marketplace.readBoundedResponseBuffer(
      { headers: { get: () => null }, body: { getReader: () => abortingReader } },
      { label: "Test", maxBytes: 128, signal: controller.signal },
    ),
    (error) => error?.code === "INSTALL_CANCELLED",
  );
  assert.strictEqual(abortedReaderCanceled, true, "Aborted downloads must cancel their response reader.");
  console.log("Marketplace archive and download safety smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
