#!/usr/bin/env node
"use strict";

// Duplicated shell prompts on the SSH page (Anxlab). Two causes:
// 1. The service wrote "\r" into the shell as soon as it opened, so the login
//    shell printed a second prompt, sometimes before or inside the banner.
// 2. The renderer wrote a new session's first chunk straight into the terminal
//    and then switched sessions with xterm clear(), which keeps the cursor
//    line: the previous session's prompt survived in front of the new banner
//    and the first chunk was replayed a second time.
// The renderer half runs the real app.js functions against a fake xterm that
// models clear() (keeps the cursor line) and reset() (wipes everything).
// Run: node scripts/ssh-terminal-session-output-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-ssh-output-"));
process.env.ANXHUB_CONFIG_DIR = root;
process.env.ANXOS_SELECTED_NODE_ID = "output-node";
const { SshService } = require("../src/services/sshService");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };

function extract(name, nextName) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(`function ${nextName}(`, start);
  assert(start > -1 && end > start, `could not extract ${name}`);
  return appSource.slice(start, end);
}

class FakeXterm {
  constructor() { this.screen = ""; this.options = {}; }
  write(text) { this.screen += String(text).replace(/\r\n/g, "\n").replace(/\r/g, ""); }
  clear() { this.screen = this.screen.slice(this.screen.lastIndexOf("\n") + 1); }
  reset() { this.screen = ""; }
  resize() {}
}

function createRenderer() {
  const sandbox = {
    SSH_OUTPUT_LINE_LIMIT: 1500,
    SSH_TERMINAL_DEFAULT_COLS: 120,
    SSH_TERMINAL_DEFAULT_ROWS: 32,
    sshSessions: new Map(),
    activeSshSessionId: null,
    sshXtermSessionId: null,
    sshXterm: new FakeXterm(),
    sshOutputList: null,
    measureSshTerminalSize: () => ({ cols: 120, rows: 32 }),
    bindSshXtermInput: () => {},
    renderSshView: () => {},
  };
  sandbox.ensureSshXterm = () => sandbox.sshXterm;
  const code = [
    extract("createSshTerminalBuffer", "getSshTerminalBuffer"),
    extract("getSshTerminalBuffer", "getSshRenderableRows"),
    extract("syncSshXtermSession", "renderSshOutput"),
    "function renderSshOutput(session) { syncSshXtermSession(session); }",
    extract("appendSshOutput", "getSshSessionStatusLabel"),
    "this.appendSshOutput = appendSshOutput; this.renderSshOutput = renderSshOutput;",
  ].join("\n");
  vm.runInNewContext(code, sandbox);
  return sandbox;
}

const BANNER = "Linux Anxlab 6.1.0-26-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.112-1 x86_64\r\n\r\nThe programs included with the Debian GNU/Linux system are free software;\r\n";
const LAST_LOGIN = "Last login: Thu Oct 29 21:02:11 2026 from 10.0.0.2\r\n";
const PROMPT = "anx@Anxlab:~$ ";
const count = (text, needle) => text.split(needle).length - 1;

