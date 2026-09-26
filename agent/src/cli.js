#!/usr/bin/env node
"use strict";

// anxos-agent — headless Agent CLI/TUI entry point.
//
// Thin by design: argument parsing, dispatch, exit codes, and output shaping
// live here; every behavior is implemented by the shared runtime modules under
// src/services and src/tui. The CLI talks to the authoritative agent runtime
// (agent/src/server.js) over its HTTP API and manages its systemd unit — it is
// never a second agent implementation.

const fs = require("fs");
const { createAgentCliClient, isLoopbackUrl } = require("./services/agentCliClient");
const { createServiceManager } = require("./services/agentServiceManager");
const { checkForUpdate, getCurrentVersion, readAgentReleaseIdentity } = require("./services/agentUpdateCheck");
const { readAgentLogTail } = require("./services/agentLogService");
const { createPairingFlow, formatRemaining } = require("./tui/pairing-flow");
const { runTui } = require("./tui/tui");
const {
  readAgentConfigFile,
  resolveAgentConfigPath,
  writeAgentConfigToken,
} = require("../../src/shared/agentTokenStore");
const { sanitizeForDiagnostics } = require("../../src/shared/redaction");

const SERVICE_ACTIONS = ["status", "start", "stop", "restart", "install", "uninstall"];
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const HELP_TEXT = `anxos-agent — AnxOS Agent terminal interface

Usage:
  anxos-agent                              Interactive terminal UI (TTY); plain status text otherwise
  anxos-agent status [--json]              Agent health, identity, service and system summary
  anxos-agent pair [--json] [--wait] [--timeout <seconds>] [--cancel]
                                           Start a pairing code (or cancel the active session)
  anxos-agent service status|start|stop|restart|install|uninstall [--json]
                                           Manage the anxos-agent systemd unit
  anxos-agent logs [--lines N] [--json]    Tail the Agent log
  anxos-agent diagnostics [--json]         Redacted support summary (no credential material)
  anxos-agent update --check [--json]      Read-only release check (never installs)
  anxos-agent unpair [--yes]               Revoke the enrollment and clear the local credential
  anxos-agent --help | --version

Pairing:
  Paste the printed full pairing code into AnxOS Control Center under Add
  Computer; the short ANX reference code identifies the session on screen. With
  --json --wait the first stdout line is a {"event":"pairing-started"} record
  (so scripts can complete the session), followed by the final
  {"event":"pairing-result"} record. --json without --wait prints one object.

  An already-enrolled Agent only accepts re-pairing over the network from a
  caller that can present the stored credential; run with sudo (or from Agent
  Control on this machine) when the credential file is not readable.

Automation seam (tests only):
  Set ANXOS_TUI_KEYS to a key sequence (for example "pq"). The TUI processes
  each key, renders after each into stdout, and exits with code 0.

Environment:
  ANXHUB_CONFIG_DIR   Agent configuration directory (default /var/lib/anxos-agent/config)
  AGENT_INSTANCE_ROOT Managed instances root (default /var/lib/anxos-agent/instances)
  AGENT_BACKUP_ROOT   Backups root (default /var/lib/anxos-agent/backups)
  ANXOS_LOG_DIR       Agent log directory (default /var/log/anxos-agent)
  AGENT_PORT          Agent port (default 47131)
  AGENT_URL           Explicit Agent base URL
  AGENT_HOST          Explicit Agent bind host (used for the user unit and network access)
  ANXOS_AGENT_UPDATE_SOURCE  Override the release metadata URL
`;

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--wait") flags.wait = true;
    else if (arg === "--cancel") flags.cancel = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--check") flags.check = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg === "--lines") {
      flags.lines = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--lines=")) flags.lines = arg.slice("--lines=".length);
    else if (arg === "--timeout") {
      flags.timeout = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--timeout=")) flags.timeout = arg.slice("--timeout=".length);
    else if (arg.startsWith("-")) return { error: `Unknown option: ${arg}` };
    else positionals.push(arg);
  }
  return { positionals, flags };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printError(message) {
  process.stderr.write(`${message}\n`);
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Environment parity (once, before dispatch): a plain root shell does not
// inherit the systemd unit's environment, so the CLI applies the installed
// Agent env files itself. Explicitly-set variables always win, and
// ANXOS_AGENT_SKIP_ENV_FILE=1 disables loading for callers that need a clean
// environment. This must never block the CLI.
function loadAgentEnvironment() {
  try {
    const { applyEnvFile } = require("./services/agentEnvFile");
    applyEnvFile({ env: process.env });
  } catch {
    // A missing or unreadable env file is not an error for the CLI.
  }
}

async function attempt(promise, fallback = null) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

async function collectStatusReport(client, serviceManager) {
  const connection = client.resolveConnection();
  const releaseIdentity = readAgentReleaseIdentity({ env: process.env });
  const [health, enrollment, pairing, service, stats] = await Promise.all([
    attempt(client.health()),
    attempt(client.enrollStatus()),
    attempt(client.pairingStatus()),
    attempt(Promise.resolve(serviceManager.status())),
    attempt(client.stats()),
  ]);
  const healthBody = health?.body || null;
  return {
    ok: Boolean(health?.ok),
    reachable: Boolean(health?.ok),
    baseUrl: health?.baseUrl || connection.primary,
    // Runtime and package are distinct identities: the runtime version comes
    // from agent/package.json, the package version from the stamped release
    // identity. Source checkouts have no identity and say so.
    runtimeVersion: getCurrentVersion(),
    packageVersion: releaseIdentity?.artifactVersion || null,
    releaseTag: releaseIdentity?.releaseTag || null,
    releaseIdentityPath: releaseIdentity?.identityPath || null,
    connection: {
      mode: connection.mode,
      candidates: connection.candidates,
      loopbackOnly: connection.loopbackOnly,
      reachableUrl: connection.reachableUrl,
      credential: connection.token,
      notes: connection.notes,
    },
    agent: healthBody?.identity || null,
    health: healthBody
      ? {
        ok: healthBody.ok,
        mode: healthBody.mode,
        tokenConfigured: healthBody.tokenConfigured,
        credentialFingerprint: healthBody.tokenFingerprint || null,
        process: healthBody.process || null,
      }
      : null,
    enrollment: enrollment?.body ? { state: enrollment.body.state, enrollmentId: enrollment.body.enrollmentId || null } : null,
    pairing: pairing?.body ? { status: pairing.body.status } : null,
    service: service || null,
    // Env-first layout resolution (ANXHUB_CONFIG_DIR / AGENT_INSTANCE_ROOT /
    // AGENT_BACKUP_ROOT / ANXOS_LOG_DIR), reported so scripts never have to
    // guess where this installation keeps its data.
    paths: {
      configDir: serviceManager.resolveConfigDir(),
      instanceRoot: serviceManager.resolveInstanceRoot(),
      backupRoot: serviceManager.resolveBackupRoot(),
      logDir: serviceManager.resolveLogDir(),
    },
    system: stats?.body || null,
    errors: {
      health: health?.ok ? null : health?.code || "AGENT_UNREACHABLE",
      stats: stats?.ok ? null : stats?.code || "STATS_UNAVAILABLE",
    },
  };
}

function formatPlainStatus(report) {
  const lines = [];
  const identity = report.agent || {};
  lines.push("AnxOS Agent status");
  lines.push("------------------");
  lines.push(`Reachable:  ${report.reachable ? `yes (${report.baseUrl})` : "no"}`);
  if (report.reachable) {
    lines.push(`Version:    ${identity.agentVersion || "unknown"}`);
    lines.push(`Identity:   ${identity.deviceId || "unknown"} @ ${identity.hostname || "unknown"}`);
    lines.push(`Platform:   ${identity.platform || "unknown"} ${identity.architecture || ""}`.trimEnd());
    lines.push(`Mode:       ${report.health?.mode || "unknown"}`);
    lines.push(`Credential: ${report.health?.tokenConfigured ? "configured" : "not configured"}${report.health?.credentialFingerprint ? ` (fingerprint ${report.health.credentialFingerprint})` : ""}`);
  } else {
    lines.push(`Reason:     ${report.errors?.health || "AGENT_UNREACHABLE"}`);
  }
  lines.push(`Runtime:    ${report.runtimeVersion || "unknown"}`);
  lines.push(`Package:    ${report.packageVersion ? `${report.packageVersion}${report.releaseTag ? ` (${report.releaseTag})` : ""}` : "development or source install"}`);
  lines.push(`Enrollment: ${report.enrollment?.state || "unknown"}`);
  lines.push(`Pairing:    ${report.pairing?.status || "unknown"}`);
  const service = report.service;
  if (service) {
    lines.push(`Service:    ${service.supported === false ? "unsupported" : service.mode === "none" ? "not installed" : `${service.state || "unknown"} (${service.mode} unit${service.unitPath ? `, ${service.unitPath}` : ""})`}`);
    if (service.privilege?.rootRequired && service.privilege.isRoot === false) {
      lines.push("Note:       This is a package-managed system unit; service control needs root (use sudo).");
    }
  }
  if (report.system) {
    const memory = report.system.memory || {};
    const cpu = report.system.cpu || {};
    lines.push(`CPU/RAM:    ${Number.isFinite(cpu.usagePercent) ? `${cpu.usagePercent}%` : "n/a"} CPU, ${Math.round((memory.used / memory.total) * 100)}% RAM used`);
  }
  if (report.connection.loopbackOnly && report.reachable) {
    lines.push("Note:       The Agent listens on loopback only; another computer cannot pair with it.");
  }
  return lines.join("\n");
}

function describeServiceResult(action, result) {
  if (action === "status") {
    if (result.supported === false) return `Service status unavailable: ${result.reason || "unsupported platform"}.`;
    if (result.mode === "none") return "No anxos-agent systemd unit is installed. Run `anxos-agent service install` for a source installation.";
    return `Unit: ${result.unitPath}\nMode: ${result.mode}\nState: ${result.state}\nEnabled: ${result.enabled ? "yes" : "no"}\nActive: ${result.active ? "yes" : "no"}`;
  }
  if (action === "install") {
    return [
      `Installed user unit: ${result.unitPath}`,
      `State: ${result.state} (enabled: ${result.enabled ? "yes" : "no"}, active: ${result.active ? "yes" : "no"})`,
      ...(result.notes || []),
    ].join("\n");
  }
  if (action === "uninstall") {
    return result.removed
      ? `Removed user unit ${result.unitPath}. Configuration, instances and backups were preserved.${result.warning ? `\nWarning: ${result.warning}` : ""}`
      : result.detail || "No user unit was installed.";
  }
  return `Agent service ${action}: ${result.state || "ok"} (active: ${result.active ? "yes" : "no"})`;
}

function formatPairingStart(state, options = {}) {
  // The FULL pairing code (friendly code + base64url payload carrying the Agent
  // address) is the only value Control Center's Add Computer accepts. The short
  // display code is a human reference for matching the session on screen, so it
  // stays a separate line and is never presented as the code to enter.
  const pairingCode = trim(state.pairingCode) || trim(state.displayCode) || "unknown";
  const lines = [];
  lines.push("AnxOS Agent pairing");
  lines.push("-------------------");
  if (options.loopbackOnly) {
    // The code below is minted over loopback, so it advertises 127.0.0.1 and a
    // different computer cannot redeem it. Say so before the code, with the
    // exact opt-in remedy, instead of letting the other machine fail later.
    lines.push("");
    lines.push("NOTICE: This Agent is reachable on this computer only (loopback).");
    lines.push("Another computer cannot use this code until network access is enabled.");
    lines.push("");
    lines.push("To allow a computer on your network to connect:");
    lines.push("  1. Open the setup screen with: sudo anxos-agent");
    lines.push("  2. Choose Pair, then press n to allow network access for your network.");
    lines.push("  3. Or add AGENT_HOST with this computer's network address to");
    lines.push("     /etc/anxos-agent/agent.env, then restart the Agent service.");
    lines.push("");
  }
  lines.push("Pairing code (paste into Add Computer):");
  lines.push(pairingCode);
  lines.push("");
  lines.push(`Reference code: ${state.displayCode || "unknown"}`);
  lines.push(`Agent address: ${state.agentUrl || state.baseUrl || "unknown"}`);
  lines.push(`Expires: ${state.expiresAt || "unknown"} (in ${formatRemaining(state.remainingMs)})`);
  lines.push("");
  lines.push("In AnxOS Control Center open Add Computer and paste the full pairing code above.");
  lines.push("The code may wrap across lines; whitespace in the pasted code is ignored.");
  return lines.join("\n");
}

function formatPairingResult(state) {
  if (state.status === "paired") return "Paired successfully. The Agent credential was installed by AnxOS Control Center.";
  if (state.status === "expired") return "The pairing code expired before it was used.";
  if (state.status === "timeout") return "Stopped waiting for the code to be used. The code is still valid until it expires.";
  if (state.status === "cancelled") return "The pairing session was cancelled.";
  const error = state.error || {};
  return [`Pairing failed: ${error.message || "unknown error"}`, error.hint].filter(Boolean).join("\n");
}

async function commandStatus(flags) {
  const client = createAgentCliClient();
  const serviceManager = createServiceManager();
  const report = await collectStatusReport(client, serviceManager);
  if (flags.json) printJson(report);
  else process.stdout.write(`${formatPlainStatus(report)}\n`);
  return EXIT_OK;
}

async function commandPair(flags) {
  const client = createAgentCliClient();

  if (flags.cancel) {
    const flow = createPairingFlow({ client });
    const state = await flow.cancel();
    if (flags.json) printJson({ cancelled: state.status === "cancelled", status: state.status, error: state.error || null });
    else process.stdout.write(`${formatPairingResult(state)}\n`);
    return state.status === "cancelled" ? EXIT_OK : EXIT_ERROR;
  }

  const flow = createPairingFlow({ client });
  const connection = client.resolveConnection();
  const started = await flow.start();
  if (started.status !== "waiting") {
    if (flags.json) printJson({ state: started.status, error: started.error || null });
    else printError(formatPairingResult(started));
    return EXIT_ERROR;
  }
  // resolveConnection() reflects config/env, but a stale non-loopback agentUrl
  // can fall through to the loopback candidate while the mint is requested, so
  // the session's actual address is the authoritative check: a code minted over
  // loopback must never be presented for another computer without the notice.
  const loopbackOnly = connection.loopbackOnly === true || isLoopbackUrl(started.agentUrl);

  if (!flags.wait) {
    if (flags.json) {
      printJson({
        state: started.status,
        displayCode: started.displayCode,
        pairingCode: started.pairingCode,
        agentUrl: started.agentUrl,
        expiresAt: started.expiresAt,
        baseUrl: started.baseUrl,
      });
    } else {
      process.stdout.write(`${formatPairingStart(started, { loopbackOnly })}\n`);
    }
    return EXIT_OK;
  }

  if (flags.json) {
    printJsonLine({ event: "pairing-started", state: started.status, displayCode: started.displayCode, pairingCode: started.pairingCode, agentUrl: started.agentUrl, expiresAt: started.expiresAt, baseUrl: started.baseUrl });
  } else {
    process.stdout.write(`${formatPairingStart(started, { loopbackOnly })}\n\nWaiting for the code to be used...\n`);
  }

  const requestedTimeoutSeconds = Number.parseInt(flags.timeout, 10);
  const timeoutMs = Number.isFinite(requestedTimeoutSeconds) && requestedTimeoutSeconds > 0
    ? requestedTimeoutSeconds * 1000
    : (started.remainingMs || 10 * 60 * 1000) + 1000;
  const final = await flow.waitForCompletion({ timeoutMs });

  if (flags.json) {
    printJsonLine({
      event: "pairing-result",
      state: final.status,
      displayCode: final.displayCode,
      agentUrl: final.agentUrl,
      baseUrl: final.baseUrl,
      credentialFingerprint: final.tokenFingerprint || null,
      error: final.error || null,
    });
  } else {
    process.stdout.write(`${formatPairingResult(final)}\n`);
  }
  return final.status === "paired" ? EXIT_OK : EXIT_ERROR;
}

async function commandService(positionals, flags) {
  const action = positionals[1] || "status";
  if (!SERVICE_ACTIONS.includes(action)) {
    printError(`Unknown service action "${action}". Expected one of: ${SERVICE_ACTIONS.join(", ")}.`);
    return EXIT_USAGE;
  }
  const manager = createServiceManager();
  try {
    const result = action === "status" ? await manager.status() : await manager[action]();
    if (flags.json) printJson(result);
    else process.stdout.write(`${describeServiceResult(action, result)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (flags.json) printJson({ ok: false, code: error.code || "SERVICE_FAILED", message: error.message, recoverySuggestion: error.recoverySuggestion || null });
    else {
      printError(error.message || "The service operation failed.");
      if (error.recoverySuggestion) printError(error.recoverySuggestion);
    }
    return EXIT_ERROR;
  }
}

async function commandLogs(flags) {
  const result = readAgentLogTail({ env: process.env, lines: flags.lines });
  if (flags.json) {
    printJson(result);
  } else if (result.ok) {
    if (result.note) printError(result.note);
    process.stdout.write(result.lines.length ? `${result.lines.join("\n")}\n` : "The Agent log has no entries yet.\n");
  } else {
    printError(result.message || "The Agent log could not be read.");
  }
  return result.ok ? EXIT_OK : EXIT_ERROR;
}

async function commandDiagnostics(flags) {
  const client = createAgentCliClient();
  const serviceManager = createServiceManager();
  const [health, enrollment, pairing, service, logs] = await Promise.all([
    attempt(client.health()),
    attempt(client.enrollStatus()),
    attempt(client.pairingStatus()),
    attempt(Promise.resolve(serviceManager.status())),
    Promise.resolve(readAgentLogTail({ env: process.env, lines: 50 })),
  ]);
  const connection = client.resolveConnection();
  const healthBody = health?.body || null;
  const report = {
    generatedAt: new Date().toISOString(),
    tool: { name: "anxos-agent", version: getCurrentVersion() },
    agent: {
      reachable: Boolean(health?.ok),
      baseUrl: health?.baseUrl || connection.primary,
      version: healthBody?.identity?.agentVersion || null,
      identity: healthBody?.identity
        ? {
          deviceId: healthBody.identity.deviceId,
          hostname: healthBody.identity.hostname,
          platform: healthBody.identity.platform,
          operatingSystem: healthBody.identity.operatingSystem,
          architecture: healthBody.identity.architecture,
        }
        : null,
      health: healthBody
        ? {
          ok: healthBody.ok,
          mode: healthBody.mode,
          credentialConfigured: Boolean(healthBody.tokenConfigured),
          credentialFingerprint: healthBody.tokenFingerprint || null,
          process: healthBody.process || null,
        }
        : null,
      errorCode: health?.ok ? null : health?.code || "AGENT_UNREACHABLE",
    },
    enrollment: enrollment?.body ? { state: enrollment.body.state, enrollmentId: enrollment.body.enrollmentId || null } : null,
    pairing: pairing?.body ? { status: pairing.body.status } : null,
    service: service || null,
    log: { ok: logs.ok, path: logs.path, entries: logs.lines },
    connection: { mode: connection.mode, loopbackOnly: connection.loopbackOnly, credentialReadable: connection.token.readable },
    notes: [
      "This summary contains no credential material; fingerprints only.",
      ...(connection.notes || []),
    ],
  };
  const redacted = sanitizeForDiagnostics(report);
  if (flags.json) {
    printJson(redacted);
  } else {
    const lines = [];
    lines.push("AnxOS Agent diagnostics");
    lines.push("-----------------------");
    lines.push(`Generated:  ${redacted.generatedAt}`);
    lines.push(`Agent:      ${redacted.agent.reachable ? `reachable at ${redacted.agent.baseUrl}` : `unreachable (${redacted.agent.errorCode})`}`);
    lines.push(`Version:    ${redacted.agent.version || redacted.tool.version}`);
    lines.push(`Identity:   ${redacted.agent.identity?.deviceId || "unknown"} @ ${redacted.agent.identity?.hostname || "unknown"}`);
    lines.push(`Enrollment: ${redacted.enrollment?.state || "unknown"}`);
    lines.push(`Pairing:    ${redacted.pairing?.status || "unknown"}`);
    lines.push(`Service:    ${redacted.service?.supported === false ? "unsupported" : redacted.service?.mode === "none" ? "not installed" : `${redacted.service?.state || "unknown"} (${redacted.service?.mode || "unknown"} unit)`}`);
    lines.push(`Credential: ${redacted.agent.health?.credentialConfigured ? `configured (fingerprint ${redacted.agent.health?.credentialFingerprint || "unknown"})` : "not configured"}`);
    lines.push("");
    lines.push(`Log (${redacted.log.ok ? redacted.log.path : "unavailable"}):`);
    if (redacted.log.entries.length) lines.push(...redacted.log.entries.map((entry) => `  ${entry}`));
    else lines.push("  no entries");
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return EXIT_OK;
}

async function commandUpdate(flags) {
  if (!flags.check) {
    printError("`anxos-agent update` only supports --check. The CLI never downloads or installs updates automatically.");
    return EXIT_USAGE;
  }
  const result = await checkForUpdate({ env: process.env });
  if (flags.json) {
    printJson(result);
  } else {
    const lines = [];
    lines.push("AnxOS Agent update check");
    lines.push("------------------------");
    lines.push(`Runtime:  ${result.currentVersion}`);
    lines.push(`Package:  ${result.installedArtifactVersion ? `${result.installedArtifactVersion}${result.installedReleaseTag ? ` (${result.installedReleaseTag})` : ""}` : "development or source install"}`);
    lines.push(`Latest:   ${result.latestVersion || "unknown"}`);
    lines.push(`State:    ${result.state}${result.reason ? ` (${result.reason})` : ""}`);
    if (result.state === "update-available") {
      if (result.downloadUrl) lines.push(`Download: ${result.downloadUrl}`);
      if (result.checksumUrl) lines.push(`Checksum: ${result.checksumUrl}`);
      if (result.assetName) lines.push(`Install:  sudo apt install ./${result.assetName}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return EXIT_OK;
}

function promptYes(question) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^yes$/i.test(String(answer || "").trim()));
    });
  });
}

