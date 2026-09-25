const http = require("http");
const { sanitizeForDiagnostics } = require("../../src/shared/redaction");
const { URL } = require("url");

const { handleActionInvoke, handleActionsList } = require("./routes/actions");
const { handleAgentTask } = require("./routes/agentTask");
const { handleAmpInstances, handleAmpSnapshot, handleAmpStatus } = require("./routes/amp");
const { auditAction } = require("./audit/auditLogger");
const { handleBackups, handleBackupsList } = require("./routes/backups");
const { recoverBackupArtifacts, startBackupScheduler, stopBackupScheduler } = require("./services/backupService");
const { startRestartScheduler, stopRestartScheduler } = require("./services/restartScheduleService");
const instanceService = require("./services/instances/instanceService");
const { handleConsoleCommands, handleConsoleLogs } = require("./routes/console");
const { handleCurseForgeProxy } = require("./services/curseforgeProxyService");
const { isAuthorized } = require("./auth");
const { getConfig } = require("./config");
const { handleDocker, handleDockerContainers, handleDockerSnapshot, handleDockerSummary } = require("./routes/docker");
const { handleDiagnostics } = require("./routes/diagnostics");
const { handleDependencies } = require("./routes/dependencies");
const {
  PUBLIC_ENROLL_PATHS,
  assertEnrollmentGate,
  getEnrollmentRoutePermission,
  handleEnrollmentManagement,
  handlePublicEnrollment,
  registerEnrollmentStartup,
} = require("./routes/enroll");
const { resolveEnrollmentScopeContext } = require("./services/enrollmentService");
const { handleFilesDownload, handleFilesIdentity, handleFilesList, handleFilesMutate, handleFilesRead, handleFilesStat } = require("./routes/files");
const { handleHealth } = require("./routes/health");
const { handleInstances } = require("./routes/instances");
const { handleJobs } = require("./routes/jobs");
const { handleNetworkInventory } = require("./routes/network");
const { handleUiBootstrap, handleUiBootstrapCode, handleUiSession, handleUiSessionError, parseSessionCookie } = require("./routes/ui");
const { validateSessionToken } = require("./services/sessionService");
const { CROSS_ORIGIN_DENIED, HOST_NOT_ALLOWED, assertTrustedRequest } = require("./services/hostTrustPolicy");
const { handlePairing } = require("./routes/pairing");
const { CLAIM_PAGE_PATH, handleMobileClaimPage } = require("./routes/mobileClaimPage");
const { authorizeApiPermission } = require("./permissions");
const { handlePlayitSnapshot, handlePlayitStatus, handlePublicAccessPlayit } = require("./routes/playit");
const { handlePublicAccess } = require("./routes/publicAccess");
const { handleStats, handleSystemSummary } = require("./routes/system");

const config = getConfig();
const { logger } = require("./services/diagnosticsLogger");
// V2-J bullet 2: the Agent side of the shared correlation primitive. An
// authorized request is dispatched inside a correlation scope, so the Agent's
// own log lines, its action audit lines and the workload log lines it writes
// join on one id. When the desktop sent a valid opaque id in the correlation
// header that id is adopted verbatim (same operation, both processes);
// otherwise a local one is minted. Any other header value is ignored rather
// than sanitized, so request input can never become a log field.
const { CORRELATION_HEADER, isCorrelationId, runWithCorrelationScope } = require("../../src/shared/structuredLogger");

function runWithRequestScope(request, fn) {
  const header = request.headers?.[CORRELATION_HEADER];
  const supplied = typeof header === "string" ? header.trim() : "";
  const requested = isCorrelationId(supplied) ? supplied : null;
  return runWithCorrelationScope({ prefix: "agent", correlationId: requested }, fn);
}
const originalConsoleError = console.error.bind(console);
console.error = (...args) => { originalConsoleError(...args); logger.write("error", "console-error", args.map((value) => value?.message || String(value)).join(" "), { arguments: args }, { file: "agent" }); };
const rateBuckets = new Map();

