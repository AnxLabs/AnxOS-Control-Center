// Hermetic backup-verification smoke: the verification lifecycle on the Agent
// side plus its desktop wiring.
//
// Proves, against the real Agent service on a temp tree:
//   1. a newly created backup records { state: "unverified", method: "sha256",
//      checkedAt: null, detail: null } in its metadata file;
//   2. verifyBackup() promotes a fresh archive to "verified" with the injected
//      clock persisted (re-read from the metadata file, not just returned);
//   3. a readable archive whose content was replaced (valid gzip, wrong bytes)
//      fails with "checksum mismatch" — expected/actual digests appear in the
//      RESULT object only, never in the persisted detail;
//   4. a deleted archive fails with "archive missing" (BACKUP_ARCHIVE_MISSING);
//   5. a truncated archive is classified "corrupt" with the read error code;
//   6. legacy metadata without the field is disclosed as "unknown" (never
//      "unverified"), the on-disk file is not rewritten by reading, and an
//      explicit verify of a digest-less record stays unknown instead of being
//      promoted to verified;
//   7. an unknown id throws BACKUP_NOT_FOUND; every other outcome returns;
//   8. metadata files stay valid JSON after every outcome, list output exposes
//      the verification objects, and the REST route serves the same outcomes;
//   9. the desktop wiring exists: agentClient.verifyBackup really hits
//      POST /api/v1/backups/<encoded id>/verify with the node credential, and
//      the route/authorization/IPC sources carry the verify wiring
//      (agent/src/server.js is asserted from source because requiring it
//      starts the listener).
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const zlib = require("zlib");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const root = pinAgentRoots("anx-backup-verification-");
// Pin the desktop config dir too: the agentClient check below resolves its
// node from nodes.json in here, and a smoke must never touch the real machine
// config.
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const backupService = require("../agent/src/services/backupService");
const { handleBackups } = require("../agent/src/routes/backups");
const agentClient = require("../src/services/agentClient");

const INSTANCE_ID = "verify-instance";
const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const FIXED_NOW_ISO = FIXED_NOW.toISOString();
const UNVERIFIED = { state: "unverified", method: "sha256", checkedAt: null, detail: null };
const LEGACY_DISCLOSURE = { state: "unknown", method: "sha256", checkedAt: null, detail: "Backup predates verification support." };

function instanceDir(instanceId) {
  return path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
}

function metadataFile(backupId) {
  return path.join(process.env.AGENT_BACKUP_ROOT, `${backupId}.json`);
}

function archiveFile(backupId) {
  return path.join(process.env.AGENT_BACKUP_ROOT, `${backupId}.tar.gz`);
}

function createInstanceFixture(instanceId) {
  const instancePath = instanceDir(instanceId);
  fs.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(instancePath, "config.json"), `${JSON.stringify({ id: instanceId, displayName: instanceId, state: "Stopped" }, null, 2)}\n`);
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), "verification-world-v1");
  return instancePath;
}

