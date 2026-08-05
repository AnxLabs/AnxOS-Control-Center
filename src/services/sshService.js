const { createHash, randomUUID } = require("crypto");
const { EventEmitter } = require("events");
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");
const { getAllNodesSync, getSelectedNodeId } = require("./nodeService");
const { redactString } = require("../shared/redaction");

const DEV_SSH_PROFILES_PATH = path.resolve(__dirname, "..", "..", "config", "ssh-profiles.json");
const SSH_TIMEOUTS = Object.freeze({
  connect: 10000,
  authentication: 15000,
  shell: 15000,
});
const DEFAULT_SHELL_COLS = 120;
const DEFAULT_SHELL_ROWS = 32;
const VALID_AUTH_TYPES = new Set(["password", "privateKey"]);
const SSH_PROFILES_SCHEMA_VERSION = 1;

class SshServiceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SshServiceError";
    this.code = details.code || null;
    this.status = details.status || null;
    this.stage = details.stage || null;
    this.retryable = details.retryable !== false;
    this.technicalMessage = redactString(details.technicalMessage || message || "SSH operation failed.");
    this.platformCode = details.platformCode || null;
    this.details = details.details || null;
  }
}

function getDefaultProfilesConfig() {
  return {
    schemaVersion: SSH_PROFILES_SCHEMA_VERSION,
    servers: [
      {
        id: "debian-server",
        displayName: "Debian",
        host: "192.168.1.134",
      },
    ],
    profiles: [
      {
        id: "debian-anx",
        serverId: "debian-server",
        displayName: "Debian",
        host: "192.168.1.134",
        port: 22,
        username: "anx",
        authType: "password",
      },
    ],
    defaultServerId: "debian-server",
    defaultProfileId: "debian-anx",
  };
}

function slugify(value, fallback = "item") {
  const slug = trimValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || fallback;
}

function getProfilesPath() {
  if (process.env.ANXHUB_CONFIG_DIR) return path.join(process.env.ANXHUB_CONFIG_DIR, "ssh-profiles.json");
  if (app?.isPackaged) {
    return path.join(app.getPath("userData"), "config", "ssh-profiles.json");
  }

  return DEV_SSH_PROFILES_PATH;
}

function getSeedProfilesPath() {
  return DEV_SSH_PROFILES_PATH;
}

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : 22;
}

function normalizeAuthType(value) {
  const normalized = trimValue(value);
  return VALID_AUTH_TYPES.has(normalized) ? normalized : "password";
}

function ensureProfilesDirectory() {
  fs.mkdirSync(path.dirname(getProfilesPath()), { recursive: true });
}

function ensureProfilesFile() {
  ensureProfilesDirectory();
  const profilesPath = getProfilesPath();

  if (fs.existsSync(profilesPath)) {
    return;
  }

  const seedPath = getSeedProfilesPath();

  if (seedPath !== profilesPath && fs.existsSync(seedPath)) {
    fs.copyFileSync(seedPath, profilesPath);
    return;
  }

  fs.writeFileSync(
    profilesPath,
    `${JSON.stringify(getDefaultProfilesConfig(), null, 2)}\n`,
    "utf8",
  );
}

function normalizeServer(server, fallbackHost = "") {
  const host = trimValue(server?.host) || fallbackHost;
  const id = trimValue(server?.id) || (host ? host.replace(/[^a-z0-9]+/gi, "-").toLowerCase() : "");

  if (!id || !host) {
    return null;
  }

  return {
    id,
    displayName: trimValue(server?.displayName) || host,
    host,
    nodeId: trimValue(server?.nodeId) || null,
  };
}

