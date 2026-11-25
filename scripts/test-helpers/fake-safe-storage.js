"use strict";

// Build 216-E: a Local Owner session is remembered only with OS-backed secure
// storage (Electron safeStorage). Plain-Node smokes have no Electron, so a
// smoke that checks remembered sessions installs this reversible fake before
// it requires any service. It replaces `require("electron")` for that process
// with { app: undefined, safeStorage } (in plain Node, `app` is undefined
// anyway), so nothing else about the run changes.

function install() {
  const fakeSafeStorage = {
    available: true,
    isEncryptionAvailable() { return this.available; },
    encryptString(text) { return Buffer.from(`SAFE:${Buffer.from(String(text), "utf8").toString("base64")}`, "utf8"); },
    decryptString(buffer) {
      const text = Buffer.from(buffer).toString("utf8");
      if (!text.startsWith("SAFE:")) throw new Error("not protected by the fake safe storage");
      return Buffer.from(text.slice(5), "base64").toString("utf8");
    },
  };
  const electronPath = require.resolve("electron");
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: undefined, safeStorage: fakeSafeStorage } };
  return fakeSafeStorage;
}

module.exports = { install };