async function commandUnpair(flags) {
  if (!flags.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      printError("Refusing to unpair without confirmation in a non-interactive shell. Re-run with --yes after reviewing the effect:");
      printError("  This revokes the Agent enrollment and clears the stored credential. Instances, backups and configuration are preserved.");
      return EXIT_ERROR;
    }
    const confirmed = await promptYes("Revoke this Agent's enrollment and clear the stored credential? Instances, backups and configuration are preserved. Type yes to continue: ");
    if (!confirmed) {
      process.stdout.write("Unpair cancelled.\n");
      return EXIT_OK;
    }
  }

  const client = createAgentCliClient();
  const result = {
    revoked: false,
    enrollment: null,
    localCredentialCleared: false,
    configPath: null,
    dataPreserved: true,
    instancesPreserved: true,
    backupsPreserved: true,
  };

  try {
    const revoke = await client.revokeEnrollment({ reason: "cli-unpair" });
    result.revoked = revoke.body?.status === "revoked";
    result.enrollment = revoke.body || null;
  } catch (error) {
    if (error.code === "NO_ACTIVE_ENROLLMENT") {
      result.enrollment = { state: "not-enrolled" };
    } else {
      const hint = error.code === "UNAUTHORIZED" || error.code === "AGENT_TOKEN_MISSING"
        ? "The stored Agent credential could not be presented. Run this command with sudo, or revoke the enrollment from AnxOS Control Center."
        : "Verify that the Agent is running, then try again.";
      if (flags.json) printJson({ ok: false, code: error.code || "UNPAIR_FAILED", message: error.message, hint });
      else {
        printError(`Unpair failed: ${error.message}`);
        printError(hint);
      }
      return EXIT_ERROR;
    }
  }

  try {
    const configPath = resolveAgentConfigPath({ cwd: process.cwd(), configDir: process.env.ANXHUB_CONFIG_DIR });
    result.configPath = configPath;
    if (configPath && fs.existsSync(configPath)) {
      const config = readAgentConfigFile(configPath);
      if (trim(config.agentToken)) {
        writeAgentConfigToken(configPath, "", {});
        result.localCredentialCleared = true;
      } else {
        result.localCredentialCleared = false;
        result.localCredentialNote = "No stored credential was present.";
      }
    } else {
      result.localCredentialNote = "No stored Agent configuration was found.";
    }
  } catch (error) {
    result.localCredentialCleared = false;
    result.localCredentialError = error.code || "AGENT_CONFIG_UNREADABLE";
    if (flags.json) printJson({ ok: false, ...result });
    else printError(`The local credential could not be cleared: ${error.message}`);
    return EXIT_ERROR;
  }

  result.restartNote = "The running Agent keeps its current in-memory credential until it restarts.";
  if (flags.json) {
    printJson({ ok: true, ...result });
  } else {
    process.stdout.write([
      result.revoked ? "Enrollment revoked." : "No active enrollment was present.",
      result.localCredentialCleared ? "The stored Agent credential was cleared." : (result.localCredentialNote || "No stored credential was present."),
      "Instances, backups and configuration were preserved.",
      result.restartNote,
    ].join("\n") + "\n");
  }
  return EXIT_OK;
}

