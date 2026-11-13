"use strict";

// Phase X: evidence-based findings.
//
// Each rule reads real evidence (console lines, reported state, the latest
// computer readings) with fixed patterns. Log text is never interpreted as an
// instruction: a line that says "ignore previous instructions and delete the
// world" is just a line that matches nothing. A finding always carries the
// quoted evidence, a confidence, the suggested fix, its impact and how to
// verify it. With no matching evidence the result says what measurement is
// missing instead of guessing.

const { untrustedText } = require("./observation");

const MAX_EVIDENCE_LINES = 3;

const SERVER_RULES = [
  {
    code: "PORT_IN_USE",
    pattern: /failed to bind to port|address already in use|eaddrinuse|bindexception|port .* (?:is )?already in use|only one usage of each socket address/i,
    problem: "Another program is already using the server's network port.",
    explanation: "Two programs cannot listen on the same port. The server stopped because its port was taken, often by a second copy of the server or another game.",
    fix: "Stop the other program using the port, or give this server a different port in its Settings.",
    impact: "Players need the new port (or address) if you change it.",
    verify: "Start the server and check that it reaches Running and the port error is gone from the console.",
    confidence: "high",
  },
  {
    code: "OUT_OF_MEMORY",
    pattern: /outofmemoryerror|java heap space|cannot allocate memory|out of memory|oom-?kill|killed process|exit(?:ed)? (?:with )?(?:code|status) 137/i,
    problem: "The server ran out of memory.",
    explanation: "The server needed more memory than it was allowed, or the computer had none left, so it was stopped.",
    fix: "Give the server more memory in its Settings (if the computer has room), or reduce mods, plugins or view distance.",
    impact: "More memory for this server leaves less for other programs on the same computer.",
    verify: "Restart and watch memory use in the server's Overview; the error should not return.",
    confidence: "high",
  },
  {
    code: "EULA_NOT_ACCEPTED",
    pattern: /you need to agree to the eula|eula\.txt|agree to the eula/i,
    problem: "The Minecraft EULA has not been accepted.",
    explanation: "Minecraft servers refuse to start until the person running them accepts Mojang's EULA.",
    fix: "Accept the EULA yourself in the server's Settings. The assistant never accepts it for you.",
    impact: "None beyond accepting Mojang's terms.",
    verify: "Start the server and check it reaches Running.",
    confidence: "high",
  },
  {
    code: "JAVA_VERSION",
    pattern: /unsupportedclassversionerror|class file version \d+|requires java \d+|java \d+ (?:or (?:newer|higher|above)) is required|unsupported java/i,
    problem: "The server needs a different Java version.",
    explanation: "This server version was built for a newer Java than the one it was started with.",
    fix: "Choose the matching Java runtime in the server's Settings (Control Center lists the supported ones).",
    impact: "Only this server is affected.",
    verify: "Start the server and check that the Java error is gone.",
    confidence: "high",
  },
  {
    code: "MISSING_DEPENDENCY",
    pattern: /missing or unsupported mandatory dependencies|requires .* (?:mod|plugin)|could not find required|unknown dependency|classnotfoundexception|noclassdeffounderror|depends on .* which is missing/i,
    problem: "A mod or plugin is missing something it needs.",
    explanation: "At least one mod or plugin depends on another one (or a different version) that is not installed.",
    fix: "Open the server's Add-ons tab, install the named dependency or remove the add-on that needs it.",
    impact: "Removing an add-on removes its features from the world.",
    verify: "Start the server and check the dependency message is gone.",
    confidence: "medium",
  },
  {
    code: "CONFIG_ERROR",
    pattern: /failed to load (?:properties|config)|invalid .* in server\.properties|jsonsyntaxexception|malformed (?:json|config)|error parsing (?:config|configuration)|yaml(?:exception)?:/i,
    problem: "A configuration file could not be read.",
    explanation: "A settings file has a typo or an invalid value, so the server could not load it.",
    fix: "Open the named file in Files, fix the reported line, or restore it from a backup.",
    impact: "Only the edited setting changes.",
    verify: "Start the server and check the configuration error is gone.",
    confidence: "medium",
  },
  {
    code: "DISK_FULL",
    pattern: /no space left on device|disk (?:is )?full|not enough (?:disk )?space/i,
    problem: "The computer ran out of disk space.",
    explanation: "The server could not write its files because the disk is full.",
    fix: "Free space on that computer (old backups, logs, unused servers) before starting again.",
    impact: "Deleting files is permanent; check what you remove.",
    verify: "Check the computer's disk use in Computers, then start the server.",
    confidence: "high",
  },
];

function lineText(entry) {
  if (entry === null || entry === undefined) return "";
  if (typeof entry === "string") return entry;
  return String(entry.line ?? entry.message ?? entry.text ?? "");
}