function normalizeProfile(profile, serverMap) {
  const serverId = trimValue(profile?.serverId);
  const server = serverMap.get(serverId) || null;
  const host = trimValue(profile?.host) || server?.host || "";
  const id = trimValue(profile?.id) || (host ? `${host}-${trimValue(profile?.username || "user")}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase() : "");

  if (!id) {
    return null;
  }

  return {
    id,
    serverId: server?.id || serverId || null,
    displayName: trimValue(profile?.displayName) || `${trimValue(profile?.username) || "user"}@${host || "server"}`,
    host,
    port: normalizePort(profile?.port),
    username: trimValue(profile?.username),
    authType: normalizeAuthType(profile?.authType),
    privateKeyPath: trimValue(profile?.privateKeyPath) || null,
    nodeId: trimValue(profile?.nodeId) || server?.nodeId || null,
  };
}

function normalizeProfilesConfig(config = {}) {
  const defaultConfig = getDefaultProfilesConfig();
  const rawServers = Array.isArray(config.servers) ? config.servers : defaultConfig.servers;
  const servers = rawServers
    .map((server) => normalizeServer(server))
    .filter(Boolean);
  const serverMap = new Map(servers.map((server) => [server.id, server]));
  const rawProfiles = Array.isArray(config.profiles) ? config.profiles : defaultConfig.profiles;
  const profiles = rawProfiles
    .map((profile) => normalizeProfile(profile, serverMap))
    .filter(Boolean);

  return {
    schemaVersion: SSH_PROFILES_SCHEMA_VERSION,
    servers,
    profiles,
    defaultServerId: trimValue(config.defaultServerId) || profiles[0]?.serverId || servers[0]?.id || null,
    defaultProfileId: trimValue(config.defaultProfileId) || profiles[0]?.id || null,
  };
}

function readProfilesConfig() {
  ensureProfilesFile();
  const profilesPath = getProfilesPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SSH profiles root must be an object.");
  } catch (error) {
    const backupPath = `${profilesPath}.corrupt-${Date.now()}.backup`;
    try { fs.copyFileSync(profilesPath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw new SshServiceError("SSH profiles configuration is unreadable and was preserved for recovery.", { code: "SSH_PROFILES_CORRUPT", status: 500, cause: error });
  }
  const schemaVersion = parsed.schemaVersion === undefined ? 0 : Number(parsed.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) throw new SshServiceError("SSH profiles configuration has an invalid schema version.", { code: "SSH_PROFILES_SCHEMA_INVALID", status: 500 });
  if (schemaVersion > SSH_PROFILES_SCHEMA_VERSION) throw new SshServiceError("SSH profiles configuration was created by a newer application version.", { code: "SSH_PROFILES_SCHEMA_UNSUPPORTED", status: 500 });
  try {
    const config = normalizeProfilesConfig(parsed);
    const originalConfig = JSON.stringify(config);
    const agentNodes = getAllNodesSync().filter((node) => node.kind === "agent");
    const matchNodeId = (host) => agentNodes.find((node) => { try { return new URL(node.agentUrl).hostname === host; } catch { return false; } })?.id || null;
    config.servers = config.servers.map((server) => ({ ...server, nodeId: server.nodeId || matchNodeId(server.host) }));
    config.profiles = config.profiles.map((profile) => ({ ...profile, nodeId: profile.nodeId || config.servers.find((server) => server.id === profile.serverId)?.nodeId || matchNodeId(profile.host) }));

    if (schemaVersion < SSH_PROFILES_SCHEMA_VERSION) {
      const backupPath = `${profilesPath}.schema-v${schemaVersion}.backup`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(profilesPath, backupPath, fs.constants.COPYFILE_EXCL);
    }
    if (schemaVersion < SSH_PROFILES_SCHEMA_VERSION || JSON.stringify(config) !== originalConfig) {
      writeProfilesConfig(config);
    }
    return config;
  } catch (error) {
    if (error instanceof SshServiceError) throw error;
    throw new SshServiceError("SSH profiles configuration could not be normalized.", { code: "SSH_PROFILES_INVALID", status: 500, cause: error });
  }
}

function writeProfilesConfig(config) {
  ensureProfilesDirectory();
  const profilesPath = getProfilesPath();
  const temporaryPath = `${profilesPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalizeProfilesConfig(config), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, profilesPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw new SshServiceError("SSH profiles configuration could not be saved atomically.", { code: "SSH_PROFILES_WRITE_FAILED", status: 500, cause: error });
  }
}

function logSafeSshDebug(message, details = {}) {
  console.info(`[SSH Service] ${message}`, details);
}

function getSafeNodeSnapshot(nodeId) {
  const selectedNodeId = trimValue(nodeId || getSelectedNodeId());
  const nodes = getAllNodesSync();
  const node = nodes.find((candidate) => candidate.id === selectedNodeId) || null;
  let agentHost = null;
  try {
    agentHost = node?.agentUrl ? new URL(node.agentUrl).hostname : null;
  } catch {}
  return {
    selectedNodeId,
    selectedNodeName: node?.displayName || node?.name || selectedNodeId || null,
    selectedNodeHost: agentHost,
  };
}

function buildProfileNodeMismatchDetails(profile, nodeId) {
  const node = getSafeNodeSnapshot(nodeId);
  const profileHost = trimValue(profile?.host);
  const canAssignToSelectedNode = Boolean(
    !profile?.nodeId &&
    node.selectedNodeId &&
    profileHost &&
    node.selectedNodeHost &&
    profileHost.toLowerCase() === node.selectedNodeHost.toLowerCase()
  );
  return {
    ...node,
    profileId: profile?.id || null,
    profileName: profile?.displayName || null,
    profileNodeId: profile?.nodeId || null,
    host: profileHost || null,
    port: normalizePort(profile?.port),
    username: trimValue(profile?.username) || null,
    authType: profile?.authType || null,
    privateKeyPath: profile?.authType === "privateKey" ? Boolean(profile?.privateKeyPath) : null,
    mismatchBlocked: true,
    canAssignToSelectedNode,
    suggestedAction: canAssignToSelectedNode ? "assign-profile-to-selected-node" : "choose-profile-for-selected-node",
  };
}

function sanitizeProfile(profile) {
  if (!profile) {
    return null;
  }

  return {
    id: profile.id,
    serverId: profile.serverId,
    displayName: profile.displayName,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authType: profile.authType,
    privateKeyPath: profile.privateKeyPath,
    nodeId: profile.nodeId || null,
  };
}

function createSessionLabel(profile) {
  const host = trimValue(profile?.host) || "server";
  const username = trimValue(profile?.username) || "user";
  return trimValue(profile?.displayName) || `${username}@${host}`;
}

function mapConnectionError(error, stage = "connecting") {
  const code = error?.level === "client-authentication" ? "SSH_AUTH_FAILED" : error?.code || null;
  const message = String(error?.message || "");

  if (
    code === "HOST_VERIFICATION_FAILED" ||
    code === "SSH_HOST_KEY_MISMATCH" ||
    /host key verification failed|host key mismatch|remote host identification has changed/i.test(message)
  ) {
    return new SshServiceError("Host key mismatch. Verify the server identity before connecting again.", {
      code: "SSH_HOST_KEY_CHANGED", stage: "verifying-host", retryable: false, platformCode: code,
    });
  }

  if (
    code === "SSH_AUTH_FAILED" ||
    /all configured authentication methods failed|authentication failed/i.test(message)
  ) {
    return new SshServiceError("Authentication failed. Check your username, password, or private key.", {
      code: "SSH_AUTHENTICATION_FAILED", stage: "authenticating", retryable: true, platformCode: code,
    });
  }

  if (code === "EACCES" || /permission denied|publickey/i.test(message)) {
    return new SshServiceError("Permission denied. The account or key is not allowed to open this SSH session.", {
      code: "SSH_AUTHENTICATION_FAILED", stage: "authenticating", retryable: true, platformCode: code,
    });
  }

  if (code === "ECONNREFUSED") {
    return new SshServiceError("Connection refused. Verify the SSH service is running on the target host.", {
      code: "SSH_CONNECTION_REFUSED", stage: "connecting", platformCode: code,
    });
  }

  if (code === "ETIMEDOUT" || /timed out/i.test(message)) {
    return new SshServiceError("Connection timed out. The SSH host did not respond in time.", {
      code: stage === "authenticating" ? "SSH_AUTHENTICATION_TIMEOUT" : "SSH_CONNECTION_TIMEOUT", stage, platformCode: code,
    });
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new SshServiceError("The SSH hostname could not be resolved.", {
      code: "SSH_DNS_FAILED", stage: "resolving-host", platformCode: code,
    });
  }

  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return new SshServiceError("Host unreachable. Check the host address and network connectivity.", {
      code: "SSH_HOST_UNREACHABLE", stage: "connecting", platformCode: code,
    });
  }

  if (code === "ECONNRESET" || code === "EPIPE" || /socket hang up|connection reset/i.test(message)) {
    return new SshServiceError("SSH connection was interrupted by the remote host. AnxOS will retry when it is safe to do so.", {
      code: "SSH_CONNECTION_CLOSED", stage, platformCode: code,
    });
  }

  if (code === "SSH_AGENT_UNAVAILABLE" || /agent.*(?:unavailable|not running|refused)/i.test(message)) {
    return new SshServiceError("SSH agent unavailable. Start or unlock the configured agent, then retry.", {
      code: "SSH_AGENT_UNAVAILABLE",
    });
  }

  return new SshServiceError("SSH connection failed.", {
    code: "SSH_INTERNAL_ERROR", stage, platformCode: code, technicalMessage: message,
  });
}

