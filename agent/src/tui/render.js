"use strict";

// Pure screen builder for the Agent TUI. No I/O, no process access, no clock
// reads: everything comes from the state object and the {width, height, unicode}
// options, so the exact rendered text can be asserted in tests.
//
// Untrusted text (log lines, captured output, messages, errors) is sanitized
// before any width computation: C0/C1 control characters are stripped (TAB is
// kept) and complete CSI/OSC/escape sequences are removed, so a crafted log or
// future log source can never execute terminal control on the operator's TTY
// and never breaks width containment (clipping measures the text that is
// actually emitted).
//
// Layout contract: every view is assembled as a title, an optional rule, a
// protected core (content that must never disappear, such as the pairing code),
// droppable titled blocks, and a key bar/footer, and is then passed through
// composeScreen(). That single helper clips every line to the requested width
// and, when the content does not fit the requested height, hides whole blocks
// behind a visible "(hidden here: ...)" notice instead of dropping them.

const BIG_GLYPHS = {
  A: ["▄▀▄", "█▀█", "▀ ▀"],
  B: ["█▀▄", "█▀▄", "▀▀ "],
  C: ["▄▀▀", "█  ", "▀▀ "],
  D: ["█▀▄", "█ █", "▀▀ "],
  E: ["█▀▀", "█▀ ", "▀▀ "],
  F: ["█▀▀", "█▀ ", "▀  "],
  G: ["▄▀▀", "█ █", "▀▀ "],
  H: ["█ █", "█▀█", "▀ ▀"],
  J: ["  █", "  █", "▀▀ "],
  K: ["█ █", "█▀▄", "▀ ▀"],
  L: ["█  ", "█  ", "▀▀ "],
  M: ["█▄█", "█ █", "▀ ▀"],
  N: ["█▄▄", "█ █", "▀ ▀"],
  P: ["█▀▄", "█▀ ", "▀  "],
  Q: ["▄▀▄", "█ █", " ▀▀"],
  R: ["█▀▄", "█▀▄", "▀ ▀"],
  S: ["▄▀▀", "▀▀▄", "▀▀ "],
  T: ["▀█▀", " █ ", " ▀ "],
  U: ["█ █", "█ █", "▀▀▀"],
  V: ["█ █", "█ █", " ▀ "],
  W: ["█ █", "█▄█", "▀ ▀"],
  X: ["█ █", " ▄ ", "▀ ▀"],
  Y: ["█ █", " ▀ ", " ▀ "],
  Z: ["▀▀█", " ▄▀", "▀▀ "],
  2: ["▄▀▄", " ▄▀", "▀▀ "],
  3: ["▀▀▄", " ▀▄", "▀▀ "],
  4: ["█ █", "▀▀█", "  ▀"],
  5: ["█▀▀", "▀▀▄", "▀▀ "],
  6: ["▄▀▀", "█▀▄", "▀▀ "],
  7: ["▀▀█", "  █", "  ▀"],
  8: ["▄▀▄", "█▀█", "▀▀ "],
  9: ["▄▀▄", "▀▀█", "▀▀ "],
  "-": ["   ", "▀▀ ", "   "],
};

const KEY_BAR = [
  { key: "p", label: "pair" },
  { key: "r", label: "refresh" },
  { key: "s", label: "restart" },
  { key: "l", label: "logs" },
  { key: "u", label: "update" },
  { key: "?", label: "help" },
  { key: "q", label: "quit" },
];

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Complete sequences first (OSC before CSI), then any leftover ESC, then the
// remaining C0/C1 controls. TAB (0x09) is the only C0 control kept. Stripping
// the whole OSC/CSI sequence (not just the ESC byte) also removes a hostile
// payload such as an OSC-52 clipboard write from the rendered screen.
const OSC_SEQUENCE_PATTERN = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

function sanitizeText(value) {
  return String(value ?? "")
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(CSI_SEQUENCE_PATTERN, "")
    .replace(/\u001b/g, "")
    .replace(CONTROL_CHARACTER_PATTERN, "");
}

function clipText(text, width, unicode) {
  const value = sanitizeText(text);
  if (width <= 0) return "";
  if (value.length <= width) return value;
  const ellipsis = unicode === false ? "..." : "…";
  if (width <= ellipsis.length) return value.slice(0, width);
  return `${value.slice(0, width - ellipsis.length)}${ellipsis}`;
}