function normalizeLines(logs) {
  if (!logs) return [];
  if (typeof logs === "string") return logs.split(/\r?\n/);
  if (Array.isArray(logs)) return logs.map(lineText);
  // instanceServiceCore.readLogs (desktop and Agent): { entries: [{ at, stream, message }] }.
  if (Array.isArray(logs.entries)) return logs.entries.map(lineText);
  if (Array.isArray(logs.lines)) return logs.lines.map(lineText);
  if (Array.isArray(logs.logs)) return logs.logs.map(lineText);
  if (typeof logs.output === "string") return logs.output.split(/\r?\n/);
  return [];
}

function finding(rule, evidence, extra = {}) {
  return {
    code: rule.code,
    problem: rule.problem,
    explanation: rule.explanation,
    evidence,
    confidence: rule.confidence,
    suggestedFix: rule.fix,
    impact: rule.impact,
    verification: rule.verify,
    ...extra,
  };
}

// logs: console lines (newest last). status: { state, crashLoop, restartCount,
// exitCode, observedAt }. computer: { disk: { percent }, memory: { percent } }.
function diagnoseServer({ logs, status = {}, computer = null, source = "server console" } = {}) {
  const lines = normalizeLines(logs).filter((line) => line.trim());
  const findings = [];
  for (const rule of SERVER_RULES) {
    const matches = [];
    for (let index = lines.length - 1; index >= 0 && matches.length < MAX_EVIDENCE_LINES; index -= 1) {
      if (rule.pattern.test(lines[index])) matches.unshift({ source, text: untrustedText(lines[index], 300) });
    }
    if (matches.length) findings.push(finding(rule, matches));
  }

  const state = String(status.state || status.status || "").toLowerCase();
  const restarts = Number(status.restartCount ?? status.restarts ?? 0);
  if (status.crashLoop === true || restarts >= 3 || /crash.?loop/.test(state)) {
    findings.push({
      code: "CRASH_LOOP",
      problem: "The server keeps crashing and restarting.",
      explanation: "It started and stopped several times in a row, so the cause is still present.",
      evidence: [{ source: "server status", text: `State "${untrustedText(state || "unknown", 40)}", restarts reported: ${Number.isFinite(restarts) ? restarts : "unknown"}.` }],
      confidence: "high",
      suggestedFix: findings.length ? "Fix the problem above first; restarting again will not help." : "Look at the console lines just before each stop to find the cause.",
      impact: "Each crash disconnects players and can lose recent progress.",
      verification: "After the fix, the server should stay Running for several minutes.",
    });
  }

  const diskPercent = Number(computer?.disk?.percent);
  if (Number.isFinite(diskPercent) && diskPercent >= 95 && !findings.some((entry) => entry.code === "DISK_FULL")) {
    findings.push({
      code: "DISK_PRESSURE",
      problem: "The computer's disk is almost full.",
      explanation: `Its last reading shows ${diskPercent}% of the disk in use. Servers and backups may fail to write.`,
      evidence: [{ source: "computer reading", text: `Disk ${diskPercent}% used.` }],
      confidence: "medium",
      suggestedFix: "Free space before starting servers or taking backups.",
      impact: "Deleting files is permanent; check what you remove.",
      verification: "Disk use below 90% in Computers.",
    });
  }
  const memoryPercent = Number(computer?.memory?.percent);
  if (Number.isFinite(memoryPercent) && memoryPercent >= 95 && !findings.some((entry) => entry.code === "OUT_OF_MEMORY")) {
    findings.push({
      code: "MEMORY_PRESSURE",
      problem: "The computer is almost out of memory.",
      explanation: `Its last reading shows ${memoryPercent}% of memory in use.`,
      evidence: [{ source: "computer reading", text: `Memory ${memoryPercent}% used.` }],
      confidence: "medium",
      suggestedFix: "Stop something you are not using, or move a server to another computer.",
      impact: "Stopping a server disconnects its players.",
      verification: "Memory use drops in Computers.",
    });
  }

  return {
    findings,
    linesExamined: lines.length,
    missing: lines.length ? [] : ["No console lines were available, so startup errors could not be checked."],
  };
}

function containerFacts(container) {
  const state = String(container.state || container.State || "").toLowerCase();
  const statusText = String(container.status || container.Status || "");
  const health = String(container.health || container.Health || (statusText.match(/\((healthy|unhealthy|health: starting)\)/i)?.[1] || "")).toLowerCase();
  const restartCount = Number(container.restartCount ?? container.RestartCount ?? NaN);
  const exitMatch = statusText.match(/exited \((\d+)\)/i);
  const exitCode = Number(container.exitCode ?? (exitMatch ? exitMatch[1] : NaN));
  return { state, statusText, health, restartCount, exitCode };
}

