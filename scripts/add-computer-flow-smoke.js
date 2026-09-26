#!/usr/bin/env node
// Add Computer flow structure smoke (static, read-only).
//
// Asserts the two-path onboarding redesign is intact in index.html/app.js:
// the Add Computer modal offers "Desktop computer" and "Headless server" cards,
// the headless card carries the real .deb install commands, "Pair with Code"
// comes before the collapsed "Advanced Manual Setup", the primary path
// contains no raw token/credential field, Agent Control keeps its
// "Connect this computer to AnxOS" panel and uninstall note, and the strings
// the two existing UX smokes depend on are still present.
//
// Build 205 P1-A/P1-B/P1-C/P2 corrections this smoke now also protects:
//   * headless card: artifact-availability honesty + fallback, network opt-in
//     step before the pairing code step, full-code expectation;
//   * desktop card: "Another computer will connect to this one" + full code;
//   * Agent Control: default-off network opt-in, the FULL pasteable code in the
//     visible readonly field, the short code only as a session reference, and
//     the renderer wiring (full code displayed/copied, opt-in passed to IPC,
//     confirmation before widening the bind).
//   * FIX 2 (Build 205): already-reachable honesty — the confirmation must not
//     promise a binding restore the service will not perform, and the pairing
//     note/poll must keep showing the already-reachable state while a code from
//     that generation is active.
// These assertions replace the earlier full-code vs short-code expectations
// that matched the old short-code display; they are not weakened.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8").replace(/\r\n/g, "\n");
const app = fs.readFileSync(path.join(rootDir, "app.js"), "utf8").replace(/\r\n/g, "\n");

function region(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker);
  assert(start >= 0, `${label}: start marker ${JSON.stringify(startMarker)} must exist.`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert(end > start, `${label}: end marker ${JSON.stringify(endMarker)} must follow the start marker.`);
  return text.slice(start, end);
}

function assertContains(text, needle, label) {
  assert(text.includes(needle), `${label}: expected ${JSON.stringify(needle)}.`);
}

