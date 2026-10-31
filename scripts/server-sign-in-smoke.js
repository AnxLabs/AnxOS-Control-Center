#!/usr/bin/env node
"use strict";

// Sign in for game servers that need an account sign-in (Hytale first). The
// Agent reads the publisher's link and code from the server's output; the
// desktop starts the game's own sign-in command when no code is pending and
// opens only an allowed sign-in link in the default browser.
// Run: node scripts/server-sign-in-smoke.js

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const signIn = require("../src/shared/gameSignIn");
const core = require("../src/shared/instances/instanceServiceCore");

let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };

// Real lines from a Hytale 0.7.5 console (ANSI colour codes included).
const HYTALE_PROMPT = [
  "\u001b[m[2026/10/31 00:39:51   INFO]        [AbstractCommand] Visit: https://oauth.accounts.hytale.com/oauth2/device/verify\u001b[m",
  "\u001b[m[2026/10/31 00:39:51   INFO]        [AbstractCommand] Enter code: CkvKc7UU\u001b[m",
  "\u001b[m[2026/10/31 00:39:51   INFO]        [AbstractCommand] Or visit: https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=CkvKc7UU\u001b[m",
  "\u001b[m[2026/10/31 00:39:51   INFO]        [AbstractCommand] Waiting for authorization (expires in 599 seconds)...\u001b[m",
].join("\n");

