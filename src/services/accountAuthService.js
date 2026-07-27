const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");
const { SecureSessionStore, getDefaultConfigDirectory } = require("./secureSessionStore");
const { openExternalUrl } = require("./externalUrlService");
const { OFFICIAL_SITE_HOSTNAME, OFFICIAL_SITE_ORIGIN } = require("../shared/officialSite");

const WEBSITE_BASE_URL = OFFICIAL_SITE_ORIGIN;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DEVICE_LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_POLL_MS = 10 * 60 * 1000;
const APPROVED_AUTH_HOSTS = new Set([
  OFFICIAL_SITE_HOSTNAME,
]);
const LOCAL_ACCOUNT_HOSTS = new Set(["localhost", "127.0.0.1"]);
const LEGACY_ACCOUNT_HOSTS = new Set([
  "anxos-control-center.pages.dev",
]);
const APPROVED_SUPABASE_FUNCTION_HOST = /^[a-z0-9-]+\.functions\.supabase\.co$/i;
const APPROVED_SUPABASE_AUTH_HOST = /^[a-z0-9-]+\.supabase\.co$/i;

let currentSession = null;
let pendingDeviceLogin = null;
let pendingRequestInFlight = false;
let cachedAccountConfig = null;

const sessionStore = new SecureSessionStore({ fileName: "account.json" });

function getConfigDirectory() {
  return getDefaultConfigDirectory();
}

function ensureConfigDirectory() {
  fs.mkdirSync(getConfigDirectory(), { recursive: true });
}

function getAuditPath() {
  return path.join(getConfigDirectory(), "audit.log");
}

function normalizeBaseUrl(value, fallback = "") {
  return String(value || fallback).replace(/\/+$/, "");
}

function validateAccountApiUrl(value, source = "account configuration") {
  const normalized = normalizeBaseUrl(value, "");
  if (!normalized) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    const error = new Error(`Account API URL in ${source} is invalid.`);
    error.code = "ACCOUNT_API_URL_INVALID";
    throw error;
  }
  if (/^functions\.supabase\.co$/i.test(parsed.hostname) || /^supabase\.co$/i.test(parsed.hostname)) {
    const error = new Error("Account API URL is missing the Supabase project reference. Use https://<project-ref>.functions.supabase.co/anxos-account.");
    error.code = "ACCOUNT_API_PROJECT_MISSING";
    throw error;
  }
  return normalized;
}

