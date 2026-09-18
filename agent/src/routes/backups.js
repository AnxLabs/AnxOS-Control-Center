const {
  createBackup,
  deleteBackup,
  deleteSchedule,
  getBackupDownload,
  importBackup,
  listBackups,
  listSchedules,
  restoreBackup,
  saveSchedule,
} = require("../services/backupService");
const {
  deleteDestination,
  listDestinations,
  pushBackupToDestination,
  restoreBackupFromDestination,
  saveDestination,
} = require("../services/backupDestinationService");

function parseJsonBody(request) {
  if (!request.body) {
    return {};
  }

  try {
    return JSON.parse(request.body);
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    error.statusCode = 400;
    throw error;
  }
}

function result(statusCode, body) {
  return { statusCode, body };
}

function errorResult(error) {
  return result(error.statusCode || 500, {
    error: {
      code: error.code || "BACKUP_REQUEST_FAILED",
      message: "Request failed.",
    },
  });
}

function getBackupIdFromPath(pathname, suffix = "") {
  const prefix = "/api/v1/backups/";

  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const raw = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  return decodeURIComponent(raw.replace(/\/$/, ""));
}

// Destination routes live directly under /api/v1/backups and must be matched
// before the generic per-backup id parser: "/api/v1/backups/destinations" would
// otherwise be read as a backup id.
const DESTINATIONS_PREFIX = "/api/v1/backups/destinations";

function getDestinationIdFromPath(pathname) {
  if (!pathname.startsWith(`${DESTINATIONS_PREFIX}/`)) {
    return null;
  }
  const raw = pathname.slice(DESTINATIONS_PREFIX.length + 1).replace(/\/$/, "");
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

// Single-segment backup sub-route, e.g. /api/v1/backups/<backupId>/push.
function getBackupSubroute(pathname, suffix) {
  const prefix = "/api/v1/backups/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const raw = pathname.slice(prefix.length, -suffix.length);
  if (!raw || raw.includes("/")) {
    return null;
  }
  return decodeURIComponent(raw);
}

// /api/v1/backups/<backupId>/destinations/<destinationId>/restore — the trailing
// "/restore" keeps the backups:restore tier for this route (server.js routing).
function parseRemoteRestorePath(pathname) {
  const match = pathname.match(/^\/api\/v1\/backups\/([^/]+)\/destinations\/([^/]+)\/restore\/?$/);
  if (!match) {
    return null;
  }
  return { backupId: decodeURIComponent(match[1]), destinationId: decodeURIComponent(match[2]) };
}

async function handleBackups(request, url) {
  try {
    if (request.method === "GET" && (url.pathname === "/api/v1/backups" || url.pathname === "/api/v1/backups/list")) {
      return result(200, await listBackups({ instanceId: url.searchParams.get("instanceId") || "" }));
    }

    if (request.method === "POST" && url.pathname === "/api/v1/backups") {
      return result(201, await createBackup(parseJsonBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/v1/backups/import") {
      return result(201, await importBackup(parseJsonBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/v1/backups/restore") {
      return result(200, await restoreBackup(parseJsonBody(request)));
    }

    // V2-F wave 5 destinations. Matched before the generic per-backup routes so
    // "/api/v1/backups/destinations" is never parsed as a backup id.
    if (url.pathname === DESTINATIONS_PREFIX) {
      if (request.method === "GET") {
        return result(200, await listDestinations());
      }
      if (request.method === "POST") {
        return result(201, await saveDestination(parseJsonBody(request)));
      }
    }

    const destinationId = getDestinationIdFromPath(url.pathname);
    if (request.method === "DELETE" && destinationId) {
      return result(200, await deleteDestination(destinationId));
    }

    const pushBackupId = getBackupSubroute(url.pathname, "/push");
    if (request.method === "POST" && pushBackupId) {
      return result(200, await pushBackupToDestination(pushBackupId, parseJsonBody(request)));
    }

    const remoteRestore = parseRemoteRestorePath(url.pathname);
    if (request.method === "POST" && remoteRestore) {
      return result(200, await restoreBackupFromDestination({
        ...parseJsonBody(request),
        backupId: remoteRestore.backupId,
        destinationId: remoteRestore.destinationId,
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/v1/backups/schedules") {
      return result(200, await listSchedules());
    }

    if (request.method === "PUT" && url.pathname === "/api/v1/backups/schedules") {
      return result(200, await saveSchedule(parseJsonBody(request)));
    }

    const scheduleId = getBackupIdFromPath(url.pathname, "/schedule");
    if (request.method === "DELETE" && scheduleId) {
      return result(200, await deleteSchedule(scheduleId));
    }

    const downloadId = getBackupIdFromPath(url.pathname, "/download");
    if (request.method === "GET" && downloadId) {
      const download = await getBackupDownload(downloadId);
      return {
        statusCode: 200,
        stream: download.stream,
        headers: download.headers,
      };
    }

    const deleteId = getBackupIdFromPath(url.pathname);
    if (request.method === "DELETE" && deleteId) {
      return result(200, await deleteBackup(deleteId));
    }

    return result(404, {
      error: {
        code: "NOT_FOUND",
        message: "Request failed.",
      },
    });
  } catch (error) {
    return errorResult(error);
  }
}

async function handleBackupsList() {
  return result(200, await listBackups());
}

module.exports = {
  handleBackups,
  handleBackupsList,
};
