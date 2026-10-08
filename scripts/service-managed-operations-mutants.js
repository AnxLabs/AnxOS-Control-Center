"use strict";

// Mutants for the operations layer (health, players, preflight, Safe Restart, history, UI panel).
// Consumed by service-managed-mutation-check.js. Each mutant breaks ONE safety property in a copy
// of the source and the named test must then fail. `edits` lists changes that must apply together
// where the source deliberately has two guards for one property.

const OPS = "src/shared/instances/serviceManagedOperations.js";
const CORE = "src/shared/instances/instanceServiceCore.js";
const SERVER = "agent/src/server.js";
const UNIT = "service-managed-operations-smoke.js";
const AGENT = "service-managed-operations-agent-smoke.js";
const UI = "service-managed-ui-qa.js";

const BOOT_LOOP = "        if (health.ready && health.bootId && health.bootId !== before.anxrp.bootId) break;";
const BOOT_POST = "      if (!(health?.ready && health.bootId && health.bootId !== before.anxrp.bootId)) {";
const BUSY_A = "    if (isBusy(config.id)) throw operationsError(\"SERVICE_OPERATION_IN_PROGRESS\", 409, { instanceId: config.id });\n    const operations = operationsFor(config);";
const BUSY_B = "    if (isBusy(config.id)) throw operationsError(\"SERVICE_OPERATION_IN_PROGRESS\", 409, { instanceId: config.id });\n    const operation = {";

