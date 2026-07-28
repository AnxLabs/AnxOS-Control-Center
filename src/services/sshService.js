const { randomUUID } = require("crypto");
const { EventEmitter } = require("events");
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");
const { getAllNodesSync, getSelectedNodeId } = require("./nodeService");
const { redactString } = require("../shared/redaction");

const DEV_SSH_PROFILES_PATH = path.resolve(__dirname, "..", "..", "config", "ssh-profiles.json");
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const SHELL_START_TIMEOUT_MS = 15000;
const DEFAULT_SHELL_START_ATTEMPTS = 2;
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

function mapConnectionError(error) {
  const code = error?.level === "client-authentication" ? "SSH_AUTH_FAILED" : error?.code || null;
  const message = String(error?.message || "");

  if (
    code === "HOST_VERIFICATION_FAILED" ||
    code === "SSH_HOST_KEY_MISMATCH" ||
    /host key verification failed|host key mismatch|remote host identification has changed/i.test(message)
  ) {
    return new SshServiceError("Host key mismatch. Verify the server identity before connecting again.", {
      code: "SSH_HOST_KEY_MISMATCH",
    });
  }

  if (
    code === "SSH_AUTH_FAILED" ||
    /all configured authentication methods failed|authentication failed/i.test(message)
  ) {
    return new SshServiceError("Authentication failed. Check your username, password, or private key.", {
      code: "SSH_AUTH_FAILED",
    });
  }

  if (code === "EACCES" || /permission denied|publickey/i.test(message)) {
    return new SshServiceError("Permission denied. The account or key is not allowed to open this SSH session.", {
      code: "SSH_PERMISSION_DENIED",
    });
  }

  if (code === "ECONNREFUSED") {
    return new SshServiceError("Connection refused. Verify the SSH service is running on the target host.", {
      code: "SSH_CONNECTION_REFUSED",
    });
  }

  if (code === "ETIMEDOUT" || /timed out/i.test(message)) {
    return new SshServiceError("Connection timed out. The SSH host did not respond in time.", {
      code: "SSH_TIMEOUT",
    });
  }

  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENOTFOUND") {
    return new SshServiceError("Host unreachable. Check the host address and network connectivity.", {
      code: "SSH_HOST_UNREACHABLE",
    });
  }

  if (code === "ECONNRESET" || code === "EPIPE" || /socket hang up|connection reset/i.test(message)) {
    return new SshServiceError("SSH connection was interrupted by the remote host. AnxOS will retry when it is safe to do so.", {
      code: "SSH_CONNECTION_INTERRUPTED",
    });
  }

  if (code === "SSH_AGENT_UNAVAILABLE" || /agent.*(?:unavailable|not running|refused)/i.test(message)) {
    return new SshServiceError("SSH agent unavailable. Start or unlock the configured agent, then retry.", {
      code: "SSH_AGENT_UNAVAILABLE",
    });
  }

  return new SshServiceError("SSH connection failed.", {
    code: code || "SSH_CONNECTION_FAILED",
  });
}

function mapShellOpenError(error) {
  if (error) {
    const mapped = mapConnectionError(error);
    if (mapped.code && !/^SSH_CONNECTION/i.test(mapped.code)) {
      return mapped;
    }
  }
  return new SshServiceError("SSH connected, but remote shell could not be opened.", {
    code: "SSH_SHELL_OPEN_FAILED",
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
    },
  };
}

