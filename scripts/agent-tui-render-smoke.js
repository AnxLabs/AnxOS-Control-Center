#!/usr/bin/env node
// Headless Agent TUI renderer smoke (pure, no I/O).
//
// Renders every view (status, pairing, logs, help) across widths
// 32/40/80/120/200 and heights 8/12/24/50 and asserts as hard guarantees:
//   - no view throws;
//   - the output contains no ANSI escapes;
//   - EVERY ANSI-stripped line fits the requested width at every size, because
//     the renderer clips or word-wraps every line itself (headers, rules,
//     section lines, notices, messages, confirms, key bar, logs);
//   - whenever a view needs more lines than the terminal height, the visible
//     "(hidden here: ...)" notice is kept instead of dropping content silently;
//   - the status view exposes Agent/System/Service sections on a tall terminal
//     and the hidden-sections notice on a short one, including 30x8 and 20x6;
//   - the pairing view shows the FULL pairing code (the value Add Computer
//     accepts) as width-bounded wrapped fragments that reconstruct exactly
//     after whitespace stripping, plus the short reference code, wherever the
//     terminal can fit it; at narrow/short sizes the reference code stays in
//     the protected core and the hidden-sections notice names the full-code
//     block, so it is never silently dropped;
//   - the pairing view degrades to the compact layout when the card art does
//     not fit the width, keeping the full code and the Add Computer label at
//     40x12, and keeping the reference code + key bar at tiny sizes;
//   - unicode:false degrades the card art to ASCII and emits ASCII only;
//   - hostile terminal control sequences (OSC-52 clipboard writes, CSI clears)
//     embedded in logs, messages, paths, and confirm prompts are stripped with
//     all other C0/C1 controls, so no raw ESC can reach the TTY and the
//     sanitized text stays width-contained.
"use strict";

const assert = require("assert");

const {
  bigCodeLines,
  formatLogLine,
  renderScreen,
  renderHelpView,
  renderLogsView,
  renderPairingView,
  renderStatusView,
  sanitizeText,
} = require("../agent/src/tui/render");

const WIDTHS = [32, 40, 80, 120, 200];
const HEIGHTS = [8, 12, 24, 50];
const VIEWS = ["status", "pairing", "logs", "help"];