async function main() {
  const r = createRenderer();
  const open = (id) => { r.sshSessions.set(id, { id, status: "connected" }); r.activeSshSessionId = id; };

  // T1 initial connection: banner, then exactly one prompt on its own line.
  open("s1");
  r.appendSshOutput("s1", BANNER);
  r.appendSshOutput("s1", LAST_LOGIN);
  r.appendSshOutput("s1", PROMPT);
  assert.strictEqual(count(r.sshXterm.screen, "anx@Anxlab:~$"), 1, r.sshXterm.screen);
  assert.ok(r.sshXterm.screen.startsWith("Linux Anxlab"), "the banner starts the terminal");
  assert.strictEqual(count(r.sshXterm.screen, "Linux Anxlab"), 1, "the first chunk is shown once");
  pass("T1 first connection shows the banner once and one prompt");

  // T2 command execution output is appended once, in order.
  r.appendSshOutput("s1", "uptime\r\n");
  r.appendSshOutput("s1", " 03:10:00 up 21 days\r\n");
  r.appendSshOutput("s1", PROMPT);
  assert.strictEqual(count(r.sshXterm.screen, "up 21 days"), 1);
  assert.strictEqual(count(r.sshXterm.screen, "anx@Anxlab:~$"), 2, "one prompt before and one after the command");
  pass("T2 command output appears once, followed by a single new prompt");

  // T3 reconnection: the old prompt must not be left in front of the banner.
  // connectSshSession renders the new session before any output arrives.
  r.sshSessions.get("s1").status = "disconnected";
  open("s2");
  r.renderSshOutput(r.sshSessions.get("s2"));
  r.appendSshOutput("s2", BANNER);
  assert.ok(r.sshXterm.screen.startsWith("Linux Anxlab"), `the old prompt was prepended to the banner: ${JSON.stringify(r.sshXterm.screen.slice(0, 40))}`);
  assert.strictEqual(count(r.sshXterm.screen, "Linux Anxlab"), 1, "the first chunk of the new session is not doubled");
  r.appendSshOutput("s2", LAST_LOGIN);
  r.appendSshOutput("s2", PROMPT);
  assert.strictEqual(count(r.sshXterm.screen, "anx@Anxlab:~$"), 1);
  pass("T3 a reconnection starts clean: no carried-over prompt, banner shown once");

  // T3b output arriving before the terminal switches, with a first chunk that
  // ends mid-line (as SSH chunks often do).
  r.sshSessions.get("s2").status = "disconnected";
  open("s2b");
  r.appendSshOutput("s2b", "Linux Anxlab 6.1.0-26");
  r.appendSshOutput("s2b", "-amd64 x86_64\r\n");
  r.appendSshOutput("s2b", PROMPT);
  assert.ok(r.sshXterm.screen.startsWith("Linux Anxlab 6.1.0-26-amd64"), JSON.stringify(r.sshXterm.screen.slice(0, 60)));
  assert.strictEqual(count(r.sshXterm.screen, "Linux Anxlab"), 1, JSON.stringify(r.sshXterm.screen));
  assert.strictEqual(count(r.sshXterm.screen, "anx@Anxlab:~$"), 1, JSON.stringify(r.sshXterm.screen));
  pass("T3b a partial first chunk is neither doubled nor appended to the old prompt");

  // T4 several sessions: switching tabs replays each session's own output once.
  open("s3");
  r.appendSshOutput("s3", "vps banner\r\ndebian@vps:~$ ");
  r.activeSshSessionId = "s2";
  r.renderSshOutput(r.sshSessions.get("s2"));
  assert.strictEqual(count(r.sshXterm.screen, "anx@Anxlab:~$"), 1);
  assert.strictEqual(count(r.sshXterm.screen, "debian@vps"), 0);
  r.appendSshOutput("s3", "background output\r\n");
  assert.strictEqual(count(r.sshXterm.screen, "background output"), 0, "inactive sessions don't write into the visible terminal");
  r.activeSshSessionId = "s3";
  r.renderSshOutput(r.sshSessions.get("s3"));
  assert.strictEqual(count(r.sshXterm.screen, "debian@vps:~$"), 1);
  assert.strictEqual(count(r.sshXterm.screen, "background output"), 1);
  pass("T4 switching between sessions shows each session's output once");

  // T5 long output (scrollback): every line once, the last line is the tail.
  for (let line = 0; line < 400; line += 1) r.appendSshOutput("s3", `line-${line}\r\n`);
  r.appendSshOutput("s3", "debian@vps:~$ ");
  assert.strictEqual(count(r.sshXterm.screen, "line-399\n"), 1);
  assert.strictEqual(count(r.sshXterm.screen, "line-0\n"), 1);
  assert.ok(r.sshXterm.screen.endsWith("debian@vps:~$ "));
  pass("T5 long output streams once and ends at the prompt");

  // T6 service: one shell per connection, and nothing is typed into it.
  class ShellClient extends EventEmitter {
    constructor() { super(); this.shells = 0; this.writes = []; }
    connect() { queueMicrotask(() => this.emit("ready")); }
    shell(options, callback) {
      this.shells += 1;
      const stream = new EventEmitter();
      stream.writable = true;
      stream.write = (data) => { this.writes.push(data); };
      stream.end = () => {};
      queueMicrotask(() => callback(null, stream));
    }
    end() {}
    destroy() {}
  }
  const clients = [];
  const service = new SshService({ createClient: () => { const client = new ShellClient(); clients.push(client); return client; } });
  service.getProfile = () => ({ id: "anxlab", nodeId: "output-node", displayName: "Anxlab", host: "127.0.0.1", port: 22, username: "anx", authType: "password" });
  const first = service.connect({ profileId: "anxlab", nodeId: "output-node", password: "fixture-only" });
  const deadline = Date.now() + 3000;
  while (service.sessions.get(first.id)?.shellReady !== true && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.strictEqual(service.sessions.get(first.id)?.status, "connected");
  assert.deepStrictEqual(clients[0].writes, [], "opening the shell must not send a keystroke");
  const again = service.connect({ profileId: "anxlab", nodeId: "output-node", password: "fixture-only" });
  assert.strictEqual(again.id, first.id, "connecting an already-connected profile reuses its session");
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].shells, 1);
  service.write(first.id, "whoami\r");
  assert.deepStrictEqual(clients[0].writes, ["whoami\r"], "user input still reaches the shell");
  service.disconnect(first.id);
  pass("T6 one shell per connection, no injected keystroke, user input still delivered");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`ssh terminal session output smoke passed (${results} checks).`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
