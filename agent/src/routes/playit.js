const {
  getPlayitLogs,
  getPlayitSnapshot,
  getPlayitStatus,
  listPlayitTunnels,
  restartPlayit,
  startPlayit,
  stopPlayit,
} = require("../services/playitService");
const { createPlayitAccountService } = require("../../../src/services/playitAccountService");

// Running state comes from the Agent's own playit detection (systemd/IPC).
const playitAccount = createPlayitAccountService({ getStatus: () => getPlayitStatus() });
const ACCOUNT_LINK_PATH = /^\/api\/v1\/public-access\/playit\/account\/link\/([A-Za-z0-9-]{1,64})(?:\/(open|cancel))?$/;

// Link progress without the link itself: the claim link lets whoever opens
// it take over this playit agent, so only write-scoped callers receive it
// (POST .../open, POST .../account/link).
function withoutLinkUrl(session) {
  const { linkUrl, ...view } = session;
  return { ...view, hasLink: Boolean(linkUrl) };
}

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
    if (request.method === "GET" && pathname === "/api/v1/public-access/playit/account") {
      return { statusCode: 200, body: await playitAccount.getAccountState() };
    }
    if (request.method === "POST" && pathname === "/api/v1/public-access/playit/account/link") {
      return { statusCode: 200, body: await playitAccount.startLink() };
    }
    if (request.method === "POST" && pathname === "/api/v1/public-access/playit/account/manage") {
      return { statusCode: 200, body: await playitAccount.getManageLink() };
    }
    const linkMatch = pathname.match(ACCOUNT_LINK_PATH);
    if (linkMatch) {
      const [, linkId, action] = linkMatch;
      if (request.method === "GET" && !action) return { statusCode: 200, body: withoutLinkUrl(playitAccount.getLink(linkId)) };
      if (request.method === "POST" && action === "open") return { statusCode: 200, body: playitAccount.getLink(linkId) };
      if (request.method === "POST" && action === "cancel") return { statusCode: 200, body: withoutLinkUrl(playitAccount.cancelLink(linkId)) };
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
  withoutLinkUrl,
  handlePublicAccessPlayit,
  handlePlayitSnapshot,
  handlePlayitStatus,
};
