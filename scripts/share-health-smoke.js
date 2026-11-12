#!/usr/bin/env node
"use strict";

// Regression for per-server sharing health (Phase 3.1).
//   H1 a running tunnel is never "ready" until the game's port is confirmed;
//   H2 each failure point (computer, server, port, Playit, tunnel) has its
//      own status and one plain next step;
//   H3 a connection test result settles the game's port and names the first
//      broken stage;
//   H4 the renderer uses these rules and offers Test connection through the
//      existing read-only connectivity diagnostics;
//   H5 sharing needs explicit approval and refuses management ports.
// Run: node scripts/share-health-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const share = require(path.join(root, "src", "shared", "shareHealth.js"));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const { STATUS } = share;

const tunnelUp = { processState: "running", playitState: "running", tunnelMatch: "matched", usablePublic: true, usableLan: true };

// H1
assert.strictEqual(share.classifyShareHealth({ ...tunnelUp, portState: "listening" }), STATUS.PUBLIC_READY);
assert.strictEqual(share.classifyShareHealth({ ...tunnelUp, portState: "unknown" }), STATUS.GAME_NOT_VERIFIED, "tunnel up + unknown game port is not ready");
assert.strictEqual(share.classifyShareHealth({ ...tunnelUp, portState: "not-listening" }), STATUS.PORT_NOT_LISTENING, "tunnel up + closed game port is a game problem");
assert.strictEqual(share.describeShareHealth(STATUS.GAME_NOT_VERIFIED).tone, "warning");
assert.match(share.describeShareHealth(STATUS.GAME_NOT_VERIFIED).nextStep, /Test connection/);
console.log("PASS H1 an active tunnel is not reported as a reachable game");

// H2
assert.strictEqual(share.classifyShareHealth({ ...tunnelUp, portState: "listening", nodeUnavailable: true }), STATUS.NODE_DISCONNECTED);
assert.strictEqual(share.classifyShareHealth({ ...tunnelUp, processState: "failed" }), STATUS.SERVER_FAILED);
assert.strictEqual(share.classifyShareHealth({ ...tunnelUp, processState: "stopped" }), STATUS.SERVER_STOPPED);
assert.strictEqual(share.classifyShareHealth({ processState: "running", portState: "listening", playitState: "stopped", tunnelMatch: "matched", usablePublic: false, usableLan: true }), STATUS.PLAYIT_STOPPED);
assert.strictEqual(share.classifyShareHealth({ processState: "running", portState: "listening", playitState: "running", tunnelMatch: "multiple", usablePublic: true }), STATUS.MULTIPLE_TUNNELS);
assert.strictEqual(share.classifyShareHealth({ processState: "running", portState: "listening", playitState: "running", tunnelMatch: "not-matched", usableLan: true }), STATUS.LOCAL_ONLY);
assert.strictEqual(share.classifyShareHealth({ processState: "running", portState: "listening", playitState: "running", tunnelMatch: "not-matched" }), STATUS.NO_TUNNEL);
assert.strictEqual(share.classifyShareHealth({}), STATUS.UNKNOWN);
for (const status of Object.values(STATUS)) {
  const described = share.describeShareHealth(status);
  assert.strictEqual(described.status, status);
  assert.ok(described.headline && described.nextStep, `${status} has a headline and a next step`);
}
const checklist = share.buildShareChecklist({ processState: "running", portState: "unknown", playitState: "running", tunnelMatch: "matched", publicAddress: "available" });
assert.deepStrictEqual(checklist.map((check) => [check.id, check.state]), [["server", "ok"], ["game", "unknown"], ["playit", "ok"], ["tunnel", "ok"], ["address", "ok"]]);
const offline = share.buildShareChecklist({ nodeState: "disconnected", processState: "running", playitState: "unavailable", tunnelMatch: "matched", publicAddress: "available" });
assert.ok(offline.every((check) => check.state === "unknown"), "a disconnected computer marks nothing as working or broken");
console.log("PASS H2 each failure point has its own status and next step");

