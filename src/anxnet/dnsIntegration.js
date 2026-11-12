"use strict";

// Make this computer's own name lookups use AnxNet for its network's names,
// and nothing else.
//
// Windows: one NRPT rule (Name Resolution Policy Table) for the namespace
//   ".<network>.internal", pointing at AnxNet's resolver on 127.77.0.1:53,
//   tagged with the comment "AnxNet <networkId>". Ordinary internet DNS and
//   other programs' rules (for example Tailscale's) are untouched. NRPT only
//   supports port 53; a normal user may bind 127.77.0.1:53, so the AnxNet
//   resolver moves there while this is on.
// Linux (systemd-resolved): a dummy link "anxnet0" with AnxNet's resolver
//   (127.77.0.1:5353) and a routing-only domain "~<network>.internal", not a
//   default route. Runtime only: it is gone after a reboot and is reapplied
//   from AnxOS.
//
// Both need administrator rights. AnxOS applies them only when the user asks
// (an explicit confirmation in the UI), through the OS's own elevation prompt
// (UAC / pkexec), and removes them the same way. Nothing here runs on its own.

const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const RESOLVER_HOST = "127.77.0.1";
const COMMENT_PREFIX = "AnxNet ";
const LINUX_LINK = "anxnet0";

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertDomain(domain) {
  if (!/^anx-[a-z0-9-]{2,40}\.internal$/.test(String(domain || ""))) throw error("ANXNET_DNS_DOMAIN", "Only AnxNet network domains can be set up.");
  return domain;
}

function assertNetworkId(networkId) {
  if (!/^net-[a-z2-7]{26}$/.test(String(networkId || ""))) throw error("ANXNET_DNS_NETWORK", "Unknown network.");
  return networkId;
}

