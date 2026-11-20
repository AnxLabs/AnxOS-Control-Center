"use strict";

// AnxHost CC data-testid convention (Build 216, docs/anxhost/UI_PATTERNS.md,
// "Test identifiers"). Shared by the convention smoke and by Playwright suites
// that select redesigned UI.
//
//   data-testid="<area>-<thing>[-<qualifier>]"  kebab-case, lowercase ASCII
//   - <area> is one of AREAS (the Build 216 destinations);
//   - repeated items share one testid and carry their identity in another
//     data-*-id attribute (data-instance-id, data-node-id, data-template-id ...);
//   - never user data, hostnames, IP addresses, e-mail addresses or secrets;
//   - only tests read testids: application JavaScript selects by its data-*
//     behaviour hooks, never by data-testid.

const AREAS = Object.freeze([
  "shell", "nav", "home", "my-servers", "server", "add-server", "create-server", "template",
  "computers", "agent", "docker", "network", "files", "terminal", "backups", "activity",
  "security", "settings", "workspace", "dialog", "operation", "phone", "gallery",
]);

// Testids that existed before Build 216. They keep working unchanged because
// tests use them (qa-acceptance, capture-product-screenshots); renaming one
// is a deliberate change made together with its tests.
const LEGACY_TESTIDS = Object.freeze(["qa-mode-indicator"]);

const FORMAT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FORBIDDEN = [
  [/\b\d{1,3}(?:-\d{1,3}){3}\b/, "looks like an IP address"],
  [/@/, "contains @"],
  [/(?:token|secret|password|passwd|apikey|api-key)/, "names a secret"],
  [/-\d+$/, "ends with a bare index; use a data-*-id attribute for identity"],
];

function areaOf(testId) {
  return AREAS.filter((area) => testId === area || testId.startsWith(`${area}-`)).sort((a, b) => b.length - a.length)[0] || null;
}

// Returns [] when valid, otherwise a list of reasons.
function checkTestId(testId) {
  if (LEGACY_TESTIDS.includes(testId)) return [];
  const problems = [];
  if (!FORMAT.test(testId)) problems.push("not lowercase kebab-case");
  if (!areaOf(testId)) problems.push(`does not start with a known area (${AREAS.join(", ")})`);
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(testId)) problems.push(reason);
  return problems;
}

const selector = (testId) => `[data-testid="${testId}"]`;

module.exports = { AREAS, LEGACY_TESTIDS, FORMAT, checkTestId, areaOf, selector };
