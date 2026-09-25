const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

function requireIndex(needle, message) {
  assert(index.includes(needle), message || `index.html is missing ${needle}`);
}

function requireApp(needle, message) {
  assert(app.includes(needle), message || `app.js is missing ${needle}`);
}

function requireStyle(needle, message) {
  assert(styles.includes(needle), message || `styles.css is missing ${needle}`);
}

[
  "data-command-palette-open",
  "data-command-palette",
  'role="dialog" aria-modal="true"',
  "data-command-palette-input",
  "data-command-palette-results",
  "data-command-palette-status",
  "data-command-palette-recents",
  "data-command-palette-clear-recents",
  "Ctrl Shift P",
].forEach((needle) => requireIndex(needle, `Command Palette shell must expose ${needle}.`));

[
  "const commandPaletteState",
  "COMMAND_PALETTE_RECENTS_STORAGE_KEY",
  "COMMAND_PALETTE_DEBOUNCE_MS",
  "function createCommand",
  "function getCommandRegistry",
  "function openCommandPalette",
  "function closeCommandPalette",
  "function filterCommandPalette",
  "function renderCommandPalette",
  "function runCommandPaletteCommand",
  "function handleCommandPaletteKeydown",
  "function rememberCommand",
  "function readCommandPaletteRecents",
  "function writeCommandPaletteRecents",
].forEach((needle) => requireApp(needle, `Command Palette renderer must implement ${needle}.`));

[
  'id: "search.open"',
  'id: "agent.refresh"',
  'id: `agent.${action}`',
  'id: "marketplace.refresh"',
  'id: "files.refresh"',
  'id: "files.upload"',
  'id: `diagnostics.${action}`',
  'id: "maintenance.scan"',
  'id: "maintenance.clearSafe"',
  'id: "maintenance.resetUi"',
  'id: "operations.clearCompleted"',
  'id: "security.refresh"',
  'id: "security.sessions"',
  'id: "security.trustedDevices"',
  'id: "security.recommendations"',
  'id: "security.notifications"',
  'id: "security.rotateAgentToken"',
  'id: "security.logoutAll"',
  'id: "account.signIn"',
  'id: "account.signOut"',
  'id: "updates.check"',
  'id: "updates.install"',
  'id: "owner.refresh"',
  'id: "workspace.refresh-active"',
  'shortcut: "Ctrl+Shift+R"',
  'id: `nav.shortcut.${page}`',
].forEach((needle) => requireApp(needle, `Command registry missing ${needle}.`));

assert(
  app.includes("isOwnerWorkspaceAuthorized()") && app.includes('id: "owner.refresh"'),
  "Owner commands must be permission gated.",
);
assert(
  app.includes("confirm: { title: \"Reset renderer UI state?\"") &&
    app.includes("confirm: { title: \"Rotate Agent token?\"") &&
    app.includes("confirm: { title: \"Sign out of AnxOS account?\""),
  "Sensitive Command Palette commands must require confirmation.",
);
assert(
  app.includes("showPage(\"operations\")") &&
    app.includes("persistOperationHistory()") &&
    app.includes("showPage(\"maintenance\")") &&
    app.includes("scanMaintenanceStorage({ trackOperation: true })"),
  "Commands must reuse existing Operations and Maintenance behavior.",
);
assert(
  app.includes("refreshCurrentFilesDirectory()") &&
    app.includes("runDiagnosticsAction(action)") &&
    app.includes("runAgentControlAction(action)"),
  "Commands must reuse existing Files, Diagnostics, and Agent action paths.",
);
assert(
  app.includes('event.key.toLowerCase() === "p"') &&
    app.includes("event.shiftKey") &&
    app.includes("event.ctrlKey || event.metaKey") &&
    app.includes('event.key === "Escape"') &&
    app.includes('event.key === "ArrowDown"') &&
    app.includes('event.key === "ArrowUp"') &&
    app.includes('event.key === "Enter"'),
  "Command Palette shortcut and keyboard navigation must be wired.",
);
assert(
  app.includes('"1": "dashboard"') &&
    app.includes('"5": "agent-control"') &&
    app.includes("refreshActiveWorkspace()") &&
    app.includes("!document.body.classList.contains(\"has-open-modal\")"),
  "Primary workspace shortcuts and modal-safe active refresh must be wired.",
);
assert(
  app.includes("COMMAND_PALETTE_RECENTS_STORAGE_KEY,") &&
    app.includes("window.localStorage.setItem(COMMAND_PALETTE_RECENTS_STORAGE_KEY") &&
    app.includes("recentCommandIds"),
  "Recent commands must store command IDs and reset with UI state.",
);
assert(
  app.includes("appendHighlightedText(title, command.title") &&
    !app.includes("commandPaletteResults.innerHTML") &&
    !app.includes("eval("),
  "Command Palette must render safely and avoid arbitrary execution.",
);
assert(
  app.includes('id: "commands"') && app.includes("Open Command Palette"),
  "Global Search should expose a bridge result for opening the Command Palette.",
);

[
  ".command-palette-backdrop",
  ".command-palette-dialog",
  ".command-palette-input",
  ".command-palette-results",
  ".command-palette-result.is-active",
  ".command-palette-result.is-disabled",
  ".command-palette-empty",
].forEach((needle) => requireStyle(needle, `Command Palette CSS must include ${needle}.`));

console.log("Command Palette smoke checks passed.");
