"use strict";

// "Sign in" for game servers that need an account sign-in (for example
// Hytale's OAuth device flow). Starts the game's own sign-in command when no
// usable code is pending, then opens the publisher's sign-in page in the
// default browser. The link comes from the Agent's view of the server's
// output, never from the renderer, and must be on the game's allowed host.

const { getSignInAdapter, isAllowedSignInUrl } = require("../shared/gameSignIn");
const { getInstanceStatus, sendInstanceCommand } = require("./serviceRouter");
const { openExternalUrl } = require("./externalUrlService");

const CHALLENGE_WAIT_MS = 15000;
const CHALLENGE_POLL_MS = 750;

function createSignInError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unwrapInstance(status) {
  return status?.instance || status || null;
}

async function readSignInState(instanceId, options) {
  const instance = unwrapInstance(await getInstanceStatus(instanceId, options));
  return { instance, signIn: instance?.signIn || null };
}

async function openInstanceSignIn(instanceId, options = {}, deps = {}) {
  const wait = deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  let { instance, signIn } = await readSignInState(instanceId, options);
  const adapter = getSignInAdapter(signIn?.game);
  if (!signIn?.supported || !adapter) {
    throw createSignInError("This server does not use an account sign-in.", "SIGN_IN_UNSUPPORTED");
  }
  if (!instance.processRunning) {
    throw createSignInError("Start the server first; it shows its sign-in code while it runs.", "SIGN_IN_SERVER_NOT_RUNNING");
  }

  let started = false;
  if (!signIn.challenge) {
    await sendInstanceCommand(instanceId, adapter.command, options);
    started = true;
    const deadline = now() + CHALLENGE_WAIT_MS;
    while (!signIn?.challenge && now() < deadline) {
      await wait(CHALLENGE_POLL_MS);
      ({ signIn } = await readSignInState(instanceId, options));
    }
    if (!signIn?.challenge) {
      throw createSignInError("The server did not show a sign-in code. Check its console.", "SIGN_IN_CODE_TIMEOUT");
    }
  }

  const { openUrl, userCode, expiresAt } = signIn.challenge;
  if (!isAllowedSignInUrl(adapter.game, openUrl)) {
    throw createSignInError("The sign-in link is not on the publisher's sign-in site, so it was not opened.", "SIGN_IN_URL_BLOCKED");
  }
  await openExternalUrl(openUrl, { source: "instance-sign-in", allowedHosts: [...adapter.allowedHosts] });
  return { opened: true, started, label: adapter.label, userCode, expiresAt: expiresAt || null };
}

module.exports = {
  openInstanceSignIn,
};