function getSupabaseProjectRefFromUrl(value) {
  const normalized = normalizeBaseUrl(value, "");
  if (!normalized) {
    return "";
  }
  try {
    const hostname = new URL(normalized).hostname;
    const match = hostname.match(/^([a-z0-9-]+)\.(?:functions\.)?supabase\.co$/i);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function getBundledAccountConfigPath() {
  return path.join(__dirname, "..", "..", "website", "account-config.js");
}

function getAccountConfigSearchPaths() {
  const paths = [
    process.env.ANXOS_ACCOUNT_CONFIG_PATH,
    path.join(getConfigDirectory(), "account-config.json"),
    path.join(getConfigDirectory(), "account-config.js"),
    getBundledAccountConfigPath(),
  ].filter(Boolean);
  return [...new Set(paths.map((entry) => path.resolve(entry)))];
}

function normalizeAccountConfig(rawConfig = {}, source = "unknown") {
  const supabaseUrl = normalizeBaseUrl(rawConfig.supabaseUrl || rawConfig.SUPABASE_URL || rawConfig.ANXOS_SUPABASE_URL, "");
  const accountApiUrl = validateAccountApiUrl(rawConfig.accountApiUrl || rawConfig.ANXOS_ACCOUNT_API_URL || rawConfig.ANXOS_SUPABASE_ACCOUNT_FUNCTION_URL, source);
  const projectRef = String(
    rawConfig.projectRef ||
    rawConfig.projectId ||
    rawConfig.supabaseProjectRef ||
    rawConfig.SUPABASE_PROJECT_REF ||
    rawConfig.ANXOS_SUPABASE_PROJECT_REF ||
    getSupabaseProjectRefFromUrl(accountApiUrl) ||
    getSupabaseProjectRefFromUrl(supabaseUrl) ||
    "",
  ).trim();
  return {
    source,
    supabaseUrl,
    supabaseAnonKey: String(rawConfig.supabaseAnonKey || rawConfig.supabaseAnonKeyPublic || rawConfig.SUPABASE_ANON_KEY || rawConfig.ANXOS_SUPABASE_ANON_KEY || "").trim(),
    accountApiUrl,
    projectRef,
    siteUrl: normalizeBaseUrl(rawConfig.siteUrl || rawConfig.WEBSITE_BASE_URL || rawConfig.ANXOS_WEBSITE_BASE_URL, ""),
  };
}

function parseAccountConfigFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  if (/\.json$/i.test(filePath)) {
    return JSON.parse(raw);
  }
  const sandbox = { window: {}, globalThis: {} };
  sandbox.globalThis = sandbox.window;
  const vm = require("vm");
  vm.runInNewContext(raw, sandbox, {
    filename: filePath,
    timeout: 1000,
  });
  return sandbox.window.ANXOS_ACCOUNT_CONFIG || sandbox.globalThis.ANXOS_ACCOUNT_CONFIG || {};
}

function readAccountConfigFromDisk() {
  const errors = [];
  for (const filePath of getAccountConfigSearchPaths()) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const parsed = normalizeAccountConfig(parseAccountConfigFile(filePath), filePath);
      if (parsed.supabaseUrl || parsed.supabaseAnonKey || parsed.accountApiUrl || parsed.siteUrl) {
        return parsed;
      }
      errors.push(`${filePath}: file did not contain account configuration values`);
    } catch (error) {
      errors.push(`${filePath}: ${redactSecret(error?.message || String(error))}`);
    }
  }
  if (errors.length) {
    const error = new Error(`AnxOS account configuration could not be loaded. ${errors.join("; ")}`);
    error.code = "ACCOUNT_CONFIG_LOAD_FAILED";
    throw error;
  }
  return normalizeAccountConfig({}, "none");
}

function readBundledAccountConfig() {
  try {
    return normalizeAccountConfig(parseAccountConfigFile(getBundledAccountConfigPath()), getBundledAccountConfigPath());
  } catch {
    return normalizeAccountConfig({}, "bundled-unavailable");
  }
}

function getAccountConfig(options = {}) {
  const envConfig = normalizeAccountConfig({
    supabaseUrl: process.env.ANXOS_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.ANXOS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
    accountApiUrl: process.env.ANXOS_ACCOUNT_API_URL || process.env.ANXOS_SUPABASE_ACCOUNT_FUNCTION_URL,
    projectRef: process.env.ANXOS_SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_REF || process.env.ANXOS_ACCOUNT_PROJECT_REF,
    siteUrl: process.env.ANXOS_WEBSITE_BASE_URL || process.env.WEBSITE_BASE_URL || process.env.ANXOS_ACCOUNT_SITE_URL,
  }, "environment");
  if ((envConfig.supabaseUrl && envConfig.supabaseAnonKey) || envConfig.accountApiUrl) {
    return envConfig;
  }
  if (!cachedAccountConfig || options.reload) {
    cachedAccountConfig = readAccountConfigFromDisk();
  }
  return {
    ...cachedAccountConfig,
    ...Object.fromEntries(Object.entries(envConfig).filter(([key, value]) => key === "source" ? false : Boolean(value))),
    source: cachedAccountConfig?.source && envConfig.siteUrl ? `${cachedAccountConfig.source} + environment` : cachedAccountConfig?.source || envConfig.source,
  };
}

function getWebsiteBaseUrl() {
  return normalizeBaseUrl(getAccountConfig().siteUrl, WEBSITE_BASE_URL);
}

