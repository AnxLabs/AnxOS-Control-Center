// The AnxOS-managed prefix is enforced, not caller-optional (review P2): a
// rule created without it could never be listed or deleted by AnxOS (the
// inventory and delete paths only accept managed names), and a caller-supplied
// name could also shadow a rule from an earlier session. Normalizing here
// guarantees every created rule is addressable and attributable.
const MANAGED_RULE_PREFIX = "AnxOS ";

function ensureManagedRuleName(value, protocol, port) {
  const requested = String(value || "").trim().replace(/["\r\n]/g, " ").trim();
  const base = requested || `${protocol} ${port}`;
  const prefixed = base.startsWith(MANAGED_RULE_PREFIX) ? base : `${MANAGED_RULE_PREFIX}${base}`;
  return prefixed.slice(0, 80);
}

function buildWindowsFirewallRule(payload = {}) {
  const protocol = String(payload.protocol || "tcp").trim().toUpperCase();
  const port = Number.parseInt(payload.localPort || payload.port, 10);
  if (!['TCP', 'UDP'].includes(protocol)) throw Object.assign(new Error("Windows Firewall rules can only be created for TCP or UDP services."), { code: "INVALID_FIREWALL_PROTOCOL" });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error("Choose a service port from 1 to 65535 before creating a firewall rule."), { code: "INVALID_FIREWALL_PORT" });
  if (payload.confirmConsent !== true) throw Object.assign(new Error("Creating a Windows Firewall rule requires explicit confirmation."), { code: "FIREWALL_CONSENT_REQUIRED" });
  const name = ensureManagedRuleName(payload.name, protocol, port);
  return { name, protocol, port, args: ["advfirewall", "firewall", "add", "rule", `name=${name}`, "dir=in", "action=allow", `protocol=${protocol}`, `localport=${port}`] };
}

module.exports = { buildWindowsFirewallRule, ensureManagedRuleName, MANAGED_RULE_PREFIX };
