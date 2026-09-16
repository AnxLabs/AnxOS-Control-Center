const DEFAULT_ACTION_PERMISSIONS = ["docker:write"];

// V2-A Decision 4: the API permission set must be fail-closed by default.
// A standalone/remote agent receives NO implicit "*" grant; every capability
// must come from explicit configuration (AGENT_API_PERMISSIONS) or from an
// explicit per-principal grant. The local single-node Owner keeps its existing
// wildcard so current desktop-managed installs are unaffected.
const DEFAULT_API_PERMISSIONS_LOCAL = ["*"];
const DEFAULT_API_PERMISSIONS_RESTRICTED = [];

const PERMISSION_PROFILES = new Set(["local-owner", "restricted"]);

function normalizePermissionToken(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "docker" || normalized === "docker.write") {
    return "docker:write";
  }

  return normalized;
}

function expandPermissionToken(value) {
  const normalized = normalizePermissionToken(value);

  if (!normalized) {
    return [];
  }

  if (normalized === "*" || normalized === "*:*") {
    return ["*"];
  }

  if (normalized === "docker:*") {
    return ["docker:*", "docker:write"];
  }

  return [normalized];
}

// V2-A Decision 1 ties the desktop-spawn contract to ANXHUB_CONFIG_DIR: the
// desktop always spawns its LOCAL agent with it, and a standalone/remote agent
// must not silently inherit desktop assumptions. That env therefore doubles as
// the local-vs-remote permission signal, with an explicit profile override
// (AGENT_PERMISSION_PROFILE) so deployment tooling can pin the mode either way.
function resolvePermissionProfile() {
  const explicit = String(process.env.AGENT_PERMISSION_PROFILE || "").trim().toLowerCase();
  if (PERMISSION_PROFILES.has(explicit)) {
    return explicit;
  }

  if (explicit) {
    // Unknown explicit profile: fail closed rather than guess.
    return "restricted";
  }

  return process.env.ANXHUB_CONFIG_DIR ? "local-owner" : "restricted";
}

function isLocalOwnerProfile() {
  return resolvePermissionProfile() === "local-owner";
}

function getRawConfiguredPermissions() {
  return process.env.AGENT_ACTION_PERMISSIONS
    || process.env.AGENT_ALLOWED_PERMISSIONS
    || process.env.ANX_AGENT_ACTION_PERMISSIONS
    || "";
}

function getConfiguredPermissions() {
  const rawPermissions = String(getRawConfiguredPermissions());
  const sourcePermissions = rawPermissions.trim()
    ? rawPermissions.split(/[\s,]+/)
    : DEFAULT_ACTION_PERMISSIONS;

  return new Set(sourcePermissions.flatMap(expandPermissionToken).filter(Boolean));
}

function getDefaultApiPermissions() {
  return isLocalOwnerProfile()
    ? DEFAULT_API_PERMISSIONS_LOCAL
    : DEFAULT_API_PERMISSIONS_RESTRICTED;
}

