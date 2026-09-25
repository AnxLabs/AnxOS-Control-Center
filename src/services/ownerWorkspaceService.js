const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, shell, session, Notification } = require("electron");
const { getStatus, requireOwner, audit } = require("./securityService");
const { getSystemSnapshot } = require("./systemService");
const { getAgentConfigPath, readAgentSettings, testConnection } = require("./agentClient");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../shared/migrationRecoveryPolicy");

const WORKSPACE_VERSION = 1;
const REDACTED = "[redacted]";
const BUILT_IN_PAGES = [
  ["overview", "Overview", "grid", "#b66cff"],
  ["notes", "Notes", "note", "#45e08f"],
  ["scratchpad", "Scratchpad", "pen", "#f5c451"],
  ["ui-sandbox", "UI Sandbox", "layout", "#61dafb"],
  ["feature-flags", "Feature Flags", "flag", "#ff8bd1"],
  ["api-tester", "API Tester", "plug", "#8ab4ff"],
  ["internal-analytics", "Internal Analytics", "chart", "#45e08f"],
  ["command-center", "Command Center", "terminal", "#ff6b8a"],
  ["json-editor", "JSON Editor", "braces", "#d8b4fe"],
  ["log-viewer", "Log Viewer", "file", "#f5c451"],
].map(([id, title, icon, accent]) => ({
  id,
  title,
  icon,
  accent,
  builtIn: true,
  pinned: true,
  contentType: "markdown",
}));

const DEFAULT_FLAGS = [
  {
    name: "ownerWorkspace.enabled",
    description: "Enables the private Owner Workspace shell.",
    environment: "local",
    productionSafe: true,
    requiresRestart: false,
    defaultValue: true,
  },
  {
    name: "account.webDeviceLogin",
    description: "Shows the optional Sign in with AnxOS device authorization flow.",
    environment: "local",
    productionSafe: true,
    requiresRestart: false,
    defaultValue: true,
  },
  {
    name: "dev.mockData",
    description: "Allows generated local mock content for UI testing.",
    environment: "development",
    productionSafe: false,
    requiresRestart: false,
    defaultValue: false,
  },
];

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) {
    return process.env.ANXHUB_CONFIG_DIR;
  }
  try {
    return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config");
  } catch {
    return path.join(process.cwd(), "config");
  }
}

function getWorkspaceDirectory() {
  return path.join(getConfigDirectory(), "owner-workspace");
}

function getWorkspacePath() {
  return path.join(getWorkspaceDirectory(), "workspace.json");
}

function safeIso() {
  return new Date().toISOString();
}

function createDefaultState() {
  const now = safeIso();
  return {
    version: WORKSPACE_VERSION,
    createdAt: now,
    updatedAt: now,
    builtInPages: BUILT_IN_PAGES,
    customPages: [],
    selectedPageId: "overview",
    contents: {
      overview: {
        markdown: "",
        updatedAt: now,
      },
      notes: {
        markdown: "# Notes\n\n",
        updatedAt: now,
      },
      scratchpad: {
        markdown: "",
        updatedAt: now,
      },
      "json-editor": {
        json: "{}",
        updatedAt: now,
      },
      "ui-sandbox": {
        markdown: "",
        updatedAt: now,
      },
    },
    flagOverrides: {},
    apiHistory: [],
  };
}

