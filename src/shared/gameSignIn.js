"use strict";

// Game-server account sign-in ("device code" flows a server prints to its
// console). Shared by the Agent, which reads the challenge from the server's
// output, and the desktop, which opens the sign-in page in the default
// browser. AnxOS only relays the publisher's own link and code: it never sees,
// stores or submits account credentials.
//
// This file must stay dependency-free: Electron Builder copies src/shared/**/*
// into the standalone agent runtime.

const SIGN_IN_ADAPTERS = Object.freeze({
  hytale: Object.freeze({
    game: "hytale",
    label: "Hytale account",
    // Hytale's own console command for the OAuth device flow.
    command: "auth login device",
    // The instance needs sign-in while it reports this readiness reason.
    requiredReason: "HYTALE_AUTH_REQUIRED",
    // Only links on the publisher's sign-in host are ever opened.
    allowedHosts: Object.freeze(["oauth.accounts.hytale.com"]),
    patterns: Object.freeze({
      verificationUrl: /\bVisit:\s+(https:\/\/\S+)/,
      verificationUrlComplete: /\bOr visit:\s+(https:\/\/\S+)/,
      userCode: /\bEnter code:\s+([A-Za-z0-9-]{4,16})\b/,
      expiresInSeconds: /\bexpires in (\d{1,5}) seconds\b/,
      succeeded: /\bAuthentication successful\b/,
    }),
  }),
});

function getSignInAdapter(game) {
  return SIGN_IN_ADAPTERS[String(game || "").toLowerCase()] || null;
}

function isAllowedSignInUrl(game, rawUrl) {
  const adapter = getSignInAdapter(game);
  if (!adapter) return false;
  try {
    const url = new URL(String(rawUrl || ""));
    return url.protocol === "https:" && adapter.allowedHosts.includes(url.hostname);
  } catch {
    return false;
  }
}

// Reads one chunk of server output and returns what it adds to the current
// challenge: { verificationUrl, verificationUrlComplete, userCode,
// expiresInSeconds } fields that were found, { succeeded: true } when the
// sign-in completed, or null. Links outside the adapter's hosts are ignored.
function parseSignInOutput(game, text) {
  const adapter = getSignInAdapter(game);
  if (!adapter) return null;
  const found = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const clean = line.replace(/\u001b\[[0-9;]*m/g, "");
    if (adapter.patterns.succeeded.test(clean)) {
      found.succeeded = true;
      continue;
    }
    const complete = clean.match(adapter.patterns.verificationUrlComplete)?.[1];
    if (complete && isAllowedSignInUrl(game, complete)) {
      found.verificationUrlComplete = complete;
      continue;
    }
    const url = clean.match(adapter.patterns.verificationUrl)?.[1];
    if (url && isAllowedSignInUrl(game, url)) found.verificationUrl = url;
    const code = clean.match(adapter.patterns.userCode)?.[1];
    if (code) found.userCode = code;
    const expires = clean.match(adapter.patterns.expiresInSeconds)?.[1];
    if (expires) found.expiresInSeconds = Number(expires);
  }
  return Object.keys(found).length > 0 ? found : null;
}

// The challenge a caller may act on, or null when there is none, it is
// incomplete, it has expired, or its link is not on an allowed host.
function usableSignInChallenge(game, challenge, now = Date.now()) {
  if (!challenge || !challenge.userCode) return null;
  const link = challenge.verificationUrlComplete || challenge.verificationUrl;
  if (!isAllowedSignInUrl(game, link)) return null;
  const expiresAt = Date.parse(challenge.expiresAt || "");
  if (Number.isFinite(expiresAt) && expiresAt <= now) return null;
  return { ...challenge, openUrl: link };
}

module.exports = {
  SIGN_IN_ADAPTERS,
  getSignInAdapter,
  isAllowedSignInUrl,
  parseSignInOutput,
  usableSignInChallenge,
};
