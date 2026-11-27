// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// 217-C (prepared, not deployed): the primary website is added beside the
// legacy origin, never instead of it.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://anxoscontrolcenter.org",
  "https://anxhost.anxlabs.net",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const desktopTokenSecret = Deno.env.get("ANXOS_DESKTOP_TOKEN_SECRET") || "";
const deviceCodeSecret = Deno.env.get("ANXOS_DEVICE_CODE_SECRET") || desktopTokenSecret;
const OFFICIAL_WEBSITE_BASE_URL = "https://anxoscontrolcenter.org";
const websiteBaseUrl = normalizeWebsiteBaseUrl(Deno.env.get("ANXOS_WEBSITE_BASE_URL"));
const configuredAllowedOrigins = (Deno.env.get("ANXOS_ALLOWED_ORIGINS") || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredAllowedOrigins]));

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type JsonMap = Record<string, unknown>;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  try {
    assertConfigured();
    const url = new URL(request.url);
    const route = normalizeRoute(url.pathname);

    if (request.method === "POST" && route === "/api/auth/device/start") return json(request, await startDevice(request));
    if (request.method === "POST" && route === "/api/auth/device/poll") return json(request, await pollDevice(request));
    if (request.method === "POST" && route === "/api/auth/device/lookup") return json(request, await lookupDevice(request));
    if (request.method === "POST" && route === "/api/auth/device/approve") return json(request, await approveDevice(request));
    if (request.method === "POST" && route === "/api/auth/device/deny") return json(request, await denyDevice(request));
    if (request.method === "POST" && route === "/api/auth/refresh") return json(request, await refreshDesktopSession(request));
    if (request.method === "POST" && route === "/api/auth/logout") return json(request, await logoutDesktopSession(request));
    if (request.method === "GET" && route === "/api/account/devices") return json(request, await listDevices(request));
    if (request.method === "POST" && route === "/api/account/devices/revoke") return json(request, await revokeDevice(request));
    if (request.method === "POST" && route === "/api/account/devices/clear-revoked") return json(request, await clearRevokedDevices(request));
    if (request.method === "GET" && route === "/api/account/sessions") return json(request, await listSessions(request));
    if (request.method === "POST" && route === "/api/account/sessions/revoke-all") return json(request, await revokeAllSessions(request));
    if (request.method === "POST" && route === "/api/account/sessions/clear-expired") return json(request, await clearExpiredSessions(request));
    if (request.method === "POST" && route === "/api/account/cleanup-inactive") return json(request, await clearInactiveAccountRecords(request));
    if (request.method === "GET" && route === "/api/account/security-events") return json(request, await listSecurityEvents(request));

    return json(request, { code: "NOT_FOUND", message: "Endpoint not found." }, 404);
  } catch (error: unknown) {
    const accountError = normalizeCaughtError(error);
    const status = Number.isInteger(accountError.status) ? Number(accountError.status) : 500;
    const code = accountError.code || (status === 401 ? "AUTH_REQUIRED" : "ACCOUNT_API_ERROR");
    const message = status >= 500 ? "Account service failed. Try again later." : sanitizeMessage(accountError.message || "Account request failed.");
    console.warn("[anxos-account]", { code, status, message });
    return json(request, { code, message }, status);
  }
});

function assertConfigured() {
  if (!supabaseUrl || !serviceRoleKey || !desktopTokenSecret || !deviceCodeSecret) {
    throw httpError(503, "ACCOUNT_SERVICE_NOT_CONFIGURED", "Account service is not configured.");
  }
}

function normalizeRoute(pathname: string) {
  return pathname
    .replace(/^\/functions\/v1\/anxos-account/, "")
    .replace(/^\/anxos-account/, "")
    .replace(/\/+$/, "") || "/";
}

function normalizeWebsiteBaseUrl(value: string | undefined) {
  const configured = trimSlash(value || "");
  if (!configured || configured === "https://anxos-control-center.pages.dev") return OFFICIAL_WEBSITE_BASE_URL;
  return configured;
}