// The full pairing code is what Control Center's Add Computer accepts; the
// renderer must show it as wrapped, width-contained fragments that reconstruct
// exactly (normalizePairingCode strips whitespace on paste).
const TUI_FULL_PAIRING_CODE = (() => {
  const payload = {
    type: "anxos-agent-temporary-pairing",
    version: 1,
    code: "ANX-4K7P-92DM-QW3Z",
    agentUrl: "http://127.0.0.1:47131",
    issuedAt: "2026-09-25T18:50:00.000Z",
    expiresAt: "2026-09-25T19:00:00.000Z",
  };
  return `ANX-4K7P-92DM-QW3Z.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
})();

const compactState = {
  view: "status",
  connection: { primary: "http://127.0.0.1:47131", loopbackUrl: "http://127.0.0.1:47131", loopbackOnly: true, token: { readable: true, fingerprint: "abc4" } },
  health: { identity: { agentVersion: "0.1.0", deviceId: "enr-1", hostname: "host" }, tokenConfigured: true, tokenFingerprint: "abc4" },
  enrollment: { state: "enrolled" },
  pairingStatus: { status: "not_paired" },
  service: { supported: true, mode: "user", state: "active", enabled: true, unitPath: "/x/anxos-agent.service" },
  system: { cpu: { usagePercent: 0, cores: 1 }, memory: { used: 0, total: 1, percent: 0 }, disk: { free: 0, total: 1, percent: 0 }, network: { downloadPerSecond: 0, uploadPerSecond: 0 } },
  logs: { ok: true, path: "/tmp/agent.log", lines: ['{"severity":"info","operation":"startup","message":"ready"}'] },
  pairing: { status: "waiting", displayCode: "ANX-4K7P-92DM-QW3Z", pairingCode: TUI_FULL_PAIRING_CODE, expiresAt: "2026-09-25T19:00:00.000Z", agentUrl: "http://127.0.0.1:47131" },
  nowMs: Date.parse("2026-09-25T18:50:00.000Z"),
  cliVersion: "0.1.0",
  update: { state: "current", currentVersion: "0.1.0", latestVersion: "0.1.0" },
};

const fullState = {
  ...compactState,
  connection: { primary: "http://127.0.0.1:47131", loopbackUrl: "http://127.0.0.1:47131", loopbackOnly: false, reachableUrl: "http://192.168.1.50:47131", token: { readable: true, fingerprint: "abcdef123456" } },
  health: { identity: { agentVersion: "0.1.0", deviceId: "3f2b6c2e-9a1d-4c3e-8f10-1234567890ab", hostname: "my-long-hostname", platform: "linux", architecture: "x64" }, tokenConfigured: true, tokenFingerprint: "abcdef123456" },
  service: { supported: true, mode: "system", state: "active", enabled: true, unitPath: "/lib/systemd/system/anxos-agent.service" },
  message: "Status refreshed.",
};

const deepLogState = {
  ...fullState,
  logs: {
    ok: true,
    path: "/var/log/anxos-agent/agent.log",
    lines: Array.from({ length: 40 }, (_, index) => JSON.stringify({
      timestamp: "2026-09-25T18:50:00.000Z",
      severity: index % 7 === 0 ? "error" : "info",
      operation: "tick",
      message: `entry ${index + 1} with a reasonably long message body`,
    })),
  },
};

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "");
}

function renderView(view, state, width, height, unicode = true) {
  return renderScreen({ ...state, view }, { width, height, unicode });
}

function overflowLines(text, width) {
  return stripAnsi(text).split("\n").filter((line) => line.length > width);
}

function assertNoAnsi(text, label) {
  assert.strictEqual(stripAnsi(text), text, `${label} must not emit ANSI escapes (the renderer is pure text).`);
}

function assertContained(text, width, label) {
  const overflow = overflowLines(text, width);
  assert.deepStrictEqual(overflow, [], `${label} must not exceed width ${width}; overflow: ${JSON.stringify(overflow.slice(0, 2))}`);
}

// Joins the pairing-code fragment lines that follow the "Pairing code (paste
// into Add Computer):" label. Whitespace is what normalizePairingCode strips on
// paste, so the joined fragments must equal the code exactly. Returns "" when
// the label (or the full code) is not rendered at this size.
function reconstructWrappedCode(text) {
  const lines = String(text).split("\n");
  const label = lines.findIndex((line) => line.includes("Pairing code (paste"));
  if (label === -1) return "";
  const start = lines.findIndex((line, index) => index > label && /^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}\./.test(line.trim()));
  if (start === -1) return "";
  let code = "";
  for (let index = start; index < lines.length; index += 1) {
    const fragment = lines[index].trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(fragment)) break;
    // A bare friendly code is the compact "Reference code" line at widths too
    // narrow for its label, not a fragment of the full code.
    if (code && /^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(fragment)) break;
    code += fragment;
  }
  return code;
}

function main() {
  // --- every view renders at every size, ANSI-free and width-contained ------
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      for (const view of VIEWS) {
        for (const state of [compactState, fullState, deepLogState]) {
          const label = `${view} view at ${width}x${height}`;
          const text = renderView(view, state, width, height);
          assertNoAnsi(text, label);
          assertContained(text, width, label);
          assert(text.split("\n").length <= height, `${label} must not render more lines than requested.`);
        }
      }
    }
  }

  // --- the layout surfaces (header, rule, key bar) are contained ------------
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      const fullLines = renderView("status", fullState, width, height).split("\n");
      assert(fullLines[0].length <= width, `the status header must be clipped to ${width}.`);
      assert(fullLines[1].length <= width, `the status rule must fit ${width}.`);
      for (const barLine of fullLines.slice(-3)) {
        assert(barLine.length <= width, `the key bar must wrap within ${width}: ${JSON.stringify(barLine)}`);
      }
    }
  }

  // --- status/logs stay contained with bounded values at every size ---------
  for (const width of WIDTHS) {
    assertContained(renderView("status", compactState, width, 50), width, `compact status at ${width}x50`);
    assertContained(renderView("logs", compactState, width, 50), width, `compact logs at ${width}x50`);
    assertContained(renderView("logs", compactState, width, 8), width, `compact logs at ${width}x8`);
  }
  for (const width of [80, 120, 200]) {
    assertContained(renderView("status", compactState, width, 8), width, `compact status at ${width}x8`);
  }

  // --- widths >= 80 contain every view even with long real values -----------
  for (const width of [80, 120, 200]) {
    for (const height of HEIGHTS) {
      for (const view of VIEWS) {
        assertContained(renderView(view, fullState, width, height), width, `full ${view} at ${width}x${height}`);
      }
    }
  }

  // --- the hidden-sections notice is kept whenever content is truncated -----
  // A view is truncated when its full render needs more lines than the
  // terminal height; truncation must always surface the notice, and a view
  // that fits must not claim hidden content.
  const truncatedViews = new Set();
  for (const width of WIDTHS) {
    for (const height of [8, 12]) {
      for (const view of VIEWS) {
        const label = `${view} view at ${width}x${height}`;
        const full = renderView(view, deepLogState, width, 500);
        const small = renderView(view, deepLogState, width, height);
        assert(small.split("\n").length <= height, `${label} must fit the requested height.`);
        if (full.split("\n").length > height) {
          assert(small.includes("(hidden here:"), `${label} truncates content but must keep the hidden-sections notice.`);
          truncatedViews.add(view);
        } else {
          assert(!small.includes("(hidden here:"), `${label} fits all content and must not claim hidden sections.`);
        }
      }
    }
  }
  assert.deepStrictEqual([...truncatedViews].sort(), [...VIEWS].sort(), "every view must be exercised for the hidden-sections notice at a small height.");

  // --- status sections and the short-terminal degradation -------------------
  const tall = renderView("status", fullState, 120, 40);
  for (const title of ["Agent", "System", "Service"]) {
    assert(new RegExp(`^${title}$`, "m").test(tall), `the tall status view must render the ${title} section.`);
  }
  const short = renderView("status", fullState, 120, 12);
  assert(short.includes("(hidden here:"), "a short terminal must say which sections are hidden instead of silently dropping them.");
  assert(short.includes("Agent"), "the hidden-sections notice must name the hidden sections.");
  const eightRows = renderView("status", fullState, 120, 8);
  assert(eightRows.includes("(hidden here:"), "at 8 rows the hidden-sections notice must stay visible instead of being dropped by the key-bar fitting.");
  assert(eightRows.split("\n").length <= 8, "the 8-row status view must not exceed the requested height.");

  // --- minimal terminals never crash, stay contained, and keep the notices --
  for (const [width, height] of [[30, 8], [20, 6]]) {
    const label = `${width}x${height}`;
    let tinyStatus = "";
    assert.doesNotThrow(() => { tinyStatus = renderView("status", fullState, width, height); }, `a ${label} status view must not throw.`);
    assert(tinyStatus.length > 0, `a ${label} terminal must still render something.`);
    assert(tinyStatus.includes("AnxOS Agent"), `a ${label} terminal must still render the header.`);
    assert(tinyStatus.includes("(hidden here:"), `a ${label} status view must keep the hidden-sections notice.`);
    assertContained(tinyStatus, width, `status at ${label}`);

    let tinyPairing = "";
    assert.doesNotThrow(() => { tinyPairing = renderView("pairing", fullState, width, height); }, `a ${label} pairing view must not throw.`);
    assert(tinyPairing.includes("Pair a computer"), `a ${label} pairing view must still render the header.`);
    assert(/ANX-4K7P/.test(tinyPairing), `a ${label} pairing view must keep the pairing code visible.`);
    assert(/(esc back|p new code|q quit)/.test(tinyPairing), `a ${label} pairing view must keep the key bar visible.`);
    assertContained(tinyPairing, width, `pairing at ${label}`);
  }

  // --- pairing view content: the full code, wrapped and reconstructable ----
  const pairing = renderView("pairing", fullState, 120, 40);
  assert(pairing.includes("Pair a computer"), "the pairing view must have a header.");
  assert(pairing.includes("Pairing code (paste into Add Computer):"), "the pairing view must label the full pairing code as the code to paste.");
  assert.strictEqual(reconstructWrappedCode(pairing), TUI_FULL_PAIRING_CODE, "the 120x40 pairing view must show the full pairing code (wrapped fragments must reconstruct it exactly).");
  assert(pairing.includes("Reference code: ANX-4K7P-92DM-QW3Z"), "the pairing view must show the short reference code.");
  assert(pairing.includes("Expires in"), "the pairing view must show the expiry countdown.");
  assert(pairing.includes("In AnxOS Control Center open Add Computer and paste the full pairing code above."), "the pairing view must show the Add Computer paste instruction.");
  assert(bigCodeLines("ANX-4K7P", true).length === 3, "the unicode card art must be available for a valid code.");

  // --- wherever the full code fits, the view must keep it whole ------------
  // The code is protected-core whenever the title, the wrapped block, the key
  // bar, and a possible hidden-sections notice fit the height; on a terminal
  // too short for that the notice names the hidden full-code block instead.
  const fullCodeSizes = [
    [32, 24], [32, 50],
    [40, 12], [40, 24], [40, 50],
    [80, 8], [80, 12], [80, 24], [80, 50],
    [120, 8], [120, 12], [120, 24], [120, 50],
    [200, 8], [200, 12], [200, 24], [200, 50],
  ];
  for (const [width, height] of fullCodeSizes) {
    const text = renderView("pairing", compactState, width, height);
    assert.strictEqual(
      reconstructWrappedCode(text),
      TUI_FULL_PAIRING_CODE,
      `the ${width}x${height} pairing view must show the full pairing code, wrapped but reconstructable.`,
    );
    assertContained(text, width, `pairing at ${width}x${height}`);
  }

  // --- narrow/short terminals keep the reference code and name what is hidden -
  for (const [width, height] of [[32, 8], [32, 12], [40, 8]]) {
    const text = renderView("pairing", compactState, width, height);
    assert(text.includes("ANX-4K7P-92DM-QW3Z"), `the ${width}x${height} pairing view must keep the short reference code visible.`);
    assert(text.includes("(hidden here:") && text.includes("pairing code"), `the ${width}x${height} pairing view must name the hidden full-code block in the notice.`);
    assert(/(esc back|p new code|q quit)/.test(text), `the ${width}x${height} pairing view must keep the key bar visible.`);
    assertContained(text, width, `pairing at ${width}x${height}`);
  }

  // --- pairing degrades to the compact layout when the art does not fit -----
  for (const state of [compactState, fullState]) {
    const compactPairing = renderView("pairing", state, 40, 12);
    assert(compactPairing.includes("Pairing code (paste into Add Computer):"), "the 40x12 pairing view must label the code to paste.");
    assert.strictEqual(reconstructWrappedCode(compactPairing), TUI_FULL_PAIRING_CODE, "the 40x12 pairing view must keep the full pairing code, wrapped but reconstructable.");
    assert(compactPairing.includes("Add Computer"), "the 40x12 pairing view must show the Add Computer instruction.");
    assert(compactPairing.includes("(hidden here:"), "the 40x12 pairing view must name the sections it cannot fit.");
    assert(!compactPairing.includes("▄"), "the 40x12 pairing view must drop the oversized card art.");
    assertContained(compactPairing, 40, "compact pairing at 40x12");
  }

  // --- ASCII degradation ----------------------------------------------------
  assert.deepStrictEqual(bigCodeLines("ANX-4K7P", false), [], "unicode:false must drop the card art instead of mangling glyphs.");
  for (const width of WIDTHS) {
    for (const height of [8, 24, 50]) {
      for (const view of VIEWS) {
        const ascii = renderView(view, fullState, width, height, false);
        const label = `ascii ${view} at ${width}x${height}`;
        assert(!/[^\x00-\x7F]/.test(ascii), `${label} must be ASCII only when unicode:false.`);
        assertContained(ascii, width, label);
      }
    }
  }
  const asciiPairing = renderView("pairing", fullState, 120, 40, false);
  assert(asciiPairing.includes("Pairing code (paste into Add Computer):"), "the ASCII pairing view must label the full code as the code to paste.");
  assert.strictEqual(reconstructWrappedCode(asciiPairing), TUI_FULL_PAIRING_CODE, "the ASCII pairing view must still show the full pairing code, wrapped but reconstructable.");
  assert(asciiPairing.includes("Expires in"), "the ASCII pairing view must still show the expiry.");
  assert(asciiPairing.includes("Add Computer"), "the ASCII pairing view must still show the Add Computer instruction.");
  assert(!/[▄▀█─…·—]/.test(asciiPairing), "the ASCII pairing view must not contain unicode card glyphs or separators.");
  const asciiStatus = renderView("status", fullState, 120, 40, false);
  assert(asciiStatus.includes("|"), "the ASCII status view must use an ASCII separator.");
  assert(!/[─·…—▄▀█]/.test(asciiStatus), "the ASCII status view must not contain unicode glyphs.");
  const asciiHelp = renderView("help", fullState, 120, 40, false);
  assert(!/[─·…—]/.test(asciiHelp), "the ASCII help view must not contain unicode glyphs.");

  // --- direct view functions agree with renderScreen ------------------------
  assert.strictEqual(renderStatusView(compactState, { width: 80, height: 24, unicode: true }).join("\n"), renderScreen({ ...compactState, view: "status" }, { width: 80, height: 24, unicode: true }), "renderStatusView must match renderScreen for the status view.");
  assert.strictEqual(renderPairingView({ ...compactState, view: "pairing" }, { width: 80, height: 24, unicode: true }).join("\n"), renderScreen({ ...compactState, view: "pairing" }, { width: 80, height: 24, unicode: true }), "renderPairingView must match renderScreen for the pairing view.");
  assert.strictEqual(renderLogsView({ ...compactState, view: "logs" }, { width: 80, height: 24, unicode: true }).join("\n"), renderScreen({ ...compactState, view: "logs" }, { width: 80, height: 24, unicode: true }), "renderLogsView must match renderScreen for the logs view.");
  assert.strictEqual(renderHelpView({ ...compactState, view: "help" }, { width: 80, height: 24, unicode: true }).join("\n"), renderScreen({ ...compactState, view: "help" }, { width: 80, height: 24, unicode: true }), "renderHelpView must match renderScreen for the help view.");

  // --- hostile terminal control sequences are stripped, never emitted ------
  // A log source or crafted message could carry ESC/CSI/OSC; the renderer must
  // strip them BEFORE width computation (containment) and must not pass the
  // payload through (an OSC-52 write would reach the operator's clipboard).
  const OSC52_PAYLOAD = Buffer.from("clipboard-secret", "utf8").toString("base64");
  const OSC52_CLIPBOARD = `\u001b]52;c;${OSC52_PAYLOAD}\u0007`;
  const CSI_CLEAR = "\u001b[2J\u001b[H";
  const HOSTILE_TEXT = `before ${CSI_CLEAR} middle ${OSC52_CLIPBOARD} after`;
  const hostileState = {
    ...fullState,
    message: HOSTILE_TEXT,
    logs: {
      ok: true,
      path: `/tmp/agent${CSI_CLEAR}.log`,
      lines: [
        `raw ${CSI_CLEAR} line ${OSC52_CLIPBOARD} end`,
        JSON.stringify({
          timestamp: "2026-09-25T18:50:00.000Z",
          severity: "error",
          operation: "inject",
          message: HOSTILE_TEXT,
        }),
      ],
    },
    confirm: { prompt: `Proceed ${CSI_CLEAR}?` },
  };
  const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
  for (const view of ["status", "logs"]) {
    for (const width of [40, 80, 120]) {
      const text = renderView(view, hostileState, width, 40);
      assert(!text.includes("\u001b"), `hostile ${view} at ${width} must not emit a raw ESC byte.`);
      assert(!FORBIDDEN_CONTROLS.test(text), `hostile ${view} at ${width} must not emit terminal control characters.`);
      assert(!text.includes(OSC52_PAYLOAD), `hostile ${view} at ${width} must strip the OSC-52 payload instead of rendering it.`);
      assertContained(text, width, `hostile ${view} at ${width}`);
    }
  }
  const hostileTall = renderView("status", hostileState, 120, 40);
  assert(hostileTall.includes("before") && hostileTall.includes("middle") && hostileTall.includes("after"), "legitimate content around a stripped sequence must survive.");
  assert(hostileTall.includes("Proceed") && hostileTall.includes("?"), "the confirm prompt must survive sequence stripping.");
  const hostileLogs = renderView("logs", hostileState, 120, 40);
  assert(hostileLogs.includes("raw") && hostileLogs.includes("end"), "captured log output around a stripped sequence must survive.");
  assert.strictEqual(sanitizeText(`a\u001b[2Jb\u0007c`), "abc", "sanitizeText must strip CSI sequences and control characters.");
  assert.strictEqual(sanitizeText("keep\ttabs\nhere"), "keep\ttabshere", "sanitizeText must keep TAB and strip other C0 controls.");
  assert(!formatLogLine(`plain ${CSI_CLEAR} line`).includes("\u001b"), "formatLogLine must strip sequences from raw lines.");
  assert(
    !formatLogLine(JSON.stringify({ timestamp: "2026-09-25T18:50:00.000Z", severity: "warn", operation: "x", message: `m ${OSC52_CLIPBOARD}` })).includes("\u001b"),
    "formatLogLine must strip sequences decoded from JSON log lines.",
  );

  console.log("agent:tui:smoke passed — 5 widths x 4 heights x 4 views, hard width/height containment, hidden-sections notice, compact pairing, ASCII degradation, and hostile control-sequence stripping");
}

main();