function mapShellOpenError(error) {
  if (error) {
    const mapped = mapConnectionError(error, "opening-shell");
    if (["SSH_AUTHENTICATION_FAILED", "SSH_HOST_KEY_CHANGED", "SSH_CONNECTION_CLOSED"].includes(mapped.code)) {
      return mapped;
    }
  }
  return new SshServiceError("SSH connected, but remote shell could not be opened.", {
      code: "SSH_SHELL_OPEN_FAILED", stage: "opening-shell",
  });
}

function createSessionSnapshot(session) {
  return {
    id: session.id,
    profileId: session.profile.id,
    serverId: session.profile.serverId || null,
    nodeId: session.profile.nodeId || null,
    label: session.label,
    host: session.profile.host,
    port: session.profile.port,
    username: session.profile.username,
    status: session.status,
    message: session.message || "",
    connected: session.status === "connected",
    shellReady: Boolean(session.shellReady),
    createdAt: session.createdAt,
    connectedAt: session.connectedAt || null,
    shellReadyAt: session.shellReadyAt || null,
    diagnostics: {
      phase: session.phase || session.status,
      failureCode: session.failureCode || null,
      attemptId: session.attemptId,
      failedStage: session.failedStage || null,
      retryable: session.retryable !== false,
      createdAt: session.createdAt,
      stateChangedAt: session.stateChangedAt,
      timings: { ...session.timings },
      cleanup: session.cleanup ? { ...session.cleanup } : null,
    },
  };
}

function getKnownHostsPath() {
  return path.join(path.dirname(getProfilesPath()), "ssh-known-hosts.json");
}