function wrapText(text, width, unicode) {
  const value = sanitizeText(text);
  if (width <= 0) return [value];
  const lines = [];
  let current = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const clipped = clipText(word, width, unicode);
    if (clipped !== word) {
      if (current) lines.push(current);
      current = "";
      lines.push(clipped);
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function padRight(text, width, unicode) {
  const clipped = clipText(text, width, unicode);
  return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let scaled = value;
  let unit = "B";
  for (const next of units) {
    if (scaled < 1024) break;
    scaled /= 1024;
    unit = next;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(decimals)} ${unit}`;
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(number >= 10 ? 0 : 1)}%` : "n/a";
}

function formatCountdown(expiresAt, nowMs) {
  const expiresAtMs = Date.parse(expiresAt || "");
  if (!Number.isFinite(expiresAtMs)) return "unknown";
  const remaining = expiresAtMs - (Number.isFinite(nowMs) ? nowMs : Date.now());
  if (remaining <= 0) return "expired";
  const totalSeconds = Math.floor(remaining / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatTime(isoValue) {
  const parsed = Date.parse(isoValue || "");
  if (!Number.isFinite(parsed)) return trim(isoValue) || "unknown";
  return new Date(parsed).toISOString().slice(11, 19);
}

function formatLogLine(line) {
  const text = sanitizeText(trim(line));
  if (!text.startsWith("{")) return text;
  try {
    const entry = JSON.parse(text);
    const severity = trim(entry.severity) || "info";
    const operation = trim(entry.operation) || "event";
    const message = trim(entry.message);
    // JSON escapes like \u001b become real control characters here, so the
    // formatted line is sanitized again before it can reach the screen.
    return sanitizeText(`${formatTime(entry.timestamp)} ${severity.padEnd(5)} ${operation} ${message}`.trimEnd());
  } catch {
    return text;
  }
}

function bigCodeLines(code, unicode) {
  const value = String(code || "").toUpperCase();
  if (!unicode || !value) return [];
  const glyphs = [];
  for (const character of value) {
    const glyph = BIG_GLYPHS[character];
    if (!glyph) return [];
    glyphs.push(glyph);
  }
  return [0, 1, 2].map((row) => glyphs.map((glyph) => glyph[row]).join(" "));
}

function ruleLine(width, unicode) {
  return (unicode ? "─" : "-").repeat(Math.max(0, width));
}

function section(title, lines) {
  return { title, lines: [`${title}`, ...lines] };
}

function formatServiceState(service) {
  if (!service) return "unavailable";
  if (!service.supported) return service.reason ? `unsupported (${service.reason})` : "unsupported";
  if (service.mode === "none") return "not installed";
  const mode = service.mode === "system" ? "system unit" : "user unit";
  const parts = [service.state || "unknown"];
  parts.push(service.enabled ? "enabled" : "disabled");
  return `${parts.join(", ")} (${mode})`;
}

// --- shared layout helper ---------------------------------------------------

// Clips every line to the requested width and fits the requested height. The
// title, core, and at least one foot line are kept; droppable blocks are picked
// by priority and any block that does not fit is named in the hidden-sections
// notice, so height truncation is never silent.
function composeScreen(options, view) {
  const unicode = options.unicode !== false;
  const width = options.width;
  const height = options.height;
  const clip = (text) => clipText(text, width, unicode);
  const prepare = (blocks) => (blocks || [])
    .filter((block) => block && Array.isArray(block.lines) && block.lines.length > 0)
    .map((block) => ({
      title: block.title,
      priority: Number.isFinite(block.priority) ? block.priority : 0,
      lines: block.lines.map(clip),
    }));

  const title = clip(view.title);
  const rule = clip(ruleLine(width, unicode));
  const lead = prepare(view.lead);
  const core = (view.core || []).map(clip);
  const blocks = prepare(view.blocks);
  const footSource = (view.foot || []).map(clip);

  const bodyLines = lead.reduce((count, block) => count + block.lines.length, 0)
    + blocks.reduce((count, block) => count + block.lines.length, 0);
  if (1 + 1 + bodyLines + core.length + footSource.length <= height) {
    return [title, rule, ...lead.flatMap((block) => block.lines), ...core, ...blocks.flatMap((block) => block.lines), ...footSource];
  }

  // The rule is decorative: drop it before anything with real content.
  const useRule = height >= 1 + 1 + core.length + 1 + 1;
  const headLength = 1 + (useRule ? 1 : 0) + core.length;

  let foot = footSource;
  const maxFoot = Math.max(1, height - headLength - 1);
  if (foot.length > maxFoot) {
    const withoutBlank = foot.filter((line, index) => !(index === 0 && line === ""));
    foot = withoutBlank.length > maxFoot ? withoutBlank.slice(0, maxFoot) : withoutBlank;
  }

  const budget = Math.max(0, height - headLength - foot.length - 1);
  const selection = [
    ...lead.map((block, index) => ({ block, index, group: 0 })),
    ...blocks.map((block, index) => ({ block, index, group: 1 })),
  ].sort((a, b) => b.block.priority - a.block.priority || a.group - b.group || a.index - b.index);

  const keptLead = new Array(lead.length).fill(false);
  const keptBlocks = new Array(blocks.length).fill(false);
  let remaining = budget;
  for (const entry of selection) {
    if (entry.block.lines.length <= remaining) {
      if (entry.group === 0) keptLead[entry.index] = true;
      else keptBlocks[entry.index] = true;
      remaining -= entry.block.lines.length;
    }
  }

  const hiddenTitles = [
    ...lead.filter((block, index) => !keptLead[index]).map((block) => block.title),
    ...blocks.filter((block, index) => !keptBlocks[index]).map((block) => block.title),
  ];

  const lines = [title];
  if (useRule) lines.push(rule);
  lead.forEach((block, index) => {
    if (keptLead[index]) lines.push(...block.lines);
  });
  lines.push(...core);
  blocks.forEach((block, index) => {
    if (keptBlocks[index]) lines.push(...block.lines);
  });
  if (hiddenTitles.length) {
    lines.push(clip(`  (hidden here: ${hiddenTitles.join(", ")} ${unicode ? "—" : "-"} resize taller)`));
  }
  lines.push(...foot);
  return lines.slice(0, Math.max(1, height));
}

// --- status view -------------------------------------------------------------

function buildAgentSection(state, options) {
  const connection = state.connection || {};
  const health = state.health || {};
  const identity = health.identity || {};
  const enrollment = state.enrollment || {};
  const pairingStatus = state.pairingStatus || {};
  const token = connection.token || {};
  const address = trim(state.effectiveBaseUrl || connection.primary) || "not resolved";
  const joiner = options.unicode === false ? "|" : "·";
  const lines = [];
  lines.push(`  State      ${formatServiceState(state.service)}`);
  lines.push(`  Version    ${trim(identity.agentVersion) || state.cliVersion || "unknown"}${identity.platform ? ` ${joiner} ${identity.platform} ${identity.architecture || ""}`.trimEnd() : ""}`);
  lines.push(`  Identity   ${trim(identity.deviceId) || "unavailable"}${identity.hostname ? ` @ ${identity.hostname}` : ""}`);
  const pairingText = state.pairing && state.pairing.status && state.pairing.status !== "idle"
    ? state.pairing.status
    : (pairingStatus.status || (enrollment.state ? `enrollment: ${enrollment.state}` : "unknown"));
  lines.push(`  Pairing    ${pairingText}`);
  lines.push(`  Address    ${address}`);
  lines.push(`  Credential ${token.readable ? `readable (fingerprint ${token.fingerprint || "unknown"})` : `not readable${token.errorCode ? ` (${token.errorCode})` : ""}`}`);
  return section("Agent", lines);
}

function buildSystemSection(state, options) {
  const system = state.system;
  if (!system) {
    return section("System", [`  ${state.systemError ? `unavailable (${state.systemError})` : "not loaded"}`]);
  }
  const cpu = system.cpu || {};
  const memory = system.memory || {};
  const disk = system.disk || {};
  const network = system.network;
  const joiner = options.unicode === false ? "|" : "·";
  const cpuLine = `${formatPercent(cpu.usagePercent)} ${joiner} ${cpu.cores || "?"} cores`;
  const memoryLine = `${formatBytes(memory.used)} / ${formatBytes(memory.total)} (${formatPercent(memory.percent)})`;
  const diskLine = disk.total
    ? `${formatBytes(disk.free)} free of ${formatBytes(disk.total)} (${formatPercent(disk.percent)} used${disk.mount ? `, ${disk.mount}` : ""})`
    : "unavailable";
  const networkLine = network === null || network === undefined
    ? "unavailable"
    : (network.downloadPerSecond !== undefined || network.uploadPerSecond !== undefined)
      ? `rx ${formatBytes(network.downloadPerSecond)}/s ${joiner} tx ${formatBytes(network.uploadPerSecond)}/s`
      : "unsupported";
  return section("System", [
    `  CPU        ${cpuLine}`,
    `  Memory     ${memoryLine}`,
    `  Disk       ${diskLine}`,
    `  Network    ${networkLine}`,
  ]);
}

function buildServiceSection(state, options) {
  const service = state.service;
  const lines = [`  Unit       ${formatServiceState(service)}`];
  if (service?.unitPath && options.width >= 72) {
    lines.push(`  Path       ${service.unitPath}`);
  }
  if (service && service.supported && service.mode === "system") {
    lines.push("  Note       Package-managed unit; use the system package manager for changes.");
  }
  return section("Service", lines);
}

function buildUpdateSection(state) {
  const update = state.update;
  if (!update) {
    return section("Update", [`  Current    ${state.cliVersion || "unknown"}`, "  Latest     not checked (press u)"]);
  }
  if (update.state === "update-available") {
    return section("Update", [
      `  Current    ${update.currentVersion}`,
      `  Latest     ${update.latestVersion} (update available)`,
      ...(update.downloadUrl ? [`  Download   ${update.downloadUrl}`] : []),
      ...(update.assetName ? [`  Install    sudo apt install ./${update.assetName}`] : []),
    ]);
  }
  if (update.state === "current") {
    return section("Update", [`  Current    ${update.currentVersion}`, `  Latest     ${update.latestVersion} (up to date)`]);
  }
  return section("Update", [
    `  Current    ${update.currentVersion || state.cliVersion || "unknown"}`,
    `  Latest     unknown`,
    ...(update.reason ? [`  Reason     ${update.reason}`] : []),
  ]);
}

function buildLogsSection(state) {
  const logs = state.logs;
  if (!logs) return section("Logs", ["  not loaded"]);
  if (!logs.ok) return section("Logs", [`  ${logs.message || "unavailable"}`]);
  const entries = Array.isArray(logs.lines) ? logs.lines : [];
  const tail = entries.slice(-4);
  if (!tail.length) return section("Logs", ["  no entries yet"]);
  return section("Logs", tail.map((line) => `  ${formatLogLine(line)}`));
}

function wrapKeyBar(items, options) {
  const separator = options.unicode ? " · " : " | ";
  const lines = [];
  let current = "";
  for (const item of items) {
    const candidate = current ? `${current}${separator}${item}` : item;
    if (candidate.length > options.width && current) {
      lines.push(current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function buildKeyBar(state, options) {
  const selected = Number.isInteger(state.selectedAction) ? state.selectedAction : -1;
  const items = KEY_BAR.map((item, index) => {
    const label = `${item.key} ${item.label}`;
    return index === selected ? `[${label}]` : label;
  });
  return wrapKeyBar(items, options);
}

function statusHeader(state, options) {
  const title = state.view === "logs"
    ? (options.unicode === false ? "AnxOS Agent - logs" : "AnxOS Agent — logs")
    : "AnxOS Agent";
  const hostname = trim(state.health?.identity?.hostname) || "";
  if (!hostname || options.width < title.length + hostname.length + 2) return title;
  return `${padRight(title, options.width - hostname.length - 1, options.unicode)} ${hostname}`;
}

function renderStatusView(state, options) {
  const blocks = [
    buildAgentSection(state, options),
    buildServiceSection(state, options),
    buildSystemSection(state, options),
    buildUpdateSection(state),
    buildLogsSection(state),
  ];
  if (state.message) {
    blocks.push({ title: "message", priority: 1, lines: ["", `  ${state.message}`] });
  }
  if (state.confirm) {
    blocks.push({
      title: "confirm",
      priority: 2,
      lines: ["", `  ${state.confirm.prompt}`, "  Press y to confirm, any other key to cancel."],
    });
  }
  return composeScreen(options, {
    title: statusHeader(state, options),
    blocks,
    foot: ["", ...buildKeyBar(state, options)],
  });
}

// --- pairing view ------------------------------------------------------------

// The full pairing code (friendly code + base64url payload carrying the Agent
// address) is the exact material a user pastes into Add Computer, so it is
// hard-wrapped at the terminal width without an ellipsis: normalizePairingCode
// strips whitespace on paste, so joining the fragments must reconstruct it
// byte for byte. It is never clipped and never silently dropped.
function wrapCodeFragments(code, width) {
  const value = sanitizeText(code);
  if (!value) return ["unknown"];
  const perLine = Math.max(1, width);
  const lines = [];
  for (let index = 0; index < value.length; index += perLine) {
    lines.push(value.slice(index, index + perLine));
  }
  return lines;
}

function pairingFullCode(pairing) {
  return trim(pairing.pairingCode) || trim(pairing.displayCode) || "unknown";
}

function pairingCodeBlockLines(pairing, options) {
  const labelLines = wrapText("Pairing code (paste into Add Computer):", options.width, options.unicode !== false);
  return [...labelLines, ...wrapCodeFragments(pairingFullCode(pairing), options.width)];
}

function pairingReferenceLine(pairing, options) {
  const value = trim(pairing.displayCode) || "unknown";
  const label = `  Reference code: ${value}`;
  if (label.length <= options.width) return label;
  return clipText(value, options.width, options.unicode !== false);
}

function pairingInstructionLines(options) {
  const text = "In AnxOS Control Center open Add Computer and paste the full pairing code above. "
    + "The code may wrap across lines; whitespace in the pasted code is ignored.";
  return wrapText(text, Math.max(1, options.width - 2), options.unicode !== false).map((line) => `  ${line}`);
}

function pairingStatusLines(state, options) {
  const pairing = state.pairing || {};
  const status = pairing.status || "idle";
  const countdown = formatCountdown(pairing.expiresAt, state.nowMs);
  if (status === "starting") return ["  Starting pairing session..."];
  if (status === "error") {
    const error = pairing.error || {};
    return [
      `  Pairing failed: ${error.message || "unknown error"}`,
      ...(error.hint ? [`  ${error.hint}`] : []),
    ];
  }
  if (status === "expired") {
    return ["  The pairing code expired.", "  Press p for a new code."];
  }
  if (status === "timeout") {
    return ["  Stopped waiting for the code to be used.", "  The code stays valid until it expires; press p for a new code."];
  }
  if (status === "cancelled") {
    return ["  The pairing session was cancelled.", "  Press p to start a new code."];
  }
  if (status === "paired") {
    return [
      "  Paired successfully.",
      "  The code was used by an AnxOS Control Center.",
      ...(pairing.tokenFingerprint ? [`  Agent credential fingerprint: ${pairing.tokenFingerprint}`] : []),
    ];
  }
  if (status === "waiting") {
    return [
      `  Expires in ${countdown}`,
      `  Agent address: ${pairing.agentUrl || state.effectiveBaseUrl || "unknown"}`,
    ];
  }
  return ["  No pairing session is active.", "  Press p to start one."];
}

function renderPairingView(state, options) {
  const pairing = state.pairing || {};
  const status = pairing.status || "idle";
  const lead = [];
  const core = [];
  const blocks = [];
  if (status === "waiting") {
    const art = bigCodeLines(pairing.displayCode, options.unicode !== false);
    if (art.length && art.every((row) => row.length + 2 <= options.width)) {
      lead.push({ title: "code card", priority: -1, lines: ["", ...art.map((row) => `  ${row}`), ""] });
    }
    // Protected-core rule: the full code is pinned in the core (never
    // droppable) whenever the title, the code block, the key bar, and a
    // possible hidden-sections notice still fit the height. On a terminal too
    // short for that, the short reference code stays protected instead and the
    // full code becomes the highest-priority block, so it is hidden only
    // behind the visible hidden-sections notice — never truncated or dropped
    // silently.
    const codeBlock = pairingCodeBlockLines(pairing, options);
    const referenceLine = pairingReferenceLine(pairing, options);
    if (1 + codeBlock.length + 2 <= options.height) {
      core.push(...codeBlock);
      blocks.push({ title: "reference code", priority: 2, lines: [referenceLine] });
    } else {
      core.push(referenceLine);
      blocks.push({ title: "pairing code", priority: 3, lines: codeBlock });
    }
    blocks.push({
      title: "pairing details",
      priority: 1,
      lines: pairingStatusLines(state, options),
    });
    blocks.push({
      title: "pairing instruction",
      priority: 1,
      lines: ["", ...pairingInstructionLines(options)],
    });
  } else {
    blocks.push({
      title: "pairing status",
      priority: 2,
      lines: pairingStatusLines(state, options),
    });
  }

  if (state.connection?.loopbackOnly) {
    const lines = [
      "",
      `  ! This Agent is only reachable on loopback (${state.connection.loopbackUrl}).`,
      "    Another computer cannot reach it until the Agent listens on a network address.",
    ];
    if (state.networkCandidate) {
      lines.push(`    Press n to allow network access on ${state.networkCandidate} (asks for confirmation first).`);
    } else {
      lines.push("    No non-internal network address was detected on this machine.");
    }
    blocks.push({ title: "connection", lines });
  } else if (state.connection?.reachableUrl) {
    blocks.push({ title: "connection", lines: ["", `  Reachable address: ${state.connection.reachableUrl}`] });
  }

  if (state.message) {
    blocks.push({ title: "message", priority: 1, lines: ["", `  ${state.message}`] });
  }
  if (state.confirm) {
    blocks.push({
      title: "confirm",
      priority: 2,
      lines: ["", `  ${state.confirm.prompt}`, "  Press y to confirm, any other key to cancel."],
    });
  }

  const items = ["esc back", "p new code", "q quit"];
  if (state.networkCandidate && state.connection?.loopbackOnly) items.splice(2, 0, "n allow network access");

  return composeScreen(options, {
    title: "Pair a computer",
    lead,
    core,
    blocks,
    foot: ["", ...wrapKeyBar(items, options)],
  });
}

// --- logs view ---------------------------------------------------------------

function renderLogsView(state, options) {
  const logs = state.logs || {};
  const entries = [`  ${logs.path || "unknown path"}`, ""];
  if (!logs.ok) {
    entries.push(`  ${logs.message || "unavailable"}`);
  } else if (!Array.isArray(logs.lines) || !logs.lines.length) {
    entries.push("  No log entries yet.");
  } else {
    entries.push(...logs.lines.slice(-4).map((line) => `  ${formatLogLine(line)}`));
  }
  const separator = options.unicode === false ? " | " : " · ";
  return composeScreen(options, {
    title: "Agent logs",
    blocks: [{ title: "log entries", lines: entries }],
    foot: ["", `  esc back${separator}r reload${separator}q quit`],
  });
}

// --- help view ---------------------------------------------------------------

function renderHelpView(state, options) {
  const separator = options.unicode === false ? " | " : " · ";
  return composeScreen(options, {
    title: options.unicode === false ? "AnxOS Agent - help" : "AnxOS Agent — help",
    blocks: [
      {
        title: "Keys",
        lines: [
          "",
          "  Keys",
          "    up/down or j/k   move through the action bar",
          "    enter            run the selected action",
          "    p                start a pairing session",
          "    r                refresh status",
          "    s                restart the Agent service (asks first)",
          "    l                open the Agent log",
          "    u                check for updates (read-only)",
          "    ? or h           this help",
          "    esc              back",
          "    q                quit",
        ],
      },
      {
        title: "Commands",
        lines: [
          "",
          "  Commands",
          "    anxos-agent status [--json]",
          "    anxos-agent pair [--json] [--wait] [--timeout <seconds>] [--cancel]",
          "    anxos-agent service status|start|stop|restart|install|uninstall [--json]",
          "    anxos-agent logs [--lines N] [--json]",
          "    anxos-agent diagnostics [--json]",
          "    anxos-agent update --check [--json]",
          "    anxos-agent unpair [--yes]",
        ],
      },
      {
        title: "Automation seam",
        lines: [
          "",
          "  Automation seam (tests only): set ANXOS_TUI_KEYS to a key sequence;",
          "  the TUI processes each key, renders after each, then exits with code 0.",
        ],
      },
    ],
    foot: ["", `  esc back${separator}q quit`],
  });
}

function renderScreen(state = {}, runtimeOptions = {}) {
  const width = Math.max(1, Number.parseInt(runtimeOptions.width || state.width, 10) || 80);
  const height = Math.max(4, Number.parseInt(runtimeOptions.height || state.height, 10) || 24);
  const unicode = runtimeOptions.unicode !== undefined
    ? runtimeOptions.unicode !== false
    : state.unicode !== false;
  const options = { width, height, unicode };
  if (state.view === "pairing") return renderPairingView(state, options).join("\n");
  if (state.view === "logs") return renderLogsView(state, options).join("\n");
  if (state.view === "help") return renderHelpView(state, options).join("\n");
  return renderStatusView(state, options).join("\n");
}

module.exports = {
  KEY_BAR,
  bigCodeLines,
  buildKeyBar,
  clipText,
  formatBytes,
  formatCountdown,
  formatLogLine,
  padRight,
  renderHelpView,
  renderLogsView,
  renderPairingView,
  renderScreen,
  renderStatusView,
  sanitizeText,
};