// The exact change, shown to the user before anything runs.
function plan({ platform = process.platform, domain, networkId }) {
  assertDomain(domain);
  assertNetworkId(networkId);
  if (platform === "win32") {
    const namespace = `.${domain}`;
    const comment = `${COMMENT_PREFIX}${networkId}`;
    return {
      supported: true,
      platform,
      resolverPort: 53,
      summary: `Adds one Windows name rule: names ending in ${namespace} are looked up at AnxNet (${RESOLVER_HOST}). All other names keep using your normal DNS.`,
      apply: [
        "$ErrorActionPreference = 'Stop'",
        `$ns = '${namespace}'`,
        "$rules = @(Get-DnsClientNrptRule | Where-Object { $_.Namespace -contains $ns })",
        `if ($rules | Where-Object { $_.Comment -notlike '${COMMENT_PREFIX}*' }) { throw 'Another program already handles these names.' }`,
        `$rules | Where-Object { $_.Comment -like '${COMMENT_PREFIX}*' } | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }`,
        `Add-DnsClientNrptRule -Namespace $ns -NameServers '${RESOLVER_HOST}' -Comment '${comment}' | Out-Null`,
        "Clear-DnsClientCache",
      ],
      remove: [
        "$ErrorActionPreference = 'Stop'",
        `Get-DnsClientNrptRule | Where-Object { $_.Comment -like '${COMMENT_PREFIX}*' } | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }`,
        "Clear-DnsClientCache",
      ],
    };
  }
  if (platform === "linux") {
    return {
      supported: true,
      platform,
      resolverPort: 5353,
      summary: `Adds a private link "${LINUX_LINK}" to systemd-resolved: names ending in .${domain} are looked up at AnxNet (${RESOLVER_HOST}:5353). It is not a default route, so all other names keep using your normal DNS. Undone on reboot or when you turn it off.`,
      apply: [
        "set -e",
        "command -v resolvectl >/dev/null || { echo 'systemd-resolved is required' >&2; exit 3; }",
        `ip link show ${LINUX_LINK} >/dev/null 2>&1 || ip link add ${LINUX_LINK} type dummy`,
        `ip link set ${LINUX_LINK} up`,
        `resolvectl dns ${LINUX_LINK} ${RESOLVER_HOST}:5353`,
        `resolvectl domain ${LINUX_LINK} '~${domain}'`,
        `resolvectl default-route ${LINUX_LINK} false`,
      ],
      remove: [`ip link del ${LINUX_LINK} 2>/dev/null || true`],
    };
  }
  return { supported: false, platform, reason: "Automatic name lookup is available on Windows and Linux (systemd-resolved)." };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: options.timeoutMs || 120000 }, (cause, stdout, stderr) => {
      resolve({ ok: !cause, code: cause?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Read-only: is AnxNet's rule in place, and does anything else claim the names?
async function detect({ platform = process.platform, domain, runCommand = run } = {}) {
  if (platform === "win32") {
    const result = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-DnsClientNrptRule | Select-Object Namespace, NameServers, Comment | ConvertTo-Json -Compress"]);
    let rules = [];
    try { const parsed = JSON.parse(result.stdout || "[]"); rules = Array.isArray(parsed) ? parsed : [parsed]; } catch {}
    const namespace = domain ? `.${domain}` : null;
    const listOf = (value) => (Array.isArray(value) ? value : value ? [value] : []);
    const ours = rules.filter((rule) => String(rule.Comment || "").startsWith(COMMENT_PREFIX));
    const conflicting = namespace ? rules.filter((rule) => !String(rule.Comment || "").startsWith(COMMENT_PREFIX) && listOf(rule.Namespace).includes(namespace)) : [];
    return {
      enabled: Boolean(namespace) && ours.some((rule) => listOf(rule.Namespace).includes(namespace) && listOf(rule.NameServers).includes(RESOLVER_HOST)),
      leftover: ours.filter((rule) => !namespace || !listOf(rule.Namespace).includes(namespace)).map((rule) => listOf(rule.Namespace).join(",")),
      conflict: conflicting.length > 0,
      otherRules: rules.length - ours.length,
    };
  }
  if (platform === "linux") {
    const result = await runCommand("resolvectl", ["status", LINUX_LINK]);
    return { enabled: result.ok && Boolean(domain) && result.stdout.includes(`~${domain}`), leftover: [], conflict: false };
  }
  return { enabled: false, leftover: [], conflict: false, unsupported: true };
}

// Run the plan's commands with the OS's own elevation prompt. The elevated
// script's output can't be captured directly, so it writes a result file.
async function elevate({ platform = process.platform, lines, runCommand = run }) {
  if (platform === "win32") {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-dns-"));
    const script = path.join(folder, "anxnet-dns.ps1");
    const resultFile = path.join(folder, "result.txt");
    const body = ["try {", ...lines.map((line) => `  ${line}`), `  Set-Content -LiteralPath '${resultFile}' -Value 'ok'`, "} catch {", `  Set-Content -LiteralPath '${resultFile}' -Value ('error: ' + $_.Exception.Message)`, "}"].join("\r\n");
    fs.writeFileSync(script, body);
    try {
      const outer = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}'`]);
      const result = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8").trim() : "";
      if (result === "ok") return { ok: true };
      if (!outer.ok && /canceled|cancelled|1223/i.test(outer.stderr)) throw error("ANXNET_DNS_DECLINED", "Administrator permission wasn't given, so nothing changed.");
      throw error("ANXNET_DNS_FAILED", result.replace(/^error:\s*/, "") || "The change didn't complete.");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
  if (platform === "linux") {
    const result = await runCommand("pkexec", ["sh", "-c", lines.join("\n")]);
    if (result.ok) return { ok: true };
    if (result.code === 126 || result.code === 127) throw error("ANXNET_DNS_DECLINED", "Administrator permission wasn't given, so nothing changed.");
    throw error("ANXNET_DNS_FAILED", (result.stderr || result.stdout).trim().slice(0, 300) || "The change didn't complete.");
  }
  throw error("ANXNET_DNS_UNSUPPORTED", "Not supported on this system.");
}

// Ask the computer's normal resolver (what games and browsers use) for a
// name, and check the answer.
async function verify({ name, expected, lookup = (host) => dns.promises.lookup(host, { family: 4 }) }) {
  try {
    const result = await lookup(name);
    const address = result?.address || result;
    return { ok: address === expected, address, name };
  } catch (cause) {
    return { ok: false, name, error: cause.code || cause.message };
  }
}

module.exports = { COMMENT_PREFIX, LINUX_LINK, RESOLVER_HOST, detect, elevate, plan, verify, _test: { assertDomain, run } };
