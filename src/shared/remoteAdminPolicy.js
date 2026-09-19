"use strict";

// V2-I bullet 2/3: strong authentication for remote administration.
//
// THE PROBLEM THIS MODULE MODELS
// ------------------------------
// Before this policy a single bearer credential — or a legacy enrollment with
// no scopes at all — reached the full Agent API from any address the Agent was
// reachable on. The Agent binds `0.0.0.0` by default (agent/src/config.js
// DEFAULT_HOST), so "reachable on the LAN" and "remote administration" were
// the same thing: possession of the token was the only requirement, and the
// token was not required to be scoped to anything.
//
// THE RULE (chosen, not inherited)
// --------------------------------
// This module is a PURE decision function. It answers one question:
// "may this already-authenticated request proceed to the capability it asks
// for, given where it came from and what the credential proves?" It does NOT
// authenticate, and it does NOT replace any existing gate.
//
//   1. An UNDETERMINABLE origin is REFUSED. A missing, empty, or non-string
//      remote address is never optimistically treated as local. Fail closed.
//   2. A LOOPBACK origin is ALLOWED unchanged. Every existing gate (pairing
//      credential gate, host-trust gate, bearer auth, scope gate, enrollment
//      binding gate) still runs; this policy adds nothing to the local path.
//      This is deliberate: it is the protected-recovery contract below.
//   3. A REMOTE origin is REFUSED unless ALL of the following hold:
//        a. Remote administration is EXPLICITLY enabled by the operator
//           (AGENT_REMOTE_ADMIN; absent/unknown => disabled). Reachability is
//           not consent: binding a public address does not turn this on.
//        b. The enrollment is `enrolled`. A null/undeterminable state, or a
//           pending/revoked/unenrolled state, is refused.
//        c. The credential is SCOPED, and its family scope EXPLICITLY covers
//           the requested family. An unscoped (legacy) credential is refused:
//           "strong" means the credential was deliberately narrowed, not that
//           it happens to be valid. A wildcard family ("*") does NOT count as
//           explicit coverage, so a broad legacy-shaped scope cannot be passed
//           off as strong auth.
//        d. The requested family is not in LOOPBACK_ONLY_FAMILIES. Those are
//           the families whose only proven product path is on-host; they must
//           stay loopback-only regardless of (a)-(c).
//   4. A request that names no permission family (health, an unrouted path)
//      requires nothing of this policy and is allowed. There is no capability
//      to gate, and the route tier still applies below.
//
// WHY THIS RULE AND NOT ANOTHER
// -----------------------------
// * Fail-closed on origin is the only defensible default: `request.socket.
//   remoteAddress` is the one signal a caller cannot forge, but it can be
//   ABSENT (a test harness, a unix socket, a future transport). Assuming local
//   on absence is exactly how a loopback trust assumption becomes a remote
//   bypass, so absence is refused.
// * Explicit enablement plus explicit scoping is two independent controls on
//   one decision, which is what "strong authentication" has to mean when the
//   Agent has no second factor: the operator must have opted in, AND the
//   credential must have been narrowed for the job. Either alone is weaker —
//   enablement alone still accepts an unscoped token; scoping alone still
//   grants remote administration the operator never asked for.
// * Refusing an unscoped remote credential is the deliberate behaviour change.
//   Remote administration with a legacy unscoped enrollment stops working by
//   design; the supported recovery is to re-enroll the remote node with a
//   family-scoped credential (V2-I bullet 3 already persists `scopes` on the
//   enrollment record) and set AGENT_REMOTE_ADMIN on that Agent. See
//   docs/remote administration note in the smoke for the operator steps.
// * `ui:session` is the only loopback-only family, and it is loopback-only
//   because that is what the codebase already proves: the browser session
//   transport is minted by the on-host desktop (agentControlService calls
//   createUiBootstrapCode with no node override) and consumed by a browser on
//   the Agent machine. It is not on any remote-node product path.
//   `owner` and `agent:manage` are deliberately NOT loopback-only: the desktop
//   revokes/rotates a remote node's enrollment over the network with that
//   node's own token (src/services/nodeService.js), so making them
//   loopback-only would break a shipping flow. They are protected by (a)-(c)
//   instead.
//
// PROTECTED RECOVERY (must remain possible when the credential is lost)
// --------------------------------------------------------------------
// "Strong auth" must never be able to lock an operator out of their own node.
// Therefore:
//   * The LOOPBACK origin is NEVER refused by this policy (rule 2), so the
//     on-host paths keep working unconditionally: `npm run agent:pair`, and the
//     desktop running on the Agent machine. An operator standing at the
//     machine always has a way in, whatever the remote setting says.
//   * The public enrollment handshake (`/api/v1/enroll/start|complete|status`)
//     and the pairing routes are handled BEFORE this policy is consulted and
//     are unchanged, so re-enrollment is never gated by remote administration.
//   * Revoke-then-reenroll remains the documented recovery: `POST
//     /api/v1/enroll/revoke` (owner) then the public handshake. Revoke is
//     reachable on loopback unconditionally, and remotes hold it only under
//     rule 3 — so a lost remote credential is recovered ON the Agent machine,
//     which is the intended posture.
// Losing the credential can therefore never require remote access to recover,
// which is the property that makes the stricter rule safe to enable.
//
// SCOPE OF PROOF: this policy is proven at the request layer (see
// scripts/remote-admin-authorization-smoke.js). No remote caller has been
// exercised over a real network.

