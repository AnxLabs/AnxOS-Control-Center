"use strict";

// playit account connection (src/services/playitAccountService.js), driven
// against a fake playit: every system call is injected, so this never touches
// a real playit install, its key or its tunnels.
// Run: node scripts/playit-account-service-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const {
  createPlayitAccountService,
  extractPlayitUrl,
  isAllowedPlayitUrl,
  redactPlayitText,
} = require("../src/services/playitAccountService");

const BIN = "C:\\Program Files\\playit_gg\\bin\\playit.exe";
const KEY = "C:\\ProgramData\\playit_gg\\playit.toml";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

// files: path -> size. A missing path throws ENOENT, like fs.stat.
function world(options = {}) {
  const files = new Map(Object.entries(options.files || {}));
  const calls = { run: [], spawn: [], stat: [] };
  const children = [];
  const service = createPlayitAccountService({
    findBinary: async () => (options.installed === false ? { installed: false, path: null } : { installed: true, path: BIN }),
    getStatus: async () => ({ running: options.running !== false }),
    configCandidates: () => [KEY, "C:\\Users\\x\\AppData\\Local\\playit_gg\\playit.toml"],
    run: async (file, args) => {
      calls.run.push([file, ...args]);
      const key = args.join(" ");
      const scripted = (options.commands || {})[key];
      if (typeof scripted === "function") return scripted();
      return scripted || { ok: false, exitCode: 1, stdout: "", stderr: "Could not connect to the playit service." };
    },
    spawn: (file, args) => {
      calls.spawn.push([file, ...args]);
      const child = fakeChild();
      children.push(child);
      return child;
    },
    stat: async (filePath) => {
      calls.stat.push(filePath);
      if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { size: files.get(filePath), isFile: () => true };
    },
    linkTimeoutMs: options.linkTimeoutMs || 60000,
  });
  return { service, calls, children, files };
}

const secretPath = (filePath) => ({ ok: true, exitCode: 0, stdout: `${filePath}\n`, stderr: "" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => { assert.strictEqual(error.code, code); return true; });
}

