const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { pipeline } = require("stream/promises");
const { BrowserWindow, dialog } = require("electron");
const { Client } = require("ssh2");
const { AgentClientError, downloadFile, getFileListing, getFilesystemIdentity, mutateFile, readFileText } = require("./agentClient");
const diagnostics = require("./diagnosticsService");
const { getNode, getNodeAgentConfig } = require("./nodeService");
const longOperations = require("../shared/longOperationService");
const { SshService, SshServiceError } = require("./sshService");
const { LOCAL_STORAGE_ID, getConnection } = require("./storageConnectionService");

const posixPath = path.posix;
const PROTECTED_REMOTE_PATHS = ["/", "/etc", "/usr", "/bin"];
const DEFAULT_TEXT_READ_LIMIT_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

class FileServiceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "FileServiceError";
    this.code = details.code || null;
    this.status = details.status || null;
  }
}

async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function createLocalTemporaryPath(targetPath, purpose = "write") {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${purpose}.tmp`);
}

async function commitLocalFile(targetPath, writeTemporary, purpose = "write") {
  const temporaryPath = createLocalTemporaryPath(targetPath, purpose);
  try {
    await writeTemporary(temporaryPath);
    await fsPromises.rename(temporaryPath, targetPath);
  } catch (error) {
    await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function createRemoteTemporaryPath(remotePath, purpose = "write") {
  return posixPath.join(posixPath.dirname(remotePath), `.${posixPath.basename(remotePath)}.${process.pid}.${Date.now()}.${purpose}.tmp`);
}

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createProfileLookup() {
  return new SshService();
}

function getWindowForDialogs() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

async function showOpenDialog(options) {
  const window = getWindowForDialogs();
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}

async function showSaveDialog(options) {
  const window = getWindowForDialogs();
  return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
}

function getDefaultRemotePath(profile) {
  const profileId = trimValue(profile?.id);
  const username = trimValue(profile?.username);
  const displayName = trimValue(profile?.displayName).toLowerCase();

  if (profileId === "debian-anx" || (displayName === "debian" && username === "anx")) {
    return "/home/anx";
  }

  if (username) {
    return posixPath.join("/home", username);
  }

  return "/";
}

function normalizeRemotePath(inputPath, fallbackPath = "/") {
  const fallback = trimValue(fallbackPath) || "/";
  const rawValue = trimValue(inputPath);

  if (!rawValue) {
    return posixPath.normalize(fallback) || "/";
  }

  if (rawValue.startsWith("/")) {
    return posixPath.normalize(rawValue) || "/";
  }

  return posixPath.normalize(posixPath.join(fallback, rawValue)) || "/";
}

function buildBreadcrumbs(currentPath) {
  const normalizedPath = normalizeRemotePath(currentPath);

  if (normalizedPath === "/") {
    return [];
  }

  const segments = normalizedPath.split("/").filter(Boolean);
  let runningPath = "";

  return segments.map((segment) => {
    runningPath = `${runningPath}/${segment}`;
    return {
      name: segment,
      path: runningPath || "/",
    };
  });
}

function getEntryTypeFromAttrs(attrs = {}) {
  if (typeof attrs.isDirectory === "function" && attrs.isDirectory()) {
    return "directory";
  }

  if (typeof attrs.isFile === "function" && attrs.isFile()) {
    return "file";
  }

  const mode = Number(attrs.mode);

  if (Number.isFinite(mode)) {
    if ((mode & fs.constants.S_IFMT) === fs.constants.S_IFDIR) {
      return "directory";
    }

    if ((mode & fs.constants.S_IFMT) === fs.constants.S_IFREG) {
      return "file";
    }
  }

  return "other";
}

function createEntry(remoteDirectoryPath, entry) {
  const name = entry?.filename || "";
  const type = getEntryTypeFromAttrs(entry?.attrs);
  const entryPath = normalizeRemotePath(posixPath.join(remoteDirectoryPath, name));
  const extension = type === "file" && name.includes(".") ? name.split(".").pop() : "";
  const modifiedAt = Number.isFinite(entry?.attrs?.mtime)
    ? new Date(entry.attrs.mtime * 1000).toISOString()
    : null;
  const mode = Number(entry?.attrs?.mode);

  return {
    name,
    path: entryPath,
    type,
    isDirectory: type === "directory",
    extension,
    size: Number.isFinite(entry?.attrs?.size) ? entry.attrs.size : null,
    modifiedAt,
    permissions: Number.isFinite(mode) ? (mode & 0o777).toString(8).padStart(3, "0") : null,
  };
}

function createSummary(entries) {
  const directoryCount = entries.filter((entry) => entry.isDirectory).length;
  const fileCount = entries.filter((entry) => !entry.isDirectory).length;

  return {
    directoryCount,
    fileCount,
    totalCount: entries.length,
  };
}

function isProtectedRemotePath(remotePath) {
  const normalizedPath = normalizeRemotePath(remotePath);

  if (normalizedPath === "/") {
    return true;
  }

  return PROTECTED_REMOTE_PATHS.some((candidate) => candidate !== "/" && (normalizedPath === candidate || normalizedPath.startsWith(`${candidate}/`)));
}

function assertDangerousActionAllowed(remotePath, confirmed) {
  if (!isProtectedRemotePath(remotePath)) {
    return;
  }

  if (!confirmed) {
    throw new FileServiceError(
      `Protected path "${normalizeRemotePath(remotePath)}" requires explicit confirmation before deletion.`,
      {
        code: "FILES_CONFIRM_PROTECTED_PATH",
        status: 400,
      },
    );
  }
}

function mapFileOperationError(error, fallbackMessage) {
  if (error instanceof FileServiceError || error instanceof SshServiceError) {
    return error;
  }

  const message = trimValue(error?.message);
  const code = error?.code;

  if (code === "ENOENT" || code === 2 || /no such file|not found/i.test(message)) {
    return new FileServiceError("Remote path not found.", {
      code: "FILES_PATH_NOT_FOUND",
      status: 404,
    });
  }

  if (code === "EACCES" || code === "EPERM" || /permission denied|access denied/i.test(message)) {
    return new FileServiceError("Permission denied for that remote path.", {
      code: "FILES_PERMISSION_DENIED",
      status: 403,
    });
  }

  if (/failure/i.test(message) && fallbackMessage) {
    return new FileServiceError(fallbackMessage, {
      code: "FILES_OPERATION_FAILED",
      status: 400,
    });
  }

  return new FileServiceError(fallbackMessage || "Remote file operation failed.", {
    code: code || "FILES_OPERATION_FAILED",
    status: 400,
  });
}

function mapAgentFileOperationError(error, fallbackMessage) {
  if (error instanceof FileServiceError) {
    return error;
  }

  if (!(error instanceof AgentClientError)) {
    return mapFileOperationError(error, fallbackMessage);
  }

  const code = error?.payload?.error?.code || error.code || null;
  const details = error?.payload?.error?.details && typeof error.payload.error.details === "object"
    ? error.payload.error.details
    : {};
  const message = error?.payload?.error?.message || error.message || fallbackMessage || "Remote file operation failed.";

  const rootConfigurationCodes = new Set([
    "FILESYSTEM_ROOT_EMPTY",
    "FILESYSTEM_ROOT_INVALID",
    "FILESYSTEM_ROOT_MISSING",
    "FILESYSTEM_ROOT_UNREADABLE",
  ]);

  if (rootConfigurationCodes.has(code)) {
    return new FileServiceError(message, {
      code: `FILES_${code}`,
      status: error.status || 403,
      details,
    });
  }

  if (code === "PATH_NOT_FOUND") {
    return new FileServiceError(message || "Remote path not found.", {
      code: "FILES_PATH_NOT_FOUND",
      status: 404,
      details,
    });
  }

  if (code === "PATH_NOT_ALLOWED") {
    return new FileServiceError(message || "Permission denied for that remote path.", {
      code: "FILES_PERMISSION_DENIED",
      status: 403,
      details,
    });
  }

  if (code === "PATH_UNREADABLE" || code === "REALPATH_FAILED") {
    return new FileServiceError(message, {
      code: `FILES_${code}`,
      status: error.status || 400,
      details,
    });
  }

  if (code === "PATH_NOT_FILE") {
    return new FileServiceError("Only files can be downloaded from this view.", {
      code: "FILES_DOWNLOAD_FILE_ONLY",
      status: 400,
    });
  }

  if (code === "AGENT_TIMEOUT") {
    return new FileServiceError("Agent download timed out.", {
      code,
      status: 504,
    });
  }

  if (code === "AGENT_UNAVAILABLE") {
    return new FileServiceError("Agent unavailable. Check Agent settings.", {
      code,
      status: 503,
    });
  }

  return new FileServiceError(message, {
    code: code || "FILES_OPERATION_FAILED",
    status: error.status || 400,
    details,
  });
}

function detectTextSupport(buffer) {
  if (buffer.includes(0)) {
    return false;
  }

  try {
    TEXT_DECODER.decode(buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES)));
    return true;
  } catch {
    return false;
  }
}

function sortEntries(entries) {
  return entries.slice().sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    return String(left.name || "").localeCompare(String(right.name || ""), undefined, { sensitivity: "base" });
  });
}

function shouldUseLocalFiles(options = {}) {
  return getProviderType(options) === "renderer-local";
}

function getFileNodeConfig(options = {}) {
  const nodeId = trimValue(options.nodeId);
  if (!nodeId) return null;
  const node = getNode(nodeId);
  if (node?.enabled === false) {
    throw new FileServiceError("Selected node is disabled.", {
      code: "NODE_DISABLED",
      status: 403,
    });
  }
  return {
    ...getNodeAgentConfig(nodeId),
    nodeId,
    agentNodeId: nodeId,
  };
}

function getTransferNodeId(options = {}) {
  if (trimValue(options.nodeId)) return trimValue(options.nodeId);
  if (shouldUseLocalFiles(options)) return "application-host";
  return null;
}

function shouldUseNodeAgent(options = {}) {
  return getProviderType(options) === "agent-native";
}

function getProviderType(options = {}) {
  const explicit = trimValue(options.providerType).toLowerCase();
  if (["renderer-local", "agent-native", "sftp"].includes(explicit)) return explicit;
  if (explicit) throw new FileServiceError("Unknown filesystem provider type.", { code: "FILES_PROVIDER_INVALID", status: 400 });
  if (options.storageId === LOCAL_STORAGE_ID) return "renderer-local";
  if (trimValue(options.profileId) || (trimValue(options.storageId) && options.storageId !== LOCAL_STORAGE_ID)) return "sftp";
  if (trimValue(options.nodeId)) return "agent-native";
  throw new FileServiceError("Filesystem provider type is required.", { code: "FILES_PROVIDER_REQUIRED", status: 400 });
}

function getLocalHomePath() {
  return os.homedir() || process.env.USERPROFILE || process.cwd();
}

function normalizeLocalPath(inputPath, fallbackPath = getLocalHomePath()) {
  const fallback = path.resolve(trimValue(fallbackPath) || getLocalHomePath());
  const rawValue = trimValue(inputPath);
  if (!rawValue) {
    return fallback;
  }
  return path.resolve(rawValue.startsWith(path.sep) || /^[a-zA-Z]:[\\/]/.test(rawValue) ? rawValue : path.join(fallback, rawValue));
}

function buildLocalBreadcrumbs(currentPath) {
  const parsed = path.parse(currentPath);
  const root = parsed.root || path.sep;
  const relative = path.relative(root, currentPath);
  if (!relative) {
    return [];
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let runningPath = root;
  return parts.map((name) => {
    runningPath = path.join(runningPath, name);
    return { name, path: runningPath };
  });
}

function createLocalEntry(directoryPath, entry, stats) {
  return {
    name: entry.name,
    path: path.join(directoryPath, entry.name),
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    isDirectory: entry.isDirectory(),
    extension: entry.isFile() && entry.name.includes(".") ? entry.name.split(".").pop() : "",
    size: entry.isFile() ? stats.size : null,
    modifiedAt: stats.mtime ? stats.mtime.toISOString() : null,
    permissions: Number.isFinite(stats.mode) ? (stats.mode & 0o777).toString(8).padStart(3, "0") : null,
  };
}

class FileService extends EventEmitter {
  constructor() {
    super();
    this.profileLookup = createProfileLookup();
    this.sessions = new Map();
    this.transferControllers = new Map();
  }

  emitTransfer(event) {
    this.emit("transfer", {
      at: new Date().toISOString(),
      nodeId: event.nodeId || null,
      ...event,
    });
  }

  createTransferController(transferId, context = {}) {
    const id = trimValue(transferId);
    if (!id) {
      return null;
    }
    const controller = {
      id,
      canceled: false,
      streams: new Set(),
    };
    this.transferControllers.set(id, controller);
    // Tracked in the shared long-operation registry so concurrent transfers
    // are visible for locking/diagnostics and are not silently left "running"
    // forever if the app restarts mid-transfer.
    longOperations.upsertOperation(id, {
      kind: "file-transfer",
      nodeId: context.nodeId || null,
      status: "running",
      stage: context.type || null,
      canCancel: true,
      metadata: { path: context.path || null, type: context.type || null },
    });
    longOperations.registerCancelHandler(id, () => this.cancelTransfer(id));
    return controller;
  }

  attachTransferStream(controller, stream) {
    if (!controller || !stream) {
      return;
    }
    controller.streams.add(stream);
    stream.once("close", () => controller.streams.delete(stream));
  }

  cancelTransfer(transferId) {
    const id = trimValue(transferId);
    const controller = id ? this.transferControllers.get(id) : null;
    if (!controller) {
      return { id, canceled: false };
    }
    controller.canceled = true;
    for (const stream of controller.streams) {
      stream.destroy(new FileServiceError("Transfer canceled.", { code: "FILES_TRANSFER_CANCELED", status: 499 }));
    }
    this.emitTransfer({ id, status: "failed", message: "Canceled" });
    this.transferControllers.delete(id);
    if (longOperations.getOperation(id)) {
      longOperations.updateOperation(id, { status: "cancelled", canCancel: false });
    }
    return { id, canceled: true };
  }

  finishTransferController(controller) {
    if (controller?.id) {
      this.transferControllers.delete(controller.id);
      // Success/failure is already reported through transfer events; this only
      // clears the shared registry entry so it does not appear stuck "running".
      if (longOperations.getOperation(controller.id)?.status === "running") {
        longOperations.deleteOperation(controller.id);
      }
    }
  }

  getStorageConnection(storageId) {
    return getConnection(storageId || LOCAL_STORAGE_ID, { includeSecrets: true });
  }

  getProviderProfile(options = {}) {
    if (trimValue(options.storageId)) {
      const connection = this.getStorageConnection(options.storageId);
      if (connection.provider === "local" || connection.type === "local") {
        return { provider: "local", connection };
      }
      return {
        provider: "sftp",
        connection,
        profile: {
          id: connection.id,
          serverId: connection.id,
          displayName: connection.name || connection.displayName,
          host: connection.host,
          port: connection.port || 22,
          username: connection.username,
          authType: connection.authType || "password",
          rootDirectory: connection.rootDirectory || "/",
          password: connection.password || "",
          privateKey: connection.privateKey || "",
          passphrase: connection.passphrase || "",
        },
      };
    }
    return { provider: "sftp", profile: this.getProfile(options.profileId), connection: null };
  }

  getProfile(profileId) {
    if (!trimValue(profileId)) {
      throw new FileServiceError("SSH profile is required for remote file access.", {
        code: "FILES_PROFILE_REQUIRED",
        status: 400,
      });
    }

    return this.profileLookup.getProfile(profileId);
  }

  buildSftpConnectConfig(profile, options = {}) {
    const connectConfig = {
      host: profile.host,
      port: Number(profile.port) || 22,
      username: profile.username,
      readyTimeout: 12000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 2,
      tryKeyboard: false,
    };
    if (profile.authType === "privateKey") {
      if (profile.privateKey) {
        connectConfig.privateKey = profile.privateKey;
      } else {
        connectConfig.privateKey = fs.readFileSync(profile.privateKeyPath, "utf8");
      }
      if (profile.passphrase || options.passphrase) {
        connectConfig.passphrase = profile.passphrase || options.passphrase;
      }
    } else {
      const password = profile.password || (typeof options.password === "string" ? options.password : "");
      if (!password) {
        throw new SshServiceError("Password required for this SFTP connection.", {
          code: "SSH_PASSWORD_REQUIRED",
        });
      }
      connectConfig.password = password;
    }
    return connectConfig;
  }

  async ensureSession(options = {}) {
    const providerProfile = this.getProviderProfile(options);
    if (providerProfile.provider === "local") {
      throw new FileServiceError("Local provider does not use SFTP sessions.", { code: "FILES_LOCAL_SESSION_UNAVAILABLE" });
    }
    const profile = providerProfile.profile;
    const sessionKey = options.storageId ? `storage:${profile.id}` : `profile:${profile.id}`;
    const existingSession = this.sessions.get(sessionKey);

    if (existingSession?.connected && existingSession.sftp) {
      return existingSession;
    }

    if (existingSession) {
      this.destroySession(sessionKey);
    }

    const connectConfig = options.storageId ? this.buildSftpConnectConfig(profile, options) : this.profileLookup.buildConnectConfig(profile, options);
    const session = await new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const rejectOnce = (error) => {
        if (settled) {
          return;
        }

        settled = true;

        try {
          client.end();
          client.destroy();
        } catch {}

        reject(mapFileOperationError(error, "Remote file connection failed."));
      };

      client.on("ready", () => {
        client.sftp((error, sftp) => {
          if (error) {
            rejectOnce(error);
            return;
          }

          if (settled) {
            try {
              client.end();
              client.destroy();
            } catch {}
            return;
          }

          settled = true;
          resolve({
            id: sessionKey,
            profile,
            client,
            sftp,
            connected: true,
            storageId: options.storageId || null,
            provider: options.storageId ? "sftp" : "ssh-profile",
            homePath: profile.rootDirectory || getDefaultRemotePath(profile),
            currentPath: profile.rootDirectory || getDefaultRemotePath(profile),
            connectedAt: new Date().toISOString(),
          });
        });
      });

      client.on("error", rejectOnce);
      client.on("close", () => {
        const activeSession = this.sessions.get(sessionKey);

        if (activeSession?.client === client) {
          this.destroySession(sessionKey);
        }
      });

      client.connect(connectConfig);
    });

    this.sessions.set(sessionKey, session);
    return session;
  }

  destroySession(profileId) {
    const session = this.sessions.get(profileId);

    if (!session) {
      return;
    }

    session.connected = false;

    try {
      session.client?.end?.();
      session.client?.destroy?.();
    } catch {}

    this.sessions.delete(profileId);
  }

  disconnect(profileId, storageId = null) {
    const key = storageId ? `storage:${storageId}` : profileId?.startsWith?.("storage:") || profileId?.startsWith?.("profile:") ? profileId : `profile:${profileId}`;
    this.destroySession(key);
    return {
      profileId,
      storageId,
      connected: false,
    };
  }

  async identity(options = {}) {
    if (shouldUseNodeAgent(options)) {
      try {
        const identity = await getFilesystemIdentity(getFileNodeConfig(options));
        return {
          providerType: "agent-native",
          nodeId: options.nodeId || null,
          platform: identity.platform || "",
          hostname: identity.hostname || "",
          homeDirectory: identity.homeDirectory || identity.home || "/",
          rootPath: identity.rootPath || "/",
          filesystemRoot: identity.filesystemRoot || identity.rootPath || "/",
          filesystemRootStatus: identity.filesystemRootStatus || null,
          filesystemRoots: Array.isArray(identity.filesystemRoots) ? identity.filesystemRoots : [],
          filesystemRootExists: Boolean(identity.filesystemRootExists),
          filesystemRootReadable: Boolean(identity.filesystemRootReadable),
          homeInsideFilesystemRoot: Boolean(identity.homeInsideFilesystemRoot),
          initialPath: identity.initialPath || null,
          configSourceType: identity.configSourceType || null,
          restartRequired: Boolean(identity.restartRequired),
          pathSeparator: identity.pathSeparator || "/",
          roots: Array.isArray(identity.roots) ? identity.roots : [],
          shortcuts: Array.isArray(identity.shortcuts) ? identity.shortcuts : [],
          fileShortcuts: Array.isArray(identity.fileShortcuts) ? identity.fileShortcuts : Array.isArray(identity.shortcuts) ? identity.shortcuts : [],
          capabilities: identity.capabilities && typeof identity.capabilities === "object" ? identity.capabilities : {},
        };
      } catch (error) {
        throw mapAgentFileOperationError(error, "Node filesystem identity failed.");
      }
    }
    if (shouldUseLocalFiles(options)) {
      const homeDirectory = getLocalHomePath();
      return {
        providerType: "renderer-local",
        nodeId: options.nodeId || "application-host",
        platform: process.platform,
        hostname: os.hostname(),
        homeDirectory,
        rootPath: path.parse(homeDirectory).root || path.sep,
        filesystemRoot: path.parse(homeDirectory).root || path.sep,
        filesystemRootStatus: {
          status: "valid",
          code: "valid",
          exists: true,
          readable: true,
        },
        filesystemRoots: [],
        filesystemRootExists: true,
        filesystemRootReadable: true,
        homeInsideFilesystemRoot: true,
        initialPath: homeDirectory,
        configSourceType: "local",
        restartRequired: false,
        pathSeparator: path.sep,
        roots: [path.parse(homeDirectory).root || path.sep],
        shortcuts: [],
        fileShortcuts: [],
        capabilities: {},
      };
    }
    const providerProfile = this.getProviderProfile(options);
    const profile = providerProfile.profile || providerProfile.connection || {};
    const homeDirectory = profile.rootDirectory || getDefaultRemotePath(profile);
    return {
      providerType: "sftp",
      nodeId: options.nodeId || profile.nodeId || null,
      platform: "linux",
      hostname: profile.host || "",
      homeDirectory,
      rootPath: "/",
      filesystemRoot: homeDirectory,
      filesystemRootStatus: {
        status: "valid",
        code: "valid",
        exists: true,
        readable: true,
      },
      filesystemRoots: [],
      filesystemRootExists: true,
      filesystemRootReadable: true,
      homeInsideFilesystemRoot: true,
      initialPath: homeDirectory,
      configSourceType: "sftp-profile",
      restartRequired: false,
      pathSeparator: "/",
      roots: [homeDirectory],
      shortcuts: [],
      fileShortcuts: [],
      capabilities: {},
    };
  }

  async sftpCall(session, methodName, ...args) {
    return new Promise((resolve, reject) => {
      session.sftp[methodName](...args, (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      });
    });
  }

  async readRemoteBuffer(session, remotePath, size) {
    const handle = await this.sftpCall(session, "open", remotePath, "r");
    let position = 0;
    const chunks = [];

    try {
      while (position < size) {
        const nextLength = Math.min(READ_CHUNK_BYTES, size - position);
        const buffer = Buffer.alloc(nextLength);
        const bytesRead = await new Promise((resolve, reject) => {
          session.sftp.read(handle, buffer, 0, nextLength, position, (error, count) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(count);
          });
        });

        if (!bytesRead) {
          break;
        }

        chunks.push(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      try {
        await this.sftpCall(session, "close", handle);
      } catch {}
    }

    return Buffer.concat(chunks);
  }

  async writeRemoteBuffer(session, remotePath, buffer) {
    const temporaryPath = createRemoteTemporaryPath(remotePath);
    const handle = await this.sftpCall(session, "open", temporaryPath, "wx");
    let position = 0;

    try {
      while (position < buffer.length) {
        const nextChunk = buffer.subarray(position, position + READ_CHUNK_BYTES);
        await new Promise((resolve, reject) => {
          session.sftp.write(handle, nextChunk, 0, nextChunk.length, position, (error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
        position += nextChunk.length;
      }
      await this.sftpCall(session, "close", handle);
      await this.sftpCall(session, "rename", temporaryPath, remotePath);
      return;
    } catch (error) {
      await this.sftpCall(session, "unlink", temporaryPath).catch(() => {});
      throw error;
    } finally {
      try {
        await this.sftpCall(session, "close", handle);
      } catch {}
    }
  }

  async statRemotePath(session, remotePath) {
    return this.sftpCall(session, "stat", remotePath);
  }

  async lstatRemotePath(session, remotePath) {
    return this.sftpCall(session, "lstat", remotePath);
  }

  async list(options = {}) {
    if (shouldUseNodeAgent(options)) {
      try {
        const listing = await getFileListing(options.path || ".", getFileNodeConfig(options));
        return { ...listing, nodeId: options.nodeId, provider: "agent", providerBadge: "Node" };
      } catch (error) {
        throw mapAgentFileOperationError(error, "Node file listing failed.");
      }
    }
    if (shouldUseLocalFiles(options)) {
      return this.listLocal(options);
    }
    const session = await this.ensureSession(options);
    const targetPath = normalizeRemotePath(options.path, session.currentPath || session.homePath);

    try {
      const attrs = await this.statRemotePath(session, targetPath);

      if (getEntryTypeFromAttrs(attrs) !== "directory") {
        throw new FileServiceError("Remote path is not a directory.", {
          code: "FILES_PATH_NOT_DIRECTORY",
          status: 400,
        });
      }

      const entries = sortEntries((await this.sftpCall(session, "readdir", targetPath)).map((entry) => createEntry(targetPath, entry)));
      session.currentPath = targetPath;

      return {
        configured: true,
        connected: true,
        status: "connected",
        message: `Connected to ${profileLabel(session.profile)}.`,
        profileId: session.profile.id,
        storageId: session.storageId || null,
        provider: session.provider === "sftp" ? "sftp" : "ssh-profile",
        providerBadge: "SFTP",
        connectionName: session.profile.displayName || session.profile.host,
        currentPath: targetPath,
        homePath: session.homePath,
        roots: [
          {
            name: session.profile.displayName || session.profile.host,
            path: session.homePath,
          },
        ],
        breadcrumbs: buildBreadcrumbs(targetPath),
        entries,
        summary: createSummary(entries),
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote directory listing failed.");
    }
  }

  async listLocal(options = {}) {
    const targetPath = normalizeLocalPath(options.path, options.currentPath || getLocalHomePath());
    try {
      const stats = await fsPromises.stat(targetPath);
      if (!stats.isDirectory()) {
        throw new FileServiceError("Local path is not a directory.", {
          code: "FILES_PATH_NOT_DIRECTORY",
          status: 400,
        });
      }
      const entries = await Promise.all((await fsPromises.readdir(targetPath, { withFileTypes: true })).map(async (entry) => {
        const entryPath = path.join(targetPath, entry.name);
        let entryStats = null;
        try {
          entryStats = await fsPromises.stat(entryPath);
        } catch {
          entryStats = { size: null, mtime: null };
        }
        return createLocalEntry(targetPath, entry, entryStats);
      }));
      return {
        configured: true,
        connected: true,
        status: "connected",
        message: "Browsing files on this device.",
        profileId: null,
        storageId: LOCAL_STORAGE_ID,
        provider: "local",
        providerBadge: "Local",
        connectionName: "This Device",
        currentPath: targetPath,
        homePath: getLocalHomePath(),
        roots: [
          { name: "Home", path: getLocalHomePath() },
          { name: "Computer", path: path.parse(targetPath).root || path.sep },
        ],
        breadcrumbs: buildLocalBreadcrumbs(targetPath),
        entries: sortEntries(entries),
        summary: createSummary(entries),
        lastCheckedAt: new Date().toISOString(),
        local: true,
      };
    } catch (error) {
      throw mapFileOperationError(error, "Local directory listing failed.");
    }
  }

  async readText(options = {}) {
    if (shouldUseNodeAgent(options)) {
      try {
        return await readFileText(options.path, getFileNodeConfig(options));
      } catch (error) {
        throw mapAgentFileOperationError(error, "Node file read failed.");
      }
    }
    if (shouldUseLocalFiles(options)) {
      return this.readLocalText(options);
    }
    const session = await this.ensureSession(options);
    const remotePath = normalizeRemotePath(options.path, session.currentPath || session.homePath);

    try {
      const attrs = await this.statRemotePath(session, remotePath);

      if (getEntryTypeFromAttrs(attrs) !== "file") {
        throw new FileServiceError("Remote path is not a file.", {
          code: "FILES_PATH_NOT_FILE",
          status: 400,
        });
      }

      if (attrs.size > DEFAULT_TEXT_READ_LIMIT_BYTES) {
        return {
          path: remotePath,
          name: posixPath.basename(remotePath),
          size: attrs.size,
          modifiedAt: Number.isFinite(attrs.mtime) ? new Date(attrs.mtime * 1000).toISOString() : null,
          supported: false,
          reason: "file_too_large",
          content: null,
        };
      }

      const buffer = await this.readRemoteBuffer(session, remotePath, attrs.size);

      if (!detectTextSupport(buffer)) {
        return {
          path: remotePath,
          name: posixPath.basename(remotePath),
          size: attrs.size,
          modifiedAt: Number.isFinite(attrs.mtime) ? new Date(attrs.mtime * 1000).toISOString() : null,
          supported: false,
          reason: "binary_unsupported",
          content: null,
        };
      }

      return {
        path: remotePath,
        name: posixPath.basename(remotePath),
        size: attrs.size,
        modifiedAt: Number.isFinite(attrs.mtime) ? new Date(attrs.mtime * 1000).toISOString() : null,
        supported: true,
        content: buffer.toString("utf8"),
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote file read failed.");
    }
  }

  async readLocalText(options = {}) {
    const localPath = normalizeLocalPath(options.path, options.currentPath || getLocalHomePath());
    try {
      const stats = await fsPromises.stat(localPath);
      if (!stats.isFile()) {
        throw new FileServiceError("Local path is not a file.", {
          code: "FILES_PATH_NOT_FILE",
          status: 400,
        });
      }
      if (stats.size > DEFAULT_TEXT_READ_LIMIT_BYTES) {
        return {
          path: localPath,
          name: path.basename(localPath),
          size: stats.size,
          modifiedAt: stats.mtime ? stats.mtime.toISOString() : null,
          supported: false,
          reason: "file_too_large",
          content: null,
        };
      }
      const buffer = await fsPromises.readFile(localPath);
      if (!detectTextSupport(buffer)) {
        return {
          path: localPath,
          name: path.basename(localPath),
          size: stats.size,
          modifiedAt: stats.mtime ? stats.mtime.toISOString() : null,
          supported: false,
          reason: "binary_unsupported",
          content: null,
        };
      }
      return {
        path: localPath,
        name: path.basename(localPath),
        size: stats.size,
        modifiedAt: stats.mtime ? stats.mtime.toISOString() : null,
        supported: true,
        content: buffer.toString("utf8"),
      };
    } catch (error) {
      throw mapFileOperationError(error, "Local file read failed.");
    }
  }

  async writeText(options = {}) {
    if (shouldUseNodeAgent(options)) {
      return mutateFile({ action: "write", path: options.path, content: options.content || "" }, getFileNodeConfig(options));
    }
    if (shouldUseLocalFiles(options)) {
      const localPath = normalizeLocalPath(options.path, options.currentPath || getLocalHomePath());
      await commitLocalFile(
        localPath,
        (temporaryPath) => fsPromises.writeFile(temporaryPath, typeof options.content === "string" ? options.content : "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
      );
      return { path: localPath, saved: true };
    }
    const session = await this.ensureSession(options);
    const remotePath = normalizeRemotePath(options.path, session.currentPath || session.homePath);
    const content = typeof options.content === "string" ? options.content : "";

    try {
      await this.writeRemoteBuffer(session, remotePath, Buffer.from(content, "utf8"));
      return {
        path: remotePath,
        saved: true,
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote file save failed.");
    }
  }

  async mkdir(options = {}) {
    if (shouldUseNodeAgent(options)) {
      return mutateFile({ action: "mkdir", path: options.path }, getFileNodeConfig(options));
    }
    if (shouldUseLocalFiles(options)) {
      const localPath = normalizeLocalPath(options.path, options.currentPath || getLocalHomePath());
      await fsPromises.mkdir(localPath, { recursive: false });
      return { path: localPath, created: true };
    }
    const session = await this.ensureSession(options);
    const remotePath = normalizeRemotePath(options.path, session.currentPath || session.homePath);

    try {
      await this.sftpCall(session, "mkdir", remotePath);
      return {
        path: remotePath,
        created: true,
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote folder creation failed.");
    }
  }

  async rename(options = {}) {
    if (shouldUseNodeAgent(options)) {
      return mutateFile({ action: "rename", oldPath: options.oldPath, newPath: options.newPath }, getFileNodeConfig(options));
    }
    if (shouldUseLocalFiles(options)) {
      const oldPath = normalizeLocalPath(options.oldPath, options.currentPath || getLocalHomePath());
      const newPath = normalizeLocalPath(options.newPath, path.dirname(oldPath));
      await fsPromises.rename(oldPath, newPath);
      return { oldPath, newPath, renamed: true };
    }
    const session = await this.ensureSession(options);
    const oldPath = normalizeRemotePath(options.oldPath, session.currentPath || session.homePath);
    const newPath = normalizeRemotePath(options.newPath, posixPath.dirname(oldPath));

    try {
      await this.sftpCall(session, "rename", oldPath, newPath);
      return {
        oldPath,
        newPath,
        renamed: true,
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote rename failed.");
    }
  }

  async deletePathRecursive(session, remotePath) {
    const attrs = await this.lstatRemotePath(session, remotePath);
    const type = getEntryTypeFromAttrs(attrs);

    if (type === "directory") {
      const children = await this.sftpCall(session, "readdir", remotePath);

      for (const child of children) {
        const childPath = normalizeRemotePath(posixPath.join(remotePath, child.filename));
        await this.deletePathRecursive(session, childPath);
      }

      await this.sftpCall(session, "rmdir", remotePath);
      return;
    }

    await this.sftpCall(session, "unlink", remotePath);
  }

  async copy(options = {}) {
    if (shouldUseNodeAgent(options)) {
      return mutateFile({
        action: "copy",
        sourcePath: options.sourcePath || options.path,
        destinationPath: options.destinationPath || options.newPath,
        conflictPolicy: options.conflictPolicy,
      }, getFileNodeConfig(options));
    }
    if (shouldUseLocalFiles(options)) {
      const sourcePath = normalizeLocalPath(options.sourcePath || options.path, options.currentPath || getLocalHomePath());
      const destinationPath = normalizeLocalPath(options.destinationPath || options.newPath, path.dirname(sourcePath));
      await fsPromises.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: false });
      return { sourcePath, destinationPath, copied: true };
    }
    const session = await this.ensureSession(options);
    const sourcePath = normalizeRemotePath(options.sourcePath || options.path, session.currentPath || session.homePath);
    const destinationPath = normalizeRemotePath(options.destinationPath || options.newPath, posixPath.dirname(sourcePath));
    try {
      const attrs = await this.statRemotePath(session, sourcePath);
      if (getEntryTypeFromAttrs(attrs) !== "file") {
        throw new FileServiceError("Only files can be copied over SFTP in this view.", {
          code: "FILES_COPY_FILE_ONLY",
          status: 400,
        });
      }
      const buffer = await this.readRemoteBuffer(session, sourcePath, attrs.size || 0);
      await this.writeRemoteBuffer(session, destinationPath, buffer);
      return { sourcePath, destinationPath, copied: true };
    } catch (error) {
      throw mapFileOperationError(error, "Remote copy failed.");
    }
  }

  async newFile(options = {}) {
    const targetPath = options.path || options.filePath;
    return this.writeText({
      ...options,
      path: targetPath,
      content: options.content || "",
    });
  }

  async delete(options = {}) {
    if (shouldUseNodeAgent(options)) {
      return mutateFile({ action: "delete", path: options.path }, getFileNodeConfig(options));
    }
    if (shouldUseLocalFiles(options)) {
      const localPath = normalizeLocalPath(options.path, options.currentPath || getLocalHomePath());
      await fsPromises.rm(localPath, { recursive: true, force: false });
      return { path: localPath, deleted: true };
    }
    const session = await this.ensureSession(options);
    const remotePath = normalizeRemotePath(options.path, session.currentPath || session.homePath);
    assertDangerousActionAllowed(remotePath, Boolean(options.confirmDangerous));

    try {
      await this.deletePathRecursive(session, remotePath);
      return {
        path: remotePath,
        deleted: true,
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote delete failed.");
    }
  }

  async upload(options = {}) {
    const transferNodeId = getTransferNodeId(options);
    if (shouldUseNodeAgent(options)) {
      const selection = await showOpenDialog({ title: "Upload file to node", properties: ["openFile"] });
      if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
      const localPath = selection.filePaths[0];
      const remotePath = posixPath.join(options.directoryPath || "/", path.basename(localPath));
      if (options.conflictPolicy !== "replace") {
        const listing = await getFileListing(options.directoryPath || "/", getFileNodeConfig(options));
        if (Array.isArray(listing?.entries) && listing.entries.some((entry) => entry.name === path.basename(localPath))) {
          throw new FileServiceError("An item with that name already exists. Choose a different destination name or confirm replacement first.", {
            code: "FILES_CONFLICT",
            status: 409,
          });
        }
      }
      const buffer = await fsPromises.readFile(localPath);
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "upload", status: "running", path: remotePath, receivedBytes: 0, totalBytes: buffer.length, percent: 0 });
      const result = await mutateFile({ action: "upload", path: remotePath, content: buffer.toString("base64") }, getFileNodeConfig(options));
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "upload", status: "complete", path: remotePath, receivedBytes: buffer.length, totalBytes: buffer.length, percent: 100 });
      return { ...result, canceled: false, localPath, remotePath };
    }
    if (shouldUseLocalFiles(options)) {
      const targetDirectory = normalizeLocalPath(options.directoryPath, options.currentPath || getLocalHomePath());
      const selection = await showOpenDialog({
        title: "Import file to this device",
        properties: ["openFile"],
      });
      if (selection.canceled || !selection.filePaths[0]) {
        return { canceled: true };
      }
      const localPath = selection.filePaths[0];
      const destinationPath = path.join(targetDirectory, path.basename(localPath));
      if (options.conflictPolicy !== "replace" && await pathExists(destinationPath)) {
        throw new FileServiceError("An item with that name already exists. Choose a different destination name or confirm replacement first.", {
          code: "FILES_CONFLICT",
          status: 409,
        });
      }
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "upload", status: "running", path: destinationPath, percent: 20 });
      await commitLocalFile(destinationPath, (temporaryPath) => fsPromises.copyFile(localPath, temporaryPath, fs.constants.COPYFILE_EXCL), "upload");
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "upload", status: "complete", path: destinationPath, percent: 100 });
      return {
        canceled: false,
        localPath,
        remotePath: destinationPath,
        uploaded: true,
        local: true,
      };
    }
    const session = await this.ensureSession(options);
    const targetDirectory = normalizeRemotePath(options.directoryPath, session.currentPath || session.homePath);

    try {
      const selection = await showOpenDialog({
        title: "Upload file to remote server",
        properties: ["openFile"],
      });

      if (selection.canceled || !selection.filePaths[0]) {
        return {
          canceled: true,
        };
      }

      const localPath = selection.filePaths[0];
      const remotePath = normalizeRemotePath(posixPath.join(targetDirectory, path.basename(localPath)));
      if (options.conflictPolicy !== "replace") {
        try {
          await this.statRemotePath(session, remotePath);
          throw new FileServiceError("An item with that name already exists. Choose a different destination name or confirm replacement first.", {
            code: "FILES_CONFLICT",
            status: 409,
          });
        } catch (error) {
          if (error instanceof FileServiceError && error.code === "FILES_CONFLICT") {
            throw error;
          }
        }
      }
      const localSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
      const controller = this.createTransferController(options.transferId, { nodeId: transferNodeId, path: remotePath, type: "upload" });
      let transferredBytes = 0;
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "upload", status: "running", path: remotePath, receivedBytes: 0, totalBytes: localSize, percent: localSize > 0 ? 0 : null });

      const temporaryPath = createRemoteTemporaryPath(remotePath, "upload");
      try {
        const source = fs.createReadStream(localPath);
        const destination = session.sftp.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
        this.attachTransferStream(controller, source);
        this.attachTransferStream(controller, destination);
        source.on("data", (chunk) => {
          transferredBytes += chunk.length;
          this.emitTransfer({
            nodeId: transferNodeId,
            id: options.transferId || null,
            type: "upload",
            status: "running",
            path: remotePath,
            receivedBytes: transferredBytes,
            totalBytes: localSize,
            percent: localSize ? Math.round((transferredBytes / localSize) * 100) : null,
          });
        });
        await pipeline(source, destination);
        if (controller?.canceled) {
          throw new FileServiceError("Transfer canceled.", { code: "FILES_TRANSFER_CANCELED", status: 499 });
        }
        await this.sftpCall(session, "rename", temporaryPath, remotePath);
      } catch (error) {
        await this.sftpCall(session, "unlink", temporaryPath).catch(() => {});
        throw error;
      } finally {
        this.finishTransferController(controller);
      }
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "upload", status: "complete", path: remotePath, receivedBytes: localSize, totalBytes: localSize, percent: 100 });

      return {
        canceled: false,
        localPath,
        remotePath,
        uploaded: true,
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote upload failed.");
    }
  }

  async downloadFromAgent(remotePath, configOverride = null) {
    try {
      const selection = await showSaveDialog({
        title: "Download remote file",
        defaultPath: path.join(process.env.USERPROFILE || process.cwd(), posixPath.basename(remotePath)),
      });

      if (selection.canceled || !selection.filePath) {
        return {
          canceled: true,
        };
      }

      const response = await downloadFile(remotePath, configOverride);
      await commitLocalFile(selection.filePath, (temporaryPath) => fsPromises.writeFile(temporaryPath, response.buffer, { flag: "wx", mode: 0o600 }), "download");
      diagnostics.log("info", "files", "download-completed", "Download completed via agent.", { remotePath, localPath: selection.filePath, transport: "agent" }, { file: "files" });

      return {
        canceled: false,
        remotePath,
        localPath: selection.filePath,
        downloaded: true,
        transport: "agent",
      };
    } catch (error) {
      throw mapAgentFileOperationError(error, "Remote download failed.");
    }
  }

  async download(options = {}) {
    const transferNodeId = getTransferNodeId(options);
    if (shouldUseNodeAgent(options)) {
      return this.downloadFromAgent(options.path, getFileNodeConfig(options));
    }
    if (shouldUseLocalFiles(options)) {
      const localPath = normalizeLocalPath(options.path, options.currentPath || getLocalHomePath());
      const selection = await showSaveDialog({
        title: "Save local file copy",
        defaultPath: path.join(process.env.USERPROFILE || process.cwd(), path.basename(localPath)),
      });
      if (selection.canceled || !selection.filePath) {
        return { canceled: true };
      }
      await commitLocalFile(selection.filePath, (temporaryPath) => fsPromises.copyFile(localPath, temporaryPath, fs.constants.COPYFILE_EXCL), "download");
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "download", status: "complete", path: localPath, percent: 100 });
      return {
        canceled: false,
        remotePath: localPath,
        localPath: selection.filePath,
        downloaded: true,
        local: true,
      };
    }
    const session = await this.ensureSession(options);
    const remotePath = normalizeRemotePath(options.path, session.currentPath || session.homePath);

    try {
      const attrs = await this.statRemotePath(session, remotePath);

      if (getEntryTypeFromAttrs(attrs) !== "file") {
        throw new FileServiceError("Only files can be downloaded from this view.", {
          code: "FILES_DOWNLOAD_FILE_ONLY",
          status: 400,
        });
      }

      const selection = await showSaveDialog({
        title: "Download remote file",
        defaultPath: path.join(process.env.USERPROFILE || process.cwd(), posixPath.basename(remotePath)),
      });

      if (selection.canceled || !selection.filePath) {
        return {
          canceled: true,
        };
      }

      diagnostics.log("info", "files", "download-transport-selected", "Download transport selected: sftp.", { remotePath }, { file: "files" });
      const controller = this.createTransferController(options.transferId, { nodeId: transferNodeId, path: remotePath, type: "download" });
      let transferredBytes = 0;
      const temporaryPath = createLocalTemporaryPath(selection.filePath, "download");
      try {
        const source = session.sftp.createReadStream(remotePath);
        const destination = fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
        this.attachTransferStream(controller, source);
        this.attachTransferStream(controller, destination);
        source.on("data", (chunk) => {
          transferredBytes += chunk.length;
          this.emitTransfer({
            nodeId: transferNodeId,
            id: options.transferId || null,
            type: "download",
            status: "running",
            path: remotePath,
            receivedBytes: transferredBytes,
            totalBytes: attrs.size || 0,
            percent: attrs.size ? Math.round((transferredBytes / attrs.size) * 100) : null,
          });
        });
        await pipeline(source, destination);
        if (controller?.canceled) {
          throw new FileServiceError("Transfer canceled.", { code: "FILES_TRANSFER_CANCELED", status: 499 });
        }
        await fsPromises.rename(temporaryPath, selection.filePath);
      } catch (error) {
        await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      } finally {
        this.finishTransferController(controller);
      }
      this.emitTransfer({ nodeId: transferNodeId, id: options.transferId || null, type: "download", status: "complete", path: remotePath, receivedBytes: attrs.size || 0, totalBytes: attrs.size || 0, percent: 100 });

      return {
        canceled: false,
        remotePath,
        localPath: selection.filePath,
        downloaded: true,
      };
    } catch (error) {
      throw mapFileOperationError(error, "Remote download failed.");
    }
  }

  dispose() {
    for (const transferId of this.transferControllers.keys()) {
      this.cancelTransfer(transferId);
    }
    for (const profileId of this.sessions.keys()) {
      this.destroySession(profileId);
    }

    this.profileLookup.dispose();
  }
}

function profileLabel(profile) {
  return profile?.displayName || `${profile?.username || "user"}@${profile?.host || "server"}`;
}

module.exports = {
  FileService,
  FileServiceError,
  isProtectedRemotePath,
};
