const fs = require("fs");
const path = require("path");
const { getDefaultConfigDirectory } = require("./secureSessionStore");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../shared/migrationRecoveryPolicy");

const OWNER_ACCOUNTS_FILE = "owner-accounts.json";
const OWNER_ACCOUNTS_SCHEMA_VERSION = 1;

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUuid(value) {
  return String(value || "").trim().toLowerCase();
}

function getOwnerAccountsPath(configDirectory = getDefaultConfigDirectory()) {
  return path.join(configDirectory, OWNER_ACCOUNTS_FILE);
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

function readOwnerAccountsFile(configDirectory = getDefaultConfigDirectory()) {
  const filePath = getOwnerAccountsPath(configDirectory);
  if (!fs.existsSync(filePath)) return { userIds: [], emails: [], updatedAt: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Owner account root must be an object.");
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw Object.assign(new Error("Owner account authorization state is unreadable. The original file was preserved for recovery."), {
      code: "OWNER_ACCOUNT_STORE_CORRUPT",
      details: { causeCode: error?.code || "INVALID_JSON" },
    });
  }
  const schemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > OWNER_ACCOUNTS_SCHEMA_VERSION) {
    throw Object.assign(new Error("Owner account authorization state was created by a newer application version."), {
      code: "OWNER_ACCOUNT_SCHEMA_UNSUPPORTED",
      details: { schemaVersion, supportedSchemaVersion: OWNER_ACCOUNTS_SCHEMA_VERSION },
    });
  }
  const normalized = {
    userIds: Array.isArray(parsed.userIds) ? parsed.userIds.map(normalizeUuid).filter(Boolean) : [],
    emails: Array.isArray(parsed.emails) ? parsed.emails.map(normalizeEmail).filter(Boolean) : [],
    updatedAt: parsed.updatedAt || null,
  };
  if (schemaVersion < OWNER_ACCOUNTS_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(filePath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    // V2-J bullet 6: the authorization rewrite below only runs behind a
    // recovery point that was read back and verified. An unverified copy is
    // refused, not warned past. Owner authorization state cannot be rebuilt
    // from anywhere else and a wrong migration could lock out the owner.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "owner-accounts",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: OWNER_ACCOUNTS_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw Object.assign(new Error("Owner account authorization state could not be migrated safely because the pre-migration recovery point could not be verified."), {
        code: "OWNER_ACCOUNT_MIGRATION_RECOVERY_UNVERIFIED",
        details: { storeId: "owner-accounts", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      });
    }
    atomicWriteJson(filePath, { schemaVersion: OWNER_ACCOUNTS_SCHEMA_VERSION, ...normalized });
  }
  return normalized;
}

function getConfiguredOwnerAccounts(options = {}) {
  const fileConfig = readOwnerAccountsFile(options.configDirectory);
  const envUserIds = splitList(process.env.ANXOS_OWNER_ACCOUNT_IDS || process.env.ANXOS_OWNER_SUPABASE_USER_IDS).map(normalizeUuid);
  const envEmails = splitList(process.env.ANXOS_OWNER_EMAILS || process.env.ANXOS_OWNER_ACCOUNT_EMAILS).map(normalizeEmail);
  return {
    userIds: [...new Set([...fileConfig.userIds, ...envUserIds])],
    emails: [...new Set([...fileConfig.emails, ...envEmails])],
    sourcePath: getOwnerAccountsPath(options.configDirectory),
    hasFileConfig: Boolean(fileConfig.userIds.length || fileConfig.emails.length),
    hasEnvConfig: Boolean(envUserIds.length || envEmails.length),
  };
}

function isOwnerAccount(account = {}, options = {}) {
  const config = getConfiguredOwnerAccounts(options);
  const id = normalizeUuid(account.id || account.userId || account.sub);
  const email = normalizeEmail(account.email);
  return Boolean((id && config.userIds.includes(id)) || (email && config.emails.includes(email)));
}

function writeOwnerAccounts({ userIds = [], emails = [] }, options = {}) {
  const configDirectory = options.configDirectory || getDefaultConfigDirectory();
  const payload = {
    schemaVersion: OWNER_ACCOUNTS_SCHEMA_VERSION,
    userIds: [...new Set(userIds.map(normalizeUuid).filter(Boolean))],
    emails: [...new Set(emails.map(normalizeEmail).filter(Boolean))],
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(getOwnerAccountsPath(configDirectory), payload);
  return payload;
}

module.exports = {
  OWNER_ACCOUNTS_SCHEMA_VERSION,
  getConfiguredOwnerAccounts,
  getOwnerAccountsPath,
  isOwnerAccount,
  normalizeEmail,
  normalizeUuid,
  readOwnerAccountsFile,
  writeOwnerAccounts,
};