// --- Typed verdicts --------------------------------------------------------

const ACCESS_ALLOWED = "allowed";
const ACCESS_ALLOWED_WITH_REQUIREMENT = "allowed-with-requirement";
const ACCESS_REFUSED = "refused";

// --- Origin classification -------------------------------------------------

const ORIGIN_LOOPBACK = "loopback";
const ORIGIN_REMOTE = "remote";
const ORIGIN_UNKNOWN = "unknown";

// Every spelling a dual-stack socket can report for loopback. Kept identical to
// agent/src/routes/pairing.js so the two loopback notions cannot drift.
const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "0:0:0:0:0:0:0:1",
]);

// --- Operator setting ------------------------------------------------------

// The explicit remote-administration opt-in. Absent, empty, or unrecognized =>
// disabled (fail closed); binding a routable address is not consent.
const REMOTE_ADMIN_ENV_KEY = "AGENT_REMOTE_ADMIN";
const TRUTHY_SETTING_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

// --- Loopback-only families ------------------------------------------------

// Keyed on the permission FAMILY (the segment before ":"), because that is the
// unit this policy matches. "ui" is the family of the browser session transport
// (`ui:session`, the /api/v1/ui/* routes). See the header for why this set is
// exactly this and why owner/agent:manage are not in it.
const LOOPBACK_ONLY_FAMILIES = new Set(["ui"]);

// --- Verdict codes ---------------------------------------------------------

const ALLOW_LOOPBACK_ORIGIN = "REMOTE_ADMIN_LOOPBACK_ORIGIN";
const ALLOW_NO_FAMILY_REQUIRED = "REMOTE_ADMIN_NO_FAMILY_REQUIRED";
const ALLOW_REMOTE_SCOPED_CREDENTIAL = "REMOTE_ADMIN_SCOPED_CREDENTIAL";

const REFUSE_ORIGIN_UNDETERMINED = "REMOTE_ADMIN_ORIGIN_UNDETERMINED";
const REFUSE_LOOPBACK_ONLY_FAMILY = "REMOTE_ADMIN_LOOPBACK_ONLY_FAMILY";
const REFUSE_NOT_ENABLED = "REMOTE_ADMIN_NOT_ENABLED";
const REFUSE_STATE_UNDETERMINED = "REMOTE_ADMIN_STATE_UNDETERMINED";
const REFUSE_NOT_ENROLLED = "REMOTE_ADMIN_NOT_ENROLLED";
const REFUSE_CREDENTIAL_UNSCOPED = "REMOTE_ADMIN_CREDENTIAL_UNSCOPED";
const REFUSE_FAMILY_NOT_COVERED = "REMOTE_ADMIN_FAMILY_NOT_COVERED";

const REMOTE_ADMIN_REQUIREMENT =
  "remote administration must be explicitly enabled (AGENT_REMOTE_ADMIN) and the credential must carry an explicit family scope covering this capability";

// --- Helpers ---------------------------------------------------------------

function normalizeToken(value) {
  return String(value === undefined || value === null ? "" : value).trim().toLowerCase();
}

// Classifies an origin from the one un-forgeable signal the request path has.
// Anything that is not a recognizable loopback spelling — including a missing
// or non-string address — is NOT assumed local.
function classifyOrigin(address) {
  if (typeof address !== "string") return ORIGIN_UNKNOWN;
  const value = address.trim();
  if (!value) return ORIGIN_UNKNOWN;
  return LOOPBACK_ADDRESSES.has(value) ? ORIGIN_LOOPBACK : ORIGIN_REMOTE;
}