function readKnownHosts() {
  try {
    const value = JSON.parse(fs.readFileSync(getKnownHostsPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new SshServiceError("Saved SSH host identities could not be read.", { code: "SSH_KNOWN_HOSTS_INVALID", retryable: false });
  }
}

function writeKnownHosts(value) {
  ensureProfilesDirectory();
  const target = getKnownHostsPath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

function fingerprintHostKey(key) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function knownHostId(profile) {
  return `${trimValue(profile.host).toLowerCase()}:${normalizePort(profile.port)}`;
}

const SSH_STATES = Object.freeze({
  IDLE: "idle", CONNECTING: "connecting", VERIFYING_HOST: "verifying-host",
  AUTHENTICATING: "authenticating", OPENING_SHELL: "opening-shell", CONNECTED: "connected",
  DISCONNECTING: "disconnecting", DISCONNECTED: "disconnected", CANCELLED: "cancelled", FAILED: "failed",
});
const TERMINAL_STATES = new Set([SSH_STATES.DISCONNECTED, SSH_STATES.CANCELLED, SSH_STATES.FAILED]);
const VALID_TRANSITIONS = new Map([
  [SSH_STATES.IDLE, new Set([SSH_STATES.CONNECTING])],
  [SSH_STATES.CONNECTING, new Set([SSH_STATES.VERIFYING_HOST, SSH_STATES.AUTHENTICATING, SSH_STATES.CANCELLED, SSH_STATES.FAILED, SSH_STATES.DISCONNECTED])],
  [SSH_STATES.VERIFYING_HOST, new Set([SSH_STATES.AUTHENTICATING, SSH_STATES.CANCELLED, SSH_STATES.FAILED])],
  [SSH_STATES.AUTHENTICATING, new Set([SSH_STATES.OPENING_SHELL, SSH_STATES.CANCELLED, SSH_STATES.FAILED, SSH_STATES.DISCONNECTED])],
  [SSH_STATES.OPENING_SHELL, new Set([SSH_STATES.CONNECTED, SSH_STATES.CANCELLED, SSH_STATES.FAILED, SSH_STATES.DISCONNECTED])],
  [SSH_STATES.CONNECTED, new Set([SSH_STATES.DISCONNECTING, SSH_STATES.DISCONNECTED, SSH_STATES.FAILED])],
  [SSH_STATES.DISCONNECTING, new Set([SSH_STATES.DISCONNECTED])],
]);

class SshService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.terminalSessions = new Map();
    this.sessionIdsByProfileId = new Map();
    this.lastWriteDiagnostic = null;
    this.createClient = typeof options.createClient === "function" ? options.createClient : () => new Client();
    this.pendingHostKeys = new Map();
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs)
      ? Math.max(1, options.connectTimeoutMs)
      : SSH_TIMEOUTS.connect;
    this.authenticationTimeoutMs = Number.isFinite(options.authenticationTimeoutMs)
      ? Math.max(1, options.authenticationTimeoutMs)
      : SSH_TIMEOUTS.authentication;
    this.shellStartTimeoutMs = Number.isFinite(options.shellStartTimeoutMs)
      ? Math.max(1, options.shellStartTimeoutMs)
      : SSH_TIMEOUTS.shell;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) return createSessionSnapshot(session);
    return this.terminalSessions.get(sessionId) || null;
  }

  approveHostKey(profileId, fingerprint) {
    const profile = this.getProfile(profileId);
    const pending = this.pendingHostKeys.get(profile.id);
    if (!pending || pending.fingerprint !== trimValue(fingerprint)) {
      throw new SshServiceError("The host-key approval is stale. Start a new connection attempt.", { code: "SSH_HOST_KEY_APPROVAL_STALE", stage: "verifying-host", retryable: true });
    }
    const knownHosts = readKnownHosts();
    knownHosts[knownHostId(profile)] = { fingerprint: pending.fingerprint, approvedAt: new Date().toISOString() };
    writeKnownHosts(knownHosts);
    this.pendingHostKeys.delete(profile.id);
    return { profileId: profile.id, fingerprint: pending.fingerprint, approved: true };
  }

  transition(session, nextState, message, details = {}) {
    if (!session || session.didClose || session.status === nextState) return false;
    const allowed = VALID_TRANSITIONS.get(session.status);
    if (!allowed?.has(nextState)) return false;
    const now = Date.now();
    if (session.stageStartedAt && session.phase) session.timings[session.phase] = now - session.stageStartedAt;
    session.status = nextState;
    session.phase = nextState;
    session.message = message || session.message;
    session.stateChangedAt = new Date(now).toISOString();
    session.stageStartedAt = now;
    if (details.failureCode) session.failureCode = details.failureCode;
    if (details.failedStage) session.failedStage = details.failedStage;
    if (typeof details.retryable === "boolean") session.retryable = details.retryable;
    this.emit("session-updated", createSessionSnapshot(session));
    return true;
  }

  setStageTimer(session, stage, timeoutMs, code, message) {
    this.clearStageTimer(session);
    session.stageTimer = setTimeout(() => {
      if (!this.isCurrentAttempt(session)) return;
      this.handleSessionFailure(session.id, new SshServiceError(message, { code, stage, retryable: true }));
    }, timeoutMs);
  }

  clearStageTimer(session) {
    if (session?.stageTimer) clearTimeout(session.stageTimer);
    if (session) session.stageTimer = null;
  }

  isCurrentAttempt(session) {
    return Boolean(session && !session.didClose && this.sessions.get(session.id)?.attemptId === session.attemptId);
  }

  recordWriteDiagnostic(details = {}) {
    this.lastWriteDiagnostic = {
      ...details,
      updatedAt: new Date().toISOString(),
    };
    return { ...this.lastWriteDiagnostic };
  }

  listProfiles() {
    const config = readProfilesConfig();
    const configPath = getProfilesPath();

    logSafeSshDebug("Profiles listed.", {
      configPath,
      profileCount: config.profiles.length,
      serverCount: config.servers.length,
    });

    return {
      servers: config.servers,
      profiles: config.profiles.map(sanitizeProfile),
      defaultServerId: config.defaultServerId,
      defaultProfileId: config.defaultProfileId,
      configPath,
    };
  }

  saveProfile(payload = {}) {
    const config = readProfilesConfig();
    const displayName = trimValue(payload.displayName || payload.name);
    const host = trimValue(payload.host);
    const username = trimValue(payload.username);
    const authType = normalizeAuthType(payload.authType);
    const privateKeyPath = trimValue(payload.privateKeyPath) || null;
    const port = normalizePort(payload.port);

    if (!displayName || !host || !username) {
      throw new SshServiceError("Name, host, port, and username are required.", {
        code: "SSH_PROFILE_FIELDS_REQUIRED",
      });
    }

    if (authType === "privateKey" && !privateKeyPath) {
      throw new SshServiceError("Private key path is required for key-based SSH profiles.", {
        code: "SSH_PROFILE_FIELDS_REQUIRED",
      });
    }

    const serverId = `${slugify(displayName, "server")}-server`;
    const profileId = `${slugify(displayName, "profile")}-${slugify(username, "user")}`;
    const nextServer = normalizeServer({
      id: serverId,
      displayName,
      host,
      nodeId: payload.nodeId || getSelectedNodeId(),
    });
    const nextProfile = normalizeProfile(
      {
        id: profileId,
        serverId,
        displayName,
        host,
        port,
        username,
        authType,
        privateKeyPath,
        nodeId: payload.nodeId || getSelectedNodeId(),
      },
      new Map(nextServer ? [[nextServer.id, nextServer]] : []),
    );

    this.validateProfile(nextProfile);

    const servers = config.servers.filter((server) => server.id !== serverId);
    const profiles = config.profiles.filter((profile) => profile.id !== profileId);

    if (nextServer) {
      servers.push(nextServer);
    }

    profiles.push(nextProfile);

    const nextConfig = {
      servers,
      profiles,
      defaultServerId: config.defaultServerId || nextServer?.id || null,
      defaultProfileId: nextProfile.id,
    };

    writeProfilesConfig(nextConfig);
    logSafeSshDebug("Profile saved.", {
      configPath: getProfilesPath(),
      profileId: nextProfile.id,
      profileName: nextProfile.displayName,
    });

    return {
      profile: sanitizeProfile(nextProfile),
      profiles: this.listProfiles(),
    };
  }

  assignProfileToNode(profileId, nodeId) {
    const config = readProfilesConfig();
    const selectedNode = getSafeNodeSnapshot(nodeId);
    if (!selectedNode.selectedNodeId) {
      throw new SshServiceError("Select a node before assigning this SSH profile.", {
        code: "SSH_NODE_REQUIRED",
      });
    }
    const profile = config.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new SshServiceError("SSH profile not found.", {
        code: "SSH_PROFILE_NOT_FOUND",
      });
    }
    const servers = config.servers.map((server) => (
      server.id === profile.serverId ? { ...server, nodeId: selectedNode.selectedNodeId } : server
    ));
    const profiles = config.profiles.map((candidate) => (
      candidate.id === profile.id ? { ...candidate, nodeId: selectedNode.selectedNodeId } : candidate
    ));
    writeProfilesConfig({ ...config, servers, profiles });
    logSafeSshDebug("Profile assigned to selected node.", {
      selectedNodeId: selectedNode.selectedNodeId,
      selectedNodeName: selectedNode.selectedNodeName,
      profileId: profile.id,
      profileName: profile.displayName,
      host: profile.host,
      port: normalizePort(profile.port),
      username: profile.username,
      authType: profile.authType,
      privateKeyPath: profile.authType === "privateKey" ? Boolean(profile.privateKeyPath) : null,
    });
    return this.listProfiles();
  }

  getProfile(profileId) {
    const config = readProfilesConfig();
    const profile = config.profiles.find((candidate) => candidate.id === profileId);

    if (!profile) {
      throw new SshServiceError("SSH profile not found.", {
        code: "SSH_PROFILE_NOT_FOUND",
      });
    }

    return profile;
  }

  validateProfile(profile) {
    const missingFields = [];

    if (!trimValue(profile.host)) {
      missingFields.push("host");
    }

    if (!normalizePort(profile.port)) {
      missingFields.push("port");
    }

    if (!trimValue(profile.username)) {
      missingFields.push("username");
    }

    if (!VALID_AUTH_TYPES.has(profile.authType)) {
      missingFields.push("authType");
    }

    if (profile.authType === "privateKey" && !trimValue(profile.privateKeyPath)) {
      missingFields.push("privateKeyPath");
    }

    if (missingFields.length > 0) {
      throw new SshServiceError(`SSH profile is missing required fields: ${missingFields.join(", ")}.`, {
        code: "SSH_PROFILE_FIELDS_REQUIRED",
      });
    }
  }

  buildConnectConfig(profile, options = {}) {
    this.validateProfile(profile);

    const connectConfig = {
      host: profile.host,
      port: normalizePort(profile.port),
      username: profile.username,
      readyTimeout: this.connectTimeoutMs,
      keepaliveInterval: 15000,
      keepaliveCountMax: 2,
      tryKeyboard: false,
    };

    if (profile.authType === "password") {
      const password = typeof options.password === "string" ? options.password : "";

      if (!password) {
        throw new SshServiceError("Password required for this SSH profile.", {
          code: "SSH_PASSWORD_REQUIRED",
        });
      }

      connectConfig.password = password;
      return connectConfig;
    }

    try {
      connectConfig.privateKey = fs.readFileSync(profile.privateKeyPath, "utf8");
    } catch {
      throw new SshServiceError("Private key file could not be read.", {
        code: "SSH_PRIVATE_KEY_READ_FAILED",
      });
    }

    if (typeof options.passphrase === "string" && options.passphrase) {
      connectConfig.passphrase = options.passphrase;
    }

    return connectConfig;
  }

  connect(options = {}) {
    const profile = this.getProfile(options.profileId);
    const requestedNode = getSafeNodeSnapshot(options.nodeId);
    logSafeSshDebug("Connection requested.", {
      selectedNodeId: requestedNode.selectedNodeId,
      selectedNodeName: requestedNode.selectedNodeName,
      profileId: profile.id,
      profileName: profile.displayName,
      profileNodeId: profile.nodeId || null,
      host: profile.host,
      port: normalizePort(profile.port),
      username: profile.username,
      authType: profile.authType,
      privateKeyPath: profile.authType === "privateKey" ? Boolean(profile.privateKeyPath) : null,
      mismatchBlocked: Boolean(!requestedNode.selectedNodeId || profile.nodeId !== requestedNode.selectedNodeId),
    });
    if (!requestedNode.selectedNodeId || profile.nodeId !== requestedNode.selectedNodeId) {
      const details = buildProfileNodeMismatchDetails(profile, requestedNode.selectedNodeId);
      logSafeSshDebug("Connection blocked by profile/node mismatch.", details);
      const error = new SshServiceError(
        "This SSH profile is not assigned to the selected node. Reassign it to Anxlab or choose another profile.",
        { code: "SSH_NODE_MISMATCH" },
      );
      error.details = details;
      throw error;
    }
    const existingSessionId = this.sessionIdsByProfileId.get(profile.id);
    const existingSession = existingSessionId ? this.sessions.get(existingSessionId) || null : null;

    if (existingSession && !existingSession.didClose && !TERMINAL_STATES.has(existingSession.status)) {
      return createSessionSnapshot(existingSession);
    }

    const connectConfig = this.buildConnectConfig(profile, options);
    const sessionId = randomUUID();
    const client = this.createClient();
    const session = {
      id: sessionId,
      client,
      stream: null,
      profile,
      label: createSessionLabel(profile),
      createdAt: new Date().toISOString(),
      connectedAt: null,
      shellReadyAt: null,
      attemptId: randomUUID(),
      status: SSH_STATES.IDLE,
      message: "Preparing SSH connection...",
      shellReady: false,
      didClose: false,
      phase: "tcp-connect",
      failureCode: null,
      stateChangedAt: new Date().toISOString(),
      stageStartedAt: Date.now(),
      stageTimer: null,
      timings: {},
      retryable: true,
      cleanup: null,
    };

    this.sessions.set(sessionId, session);
    this.sessionIdsByProfileId.set(profile.id, sessionId);
    this.transition(session, SSH_STATES.CONNECTING, "Connecting to SSH host...");
    this.setStageTimer(session, "connecting", this.connectTimeoutMs, "SSH_CONNECTION_TIMEOUT", "Connection timed out before the SSH handshake completed.");

    const knownFingerprint = readKnownHosts()[knownHostId(profile)]?.fingerprint || null;
    connectConfig.hostVerifier = (key) => {
      if (!this.isCurrentAttempt(session)) return false;
      const fingerprint = fingerprintHostKey(key);
      if (!knownFingerprint) {
        session.pendingHostKey = { fingerprint };
        this.pendingHostKeys.set(profile.id, { fingerprint, capturedAt: new Date().toISOString() });
        this.transition(session, SSH_STATES.VERIFYING_HOST, "Host-key approval required.");
        return false;
      }
      if (knownFingerprint !== fingerprint) {
        session.changedHostKey = { expected: knownFingerprint, received: fingerprint };
        this.transition(session, SSH_STATES.VERIFYING_HOST, "The saved host identity does not match.");
        return false;
      }
      return true;
    };

    client.on("handshake", () => {
      if (!this.isCurrentAttempt(session)) return;
      this.transition(session, SSH_STATES.AUTHENTICATING, "Authenticating SSH credentials...");
      this.setStageTimer(session, "authenticating", this.authenticationTimeoutMs, "SSH_AUTHENTICATION_TIMEOUT", "SSH authentication did not complete in time.");
    });

    client.on("ready", () => {
      if (!this.isCurrentAttempt(session)) return;
      this.clearStageTimer(session);
      if (session.status === SSH_STATES.CONNECTING || session.status === SSH_STATES.VERIFYING_HOST) {
        this.transition(session, SSH_STATES.AUTHENTICATING, "SSH credentials accepted.");
      }
      session.connectedAt = new Date().toISOString();
      this.transition(session, SSH_STATES.OPENING_SHELL, "Opening remote terminal...");
      this.setStageTimer(session, "opening-shell", this.shellStartTimeoutMs, "SSH_SHELL_OPEN_TIMEOUT", "SSH authentication succeeded, but the remote terminal did not open in time.");
      client.shell(
        {
          term: "xterm-256color",
          cols: Number.isFinite(options.cols) ? options.cols : DEFAULT_SHELL_COLS,
          rows: Number.isFinite(options.rows) ? options.rows : DEFAULT_SHELL_ROWS,
        },
        (error, stream) => {
          this.clearStageTimer(session);
          if (!this.isCurrentAttempt(session)) {
            try {
              stream?.removeAllListeners?.();
              stream?.end?.();
              stream?.destroy?.();
            } catch {}
            return;
          }
          if (error) {
            this.handleSessionFailure(sessionId, mapShellOpenError(error));
            return;
          }
          if (!stream || stream.writable === false) {
            this.handleSessionFailure(sessionId, new SshServiceError("SSH connected, but remote shell could not be opened.", {
              code: "SSH_SHELL_OPEN_FAILED",
            }));
            return;
          }

          session.stream = stream;
          stream.on("data", (chunk) => {
            this.emit("session-output", {
              sessionId,
              chunk: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
            });
          });

          stream.on("close", () => {
            this.handleSessionClosed(sessionId, "SSH session closed.");
          });

          session.shellReady = true;
          session.connectedAt = session.connectedAt || new Date().toISOString();
          session.shellReadyAt = new Date().toISOString();
          session.message = `Connected to ${session.label}. Shell ready.`;
          this.transition(session, SSH_STATES.CONNECTED, session.message);
          try {
            if (stream.writable !== false) stream.write("\r");
          } catch {}
        },
        );
    });

    client.on("error", (error) => {
      if (!this.isCurrentAttempt(session)) return;
      if (session.pendingHostKey) {
        this.handleSessionFailure(sessionId, new SshServiceError("This SSH host is not trusted yet. Review and approve its fingerprint before retrying.", {
          code: "SSH_HOST_KEY_UNKNOWN", stage: "verifying-host", retryable: true,
          details: { fingerprint: session.pendingHostKey.fingerprint },
        }));
        return;
      }
      if (session.changedHostKey) {
        this.handleSessionFailure(sessionId, new SshServiceError("The SSH host key changed. Verify the server identity before connecting again.", {
          code: "SSH_HOST_KEY_CHANGED", stage: "verifying-host", retryable: false,
          details: { expectedFingerprint: session.changedHostKey.expected, receivedFingerprint: session.changedHostKey.received },
        }));
        return;
      }
      this.handleSessionFailure(sessionId, mapConnectionError(error, session.phase));
    });

    client.on("close", () => {
      this.handleSessionClosed(sessionId, "SSH session disconnected.");
    });

    client.connect(connectConfig);

    return createSessionSnapshot(session);
  }

  handleSessionFailure(sessionId, error) {
    const session = this.sessions.get(sessionId);

    if (!session || session.didClose) {
      return;
    }

    const failedStage = error.stage || session.phase;
    session.failureCode = error.code || "SSH_INTERNAL_ERROR";
    session.failedStage = failedStage;
    session.retryable = error.retryable !== false;
    session.message = redactString(error.message || "SSH connection failed.");
    this.transition(session, SSH_STATES.FAILED, session.message, { failureCode: session.failureCode, failedStage, retryable: session.retryable });
    this.emit("session-error", {
      sessionId,
      attemptId: session.attemptId,
      profileId: session.profile.id,
      message: session.message,
      technicalMessage: error.technicalMessage,
      code: session.failureCode,
      failedStage,
      retryable: session.retryable,
      timestamp: new Date().toISOString(),
      platformCode: error.platformCode,
      details: error.details,
    });
    this.destroySession(sessionId);
  }

  handleSessionClosed(sessionId, message) {
    const session = this.sessions.get(sessionId);

    if (!session || session.didClose) {
      return;
    }

    this.transition(session, SSH_STATES.DISCONNECTED, message);
    this.emit("session-closed", {
      sessionId,
      message,
    });
    this.destroySession(sessionId);
  }

  destroySession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session || session.didClose) {
      return;
    }

    session.didClose = true;

    this.clearStageTimer(session);

    try {
      session.stream?.removeAllListeners();
      session.stream?.end?.();
      session.stream?.destroy?.();
    } catch {}

    session.cleanup = { timersCleared: true, streamClosed: true, clientClosed: true, completedAt: new Date().toISOString() };

    try {
      session.client?.removeAllListeners();
      session.client?.end?.();
      session.client?.destroy?.();
    } catch {}

    this.terminalSessions.set(sessionId, createSessionSnapshot(session));
    while (this.terminalSessions.size > 50) {
      this.terminalSessions.delete(this.terminalSessions.keys().next().value);
    }

    if (session.profile?.id && this.sessionIdsByProfileId.get(session.profile.id) === sessionId) {
      this.sessionIdsByProfileId.delete(session.profile.id);
    }

    this.sessions.delete(sessionId);
  }

  deleteProfile(profileId) {
    const id = trimValue(profileId);
    const config = readProfilesConfig();
    const profile = config.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      throw new SshServiceError("SSH profile not found.", { code: "SSH_PROFILE_NOT_FOUND" });
    }
    const activeSessionId = this.sessionIdsByProfileId.get(id);
    const activeSession = activeSessionId ? this.sessions.get(activeSessionId) : null;
    if (activeSession && !activeSession.didClose && !TERMINAL_STATES.has(activeSession.status)) {
      throw new SshServiceError("Disconnect this SSH profile before deleting it.", {
        code: "SSH_PROFILE_IN_USE",
        retryable: true,
      });
    }
    const profiles = config.profiles.filter((candidate) => candidate.id !== id);
    const serverStillUsed = profiles.some((candidate) => candidate.serverId === profile.serverId);
    const servers = serverStillUsed ? config.servers : config.servers.filter((server) => server.id !== profile.serverId);
    writeProfilesConfig({
      ...config,
      profiles,
      servers,
      defaultProfileId: config.defaultProfileId === id ? profiles[0]?.id || null : config.defaultProfileId,
      defaultServerId: config.defaultServerId === profile.serverId && !serverStillUsed ? servers[0]?.id || null : config.defaultServerId,
    });
    this.terminalSessions.forEach((session, sessionId) => {
      if (session.profileId === id) this.terminalSessions.delete(sessionId);
    });
    return this.listProfiles();
  }

  disconnect(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return { sessionId, status: SSH_STATES.DISCONNECTED, alreadyClosed: true };
    }

    if ([SSH_STATES.CONNECTING, SSH_STATES.VERIFYING_HOST, SSH_STATES.AUTHENTICATING, SSH_STATES.OPENING_SHELL].includes(session.status)) {
      this.transition(session, SSH_STATES.CANCELLED, "SSH connection cancelled.", { failureCode: "SSH_CANCELLED", failedStage: session.phase, retryable: true });
      this.emit("session-error", { sessionId, attemptId: session.attemptId, profileId: session.profile.id, code: "SSH_CANCELLED", message: "SSH connection cancelled.", technicalMessage: "Connection attempt cancelled by user.", failedStage: session.phase, retryable: true, timestamp: new Date().toISOString(), platformCode: null });
      this.destroySession(sessionId);
      return { sessionId, attemptId: session.attemptId, status: SSH_STATES.CANCELLED };
    }
    if (session.status === SSH_STATES.CONNECTED) this.transition(session, SSH_STATES.DISCONNECTING, "Disconnecting SSH session...");
    this.handleSessionClosed(sessionId, "SSH session disconnected.");
    return { sessionId, attemptId: session.attemptId, status: SSH_STATES.DISCONNECTED };
  }

  write(sessionId, input) {
    const session = this.sessions.get(sessionId);
    const data = typeof input === "string" ? input : "";
    const byteLength = Buffer.byteLength(data, "utf8");

    if (!session || session.status !== SSH_STATES.CONNECTED || !session.stream || !session.shellReady) {
      this.recordWriteDiagnostic({
        ipcReceived: true,
        sessionFound: Boolean(session),
        streamExists: Boolean(session?.stream),
        shellReady: Boolean(session?.shellReady),
        streamWritable: false,
        byteLength,
        accepted: false,
        rejectedCategory: session && session.status === "connected" && !session.shellReady ? "SSH_SHELL_NOT_READY" : "SSH_SESSION_NOT_CONNECTED",
      });
      throw new SshServiceError(session && session.status === "connected"
        ? "Command could not be sent because the SSH shell is not ready."
        : "SSH session is not connected.", {
        code: session && session.status === "connected" ? "SSH_SHELL_NOT_READY" : "SSH_SESSION_NOT_CONNECTED",
      });
    }

    if (session.stream.writable === false) {
      this.recordWriteDiagnostic({
        ipcReceived: true,
        sessionFound: true,
        streamExists: true,
        shellReady: true,
        streamWritable: false,
        byteLength,
        accepted: false,
        rejectedCategory: "SSH_STREAM_NOT_WRITABLE",
      });
      throw new SshServiceError("SSH session input stream is not writable.", {
        code: "SSH_STREAM_NOT_WRITABLE",
      });
    }

    if (!data) {
      this.recordWriteDiagnostic({
        ipcReceived: true,
        sessionFound: true,
        streamExists: true,
        shellReady: true,
        streamWritable: session.stream.writable !== false,
        byteLength,
        accepted: false,
        rejectedCategory: "EMPTY_DATA",
      });
      return { sessionId };
    }

    session.stream.write(data);
    this.recordWriteDiagnostic({
      ipcReceived: true,
      sessionFound: true,
      streamExists: true,
      shellReady: true,
      streamWritable: session.stream.writable !== false,
      byteLength,
      accepted: true,
      rejectedCategory: null,
    });
    return { sessionId };
  }

  resize(sessionId, size = {}) {
    const session = this.sessions.get(sessionId);

    if (!session || session.status !== SSH_STATES.CONNECTED || !session.stream?.setWindow) {
      return { sessionId };
    }

    const rows = Number.isFinite(size.rows) ? Math.max(12, Math.min(300, Math.floor(size.rows))) : DEFAULT_SHELL_ROWS;
    const cols = Number.isFinite(size.cols) ? Math.max(40, Math.min(500, Math.floor(size.cols))) : DEFAULT_SHELL_COLS;
    session.stream.setWindow(rows, cols, 0, 0);
    return { sessionId };
  }

  dispose() {
    [...this.sessions.keys()].forEach((sessionId) => {
      this.destroySession(sessionId);
    });

    this.removeAllListeners();
    this.sessionIdsByProfileId.clear();
    this.pendingHostKeys.clear();
  }
}

module.exports = {
  SSH_PROFILES_SCHEMA_VERSION,
  SSH_PROFILES_PATH: DEV_SSH_PROFILES_PATH,
  SshService,
  SshServiceError,
  _test: {
    buildProfileNodeMismatchDetails,
    SSH_STATES,
    SSH_TIMEOUTS,
    VALID_TRANSITIONS,
  },
};
