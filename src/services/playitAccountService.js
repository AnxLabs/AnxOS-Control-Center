"use strict";

// playit account connection: the guided Install -> Start -> Link -> Tunnels
// flow, using playit's own browser-based linking.
//
// Security model
//   - AnxOS never sees a playit password and never reads playit's secret key.
//     Whether playit is linked is decided only from whether its key file
//     exists and is non-empty (fs.stat; contents are never opened).
//   - Linking runs `playit setup`, which provisions the key inside playit
//     itself; the user approves on playit.gg in their browser. It is refused
//     unless playit is running and reports no key, so an existing link (and
//     its tunnels) can never be replaced.
//   - The claim/setup link and the account sign-in link act like temporary
//     credentials. They are returned only as `linkUrl` to the trusted caller
//     (main process or the Agent's authenticated REST client), which opens
//     them in the browser; they are allowlisted to https://playit.gg and are
//     redacted from every message and diagnostic.
//
// Shared by the desktop main process (this computer) and the Agent (remote
// nodes). Every system call is injectable for tests.

const { execFile, spawn: defaultSpawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const playitService = require("./playitService");

const COMMAND_TIMEOUT_MS = 15000;
const LINK_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SESSION_OUTPUT_CHARS = 4000;
const PLAYIT_DOWNLOAD_URL = "https://playit.gg/download";
const URL_IN_TEXT = /https?:\/\/[^\s"'<>)]+/gi;

function isAllowedPlayitUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === "playit.gg" || host.endsWith(".playit.gg");
}

// The first allowlisted playit.gg link in a block of CLI output.
function extractPlayitUrl(text) {
  for (const candidate of String(text || "").match(URL_IN_TEXT) || []) {
    const cleaned = candidate.replace(/[.,;:!?]+$/, "");
    if (isAllowedPlayitUrl(cleaned)) return cleaned;
  }
  return null;
}

// Messages shown to people or written to diagnostics never carry a link or a
// long token (claim codes, keys).
function redactPlayitText(text) {
  return String(text || "")
    .replace(URL_IN_TEXT, "[link]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function runCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: options.timeout || COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
        errorCode: error?.code || null,
        stdout: stdout ? String(stdout) : "",
        stderr: stderr ? String(stderr) : "",
      });
    });
  });
}