function buildWebsiteUrl(route = "account", params = {}) {
  const base = assertApprovedExternalUrl(getWebsiteBaseUrl(), "website base");
  const normalizedRoute = String(route || "account").replace(/^#?\/?/, "");
  const url = new URL(base);
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });
  if (["account", "activate", "signin"].includes(normalizedRoute)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${normalizedRoute}/`.replace(/^\/?/, "/");
    url.search = search.toString();
    url.hash = "";
    return url.toString();
  }
  url.hash = `${normalizedRoute}${search.toString() ? `?${search.toString()}` : ""}`;
  return url.toString();
}

function canonicalizeAccountWebsiteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!LEGACY_ACCOUNT_HOSTS.has(parsed.hostname)) {
    return parsed.toString();
  }
  const official = new URL(OFFICIAL_SITE_ORIGIN);
  parsed.protocol = official.protocol;
  parsed.username = "";
  parsed.password = "";
  parsed.host = official.host;
  return parsed.toString();
}

function isLocalAccountHost(hostname) {
  return LOCAL_ACCOUNT_HOSTS.has(String(hostname || "").toLowerCase());
}

function isDevelopmentAccountHostAllowed(hostname) {
  return isLocalAccountHost(hostname) && app?.isPackaged !== true;
}

function getAccountApiUrl() {
  return normalizeBaseUrl(getAccountConfig().accountApiUrl, "");
}

function getSupabaseUrl() {
  return normalizeBaseUrl(getAccountConfig().supabaseUrl, "");
}

function getSupabaseAnonKey() {
  return String(getAccountConfig().supabaseAnonKey || "").trim();
}

function getAccountProjectRef() {
  return String(getAccountConfig().projectRef || "").trim();
}

function getAccountApiHeaders(rawUrl, options = {}) {
  const headers = { "content-type": "application/json" };
  let isSupabaseFunction = false;
  try {
    isSupabaseFunction = APPROVED_SUPABASE_FUNCTION_HOST.test(new URL(rawUrl).hostname);
  } catch {}
  const anonKey = isSupabaseFunction ? getSupabaseAnonKey() : "";
  if (anonKey) {
    headers.apikey = anonKey;
  }
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
  }
  return headers;
}

function assertApprovedExternalUrl(rawUrl, purpose = "account") {
  let parsed;
  try {
    parsed = new URL(canonicalizeAccountWebsiteUrl(rawUrl));
  } catch {
    const error = new Error("Account URL is invalid.");
    error.code = "ACCOUNT_URL_INVALID";
    throw error;
  }

  const isLocalDevelopmentHost = isDevelopmentAccountHostAllowed(parsed.hostname);
  if (parsed.protocol !== "https:" && !(isLocalDevelopmentHost && parsed.protocol === "http:")) {
    const error = new Error("AnxOS account sign-in requires HTTPS outside local development.");
    error.code = "ACCOUNT_HTTPS_REQUIRED";
    throw error;
  }
  if (isLocalAccountHost(parsed.hostname) && !isLocalDevelopmentHost) {
    const error = new Error("Packaged AnxOS builds cannot use local account or device-login URLs.");
    error.code = "ACCOUNT_LOCALHOST_NOT_ALLOWED";
    throw error;
  }
  const isApprovedSupabaseFunction = APPROVED_SUPABASE_FUNCTION_HOST.test(parsed.hostname);
  const isApprovedSupabaseAuth = APPROVED_SUPABASE_AUTH_HOST.test(parsed.hostname);
  if (!APPROVED_AUTH_HOSTS.has(parsed.hostname) && !isLocalDevelopmentHost && !isApprovedSupabaseFunction && !isApprovedSupabaseAuth && !process.env.ANXOS_ACCOUNT_ALLOW_UNTRUSTED_HOSTS) {
    const error = new Error(`Refusing to open unapproved ${purpose} URL.`);
    error.code = "ACCOUNT_URL_NOT_APPROVED";
    throw error;
  }
  return parsed.toString();
}

function redactSecret(value) {
  return String(value || "")
    .replace(/(access[_-]?token|refresh[_-]?token|device[_-]?code|authorization|secret|password)["'=:\s]+[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
}

async function readResponsePayload(response) {
  const text = await response.text().catch(() => "");
  if (!text) {
    return { data: {}, text: "" };
  }
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: {}, text };
  }
}

function getHttpErrorMessage(response, data = {}, text = "", fallback = "Account request failed") {
  const structuredMessage = data.message || data.error_description || data.error;
  if (structuredMessage) {
    return redactSecret(structuredMessage);
  }
  const responseText = String(text || "").replace(/\s+/g, " ").trim();
  if (responseText) {
    return redactSecret(`${fallback} with HTTP ${response.status}: ${responseText.slice(0, 240)}`);
  }
  return `${fallback} with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
}