function normalizeOrigin(value) {
  const normalized = normalizeToken(value);
  if (normalized === ORIGIN_LOOPBACK) return ORIGIN_LOOPBACK;
  if (normalized === ORIGIN_REMOTE) return ORIGIN_REMOTE;
  return ORIGIN_UNKNOWN;
}

function permissionFamily(permission) {
  const normalized = normalizeToken(permission);
  if (!normalized || normalized === "*") return null;
  return normalized.includes(":") ? normalized.split(":")[0] : normalized;
}

// An explicit boolean from a caller wins (the smoke uses this to be
// deterministic); otherwise the process environment decides. Unrecognized
// values are disabled.
function isRemoteAdminEnabled(explicit, env = process.env) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  if (explicit !== undefined && explicit !== null) return false;
  return TRUTHY_SETTING_VALUES.has(normalizeToken(env ? env[REMOTE_ADMIN_ENV_KEY] : ""));
}

// Returns the credential's family scope list, or null when the credential
// carries no usable scope envelope at all (an unscoped / legacy credential).
// A credential scoped ONLY by node ids is not unscoped — it is simply not
// family-scoped, which later reads as "does not cover the family" and is
// refused for the same reason with a more accurate code.
function normalizeScopeFamilies(scopes) {
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) return null;
  const rawFamilies = scopes.families === undefined || scopes.families === null ? [] : scopes.families;
  const rawNodeIds = scopes.nodeIds === undefined ? scopes.nodeId : scopes.nodeIds;
  const list = Array.isArray(rawFamilies) ? rawFamilies : [rawFamilies];
  const families = [];
  for (const entry of list) {
    if (typeof entry !== "string" && typeof entry !== "number") continue;
    const token = normalizeToken(entry);
    if (token) families.push(token);
  }
  const nodeList = Array.isArray(rawNodeIds) ? rawNodeIds : rawNodeIds === undefined || rawNodeIds === null ? [] : [rawNodeIds];
  const hasNodeScope = nodeList.some((entry) => normalizeToken(entry));
  if (!families.length && !hasNodeScope) return null;
  return families;
}

// "Explicitly covers" means the family itself or its "*" form is listed. A bare
// "*" is intentionally NOT accepted: a wildcard scope is not a narrowed
// credential, so it does not satisfy strong remote authentication.
function familyIsExplicitlyScoped(families, family, permission) {
  if (!Array.isArray(families) || !families.length || !family) return false;
  const exact = normalizeToken(permission);
  return families.some((entry) => entry === family || entry === `${family}:*` || (exact && entry === exact));
}

function verdict(access, code, reason, extra = {}) {
  return Object.freeze({
    access,
    allowed: access !== ACCESS_REFUSED,
    code,
    reason,
    requirement: extra.requirement || null,
    origin: extra.origin || null,
    family: extra.family || null,
    statusCode: access === ACCESS_REFUSED ? extra.statusCode || 403 : 200,
  });
}

// --- The decision ----------------------------------------------------------

/**
 * Decide whether an already-authenticated request may proceed.
 *
 * @param {object} descriptor
 * @param {string} [descriptor.origin]        "loopback" | "remote" | anything else
 * @param {string} [descriptor.remoteAddress] raw socket address; classified when origin is absent
 * @param {string|null} [descriptor.permission] the route's permission family (e.g. "files:read"), or null
 * @param {object|null} [descriptor.scopes]   the credential's normalized scope envelope
 * @param {string|null} [descriptor.enrollmentState] "enrolled" | "pending" | "revoked" | "unenrolled"
 * @param {boolean} [descriptor.remoteAdminEnabled] explicit override of AGENT_REMOTE_ADMIN
 * @returns {{access:string, allowed:boolean, code:string, reason:string, requirement:string|null,
 *            origin:string|null, family:string|null, statusCode:number}} frozen verdict
 */