// Every verification outcome must leave a valid JSON record behind, so all
// persistence checks funnel through this parse.
function readPersistedMetadata(backupId) {
  return JSON.parse(fs.readFileSync(metadataFile(backupId), "utf8"));
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function createFixtureBackup(name) {
  return (await backupService.createBackup({ instanceId: INSTANCE_ID, type: "world", name, createdBy: "smoke" })).backup;
}

// createBackup prunes to the default keepLast; these extra fixtures keep every
// earlier backup so later checks still find theirs.
async function createRetainedFixtureBackup(name) {
  return (await backupService.createBackup({ instanceId: INSTANCE_ID, type: "world", name, createdBy: "smoke", retention: { keepLast: 9999, maxAgeDays: 3650 } })).backup;
}

// Replaces a fixture's archive with arbitrary bytes and records their digest
// as the create-time digest, so verification is judged on decoding alone.
async function replaceArchive(backupId, bytes, { recordDigest = true } = {}) {
  await fsp.writeFile(archiveFile(backupId), bytes, { mode: 0o600 });
  if (recordDigest) {
    const metadata = readPersistedMetadata(backupId);
    metadata.archiveSha256 = sha256Hex(bytes);
    await fsp.writeFile(metadataFile(backupId), `${JSON.stringify(metadata, null, 2)}\n`);
  }
}

// Runs fn while sampling the event loop (largest gap between 5 ms ticks) and
// external memory, so a verification that blocks or buffers is observable.
async function observeEventLoop(fn) {
  const baseline = process.memoryUsage().arrayBuffers;
  let last = Date.now();
  let maxGapMs = 0;
  let peakArrayBuffers = baseline;
  const sample = () => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
  };
  const timer = setInterval(sample, 5);
  try {
    const result = await fn();
    sample();
    return { result, maxGapMs, peakExtraBytes: peakArrayBuffers - baseline };
  } finally {
    clearInterval(timer);
  }
}

// A blocking verification stalls the loop on every run, in proportion to its
// work (~400 ms here); a busy host can also deschedule the process for a
// one-off stall. Up to three runs are observed and the quietest one is judged,
// so host noise cannot fail the check while blocking code still fails every
// run. Memory is judged by the worst run.
async function observeVerification(fn, attempts = 3) {
  const gaps = [];
  let peakExtraBytes = 0;
  let observed = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    observed = await observeEventLoop(fn);
    gaps.push(observed.maxGapMs);
    peakExtraBytes = Math.max(peakExtraBytes, observed.peakExtraBytes);
    if (observed.maxGapMs < 150) break;
  }
  return { result: observed.result, gaps, quietestGapMs: Math.min(...gaps), peakExtraBytes };
}

async function startMockAgent() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || "", body });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ record: { id: "mock" }, ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