function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const active = bucket.filter((timestamp) => now - timestamp < windowMs);
  active.push(now);
  rateBuckets.set(key, active);

  if (active.length > limit) {
    const error = new Error("RATE_LIMITED");
    error.code = "RATE_LIMITED";
    error.statusCode = 429;
    throw error;
  }
}

function sendJson(response, statusCode, body, extraHeaders = null) {
  const payload = JSON.stringify(body);

  if (Buffer.byteLength(payload) > config.maxResponseBytes) {
    sendError(response, 413, "RESPONSE_TOO_LARGE");
    return;
  }

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
  });
  response.end(payload);
}

function sendRaw(response, statusCode, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const finalHeaders = {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  };

  response.writeHead(statusCode, finalHeaders);
  response.end(payload);
}

function sendStream(response, statusCode, stream, headers = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    ...headers,
  });

  stream.on("error", () => {
    if (!response.destroyed) {
      response.destroy();
    }
  });

  stream.pipe(response);
}

function sendResult(response, result) {
  if (result?.stream) {
    sendStream(response, result.statusCode || 200, result.stream, result.headers || {});
    return;
  }

  if (Object.prototype.hasOwnProperty.call(result || {}, "rawBody")) {
    sendRaw(response, result.statusCode || 200, result.rawBody, result.headers || {});
    return;
  }

  sendJson(response, result?.statusCode || 200, result?.body, result?.headers);
}

function sanitizeErrorDetails(error, extra = {}) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const sanitized = sanitizeForDiagnostics({
    ...details,
    ...extra,
    name: error?.name || null,
    status: details.status || error?.status || error?.statusCode || extra.status || null,
    url: details.url || extra.url || null,
    invalidUrl: details.invalidUrl || null,
    causeCode: error?.cause?.code || details.causeCode || null,
  });
  delete sanitized.stack;
  delete sanitized.body;
  delete sanitized.responseBody;
  return sanitized;
}

