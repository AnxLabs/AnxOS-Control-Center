"use strict";

// The phone gateway: an HTTPS server in the desktop's main process that
// serves the mobile web app and its small API. Off unless the owner turns
// on Phone access.
//
// Requests are refused unless:
//   * they come from a private address (home network, loopback, CGNAT ranges
//     used by Tailscale-style VPNs); a router port-forward to the internet
//     still gets nothing,
//   * the Host header names this gateway (blocks DNS-rebinding pages),
//   * API calls carry a valid session cookie (HttpOnly, Secure,
//     SameSite=Strict), and changes also carry the CSRF header and a
//     same-origin Origin header.
// No CORS headers are ever sent, API responses are never cached, and the
// page runs under a strict Content Security Policy.

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const net = require("net");
const path = require("path");

const COOKIE = "__Host-anxos-session";
const DEFAULT_MAX_BODY = 256 * 1024;
const REQUESTS_PER_MINUTE = 600;
const PAIR_ATTEMPTS_PER_WINDOW = 10;
const PAIR_WINDOW_MS = 5 * 60 * 1000;
const SHARED_MODULES = Object.freeze(["homeDashboardModel.js", "serverViewModel.js", "restorePreview.js"]);
const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
});
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
});

function plainAddress(address) {
  const value = String(address || "");
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

// Home networks, loopback, link-local and 100.64/10 (CGNAT, used by
// Tailscale-style VPNs). Anything else is the open internet.
function isPrivateAddress(address) {
  const ip = plainAddress(address);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  return false;
}

// How a phone reached this computer, in words, from its source address.
function connectionPath(address) {
  const ip = plainAddress(address);
  if (ip === "127.0.0.1" || ip === "::1") return "this computer";
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return "a VPN (100.64.0.0/10, for example Tailscale)";
  return "your home network";
}

// One on-device check result, reduced to plain values with fixed keys.
function cleanPhoneCheck(body) {
  const number = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null);
  const text = (value, max = 120) => String(value ?? "").replace(/[\u0000-\u001f<>]/g, "").slice(0, max);
  const flag = (value) => value === true;
  const checks = Array.isArray(body.checks) ? body.checks.slice(0, 30).map((entry) => ({ id: text(entry?.id, 40), ok: entry?.ok === true ? true : entry?.ok === false ? false : null, detail: text(entry?.detail, 200) })) : [];
  return {
    userAgent: text(body.userAgent, 300),
    standalone: flag(body.standalone),
    secureContext: flag(body.secureContext),
    serviceWorker: text(body.serviceWorker, 20),
    viewport: { width: number(body.viewport?.width), height: number(body.viewport?.height), dpr: number(body.viewport?.dpr) },
    safeArea: { top: number(body.safeArea?.top), right: number(body.safeArea?.right), bottom: number(body.safeArea?.bottom), left: number(body.safeArea?.left) },
    orientation: text(body.orientation, 30),
    touchPoints: number(body.touchPoints),
    latencyMs: number(body.latencyMs),
    checks,
  };
}

function parseCookies(header) {
  const cookies = {};
  String(header || "").split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  });
  return cookies;
}

function pemToDer(pem) {
  return Buffer.from(String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

// Reads the web app's files once, at start. Only these exact paths are served.
function loadStatic(webRoot, sharedRoot, iconsRoot) {
  const files = new Map();
  const add = (urlPath, file) => {
    const body = fs.readFileSync(file);
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (!type) return;
    files.set(urlPath, { body, type, etag: `"${crypto.createHash("sha256").update(body).digest("base64url").slice(0, 22)}"` });
  };
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (entry.isFile()) add(`/${prefix}${entry.name}`, full);
    }
  };
  walk(webRoot, "");
  SHARED_MODULES.forEach((name) => add(`/shared/${name}`, path.join(sharedRoot, name)));
  // 216-C: the phone uses the desktop's own design tokens, not a copy.
  add("/tokens.css", path.join(sharedRoot, "..", "renderer", "anxhost", "tokens.css"));
  [512, 256, 192, 180, 128].forEach((size) => {
    const file = path.join(iconsRoot, `${size}x${size}.png`);
    if (fs.existsSync(file)) add(`/icons/${size}.png`, file);
  });
  if (files.has("/index.html")) files.set("/", files.get("/index.html"));
  return files;
}