function publicAccount(session) {
  if (!session) {
    return null;
  }
  return {
    id: session.account?.id || session.user?.id || null,
    username: session.account?.username || session.user?.username || session.account?.email || session.user?.email || "AnxOS Account",
    email: session.account?.email || session.user?.email || null,
    displayName: session.account?.displayName || session.user?.displayName || session.account?.username || session.user?.username || "AnxOS Account",
    provider: session.provider || session.account?.provider || "AnxOS",
    ownerAuthorized: Boolean(session.ownerAuthorized),
    connectedAt: session.createdAt || null,
    device: session.device ? {
      id: session.device.id || session.device.deviceId || null,
      name: session.device.device_name || session.device.deviceName || null,
      platform: session.device.platform || null,
      appVersion: session.device.app_version || session.device.appVersion || null,
    } : null,
  };
}

function normalizeSupabaseUser(user = {}) {
  const metadata = user.user_metadata || {};
  return {
    id: user.id || null,
    email: user.email || null,
    username: metadata.username || metadata.name || user.email || "AnxOS Account",
    displayName: metadata.display_name || metadata.full_name || metadata.name || metadata.username || user.email || "AnxOS Account",
    provider: "Supabase",
    emailConfirmedAt: user.email_confirmed_at || user.confirmed_at || null,
  };
}

function audit(event) {
  try {
    ensureConfigDirectory();
    fs.appendFileSync(getAuditPath(), `${JSON.stringify({
      at: new Date().toISOString(),
      actor: publicAccount(getCurrentSession({ allowExpired: true })),
      action: event.action,
      outcome: event.outcome || "ok",
      target: event.target || null,
      reason: event.reason || null,
    })}\n`, { mode: 0o600 });
  } catch {}
}

function normalizeSession(payload = {}) {
  const accessToken = payload.accessToken || payload.access_token || payload.token || null;
  const refreshToken = payload.refreshToken || payload.refresh_token || null;
  if (!accessToken) {
    const error = new Error("Account login response did not include an access token.");
    error.code = "ACCOUNT_TOKEN_MISSING";
    throw error;
  }
  const expiresAt = payload.expiresAt
    ? Date.parse(payload.expiresAt)
    : Date.now() + ((Number.parseInt(payload.expiresIn || payload.expires_in, 10) || DEFAULT_SESSION_TTL_MS / 1000) * 1000);
  if (!Number.isFinite(expiresAt)) {
    const error = new Error("Account login response included an invalid expiration time.");
    error.code = "ACCOUNT_TOKEN_EXPIRATION_INVALID";
    throw error;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    account: payload.account || payload.user || null,
    device: payload.device || null,
    provider: payload.provider || "AnxOS",
    createdAt: payload.connectedAt || payload.createdAt || new Date().toISOString(),
  };
}

function writeSession(session) {
  currentSession = session;
  sessionStore.write(session);
}

function clearSession() {
  currentSession = null;
  sessionStore.clear();
}

function getCurrentSession(options = {}) {
  if (!currentSession) {
    currentSession = sessionStore.read();
  }
  if (!currentSession?.accessToken) {
    return null;
  }
  if (!options.allowExpired && (!Number.isFinite(currentSession.expiresAt) || currentSession.expiresAt <= Date.now())) {
    return null;
  }
  return currentSession;
}

function getRefreshableSession() {
  const session = getCurrentSession({ allowExpired: true });
  return session?.refreshToken ? session : null;
}

function isTransientAccountError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return /ACCOUNT_(?:NETWORK_UNAVAILABLE|TIMEOUT)|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network|timeout/i.test(`${code} ${message}`);
}

function isInvalidRefreshError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return /invalid_grant|refresh_token_not_found|refresh_token_revoked|session_not_found|JWT_EXPIRED|HTTP_40[013]|HTTP_404|revoked|invalid refresh|invalid session|refresh token/i.test(`${code} ${message}`);
}

