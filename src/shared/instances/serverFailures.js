// Common server startup failures: recognised from the server's own output by
// the Agent (classifyServerOutput) and explained to the user by the renderer
// (explainServerFailure). One vocabulary for both sides.
//
// Dual-mode like the other shared modules: CommonJS for the Agent and Node
// smokes, and root.AnxServerFailures for the renderer <script> tag.
(function initializeServerFailures(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxServerFailures = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createServerFailuresApi() {
  "use strict";

  // Patterns are deliberately specific to failure lines, so normal log
  // chatter (a plugin mentioning "memory", a port in a banner) never matches.
  const OUTPUT_RULES = Object.freeze([
    {
      code: "PORT_IN_USE",
      // Restarting cannot free a port another program holds.
      suppressRestart: true,
      pattern: /\*{2,}\s*FAILED TO BIND TO PORT|java\.net\.BindException|\bAddress already in use\b|\bEADDRINUSE\b|Only one usage of each socket address/i,
    },
    {
      code: "OUT_OF_MEMORY",
      // A leak can recover after a restart; restart policy and crash-loop
      // protection decide.
      suppressRestart: false,
      pattern: /java\.lang\.OutOfMemoryError|\bOutOfMemoryError: Java heap space\b|There is insufficient memory for the Java Runtime Environment/i,
    },
    {
      code: "DISK_FULL",
      suppressRestart: true,
      pattern: /No space left on device|\bENOSPC\b|There is not enough space on the disk/i,
    },
  ]);

  function classifyServerOutput(text = "") {
    const value = String(text || "");
    if (!value) return null;
    const rule = OUTPUT_RULES.find((entry) => entry.pattern.test(value));
    return rule ? { code: rule.code, suppressRestart: rule.suppressRestart } : null;
  }

  // Plain explanation and the one next step, keyed by Agent failure codes.
  const EXPLANATIONS = Object.freeze({
    PORT_IN_USE: {
      title: "Its port is already taken",
      detail: "Another program, or another server, is already using this server's port, so it could not start.",
      fix: "Stop the other program, or give this server a different port in its Settings, then start it again.",
    },
    OUT_OF_MEMORY: {
      title: "It ran out of memory",
      detail: "The server needed more memory than it was allowed to use.",
      fix: "Raise its memory in Settings (for example from 2G to 4G), or remove heavy mods or plugins, then start it again.",
    },
    DISK_FULL: {
      title: "The computer's disk is full",
      detail: "The server could not write its files because the disk has no space left.",
      fix: "Free up space on that computer (old backups are a common cause), then start the server again.",
    },
    CRASH_LOOP: {
      title: "It kept crashing, so AnxHost stopped restarting it",
      detail: "The server crashed several times in a row. Automatic restarts were paused so it does not loop forever.",
      fix: "Open the console to see the error, fix it, then start the server again.",
    },
    EARLY_CLEAN_EXIT: {
      title: "It stopped right after starting",
      detail: "The server closed by itself a few seconds after starting, often because of a first-run setting such as an unaccepted EULA.",
      fix: "Open the console to see the last messages, then start it again.",
    },
    PROCESS_KILLED: {
      title: "It was stopped by the computer",
      detail: "Something outside AnxHost ended the server, for example the system running low on memory or a shutdown.",
      fix: "Start it again. If it keeps happening, give the computer more free memory or lower the server's memory.",
    },
    PROCESS_EXITED: {
      title: "It crashed",
      detail: "The server program ended with an error.",
      fix: "Open the console to see the error, then start it again.",
    },
    INVALID_COMMAND: {
      title: "Its start command does not work",
      detail: "The command used to start the server is missing a file or has a wrong option.",
      fix: "Repair or reinstall the server, or check its start command in Advanced settings.",
    },
  });

  function explainServerFailure(code) {
    const key = String(code || "").trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(EXPLANATIONS, key) ? { code: key, ...EXPLANATIONS[key] } : null;
  }

  return Object.freeze({ OUTPUT_RULES, classifyServerOutput, explainServerFailure });
});