async function startDevice(request: Request) {
  const payload = await readJson(request);
  await cleanupExpired();
  const deviceCode = randomCode(32);
  const userCode = randomUserCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const row = {
    device_code_hash: await hmacHex(deviceCodeSecret, deviceCode),
    user_code_hash: await hmacHex(deviceCodeSecret, normalizeUserCode(userCode)),
    user_code_hint: maskUserCode(userCode),
    status: "pending",
    device_name: safeText(payload.deviceName, "Unknown device", 120),
    platform: safeText(payload.platform, "desktop", 60),
    arch: safeText(payload.arch, "", 40),
    app_name: safeText(payload.app || payload.appName, "AnxOS-Control-Center", 80),
    app_version: safeText(payload.appVersion, "", 40),
    request_ip: clientIp(request),
    user_agent: safeText(request.headers.get("user-agent"), "", 300),
    poll_interval_seconds: 5,
    expires_at: expiresAt,
  };
  const { error } = await admin.from("device_authorization_requests").insert(row);
  if (error) throw httpError(500, "DEVICE_START_FAILED", "Could not start device sign-in.");
  await logSecurityEvent(null, "device_authorization_started", "ok", request, { platform: row.platform, appVersion: row.app_version });
  return {
    deviceCode,
    userCode,
    verificationUrl: `${websiteBaseUrl}/activate/?code=${encodeURIComponent(userCode)}`,
    expiresIn: 600,
    pollInterval: 5,
  };
}

async function pollDevice(request: Request) {
  const payload = await readJson(request);
  const deviceCode = String(payload.deviceCode || payload.device_code || "");
  if (!deviceCode) throw httpError(400, "DEVICE_CODE_REQUIRED", "Device code is required.");
  const hash = await hmacHex(deviceCodeSecret, deviceCode);
  const { data: record, error } = await admin
    .from("device_authorization_requests")
    .select("*")
    .eq("device_code_hash", hash)
    .maybeSingle();
  if (error) throw httpError(500, "DEVICE_POLL_FAILED", "Could not check device sign-in.");
  if (!record) return { state: "expired" };
  if (isExpired(record.expires_at)) {
    await markDeviceRequest(record.id, { status: "expired" });
    return { state: "expired" };
  }
  if (record.status === "denied") return { state: "denied" };
  if (record.status === "consumed" || record.consumed_at) return { state: "expired" };

  const now = Date.now();
  const lastPolled = record.last_polled_at ? Date.parse(record.last_polled_at) : 0;
  const intervalMs = Math.max(3, Number(record.poll_interval_seconds || 5)) * 1000;
  if (lastPolled && now - lastPolled < intervalMs) {
    await admin.from("device_authorization_requests").update({
      poll_interval_seconds: Math.min(30, Number(record.poll_interval_seconds || 5) + 2),
      poll_count: Number(record.poll_count || 0) + 1,
      last_polled_at: new Date().toISOString(),
    }).eq("id", record.id);
    return { state: "slow_down", pollInterval: Math.min(30, Number(record.poll_interval_seconds || 5) + 2) };
  }

  await admin.from("device_authorization_requests").update({
    poll_count: Number(record.poll_count || 0) + 1,
    last_polled_at: new Date().toISOString(),
  }).eq("id", record.id);

  if (record.status !== "approved" || !record.approved_by) {
    return { state: "pending", pollInterval: Number(record.poll_interval_seconds || 5) };
  }

  const session = await createDesktopSession(record, request);
  await admin.from("device_authorization_requests").update({
    status: "consumed",
    consumed_at: new Date().toISOString(),
  }).eq("id", record.id).eq("status", "approved").is("consumed_at", null);
  await logSecurityEvent(record.approved_by, "desktop_session_issued", "ok", request, { deviceId: session.deviceId });
  return {
    state: "approved",
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: 3600,
    account: session.account,
    device: session.device,
    provider: "AnxOS",
  };
}

async function lookupDevice(request: Request) {
  const payload = await readJson(request);
  const userCode = normalizeUserCode(payload.userCode || payload.user_code || payload.code);
  if (!userCode) throw httpError(400, "USER_CODE_REQUIRED", "Device code is required.");
  const record = await getRequestByUserCode(userCode);
  if (!record || isExpired(record.expires_at)) return { state: "expired" };
  if (record.status !== "pending") return { state: record.status };
  return { state: "pending", device: publicDeviceRequest(record) };
}

async function approveDevice(request: Request) {
  const user = await requireWebsiteUser(request);
  const payload = await readJson(request);
  const userCode = normalizeUserCode(payload.userCode || payload.user_code || payload.code);
  const record = await getRequestByUserCode(userCode);
  if (!record || isExpired(record.expires_at)) return { state: "expired" };
  if (record.status !== "pending") return { state: record.status };
  const { error } = await admin.from("device_authorization_requests").update({
    status: "approved",
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  }).eq("id", record.id).eq("status", "pending");
  if (error) throw httpError(500, "DEVICE_APPROVAL_FAILED", "Could not approve this device.");
  await logSecurityEvent(user.id, "device_authorization_approved", "ok", request, publicDeviceRequest(record));
  return { state: "approved", device: publicDeviceRequest(record) };
}