function getConfiguredApiPermissions() {
  const rawPermissions = String(process.env.AGENT_API_PERMISSIONS || "");
  const sourcePermissions = rawPermissions.trim()
    ? rawPermissions.split(/[\s,]+/)
    : getDefaultApiPermissions();
  return new Set(sourcePermissions.flatMap(expandPermissionToken).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Per-principal grant schema (V2-A Decision 2)
//
// Scoping of credentials to individual principals, per-node and per-workload
// grants land in V2-I. This slice only fixes the SCHEMA so future scoped
// credentials can be expressed without another wire change:
//
//   {
//     "principal": "<principal-id>",
//     "role": "owner|admin|operator|viewer|service",   // optional
//     "nodeId": "agent-<deviceId>",                    // optional future scope
//     "targets": ["<workload-id>", ...],               // optional future scope
//     "permissions": ["instance:lifecycle", ...]
//   }
//
// `nodeId`/`targets` are carried and validated for shape only in this wave;
// the agent has no per-request target identity yet, so they are not enforced
// here. Unknown/invalid grants are dropped (fail-closed), never widened.
// ---------------------------------------------------------------------------

const GRANT_ROLES = new Set(["owner", "admin", "operator", "viewer", "service"]);

function parsePermissionGrants(raw) {
  const errors = [];
  const grants = [];

  const source = String(raw === undefined ? process.env.AGENT_PERMISSION_GRANTS || "" : raw);
  if (!source.trim()) {
    return { grants, errors };
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { grants, errors: [`AGENT_PERMISSION_GRANTS is not valid JSON: ${error?.message || "parse error"}`] };
  }

  if (!Array.isArray(parsed)) {
    return { grants, errors: ["AGENT_PERMISSION_GRANTS must be a JSON array of grant objects."] };
  }

  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Grant #${index} must be an object.`);
      return;
    }
    const principal = String(entry.principal || "").trim();
    if (!principal) {
      errors.push(`Grant #${index} is missing "principal".`);
      return;
    }
    const role = entry.role === undefined || entry.role === null || entry.role === ""
      ? null
      : String(entry.role).trim().toLowerCase();
    if (role && !GRANT_ROLES.has(role)) {
      errors.push(`Grant #${index} has an unknown role "${entry.role}".`);
      return;
    }
    const permissions = Array.isArray(entry.permissions)
      ? entry.permissions.flatMap(expandPermissionToken).filter(Boolean)
      : [];
    if (!permissions.length) {
      errors.push(`Grant #${index} has no usable permissions.`);
      return;
    }
    // Future scoping (V2-I): carried in the schema, not enforced in V2-A.
    const nodeId = entry.nodeId === undefined || entry.nodeId === null || entry.nodeId === ""
      ? null
      : String(entry.nodeId).trim();
    const targets = Array.isArray(entry.targets)
      ? entry.targets.map((target) => String(target || "").trim()).filter(Boolean)
      : [];

    grants.push({ principal, role, nodeId, targets, permissions });
  });

  return { grants, errors };
}

function getPermissionGrants() {
  return parsePermissionGrants();
}

// Owner-role grants are the only principal grants that may carry a wildcard.
function resolvePrincipalPermissions(descriptor = {}) {
  const principal = String(descriptor.principal || "").trim();
  const basePermissions = getConfiguredApiPermissions();
  const effective = new Set(basePermissions);

  if (principal) {
    for (const grant of getPermissionGrants().grants) {
      if (grant.principal !== principal) {
        continue;
      }
      const wildcardFromOwnerRole = grant.role === "owner";
      for (const permission of grant.permissions) {
        if (permission === "*" && !wildcardFromOwnerRole) {
          // Fail-closed: a non-owner principal grant cannot smuggle "*".
          continue;
        }
        effective.add(permission);
      }
    }
  }

  return effective;
}

function matchesApiPermission(configuredPermissions, normalized) {
  const category = normalized.includes(":") ? `${normalized.split(":", 1)[0]}:*` : null;
  return configuredPermissions.has("*")
    || configuredPermissions.has(normalized)
    || Boolean(category && configuredPermissions.has(category));
}

function authorizeApiPermission(permission, principalDescriptor = null) {
  const normalized = normalizePermissionToken(permission);
  if (!normalized) return { ok: true, code: "API_PERMISSION_NOT_REQUIRED", permission: null };
  const configuredPermissions = principalDescriptor
    ? resolvePrincipalPermissions(principalDescriptor)
    : getConfiguredApiPermissions();
  if (!matchesApiPermission(configuredPermissions, normalized)) {
    return { ok: false, statusCode: 403, code: "API_PERMISSION_DENIED", permission: normalized };
  }
  return { ok: true, statusCode: 200, code: "API_PERMISSION_AUTHORIZED", permission: normalized };
}

function authorizeAction(action) {
  if (!action) {
    return {
      ok: false,
      statusCode: 404,
      code: "ACTION_NOT_FOUND",
    };
  }

  const configuredPermissions = getConfiguredPermissions();

  if (!configuredPermissions.has("*") && !configuredPermissions.has(action.permission)) {
    return {
      ok: false,
      statusCode: 403,
      code: "ACTION_PERMISSION_DENIED",
      permission: action.permission,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    code: "ACTION_AUTHORIZED",
    permission: action.permission,
  };
}

module.exports = {
  authorizeApiPermission,
  authorizeAction,
  getConfiguredApiPermissions,
  getDefaultApiPermissions,
  getPermissionGrants,
  resolvePermissionProfile,
  resolvePrincipalPermissions,
  isLocalOwnerProfile,
  parsePermissionGrants,
};
