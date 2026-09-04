#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");

[
  "const agentPollingBackoff = new Map()",
  "function getAgentPollingBackoffKey",
  "function recordAgentPollingFailure",
  "function clearAgentPollingBackoff",
  "UNAUTHORIZED",
  "ECONNREFUSED",
  "LOCAL_AUTHENTICATION_REQUIRED",
  "AUTH_UNLOCK_REQUIRED",
  "nextRetryAt",
].forEach((needle) => assert(source.includes(needle), `Renderer Agent polling backoff missing ${needle}.`));

["amp", "system", "public-access", "backups", "instances", "docker"].forEach((feature) => {
  assert(source.includes(`shouldBackOffAgentPolling("${feature}"`) && source.includes(`recordAgentPollingFailure("${feature}"`) && source.includes(`clearAgentPollingBackoff("${feature}"`), `${feature} refresh path must use Agent polling backoff.`);
});

console.log("Agent polling backoff smoke checks passed.");