async function denyDevice(request: Request) {
  const user = await requireWebsiteUser(request);
  const payload = await readJson(request);
  const userCode = normalizeUserCode(payload.userCode || payload.user_code || payload.code);
  const record = await getRequestByUserCode(userCode);
  if (!record || isExpired(record.expires_at)) return { state: "expired" };
  if (record.status !== "pending") return { state: record.status };
  const { error } = await admin.from("device_authorization_requests").update({
    status: "denied",
    denied_by: user.id,
    denied_at: new Date().toISOString(),
  }).eq("id", record.id).eq("status", "pending");
  if (error) throw httpError(500, "DEVICE_DENIAL_FAILED", "Could not deny this device.");
  await logSecurityEvent(user.id, "device_authorization_denied", "denied", request, publicDeviceRequest(record));
  return { state: "denied" };
}

async function refreshDesktopSession(request: Request) {
  const payload = await readJson(request);
  const refreshToken = String(payload.refreshToken || payload.refresh_token || "");
  if (!refreshToken) throw httpError(401, "REFRESH_TOKEN_REQUIRED", "Refresh token is required.");
  const refreshHash = await sha256Hex(refreshToken);
  const { data: session, error } = await admin
    .from("account_sessions")
    .select("*, registered_devices(*)")
    .eq("refresh_token_hash", refreshHash)
    .maybeSingle();
  if (error) throw httpError(500, "SESSION_REFRESH_FAILED", "Could not refresh account session.");
  if (!session || session.revoked_at || isExpired(session.expires_at) || session.registered_devices?.revoked_at) {
    throw httpError(401, "SESSION_EXPIRED", "Account session expired. Sign in again.");
  }
  const nextRefreshToken = randomCode(48);
  const nextHash = await sha256Hex(nextRefreshToken);
  await admin.from("account_sessions").update({
    refresh_token_hash: nextHash,
    last_seen_at: new Date().toISOString(),
  }).eq("id", session.id);
  await admin.from("registered_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", session.device_id);
  const account = await getAccount(session.user_id);
  return {
    accessToken: await signDesktopToken({ sub: session.user_id, sid: session.id, did: session.device_id }, 3600),
    refreshToken: nextRefreshToken,
    expiresIn: 3600,
    account,
    provider: "AnxOS",
  };
}

async function logoutDesktopSession(request: Request) {
  const token = readBearer(request);
  if (token) {
    const claims = await verifyDesktopToken(token).catch(() => null);
    if (claims?.sid) {
      await admin.from("account_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", claims.sid);
      await logSecurityEvent(String(claims.sub || ""), "desktop_session_revoked", "ok", request, { sessionId: claims.sid });
    }
  }
  return { ok: true };
}

