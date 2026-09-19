const {
  createPublicAccessService,
  deletePublicAccessService,
  getPublicAccessSnapshot,
  listPublicAccessServices,
} = require("../services/publicAccessProviderService");
const {
  applyReverseProxyRoute,
  getExposureDiagnosticsSnapshot,
  getReverseProxySnapshot,
} = require("../services/reverseProxyService");
const {
  assertExposureRequestSatisfiable,
  classifyExposureRequest,
} = require("../../../src/shared/exposureRequirementsPolicy");
const { execFile } = require("child_process");
const { buildWindowsFirewallRule } = require("../../../src/shared/windowsFirewallRule");

// V2-H firewall lifecycle: AnxOS only ever manages rules it created. The
// builder names every rule with this prefix; the inventory/delete surface
// refuses to touch anything that does not carry it so a host can never lose a
// rule that was authored by something other than AnxOS.
const MANAGED_RULE_PREFIX = "AnxOS ";
const FIREWALL_COMMAND_TIMEOUT_MS = 30000;

function runWindowsFirewallCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: options.timeoutMs || FIREWALL_COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        errorCode: error?.code || error?.name || null,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

function isAnxOsManagedFirewallRuleName(name) {
  return typeof name === "string" && name.startsWith(MANAGED_RULE_PREFIX) && name.length > MANAGED_RULE_PREFIX.length;
}