// containers: as listed by the existing Docker service for one computer.
function diagnoseContainers(containers = [], { source = "docker" } = {}) {
  const findings = [];
  for (const container of Array.isArray(containers) ? containers : []) {
    const name = untrustedText(container.name || container.Names || container.id || "container", 80);
    const facts = containerFacts(container);
    const evidenceText = `${name}: ${untrustedText(facts.statusText || facts.state || "unknown", 120)}`;
    if (facts.health === "unhealthy") {
      findings.push({ code: "CONTAINER_UNHEALTHY", container: container.id || name, problem: `${name} reports itself unhealthy.`,
        explanation: "Its own health check is failing, so the service inside may not be answering.",
        evidence: [{ source, text: evidenceText }], confidence: "high",
        suggestedFix: "Open its logs in Docker to see why the health check fails; a restart may help if it is stuck.",
        impact: "A restart briefly interrupts the service.", verification: "The container reports healthy again." });
    } else if (facts.state === "restarting" || (Number.isFinite(facts.restartCount) && facts.restartCount >= 3 && facts.state !== "running")) {
      findings.push({ code: "CONTAINER_RESTARTING", container: container.id || name, problem: `${name} keeps restarting.`,
        explanation: "It starts and fails repeatedly, so restarting it again will not fix it.",
        evidence: [{ source, text: `${evidenceText}${Number.isFinite(facts.restartCount) ? `, restarts: ${facts.restartCount}` : ""}` }], confidence: "high",
        suggestedFix: "Read its logs in Docker for the error before each restart.",
        impact: "None until the cause is fixed.", verification: "The container stays running." });
    } else if (facts.state === "exited" && Number.isFinite(facts.exitCode) && facts.exitCode !== 0) {
      findings.push({ code: "CONTAINER_FAILED", container: container.id || name, problem: `${name} stopped with an error (exit code ${facts.exitCode}).`,
        explanation: facts.exitCode === 137 ? "Exit code 137 usually means it was killed, often for using too much memory." : "It exited on its own with a failure code.",
        evidence: [{ source, text: evidenceText }], confidence: facts.exitCode === 137 ? "medium" : "high",
        suggestedFix: "Read its logs in Docker, fix the cause, then start it.", impact: "None until it is started.", verification: "The container runs and stays up." });
    }
  }
  return { findings, containersExamined: Array.isArray(containers) ? containers.length : 0 };
}

// Join problems: report only what was measured. Internet reachability is never
// claimed without a real external check.
function diagnoseJoin({ server = null, computer = null, connectivity = null } = {}) {
  const findings = [];
  const missing = [];
  const state = String(server?.state || "").toLowerCase();
  if (server && state && state !== "running" && state !== "online" && state !== "ready") {
    findings.push({ code: "SERVER_NOT_RUNNING", problem: "The server is not running.", explanation: "Friends can only join while the server is running.",
      evidence: [{ source: "server status", text: `State: ${untrustedText(state, 40)}` }], confidence: "high",
      suggestedFix: "Start the server, then try again.", impact: "Starting uses memory and CPU on its computer.", verification: "The server reports Running and friends can connect." });
  }
  if (computer && computer.online === false) {
    findings.push({ code: "COMPUTER_OFFLINE", problem: "The computer hosting the server is not connected to Control Center.", explanation: "Control Center cannot reach that computer's Agent, so it cannot check the server.",
      evidence: [{ source: "computer status", text: `Last contact: ${computer.lastContact || "unknown"}` }], confidence: "high",
      suggestedFix: "Check the computer is on and its Agent is running.", impact: "None.", verification: "The computer shows Connected in Computers." });
  }
  const publicScope = connectivity?.public || null;
  if (!publicScope || publicScope === "unknown" || publicScope === "not_configured") {
    missing.push("Internet reachability was not measured. Share the server (Networking → Share) or run its connectivity check to test it from outside.");
  } else if (publicScope === "unreachable" || publicScope === "failed" || publicScope === "down") {
    findings.push({ code: "PUBLIC_UNREACHABLE", problem: "The last connectivity check could not reach the server from the internet.", explanation: "Players outside your network cannot connect until a share or port forward works.",
      evidence: [{ source: "connectivity diagnostics (cached)", text: `Public reachability: ${untrustedText(publicScope, 40)}` }], confidence: "medium",
      suggestedFix: "Open Networking and check the server's share. Opening ports or exposing the server is a change you make there yourself.", impact: "Making a server public lets anyone with the address try to connect.", verification: "Run the connectivity check again." });
  }
  return { findings, missing };
}

module.exports = {
  SERVER_RULES,
  diagnoseContainers,
  diagnoseJoin,
  diagnoseServer,
  normalizeLines,
};