function main() {
  // --- Add Computer modal exists with both path cards ----------------------
  assert(/id="node-modal-title"[^>]*>Add Computer</.test(html), "the node modal title must be Add Computer.");
  const modal = region(html, 'id="node-modal-title"', "data-node-details-modal", "Add Computer modal");

  const desktopCard = region(modal, '<details class="node-path-card" open>', "</details>", "desktop path card");
  assertContains(desktopCard, "Desktop computer", "desktop path card");
  assertContains(desktopCard, "Connect this computer", "desktop path card");
  assertContains(desktopCard, "Generate Pairing Code", "desktop path card");
  // P1-A (Build 205): the desktop path must tell the user to enable network
  // pairing on the machine being added.
  assertContains(desktopCard, "Another computer will connect to this one", "desktop path card network opt-in");
  assertContains(desktopCard, "full code", "desktop path card full-code expectation");

  const headlessCard = region(modal, '<details class="node-path-card">', "</details>", "headless path card");
  assertContains(headlessCard, "Headless server", "headless path card");
  assertContains(headlessCard, "sudo apt install ./AnxOS-Agent-", "headless path card");
  assertContains(headlessCard, "sudo anxos-agent", "headless path card");
  // P1-C (Build 205): the in-app card must not overpromise artifact availability.
  assertContains(headlessCard, "ships with this release", "headless path card artifact honesty");
  assertContains(headlessCard, "Advanced Manual Setup", "headless path card fallback");
  // P1-B (Build 205): the linear headless path must place the network opt-in
  // before the pairing code step, so following it cannot hit the loopback dead end.
  const headlessOptInIndex = headlessCard.indexOf("Allow network access");
  const headlessPairIndex = headlessCard.indexOf("Choose <strong>Pair</strong>");
  assert(headlessOptInIndex >= 0, "headless path card must include the Allow network access opt-in step.");
  assert(headlessPairIndex > headlessOptInIndex, "the network opt-in step must come before the pairing code step.");
  assertContains(headlessCard, "full pairing code", "headless path card full-code expectation");

  const pathChooser = region(modal, "data-node-path-chooser", "node-modal-layout", "path chooser");
  assertContains(pathChooser, "Desktop computer", "path chooser");
  assertContains(pathChooser, "Headless server", "path chooser");

  // --- Pair with Code before the collapsed Advanced Manual Setup -----------
  const primaryPath = region(modal, 'id="node-modal-title"', '<details class="node-manual-details">', "primary Add Computer path");
  const pairIndex = primaryPath.indexOf("Pair with Code");
  assert(pairIndex >= 0, "the primary path must offer Pair with Code.");
  assert(modal.indexOf("Advanced Manual Setup") > modal.indexOf("Pair with Code"), "Pair with Code must appear before Advanced Manual Setup.");

  const advancedBlock = region(html, '<details class="node-manual-details">', "</details>", "advanced manual setup");
  const advancedOpenTag = html.slice(html.indexOf('<details class="node-manual-details">'), html.indexOf(">", html.indexOf('<details class="node-manual-details">')) + 1);
  assert(!/\bopen\b/.test(advancedOpenTag), `Advanced Manual Setup must be collapsed by default, got ${advancedOpenTag}.`);
  assertContains(advancedBlock, "Advanced Manual Setup", "advanced manual setup");
  assertContains(advancedBlock, 'data-node-field="agentToken"', "advanced manual setup");

  // --- the primary path must not ask for a raw token ------------------------
  assert(!primaryPath.includes('type="password"'), "the primary Add Computer path must not contain a password/token input.");
  assert(!primaryPath.includes('data-node-field="agentToken"'), "the primary Add Computer path must not contain a raw agent token field.");
  assert(!primaryPath.includes("Agent Token"), "the primary Add Computer path must not mention raw Agent Token setup.");
  assert(!primaryPath.includes('data-node-action="generate-token"'), "the primary Add Computer path must not offer manual token generation.");
  assertContains(primaryPath, "No manual token setup is required.", "primary Add Computer path");

  // --- Pair with Code expects the FULL pasteable code -----------------------
  const pairCodeField = region(modal, 'data-node-pairing-code', "</textarea>", "Pair with Code field");
  assertContains(pairCodeField, 'placeholder="ANX-', "Pair with Code full-code placeholder");
  assert(/placeholder="ANX-[^"]*\.ey/.test(pairCodeField), "the Pair with Code placeholder must show the full code shape (reference.base64url), not just the short reference.");
  assertContains(primaryPath, "long code that starts with ANX-XXXX-XXXX-XXXX", "primary Add Computer path full-code copy");

  // --- Agent Control: Connect this computer + uninstall note ----------------
  const agentControl = region(html, "data-agent-control-section-target", "data-node-modal-title", "Agent Control panel");
  assertContains(agentControl, "Connect this computer to AnxOS", "Agent Control panel");
  assertContains(agentControl, 'data-agent-control-action="startPairingSession"', "Agent Control panel");
  assertContains(agentControl, 'data-agent-control-action="copyPairingCode"', "Agent Control panel");
  assertContains(agentControl, "Generate Pairing Code", "Agent Control panel");
  assertContains(agentControl, "Copy Pairing Code", "Agent Control panel");
  assertContains(agentControl, 'data-agent-control-action="installLocalAgent"', "Agent Control panel");
  // P1-A / P2 (Build 205): default-off network opt-in and the full visible code.
  assertContains(agentControl, "data-agent-pairing-network-opt-in", "Agent Control panel network opt-in");
  assertContains(agentControl, "Another computer will connect to this one", "Agent Control panel network opt-in label");
  assertContains(agentControl, "data-agent-pairing-full-code", "Agent Control panel full-code field");
  assertContains(agentControl, "Pairing code — paste this into Add Computer", "Agent Control panel full-code label");
  assertContains(agentControl, "data-agent-pairing-reference", "Agent Control panel session reference");
  assertContains(agentControl, "Session reference", "Agent Control panel session reference label");
  assert(!html.includes("data-agent-pairing-code="), "Agent Control must not show the short display code as the pairing code field anymore.");
  assert(!html.includes("<strong data-agent-pairing-code>"), "the old short-code pairing field must be replaced by the full-code field.");

  const uninstallButtonIndex = html.indexOf('data-agent-control-action="uninstallService"');
  assert(uninstallButtonIndex >= 0, "Agent Control must keep its uninstall action.");
  const uninstallRegion = html.slice(uninstallButtonIndex, uninstallButtonIndex + 3000);
  assertContains(uninstallRegion, "Uninstalling AnxOS Control Center removes the application only.", "Agent Control uninstall note");
  assertContains(uninstallRegion, "Servers, settings, and backups are kept.", "Agent Control uninstall note");

  // --- strings the two existing UX smokes depend on -------------------------
  const combined = `${html}\n${app}`;
  for (const needle of ["installLocalAgent", "startPairingSession", "copyPairingCode", "Generate Pairing Code", "Copy Pairing Code", "No manual token setup is required."]) {
    assertContains(combined, needle, "renderer UX string");
  }
  assertContains(app, 'api.installLocalAgent', "app.js must call the installLocalAgent IPC action.");
  assertContains(app, 'api.startPairingSession', "app.js must call the startPairingSession IPC action.");
  assertContains(app, "Copy Agent pairing code", "app.js must implement the copyPairingCode action label.");
  // P2 (Build 205): the visible field shows the FULL pasteable code, the short
  // reference is separate, and the copy action still copies the full code.
  assertContains(app, 'document.querySelector("textarea[data-agent-pairing-full-code]")', "app.js must read the visible full-code field.");
  assertContains(app, "agentPairingCode.value = activeAgentPairingCode", "app.js must render the full pasteable code into the visible field.");
  assertContains(app, 'agentPairingReference.textContent = activeAgentPairingReference || "Not generated"', "app.js must render the short session reference separately.");
  assert(!app.includes("agentPairingCode.textContent"), "app.js must not treat the visible code field as a text label.");
  // P1-A (Build 205): the opt-in is passed to the IPC, and the confirmation
  // gates the binding change.
  assertContains(app, "{ ...target, allowNetworkAccess }", "app.js must pass the network opt-in to startPairingSession.");
  assertContains(app, "Allow another computer to reach this Agent?", "app.js must ask before widening the Local Agent bind.");
  // FIX 2 (Build 205): when the Agent is already network-reachable the service
  // writes no opt-in marker and touches no bind, so the dialog must not promise
  // a restore it cannot perform, and the pairing note must state the Agent
  // already accepts network connections instead of reverting to default-off.
  assertContains(app, "getLocalPairingNetworkOverviewState", "app.js must read the service-derived network reachability for the confirmation copy.");
  assertContains(app, "This Agent already accepts network connections, so its listening setting will not change.", "the confirmation must not promise a restore when the Agent is already reachable.");
  assertContains(app, "Turning this network option off later will not change that setting", "the confirmation must say the already-reachable option does not change the bind.");
  assertContains(app, "On (this Agent already accepts connections on your network)", "the pairing note must show the distinct already-reachable state.");
  assertContains(app, "shouldShowAgentPairingNetworkEnabled", "the refresh poll must not revert the already-reachable checkbox state.");

  console.log("add-computer:smoke passed — two-path modal, headless commands, Pair with Code before collapsed Advanced, token-free primary path, Agent Control panel, UX strings");
}

main();