function createGateway({ certificates, sessions, api, webRoot, sharedRoot, iconsRoot, port = 0, host = "0.0.0.0", allowedHosts = [], onDevicesChanged = () => {}, onPhoneCheck = () => {}, log = () => {} }) {
  const staticFiles = loadStatic(webRoot, sharedRoot, iconsRoot);
  const caDer = pemToDer(certificates.caCert);
  const rate = new Map();
  const pairAttempts = new Map();
  let server = null;
  let boundPort = null;

  function hostAllowed(hostHeader) {
    const value = String(hostHeader || "").toLowerCase();
    const match = /^(\[[0-9a-f:]+\]|[^:]+)(?::(\d+))?$/.exec(value);
    if (!match) return false;
    const name = match[1].replace(/^\[|\]$/g, "");
    const portPart = match[2] ? Number(match[2]) : 443;
    if (portPart !== boundPort) return false;
    return ["localhost", "127.0.0.1", ...certificates.ips, ...allowedHosts].map((entry) => String(entry).toLowerCase()).includes(name);
  }

  function send(res, status, body, headers = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Length": payload.length, ...headers });
    res.end(payload);
  }

  function sendJson(res, status, body, headers = {}) {
    send(res, status, JSON.stringify(body), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  }

  function sendError(res, status, code, message, extra = {}) {
    sendJson(res, status, { ok: false, error: { code, message, ...extra } });
  }

  function limited(map, key, max, windowMs) {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now - entry.start > windowMs) {
      map.set(key, { start: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  }

  function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        reject(Object.assign(new Error("Request too large."), { status: 413, code: "TOO_LARGE", expose: true }));
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(Object.assign(new Error("Request too large."), { status: 413, code: "TOO_LARGE", expose: true }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!size) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          resolve(parsed);
        } catch {
          reject(Object.assign(new Error("The request was not readable."), { status: 400, code: "INVALID_JSON", expose: true }));
        }
      });
      req.on("error", reject);
    });
  }

  function sameOrigin(req) {
    return req.headers.origin === `https://${req.headers.host}`;
  }

  function sessionCookie(token, maxAgeSeconds) {
    return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
  }

  async function handleApi(req, res, url, address) {
    const pathname = url.pathname.slice(4) || "/";
    const method = req.method;
    const isChange = method !== "GET" && method !== "HEAD";
    if (isChange) {
      if (!sameOrigin(req)) return sendError(res, 403, "ORIGIN_REJECTED", "This request did not come from the AnxOS phone app.");
      if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return sendError(res, 415, "JSON_REQUIRED", "Requests must be JSON.");
    }

    if (pathname === "/pair" && method === "POST") {
      if (limited(pairAttempts, address, PAIR_ATTEMPTS_PER_WINDOW, PAIR_WINDOW_MS)) return sendError(res, 429, "TOO_MANY_ATTEMPTS", "Too many pairing attempts. Wait a few minutes.");
      const body = await readBody(req, 4096);
      const { token, device } = sessions.redeemPairing(body.code, { deviceName: body.deviceName, address });
      log("info", "paired", { deviceId: device.id, role: device.role });
      onDevicesChanged();
      return sendJson(res, 200, { ok: true, device }, { "Set-Cookie": sessionCookie(token, 90 * 24 * 60 * 60) });
    }

    const token = parseCookies(req.headers.cookie)[COOKIE];
    const device = sessions.authenticate(token, { address });
    if (!device) return sendError(res, 401, "NOT_PAIRED", "This phone isn't paired, or its access ended. Pair it again from the computer.");
    if (limited(rate, device.id, REQUESTS_PER_MINUTE, 60 * 1000)) return sendError(res, 429, "SLOW_DOWN", "Too many requests. Wait a moment.");
    if (isChange && !sessions.checkCsrf(device.tokenHash, req.headers["x-anxos-csrf"])) {
      return sendError(res, 403, "CSRF_REJECTED", "This request could not be verified. Reload the app.");
    }
    const publicDevice = { id: device.id, name: device.name, role: device.role, createdAt: device.createdAt, expiresAt: device.expiresAt };

    if (pathname === "/session" && method === "GET") {
      return sendJson(res, 200, { ok: true, device: publicDevice, capabilities: api.capabilities(device), csrf: sessions.csrfFor(device.tokenHash), connection: { via: connectionPath(address), tls: req.socket.getProtocol?.() || "" } });
    }
    // The owner runs "Check this phone" on a real device and sends the result
    // to the computer, where Phone Access lists it. Any paired role may send
    // one; it holds only browser facts, never server data.
    if (pathname === "/phone-check" && method === "POST") {
      if (limited(rate, `check:${device.id}`, 10, 60 * 1000)) return sendError(res, 429, "SLOW_DOWN", "Too many checks. Wait a moment.");
      const body = await readBody(req, 32 * 1024);
      const report = { ...cleanPhoneCheck(body), deviceId: device.id, deviceName: device.name, role: device.role, via: connectionPath(address), tls: req.socket.getProtocol?.() || "", at: new Date().toISOString() };
      onPhoneCheck(report);
      return sendJson(res, 200, { ok: true, received: report.at });
    }
    if (pathname === "/logout" && method === "POST") {
      sessions.revokeDevice(device.id);
      onDevicesChanged();
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    }

    const found = api.match(method, pathname);
    if (!found) return sendError(res, 404, "NOT_FOUND", "Not found.");
    if (found.error) return sendError(res, found.error.status, found.error.code, found.error.message);
    const body = isChange ? await readBody(req, found.route.maxBody || DEFAULT_MAX_BODY) : {};
    const result = await api.handle(found.route, { params: found.params, query: url.searchParams, body, device });
    if (result && result.download) {
      return send(res, 200, result.download.buffer, {
        "Content-Type": result.download.contentType,
        "Content-Disposition": `attachment; filename="${result.download.fileName}"`,
        "Cache-Control": "no-store",
      });
    }
    return sendJson(res, 200, result && typeof result === "object" && !Array.isArray(result) ? { ok: true, ...result } : { ok: true, result });
  }

  async function onRequest(req, res) {
    const address = plainAddress(req.socket.remoteAddress);
    if (!isPrivateAddress(address)) {
      req.socket.destroy();
      return undefined;
    }
    if (!hostAllowed(req.headers.host)) return sendError(res, 421, "WRONG_HOST", "Open AnxOS using the address shown on the computer.");
    let url;
    try {
      url = new URL(req.url, `https://${req.headers.host}`);
    } catch {
      return sendError(res, 400, "BAD_URL", "Bad address.");
    }
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await handleApi(req, res, url, address);
      if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "METHOD_NOT_ALLOWED", "Not allowed.");
      if (url.pathname === "/anxos-local-ca.crt") {
        return send(res, 200, caDer, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=\"anxos-local-ca.crt\"", "Cache-Control": "no-cache" });
      }
      const file = staticFiles.get(url.pathname);
      if (!file) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      if (req.headers["if-none-match"] === file.etag) return send(res, 304, Buffer.alloc(0), { ETag: file.etag });
      const extra = url.pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {};
      return send(res, 200, req.method === "HEAD" ? Buffer.alloc(0) : file.body, { "Content-Type": file.type, "Cache-Control": "no-cache", ETag: file.etag, ...extra });
    } catch (error) {
      const shaped = error && error.expose ? { status: error.status, code: error.code, message: error.message } : api.toPublicError(error);
      if (shaped.status >= 500) log("warn", "request-failed", { path: url.pathname.replace(/\/[^/]+/g, (part) => (part.length > 24 ? "/…" : part)), code: shaped.code });
      if (!res.headersSent) return sendError(res, shaped.status, shaped.code, shaped.message, error && error.fields ? { fields: error.fields } : {});
      res.destroy();
      return undefined;
    }
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = https.createServer({ key: certificates.key, cert: certificates.cert, minVersion: "TLSv1.2" }, (req, res) => {
          onRequest(req, res).catch(() => res.destroy());
        });
        server.headersTimeout = 15000;
        server.requestTimeout = 120000;
        server.keepAliveTimeout = 5000;
        server.on("tlsClientError", () => {});
        server.once("error", reject);
        server.listen(port, host, () => {
          boundPort = server.address().port;
          server.removeListener("error", reject);
          resolve({ port: boundPort, host });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        const closing = server;
        server = null;
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
    },
    get port() {
      return boundPort;
    },
  };
}

module.exports = { createGateway, isPrivateAddress, connectionPath, COOKIE };