// H3
const diagnostics = {
  stages: [
    { id: "service-process", state: "healthy", detail: "" },
    { id: "local-socket", state: "failed", detail: "Nothing answers on 127.0.0.1:25565." },
    { id: "provider", state: "healthy", detail: "" },
  ],
};
assert.strictEqual(share.portStateFromDiagnostics(diagnostics), "not-listening");
assert.strictEqual(share.portStateFromDiagnostics({ stages: [{ id: "local-socket", state: "healthy" }] }), "listening");
assert.strictEqual(share.portStateFromDiagnostics({ stages: [{ id: "local-socket", state: "unknown" }] }), null);
assert.strictEqual(share.portStateFromDiagnostics(null), null);
const explained = share.explainDiagnostics(diagnostics);
assert.strictEqual(explained.firstFailure.id, "local-socket", "the first broken stage is where to look");
assert.match(explained.firstFailure.label, /Game accepts connections/);
assert.deepStrictEqual(explained.rows.map((row) => row.stateLabel), ["OK", "Problem", "OK"]);
console.log("PASS H3 a connection test settles the game port and names the break");

// H4
assert.ok(app.includes("AnxShareHealth.classifyShareHealth({"), "sharing health uses the shared rules");
assert.ok(!/status = "Public access ready"/.test(app), "no second copy of the ready rule is left in app.js");
assert.ok(app.includes("api.connectivity.runDiagnostics({") && app.includes("serviceId: instance.id,"), "Test connection runs connectivity diagnostics for the server");
assert.ok(app.includes('testButton.textContent = "Test connection";'), "the Share dialog offers Test connection");
const at = index.indexOf('src="src/shared/shareHealth.js"');
assert.ok(at > 0 && at < index.indexOf('src="app.js"'), "shareHealth.js loads before app.js");
console.log("PASS H4 the Share dialog uses the shared rules and the existing diagnostics");

// H5 sharing a server needs explicit approval and never covers management ports.
for (const port of [22, 2375, 3389, 6566]) assert.ok(share.getManagementPortName(port), `port ${port} is a management port`);
for (const port of [25565, 30120, 8211, "7777"]) assert.strictEqual(share.getManagementPortName(port), "", `port ${port} is a game port`);
const exposure = share.describeShareExposure({ serverName: "Friends", port: 8211, protocol: "udp", providerName: "Playit" });
assert.match(exposure, /UDP port 8211/);
assert.match(exposure, /never shares SSH, Docker/);
assert.match(share.describeShareExposure({ port: 25565, providerName: "Tailscale", privateNetwork: true }), /Tailscale network/);
assert.deepStrictEqual(share.describePlayitTunnelSetup({ port: 8211, protocol: "udp" })[1], "Add a tunnel of type UDP that points to local port 8211.");
const createFn = app.slice(app.indexOf("async function createAccessServiceForInstance("), app.indexOf("async function copyInstanceAccessAddress("));
const guardAt = createFn.indexOf("AnxShareHealth.getManagementPortName(suggestion.localPort)");
const approvalAt = createFn.indexOf("await createSecurityConfirmation(");
const sendAt = createFn.indexOf("api.publicAccess.createService(payload)");
assert.ok(guardAt > 0 && guardAt < approvalAt && approvalAt < sendAt, "management ports are refused, then the user approves, then the share is created");
assert.ok(createFn.includes("if (!approved) return null;"), "declining creates nothing");
assert.ok(app.includes("message: \"AnxOS removes this server's sharing settings. A tunnel you created on playit.gg stays there"), "Stop sharing says what it does not remove");
console.log("PASS H5 sharing needs approval and never covers management ports");