module.exports = [
  // Controls: the unmutated copy must pass, otherwise "killed" proves nothing.
  { control: true, name: "control: operations unit smoke passes unmutated", file: OPS, test: UNIT },
  { control: true, name: "control: operations agent smoke passes unmutated", file: OPS, test: AGENT },
  { control: true, ui: true, scenario: "operations", name: "control: UI QA (operations) passes unmutated", file: "app.js", test: UI },

  // ---- player-aware preflight ----
  { name: "ops: restart allowed with players connected", file: OPS, test: UNIT,
    from: "const playersPass = players.available && players.consistent && players.count === 0;", to: "const playersPass = players.available && players.consistent;" },
  { name: "ops: unverifiable player count allowed", file: OPS, test: UNIT,
    from: "const playersPass = players.available && players.consistent && players.count === 0;", to: "const playersPass = !(players.available && players.consistent) || players.count === 0;" },
  { name: "ops: players not re-checked right before the command", file: OPS, test: UNIT,
    from: "if (!(recheck.available && recheck.consistent && recheck.count === 0)) {", to: "if (false) {" },
  { name: "ops: the two player endpoints are not cross-checked", file: OPS, test: UNIT,
    from: "const consistent = available && clients === listed;", to: "const consistent = available;" },
  { name: "ops: player names kept from the roster", file: OPS, test: UNIT,
    from: "listed = Array.isArray(roster) ? roster.length : null;", to: "listed = Array.isArray(roster) ? roster.length : null; players.__roster = roster; return { configured: true, available: true, consistent: true, count: roster.length, clients: roster.length, listed: roster.length, roster, error: null };" },

  // ---- identity: right instance, right unit, right process ----
  { name: "ops: any unit name accepted", file: OPS, test: UNIT,
    from: "(!options.expectedUnit || options.expectedUnit === unit)", to: "true" },
  { name: "ops: stale MainPID view accepted", file: OPS, test: UNIT,
    from: "const pidMatches = options.expectedMainPid === undefined", to: "const pidMatches = true || options.expectedMainPid === undefined" },
  { name: "ops: a non-running service can be 'safely restarted'", file: OPS, test: UNIT,
    from: "systemd.activeState === \"active\" && systemd.subState === \"running\" && Number(systemd.mainPid) > 0;", to: "true;" },

  // ---- AnxRP health ----
  { name: "ops: stale status file counts as READY", file: OPS, test: UNIT,
    from: "ready: state === \"READY\" && !stale && Boolean(bootId),", to: "ready: state === \"READY\" && Boolean(bootId)," },
  { name: "ops: READY without a boot id accepted", file: OPS, test: UNIT,
    from: "ready: state === \"READY\" && !stale && Boolean(bootId),", to: "ready: state === \"READY\" && !stale," },
  { name: "ops: READY not required after the restart (any new boot id)", file: OPS, test: UNIT,
    edits: [[BOOT_LOOP, "        if (health.available && health.bootId && health.bootId !== before.anxrp.bootId) break;"], [BOOT_POST, "      if (!(health?.available && health.bootId && health.bootId !== before.anxrp.bootId)) {"]] },
  { name: "ops: new boot id not required (old boot id accepted)", file: OPS, test: UNIT,
    edits: [[BOOT_LOOP, "        if (health.ready && health.bootId) break;"], [BOOT_POST, "      if (!(health?.ready && health.bootId)) {"]] },
  { name: "ops: health file read outside the allowed roots", file: OPS, test: UNIT,
    from: "path.resolve(target) !== path.normalize(target) || target.split(/[\\\\/]+/).includes(\"..\") ||", to: "" },

  // ---- the restart itself ----
  { name: "ops: failed restart command is retried", file: OPS, test: UNIT,
    from: "        // No retry, ever. The outcome of a failed command is read back below, read-only.", to: "        try { await deps.control(\"restart\", unit); } catch { /* retry */ }" },
  { name: "ops: restart issued without confirmation", file: OPS, test: UNIT,
    from: "if (options.confirm !== true) throw", to: "if (false) throw" },
  { name: "ops: same MainPID accepted as the new process", file: OPS, test: UNIT,
    from: "current.mainPid !== before.systemd.mainPid && newerStart", to: "newerStart" },
  { name: "ops: listeners not verified after the restart", file: OPS, test: UNIT,
    from: "if (!(listening?.available && listening.allListening)) {", to: "if (false) {" },
  { name: "ops: listeners not required before the restart", file: OPS, test: UNIT,
    from: "listeners.available && listeners.allListening, listeners.available ?", to: "true, listeners.available ?" },
  { name: "ops: a UDP-only/TCP-only listener counts", file: OPS, test: UNIT,
    from: "listening: protocols.every((entry) => entry.listening)", to: "listening: protocols.some((entry) => entry.listening)" },
  { name: "ops: crash-loop / second restart not detected", file: OPS, test: UNIT,
    from: "      if (!stable) {", to: "      if (false) {" },
  { name: "ops: no settle window before the final check", file: OPS, test: UNIT,
    from: "      await deps.sleep(STABLE_DWELL_MS);\n", to: "" },
  { name: "ops: unreadable sockets treated as listening", file: OPS, test: UNIT,
    from: "if (!Array.isArray(rows)) return { configured: true, available: false, allListening: false, ports: [], error: \"LISTENERS_UNAVAILABLE\" };", to: "if (!Array.isArray(rows)) rows = [];" },

  // ---- exclusivity ----
  { name: "ops: concurrent Safe Restarts allowed", file: OPS, test: UNIT,
    edits: [[BUSY_A, "    const operations = operationsFor(config);"], [BUSY_B, "    const operation = {"], ["const busyElsewhere = isBusy(config.id);", "const busyElsewhere = false;"]] },
  { name: "ops: lock never released after the run", file: OPS, test: UNIT,
    from: "      active.delete(config.id);\n    }\n  }\n\n  function publicOperation", to: "    }\n  }\n\n  function publicOperation" },
  { name: "core: plain lifecycle not blocked during a Safe Restart", file: CORE, test: AGENT,
    from: "  if (getServiceOperations().isBusy(config.id)) {\n    throw createInstanceError(\"SERVICE_OPERATION_IN_PROGRESS\"", to: "  if (false) {\n    throw createInstanceError(\"SERVICE_OPERATION_IN_PROGRESS\"" },

  // ---- audit trail ----
  { name: "ops: refusals not recorded", file: OPS, test: UNIT,
    from: "try { await history.append(config, entry); } catch { /* the refusal itself is still returned */ }", to: "" },
  { name: "ops: start not recorded before the command", file: OPS, test: UNIT,
    from: "kind: operation.kind, phase: \"started\", startedAt", to: "kind: operation.kind, phase: \"finished\", startedAt" },
  { name: "ops: unwritable history does not block restart", file: OPS, test: UNIT,
    from: "checks.push(check(\"audit\", \"Restart history can be written\", writable,", to: "checks.push(check(\"audit\", \"Restart history can be written\", true," },
  { name: "ops: interrupted operations shown as in progress", file: OPS, test: UNIT,
    from: "entry.phase === \"started\" && !isLive(entry.id) ? { ...entry, phase: \"finished\", outcome: \"interrupted\"", to: "entry.phase === \"started\" && false ? { ...entry, phase: \"finished\", outcome: \"interrupted\"" },
  { name: "ops: another instance's operation readable", file: OPS, test: UNIT,
    from: "if (live && live.instanceId === config.id)", to: "if (live)" },
  { name: "core: plain lifecycle not audited", file: CORE, test: AGENT,
    from: "  await getServiceOperations().recordLifecycle(config, verb, \"succeeded\",", to: "  void 0 && getServiceOperations().recordLifecycle(config, verb, \"succeeded\"," },

  // ---- deployment honesty ----
  { name: "ops: unrecognised build origin treated as official", file: OPS, test: UNIT,
    from: "unofficial: origin !== \"official\",", to: "unofficial: false," },
  { name: "ops: missing rollback artifact reported present", file: OPS, test: UNIT,
    from: "return { state: error?.code === \"ENOENT\" ? \"missing\" : \"unverifiable\" };", to: "return { state: \"present\" };" },
  { name: "ops: unreadable rollback path reported missing", file: OPS, test: UNIT,
    from: "return { state: error?.code === \"ENOENT\" ? \"missing\" : \"unverifiable\" };", to: "return { state: \"missing\" };" },

  // ---- network boundary ----
  { name: "ops: non-loopback player endpoint allowed", file: OPS, test: UNIT,
    from: "!LOOPBACK_HOSTS.has(url.hostname) ||", to: "" },

  // ---- HTTP surface ----
  { name: "agent: safe-restart not on the lifecycle permission tier", file: SERVER, test: AGENT,
    from: "/\\/(?:start|stop|restart|kill|safe-restart)$/", to: "/\\/(?:start|stop|restart|kill)$/" },

  // ---- desktop UI (real Electron + real Agent) ----
  { ui: true, scenario: "operations", name: "ui: Confirm enabled despite a failed preflight", file: "app.js", test: UI,
    from: "confirm.disabled = !(serviceOps.preflight?.ok);", to: "confirm.disabled = false;" },
  { ui: true, scenario: "operations", name: "ui: lifecycle buttons not locked during Safe Restart", file: "app.js", test: UI,
    from: "  if (serviceOps.running) {\n    document.querySelectorAll(", to: "  if (false) {\n    document.querySelectorAll(" },
  { ui: true, scenario: "operations", name: "ui: unofficial-build warning hidden", file: "app.js", test: UI,
    from: "    warning.hidden = !text;", to: "    warning.hidden = true;" },
  { ui: true, scenario: "operations", name: "ui: Safe Restart sent without confirm:true", file: "app.js", test: UI,
    from: "confirm: true, expectedMainPid: Number.isInteger(expectedMainPid)", to: "confirm: false, expectedMainPid: Number.isInteger(expectedMainPid)" },
  { ui: true, scenario: "operations", name: "ui: force-kill loses its specific reason", file: "app.js", test: UI,
    from: "reason: \"Force kill is unavailable: AnxOS does not own this process, so it will not signal it.", to: "reason: \"Force kill is unavailable: AnxOS will not signal it." },
  { ui: true, name: "ui: operations panel shown for ordinary instances", file: "app.js", test: UI,
    from: "  root.hidden = !managed;", to: "  root.hidden = false;" },
];