function buildWindowsFirewallRuleInventoryScript(prefix = MANAGED_RULE_PREFIX) {
  const escaped = String(prefix).replace(/'/g, "''");
  return [
    `$rules = Get-NetFirewallRule -DisplayName '${escaped}*' -ErrorAction SilentlyContinue;`,
    "$out = foreach ($r in $rules) {",
    "  $pf = $r | Get-NetFirewallPortFilter;",
    "  [pscustomobject]@{ name = $r.DisplayName; direction = [string]$r.Direction; action = [string]$r.Action; enabled = [string]$r.Enabled; protocol = [string]$pf.Protocol; localPort = [string]$pf.LocalPort }",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join(" ");
}

function parseManagedFirewallRuleList(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Windows Firewall rule inventory could not be parsed."), { code: "FIREWALL_RULE_PARSE_FAILED" });
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && isAnxOsManagedFirewallRuleName(row.name))
    .map((row) => {
      const parsedPort = Number.parseInt(row.localPort, 10);
      return {
        id: String(row.name),
        name: String(row.name),
        protocol: row.protocol ? String(row.protocol).toUpperCase() : null,
        localPort: Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null,
        direction: row.direction ? String(row.direction).toLowerCase() : "in",
        action: row.action ? String(row.action).toLowerCase() : "allow",
        enabled: String(row.enabled).toLowerCase() !== "false",
        managedBy: "AnxOS",
        deletableByAnxOS: true,
      };
    });
}

function createWindowsFirewallRule(payload, options = {}) {
  if (process.platform !== "win32") throw Object.assign(new Error("Windows Firewall rule creation is only available on Windows."), { code: "FIREWALL_PLATFORM_UNSUPPORTED" });
  const rule = buildWindowsFirewallRule(payload);
  const runCommandImpl = options.runCommand || runWindowsFirewallCommand;
  return runCommandImpl("netsh.exe", rule.args).then((result) => {
    if (!result.ok) throw Object.assign(new Error("Windows Firewall rule could not be created by the elevated Agent."), { code: "FIREWALL_RULE_FAILED" });
    return { ok: true, rule: { name: rule.name, protocol: rule.protocol, localPort: rule.port, direction: "in", action: "allow", managedBy: "AnxOS Agent" } };
  });
}

async function listWindowsFirewallRules(options = {}) {
  // Honest unsupported-platform contract: no rules are invented and no error
  // is raised, so callers can render "not available on this platform".
  if (process.platform !== "win32") {
    return { ok: true, supported: false, platform: process.platform, managedRulePrefix: MANAGED_RULE_PREFIX, rules: [], message: "Windows Firewall rule inventory is only available on Windows." };
  }
  const runCommandImpl = options.runCommand || runWindowsFirewallCommand;
  const result = await runCommandImpl("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildWindowsFirewallRuleInventoryScript(MANAGED_RULE_PREFIX)]);
  if (!result.ok) {
    throw Object.assign(new Error("Windows Firewall rules could not be listed by the elevated Agent."), { code: "FIREWALL_RULE_LIST_FAILED" });
  }
  return { ok: true, supported: true, platform: "win32", managedRulePrefix: MANAGED_RULE_PREFIX, rules: parseManagedFirewallRuleList(result.stdout) };
}

async function deleteWindowsFirewallRule(payload = {}, options = {}) {
  const name = String(payload.name || payload.id || "").trim();
  if (!name) throw Object.assign(new Error("Choose a firewall rule to delete."), { code: "FIREWALL_RULE_NAME_REQUIRED", statusCode: 400 });
  if (!isAnxOsManagedFirewallRuleName(name)) {
    throw Object.assign(new Error("AnxOS can only delete firewall rules it created."), { code: "FIREWALL_RULE_UNMANAGED", statusCode: 403 });
  }
  if (process.platform !== "win32") {
    return { ok: true, supported: false, platform: process.platform, deleted: null, message: "Windows Firewall rule deletion is only available on Windows." };
  }
  const runCommandImpl = options.runCommand || runWindowsFirewallCommand;
  const result = await runCommandImpl("netsh.exe", ["advfirewall", "firewall", "delete", "rule", `name=${name}`]);
  if (!result.ok) throw Object.assign(new Error("Windows Firewall rule could not be deleted by the elevated Agent."), { code: "FIREWALL_RULE_DELETE_FAILED" });
  return { ok: true, supported: true, platform: "win32", deleted: { name, managedBy: "AnxOS" } };
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

// V2-H: classify what an exposure request requires (HTTP routing vs raw TCP/UDP)
// and what the named provider declares. A combination that cannot be satisfied
// is a typed refusal (the assert throws), never a silent fallback to another
// mechanism. "unknown" is returned as an outcome, never as satisfiable:true.
function classifyExposureRequirements(payload = {}) {
  assertExposureRequestSatisfiable(payload);
  const classification = classifyExposureRequest(payload);
  return {
    ok: true,
    outcome: classification.outcome,
    satisfiable: classification.satisfiable,
    provisionable: classification.outcome === "satisfiable",
    reason: classification.reason,
    message: classification.message,
    protocol: classification.protocol,
    transport: classification.transport,
    workloadKind: classification.workloadKind,
    requestedMechanism: classification.requestedMechanism,
    recommendedMechanism: classification.recommendedMechanism,
    mechanism: classification.mechanism,
    providerId: classification.providerId,
    provider: classification.provider,
    providerLimits: classification.providerLimits,
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
  if (url.pathname === "/api/v1/public-access/firewall-rule") {
    // V2-H firewall lifecycle: one path serves inventory (GET), deletion
    // (DELETE by AnxOS-managed name) and creation (POST). Unmanaged rules are
    // never listed as deletable and can never be removed through AnxOS.
    if (request.method === "GET") {
      try { return { statusCode: 200, body: await listWindowsFirewallRules() }; }
      catch (error) { return errorResponse(error); }
    }
    if (request.method === "DELETE") {
      try {
        const queryName = typeof url.searchParams?.get === "function" ? url.searchParams.get("name") : "";
        const payload = queryName ? { name: queryName } : await readRequestJson(request);
        return { statusCode: 200, body: await deleteWindowsFirewallRule(payload) };
      } catch (error) { return errorResponse(error); }
    }
    if (request.method === "POST") {
      try { return { statusCode: 200, body: await createWindowsFirewallRule(await readRequestJson(request)) }; }
      catch (error) { return errorResponse(error); }
    }
  }
  if (url.pathname === "/api/v1/public-access/reverse-proxy" && request.method === "GET") {
    // V2-H reverse-proxy/certificate lifecycle: read current route + certificate
    // state. Activation and issuance are reported as unsupported in this build;
    // this read never claims traffic is routed or a certificate exists.
    try { return { statusCode: 200, body: await getReverseProxySnapshot() }; }
    catch (error) { return errorResponse(error); }
  }
  if (url.pathname === "/api/v1/public-access/reverse-proxy/routes" && request.method === "POST") {
    // Validate + record a route definition. The response reports applied:false
    // because AnxOS does not write proxy configuration in this build.
    try { return { statusCode: 200, body: await applyReverseProxyRoute(await readRequestJson(request)) }; }
    catch (error) { return errorResponse(error); }
  }
  // V2-H: new, additive surfaces under the already-dispatched reverse-proxy
  // path prefix (agent/src/server.js forwards only an allowlist of prefixes and
  // is owned elsewhere). Neither changes an existing endpoint's request or
  // response shape.
  if (url.pathname === "/api/v1/public-access/reverse-proxy/diagnostics" && request.method === "GET") {
    // Per exposed workload: last DNS error, last certificate error (from the
    // real certificate state), last provider error, and residual billable
    // resources. An unestablished state is reported "unknown", and the payload
    // always carries the explicit provisioning state vocabulary
    // known-succeeded / known-failed / unknown. It never implies provisioning
    // succeeded.
    try { return { statusCode: 200, body: await getExposureDiagnosticsSnapshot() }; }
    catch (error) { return errorResponse(error); }
  }
  if (url.pathname === "/api/v1/public-access/reverse-proxy/requirements" && request.method === "POST") {
    // Distinguish HTTP routing from raw TCP/UDP requirements and report the
    // provider's declared protocol/mechanism limits. An unsatisfiable
    // combination is a typed refusal (e.g. HTTP routing for a UDP workload).
    try { return { statusCode: 200, body: classifyExposureRequirements(await readRequestJson(request)) }; }
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
  _test: {
    MANAGED_RULE_PREFIX,
    applyReverseProxyRoute,
    buildWindowsFirewallRuleInventoryScript,
    classifyExposureRequirements,
    createWindowsFirewallRule,
    deleteWindowsFirewallRule,
    getExposureDiagnosticsSnapshot,
    getReverseProxySnapshot,
    isAnxOsManagedFirewallRuleName,
    listWindowsFirewallRules,
    parseManagedFirewallRuleList,
    runWindowsFirewallCommand,
  },
};