async function main(argv) {
  loadAgentEnvironment();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    printError(parsed.error);
    printError("Run `anxos-agent --help` for usage.");
    return EXIT_USAGE;
  }
  const { positionals, flags } = parsed;

  if (flags.version) {
    // Runtime and package are distinct identities: a packaged install reports
    // the stamped artifact version next to the runtime version, while a source
    // checkout keeps the single runtime version.
    const releaseIdentity = readAgentReleaseIdentity({ env: process.env });
    const runtimeVersion = getCurrentVersion();
    process.stdout.write(
      releaseIdentity?.artifactVersion
        ? `anxos-agent ${releaseIdentity.artifactVersion} (runtime ${runtimeVersion})\n`
        : `anxos-agent ${runtimeVersion}\n`,
    );
    return EXIT_OK;
  }
  if (flags.help || positionals[0] === "help") {
    process.stdout.write(HELP_TEXT);
    return EXIT_OK;
  }

  const command = positionals[0] || "";
  switch (command) {
    case "": {
      const automationRequested = Boolean(process.env.ANXOS_TUI_KEYS);
      if (automationRequested || (process.stdin.isTTY && process.stdout.isTTY)) {
        return runTui();
      }
      return commandStatus(flags);
    }
    case "status":
      return commandStatus(flags);
    case "pair":
      return commandPair(flags);
    case "service":
      return commandService(positionals, flags);
    case "logs":
      return commandLogs(flags);
    case "diagnostics":
      return commandDiagnostics(flags);
    case "update":
      return commandUpdate(flags);
    case "unpair":
      return commandUnpair(flags);
    default:
      printError(`Unknown command: ${command}`);
      printError("Run `anxos-agent --help` for usage.");
      return EXIT_USAGE;
  }
}

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    printError(error?.message || String(error));
    process.exitCode = EXIT_ERROR;
  });
