const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");
const { getReleaseInfo } = require("../shared/releaseConfig");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../shared/migrationRecoveryPolicy");

const APPLICATION_HOST_NODE_ID = "application-host";
const APPLICATION_HOST_SCHEMA_VERSION = 1;

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try { return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config"); }
  catch { return path.join(process.cwd(), "config"); }
}

function getApplicationHostPath() {
  return path.join(getConfigDirectory(), "application-host.json");
}

function readOrCreateHostId() {
  const filePath = getApplicationHostPath();
  if (!fs.existsSync(filePath)) {
    const hostId = `host-${crypto.randomUUID()}`;
    writeHostIdentity(filePath, { schemaVersion: APPLICATION_HOST_SCHEMA_VERSION, hostId });
    return hostId;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !/^[a-zA-Z0-9_-]{8,128}$/.test(parsed.hostId || "")) {
      throw new Error("Application host identity is invalid.");
    }
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw Object.assign(new Error("Application host identity is unreadable. The original file was preserved for recovery."), {
      code: "APPLICATION_HOST_IDENTITY_CORRUPT",
      details: { causeCode: error?.code || "INVALID_IDENTITY" },
    });
  }
  const schemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > APPLICATION_HOST_SCHEMA_VERSION) {
    throw Object.assign(new Error("Application host identity was created by a newer application version."), {
      code: "APPLICATION_HOST_SCHEMA_UNSUPPORTED",
      details: { schemaVersion, supportedSchemaVersion: APPLICATION_HOST_SCHEMA_VERSION },
    });
  }
  if (schemaVersion < APPLICATION_HOST_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(filePath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    // V2-J bullet 6: the risky rewrite below only runs behind a recovery point
    // that was read back and verified. A copy that was written but never checked
    // is `unverified`, and unverified is refused — not warned past. The host
    // identity is a random UUID that is not reconstructible from anywhere else.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "application-host-identity",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: APPLICATION_HOST_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw Object.assign(new Error("Application host identity could not be migrated safely because the pre-migration recovery point could not be verified."), {
        code: "APPLICATION_HOST_MIGRATION_RECOVERY_UNVERIFIED",
        details: { storeId: "application-host-identity", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      });
    }
    writeHostIdentity(filePath, { schemaVersion: APPLICATION_HOST_SCHEMA_VERSION, hostId: parsed.hostId });
  }
  return parsed.hostId;
}

function writeHostIdentity(filePath, identity) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

function getApplicationHost() {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const release = getReleaseInfo();
  const trustedDevelopmentMode = process.env.ANXOS_TRUSTED_DEVELOPMENT_MODE === "1" && app?.isPackaged === false;
  return {
    hostId: readOrCreateHostId(),
    hostname: os.hostname(),
    operatingSystem: `${os.type()} ${os.release()}`.trim(),
    platform: process.platform,
    architecture: process.arch,
    displayName: process.platform === "win32" ? "Windows Desktop" : `${os.hostname()} Desktop`,
    cpu: {
      model: cpus[0]?.model || "Unknown CPU",
      cores: cpus.length,
    },
    memory: {
      total: totalMemory,
      free: freeMemory,
      used: Math.max(totalMemory - freeMemory, 0),
    },
    storage: {
      status: "metrics-required",
      message: "Open Dashboard or select this desktop node to load current storage metrics.",
    },
    desktopUptimeSeconds: Math.round(process.uptime()),
    systemUptimeSeconds: Math.round(os.uptime()),
    electronVersion: process.versions.electron || null,
    nodeVersion: process.versions.node || null,
    appVersion: release.compactLabel,
    releaseVersion: release.version,
    buildNumber: release.build,
    channel: release.channel,
    developerMode: trustedDevelopmentMode,
    packaged: app?.isPackaged === true,
    runningState: "running",
  };
}

function getApplicationHostNode() {
  const host = getApplicationHost();
  return {
    id: APPLICATION_HOST_NODE_ID,
    kind: "application-host",
    displayName: host.displayName,
    description: "Computer running AnxOS Control Center.",
    modeLabel: "Local Application",
    nodeTypeLabel: "Application Host",
    builtIn: true,
    removable: false,
    removeUnavailableReason: "The built-in Application Host cannot be removed.",
    applicationHost: host,
    local: true,
    default: true,
    executionTarget: { type: "application-host", hostId: host.hostId },
  };
}

module.exports = { APPLICATION_HOST_NODE_ID, APPLICATION_HOST_SCHEMA_VERSION, getApplicationHost, getApplicationHostNode };