class SshService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.sessionIdsByProfileId = new Map();
    this.lastWriteDiagnostic = null;
    this.createClient = typeof options.createClient === "function" ? options.createClient : () => new Client();
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs)
      ? Math.max(1, options.connectTimeoutMs)
      : DEFAULT_CONNECT_TIMEOUT_MS;
    this.shellStartTimeoutMs = Number.isFinite(options.shellStartTimeoutMs)
      ? Math.max(1, options.shellStartTimeoutMs)
      : SHELL_START_TIMEOUT_MS;
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

    if (existingSession && !existingSession.didClose) {
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
      status: "connecting",
      message: "Connecting...",
      shellReady: false,
      didClose: false,
      phase: "tcp-connect",
      failureCode: null,
      connectTimer: null,
      shellStartTimer: null,
      shellDeadlineTimer: null,
      shellStartAttempt: 0,
    };

    this.sessions.set(sessionId, session);
    this.sessionIdsByProfileId.set(profile.id, sessionId);
    this.emit("session-updated", createSessionSnapshot(session));

    session.connectTimer = setTimeout(() => {
      if (!session.connectedAt && !session.didClose) {
        this.handleSessionFailure(sessionId, new SshServiceError("Connection timed out. The SSH host did not respond in time.", {
          code: "SSH_TIMEOUT",
        }));
      }
    }, this.connectTimeoutMs);

    client.on("ready", () => {
      if (session.connectTimer) {
        clearTimeout(session.connectTimer);
        session.connectTimer = null;
      }
      session.phase = "authenticating";
      session.connectedAt = new Date().toISOString();
      session.message = "Authenticated. Starting remote shell...";
      this.emit("session-updated", createSessionSnapshot(session));
      session.shellDeadlineTimer = setTimeout(() => {
        session.shellDeadlineTimer = null;
        if (session.shellReady || session.didClose) return;
        this.handleSessionFailure(sessionId, new SshServiceError("SSH authentication succeeded, but the remote shell did not start in time.", {
          code: "SSH_SHELL_START_TIMEOUT",
        }));
      }, this.shellStartTimeoutMs * DEFAULT_SHELL_START_ATTEMPTS);
      const openShell = () => {
        session.shellStartAttempt += 1;
        session.phase = session.shellStartAttempt > 1 ? "retrying-shell" : "waiting-shell";
        session.message = session.shellStartAttempt > 1
          ? "Remote shell was slow to start. Retrying automatically..."
          : "Waiting for remote shell...";
        this.emit("session-updated", createSessionSnapshot(session));
        const attemptTimer = setTimeout(() => {
          if (session.shellStartTimer === attemptTimer) {
            session.shellStartTimer = null;
          }
          if (session.shellReady || session.didClose) return;
          if (session.shellStartAttempt < DEFAULT_SHELL_START_ATTEMPTS) {
            openShell();
            return;
          }
          this.handleSessionFailure(sessionId, new SshServiceError("SSH authentication succeeded, but the remote shell did not start in time.", {
            code: "SSH_SHELL_START_TIMEOUT",
          }));
        }, this.shellStartTimeoutMs);
        session.shellStartTimer = attemptTimer;
        client.shell(
        {
          term: "xterm-256color",
          cols: Number.isFinite(options.cols) ? options.cols : DEFAULT_SHELL_COLS,
          rows: Number.isFinite(options.rows) ? options.rows : DEFAULT_SHELL_ROWS,
        },
        (error, stream) => {
          if (session.shellStartTimer === attemptTimer) {
            clearTimeout(attemptTimer);
            session.shellStartTimer = null;
          }
          if (session.didClose || !this.sessions.has(sessionId)) {
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

          session.status = "connected";
          session.phase = "shell-ready";
          session.shellReady = true;
          session.connectedAt = session.connectedAt || new Date().toISOString();
          session.shellReadyAt = new Date().toISOString();
          session.message = `Connected to ${session.label}. Shell ready.`;
          if (session.shellDeadlineTimer) {
            clearTimeout(session.shellDeadlineTimer);
            session.shellDeadlineTimer = null;
          }
          this.emit("session-updated", createSessionSnapshot(session));
          try {
            if (stream.writable !== false) stream.write("\r");
          } catch {}
        },
        );
      };
      openShell();
    });

    client.on("error", (error) => {
      this.handleSessionFailure(sessionId, mapConnectionError(error));
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

    session.status = "error";
    session.phase = "failed";
    session.failureCode = error.code || "SSH_CONNECTION_FAILED";
    session.message = redactString(error.message || "SSH connection failed.");
    this.emit("session-updated", createSessionSnapshot(session));
    this.emit("session-error", {
      sessionId,
      message: session.message,
      code: error.code || "SSH_CONNECTION_FAILED",
    });
    this.destroySession(sessionId);
  }

  handleSessionClosed(sessionId, message) {
    const session = this.sessions.get(sessionId);

    if (!session || session.didClose) {
      return;
    }

    session.status = "disconnected";
    session.message = message;
    this.emit("session-updated", createSessionSnapshot(session));
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

    if (session.shellStartTimer) {
      clearTimeout(session.shellStartTimer);
      session.shellStartTimer = null;
    }
    if (session.shellDeadlineTimer) {
      clearTimeout(session.shellDeadlineTimer);
      session.shellDeadlineTimer = null;
    }
    if (session.connectTimer) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
    }

    try {
      session.stream?.removeAllListeners();
      session.stream?.end?.();
    } catch {}

    try {
      session.client?.removeAllListeners();
      session.client?.end?.();
      session.client?.destroy?.();
    } catch {}

    if (session.profile?.id && this.sessionIdsByProfileId.get(session.profile.id) === sessionId) {
      this.sessionIdsByProfileId.delete(session.profile.id);
    }

    this.sessions.delete(sessionId);
  }

  disconnect(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SshServiceError("SSH session not found.", {
        code: "SSH_SESSION_NOT_FOUND",
      });
    }

    this.handleSessionClosed(sessionId, "SSH session disconnected.");
    return { sessionId };
  }

  write(sessionId, input) {
    const session = this.sessions.get(sessionId);
    const data = typeof input === "string" ? input : "";
    const byteLength = Buffer.byteLength(data, "utf8");

    if (!session || session.status !== "connected" || !session.stream || !session.shellReady) {
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

    if (!session || session.status !== "connected" || !session.stream?.setWindow) {
      return { sessionId };
    }

    const rows = Number.isFinite(size.rows) ? size.rows : DEFAULT_SHELL_ROWS;
    const cols = Number.isFinite(size.cols) ? size.cols : DEFAULT_SHELL_COLS;
    session.stream.setWindow(rows, cols, 0, 0);
    return { sessionId };
  }

  dispose() {
    [...this.sessions.keys()].forEach((sessionId) => {
      this.destroySession(sessionId);
    });

    this.removeAllListeners();
    this.sessionIdsByProfileId.clear();
  }
}

module.exports = {
  SSH_PROFILES_SCHEMA_VERSION,
  SSH_PROFILES_PATH: DEV_SSH_PROFILES_PATH,
  SshService,
  SshServiceError,
  _test: {
    buildProfileNodeMismatchDetails,
  },
};