async function postJson(url, payload, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(assertApprovedExternalUrl(url, "account API"), {
      method: "POST",
      headers: getAccountApiHeaders(url, options),
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const { data, text } = await readResponsePayload(response);
    if (!response.ok) {
      const error = new Error(getHttpErrorMessage(response, data, text, "Account request failed"));
      error.code = data.code || data.error || `HTTP_${response.status}`;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Account service timed out. Try again.");
      timeoutError.code = "ACCOUNT_TIMEOUT";
      throw timeoutError;
    }
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(error?.message || "")) {
      const networkError = new Error("Account service is unavailable. Check your internet connection.");
      networkError.code = "ACCOUNT_NETWORK_UNAVAILABLE";
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(assertApprovedExternalUrl(url, "account API"), {
      method: "GET",
      headers: getAccountApiHeaders(url, options),
      signal: controller.signal,
    });
    const { data, text } = await readResponsePayload(response);
    if (!response.ok) {
      const error = new Error(getHttpErrorMessage(response, data, text, "Account request failed"));
      error.code = data.code || data.error || `HTTP_${response.status}`;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Account service timed out. Try again.");
      timeoutError.code = "ACCOUNT_TIMEOUT";
      throw timeoutError;
    }
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(error?.message || "")) {
      const networkError = new Error("Account service is unavailable. Check your internet connection.");
      networkError.code = "ACCOUNT_NETWORK_UNAVAILABLE";
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getDeviceInfo() {
  let version = null;
  try {
    version = app?.getVersion?.() || null;
  } catch {}
  return {
    app: "AnxOS-Control-Center",
    appVersion: version,
    deviceName: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    requestedAt: new Date().toISOString(),
  };
}

function createLocalPendingDeviceLogin() {
  const userCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  const deviceCode = crypto.randomBytes(32).toString("base64url");
  return {
    deviceCode,
    userCode,
    verificationUrl: buildWebsiteUrl("activate", { code: userCode }),
    expiresAt: new Date(Date.now() + DEFAULT_DEVICE_LOGIN_TTL_MS).toISOString(),
    intervalMs: 3000,
    createdAt: Date.now(),
    localOnly: true,
    device: getDeviceInfo(),
  };
}

function normalizeDeviceStartResponse(response = {}) {
  const expiresIn = Number.parseInt(response.expiresIn || response.expires_in, 10);
  const pollInterval = Number.parseInt(response.pollInterval || response.interval || response.poll_interval, 10);
  const login = {
    deviceCode: response.deviceCode || response.device_code,
    userCode: response.userCode || response.user_code,
    verificationUrl: canonicalizeAccountWebsiteUrl(response.verificationUrl || response.verification_uri || response.verificationUri),
    expiresAt: response.expiresAt || new Date(Date.now() + ((Number.isFinite(expiresIn) ? expiresIn : 600) * 1000)).toISOString(),
    intervalMs: Math.max(1500, (Number.isFinite(pollInterval) ? pollInterval : 3) * 1000),
    createdAt: Date.now(),
    localOnly: false,
    device: getDeviceInfo(),
  };
  if (!login.deviceCode || !login.userCode || !login.verificationUrl) {
    const error = new Error("Account service returned an incomplete device authorization response.");
    error.code = "ACCOUNT_DEVICE_RESPONSE_INVALID";
    throw error;
  }
  assertApprovedExternalUrl(login.verificationUrl, "verification");
  return login;
}

function isProjectMissingError(error) {
  return error?.code === "ACCOUNT_API_PROJECT_MISSING"
    || /project not specified|missing the Supabase project reference/i.test(error?.message || "");
}

async function startRemoteDeviceLogin(apiUrl) {
  return {
    ...normalizeDeviceStartResponse(await postJson(`${apiUrl}/api/auth/device/start`, getDeviceInfo())),
    apiUrl,
  };
}

function publicPending(login = pendingDeviceLogin) {
  if (!login) {
    return null;
  }
  return {
    userCode: login.userCode,
    verificationUrl: login.verificationUrl,
    expiresAt: login.expiresAt,
    intervalMs: login.intervalMs,
    device: login.device,
  };
}

function getStatus() {
  const session = getCurrentSession();
  const storedSession = session || getCurrentSession({ allowExpired: true });
  const expired = Boolean(storedSession && !session);
  const canRefresh = Boolean(storedSession?.refreshToken);
  const config = getAccountConfig();
  const passwordConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const apiConfigured = Boolean(config.accountApiUrl);
  return {
    configured: Boolean(apiConfigured || passwordConfigured),
    passwordConfigured,
    accountApiConfigured: apiConfigured,
    configSource: config.source || null,
    authenticated: Boolean(session),
    account: publicAccount(storedSession),
    expiresAt: storedSession ? new Date(storedSession.expiresAt).toISOString() : null,
    sessionStatus: session ? "active" : expired && canRefresh ? "refreshable" : expired ? "expired" : "local",
    canRefresh,
    accountPath: sessionStore.filePath,
    siteUrl: getWebsiteBaseUrl(),
    currentDevice: getDeviceInfo(),
    pending: publicPending(),
  };
}

async function postSupabaseAuth(pathname, payload, options = {}) {
  const supabaseUrl = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!supabaseUrl || !anonKey) {
    const error = new Error("Supabase account sign-in is not configured on this device. Add Supabase URL and anon key configuration.");
    error.code = "SUPABASE_AUTH_NOT_CONFIGURED";
    throw error;
  }
  const url = `${supabaseUrl}/auth/v1/${String(pathname || "").replace(/^\/+/, "")}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(assertApprovedExternalUrl(url, "Supabase Auth"), {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${options.accessToken || anonKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const { data, text } = await readResponsePayload(response);
    if (!response.ok) {
      const reason = data.error_code || data.error || data.msg || data.message || `HTTP_${response.status}`;
      const error = new Error(redactSecret(
        response.status === 400 || response.status === 401
          ? "Invalid email or password."
          : data.msg || data.message || getHttpErrorMessage(response, data, text, "Supabase Auth request failed")
      ));
      error.code = reason;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Supabase sign-in timed out. Try again.");
      timeoutError.code = "ACCOUNT_TIMEOUT";
      throw timeoutError;
    }
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(error?.message || "")) {
      const networkError = new Error("Supabase account service is unavailable. Check your internet connection.");
      networkError.code = "ACCOUNT_NETWORK_UNAVAILABLE";
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loginWithPassword(payload = {}) {
  const email = String(payload.email || "").trim();
  const password = String(payload.password || "");
  if (!email || !password) {
    const error = new Error("Enter your AnxOS account email and password.");
    error.code = "ACCOUNT_CREDENTIALS_REQUIRED";
    throw error;
  }
  const response = await postSupabaseAuth("token?grant_type=password", {
    email,
    password,
  });
  const session = normalizeSession({
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresIn: response.expires_in,
    account: normalizeSupabaseUser(response.user || {}),
    provider: "Supabase",
    device: getDeviceInfo(),
  });
  writeSession(session);
  audit({ action: "account.login", outcome: "ok", target: "supabase-password" });
  return { ...getStatus(), state: "authenticated", message: "Signed in with AnxOS account." };
}

async function startDeviceLogin() {
  if (pendingRequestInFlight) {
    return { ...getStatus(), state: "pending", message: "A sign-in request is already starting." };
  }
  if (pendingDeviceLogin && Date.parse(pendingDeviceLogin.expiresAt) > Date.now()) {
    return { ...getStatus(), state: "pending", message: "A sign-in request is already waiting." };
  }

  pendingRequestInFlight = true;
  try {
    const apiUrl = getAccountApiUrl();
    if (apiUrl) {
      try {
        pendingDeviceLogin = await startRemoteDeviceLogin(apiUrl);
      } catch (error) {
        const bundled = readBundledAccountConfig();
        const bundledApiUrl = bundled.accountApiUrl || "";
        if (!isProjectMissingError(error) || !bundledApiUrl || bundledApiUrl === apiUrl) {
          throw error;
        }
        pendingDeviceLogin = await startRemoteDeviceLogin(bundledApiUrl);
      }
    } else {
      pendingDeviceLogin = createLocalPendingDeviceLogin();
    }
    const verificationUrl = assertApprovedExternalUrl(pendingDeviceLogin.verificationUrl, "verification");
    await openExternalUrl(verificationUrl, { source: "account-device-login" });
    audit({
      action: "account.deviceLogin.start",
      outcome: "ok",
      target: pendingDeviceLogin.localOnly ? "local-placeholder" : "device-login",
      reason: pendingDeviceLogin.localOnly ? "ACCOUNT_API_NOT_CONFIGURED" : null,
    });
    return {
      ...getStatus(),
      state: "pending",
      message: pendingDeviceLogin.localOnly
        ? "Opened the AnxOS account page. Configure ANXOS_ACCOUNT_API_URL to enable live website sign-in."
        : "Opened the AnxOS account page. Finish sign-in in your browser.",
    };
  } catch (error) {
    pendingDeviceLogin = null;
    throw error;
  } finally {
    pendingRequestInFlight = false;
  }
}

function cancelDeviceLogin() {
  pendingDeviceLogin = null;
  audit({ action: "account.deviceLogin.cancel", outcome: "ok" });
  return { ...getStatus(), state: "cancelled", message: "AnxOS account sign-in was cancelled." };
}

async function checkDeviceLogin() {
  if (!pendingDeviceLogin) {
    return { ...getStatus(), state: "idle", message: "No account sign-in is waiting." };
  }
  if (Date.now() - pendingDeviceLogin.createdAt > MAX_POLL_MS || Date.parse(pendingDeviceLogin.expiresAt) <= Date.now()) {
    pendingDeviceLogin = null;
    return { ...getStatus(), state: "expired", message: "Account sign-in expired. Start again." };
  }
  if (pendingDeviceLogin.localOnly) {
    return { ...getStatus(), state: "pending", message: "Waiting for the AnxOS account backend to be configured." };
  }

  const pollApiUrl = pendingDeviceLogin.apiUrl || getAccountApiUrl();
  const response = await postJson(`${pollApiUrl}/api/auth/device/poll`, { deviceCode: pendingDeviceLogin.deviceCode });
  const state = response.state || response.status || (response.pending ? "pending" : null);
  if (state === "pending" || state === "authorization_pending") {
    return { ...getStatus(), state: "pending", message: "Waiting for browser sign-in approval." };
  }
  if (state === "slow_down") {
    pendingDeviceLogin.intervalMs = Math.min(15000, pendingDeviceLogin.intervalMs + 2000);
    return { ...getStatus(), state: "pending", message: "Still waiting for browser approval." };
  }
  if (state === "denied" || state === "access_denied") {
    pendingDeviceLogin = null;
    return { ...getStatus(), state: "denied", message: "AnxOS account sign-in was denied." };
  }
  if (state === "expired") {
    pendingDeviceLogin = null;
    return { ...getStatus(), state: "expired", message: "Account sign-in expired. Start again." };
  }
  if (state !== "approved" && !response.accessToken && !response.access_token) {
    return { ...getStatus(), state: "pending", message: "Waiting for browser sign-in approval." };
  }

  const session = normalizeSession(response);
  writeSession(session);
  pendingDeviceLogin = null;
  audit({ action: "account.login", outcome: "ok", target: "device-login" });
  return { ...getStatus(), state: "authenticated", message: "Signed in with AnxOS." };
}

async function refreshSession() {
  const session = getCurrentSession({ allowExpired: true });
  if (!session?.refreshToken) {
    clearSession();
    return { ...getStatus(), state: "signed-out", message: "No refresh token is available." };
  }
  if (!getAccountApiUrl() && !getSupabaseUrl()) {
    return { ...getStatus(), state: "refresh-unavailable", message: "Account service is not configured." };
  }
  const response = getAccountApiUrl()
    ? await postJson(`${getAccountApiUrl()}/api/auth/refresh`, {
        refreshToken: session.refreshToken,
        projectRef: getAccountProjectRef(),
        projectId: getAccountProjectRef(),
      })
    : await postSupabaseAuth("token?grant_type=refresh_token", { refresh_token: session.refreshToken });
  const nextSession = normalizeSession(response);
  writeSession({
    ...nextSession,
    account: response.user ? normalizeSupabaseUser(response.user) : nextSession.account || session.account,
    device: nextSession.device || session.device,
    provider: response.user ? "Supabase" : nextSession.provider || session.provider,
    createdAt: session.createdAt || nextSession.createdAt,
  });
  audit({ action: "account.refresh", outcome: "ok" });
  return { ...getStatus(), state: "refreshed", message: "Account session refreshed." };
}

async function restoreSession() {
  const status = getStatus();
  if (status.authenticated) {
    return { ...status, state: "authenticated", restorationState: "authenticated", message: "Account session restored." };
  }
  const session = getRefreshableSession();
  if (!session) {
    return { ...status, state: status.sessionStatus === "expired" ? "signed-out" : "local", restorationState: "signed-out" };
  }
  if (!status.configured) {
    return {
      ...status,
      state: "refresh-unavailable",
      restorationState: "refresh-unavailable",
      message: "Account session is saved, but account refresh is not configured.",
    };
  }
  try {
    const refreshed = await refreshSession();
    return { ...refreshed, restorationState: "authenticated" };
  } catch (error) {
    if (isTransientAccountError(error)) {
      audit({ action: "account.refresh", outcome: "deferred", reason: error.code || "transient" });
      return {
        ...getStatus(),
        authenticated: false,
        state: "temporarily-offline",
        restorationState: "temporarily-offline",
        message: "Account session could not be refreshed because the account service is temporarily unavailable.",
        refreshErrorCode: error.code || "ACCOUNT_REFRESH_TRANSIENT",
      };
    }
    if (isInvalidRefreshError(error)) {
      const account = publicAccount(session);
      clearSession();
      audit({ action: "account.refresh", outcome: "revoked", target: account?.username || null, reason: error.code || "invalid_refresh" });
      return {
        ...getStatus(),
        state: "signed-out",
        restorationState: "invalid",
        message: "Account session is no longer valid. Sign in again.",
        refreshErrorCode: error.code || "ACCOUNT_REFRESH_INVALID",
      };
    }
    throw error;
  }
}

async function openAccountPage() {
  const targetUrl = pendingDeviceLogin?.verificationUrl || buildWebsiteUrl(getCurrentSession() ? "account" : "signin");
  const url = assertApprovedExternalUrl(targetUrl, "account");
  await openExternalUrl(url, { source: "account-page" });
  return { ok: true, url };
}

async function logout() {
  const session = getCurrentSession({ allowExpired: true });
  if (session?.accessToken && getAccountApiUrl()) {
    await postJson(`${getAccountApiUrl()}/api/auth/logout`, {}, { accessToken: session.accessToken }).catch((error) => {
      console.warn("[Account] Logout revoke failed.", { code: error?.code || null, message: redactSecret(error?.message || String(error)) });
    });
  }
  const account = publicAccount(session);
  clearSession();
  pendingDeviceLogin = null;
  audit({ action: "account.logout", outcome: "ok", target: account?.username || null });
  return getStatus();
}

async function listAccountDevices() {
  const session = getCurrentSession();
  if (!session?.accessToken || !getAccountApiUrl()) {
    return { devices: [] };
  }
  return getJson(`${getAccountApiUrl()}/api/account/devices`, { accessToken: session.accessToken });
}

async function revokeCurrentDevice() {
  const session = getCurrentSession({ allowExpired: true });
  const deviceId = session?.device?.id || session?.device?.deviceId || null;
  if (session?.accessToken && getAccountApiUrl() && deviceId) {
    await postJson(`${getAccountApiUrl()}/api/account/devices/revoke`, { deviceId }, { accessToken: session.accessToken }).catch((error) => {
      console.warn("[Account] Device revoke failed.", { code: error?.code || null, message: redactSecret(error?.message || String(error)) });
    });
  } else if (session?.accessToken && getAccountApiUrl()) {
    await postJson(`${getAccountApiUrl()}/api/auth/logout`, {}, { accessToken: session.accessToken }).catch(() => {});
  }
  clearSession();
  pendingDeviceLogin = null;
  audit({ action: "account.device.revokeCurrent", outcome: "ok" });
  return getStatus();
}

module.exports = {
  cancelDeviceLogin,
  checkDeviceLogin,
  getCurrentSession,
  getStatus,
  buildWebsiteUrl,
  listAccountDevices,
  logout,
  openAccountPage,
  restoreSession,
  refreshSession,
  revokeCurrentDevice,
  loginWithPassword,
  redactSecret,
  startDeviceLogin,
};