function normalizeState(raw) {
  const base = createDefaultState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const next = {
    ...base,
    ...raw,
    builtInPages: BUILT_IN_PAGES,
    customPages: Array.isArray(raw.customPages) ? raw.customPages : [],
    selectedPageId: typeof raw.selectedPageId === "string" ? raw.selectedPageId : base.selectedPageId,
    contents: raw.contents && typeof raw.contents === "object" ? { ...base.contents, ...raw.contents } : base.contents,
    flagOverrides: raw.flagOverrides && typeof raw.flagOverrides === "object" ? raw.flagOverrides : {},
    apiHistory: Array.isArray(raw.apiHistory) ? raw.apiHistory.slice(0, 50) : [],
  };
  const knownPages = new Set([...next.builtInPages, ...next.customPages].map((page) => page.id));
  if (!knownPages.has(next.selectedPageId)) {
    next.selectedPageId = "overview";
  }
  return next;
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

// V2-J bullet 6 addendum: a STRUCTURAL repair (schema version already current
// but the record shape differs) rewrites the operator's pages, notes and API
// history with no schema-version transition for the recovery policy to decide
// on, so the read-back verification is applied directly. A fresh
// `.pre-repair.backup` copy must be byte-identical to the pre-repair file; a
// pre-existing copy is never overwritten (one-time — it holds the oldest
// pre-repair state) and is accepted once it reads back as a parseable
// workspace object, because later repairs legitimately follow operator edits.
// This path is additive: it fails closed only when no verified recovery point
// can be produced or read back.
function takePreRepairRecoveryPoint(filePath, originalBytes) {
  const backupPath = `${filePath}.pre-repair.backup`;
  const backupExisted = fs.existsSync(backupPath);
  if (!backupExisted) {
    try {
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      throw Object.assign(new Error("Owner Workspace structural repair was refused because the pre-repair recovery point could not be written."), {
        code: "OWNER_WORKSPACE_PRE_REPAIR_RECOVERY_UNAVAILABLE",
        details: { causeCode: error?.code || "COPY_FAILED" },
      });
    }
  }
  let recoveryBytes = null;
  try {
    recoveryBytes = fs.readFileSync(backupPath);
  } catch {
    recoveryBytes = null;
  }
  const verification = backupExisted
    ? verifyRecoveryPoint({ mode: "json", copy: recoveryBytes })
    : verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
  if (!verification.verified) {
    if (!backupExisted && fs.existsSync(backupPath)) {
      try { fs.rmSync(backupPath, { force: true }); } catch {}
    }
    throw Object.assign(new Error("Owner Workspace structural repair was refused because the pre-repair recovery point could not be verified."), {
      code: "OWNER_WORKSPACE_PRE_REPAIR_RECOVERY_UNVERIFIED",
      details: { verification: verification.reason, copyExistedBeforeRepair: backupExisted },
    });
  }
  console.info("[OwnerWorkspace] Pre-repair recovery point verified before structural repair.", {
    filePath,
    recoveryPoint: backupPath,
    reused: backupExisted,
    verification: verification.reason,
  });
  return backupPath;
}

function readState() {
  const filePath = getWorkspacePath();
  if (!fs.existsSync(filePath)) {
    const state = createDefaultState();
    writeState(state);
    return state;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workspace root must be an object.");
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw Object.assign(new Error("Owner Workspace state is unreadable. The original file was preserved for recovery."), {
      code: "OWNER_WORKSPACE_CORRUPT",
      details: { causeCode: error?.code || "INVALID_JSON" },
    });
  }
  const version = Number.isInteger(raw.version) ? raw.version : 0;
  if (version > WORKSPACE_VERSION) {
    throw Object.assign(new Error("Owner Workspace state was created by a newer application version."), {
      code: "OWNER_WORKSPACE_SCHEMA_UNSUPPORTED",
      details: { version, supportedVersion: WORKSPACE_VERSION },
    });
  }
  const normalized = normalizeState(raw);
  if (version < WORKSPACE_VERSION) {
    const backupPath = `${filePath}.schema-v${version}.backup`;
    const originalBytes = fs.readFileSync(filePath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    // V2-J bullet 6: the workspace rewrite below only runs behind a recovery
    // point that was read back and verified. An unverified copy is refused, not
    // warned past. Operator pages, notes and API history cannot be rebuilt from
    // anywhere else.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "owner-workspace",
      fromSchemaVersion: version,
      toSchemaVersion: WORKSPACE_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw Object.assign(new Error("Owner Workspace state could not be migrated safely because the pre-migration recovery point could not be verified."), {
        code: "OWNER_WORKSPACE_MIGRATION_RECOVERY_UNVERIFIED",
        details: { storeId: "owner-workspace", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      });
    }
  }
  if (version < WORKSPACE_VERSION || !Array.isArray(raw.builtInPages) || raw.builtInPages.length !== BUILT_IN_PAGES.length || !raw.contents?.notes) {
    // A structural repair (version already current, shape differs) has no
    // schema-version gate above, so it takes its own verified recovery point
    // before the destructive rewrite.
    if (version === WORKSPACE_VERSION) {
      takePreRepairRecoveryPoint(filePath, fs.readFileSync(filePath));
    }
    writeState(normalized);
  }
  return normalized;
}

function writeState(state) {
  const next = normalizeState({ ...state, updatedAt: safeIso() });
  atomicWriteJson(getWorkspacePath(), next);
  return next;
}

function publicStatus() {
  const security = getStatus();
  const authorized = Boolean(security.ownerWorkspaceAvailable);
  return {
    identity: "Anx",
    authorized,
    authentication: authorized ? "verified" : security.authenticated ? "not-owner" : "locked",
    workspace: fs.existsSync(getWorkspacePath()) ? "loaded" : "ready",
    agents: security.agentTokenConfigured ? "configured" : "disconnected",
    ready: authorized ? "ready" : "locked",
    storagePath: authorized ? getWorkspacePath() : null,
  };
}

function assertOwner(target) {
  return requireOwner(target || "owner-workspace");
}

function getWorkspace() {
  assertOwner("owner-workspace:read");
  const state = readState();
  return {
    status: publicStatus(),
    pages: [...state.builtInPages, ...state.customPages],
    selectedPageId: state.selectedPageId,
    contents: state.contents,
    flags: getFeatureFlags(false),
    apiHistory: state.apiHistory,
    storagePath: getWorkspacePath(),
  };
}

function selectPage(payload = {}) {
  assertOwner("owner-workspace:page:select");
  const state = readState();
  const pageId = String(payload.pageId || "");
  const page = [...state.builtInPages, ...state.customPages].find((entry) => entry.id === pageId);
  if (!page) {
    const error = new Error("Page not found.");
    error.code = "PAGE_NOT_FOUND";
    throw error;
  }
  state.selectedPageId = page.id;
  return { selectedPageId: page.id, workspace: writeState(state) };
}

function slugify(value) {
  return String(value || "custom-page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "custom-page";
}

function createPage(payload = {}) {
  assertOwner("owner-workspace:page:create");
  const state = readState();
  const id = `${slugify(payload.title)}-${crypto.randomBytes(3).toString("hex")}`;
  const page = {
    id,
    title: String(payload.title || "Untitled Page").slice(0, 80),
    icon: String(payload.icon || "note").slice(0, 32),
    accent: /^#[0-9a-f]{6}$/i.test(payload.accent || "") ? payload.accent : "#b66cff",
    builtIn: false,
    pinned: payload.pinned !== false,
    contentType: "markdown",
    createdAt: safeIso(),
    updatedAt: safeIso(),
  };
  state.customPages.push(page);
  state.contents[id] = { markdown: "", updatedAt: safeIso() };
  return { page, workspace: writeState(state) };
}

function updatePage(payload = {}) {
  assertOwner("owner-workspace:page:update");
  const state = readState();
  const page = state.customPages.find((entry) => entry.id === payload.id);
  if (!page) {
    const error = new Error("Custom page not found.");
    error.code = "PAGE_NOT_FOUND";
    throw error;
  }
  if (payload.title !== undefined) page.title = String(payload.title).slice(0, 80);
  if (payload.icon !== undefined) page.icon = String(payload.icon).slice(0, 32);
  if (payload.accent !== undefined && /^#[0-9a-f]{6}$/i.test(payload.accent)) page.accent = payload.accent;
  if (payload.pinned !== undefined) page.pinned = payload.pinned === true;
  page.updatedAt = safeIso();
  return { page, workspace: writeState(state) };
}

function duplicatePage(payload = {}) {
  assertOwner("owner-workspace:page:duplicate");
  const state = readState();
  const source = [...state.builtInPages, ...state.customPages].find((entry) => entry.id === payload.id);
  if (!source) {
    const error = new Error("Page not found.");
    error.code = "PAGE_NOT_FOUND";
    throw error;
  }
  const id = `${slugify(source.title)}-copy-${crypto.randomBytes(3).toString("hex")}`;
  const page = {
    ...source,
    id,
    title: `${source.title} Copy`.slice(0, 80),
    builtIn: false,
    createdAt: safeIso(),
    updatedAt: safeIso(),
  };
  state.customPages.push(page);
  state.contents[id] = { ...(state.contents[source.id] || { markdown: "" }), updatedAt: safeIso() };
  return { page, workspace: writeState(state) };
}

function deletePage(payload = {}) {
  assertOwner("owner-workspace:page:delete");
  const state = readState();
  const before = state.customPages.length;
  state.customPages = state.customPages.filter((entry) => entry.id !== payload.id);
  if (state.customPages.length === before) {
    const error = new Error("Custom page not found.");
    error.code = "PAGE_NOT_FOUND";
    throw error;
  }
  delete state.contents[payload.id];
  return { workspace: writeState(state) };
}

function reorderPages(payload = {}) {
  assertOwner("owner-workspace:page:reorder");
  const state = readState();
  const ids = Array.isArray(payload.ids) ? payload.ids : [];
  const current = new Map(state.customPages.map((page) => [page.id, page]));
  state.customPages = ids.map((id) => current.get(id)).filter(Boolean);
  for (const page of current.values()) {
    if (!state.customPages.some((entry) => entry.id === page.id)) {
      state.customPages.push(page);
    }
  }
  return { workspace: writeState(state) };
}

function saveContent(payload = {}) {
  assertOwner("owner-workspace:content:write");
  const pageId = String(payload.pageId || "");
  const state = readState();
  const page = [...state.builtInPages, ...state.customPages].find((entry) => entry.id === pageId);
  if (!page) {
    const error = new Error("Page not found.");
    error.code = "PAGE_NOT_FOUND";
    throw error;
  }
  state.contents[pageId] = {
    ...(state.contents[pageId] || {}),
    markdown: typeof payload.markdown === "string" ? payload.markdown.slice(0, 2_000_000) : state.contents[pageId]?.markdown || "",
    json: typeof payload.json === "string" ? payload.json.slice(0, 2_000_000) : state.contents[pageId]?.json,
    updatedAt: safeIso(),
  };
  state.selectedPageId = pageId;
  return { content: state.contents[pageId], workspace: writeState(state) };
}

function getFeatureFlags(assert = true) {
  if (assert) assertOwner("owner-workspace:flags:read");
  const state = readState();
  return DEFAULT_FLAGS.map((flag) => ({
    ...flag,
    value: Object.prototype.hasOwnProperty.call(state.flagOverrides, flag.name) ? state.flagOverrides[flag.name] : flag.defaultValue,
    overridden: Object.prototype.hasOwnProperty.call(state.flagOverrides, flag.name),
  }));
}

function setFeatureFlag(payload = {}) {
  assertOwner("owner-workspace:flags:write");
  const flag = DEFAULT_FLAGS.find((entry) => entry.name === payload.name);
  if (!flag) {
    const error = new Error("Feature flag not found.");
    error.code = "FLAG_NOT_FOUND";
    throw error;
  }
  const state = readState();
  state.flagOverrides[flag.name] = payload.value === true;
  return { flags: getFeatureFlags(false), workspace: writeState(state), requiresRestart: flag.requiresRestart };
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/(authorization|cookie|password|token|api[-_]?key|secret)["'=:\s]+[^"',\s}]+/gi, `$1=${REDACTED}`)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, REDACTED);
}

function normalizeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    result[key] = /authorization|cookie|password|token|api-key|secret/.test(lower) ? REDACTED : redactSecrets(value);
  }
  return result;
}

function getApprovedApiOrigins() {
  const origins = new Set(["http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1"]);
  const agent = readAgentSettings();
  for (const value of [agent.agentUrl, agent.url]) {
    try {
      const parsed = new URL(value);
      origins.add(parsed.origin);
    } catch {}
  }
  return origins;
}

function assertApprovedApiUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const error = new Error("Enter a valid local AnxOS or configured agent URL.");
    error.code = "API_URL_INVALID";
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("Only HTTP and HTTPS API requests are supported.");
    error.code = "API_PROTOCOL_DENIED";
    throw error;
  }
  if (!getApprovedApiOrigins().has(parsed.origin)) {
    const error = new Error("API Tester is restricted to local AnxOS services and configured agents.");
    error.code = "API_ORIGIN_DENIED";
    throw error;
  }
  return parsed.toString();
}

async function runApiRequest(payload = {}) {
  assertOwner("owner-workspace:api-tester");
  const url = assertApprovedApiUrl(payload.url);
  const method = String(payload.method || "GET").toUpperCase();
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
  if (!allowedMethods.has(method)) {
    const error = new Error("Unsupported API method.");
    error.code = "API_METHOD_DENIED";
    throw error;
  }
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let status = null;
  let responseText = "";
  try {
    const response = await fetch(url, {
      method,
      headers: payload.headers && typeof payload.headers === "object" ? payload.headers : {},
      body: method === "GET" || method === "HEAD" ? undefined : String(payload.body || ""),
      signal: controller.signal,
    });
    status = response.status;
    responseText = redactSecrets((await response.text()).slice(0, 12000));
    return saveApiHistory({
      url,
      method,
      status,
      ok: response.ok,
      durationMs: Date.now() - started,
      responseText,
      headers: normalizeHeaders(payload.headers),
    });
  } catch (error) {
    return saveApiHistory({
      url,
      method,
      status,
      ok: false,
      durationMs: Date.now() - started,
      responseText: redactSecrets(error?.message || String(error)),
      headers: normalizeHeaders(payload.headers),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function saveApiHistory(entry) {
  const state = readState();
  const record = {
    id: crypto.randomUUID(),
    at: safeIso(),
    ...entry,
  };
  state.apiHistory = [record, ...state.apiHistory].slice(0, 50);
  writeState(state);
  return { result: record, history: state.apiHistory };
}

function clearApiHistory() {
  assertOwner("owner-workspace:api-history:clear");
  const state = readState();
  state.apiHistory = [];
  return { history: writeState(state).apiHistory };
}

async function getAnalytics() {
  assertOwner("owner-workspace:analytics");
  const started = Date.now();
  let snapshot = null;
  let apiLatencyMs = null;
  try {
    snapshot = await getSystemSnapshot();
    apiLatencyMs = Date.now() - started;
  } catch {}
  return {
    rendererFps: null,
    cpuUsage: snapshot?.cpu?.usagePercent ?? null,
    memory: snapshot?.memory || null,
    disk: snapshot?.disk || null,
    ipcLatencyMs: Date.now() - started,
    apiLatencyMs,
    agentLatencyMs: null,
    cache: {
      status: "Not reported",
    },
  };
}

function getCommandCatalog() {
  assertOwner("owner-workspace:commands");
  return [
    { id: "reload-renderer", label: "Reload renderer", disruptive: true, available: true },
    { id: "restart-backend", label: "Restart backend", disruptive: true, available: false, reason: "No separate backend process is managed by this app." },
    { id: "restart-agent", label: "Restart agent", disruptive: true, available: false, reason: "Agent restart is not exposed by the current architecture." },
    { id: "clear-cache", label: "Clear cache", disruptive: true, available: true },
    { id: "open-logs", label: "Open logs", disruptive: false, available: true },
    { id: "open-config", label: "Open configuration folder", disruptive: false, available: true },
    { id: "generate-mock-data", label: "Generate mock data", disruptive: false, available: true },
    { id: "test-notifications", label: "Test notifications", disruptive: false, available: Notification?.isSupported?.() === true },
    { id: "refresh-agent-connections", label: "Refresh agent connections", disruptive: false, available: true },
  ];
}

async function runCommand(payload = {}, event = null) {
  const actor = assertOwner(`owner-workspace:command:${payload.commandId || "unknown"}`);
  const command = getCommandCatalog().find((entry) => entry.id === payload.commandId);
  if (!command) {
    const error = new Error("Unknown owner command.");
    error.code = "COMMAND_NOT_FOUND";
    throw error;
  }
  if (!command.available) {
    return { ok: false, command, message: command.reason || "Command unavailable." };
  }
  if (command.disruptive && payload.confirmed !== true) {
    const error = new Error("Confirmation is required.");
    error.code = "CONFIRMATION_REQUIRED";
    throw error;
  }

  if (command.id === "reload-renderer") {
    event?.sender?.reloadIgnoringCache?.();
    audit({ action: "owner.command", outcome: "ok", actor, target: command.id });
    return { ok: true, command, message: "Renderer reload requested." };
  }
  if (command.id === "clear-cache") {
    await session.defaultSession.clearCache();
    audit({ action: "owner.command", outcome: "ok", actor, target: command.id });
    return { ok: true, command, message: "Cache cleared." };
  }
  if (command.id === "open-logs") {
    await shell.openPath(getConfigDirectory());
    return { ok: true, command, message: "Opened configuration/log folder." };
  }
  if (command.id === "open-config") {
    await shell.openPath(getConfigDirectory());
    return { ok: true, command, message: "Opened configuration folder." };
  }
  if (command.id === "generate-mock-data") {
    const created = createPage({ title: "Mock Workspace Data", icon: "spark", accent: "#45e08f" });
    saveContent({ pageId: created.page.id, markdown: "## Mock data\n\n- Generated for local UI testing.\n- Safe to delete.\n" });
    return { ok: true, command, message: "Mock workspace page created." };
  }
  if (command.id === "test-notifications") {
    new Notification({ title: "AnxOS", body: "Owner Workspace notification test." }).show();
    return { ok: true, command, message: "Notification sent." };
  }
  if (command.id === "refresh-agent-connections") {
    const result = await testConnection().catch((error) => ({ connected: false, message: error?.message || "Agent unavailable." }));
    return { ok: Boolean(result.connected), command, message: result.message || (result.connected ? "Agent connected." : "Agent unavailable.") };
  }
  return { ok: false, command, message: "Command unavailable." };
}

function readLogViewer() {
  assertOwner("owner-workspace:logs");
  const files = [
    path.join(getConfigDirectory(), "audit.log"),
    getAgentConfigPath(),
  ];
  return files.map((filePath) => {
    try {
      return {
        path: filePath,
        content: redactSecrets(fs.readFileSync(filePath, "utf8").slice(-24000)),
      };
    } catch {
      return {
        path: filePath,
        content: "Not reported",
      };
    }
  });
}

module.exports = {
  WORKSPACE_VERSION,
  clearApiHistory,
  createPage,
  deletePage,
  duplicatePage,
  getAnalytics,
  getCommandCatalog,
  getFeatureFlags,
  getWorkspace,
  getWorkspacePath,
  publicStatus,
  readLogViewer,
  reorderPages,
  runApiRequest,
  runCommand,
  saveContent,
  selectPage,
  setFeatureFlag,
  updatePage,
  _test: {
    assertApprovedApiUrl,
    createDefaultState,
    redactSecrets,
  },
};
