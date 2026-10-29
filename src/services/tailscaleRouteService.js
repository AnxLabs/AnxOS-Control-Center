"use strict";

// Suggests a Tailscale route for an Agent node by matching the node's
// hostname against this computer's tailnet peers (`tailscale status --json`,
// read-only). The suggestion is only a URL; nodeRouteResolver still verifies
// the Agent identity before any request uses it.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const STATUS_TIMEOUT_MS = 8000;

function findTailscaleCli() {
  if (process.platform === "win32") {
    const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter(Boolean)
      .map((dir) => path.join(dir, "Tailscale", "tailscale.exe"));
    return candidates.find((candidate) => fs.existsSync(candidate)) || "tailscale.exe";
  }
  return "tailscale";
}

function readTailscaleStatus() {
  return new Promise((resolve) => {
    execFile(findTailscaleCli(), ["status", "--json"], { timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ available: false, reason: error.code === "ENOENT" ? "TAILSCALE_NOT_INSTALLED" : "TAILSCALE_STATUS_FAILED" });
        return;
      }
      try {
        resolve({ available: true, status: JSON.parse(String(stdout || "{}")) });
      } catch {
        resolve({ available: false, reason: "TAILSCALE_STATUS_UNREADABLE" });
      }
    });
  });
}

function agentPortOf(node = {}) {
  try {
    const url = new URL(String(node.baseUrl || node.agentUrl || ""));
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

function hostnamesOf(node = {}) {
  return [node.hostname, node.agentIdentity?.hostname, node.displayName]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

// Pure: which tailnet peers look like this node, as candidate fallback URLs.
function suggestFromStatus(node, status = {}) {
  const port = agentPortOf(node);
  const names = new Set(hostnamesOf(node));
  if (!port || !names.size) return [];
  if (status.BackendState && status.BackendState !== "Running") return [];
  const suggestions = [];
  for (const peer of Object.values(status.Peer || {})) {
    const host = String(peer?.HostName || "").toLowerCase();
    const dnsName = String(peer?.DNSName || "").replace(/\.$/, "");
    const shortDns = dnsName.split(".")[0].toLowerCase();
    if (!names.has(host) && !names.has(shortDns)) continue;
    const address = dnsName || (peer.TailscaleIPs || []).find((ip) => /^100\./.test(ip));
    if (!address) continue;
    suggestions.push({ url: `http://${address}:${port}`, label: "Tailscale", online: peer.Online === true, peerName: peer.HostName || shortDns });
  }
  return suggestions;
}

async function suggestTailscaleRoutes(node, options = {}) {
  const read = options.readStatus || readTailscaleStatus;
  const result = await read();
  if (!result.available) return { available: false, reason: result.reason, suggestions: [] };
  const running = !result.status?.BackendState || result.status.BackendState === "Running";
  return {
    available: true,
    running,
    reason: running ? null : "TAILSCALE_NOT_RUNNING",
    suggestions: running ? suggestFromStatus(node, result.status) : [],
  };
}

module.exports = {
  suggestTailscaleRoutes,
  _test: { suggestFromStatus, agentPortOf },
};
