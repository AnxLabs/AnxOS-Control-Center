const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

function functionBody(name) {
  const marker = `function ${name}`;
  const start = app.indexOf(marker);
  assert(start >= 0, `Missing renderer function: ${name}`);
  const braceStart = app.indexOf("{", start);
  assert(braceStart >= 0, `Missing function body for: ${name}`);
  let depth = 0;
  for (let index = braceStart; index < app.length; index += 1) {
    const char = app[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return app.slice(braceStart, index + 1);
      }
    }
  }
  throw new Error(`Could not parse function body for: ${name}`);
}

function assertFunctionAvoidsHtmlStrings(name) {
  const body = functionBody(name);
  assert(!/\.innerHTML\s*=/.test(body), `${name} must not assign innerHTML.`);
  assert(!/insertAdjacentHTML\s*\(/.test(body), `${name} must not insert adjacent HTML.`);
  assert(!/document\.write\s*\(/.test(body), `${name} must not use document.write.`);
  assert(!/\.outerHTML\s*=/.test(body), `${name} must not assign outerHTML.`);
}

function sourceBetween(startNeedle, endNeedle) {
  const start = app.indexOf(startNeedle);
  assert(start >= 0, `Missing source marker: ${startNeedle}`);
  const end = app.indexOf(endNeedle, start + startNeedle.length);
  assert(end >= 0, `Missing source end marker: ${endNeedle}`);
  return app.slice(start, end);
}

[
  "createTextElement",
  "createSvgElement",
  "appendDetailPair",
  "createEmptyState",
  "createSecurityBadgeElement",
].forEach((name) => assert(app.includes(`function ${name}`), `Missing safe renderer helper: ${name}`));

[
  "renderAgentDiagnostics",
  "renderOwnerPageList",
  "renderOwnerFlags",
  "renderOwnerCommands",
  "renderOwnerApiHistory",
  "renderOwnerLogs",
  "renderStorageConnections",
  "renderSshSessionTabs",
  "renderSecurityDashboard",
  "renderSecurityRecommendations",
  "dismissSecurityRecommendation",
  "renderSecuritySessions",
  "renderSecurityTrustedDevices",
  "renderSecurityToken",
  "renderSecurityEvents",
  "createAgentRobotIcon",
  // Cycle-14 surfaces: the alerts panel renders Agent-derived alert titles,
  // conditions and targets, and the jobs panel renders job type/stage/error
  // text from a node. Both must build DOM without HTML strings.
  "renderAlertsPanel",
  "createAlertItem",
  "renderDurableJobs",
  "createDurableJobItem",
].forEach(assertFunctionAvoidsHtmlStrings);

// The AMP panel link is the one place a node-supplied value reaches an `href`,
// so the gate that validates its scheme must exist AND be the thing that decides
// the assignment. The behavioral proof for both lives in
// scripts/amp-panel-url-gate-smoke.js (it drives the real href assignment with a
// fake anchor); these are presence checks only, kept because a deleted gate is
// the first step of a regression.
assert(app.includes("function getSafeAmpPanelUrl"), "The AMP panel URL gate must exist.");
assert(/href\s*=\s*safePanelUrl/.test(app), "The AMP panel href must be assigned from the validated URL, never the raw value.");

assert(!/insertAdjacentHTML\s*\(/.test(app), "Renderer must not use insertAdjacentHTML.");
assert(!/document\.write\s*\(/.test(app), "Renderer must not use document.write.");
assert(!/\.outerHTML\s*=/.test(app), "Renderer must not assign outerHTML.");
assert(!/\son(?:click|error|load|submit|change|mouseover|keydown)\s*=/.test(app), "Renderer-generated markup must not define inline event handlers.");
assert(!app.includes("function createSecurityBadge("), "Security badges should be DOM elements, not HTML string helpers.");
assert(app.includes("review.dataset.securityRecommendation = String(item.id || \"\")"), "Security recommendation IDs should be assigned through dataset values.");
assert(app.includes("revoke.dataset.securityRevokeSession = String(session.id || \"\")"), "Security session actions should assign dataset values without HTML interpolation.");
assert(app.includes("pre = createTextElement(\"pre\", JSON.stringify(event.details || {}, null, 2)"), "Security event details should render as text.");
assert(app.includes("svg.append(") && app.includes("createSvgElement(\"path\""), "Agent icon SVG should be created through DOM APIs.");

const remainingInnerHtml = [...app.matchAll(/innerHTML\s*=/g)].map((match) => {
  const prefix = app.slice(0, match.index);
  const functionMatch = [...prefix.matchAll(/\nfunction\s+([A-Za-z0-9_]+)\s*\(/g)].pop();
  return functionMatch?.[1] || "unknown";
});
assert.deepStrictEqual(
  remainingInnerHtml,
  ["renderUpdateModal"],
  `Unexpected innerHTML assignments remain: ${remainingInnerHtml.join(", ")}`,
);

assert(sourceBetween("function createSecurityConfirmation", "function createSecurityTextPrompt").includes("document.createElement(\"section\")"), "Security confirmation should use safe DOM construction.");
assert(sourceBetween("function createSecurityTextPrompt", "const SECURITY_OPERATION_ACTIONS").includes("document.createElement(\"section\")"), "Security text prompt should use safe DOM construction.");
// The sanitizer must escape quotes as well as the tag delimiters: URLs are
// interpolated into a double-quoted href attribute by renderMarkdownLite, so
// an unescaped `"` is an attribute-injection vector (security-lane finding).
assert(functionBody("sanitizeMarkdownText").includes('replace(/[<>&"\']/g'), "Markdown sanitizer must escape HTML-sensitive characters including quotes.");
assert(functionBody("sanitizeMarkdownText").includes("&quot;") && functionBody("sanitizeMarkdownText").includes("&#39;"), "Markdown sanitizer must map quotes to entities.");
assert(sourceBetween("function renderMarkdownLite", "function formatUpdateDate").includes("sanitizeMarkdownText("), "Release note markdown renderer must sanitize input before allowlisted formatting.");
assert(functionBody("buildDiagnosticsHealthChecks").includes("const desktopApiState = getDesktopApiState();"), "Diagnostics health checks must not rely on an unsafe global desktopApiState.");

console.log("Renderer safety smoke checks passed.");