function evaluateRemoteAdminAccess(descriptor = {}) {
  const origin = descriptor.origin !== undefined && descriptor.origin !== null
    ? normalizeOrigin(descriptor.origin)
    : classifyOrigin(descriptor.remoteAddress);

  const permission = typeof descriptor.permission === "string" && descriptor.permission.trim()
    ? descriptor.permission.trim()
    : null;
  const family = permissionFamily(permission);

  // Rule 1: an origin we cannot place is never assumed local.
  if (origin === ORIGIN_UNKNOWN) {
    return verdict(ACCESS_REFUSED, REFUSE_ORIGIN_UNDETERMINED,
      "The request origin could not be determined, so remote administration cannot be ruled out. Refused.",
      { origin: ORIGIN_UNKNOWN, family });
  }

  // Rule 2 + protected recovery: loopback is always allowed and never
  // strengthened here. The existing gates still run.
  if (origin === ORIGIN_LOOPBACK) {
    return verdict(ACCESS_ALLOWED, ALLOW_LOOPBACK_ORIGIN,
      "The request came from loopback; remote-administration requirements do not apply.",
      { origin: ORIGIN_LOOPBACK, family });
  }

  // Rule 4: nothing to gate.
  if (!permission) {
    return verdict(ACCESS_ALLOWED, ALLOW_NO_FAMILY_REQUIRED,
      "The route requires no capability, so remote-administration requirements do not apply.",
      { origin: ORIGIN_REMOTE, family: null });
  }

  // Rule 3d: the loopback-only families stay loopback-only, whatever the
  // setting or the credential says.
  if (family && LOOPBACK_ONLY_FAMILIES.has(family)) {
    return verdict(ACCESS_REFUSED, REFUSE_LOOPBACK_ONLY_FAMILY,
      `The "${family}" capability is loopback-only and is not available to remote callers.`,
      { origin: ORIGIN_REMOTE, family });
  }

  // Rule 3a.
  if (!isRemoteAdminEnabled(descriptor.remoteAdminEnabled)) {
    return verdict(ACCESS_REFUSED, REFUSE_NOT_ENABLED,
      "Remote administration is not enabled on this Agent. Set AGENT_REMOTE_ADMIN to allow it explicitly.",
      { origin: ORIGIN_REMOTE, family });
  }

  // Rule 3b.
  const state = normalizeToken(descriptor.enrollmentState);
  if (!state) {
    return verdict(ACCESS_REFUSED, REFUSE_STATE_UNDETERMINED,
      "The enrollment state of the presented credential could not be determined. Refused.",
      { origin: ORIGIN_REMOTE, family });
  }
  if (state !== "enrolled") {
    return verdict(ACCESS_REFUSED, REFUSE_NOT_ENROLLED,
      `Remote administration requires an enrolled credential; this credential is "${state}".`,
      { origin: ORIGIN_REMOTE, family });
  }

  // Rule 3c.
  const scopes = normalizeScopeFamilies(descriptor.scopes);
  if (!scopes) {
    return verdict(ACCESS_REFUSED, REFUSE_CREDENTIAL_UNSCOPED,
      "Remote administration requires a scoped credential; this credential is unscoped.",
      { origin: ORIGIN_REMOTE, family });
  }
  if (!family || !familyIsExplicitlyScoped(scopes, family, permission)) {
    return verdict(ACCESS_REFUSED, REFUSE_FAMILY_NOT_COVERED,
      `The credential's family scope does not explicitly cover "${family || permission}".`,
      { origin: ORIGIN_REMOTE, family });
  }

  return verdict(ACCESS_ALLOWED_WITH_REQUIREMENT, ALLOW_REMOTE_SCOPED_CREDENTIAL,
    `Remote administration is enabled and the credential explicitly covers "${family}".`,
    { origin: ORIGIN_REMOTE, family, requirement: REMOTE_ADMIN_REQUIREMENT });
}

module.exports = {
  ACCESS_ALLOWED,
  ACCESS_ALLOWED_WITH_REQUIREMENT,
  ACCESS_REFUSED,
  LOOPBACK_ADDRESSES,
  LOOPBACK_ONLY_FAMILIES,
  ORIGIN_LOOPBACK,
  ORIGIN_REMOTE,
  ORIGIN_UNKNOWN,
  REMOTE_ADMIN_ENV_KEY,
  REMOTE_ADMIN_REQUIREMENT,
  REFUSE_CREDENTIAL_UNSCOPED,
  REFUSE_FAMILY_NOT_COVERED,
  REFUSE_LOOPBACK_ONLY_FAMILY,
  REFUSE_NOT_ENABLED,
  REFUSE_NOT_ENROLLED,
  REFUSE_ORIGIN_UNDETERMINED,
  REFUSE_STATE_UNDETERMINED,
  classifyOrigin,
  evaluateRemoteAdminAccess,
  familyIsExplicitlyScoped,
  isRemoteAdminEnabled,
  permissionFamily,
};