function loadSignInService(router, opened) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "./serviceRouter") return router;
    if (request === "./externalUrlService") {
      return { openExternalUrl: async (url, options) => { opened.push({ url, options }); return { opened: true, url }; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../src/services/instanceSignInService")];
    return require("../src/services/instanceSignInService");
  } finally {
    Module._load = originalLoad;
  }
}

function instanceWith(signInState, extra = {}) {
  return { instance: { id: "hytale-dedicated-server", processRunning: true, signIn: signInState, ...extra } };
}

(async () => {
  // S1: parsing the real prompt, and refusing foreign links.
  assert.deepStrictEqual(signIn.parseSignInOutput("hytale", HYTALE_PROMPT), {
    verificationUrl: "https://oauth.accounts.hytale.com/oauth2/device/verify",
    userCode: "CkvKc7UU",
    verificationUrlComplete: "https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=CkvKc7UU",
    expiresInSeconds: 599,
  });
  assert.deepStrictEqual(signIn.parseSignInOutput("hytale", "[ServerAuthManager] Authentication successful! Mode: OAUTH_DEVICE"), { succeeded: true });
  assert.strictEqual(signIn.parseSignInOutput("hytale", "Visit: https://evil.example/oauth2/device/verify"), null, "a link outside the publisher's host is ignored");
  assert.strictEqual(signIn.parseSignInOutput("hytale", "Visit: http://oauth.accounts.hytale.com/x"), null, "plain http is ignored");
  assert.strictEqual(signIn.parseSignInOutput("palworld", HYTALE_PROMPT), null, "games without a sign-in adapter parse nothing");
  pass("S1 the publisher's link, code and expiry are read from real Hytale output; foreign or plain-http links are ignored");

  // S2: the challenge per run: a new link starts over, success clears it.
  const now = Date.parse("2026-10-31T00:39:51Z");
  let challenge = core.nextSignInChallenge("hytale", null, HYTALE_PROMPT, now);
  assert.strictEqual(challenge.userCode, "CkvKc7UU");
  assert.strictEqual(challenge.expiresAt, "2026-10-31T00:49:50.000Z");
  const fresh = core.nextSignInChallenge("hytale", challenge, "Visit: https://oauth.accounts.hytale.com/oauth2/device/verify", now + 1000);
  assert.strictEqual(fresh.userCode, undefined, "a new sign-in attempt never keeps the previous code");
  assert.strictEqual(core.nextSignInChallenge("hytale", challenge, "Authentication successful!", now), null);
  assert.strictEqual(core.nextSignInChallenge("hytale", challenge, "Hytale Server Booted!", now), undefined, "unrelated output changes nothing");
  assert.strictEqual(signIn.usableSignInChallenge("hytale", challenge, now).openUrl, challenge.verificationUrlComplete);
  assert.strictEqual(signIn.usableSignInChallenge("hytale", challenge, now + 600000), null, "an expired code is not offered");
  assert.strictEqual(signIn.usableSignInChallenge("hytale", { ...challenge, verificationUrlComplete: "https://evil.example/" , verificationUrl: undefined }, now), null);
  pass("S2 each sign-in attempt has its own code, expiry is honoured, and success clears it");

  // S3: an existing code opens the browser without sending anything.
  const live = signIn.usableSignInChallenge("hytale", challenge, Date.now() - 1000) || { ...challenge, openUrl: challenge.verificationUrlComplete };
  let commands = [];
  let opened = [];
  let service = loadSignInService({
    getInstanceStatus: async () => instanceWith({ supported: true, game: "hytale", label: "Hytale account", required: true, challenge: live }),
    sendInstanceCommand: async (...args) => { commands.push(args); },
  }, opened);
  let result = await service.openInstanceSignIn("hytale-dedicated-server", { nodeId: "anxlab" });
  assert.deepStrictEqual(commands, []);
  assert.deepStrictEqual(opened.map((entry) => [entry.url, entry.options.allowedHosts]), [[live.openUrl, ["oauth.accounts.hytale.com"]]]);
  assert.strictEqual(result.userCode, "CkvKc7UU");
  assert.strictEqual(result.started, false);
  pass("S3 a pending code opens the publisher's page in the default browser, restricted to its host");

  // S4: no code yet: the game's own command is sent, then the new code opens.
  commands = [];
  opened = [];
  let polls = 0;
  service = loadSignInService({
    getInstanceStatus: async () => {
      polls += 1;
      return instanceWith({ supported: true, game: "hytale", label: "Hytale account", required: true, challenge: polls >= 3 ? live : null });
    },
    sendInstanceCommand: async (...args) => { commands.push(args); },
  }, opened);
  result = await service.openInstanceSignIn("hytale-dedicated-server", { nodeId: "anxlab" }, { wait: async () => {} });
  assert.deepStrictEqual(commands, [["hytale-dedicated-server", "auth login device", { nodeId: "anxlab" }]]);
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(result.started, true);
  pass("S4 without a pending code it runs the game's sign-in command (auth login device) on the right node, then opens the new code");

  // S5: refusals open nothing.
  const cases = [
    [instanceWith(null), "SIGN_IN_UNSUPPORTED"],
    [instanceWith({ supported: true, game: "hytale", required: true, challenge: live }, { processRunning: false }), "SIGN_IN_SERVER_NOT_RUNNING"],
    [instanceWith({ supported: true, game: "hytale", required: true, challenge: { ...live, openUrl: "https://evil.example/verify" } }), "SIGN_IN_URL_BLOCKED"],
  ];
  for (const [status, code] of cases) {
    opened = [];
    service = loadSignInService({ getInstanceStatus: async () => status, sendInstanceCommand: async () => {} }, opened);
    await assert.rejects(() => service.openInstanceSignIn("x", {}), (error) => error.code === code, code);
    assert.deepStrictEqual(opened, [], `${code} opens nothing`);
  }
  let clock = 0;
  service = loadSignInService({ getInstanceStatus: async () => instanceWith({ supported: true, game: "hytale", required: true, challenge: null }), sendInstanceCommand: async () => {} }, opened = []);
  await assert.rejects(
    () => service.openInstanceSignIn("x", {}, { wait: async () => { clock += 1000; }, now: () => clock }),
    (error) => error.code === "SIGN_IN_CODE_TIMEOUT",
  );
  assert.deepStrictEqual(opened, []);
  pass("S5 unsupported games, stopped servers, foreign links and missing codes are refused without opening anything");

  // S6: wiring.
  const ipc = fs.readFileSync(path.join(ROOT, "src", "ipc", "instancesIpc.js"), "utf8");
  const handler = ipc.slice(ipc.indexOf('"instances:signIn"'), ipc.indexOf('"instances:start"'));
  assert.ok(handler.indexOf('requirePermission("instance:write"') < handler.indexOf("openInstanceSignIn("), "permission is checked before anything runs");
  assert.ok(handler.includes('audit({ action: "instance.sign-in.open"'));
  assert.ok(fs.readFileSync(path.join(ROOT, "preload.js"), "utf8").includes('signIn: (instanceId, options = {}) => ipcRenderer.invoke("instances:signIn"'));
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.ok(app.includes('data-instance-action="sign-in"') && app.includes("const state = getInstanceSignInUiState(selectedInstance);"), "the button follows the sign-in state helper (checked in S9)");
  assert.ok(fs.readFileSync(path.join(ROOT, "index.html"), "utf8").includes('data-instance-action="sign-in" hidden disabled'), "the button is hidden by default");
  const coreSource = fs.readFileSync(path.join(ROOT, "src", "shared", "instances", "instanceServiceCore.js"), "utf8");
  assert.ok(coreSource.includes("signInChallenge: _signInChallenge"), "the raw challenge is not published; only the vetted signIn state is");
  pass("S6 IPC (permission then audit), preload and the Power-group button are wired");

  // S7: an account with several game profiles (real Hytale 0.7.5 output after
  // the code was approved), across two chunks; logout clears everything.
  const PROFILE_PROMPT = [
    "[2026/10/31 02:31:05   INFO]              [ServerAuthManager] Multiple profiles available. Use '/auth select <number>' to choose:",
    "[2026/10/31 02:31:05   INFO]              [ServerAuthManager]   [1] Anx_1 (110f1eaf-c209-4446-ab68-2e4b3ea24e69)",
  ].join("\n");
  const PROFILE_REST = "[2026/10/31 02:31:05   INFO]              [ServerAuthManager]   [2] Anx (69beb52d-2800-4a89-9528-d1e7eb585157)";
  let state = core.nextSignInChallenge("hytale", challenge, PROFILE_PROMPT, now);
  state = core.nextSignInChallenge("hytale", state, PROFILE_REST, now);
  assert.deepStrictEqual(state.profileSelection.profiles, [{ number: 1, name: "Anx_1" }, { number: 2, name: "Anx" }]);
  assert.strictEqual(state.userCode, undefined, "the spent code is dropped once a profile must be chosen");
  assert.strictEqual(core.nextSignInChallenge("hytale", null, PROFILE_REST, now), undefined, "a profile line outside a prompt changes nothing");
  assert.strictEqual(core.nextSignInChallenge("hytale", state, "[ServerAuthManager] Authentication successful! Mode: OAUTH_DEVICE", now), null);
  assert.strictEqual(core.nextSignInChallenge("hytale", challenge, "[ServerAuthManager] Server logged out", now), null);
  const degraded = { readinessState: "degraded", healthState: "degraded", failureReason: "HYTALE_AUTH_REQUIRED" };
  assert.deepStrictEqual(core.hytaleReadinessUpdate("[ServerAuthManager] Server logged out", { layoutInstalled: true, booted: true }), degraded, "a running server that logs out needs sign-in again");
  pass("S7 profile choice is read across chunks, the spent code is dropped, and logout makes the server need sign-in again");

  // S8: choosing a profile sends only a number the server offered.
  const choosing = instanceWith({ supported: true, game: "hytale", label: "Hytale account", required: true, challenge: null, profiles: [{ number: 1, name: "Anx_1" }, { number: 2, name: "Anx" }] });
  commands = [];
  opened = [];
  service = loadSignInService({ getInstanceStatus: async () => choosing, sendInstanceCommand: async (...args) => { commands.push(args); } }, opened);
  const chosen = await service.selectInstanceSignInProfile("hytale-dedicated-server", 2, { nodeId: "anxlab" });
  assert.deepStrictEqual(commands, [["hytale-dedicated-server", "auth select 2", { nodeId: "anxlab" }]]);
  assert.deepStrictEqual(chosen.profile, { number: 2, name: "Anx" });
  commands = [];
  await assert.rejects(() => service.selectInstanceSignInProfile("hytale-dedicated-server", 3, {}), (error) => error.code === "SIGN_IN_PROFILE_UNKNOWN");
  await assert.rejects(() => service.selectInstanceSignInProfile("hytale-dedicated-server", "1; stop", {}), (error) => error.code === "SIGN_IN_PROFILE_UNKNOWN");
  await assert.rejects(() => service.openInstanceSignIn("hytale-dedicated-server", {}), (error) => error.code === "SIGN_IN_PROFILE_REQUIRED", "a new code would discard the approved sign-in");
  assert.deepStrictEqual(commands, [], "refusals send nothing");
  assert.deepStrictEqual(opened, []);
  pass("S8 choosing a profile sends `auth select <n>` only for an offered number; a new code is refused while a choice is pending");

  // S9: the button's states, from the real renderer function.
  const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const start = appSource.indexOf("function getInstanceSignInUiState(");
  const end = appSource.slice(start).search(/\r?\n\}\r?\n/);
  assert.ok(start >= 0 && end > 0, "getInstanceSignInUiState is defined in app.js");
  const body = appSource.slice(start, start + end).concat("\n}\n");
  // eslint-disable-next-line no-new-func
  const uiState = new Function("isInstanceRunning", `${body}; return getInstanceSignInUiState;`)((instance) => instance?.state === "Running");
  const hytale = (signInPatch, extra = {}) => ({ state: "Running", readinessState: "ready", signIn: { supported: true, label: "Hytale account", required: false, profiles: null, ...signInPatch }, ...extra });
  assert.strictEqual(uiState(hytale({ required: true }, { readinessState: "degraded" })).mode, "sign-in");
  assert.strictEqual(uiState(hytale({ required: true, profiles: [{ number: 1, name: "Anx_1" }] }, { readinessState: "degraded" })).mode, "choose-profile");
  const signedIn = uiState(hytale({}));
  assert.deepStrictEqual([signedIn.mode, signedIn.actionable], ["signed-in", false], "a signed-in ready server shows a dimmed, unclickable Signed in");
  assert.strictEqual(uiState(hytale({}, { readinessState: "starting" })).mode, "hidden", "a server that is still starting never claims Signed in");
  assert.strictEqual(uiState(hytale({}, { state: "Stopped" })).mode, "hidden");
  assert.strictEqual(uiState({ state: "Running", readinessState: "ready", signIn: null }).mode, "hidden", "games without a sign-in show nothing");
  assert.ok(appSource.includes("noteInstanceSignInTransitions(instances);") && appSource.includes('title: "Server signed in"'), "becoming signed in raises a toast and a notification");
  assert.ok(fs.readFileSync(path.join(ROOT, "preload.js"), "utf8").includes('ipcRenderer.invoke("instances:selectSignInProfile"'));
  pass("S9 the button shows Sign in, Choose profile, or a dimmed Signed in (never while starting), and signing in is announced");

  console.log(`server sign-in smoke passed (${results} checks).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
