const {
  getPlayitLogs,
  getPlayitSnapshot,
  getPlayitStatus,
  listPlayitTunnels,
  restartPlayit,
  startPlayit,
  stopPlayit,
} = require("../services/playitService");

async function handlePlayitSnapshot() {
  return {
    statusCode: 200,
    body: await getPlayitSnapshot(),
  };
}

async function handlePlayitStatus() {
  return {
    statusCode: 200,
    body: await getPlayitStatus(),
  };
}

function errorResponse(error, fallbackCode = "PLAYIT_REQUEST_FAILED") {
  return {
    statusCode: error?.statusCode || 500,
    body: {
      error: {
        code: error?.code || fallbackCode,
        message: error?.message || "Playit request failed.",
        details: error?.diagnostics ? { diagnostics: error.diagnostics } : undefined,
      },
    },
  };
}

async function handlePublicAccessPlayit(request, url) {
  try {
    const pathname = url.pathname;
    if (request.method === "GET" && pathname === "/api/v1/public-access/playit/status") {
      return { statusCode: 200, body: await getPlayitStatus() };
    }
    if (request.method === "GET" && pathname === "/api/v1/public-access/playit/logs") {
      return { statusCode: 200, body: await getPlayitLogs({ limit: url.searchParams.get("limit") }) };
    }
    if (request.method === "GET" && pathname === "/api/v1/public-access/playit/tunnels") {
      return { statusCode: 200, body: await listPlayitTunnels() };
    }
    if (request.method === "POST" && pathname === "/api/v1/public-access/playit/start") {
      return { statusCode: 200, body: await startPlayit() };
    }
    if (request.method === "POST" && pathname === "/api/v1/public-access/playit/stop") {
      return { statusCode: 200, body: await stopPlayit() };
    }
    if (request.method === "POST" && pathname === "/api/v1/public-access/playit/restart") {
      return { statusCode: 200, body: await restartPlayit() };
    }
    return {
      statusCode: 404,
      body: { error: { code: "PLAYIT_ROUTE_NOT_FOUND", message: "Playit route not found." } },
    };
  } catch (error) {
    return errorResponse(error);
  }
}

module.exports = {
  handlePublicAccessPlayit,
  handlePlayitSnapshot,
  handlePlayitStatus,
};
