const {
  createPublicAccessService,
  deletePublicAccessService,
  getPublicAccessSnapshot,
  listPublicAccessServices,
} = require("../services/publicAccessProviderService");
const { execFile } = require("child_process");
const { buildWindowsFirewallRule } = require("../../../src/shared/windowsFirewallRule");

function createWindowsFirewallRule(payload) {
  if (process.platform !== "win32") throw Object.assign(new Error("Windows Firewall rule creation is only available on Windows."), { code: "FIREWALL_PLATFORM_UNSUPPORTED" });
  const rule = buildWindowsFirewallRule(payload);
  return new Promise((resolve, reject) => execFile("netsh.exe", rule.args, { windowsHide: true, timeout: 30000 }, (error) => {
    if (error) { reject(Object.assign(new Error("Windows Firewall rule could not be created by the elevated Agent."), { code: "FIREWALL_RULE_FAILED" })); return; }
    resolve({ ok: true, rule: { name: rule.name, protocol: rule.protocol, localPort: rule.port, direction: "in", action: "allow", managedBy: "AnxOS Agent" } });
  }));
}

async function readRequestJson(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.readJson === "function") return request.readJson();
  if (typeof request.body === "string" && request.body.trim()) {
    try {
      return JSON.parse(request.body);
    } catch {
      throw Object.assign(new Error("Invalid JSON payload."), {
        code: "INVALID_JSON",
        statusCode: 400,
      });
    }
  }
  return {};
}

function errorResponse(error) {
  return {
    statusCode: error?.statusCode || 400,
    body: {
      error: {
        code: error?.code || "PUBLIC_ACCESS_REQUEST_FAILED",
        message: error?.message || "Public Access request failed.",
        details: error?.details || null,
      },
    },
  };
}

async function handlePublicAccess(request, url) {
  if (request.method === "GET" && url.pathname === "/api/v1/public-access/snapshot") {
    return {
      statusCode: 200,
      body: await getPublicAccessSnapshot(),
    };
  }
  if (request.method === "GET" && url.pathname === "/api/v1/public-access/services") {
    return {
      statusCode: 200,
      body: await listPublicAccessServices(),
    };
  }
  if (request.method === "POST" && url.pathname === "/api/v1/public-access/services") {
    try {
      return {
        statusCode: 201,
        body: await createPublicAccessService(await readRequestJson(request)),
      };
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (request.method === "POST" && url.pathname === "/api/v1/public-access/firewall-rule") {
    try { return { statusCode: 200, body: await createWindowsFirewallRule(await readRequestJson(request)) }; }
    catch (error) { return errorResponse(error); }
  }
  const deleteMatch = url.pathname.match(/^\/api\/v1\/public-access\/services\/([^/]+)$/);
  if (request.method === "DELETE" && deleteMatch) {
    try {
      return {
        statusCode: 200,
        body: await deletePublicAccessService(decodeURIComponent(deleteMatch[1])),
      };
    } catch (error) {
      return errorResponse(error);
    }
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

module.exports = {
  handlePublicAccess,
};
