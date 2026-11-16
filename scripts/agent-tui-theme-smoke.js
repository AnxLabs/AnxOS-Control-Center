#!/usr/bin/env node
// Colors on the headless Agent terminal screen (agent/src/tui/theme.js).
//   T1 coloring never changes a character: stripping the color codes gives
//      back exactly what render.js produced, for every view and both widths
//   T2 only color (SGR) codes are added; hostile control text in a log line
//      stays removed by render.js and is not brought back
//   T3 color is off for NO_COLOR, TERM=dumb, ANXOS_TUI_COLOR=0 and non-TTY
//   T4 the title, headings, keys and state words are actually colored
const assert = require("assert");
const { renderScreen } = require("../agent/src/tui/render");
const { colorEnabled, colorizeScreen, stripAnsi } = require("../agent/src/tui/theme");

const baseState = {
  view: "status",
  health: { ok: true, identity: { hostname: "anxlab", agentArtifactVersion: "2.0-build213" } },
  service: { supported: true, mode: "system", state: "active", enabled: true },
  system: { cpu: { usagePercent: 12 }, memory: { total: 16e9, used: 5e9, percent: 31 }, disk: { total: 4e11, used: 1e11, percent: 25 } },
  update: { state: "update-available", currentVersion: "2.0-build212", latestVersion: "2.0-build213" },
  logs: { ok: true, entries: [{ at: "2026-11-16T12:00:00Z", level: "error", message: "boom \u001b]52;c;ZXZpbA==\u0007 \u001b[31mred\u001b[0m failed" }] },
  selectedAction: 1,
};
const views = [
  baseState,
  { ...baseState, view: "logs" },
  { ...baseState, view: "help" },
  { ...baseState, view: "pairing", pairing: { code: "AB2-CD3", fullCode: "AB2-CD3.eyJhIjoiaHR0cDovLzEwLjAuMC41OjQ3MTMxIn0", expiresAt: "2026-11-16T12:10:00Z" }, nowMs: Date.parse("2026-11-16T12:00:00Z") },
];

for (const [width, unicode] of [[100, true], [60, false]]) {
  for (const state of views) {
    const plain = renderScreen(state, { width, height: 40, unicode });
    const painted = colorizeScreen(plain, { env: { COLORTERM: "truecolor" } });
    // T1
    assert.strictEqual(stripAnsi(painted), plain, `${state.view} at ${width}: color changed the text`);
    // T2
    const withoutSgr = painted.replace(/\u001b\[[0-9;]*m/g, "");
    assert(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(withoutSgr), `${state.view}: a control character other than color reached the screen`);
    assert(!/52;c;/.test(painted), "an OSC-52 clipboard payload never reaches the screen");
  }
}
console.log("  ok T1 color never changes the text");
console.log("  ok T2 only color codes are added");

// T3
assert.strictEqual(colorEnabled({}, { isTTY: true }), true);
assert.strictEqual(colorEnabled({ NO_COLOR: "1" }, { isTTY: true }), false);
assert.strictEqual(colorEnabled({ TERM: "dumb" }, { isTTY: true }), false);
assert.strictEqual(colorEnabled({ ANXOS_TUI_COLOR: "0" }, { isTTY: true }), false);
assert.strictEqual(colorEnabled({}, { isTTY: false }), false);
console.log("  ok T3 off when asked or not a terminal");

// T4
{
  const plain = renderScreen(baseState, { width: 100, height: 40, unicode: true });
  const painted = colorizeScreen(plain, { env: {} });
  const firstLine = painted.split("\n")[0];
  assert(firstLine.startsWith("\u001b[38;5;141m\u001b[1mAnxOS Agent"), "the title is bold purple");
  assert(/\u001b\[38;5;183m\u001b\[1mService/.test(painted), "section headings are colored");
  assert(/\u001b\[38;5;114mactive/.test(painted), "a healthy state is green");
  const failedService = colorizeScreen(renderScreen({ ...baseState, service: { ...baseState.service, state: "failed" } }, { width: 100, height: 40, unicode: true }), { env: {} });
  assert(/\u001b\[38;5;203mfailed/.test(failedService), "a failure is red");
  assert(/\u001b\[7m/.test(painted), "the selected key is highlighted");
  console.log("  ok T4 title, headings, states and keys are colored");
}
console.log("Agent TUI theme smoke passed (4 cases).");