// H6 tunnel protocol: a known mismatch is flagged, unknown never is, and
// "tcp+udp" tunnels are not mistaken for TCP-only ones.
assert.strictEqual(share.assessTunnelProtocol("TCP", "UDP"), "mismatch");
assert.strictEqual(share.assessTunnelProtocol("TCP+UDP", "UDP"), "match");
assert.strictEqual(share.assessTunnelProtocol("UDP", "UDP"), "match");
assert.strictEqual(share.assessTunnelProtocol(null, "UDP"), "unknown");
assert.strictEqual(share.assessTunnelProtocol("HTTPS", "TCP"), "unknown");
const upAndListening = { processState: "running", portState: "listening", playitState: "running", tunnelMatch: "matched", usablePublic: true };
assert.strictEqual(share.classifyShareHealth({ ...upAndListening, tunnelProtocol: "mismatch" }), STATUS.PROTOCOL_MISMATCH);
assert.strictEqual(share.classifyShareHealth({ ...upAndListening, tunnelProtocol: "unknown" }), STATUS.PUBLIC_READY, "an unreported protocol is not a problem");
const agentPlayit = require(path.join(root, "agent", "src", "services", "playitService.js"))._test;
for (const [raw, expected] of [["tcp", "TCP"], ["udp", "UDP"], ["tcp+udp", "TCP+UDP"], ["udp/tcp", "TCP+UDP"], ["both", "TCP+UDP"], ["https", "HTTPS"], [null, null]]) {
  assert.strictEqual(agentPlayit.normalizeProtocol(raw), expected, `Agent normalizes ${raw}`);
}
assert.strictEqual(agentPlayit.extractProtocol("protocol: tcp+udp"), "TCP+UDP");
assert.strictEqual(agentPlayit.extractProtocol("proto=udp"), "UDP");
assert.ok(app.includes("Playit reports this tunnel as ${health.reportedTunnelProtocol}; this game needs ${health.requiredProtocol}."), "the dialog names both protocols");
console.log("PASS H6 tunnel protocol mismatches are flagged without false alarms");

// H7 Playit recovery facts are read-only, and reported only when known.
assert.deepStrictEqual(["no", "on-failure", "always", "", "weird"].map(agentPlayit.parseSystemdRestartSetting), [false, true, true, null, null]);
assert.deepStrictEqual([2, "Automatic", 3, "Disabled", null].map(agentPlayit.parseWindowsStartType), ["enabled", "enabled", "manual", "disabled", null]);
assert.deepStrictEqual(["enabled", "disabled", "manual", "static", null].map(agentPlayit.parseStartsOnBoot), [true, false, false, null, null]);
assert.strictEqual(agentPlayit.parseWindowsFailureActions("SERVICE_NAME: playit\n FAILURE_ACTIONS : RESTART -- Delay = 60000 milliseconds."), true);
assert.strictEqual(agentPlayit.parseWindowsFailureActions("SERVICE_NAME: playit\n FAILURE_ACTIONS :"), false);
assert.strictEqual(agentPlayit.parseWindowsFailureActions("[SC] OpenService FAILED 1060"), null);
assert.match(share.describePlayitServiceRecovery({ startsOnBoot: true, restartOnFailure: true }), /restarts itself/);
assert.match(share.describePlayitServiceRecovery({ manager: "systemd", restartOnFailure: false }), /Restart=on-failure/);
assert.match(share.describePlayitServiceRecovery({ manager: "windows-service", restartOnFailure: false }), /Recovery/);
assert.strictEqual(share.describePlayitServiceRecovery({}), "", "unknown facts say nothing");
const agentPlayitSource = fs.readFileSync(path.join(root, "agent", "src", "services", "playitService.js"), "utf8");
// Writes would be "systemctl set-property/edit" or "sc.exe failure/config";
// the Agent only uses "systemctl show" and "sc.exe qfailure".
for (const write of ['"set-property"', '"edit"', '["failure"', '["config"']) {
  assert.ok(!agentPlayitSource.includes(write), `the Agent never changes Playit service settings (${write})`);
}
assert.ok(agentPlayitSource.includes('"show", "-p", "Restart", "--value"') && agentPlayitSource.includes('"qfailure"'), "the Agent reads the restart settings");
console.log("PASS H7 Playit restart settings are reported, not supervised");

console.log("Share health smoke passed (7 checks).");
