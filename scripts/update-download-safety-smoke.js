#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { UpdateManager, pickUpdateAsset, verifyUpdateArtifact } = require("../src/services/updateManager");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-update-download-"));
  const payload = Buffer.from("verified update artifact\n".repeat(4096));
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const uppercaseSha256 = sha256.toUpperCase();
  const prefixedSha256 = `sha256:${sha256}`;
  let slowInterval = null;
  let artifactRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/slow") {
      response.writeHead(200, { "Content-Length": payload.length * 100 });
      slowInterval = setInterval(() => response.write(payload.subarray(0, 128)), 10);
      response.on("close", () => {
        clearInterval(slowInterval);
        slowInterval = null;
      });
      return;
    }
    if (request.url === "/artifact") {
      artifactRequests += 1;
    }
    response.writeHead(200, { "Content-Length": payload.length });
    response.end(payload);
  });
  const port = await listen(server);
  const manager = new UpdateManager();

  manager.log("redaction fixture", {
    url: "https://user:password@example.invalid/update?token=secret-value",
    stack: "secret stack",
    localPath: "C:\\Users\\Update User\\Downloads\\AnxOS Control Center.exe",
  });
  const serializedLogs = JSON.stringify(manager.getState().logs);
  assert(!serializedLogs.includes("password") && !serializedLogs.includes("secret-value"), "renderer-visible update logs must redact credentials.");
  assert(!serializedLogs.includes("secret stack"), "renderer-visible update logs must omit stack traces.");
  assert(serializedLogs.includes('"localPath":"[redacted-path]"'), "Update diagnostic history must fully redact allowlisted path fields.");

  try {
    const committedPath = path.join(root, "update.bin");
    await manager.downloadFile(`http://127.0.0.1:${port}/artifact`, committedPath, {
      size: payload.length,
      sha256,
    });
    assert.deepStrictEqual(fs.readFileSync(committedPath), payload, "verified downloads must be committed intact.");
    assert.deepStrictEqual(fs.readdirSync(root), ["update.bin"], "successful downloads must not leave temporary files.");
    await verifyUpdateArtifact(committedPath, { size: payload.length, sha256 });
    await verifyUpdateArtifact(committedPath, { size: payload.length, sha256: prefixedSha256 });
    await verifyUpdateArtifact(committedPath, { size: payload.length, sha256: uppercaseSha256 });
    await assert.rejects(
      verifyUpdateArtifact(committedPath, { size: payload.length, sha256: `sha512:${sha256}` }),
      (error) => error?.code === "UPDATE_CHECKSUM_REQUIRED",
      "SHA-512 metadata must not be accepted as a SHA-256 checksum.",
    );
    await assert.rejects(
      verifyUpdateArtifact(committedPath, { size: payload.length, sha256: `md5:${sha256}` }),
      (error) => error?.code === "UPDATE_CHECKSUM_REQUIRED",
      "unknown checksum prefixes must not be accepted.",
    );
    await assert.rejects(
      verifyUpdateArtifact(committedPath, { size: payload.length, sha256: sha256.slice(0, 63) }),
      (error) => error?.code === "UPDATE_CHECKSUM_REQUIRED",
      "partial SHA-256 digests must not be accepted.",
    );
    await assert.rejects(
      verifyUpdateArtifact(committedPath, { size: payload.length, sha256: `${sha256.slice(0, 32)} ${sha256.slice(32)}` }),
      (error) => error?.code === "UPDATE_CHECKSUM_REQUIRED",
      "SHA-256 digests containing whitespace must not be accepted.",
    );
    await assert.rejects(
      verifyUpdateArtifact(committedPath, { size: payload.length, sha256: `${sha256.slice(0, 63)}z` }),
      (error) => error?.code === "UPDATE_CHECKSUM_REQUIRED",
      "non-hex SHA-256 digests must not be accepted.",
    );

    const uppercasePath = path.join(root, "uppercase.bin");
    await manager.downloadFile(`http://127.0.0.1:${port}/artifact`, uppercasePath, {
      size: payload.length,
      sha256: uppercaseSha256,
    });
    assert.deepStrictEqual(fs.readFileSync(uppercasePath), payload, "uppercase SHA-256 metadata must verify downloads.");

    const prefixedPath = path.join(root, "prefixed.bin");
    await manager.downloadFile(`http://127.0.0.1:${port}/artifact`, prefixedPath, {
      size: payload.length,
      sha256: prefixedSha256,
    });
    assert.deepStrictEqual(fs.readFileSync(prefixedPath), payload, "GitHub digest-form SHA-256 metadata must verify downloads.");

    const requestsBeforeMissingChecksum = artifactRequests;
    let missingChecksumProgress = false;
    const missingChecksumPath = path.join(root, "missing-checksum.bin");
    await assert.rejects(
      manager.downloadFile(`http://127.0.0.1:${port}/artifact`, missingChecksumPath, {
        size: payload.length,
        onProgress: () => {
          missingChecksumProgress = true;
        },
      }),
      (error) => error?.code === "UPDATE_CHECKSUM_REQUIRED",
      "missing checksums must fail before starting the download.",
    );
    assert.strictEqual(artifactRequests, requestsBeforeMissingChecksum, "missing checksums must not start an HTTP artifact request.");
    assert.strictEqual(missingChecksumProgress, false, "missing checksums must not report download progress.");
    assert(!fs.existsSync(missingChecksumPath), "missing checksums must not expose a final artifact.");
    assert(!fs.readdirSync(root).some((name) => name.includes("missing-checksum") || name.endsWith(".part")), "missing checksums must not create temporary artifacts.");

    fs.appendFileSync(committedPath, "tampered");
    await assert.rejects(
      verifyUpdateArtifact(committedPath, { size: payload.length, sha256 }),
      (error) => error?.code === "UPDATE_ARTIFACT_SIZE_MISMATCH",
      "install handoff must reject an artifact changed after download.",
    );
    fs.writeFileSync(committedPath, payload);

    const mismatchPath = path.join(root, "mismatch.bin");
    await assert.rejects(
      manager.downloadFile(`http://127.0.0.1:${port}/artifact`, mismatchPath, {
        size: payload.length,
        sha256: "0".repeat(64),
      }),
      (error) => error?.code === "UPDATE_CHECKSUM_MISMATCH",
      "checksum mismatches must reject the artifact.",
    );
    assert(!fs.existsSync(mismatchPath), "checksum failures must not expose a final artifact.");

    const existingPath = path.join(root, "existing.bin");
    fs.writeFileSync(existingPath, "existing user file\n");
    await assert.rejects(
      manager.downloadFile(`http://127.0.0.1:${port}/artifact`, existingPath, {
        size: payload.length,
        sha256,
      }),
      (error) => error?.code === "UPDATE_DOWNLOAD_COMMIT_FAILED",
      "an existing destination must reject atomic commit.",
    );
    assert.strictEqual(fs.readFileSync(existingPath, "utf8"), "existing user file\n", "update downloads must never overwrite an existing file.");

    const cancelledPath = path.join(root, "cancelled.bin");
    const cancellation = manager.downloadFile(`http://127.0.0.1:${port}/slow`, cancelledPath, {
      size: payload.length * 100,
      sha256,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    manager.stop();
    await assert.rejects(cancellation, (error) => error?.code === "UPDATE_CANCELLED", "shutdown must cancel the underlying download.");
    assert(!fs.existsSync(cancelledPath), "cancelled downloads must not expose a final artifact.");
    assert(!fs.readdirSync(root).some((name) => name.endsWith(".part")), "cancelled downloads must clean temporary files.");

    const compatibleName = process.platform === "win32" ? "update.exe" : process.platform === "linux" ? "update.AppImage" : "update.dmg";
    const incompatibleName = process.platform === "win32" ? "update.AppImage" : "update.exe";
    const asset = (name, architecture = process.arch) => ({ name, size: 10 * 1024 * 1024, architecture, browser_download_url: `https://example.invalid/${name}` });
    assert.strictEqual(pickUpdateAsset({ assets: [asset(incompatibleName)] }), null, "asset selection must reject another operating system.");
    assert.strictEqual(pickUpdateAsset({ assets: [asset(compatibleName, process.arch === "x64" ? "arm64" : "x64")] }), null, "asset selection must reject another architecture.");
    assert.strictEqual(pickUpdateAsset({ assets: [asset(compatibleName)] })?.name, compatibleName, "asset selection must accept the current platform and architecture.");

    const prereleaseResult = manager.resolveUpdateResult({
      draft: false,
      prerelease: true,
      tag_name: "v99.9-build999",
      name: "Version 99.9 Build 999",
      published_at: "2099-01-01T00:00:00Z",
      assets: [{
        ...asset(compatibleName),
        digest: prefixedSha256,
      }],
    }, "https://api.github.com/repos/example/releases?per_page=20");
    assert.strictEqual(prereleaseResult.hasUpdate, true, "prereleases discovered through the GitHub Releases API must remain eligible updates.");
    assert.strictEqual(prereleaseResult.asset.sha256, sha256, "GitHub API digest fields must normalize to raw lowercase SHA-256.");

    const prereleasePath = path.join(root, "prerelease.bin");
    await manager.downloadFile(`http://127.0.0.1:${port}/artifact`, prereleasePath, {
      size: payload.length,
      sha256: prereleaseResult.asset.sha256,
    });
    assert.deepStrictEqual(fs.readFileSync(prereleasePath), payload, "prerelease GitHub API digest metadata must download and verify successfully.");

    manager.state.latest = {
      hasUpdate: true,
      asset: {
        name: "state-ready.bin",
        size: payload.length,
        sha256,
        downloadUrl: `http://127.0.0.1:${port}/artifact`,
      },
    };
    const downloadReady = await manager.download();
    assert.strictEqual(downloadReady.downloaded, true, "successful update downloads must report downloaded=true.");
    assert.strictEqual(downloadReady.state.status, "downloaded", "late renderer state queries must see install-ready downloaded status.");
    assert.strictEqual(downloadReady.state.downloadInFlight, false, "download completion must clear in-flight state before downloaded status is emitted.");
    assert(downloadReady.state.downloadedPath, "downloaded state must include the verified installer path.");
    fs.rmSync(downloadReady.state.downloadedPath, { force: true });
  } finally {
    if (slowInterval) clearInterval(slowInterval);
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("Update download safety smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
