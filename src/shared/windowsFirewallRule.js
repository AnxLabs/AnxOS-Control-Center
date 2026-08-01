function buildWindowsFirewallRule(payload = {}) {
  const protocol = String(payload.protocol || "tcp").trim().toUpperCase();
  const port = Number.parseInt(payload.localPort || payload.port, 10);
  if (!['TCP', 'UDP'].includes(protocol)) throw Object.assign(new Error("Windows Firewall rules can only be created for TCP or UDP services."), { code: "INVALID_FIREWALL_PROTOCOL" });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error("Choose a service port from 1 to 65535 before creating a firewall rule."), { code: "INVALID_FIREWALL_PORT" });
  if (payload.confirmConsent !== true) throw Object.assign(new Error("Creating a Windows Firewall rule requires explicit confirmation."), { code: "FIREWALL_CONSENT_REQUIRED" });
  const name = String(payload.name || `AnxOS ${protocol} ${port}`).trim().replace(/["\r\n]/g, " ").slice(0, 80);
  return { name, protocol, port, args: ["advfirewall", "firewall", "add", "rule", `name=${name}`, "dir=in", "action=allow", `protocol=${protocol}`, `localport=${port}`] };
}

module.exports = { buildWindowsFirewallRule };