function accountError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function createPlayitAccountService(overrides = {}) {
  const deps = {
    findBinary: () => playitService.findPlayitBinary(),
    getStatus: () => playitService.getPlayitStatus(),
    configCandidates: () => playitService.getConfigCandidates(),
    run: runCommand,
    spawn: defaultSpawn,
    stat: (filePath) => fs.stat(filePath),
    now: () => Date.now(),
    linkTimeoutMs: LINK_SESSION_TIMEOUT_MS,
    ...overrides,
  };
  const sessions = new Map();

  async function fileHasContent(filePath) {
    if (!filePath) return false;
    try {
      const info = await deps.stat(filePath);
      return Boolean(info?.isFile?.() !== false && Number(info?.size) > 0);
    } catch {
      return false;
    }
  }

  // true: linked, false: running and reports no key, null: cannot tell.
  async function detectLinked(binaryPath, running) {
    if (running) {
      const result = await deps.run(binaryPath, ["secret-path"]);
      if (!result.ok) return null;
      const reported = result.stdout.split(/\r?\n/).map((line) => line.trim().replace(/^"+|"+$/g, "")).filter(Boolean).pop();
      if (!reported || !path.isAbsolute(reported)) return null;
      return fileHasContent(reported);
    }
    for (const candidate of deps.configCandidates() || []) {
      if (await fileHasContent(candidate)) return true;
    }
    return null;
  }

  async function getAccountState() {
    const checkedAt = new Date(deps.now()).toISOString();
    const binary = await deps.findBinary().catch(() => null);
    if (!binary?.installed || !binary.path) {
      return { installed: false, running: false, linked: false, step: "install", downloadUrl: PLAYIT_DOWNLOAD_URL, checkedAt };
    }
    const status = await deps.getStatus().catch(() => null);
    const running = Boolean(status?.running);
    const linked = await detectLinked(binary.path, running);
    const step = !running ? "start" : linked === false ? "link" : linked === true ? "tunnels" : "start";
    return { installed: true, running, linked, step, checkedAt };
  }

  function sessionView(session) {
    return {
      id: session.id,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt || null,
      message: session.message || null,
      // Only the trusted caller receives the link; it opens it in the browser.
      linkUrl: session.linkUrl || null,
    };
  }

  function finish(session, state, message) {
    if (session.endedAt) return;
    session.state = state;
    session.message = message || null;
    session.endedAt = new Date(deps.now()).toISOString();
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
  }

  async function startLink() {
    for (const session of sessions.values()) {
      if (!session.endedAt) return sessionView(session);
    }
    const state = await getAccountState();
    if (!state.installed) throw accountError("PLAYIT_NOT_INSTALLED", "Install playit first.", 400);
    if (!state.running) throw accountError("PLAYIT_NOT_RUNNING", "Start playit before linking your account.", 409);
    if (state.linked === true) throw accountError("PLAYIT_ALREADY_LINKED", "playit is already linked to an account.", 409);
    if (state.linked !== false) {
      throw accountError("PLAYIT_LINK_STATE_UNKNOWN", "AnxOS could not confirm that playit is unlinked, so it will not start linking.", 409);
    }
    const binary = await deps.findBinary();
    const session = {
      id: crypto.randomUUID(),
      state: "starting",
      startedAt: new Date(deps.now()).toISOString(),
      endedAt: null,
      message: null,
      linkUrl: null,
      output: "",
      child: null,
      timer: null,
    };
    sessions.set(session.id, session);
    let child;
    try {
      child = deps.spawn(binary.path, ["setup"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(session, "failed", redactPlayitText(error?.message || "playit setup could not start."));
      return sessionView(session);
    }
    session.child = child;
    const onOutput = (chunk) => {
      const text = String(chunk || "");
      session.output = `${session.output}${text}`.slice(-MAX_SESSION_OUTPUT_CHARS);
      if (!session.linkUrl) {
        const url = extractPlayitUrl(session.output);
        if (url) {
          session.linkUrl = url;
          if (!session.endedAt) session.state = "awaiting-approval";
        }
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", (error) => finish(session, "failed", redactPlayitText(error?.message || "playit setup failed.")));
    child.on("exit", async (code) => {
      if (session.endedAt) return;
      if (code === 0) {
        const linked = await detectLinked(binary.path, true).catch(() => null);
        finish(session, linked === true ? "linked" : "failed", linked === true ? null : "playit setup finished, but no linked account was found.");
      } else {
        finish(session, "failed", redactPlayitText(session.output) || `playit setup exited with code ${code}.`);
      }
    });
    session.timer = setTimeout(() => {
      if (session.endedAt) return;
      try { child.kill(); } catch {}
      finish(session, "expired", "The link was not approved in time. Start linking again when you are ready.");
    }, deps.linkTimeoutMs);
    session.timer.unref?.();
    return sessionView(session);
  }

  function getLink(id) {
    const session = sessions.get(String(id || ""));
    if (!session) throw accountError("PLAYIT_LINK_NOT_FOUND", "That linking attempt is no longer available.", 404);
    return sessionView(session);
  }

  function cancelLink(id) {
    const session = sessions.get(String(id || ""));
    if (!session) throw accountError("PLAYIT_LINK_NOT_FOUND", "That linking attempt is no longer available.", 404);
    if (!session.endedAt) {
      try { session.child?.kill(); } catch {}
      finish(session, "cancelled", "Linking was cancelled.");
    }
    return sessionView(session);
  }

  // A sign-in link to the playit.gg dashboard for the linked account.
  async function getManageLink() {
    const state = await getAccountState();
    if (!state.installed) throw accountError("PLAYIT_NOT_INSTALLED", "Install playit first.", 400);
    if (!state.running) throw accountError("PLAYIT_NOT_RUNNING", "Start playit to open your playit.gg account.", 409);
    if (state.linked !== true) throw accountError("PLAYIT_NOT_LINKED", "Link your playit account first.", 409);
    const binary = await deps.findBinary();
    const result = await deps.run(binary.path, ["account", "login-url"]);
    const linkUrl = result.ok ? extractPlayitUrl(`${result.stdout}\n${result.stderr}`) : null;
    if (!linkUrl) {
      throw accountError("PLAYIT_LOGIN_LINK_UNAVAILABLE", redactPlayitText(result.stderr || result.stdout) || "playit did not return a sign-in link.", 502);
    }
    return { linkUrl };
  }

  return {
    getAccountState,
    startLink,
    getLink,
    cancelLink,
    getManageLink,
  };
}

const defaultService = createPlayitAccountService();

module.exports = {
  PLAYIT_DOWNLOAD_URL,
  createPlayitAccountService,
  isAllowedPlayitUrl,
  extractPlayitUrl,
  redactPlayitText,
  getPlayitAccountState: defaultService.getAccountState,
  startPlayitLink: defaultService.startLink,
  getPlayitLink: defaultService.getLink,
  cancelPlayitLink: defaultService.cancelLink,
  getPlayitManageLink: defaultService.getManageLink,
};
