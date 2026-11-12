// Shared, side-effect-free helpers for preparing node dependencies (Java,
// SteamCMD, Tailscale, ...). The renderer's single prepare flow
// (prepareNodeDependencies in app.js) uses these to read the Agent's install
// plan and verify the install result; Node smokes load the same file.
(function initializeDependencyPreparation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxDependencyPreparation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDependencyPreparationApi() {
  "use strict";

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  // What the plan asks of the user:
  //   "not-needed"  the Agent reports nothing to install;
  //   "installable" at least one action the trusted installer can run;
  //   "manual"      only manual steps (or an unusable plan).
  function classifyPlan(plan = {}) {
    const installable = list(plan?.installableActions);
    if (installable.length > 0) return "installable";
    if (plan?.ok === true && list(plan?.manualActions).length === 0) return "not-needed";
    return "manual";
  }

  // The confirmation dialog shows exactly what will run on the computer, so
  // packages and commands stay visible even in the plain-language flow.
  function formatPlan(plan = {}) {
    const installable = list(plan?.installableActions);
    const manual = list(plan?.manualActions);
    const commandLines = installable
      .flatMap((action) => list(action?.commands).map((command) => command?.display || `${command?.command || ""} ${list(command?.args).join(" ")}`.trim()))
      .filter(Boolean);
    const packageLines = installable.map((action) => {
      const packages = list(action?.packages).length ? action.packages.join(", ") : "no package mapping";
      return `${action?.displayName || action?.id}: ${packages}`;
    });
    const manualLines = manual.map((action) => `${action?.displayName || action?.id}: ${action?.reason || "manual installation required"}`);
    const parts = [];
    if (packageLines.length) parts.push(`Packages:\n${packageLines.join("\n")}`);
    if (commandLines.length) parts.push(`Commands:\n${commandLines.join("\n")}`);
    if (manualLines.length) parts.push(`Manual steps still required:\n${manualLines.join("\n")}`);
    return parts.join("\n\n") || "No dependency changes are planned.";
  }

  // Dependency ids the Agent's post-install verification still reports as
  // missing. Only the explicit list counts: a result's full dependency list
  // also contains optional tools that are legitimately absent.
  function getStillMissingIds(installResult = {}) {
    return list(installResult?.missingDependencyIds).map(String).filter(Boolean);
  }

  // "Java", "Java and SteamCMD", "Java, SteamCMD and 7-Zip".
  function joinNames(names = []) {
    const clean = list(names).map((name) => String(name || "").trim()).filter(Boolean);
    if (clean.length <= 1) return clean[0] || "";
    return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
  }

  function describeDependencies(dependencies = []) {
    return joinNames(list(dependencies).map((dependency) => (
      typeof dependency === "string" ? dependency : dependency?.displayName || dependency?.label || dependency?.id
    )));
  }

  return Object.freeze({
    classifyPlan,
    formatPlan,
    getStillMissingIds,
    joinNames,
    describeDependencies,
  });
});
