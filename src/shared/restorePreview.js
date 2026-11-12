// Plain-language summary of the Agent's read-only restore preview
// (POST /api/v1/backups/restore with preview: true), shown in the restore
// confirmation so the user sees what will be replaced before anything runs.
// Side-effect free; Node smokes load the same file.
(function initializeRestorePreview(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxRestorePreview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createRestorePreviewApi() {
  "use strict";

  const MAX_PATHS = 6;

  function list(value) {
    return Array.isArray(value) ? value.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
  }

  function formatPaths(paths) {
    const clean = list(paths).filter((entry) => entry !== ".");
    if (!clean.length) return "";
    const shown = clean.slice(0, MAX_PATHS).join(", ");
    return clean.length > MAX_PATHS ? `${shown} and ${clean.length - MAX_PATHS} more` : shown;
  }

  // Warnings the Agent can attach to a preview, in plain words. Unknown codes
  // are passed through as-is so nothing is hidden.
  const WARNINGS = Object.freeze({
    RESTORE_TARGET_RUNNING: "The server is running. AnxOS stops it before restoring.",
    RESTORE_TARGET_INSTANCE_MISSING: "This server is no longer registered on that computer; the backup is restored into its folder.",
    RESTORE_TARGET_STATUS_UNAVAILABLE: "AnxOS could not check whether the server is running.",
    RESTORE_TARGET_WORLD_SCOPE_MISSING: "AnxOS could not find this server's world folder, so the safety copy may not cover the world.",
  });

  // Returns { lines, warnings } for the confirmation, or null when the
  // preview is missing or not a preview (the caller then uses its generic
  // wording).
  function describeRestorePreview(preview, { formatDate = (value) => value } = {}) {
    if (!preview || preview.preview !== true) return null;
    const scope = preview.scope || {};
    const backup = preview.backup || {};
    const lines = [];
    const backupPaths = formatPaths(scope.backupSourcePaths);
    if (scope.willWipeWholeInstance === false || scope.type === "world") {
      lines.push(`Only the world is replaced${backupPaths ? ` (${backupPaths})` : ""}. Other server files stay as they are.`);
    } else {
      lines.push("Everything in this server's folder is replaced with the backup. Files added since the backup are removed.");
    }
    if (backup.createdAt) lines.push(`The backup was taken ${formatDate(backup.createdAt)}.`);
    const safetyPaths = formatPaths(scope.safetySourcePaths);
    lines.push(scope.safetyType === "world"
      ? `AnxOS first keeps a safety copy of the current world${safetyPaths ? ` (${safetyPaths})` : ""}.`
      : "AnxOS first keeps a safety copy of the whole server, so you can undo this restore.");
    if (preview.conflict && preview.conflict.verdict === "new-restore") {
      lines.push("The backup goes into a different server; the original server is not changed.");
    }
    const warnings = list(preview.conflict && preview.conflict.warnings).map((code) => WARNINGS[code] || code);
    return { lines, warnings };
  }

  return Object.freeze({ describeRestorePreview, WARNINGS });
});
