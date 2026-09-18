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
// Per-principal grant schema (V2-A Decision 2, scoped in V2-I)
//
//   {
//     "principal": "<principal-id>",
//     "role": "owner|admin|operator|viewer|service",   // optional
//     "nodeId": "agent-<deviceId>",                    // optional node scope
//     "targets": ["<workload-id>", ...],               // optional workload scope
//     "permissions": ["instance:lifecycle", ...]
//   }
//
// V2-I bullet 3: `nodeId` is now enforced — a node-scoped grant only applies
// when the request targets that node (see resolvePrincipalPermissions). The
// agent still has no per-request workload (target) identity, so `targets`
// remains carried/validated for shape only. Unknown/invalid grants are dropped
// (fail-closed), never widened.
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
  // V2-I node scope: a node-scoped grant only applies to a request targeting
  // that node. When the caller supplies no target node we keep the pre-V2-I
  // behavior (the grant applies), so unenrolled/legacy callers are unchanged.
  const targetNodeId = descriptor.nodeId === undefined || descriptor.nodeId === null || descriptor.nodeId === ""
    ? null
    : String(descriptor.nodeId).trim();

  if (principal) {
    for (const grant of getPermissionGrants().grants) {
      if (grant.principal !== principal) {
        continue;
      }
      if (grant.nodeId && targetNodeId && grant.nodeId !== targetNodeId) {
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

// ---------------------------------------------------------------------------
// V2-I bullet 3: scoped credentials.
//
// A token (enrollment record) or principal descriptor may carry an optional
// scope envelope. Canonical shape:
//
//   scopes: { nodeIds?: string[], families?: string[] }
//
// - `nodeIds` restricts the credential to the listed agent node ids
//   (`agent-<deviceId>`, mirroring src/services/nodeService.js nodeIdForDevice).
//   This is the plural, array form of the documented grant `nodeId` scope; the
//   singular `nodeId` is accepted as an alias so both spellings express the
//   same scope.
// - `families` restricts the credential to the listed permission families
//   (the segment before ":" — e.g. "files" covers "files:read"/"files:write").
//
// ABSENT or EMPTY scopes => unscoped: the credential keeps its full profile
// permissions (NOT deny-all). This is the backward-compatibility contract and
// means existing tokens/records without scopes behave exactly as before.
//
// A denial uses the distinct code API_SCOPE_DENIED and names ONLY the scope
// that was lacking (the requested family or the target node id); it never
// echoes the credential's other scopes or token material.
// ---------------------------------------------------------------------------

// Mirrors src/services/nodeService.js nodeIdForDevice exactly so the node id
// an enrollment scope is compared against is the same id the desktop derives
// for this agent node.
function resolveAgentNodeId(deviceId) {
  return `agent-${String(deviceId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56)}`;
}

function normalizeScopeList(value) {
  const source = Array.isArray(value)
    ? value
    : value === undefined || value === null || value === ""
      ? []
      : [value];
  const entries = [];
  for (const entry of source) {
    if (typeof entry !== "string" && typeof entry !== "number") {
      continue;
    }
    const text = String(entry).trim();
    if (text) entries.push(text);
  }
  return [...new Set(entries)];
}

function normalizeApiScopes(scopes) {
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
    return null;
  }
  const rawNodeIds = scopes.nodeIds !== undefined ? scopes.nodeIds : scopes.nodeId;
  const nodeIds = normalizeScopeList(rawNodeIds);
  const families = normalizeScopeList(scopes.families);
  if (!nodeIds.length && !families.length) {
    return null;
  }
  return { nodeIds, families };
}

function permissionFamily(permission) {
  const normalized = normalizePermissionToken(permission);
  if (!normalized || normalized === "*") return null;
  return normalized.includes(":") ? normalized.split(":", 1)[0] : normalized;
}

function matchesFamilyScope(families, permission) {
  if (!families.length) return true;
  const normalized = normalizePermissionToken(permission);
  const family = permissionFamily(permission);
  return families.some((entry) => {
    const candidate = normalizePermissionToken(entry);
    if (!candidate) return false;
    if (candidate === "*" || candidate === normalized) return true;
    return Boolean(family) && (candidate === family || candidate === `${family}:*`);
  });
}

function matchesNodeScope(nodeIds, targetNodeId) {
  if (!nodeIds.length) return true;
  // A node-scoped credential presented without a resolvable target node is
  // fail-closed: the scope cannot be proven to cover the request.
  if (!targetNodeId) return false;
  return nodeIds.includes(targetNodeId);
}

function evaluateApiScope(permission, descriptor = {}) {
  const scopes = normalizeApiScopes(descriptor.scopes);
  if (!scopes) return { ok: true, scope: null };
  if (!matchesNodeScope(scopes.nodeIds, descriptor.nodeId ? String(descriptor.nodeId).trim() : null)) {
    return { ok: false, scope: { type: "node", value: descriptor.nodeId ? String(descriptor.nodeId).trim() : null } };
  }
  if (!matchesFamilyScope(scopes.families, permission)) {
    return { ok: false, scope: { type: "family", value: permissionFamily(permission) || normalizePermissionToken(permission) } };
  }
  return { ok: true, scope: null };
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
  if (principalDescriptor) {
    const scope = evaluateApiScope(normalized, principalDescriptor);
    if (!scope.ok) {
      return { ok: false, statusCode: 403, code: "API_SCOPE_DENIED", permission: normalized, scope: scope.scope };
    }
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
  evaluateApiScope,
  getConfiguredApiPermissions,
  getDefaultApiPermissions,
  getPermissionGrants,
  normalizeApiScopes,
  resolveAgentNodeId,
  resolvePermissionProfile,
  resolvePrincipalPermissions,
  isLocalOwnerProfile,
  parsePermissionGrants,
};