async function main() {
  // URL allowlist and redaction.
  assert.strictEqual(isAllowedPlayitUrl("https://playit.gg/claim/abc"), true);
  assert.strictEqual(isAllowedPlayitUrl("https://www.playit.gg/login/xyz"), true);
  assert.strictEqual(isAllowedPlayitUrl("http://playit.gg/claim/abc"), false, "https only");
  assert.strictEqual(isAllowedPlayitUrl("https://playit.gg.evil.example/claim"), false, "look-alike host");
  assert.strictEqual(isAllowedPlayitUrl("https://user:pass@playit.gg/claim"), false, "no embedded credentials");
  assert.strictEqual(isAllowedPlayitUrl("https://evilplayit.gg/x"), false);
  assert.strictEqual(extractPlayitUrl("Visit https://evil.example/x then https://playit.gg/claim/AbC123."), "https://playit.gg/claim/AbC123");
  assert.strictEqual(extractPlayitUrl("no link here"), null);
  const redacted = redactPlayitText("open https://playit.gg/claim/AbC123 with key 0123456789abcdef0123456789abcdef");
  assert.ok(!redacted.includes("playit.gg/claim") && !redacted.includes("0123456789abcdef0123456789abcdef"), "messages never carry links or long tokens");
  console.log("PASS A1 links are allowlisted to https://playit.gg and redacted from messages");

  // States: Install -> Start -> Link -> Tunnels.
  let w = world({ installed: false });
  let state = await w.service.getAccountState();
  assert.strictEqual(state.step, "install");
  assert.strictEqual(state.downloadUrl, "https://playit.gg/download");

  w = world({ running: false, files: { [KEY]: 412 } });
  state = await w.service.getAccountState();
  assert.deepStrictEqual([state.running, state.linked, state.step], [false, true, "start"], "stopped with a key file: linked, start next");
  w = world({ running: false });
  state = await w.service.getAccountState();
  assert.deepStrictEqual([state.linked, state.step], [null, "start"], "stopped without a known key file: unknown, start next");

  w = world({ running: true, files: { [KEY]: 412 }, commands: { "secret-path": secretPath(KEY) } });
  state = await w.service.getAccountState();
  assert.deepStrictEqual([state.linked, state.step], [true, "tunnels"], "running and linked: tunnels next");
  w = world({ running: true, files: { [KEY]: 0 }, commands: { "secret-path": secretPath(KEY) } });
  state = await w.service.getAccountState();
  assert.deepStrictEqual([state.linked, state.step], [false, "link"], "running with an empty key file: link next");
  w = world({ running: true, commands: { "secret-path": secretPath(KEY) } });
  state = await w.service.getAccountState();
  assert.deepStrictEqual([state.linked, state.step], [false, "link"], "running with no key file: link next");
  w = world({ running: true });
  state = await w.service.getAccountState();
  assert.strictEqual(state.linked, null, "secret-path failing: unknown, never assumed unlinked");
  w = world({ running: true, commands: { "secret-path": { ok: true, exitCode: 0, stdout: "playit.toml\n", stderr: "" } } });
  assert.strictEqual((await w.service.getAccountState()).linked, null, "a relative path is not trusted");
  console.log("PASS A2 account states map to Install, Start, Link and Tunnels");

  // The key file is only ever stat-ed: the module cannot read it.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "playitAccountService.js"), "utf8");
  assert.ok(!/readFile|createReadStream|\.read\(/.test(source), "playitAccountService never reads file contents");
  console.log("PASS A3 the playit key is checked by existence and size only, never read");

  // Linking is refused unless playit is running and reports no key.
  await expectCode(world({ installed: false }).service.startLink(), "PLAYIT_NOT_INSTALLED");
  await expectCode(world({ running: false }).service.startLink(), "PLAYIT_NOT_RUNNING");
  w = world({ running: true, files: { [KEY]: 412 }, commands: { "secret-path": secretPath(KEY) } });
  await expectCode(w.service.startLink(), "PLAYIT_ALREADY_LINKED");
  assert.strictEqual(w.calls.spawn.length, 0, "an existing link is never replaced: setup is not run");
  w = world({ running: true });
  await expectCode(w.service.startLink(), "PLAYIT_LINK_STATE_UNKNOWN");
  assert.strictEqual(w.calls.spawn.length, 0, "an unknown link state never runs setup");
  console.log("PASS A4 linking only starts when playit is running and reports no key");

  // Successful linking through playit's browser flow.
  w = world({ running: true, commands: { "secret-path": secretPath(KEY) } });
  let session = await w.service.startLink();
  assert.deepStrictEqual(w.calls.spawn, [[BIN, "setup"]], "linking runs playit's own setup");
  assert.strictEqual(session.state, "starting");
  assert.strictEqual((await w.service.startLink()).id, session.id, "a second request joins the running attempt");
  const [child] = w.children;
  child.stdout.emit("data", "Visit https://evil.example/claim/x first\n");
  assert.strictEqual(w.service.getLink(session.id).linkUrl, null, "non-playit links are ignored");
  child.stdout.emit("data", "Visit https://playit.gg/claim/AbC123xyz to set up your agent\n");
  session = w.service.getLink(session.id);
  assert.strictEqual(session.state, "awaiting-approval");
  assert.strictEqual(session.linkUrl, "https://playit.gg/claim/AbC123xyz");
  w.files.set(KEY, 412); // playit wrote its key after approval
  child.emit("exit", 0);
  await tick(); await tick();
  session = w.service.getLink(session.id);
  assert.strictEqual(session.state, "linked");
  assert.ok(session.endedAt);
  console.log("PASS A5 linking surfaces the playit.gg approval link and ends linked");

  // Failure output is redacted; setup that exits without a key is not "linked".
  w = world({ running: true, commands: { "secret-path": secretPath(KEY) } });
  session = await w.service.startLink();
  w.children[0].stderr.emit("data", "error: claim https://playit.gg/claim/AbC123xyz rejected token 0123456789abcdef0123456789abcdef\n");
  w.children[0].emit("exit", 1);
  await tick();
  session = w.service.getLink(session.id);
  assert.strictEqual(session.state, "failed");
  assert.ok(!session.message.includes("playit.gg/claim") && !session.message.includes("0123456789abcdef0123456789abcdef"), "failure messages are redacted");
  w = world({ running: true, commands: { "secret-path": secretPath(KEY) } });
  session = await w.service.startLink();
  w.children[0].emit("exit", 0);
  await tick(); await tick();
  assert.strictEqual(w.service.getLink(session.id).state, "failed", "exit 0 without a key is not reported as linked");
  console.log("PASS A6 failed or incomplete setup is reported as failed, with redacted output");

  // Cancel and expiry stop playit setup.
  w = world({ running: true, commands: { "secret-path": secretPath(KEY) } });
  session = await w.service.startLink();
  session = w.service.cancelLink(session.id);
  assert.strictEqual(session.state, "cancelled");
  assert.strictEqual(w.children[0].killed, true, "cancel stops playit setup");
  w = world({ running: true, linkTimeoutMs: 30, commands: { "secret-path": secretPath(KEY) } });
  session = await w.service.startLink();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.strictEqual(w.service.getLink(session.id).state, "expired");
  assert.strictEqual(w.children[0].killed, true, "an unapproved link expires and stops setup");
  assert.throws(() => w.service.getLink("missing"), (error) => error.code === "PLAYIT_LINK_NOT_FOUND");
  console.log("PASS A7 cancel and expiry stop playit setup");

  // Manage on playit.gg: a sign-in link for a linked account only.
  const login = { ok: true, exitCode: 0, stdout: "https://playit.gg/login/guest-account/Zx9\n", stderr: "" };
  w = world({ running: true, files: { [KEY]: 412 }, commands: { "secret-path": secretPath(KEY), "account login-url": login } });
  assert.deepStrictEqual(await w.service.getManageLink(), { linkUrl: "https://playit.gg/login/guest-account/Zx9" });
  assert.ok(w.calls.run.some((call) => call.slice(1).join(" ") === "account login-url"), "uses playit's own login-url command");
  w = world({ running: true, files: { [KEY]: 412 }, commands: { "secret-path": secretPath(KEY), "account login-url": { ok: true, exitCode: 0, stdout: "https://evil.example/login\n", stderr: "" } } });
  await expectCode(w.service.getManageLink(), "PLAYIT_LOGIN_LINK_UNAVAILABLE");
  await expectCode(world({ running: true, commands: { "secret-path": secretPath(KEY) } }).service.getManageLink(), "PLAYIT_NOT_LINKED");
  await expectCode(world({ running: false, files: { [KEY]: 412 } }).service.getManageLink(), "PLAYIT_NOT_RUNNING");
  console.log("PASS A8 Manage opens an allowlisted playit.gg sign-in link for linked accounts only");

  console.log("playit account service smoke passed (8 checks).");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