async function listDevices(request: Request) {
  const user = await requireWebsiteUser(request);
  const { data, error } = await admin
    .from("registered_devices")
    .select("id,device_name,platform,arch,app_name,app_version,first_seen_at,last_seen_at,revoked_at,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) throw httpError(500, "DEVICES_LIST_FAILED", "Could not list devices.");
  return { devices: data || [] };
}

async function revokeDevice(request: Request) {
  const user = await requireWebsiteUser(request);
  const payload = await readJson(request);
  const deviceId = String(payload.deviceId || payload.device_id || "");
  if (!deviceId) throw httpError(400, "DEVICE_ID_REQUIRED", "Device ID is required.");
  await admin.from("registered_devices").update({
    revoked_at: new Date().toISOString(),
    revoked_reason: "user_revoked",
  }).eq("id", deviceId).eq("user_id", user.id);
  await admin.from("account_sessions").update({ revoked_at: new Date().toISOString() }).eq("device_id", deviceId).eq("user_id", user.id);
  await logSecurityEvent(user.id, "registered_device_revoked", "ok", request, { deviceId });
  return { ok: true };
}

async function clearRevokedDevices(request: Request) {
  const user = await requireWebsiteUser(request);
  const result = await deleteRevokedDevicesForUser(user.id);
  await logSecurityEvent(user.id, "revoked_devices_cleared", "ok", request, { deletedDevices: result.deletedDevices });
  return { ok: true, ...result };
}

async function listSessions(request: Request) {
  const user = await requireWebsiteUser(request);
  const { data, error } = await admin
    .from("account_sessions")
    .select("id,device_id,created_at,last_seen_at,expires_at,revoked_at,registered_devices(device_name,platform,app_version)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) throw httpError(500, "SESSIONS_LIST_FAILED", "Could not list sessions.");
  return { sessions: data || [] };
}

async function revokeAllSessions(request: Request) {
  const user = await requireWebsiteUser(request);
  await admin.from("account_sessions").update({ revoked_at: new Date().toISOString() }).eq("user_id", user.id).is("revoked_at", null);
  await logSecurityEvent(user.id, "sessions_revoked", "ok", request, {});
  return { ok: true };
}

async function clearExpiredSessions(request: Request) {
  const user = await requireWebsiteUser(request);
  const result = await deleteInactiveSessionsForUser(user.id);
  await logSecurityEvent(user.id, "expired_sessions_cleared", "ok", request, { deletedSessions: result.deletedSessions });
  return { ok: true, ...result };
}

async function clearInactiveAccountRecords(request: Request) {
  const user = await requireWebsiteUser(request);
  const sessions = await deleteInactiveSessionsForUser(user.id);
  const devices = await deleteRevokedDevicesForUser(user.id);
  const result = { deletedDevices: devices.deletedDevices, deletedSessions: sessions.deletedSessions };
  await logSecurityEvent(user.id, "inactive_account_records_cleared", "ok", request, result);
  return { ok: true, ...result };
}

async function deleteRevokedDevicesForUser(userId: string) {
  const { count, error } = await admin
    .from("registered_devices")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .not("revoked_at", "is", null);
  if (error) throw httpError(500, "REVOKED_DEVICES_CLEAR_FAILED", "Could not clear revoked devices.");
  return { deletedDevices: count || 0 };
}

async function deleteInactiveSessionsForUser(userId: string) {
  const now = new Date().toISOString();
  const { count, error } = await admin
    .from("account_sessions")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .or(`revoked_at.not.is.null,expires_at.lt.${now}`);
  if (error) throw httpError(500, "EXPIRED_SESSIONS_CLEAR_FAILED", "Could not clear expired sessions.");
  return { deletedSessions: count || 0 };
}

async function listSecurityEvents(request: Request) {
  const user = await requireWebsiteUser(request);
  const { data, error } = await admin
    .from("security_events")
    .select("id,event_type,outcome,metadata,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw httpError(500, "SECURITY_EVENTS_LIST_FAILED", "Could not list security history.");
  return { events: data || [] };
}

async function createDesktopSession(record: any, request: Request) {
  const userId = record.approved_by;
  const account = await getAccount(userId);
  const { data: device, error: deviceError } = await admin.from("registered_devices").insert({
    user_id: userId,
    device_name: record.device_name,
    platform: record.platform,
    arch: record.arch,
    app_name: record.app_name,
    app_version: record.app_version,
    last_seen_at: new Date().toISOString(),
  }).select("id,device_name,platform,arch,app_name,app_version,created_at,last_seen_at").single();
  if (deviceError) throw httpError(500, "DEVICE_REGISTER_FAILED", "Could not register this device.");

  const refreshToken = randomCode(48);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: session, error: sessionError } = await admin.from("account_sessions").insert({
    user_id: userId,
    device_id: device.id,
    refresh_token_hash: await sha256Hex(refreshToken),
    user_agent: safeText(request.headers.get("user-agent"), "", 300),
    ip: clientIp(request),
    expires_at: expiresAt,
  }).select("id").single();
  if (sessionError) throw httpError(500, "SESSION_CREATE_FAILED", "Could not create account session.");

  return {
    accessToken: await signDesktopToken({ sub: userId, sid: session.id, did: device.id }, 3600),
    refreshToken,
    account,
    deviceId: device.id,
    device,
  };
}

async function getAccount(userId: string) {
  const { data: profile } = await admin.from("profiles").select("id,username,display_name,avatar_url,role,bio,time_zone,preferred_platform,website_url,github_url,created_at,updated_at").eq("id", userId).maybeSingle();
  const { data: userResult } = await admin.auth.admin.getUserById(userId);
  return {
    id: userId,
    email: userResult?.user?.email || null,
    username: profile?.username || null,
    displayName: profile?.display_name || profile?.username || userResult?.user?.email || "AnxOS Account",
    avatarUrl: profile?.avatar_url || null,
    role: profile?.role || "user",
    bio: profile?.bio || null,
    timeZone: profile?.time_zone || null,
    preferredPlatform: profile?.preferred_platform || null,
    websiteUrl: profile?.website_url || null,
    githubUrl: profile?.github_url || null,
  };
}

async function requireWebsiteUser(request: Request) {
  const token = readBearer(request);
  if (!token) throw httpError(401, "AUTH_REQUIRED", "Sign in before continuing.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw httpError(401, "AUTH_REQUIRED", "Sign in before continuing.");
  return data.user;
}

async function getRequestByUserCode(userCode: string) {
  const userCodeHash = await hmacHex(deviceCodeSecret, normalizeUserCode(userCode));
  const { data, error } = await admin
    .from("device_authorization_requests")
    .select("*")
    .eq("user_code_hash", userCodeHash)
    .maybeSingle();
  if (error) throw httpError(500, "DEVICE_LOOKUP_FAILED", "Could not look up this device code.");
  return data;
}

async function markDeviceRequest(id: string, patch: JsonMap) {
  await admin.from("device_authorization_requests").update(patch).eq("id", id);
}

async function cleanupExpired() {
  try {
    await admin.rpc("cleanup_expired_device_authorizations");
  } catch {
    // Cleanup is opportunistic; request handling still validates expiration.
  }
}

function publicDeviceRequest(record: any) {
  return {
    id: record.id,
    deviceName: record.device_name,
    platform: record.platform,
    arch: record.arch,
    appName: record.app_name,
    appVersion: record.app_version,
    requestedAt: record.created_at,
    expiresAt: record.expires_at,
  };
}

async function logSecurityEvent(userId: string | null, eventType: string, outcome: string, request: Request, metadata: JsonMap) {
  try {
    await admin.from("security_events").insert({
      user_id: userId,
      event_type: eventType,
      outcome,
      ip: clientIp(request),
      user_agent: safeText(request.headers.get("user-agent"), "", 300),
      metadata: redactObject(metadata),
    });
  } catch {
    // Audit logging must not break account flows.
  }
}

async function readJson(request: Request) {
  if (request.method === "GET") return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(request: Request, body: JsonMap, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "";
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-client-info,apikey",
    "vary": "Origin",
  };
}

function readBearer(request: Request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

function safeText(value: unknown, fallback = "", max = 120) {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function normalizeUserCode(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function randomUserCode() {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += USER_CODE_ALPHABET[Math.floor(Math.random() * USER_CODE_ALPHABET.length)];
  }
  return code;
}

function randomCode(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function maskUserCode(value: string) {
  const code = normalizeUserCode(value);
  return code.length > 4 ? `${code.slice(0, 2)}***${code.slice(-2)}` : "***";
}

function trimSlash(value: string) {
  return String(value || "").replace(/\/+$/, "");
}

function isExpired(value: string) {
  return !value || Date.parse(value) <= Date.now();
}

function sanitizeMessage(value: string) {
  return String(value || "Account request failed.")
    .replace(/(access[_-]?token|refresh[_-]?token|device[_-]?code|authorization|secret|password)["'=:\s]+[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
}

function redactObject(value: JsonMap) {
  return JSON.parse(sanitizeMessage(JSON.stringify(value || {})));
}

function httpError(status: number, code: string, message: string) {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = status;
  error.code = code;
  return error;
}

function normalizeCaughtError(error: unknown): { status?: number; code?: string; message?: string } {
  if (error && typeof error === "object") {
    const record = error as { status?: number; code?: string; message?: string };
    return {
      status: record.status,
      code: record.code,
      message: record.message,
    };
  }
  return { message: String(error || "Account request failed.") };
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return hex(signature);
}

async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signDesktopToken(payload: JsonMap, expiresInSeconds: number) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = {
    ...payload,
    iss: "anxos-account",
    aud: "anxos-desktop",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(body)}`;
  return `${unsigned}.${await hmacBase64Url(desktopTokenSecret, unsigned)}`;
}

async function verifyDesktopToken(token: string) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw httpError(401, "TOKEN_INVALID", "Account token is invalid.");
  const expected = await hmacBase64Url(desktopTokenSecret, `${header}.${payload}`);
  if (!timingSafeEqual(signature, expected)) throw httpError(401, "TOKEN_INVALID", "Account token is invalid.");
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  if (Number(claims.exp || 0) <= Math.floor(Date.now() / 1000)) throw httpError(401, "TOKEN_EXPIRED", "Account token expired.");
  return claims;
}

async function hmacBase64Url(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

function base64UrlJson(value: JsonMap) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}