function sendError(response, statusCode, code, message = "Request failed.", details = null) {
  sendJson(response, statusCode, {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

function getAuthErrorMessage(code) {
  if (code === "AGENT_TOKEN_MISSING") {
    return "Agent token is missing. Open Agent setup, generate a temporary pairing code, then pair this Agent from Control Center.";
  }
  if (code === "UNAUTHORIZED") {
    return "Agent token rejected. Re-pair this Agent from Control Center or rotate the node credential from Agent Control.";
  }
  return "Request failed.";
}

function logRequestError(request, error, statusCode, code) {
  const sanitizedDetails = sanitizeErrorDetails(error);
  console.error("[AnxOS Agent] Request failed.", {
    method: request.method,
    url: request.url,
    statusCode,
    code,
    name: error?.name || null,
    message: error?.message || null,
    details: Object.keys(sanitizedDetails).length ? sanitizedDetails : null,
  });
}

function isActionInvokeRoute(request, pathname) {
  return request.method === "POST" && pathname.startsWith("/api/v1/actions/");
}

function getActionIdFromPath(pathname) {
  const prefix = "/api/v1/actions/";
  return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null;
}

function getRoutePermission(request, pathname) {
  const method = String(request.method || "GET").toUpperCase();
  if (pathname === "/api/v1/health") return null;
  if (pathname === "/api/v1/stats" || pathname === "/api/stats" || pathname === "/api/v1/system/summary") return "system:read";
  // V2-H network inventory: read-only host discovery, same read tier as the
  // system summary routes.
  if (pathname === "/api/v1/network/inventory") return "system:read";
  if (pathname.startsWith("/api/v1/playit/") || pathname.startsWith("/api/v1/public-access/")) return method === "GET" ? "public-access:read" : "public-access:write";
  if (pathname.startsWith("/api/v1/amp/")) return "instance:read";
  if (pathname.startsWith("/api/v1/files/")) return method === "GET" ? "files:read" : "files:write";
  if (pathname.startsWith("/api/v1/console/")) return method === "GET" ? "console:read" : "console:write";
  if (pathname === "/api/v1/backups" || pathname.startsWith("/api/v1/backups/")) {
    if (pathname.endsWith("/restore")) return "backups:restore";
    return method === "GET" ? "backups:read" : "backups:write";
  }
  if (pathname === "/api/v1/jobs" || pathname.startsWith("/api/v1/jobs/")) {
    if (pathname.endsWith("/cancel")) return "instance:lifecycle";
    return "instance:read";
  }
  if (pathname === "/api/v1/instances" || pathname.startsWith("/api/v1/instances/")) {
    if (method === "GET") return "instance:read";
    if (/\/(?:start|stop|restart|kill)$/.test(pathname)) return "instance:lifecycle";
    if (method === "DELETE") return "instance:delete";
    return "instance:write";
  }
  if (pathname === "/api/v1/docker" || pathname.startsWith("/api/v1/docker/")) return method === "GET" ? "docker:read" : "docker:write";
  if (pathname.startsWith("/api/v1/dependencies/")) {
    if (pathname.endsWith("/install")) return "dependencies:write";
    // V2-D runtime pin unpinning changes guard state for every workload on
    // this node: it must require the same write capability as installs.
    if (pathname.endsWith("/runtime-pins") && method !== "GET") return "dependencies:write";
    return "dependencies:read";
  }
  if (pathname.startsWith("/api/v1/marketplace/")) return "marketplace:read";
  if (pathname === "/api/v1/diagnostics") return "owner";
  // V2-A enrollment: revoke is owner-only with explicit confirmation; rotate
  // is agent:manage (admin may rotate, not revoke). Public handshake paths
  // (/enroll/start, /enroll/complete, /enroll/status) never reach here.
  if (pathname.startsWith("/api/v1/ui/")) return "ui:session";
  if (pathname === "/api/v1/enroll/revoke" || pathname === "/api/v1/credentials/rotate") return getEnrollmentRoutePermission(pathname);
  if (PUBLIC_ENROLL_PATHS.has(pathname)) return null;
  if (pathname === "/api/v1/actions") return "actions:read";
  if (pathname === "/api/v1/system/agent-task") return "agent:manage";
  if (isActionInvokeRoute(request, pathname)) return "actions:execute";
  return null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      bytes += chunk.length;

      if (bytes > config.maxRequestBytes) {
        reject(Object.assign(new Error("request too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function routeRequest(request, url) {
  const pathname = url.pathname;

  // V2-A browser surface: short-lived session transport (bearer-gated for
  // POST, cookie-gated for GET; permission-gated via ui:session below).
  if (pathname === "/api/v1/ui/session" || pathname === "/api/v1/ui" || pathname === "/api/v1/ui/bootstrap" || pathname === "/api/v1/ui/bootstrap-code") {
    try {
      if (pathname === "/api/v1/ui/bootstrap-code") {
        return handleUiBootstrapCode(request, url);
      }
      return handleUiSession(request, url);
    } catch (error) {
      return handleUiSessionError(error);
    }
  }

  // V2-A enrollment privileged management (bearer + permission gated upstream).
  if (request.method === "POST" && (pathname === "/api/v1/credentials/rotate" || pathname === "/api/v1/enroll/revoke")) {
    return handleEnrollmentManagement(request, url, config);
  }

  if (pathname === "/api/v1/system/agent-task") return handleAgentTask(request);

  if (isActionInvokeRoute(request, pathname)) {
    return handleActionInvoke(request, url);
  }

  if (pathname === "/api/v1/jobs" || pathname.startsWith("/api/v1/jobs/")) {
    return handleJobs(request, url);
  }

  if (pathname === "/api/v1/instances" || pathname.startsWith("/api/v1/instances/")) {
    return handleInstances(request, url);
  }

  if (pathname === "/api/v1/backups" || pathname.startsWith("/api/v1/backups/")) {
    return handleBackups(request, url);
  }

  if (pathname === "/api/v1/docker" || pathname.startsWith("/api/v1/docker/")) {
    return handleDocker(request, url);
  }

  if (pathname === "/api/v1/dependencies/catalog" || pathname.startsWith("/api/v1/dependencies/")) {
    return handleDependencies(request, url);
  }

  if (pathname === "/api/v1/files/mutate" && request.method === "POST") {
    return handleFilesMutate(request);
  }

  if (pathname === "/api/v1/public-access/snapshot" || pathname === "/api/v1/public-access/services" || pathname.startsWith("/api/v1/public-access/services/") || pathname === "/api/v1/public-access/firewall-rule" || pathname === "/api/v1/public-access/reverse-proxy" || pathname.startsWith("/api/v1/public-access/reverse-proxy/")) {
    return handlePublicAccess(request, url);
  }

  if (pathname.startsWith("/api/v1/public-access/playit/")) {
    return handlePublicAccessPlayit(request, url);
  }

  if (pathname === "/api/v1/marketplace/curseforge/status" || pathname === "/api/v1/marketplace/curseforge/api" || pathname === "/api/v1/marketplace/curseforge/download" || pathname.startsWith("/api/v1/marketplace/curseforge/")) {
    return handleCurseForgeProxy(request, url);
  }

  if (request.method !== "GET") {
    return {
      statusCode: 405,
      body: {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Request failed.",
        },
      },
    };
  }

  if (pathname === "/api/v1/health") {
    return handleHealth({ ...config, connectedClients: connectedClients.size });
  }

  if (pathname === "/api/v1/stats" || pathname === "/api/stats" || pathname === "/api/v1/system/summary") {
    if (pathname === "/api/v1/stats" || pathname === "/api/stats") {
      return handleStats();
    }
    return handleSystemSummary();
  }

  if (pathname === "/api/v1/network/inventory") {
    return handleNetworkInventory(url);
  }

  if (pathname === "/api/v1/playit/snapshot") {
    return handlePlayitSnapshot();
  }

  if (pathname === "/api/v1/playit/status") {
    return handlePlayitStatus();
  }

  if (pathname === "/api/v1/amp/snapshot") {
    return handleAmpSnapshot();
  }

  if (pathname === "/api/v1/amp/status") {
    return handleAmpStatus();
  }

  if (pathname === "/api/v1/amp/instances") {
    return handleAmpInstances();
  }

  if (pathname === "/api/v1/files/list") {
    return handleFilesList(url);
  }

  if (pathname === "/api/v1/files/identity") {
    return handleFilesIdentity();
  }

  if (pathname === "/api/v1/files/stat") {
    return handleFilesStat(url);
  }

  if (pathname === "/api/v1/files/read") {
    return handleFilesRead(url);
  }

  if (pathname === "/api/v1/files/download") {
    return handleFilesDownload(url);
  }

  if (pathname === "/api/v1/console/commands") {
    return handleConsoleCommands();
  }

  if (pathname === "/api/v1/console/logs") {
    return handleConsoleLogs(url);
  }

  if (pathname === "/api/v1/backups/list") {
    return handleBackupsList();
  }

  if (pathname === "/api/v1/actions") {
    return handleActionsList();
  }
  if (pathname === "/api/v1/diagnostics" && request.method === "GET") {
    auditAction(request, { actionId: "diagnostics.export", permission: "owner", outcome: "ok", reason: "SANITIZED_BUNDLE" });
    return handleDiagnostics();
  }

  return {
    statusCode: 404,
    body: {
      error: {
        code: "NOT_FOUND",
        message: "Request failed.",
      },
    },
  };
}

async function handleRequest(request, response) {
  const isFileWrite = request.method === "PUT" && /\/file$/.test(request.url || "");
  const isLongInstallerOperation = request.method === "POST" && /\/(?:steamcmd\/update|installation\/execute|neoforge\/repair-runtime)$/.test(request.url || "");
  const requestTimeoutMs = isLongInstallerOperation
    ? Math.max(config.requestTimeoutMs, 11 * 60 * 1000)
    : isFileWrite ? config.fileWriteTimeoutMs : config.requestTimeoutMs;
  request.setTimeout(requestTimeoutMs, () => {
    request.destroy();
  });

  try {
    const address = request.socket?.remoteAddress || "local";
    checkRateLimit(`api:${address}`, config.apiRateLimitPerMinute, 60 * 1000);
    if ((/\/file$/.test(request.url || "") && request.method === "PUT") || (/\/files\/mutate$/.test(request.url || "") && request.method === "POST")) {
      checkRateLimit(`file-write:${address}`, config.fileWriteRateLimitPerMinute, 60 * 1000);
    }
    if (/\/command$/.test(request.url || "") && request.method === "POST") {
      checkRateLimit(`console:${address}`, config.consoleRateLimitPerMinute, 60 * 1000);
    }

    request.body = await readRequestBody(request);

    // Security hardening (DNS-rebinding precondition): validate the caller's
    // Host header and explicitly refuse cross-origin state changes BEFORE any
    // authentication, session, enrollment, or route work runs, so a refused
    // request has no side effect and cannot reach a handler that would echo the
    // caller's Host. The URL is parsed against a fixed internal base — only
    // pathname/searchParams are consumed anywhere — so a caller-supplied Host
    // (or an absolute-form request target) can no longer shape the parsed URL.
    assertTrustedRequest(request, config);
    const url = new URL(request.url, "http://127.0.0.1");
    // V2-A public enrollment handshake: nonce-protected start/complete plus a
    // public status summary, handled before bearer authentication.
    if (url.pathname.startsWith("/api/v1/enroll/")) {
      checkRateLimit(`enroll:${address}`, 30, 60 * 1000);
      const publicEnroll = handlePublicEnrollment(request, url, config);
      if (publicEnroll) {
        sendResult(response, publicEnroll);
        return;
      }
    }
    if (url.pathname.startsWith("/api/v1/pairing/")) {
      checkRateLimit(`pairing:${address}`, 30, 60 * 1000);
      const pairingResult = await handlePairing(request, url, config);
      if (pairingResult) {
        sendResult(response, pairingResult);
        return;
      }
    }
    // Browser-reachable mobile claim page: phone camera apps cannot open the
    // anxos:// claim, so the QR can point here instead. Pre-auth by design (the
    // claim URL is the capability), rate-limited, strictly validated, no-store.
    if (url.pathname === CLAIM_PAGE_PATH && request.method === "GET") {
      checkRateLimit(`claim-page:${address}`, 60, 60 * 1000);
      const claimPage = handleMobileClaimPage(request, url);
      if (claimPage) {
        sendResult(response, claimPage);
        return;
      }
    }
    // A valid UI session cookie substitutes for the bearer credential on the
    // session-validation path only (browser clients hold no bearer token);
    // permission authorization still runs below (ui:session, fail-closed).
    // /api/v1/ui/bootstrap is pre-auth by design (the paste-code form).
    // /api/v1/ui is the browser entry point: the auth gate always lets it
    // through, and handleUiSession does its own session check (200 or 302).
    // /api/v1/ui/session GET bypasses only with a valid session cookie.
    const uiSessionBypass = (url.pathname === "/api/v1/ui/bootstrap" && request.method === "GET")
      || (url.pathname === "/api/v1/ui" && request.method === "GET")
      || (url.pathname === "/api/v1/ui/session" && request.method === "GET"
        && (() => {
          try {
            validateSessionToken(parseSessionCookie(request));
            return true;
          } catch {
            return false;
          }
        })());
    // Browser bootstrap (A2.5): pre-auth, rate-limited, one-time code →
    // session cookie. The only unauthenticated way into the UI surface.
    if (url.pathname === "/api/v1/ui/session/bootstrap" && request.method === "POST") {
      checkRateLimit(`ui-bootstrap:${address}`, 10, 60 * 1000);
      let bootstrapResult;
      try {
        bootstrapResult = handleUiBootstrap(request, url);
      } catch (error) {
        bootstrapResult = handleUiSessionError(error);
      }
      if (bootstrapResult) {
        sendResult(response, bootstrapResult);
        return;
      }
    }
    const auth = uiSessionBypass ? { ok: true } : isAuthorized(request, config, url.pathname);

    if (!auth.ok) {
      logger.warn("authentication", "Agent request authorization failed", { method: request.method, pathname: url.pathname, code: auth.code }, { file: "auth", errorCode: auth.code });
      if (isActionInvokeRoute(request, url.pathname)) {
        auditAction(request, {
          actionId: getActionIdFromPath(url.pathname),
          permission: null,
          outcome: "denied",
          reason: auth.code,
        });
      }

      sendError(response, auth.statusCode, auth.code, getAuthErrorMessage(auth.code));
      return;
    }

    // V2-I bullet 3: the enrolled credential's optional scopes are enforced
    // alongside the resolved route tier. An unscoped (legacy) enrollment
    // resolves to null scopes, so behavior is byte-identical to before.
    const apiAuthorization = authorizeApiPermission(
      getRoutePermission(request, url.pathname),
      resolveEnrollmentScopeContext(),
    );
    if (!apiAuthorization.ok) {
      logger.warn("authorization", "Agent API permission denied", {
        method: request.method,
        pathname: url.pathname,
        code: apiAuthorization.code,
        permission: apiAuthorization.permission,
        scope: apiAuthorization.scope || null,
      }, { file: "auth", errorCode: apiAuthorization.code });
      if (isActionInvokeRoute(request, url.pathname)) {
        auditAction(request, {
          actionId: getActionIdFromPath(url.pathname),
          permission: apiAuthorization.permission,
          outcome: "denied",
          reason: apiAuthorization.code,
        });
      }
      const scopeMessage = apiAuthorization.code === "API_SCOPE_DENIED"
        ? "This Agent credential is scoped and does not cover the requested API capability."
        : "This Agent credential is not allowed to access the requested API capability.";
      sendError(response, apiAuthorization.statusCode, apiAuthorization.code, scopeMessage, {
        permission: apiAuthorization.permission,
        ...(apiAuthorization.scope ? { scope: { type: apiAuthorization.scope.type, value: apiAuthorization.scope.value } } : {}),
      });
      return;
    }

    // V2-A enrollment binding gate: authenticated routes refuse with
    // NODE_BINDING_MISMATCH / REVOKED once the pinned tuple drifts. Health,
    // /enroll/*, and /pairing/* remain reachable for detection and re-enroll.
    assertEnrollmentGate(url.pathname, config);

    const result = await runWithRequestScope(request, () => routeRequest(request, url));
    sendResult(response, result);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const code = error.code || (error.statusCode === 413 ? "REQUEST_TOO_LARGE" : "INTERNAL_ERROR");
    // Request-trust refusals are pre-auth and shaped entirely by the caller, so
    // they get a hardened path: only the method and the pathname are logged (no
    // Host header, no Origin, no absolute-form target) and the response carries
    // no details object — a hostile host can never be echoed or logged back.
    if (code === HOST_NOT_ALLOWED || code === CROSS_ORIGIN_DENIED) {
      const pathname = String(request.url || "").split("?")[0].slice(0, 200);
      logger.warn("request-trust", "Agent request refused by the request-trust policy", {
        method: request.method,
        pathname,
        code,
        reason: error?.details?.reason || null,
      }, { file: "agent", errorCode: code });
      if (!response.headersSent) {
        sendError(response, statusCode, code, error.message || "Request failed.");
      }
      return;
    }
    logRequestError(request, error, statusCode, code);
    logger.error("request", error, { method: request.method, url: request.url, statusCode }, { file: "agent", errorCode: code });
    if (!response.headersSent) {
      sendError(response, statusCode, code, error.message || "Request failed.", sanitizeErrorDetails(error, {
        method: request.method,
        url: request.url,
      }));
    }
  }
}

const server = http.createServer(handleRequest);
const connectedClients = new Set();
let shuttingDown = false;
server.on("connection", (socket) => {
  if (shuttingDown) {
    socket.destroy();
    return;
  }
  connectedClients.add(socket);
  socket.once("close", () => connectedClients.delete(socket));
});

server.headersTimeout = config.requestTimeoutMs + 1000;
server.requestTimeout = config.requestTimeoutMs;

server.on("clientError", (error, socket) => {
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

server.on("error", (error) => {
  logger.error("startup", error, {}, { file: "agent" });
  console.error(`AnxOS Agent failed to start: ${error.code || "STARTUP_ERROR"}`);
  process.exitCode = 1;
});

async function startServer() {
  // V2-A enrollment contract (Decision 1): loud spawn-contract diagnostic +
  // legacy binding auto-migration before the agent accepts traffic.
  registerEnrollmentStartup(config);
  const recovery = await instanceService.recoverIncompleteInstallations();
  if (recovery.repaired.length || recovery.failures.length) {
    logger.info("startup-recovery", "Incomplete Marketplace installations were repaired.", recovery, { file: "agent" });
  }
  const backupRecovery = await recoverBackupArtifacts();
  if (backupRecovery.removed.length) {
    logger.info("startup-recovery", "Interrupted backup artifacts were removed.", backupRecovery, { file: "agent" });
  }
  if (backupRecovery.quarantined.length) {
    // Orphaned archives are preserved, never deleted: the operator needs to
    // know where the possibly-recoverable copies were moved.
    logger.info("startup-recovery", "Orphaned backup archives were quarantined instead of deleted.", { quarantined: backupRecovery.quarantined }, { file: "agent" });
  }
  // V2-A job lifecycle: re-observe jobs that were in flight when the agent
  // (or the desktop client that owns the session) restarted, so no server
  // operation is orphaned by a client crash.
  const jobRecovery = await instanceService.recoverInstanceJobs();
  if (jobRecovery?.recovered) {
    logger.info("startup-recovery", "Interrupted instance jobs were re-observed.", jobRecovery, { file: "agent" });
  }
  server.listen(config.port, config.host, () => {
    startBackupScheduler();
    startRestartScheduler();
    console.info(`AnxOS Agent listening on http://${config.host}:${config.port}`);
    logger.info("startup", "AnxOS Agent listening", { host: config.host, port: config.port, pid: process.pid });
  });
}

startServer().catch((error) => {
  logger.error("startup-recovery", error, {}, { file: "agent" });
  process.exitCode = 1;
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBackupScheduler();
  stopRestartScheduler();
  logger.info("shutdown", "AnxOS Agent shutdown started", { signal, connectedClients: connectedClients.size });
  const forceTimer = setTimeout(() => {
    for (const socket of connectedClients) socket.destroy();
    process.exit(0);
  }, 10000);
  forceTimer.unref?.();
  server.close();
  for (const socket of connectedClients) socket.end();
  const instances = await instanceService.shutdownInstanceService({ timeoutMs: 5000 }).catch((error) => ({
    stopped: 0,
    forced: 0,
    failures: [{ code: error?.code || "INSTANCE_SHUTDOWN_FAILED" }],
  }));
  clearTimeout(forceTimer);
  logger.info("shutdown", "AnxOS Agent shutdown completed", { signal, instances });
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
if (process.env.ANXOS_TEST_SHUTDOWN_IPC === "1") {
  process.on("message", (message) => {
    if (message?.type === "shutdown") shutdown("TEST_IPC");
  });
}

process.on("uncaughtException", (error) => logger.error("uncaught-exception", error, {}, { file: "agent" }));
process.on("unhandledRejection", (reason) => logger.error("unhandled-rejection", reason instanceof Error ? reason : new Error(String(reason)), {}, { file: "agent" }));