async function main() {
  createInstanceFixture(INSTANCE_ID);

  // 1. A fresh create starts unverified in the result AND on disk.
  const created = await createFixtureBackup("fresh");
  assert.deepStrictEqual(created.verification, UNVERIFIED, "A newly created backup must be returned unverified.");
  assert.deepStrictEqual(readPersistedMetadata(created.id).verification, UNVERIFIED, "The unverified state must be persisted at create time, not only returned.");

  // 2. Verifying the intact archive promotes it to verified and persists the
  // injected clock, not just the returned object.
  const verified = await backupService.verifyBackup(created.id, { now: FIXED_NOW });
  assert.strictEqual(verified.ok, true, "Verifying an intact archive must succeed.");
  assert.deepStrictEqual(
    verified.record.verification,
    { state: "verified", method: "sha256", checkedAt: FIXED_NOW_ISO, detail: null },
    "A successful verification must report verified with the injected clock.",
  );
  assert.deepStrictEqual(
    readPersistedMetadata(created.id).verification,
    { state: "verified", method: "sha256", checkedAt: FIXED_NOW_ISO, detail: null },
    "The verified outcome and checkedAt must be persisted to the metadata file.",
  );

  // 3. A readable tamper (re-gzipped replaced content) fails as checksum
  // mismatch; the digests stay in the result and out of the metadata detail.
  const tampered = await createFixtureBackup("tampered");
  const tamperedPath = archiveFile(tampered.id);
  const tamperedTar = zlib.gunzipSync(await fsp.readFile(tamperedPath));
  tamperedTar[1024] ^= 0xff; // first payload byte past both tar headers (backup-integrity-smoke fixture trick)
  const tamperedBytes = zlib.gzipSync(tamperedTar);
  await fsp.writeFile(tamperedPath, tamperedBytes, { mode: 0o600 });
  const tamperedResult = await backupService.verifyBackup(tampered.id, { now: FIXED_NOW });
  assert.strictEqual(tamperedResult.ok, false, "A tampered archive must not verify.");
  assert.strictEqual(tamperedResult.code, "BACKUP_ARCHIVE_HASH_MISMATCH", "A readable tamper must fail with the checksum code.");
  assert.strictEqual(tamperedResult.expectedSha256, tampered.archiveSha256, "The result must carry the create-time digest as expected.");
  assert.strictEqual(tamperedResult.actualSha256, sha256Hex(tamperedBytes), "The result must carry the observed digest as actual.");
  assert.notStrictEqual(tamperedResult.actualSha256, tamperedResult.expectedSha256);
  const tamperedPersisted = readPersistedMetadata(tampered.id);
  assert.strictEqual(tamperedPersisted.verification.state, "failed");
  assert.strictEqual(tamperedPersisted.verification.detail, "checksum mismatch", "The persisted detail must stay generic.");
  const tamperedVerificationText = JSON.stringify(tamperedPersisted.verification);
  assert(!tamperedVerificationText.includes(tamperedResult.actualSha256), "The persisted detail must never include the observed digest.");
  assert(!tamperedVerificationText.includes(tamperedResult.expectedSha256), "The persisted verification must not duplicate digest material.");

  // 4. A deleted archive fails as archive-missing and persists that outcome.
  const missing = await createFixtureBackup("missing");
  await fsp.rm(archiveFile(missing.id), { force: true });
  const missingResult = await backupService.verifyBackup(missing.id, { now: FIXED_NOW });
  assert.strictEqual(missingResult.ok, false);
  assert.strictEqual(missingResult.code, "BACKUP_ARCHIVE_MISSING");
  assert.strictEqual(missingResult.record.verification.state, "failed");
  assert.strictEqual(missingResult.record.verification.detail, "archive missing");
  assert.deepStrictEqual(
    readPersistedMetadata(missing.id).verification,
    { state: "failed", method: "sha256", checkedAt: FIXED_NOW_ISO, detail: "archive missing" },
    "The archive-missing outcome must be persisted.",
  );

  // 5. A truncated gzip is corrupt (not failed), with the read error code.
  const truncated = await createFixtureBackup("truncated");
  const truncatedBytes = await fsp.readFile(archiveFile(truncated.id));
  await fsp.writeFile(archiveFile(truncated.id), truncatedBytes.subarray(0, Math.max(1, Math.floor(truncatedBytes.length / 2))), { mode: 0o600 });
  const truncatedResult = await backupService.verifyBackup(truncated.id, { now: FIXED_NOW });
  assert.strictEqual(truncatedResult.ok, false);
  assert.strictEqual(truncatedResult.record.verification.state, "corrupt", "A truncated archive must be classified corrupt, not failed.");
  assert(typeof truncatedResult.code === "string" && truncatedResult.code.length > 0, "The corrupt outcome must report the read error code.");
  assert.strictEqual(truncatedResult.record.verification.detail, truncatedResult.code, "The corrupt detail must carry the read error code.");
  assert.deepStrictEqual(readPersistedMetadata(truncated.id).verification, truncatedResult.record.verification, "The corrupt outcome must be persisted.");

  // 5b. PR #9 review L2: size limits are not corruption, and a truncated
  //     archive (a real decode failure) still is.
  const oversized = await createFixtureBackup("oversized");
  const oversizedBytes = (await fsp.stat(archiveFile(oversized.id))).size;
  const overLimit = await backupService.verifyBackup(oversized.id, { now: FIXED_NOW, maxArchiveBytes: Math.max(1, oversizedBytes - 1) });
  assert.strictEqual(overLimit.ok, false);
  assert.strictEqual(overLimit.code, "BACKUP_VERIFICATION_LIMIT_EXCEEDED");
  assert.strictEqual(overLimit.record.verification.state, "unknown", "an archive over the size limit is not evaluable, not corrupt");
  const expandedLimit = await backupService.verifyBackup(oversized.id, { now: FIXED_NOW, maxExpandedBytes: 1 });
  assert.strictEqual(expandedLimit.code, "BACKUP_VERIFICATION_LIMIT_EXCEEDED");
  assert.strictEqual(expandedLimit.record.verification.state, "unknown", "an expansion over the limit is not corrupt");
  const withinLimits = await backupService.verifyBackup(oversized.id, { now: FIXED_NOW });
  assert.strictEqual(withinLimits.record.verification.state, "verified", "the same archive verifies within the limits");
  const stillCorrupt = await backupService.verifyBackup(truncated.id, { now: FIXED_NOW });
  assert.strictEqual(stillCorrupt.record.verification.state, "corrupt", "a decode failure is still corrupt");

  // 5c. PR #9 second review P2-B: verification streams the archive. A large
  //     archive never blocks the event loop or is held in memory, and every
  //     integrity classification is unchanged.
  {
    const MiB = 1024 * 1024;
    // Concatenated gzip members: ~2.5 MiB on disk (many read chunks, the
    // first incompressible), ~466 MiB expanded (just under the 512 MiB limit).
    const zeroMember = zlib.gzipSync(Buffer.alloc(8 * MiB));
    const largeBytes = Buffer.concat([zlib.gzipSync(crypto.randomBytes(2 * MiB)), ...Array(58).fill(zeroMember)]);
    const large = await createRetainedFixtureBackup("large");
    await replaceArchive(large.id, largeBytes);

    const archivePath = archiveFile(large.id);
    const archiveReads = [];
    let syncInflates = 0;
    const originalReadFile = fsp.readFile;
    const originalGunzipSync = zlib.gunzipSync;
    fsp.readFile = function readFileTripwire(target, ...rest) {
      if (path.resolve(String(target)) === path.resolve(archivePath)) archiveReads.push(target);
      return originalReadFile.call(this, target, ...rest);
    };
    zlib.gunzipSync = function gunzipSyncTripwire(...args) {
      syncInflates += 1;
      return originalGunzipSync.apply(this, args);
    };
    let observed;
    try {
      observed = await observeVerification(() => backupService.verifyBackup(large.id, { now: FIXED_NOW }));
    } finally {
      fsp.readFile = originalReadFile;
      zlib.gunzipSync = originalGunzipSync;
    }
    assert.strictEqual(observed.result.ok, true, "a large intact archive verifies");
    assert.strictEqual(observed.result.record.verification.state, "verified");
    assert.deepStrictEqual(archiveReads, [], "the archive is never read whole into memory");
    assert.strictEqual(syncInflates, 0, "verification never decompresses synchronously");
    assert(observed.quietestGapMs < 150, `verification must not block the event loop (largest gap per run: ${observed.gaps.join(", ")} ms)`);
    assert(observed.peakExtraBytes < 128 * MiB, `verification memory stays bounded (peak +${Math.round(observed.peakExtraBytes / MiB)} MiB)`);

    // The streamed digest covers every chunk: a wrong recorded digest fails
    // with the true digest of the whole file.
    const largeMismatch = await createRetainedFixtureBackup("large-mismatch");
    await replaceArchive(largeMismatch.id, largeBytes, { recordDigest: false });
    const mismatch = await backupService.verifyBackup(largeMismatch.id, { now: FIXED_NOW });
    assert.strictEqual(mismatch.code, "BACKUP_ARCHIVE_HASH_MISMATCH");
    assert.strictEqual(mismatch.actualSha256, sha256Hex(largeBytes), "the streamed digest equals the whole-file digest");
    assert.strictEqual(mismatch.record.verification.state, "failed");

    // The expansion limit is enforced while streaming, as not-evaluable.
    const expansionCapped = await observeVerification(() => backupService.verifyBackup(large.id, { now: FIXED_NOW, maxExpandedBytes: 64 * MiB }));
    assert.strictEqual(expansionCapped.result.code, "BACKUP_VERIFICATION_LIMIT_EXCEEDED");
    assert.strictEqual(expansionCapped.result.record.verification.state, "unknown", "an expansion over the limit is not corrupt");
    assert(expansionCapped.quietestGapMs < 150, `the capped run does not block either (largest gap per run: ${expansionCapped.gaps.join(", ")} ms)`);
    const archiveCapped = await backupService.verifyBackup(large.id, { now: FIXED_NOW, maxArchiveBytes: largeBytes.length - 1 });
    assert.strictEqual(archiveCapped.code, "BACKUP_VERIFICATION_LIMIT_EXCEEDED");
    assert.strictEqual(archiveCapped.record.verification.state, "unknown");

    // Malformed archives and decode failures stay corrupt, with the zlib code.
    const malformedCases = [
      ["not-gzip", Buffer.from("this is not a gzip archive"), "Z_DATA_ERROR"],
      ["empty", Buffer.alloc(0), "Z_BUF_ERROR"],
      ["corrupt-member", Buffer.concat([zeroMember, zeroMember.subarray(0, 12), Buffer.from("garbage-deflate-stream"), zeroMember.subarray(30)]), null],
      ["trailing-garbage", Buffer.concat([zeroMember, Buffer.from("trailing garbage")]), "Z_DATA_ERROR"],
    ];
    for (const [name, bytes, expectedCode] of malformedCases) {
      const fixture = await createRetainedFixtureBackup(`malformed-${name}`);
      await replaceArchive(fixture.id, bytes);
      const outcome = await backupService.verifyBackup(fixture.id, { now: FIXED_NOW });
      assert.strictEqual(outcome.ok, false, `${name}: does not verify`);
      assert.strictEqual(outcome.record.verification.state, "corrupt", `${name}: a decode failure is corrupt, even with a matching digest`);
      assert.match(outcome.code, /^Z_/, `${name}: the corrupt outcome carries the zlib code`);
      if (expectedCode) assert.strictEqual(outcome.code, expectedCode, `${name}: same code as the synchronous decoder reported`);
      assert.deepStrictEqual(readPersistedMetadata(fixture.id).verification, outcome.record.verification, `${name}: persisted`);
    }

    // Something other than a regular file is not evaluable (unknown), and is
    // never streamed (a FIFO or device could otherwise block or never end).
    const unreadable = await createRetainedFixtureBackup("unreadable");
    await fsp.rm(archiveFile(unreadable.id), { force: true });
    await fsp.mkdir(archiveFile(unreadable.id));
    const unreadableResult = await backupService.verifyBackup(unreadable.id, { now: FIXED_NOW });
    assert.strictEqual(unreadableResult.ok, false);
    assert.strictEqual(unreadableResult.record.verification.state, "unknown", "a non-file archive path is not evaluable, not corrupt");
    assert.strictEqual(unreadableResult.code, "BACKUP_ARCHIVE_UNREADABLE");
    assert.strictEqual(unreadableResult.record.verification.detail, "archive unreadable (not a regular file)");
    await fsp.rm(archiveFile(unreadable.id), { recursive: true, force: true });

    // Restore is untouched: its validation still decodes the archive itself.
    const restoreSource = readSource(path.join("agent", "src", "services", "backupService.js"));
    assert(restoreSource.includes("tarBuffer = zlib.gunzipSync(archiveBuffer, { maxOutputLength: maxExpandedBytes });"),
      "restore validation keeps its existing decoder");
  }

  // 5d. PR #9 third review: the compressed-size limit holds while streaming,
  //     even when the archive grows or changes after its size check, and the
  //     archive handle is always closed.
  {
    const KiB = 1024;
    // Every open of the archive goes through this wrapper: it can misreport
    // the size the open handle sees (the file grew after that check) or fail
    // the read mid-stream, and it counts opens, closes and bytes read.
    const opened = { opens: 0, closes: 0, bytesRead: 0 };
    let fakeSize = null;
    let failReadAfterBytes = null;
    const originalOpen = fsp.open;
    fsp.open = async function openWrapper(target, ...rest) {
      const real = await originalOpen.call(this, target, ...rest);
      opened.opens += 1;
      return {
        stat: async (...args) => {
          const stat = await real.stat(...args);
          if (fakeSize == null) return stat;
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: fakeSize });
        },
        createReadStream: (options) => {
          const stream = real.createReadStream(options);
          let seen = 0;
          stream.on("data", (chunk) => {
            seen += chunk.length;
            opened.bytesRead += chunk.length;
            if (failReadAfterBytes != null && seen > failReadAfterBytes) {
              stream.destroy(Object.assign(new Error("simulated read failure"), { code: "EIO" }));
            }
          });
          return stream;
        },
        close: async () => {
          opened.closes += 1;
          return real.close();
        },
      };
    };
    try {
      // An empty-member flood: almost no expanded output, so only the
      // compressed limit can stop it.
      const emptyMember = zlib.gzipSync(Buffer.alloc(0));
      const flood = Buffer.concat(Array(Math.ceil((2 * 1024 * KiB) / emptyMember.length)).fill(emptyMember));
      const floodBackup = await createRetainedFixtureBackup("empty-member-flood");
      await replaceArchive(floodBackup.id, flood);
      const limit = 64 * KiB;

      fakeSize = 1; // the archive "grew" after the open handle's size check
      opened.bytesRead = 0;
      const grown = await backupService.verifyBackup(floodBackup.id, { now: FIXED_NOW, maxArchiveBytes: limit });
      assert.strictEqual(grown.code, "BACKUP_VERIFICATION_LIMIT_EXCEEDED", "growth past the limit is a limit outcome, not a checksum mismatch");
      assert.strictEqual(grown.record.verification.state, "unknown");
      assert.strictEqual(grown.record.verification.detail, "archive exceeds the verification size limit");
      assert(opened.bytesRead <= limit + 1, `the read stops one byte past the limit (read ${opened.bytesRead} bytes)`);

      // Boundary: exactly at the limit verifies; one byte over does not.
      fakeSize = 1;
      const atLimit = await backupService.verifyBackup(floodBackup.id, { now: FIXED_NOW, maxArchiveBytes: flood.length });
      assert.strictEqual(atLimit.record.verification.state, "verified", "an archive exactly at the limit is read in full and verifies");
      const overByOne = await backupService.verifyBackup(floodBackup.id, { now: FIXED_NOW, maxArchiveBytes: flood.length - 1 });
      assert.strictEqual(overByOne.code, "BACKUP_VERIFICATION_LIMIT_EXCEEDED", "one byte over is caught while streaming");
      fakeSize = null;

      // A read failure mid-stream is I/O (unknown), not corruption.
      failReadAfterBytes = 1;
      const ioFailure = await backupService.verifyBackup(floodBackup.id, { now: FIXED_NOW });
      failReadAfterBytes = null;
      assert.strictEqual(ioFailure.code, "EIO");
      assert.strictEqual(ioFailure.record.verification.state, "unknown", "a read failure is not evaluable, not corrupt");
      assert.strictEqual(ioFailure.record.verification.detail, "archive unreadable (EIO)");

      // Refused before reading (static size over the limit) and decode
      // failures also close the handle.
      const refused = await backupService.verifyBackup(floodBackup.id, { now: FIXED_NOW, maxArchiveBytes: limit });
      assert.strictEqual(refused.code, "BACKUP_VERIFICATION_LIMIT_EXCEEDED");
      const garbage = await createRetainedFixtureBackup("closed-after-corrupt");
      await replaceArchive(garbage.id, Buffer.from("not gzip"));
      assert.strictEqual((await backupService.verifyBackup(garbage.id, { now: FIXED_NOW })).record.verification.state, "corrupt");
      const intact = await backupService.verifyBackup(floodBackup.id, { now: FIXED_NOW });
      assert.strictEqual(intact.record.verification.state, "verified", "the same archive verifies within the default limits");
    } finally {
      fsp.open = originalOpen;
    }
    assert(opened.opens >= 7, "every verification opened the archive through the wrapper");
    assert.strictEqual(opened.closes, opened.opens, `every archive handle is closed (${opened.closes}/${opened.opens})`);
  }

  // 6. Legacy metadata (no verification field) is disclosed as unknown — not
  // as freshly unverified — and reading it must not rewrite the file.
  const legacyId = "legacy-verification-1a2b3c";
  fs.writeFileSync(metadataFile(legacyId), `${JSON.stringify({
    schemaVersion: 1,
    id: legacyId,
    instanceId: INSTANCE_ID,
    createdAt: new Date().toISOString(),
    type: "world",
    status: "complete",
  }, null, 2)}\n`);
  const listedLegacy = (await backupService.listBackups({ instanceId: INSTANCE_ID })).backups.find((backup) => backup.id === legacyId);
  assert.deepStrictEqual(listedLegacy.verification, LEGACY_DISCLOSURE, "A legacy record must be disclosed as unknown with the legacy reason.");
  assert.deepStrictEqual((await backupService.readBackupMetadata(legacyId)).verification, LEGACY_DISCLOSURE, "Direct reads must normalize the legacy record the same way.");
  assert(!Object.prototype.hasOwnProperty.call(readPersistedMetadata(legacyId), "verification"), "Reading legacy metadata must not fabricate a verification field on disk.");
  // An explicit verify of a digest-less record can only observe readability:
  // it must stay unknown (never promoted to verified) and persist honestly.
  await fsp.copyFile(archiveFile(created.id), archiveFile(legacyId));
  const legacyVerify = await backupService.verifyBackup(legacyId, { now: FIXED_NOW });
  assert.strictEqual(legacyVerify.ok, false);
  assert.strictEqual(legacyVerify.code, "BACKUP_CHECKSUM_UNAVAILABLE", "A record without a create-time digest cannot be promoted to verified.");
  assert.strictEqual(legacyVerify.record.verification.state, "unknown");
  assert.strictEqual(legacyVerify.record.verification.checkedAt, FIXED_NOW_ISO);
  assert.strictEqual(
    readPersistedMetadata(legacyId).verification.detail,
    "No create-time checksum is recorded for this backup.",
    "The persisted legacy observation must name the missing digest as the reason.",
  );

  // 7. Only an unknown id throws.
  await assert.rejects(
    () => backupService.verifyBackup("unknown-backup-id-1", { now: FIXED_NOW }),
    (error) => error?.code === "BACKUP_NOT_FOUND",
    "Verifying an unknown backup id must throw BACKUP_NOT_FOUND.",
  );

  // 8. List output exposes every observed state.
  const listed = await backupService.listBackups({ instanceId: INSTANCE_ID });
  const stateOf = (id) => listed.backups.find((backup) => backup.id === id)?.verification?.state;
  assert.strictEqual(stateOf(created.id), "verified");
  assert.strictEqual(stateOf(tampered.id), "failed");
  assert.strictEqual(stateOf(missing.id), "failed");
  assert.strictEqual(stateOf(truncated.id), "corrupt");
  assert.strictEqual(stateOf(legacyId), "unknown");
  assert(
    listed.backups.every((backup) => backup.verification && typeof backup.verification.state === "string"),
    "Every listed backup must expose a verification object.",
  );

  // 9. The REST route serves the same outcomes through the real handler.
  const routeVerified = await handleBackups({ method: "POST" }, new URL(`http://localhost/api/v1/backups/${encodeURIComponent(created.id)}/verify`));
  assert.strictEqual(routeVerified.statusCode, 200, "The verify route must answer 200 for an expected outcome.");
  assert.strictEqual(routeVerified.body.ok, true);
  assert.strictEqual(routeVerified.body.record.verification.state, "verified");
  const routeMissingArchive = await handleBackups({ method: "POST" }, new URL(`http://localhost/api/v1/backups/${encodeURIComponent(missing.id)}/verify`));
  assert.strictEqual(routeMissingArchive.statusCode, 200, "An archive-missing outcome is data, not an HTTP error.");
  assert.strictEqual(routeMissingArchive.body.code, "BACKUP_ARCHIVE_MISSING");
  const routeUnknown = await handleBackups({ method: "POST" }, new URL("http://localhost/api/v1/backups/unknown-backup-id-1/verify"));
  assert.strictEqual(routeUnknown.statusCode, 404, "The verify route must 404 an unknown backup id.");
  assert.strictEqual(routeUnknown.body.error.code, "BACKUP_NOT_FOUND");

  // 10. agentClient.verifyBackup really hits the verify path with the node
  // credential resolved from the node registry.
  const mockAgent = await startMockAgent();
  try {
    fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), `${JSON.stringify({
      schemaVersion: 3,
      selectedNodeId: "node-a",
      nodes: [{ id: "node-a", kind: "agent", name: "Node A", displayName: "Node A", baseUrl: mockAgent.url, agentUrl: mockAgent.url, enabled: true, agentIdentity: { deviceId: "device-a" } }],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), `${JSON.stringify({
      schemaVersion: 1,
      nodes: { "node-a": { agentToken: "token-a" } },
    }, null, 2)}\n`);

    const clientResult = await agentClient.verifyBackup("backup id+1", agentClient.forNode("node-a").target.config);
    assert.strictEqual(clientResult.ok, true);
    assert.strictEqual(mockAgent.requests.length, 1);
    assert.strictEqual(mockAgent.requests[0].method, "POST", "verifyBackup must POST.");
    assert.strictEqual(mockAgent.requests[0].url, "/api/v1/backups/backup%20id%2B1/verify", "verifyBackup must encode the backup id into the verify path.");
    assert.strictEqual(mockAgent.requests[0].authorization, "Bearer token-a", "verifyBackup must carry the node credential.");
  } finally {
    await mockAgent.close();
  }

  // 11. Source wiring pins. agent/src/server.js starts its listener at require
  // time, so the permission mapping is asserted from source: POST /verify
  // resolves through the /api/v1/backups/ branch to backups:write.
  const routeSource = readSource(path.join("agent", "src", "routes", "backups.js"));
  assert(routeSource.includes('getBackupSubroute(url.pathname, "/verify")'), "The backups route table must match the /verify subroute.");
  assert(routeSource.includes("verifyBackup(verifyBackupId)"), "The verify route must call the service's verifyBackup.");
  const serverSource = readSource(path.join("agent", "src", "server.js"));
  assert(serverSource.includes('if (pathname.endsWith("/restore")) return "backups:restore";'), "Fixture check: the backups permission block must be present.");
  assert(serverSource.includes('return method === "GET" ? "backups:read" : "backups:write";'), "POST backup subroutes (including /verify) must resolve to backups:write through the backups permission branch.");
  const ipcSource = readSource(path.join("src", "ipc", "backupsIpc.js"));
  [
    'ipcMain.handle("backups:verify"',
    'requireNodeContext(payload, "backup verification")',
    'requirePermission("backups:verify", payload.backupId)',
    'audit({ action: "backup.verify", target: `${payload.nodeId}:${payload.backupId}` })',
  ].forEach((needle) => assert(ipcSource.includes(needle), `backupsIpc verify wiring missing: ${needle}`));
  const clientSource = readSource(path.join("src", "services", "agentClient.js"));
  assert(clientSource.includes('/api/v1/backups/${encodeURIComponent(String(backupId || ""))}/verify'), "agentClient must build the verify path.");

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("Backup verification smoke checks passed.");
}

main().catch((error) => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  console.error(error);
  process.exit(1);
});
