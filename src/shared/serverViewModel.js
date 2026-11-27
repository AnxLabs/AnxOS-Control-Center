// Phase 5 server view: the pure rules behind one server's page (status
// wording, tab layout, live-reading freshness, restart-required tracking,
// settings validation and add-on support). No DOM and no I/O, so the same
// rules are tested in Node and used by the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxServerViewModel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Six main tabs. The panel id "mods" is kept so existing handlers work.
  const MAIN_TABS = Object.freeze(["overview", "console", "files", "mods", "backups", "settings"]);
  const TAB_LABELS = Object.freeze({ overview: "Overview", console: "Console", files: "Files", mods: "Add-ons", backups: "Backups", settings: "Settings" });
  // Detail views reached from a main tab keep that tab highlighted.
  const TAB_PARENT = Object.freeze({ players: "overview", performance: "overview", network: "settings" });

  function mainTabFor(tab) {
    const name = String(tab || "overview");
    if (MAIN_TABS.includes(name)) return name;
    return TAB_PARENT[name] || "overview";
  }

  function stateKey(state) {
    return String(state || "").trim().toLowerCase().replace(/\s+/g, "-");
  }

  // One plain-language status for the header and Overview. A running
  // operation wins over the last reported state; a disconnected computer
  // never reports a server as running.
  function describeServerStatus(input = {}) {
    const state = stateKey(input.state);
    const operation = input.operation || null;
    if (input.computerConnected === false) {
      return { key: "unknown", label: "Computer offline", tone: "muted", detail: "AnxHost can't reach this server's computer, so its state is unknown." };
    }
    if (operation && operation.status === "running") {
      const labels = { start: "Starting", stop: "Stopping", restart: "Restarting", reload: "Restarting", update: "Updating" };
      return { key: "busy", label: labels[operation.type] || "Working", tone: "busy", detail: "Please wait, AnxHost is working on this server." };
    }
    if (state === "running") {
      return input.ready === false
        ? { key: "starting", label: "Starting", tone: "busy", detail: "The server process is up and still loading." }
        : { key: "running", label: "Running", tone: "ok", detail: "The server is up." };
    }
    if (state === "starting" || state === "restarting") return { key: "starting", label: "Starting", tone: "busy", detail: "The server is starting." };
    if (state === "stopping") return { key: "busy", label: "Stopping", tone: "busy", detail: "The server is shutting down." };
    if (state === "failed" || state === "crashed" || state === "error") {
      return { key: "error", label: "Stopped with an error", tone: "critical", detail: input.failureText || "The server stopped unexpectedly. Open the Console to see why." };
    }
    if (state === "stopped" || state === "exited" || state === "") {
      return { key: "stopped", label: "Stopped", tone: "muted", detail: operation && operation.status === "failed" && input.failureText ? input.failureText : "Start the server when you're ready." };
    }
    return { key: "unknown", label: String(input.state), tone: "muted", detail: "" };
  }

  // Live readings: "live" while fresh, "stale" afterwards (shown with their
  // age, never as live), "none" when nothing was measured.
  const FRESH_MS = 15000;
  function readingFreshness(sampledAt, now = Date.now(), freshMs = FRESH_MS) {
    const at = Number(sampledAt);
    if (!Number.isFinite(at) || at <= 0) return "none";
    return now - at <= freshMs ? "live" : "stale";
  }

  // A sample with neither CPU time nor memory means the computer does not
  // measure this server (a Windows Agent, or a server systemd runs), not that
  // a first reading is still coming. A first Linux sample has both.
  function reportsUsage(sample) {
    if (!sample) return false;
    return Number.isFinite(sample.cpuPercent) || Number.isFinite(sample.cpuSeconds) || Number.isFinite(sample.memoryRssBytes);
  }

  // Which settings only take effect after a restart.
  const RESTART_FIELDS = Object.freeze(["executable", "jar", "args", "memoryLimit", "environment", "workingDirectory", "ports"]);

  function changedRestartFields(before = {}, after = {}) {
    return RESTART_FIELDS.filter((field) => field in after && JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
  }

  // Restart-required notes, keyed by instance id. A note is cleared once the
  // server is seen stopped or (re)started after the change.
  function markRestartRequired(notes, instanceId, reason, at = Date.now()) {
    const next = { ...(notes || {}) };
    const existing = next[instanceId];
    const reasons = new Set([...(existing?.reasons || []), reason].filter(Boolean));
    next[instanceId] = { since: existing?.since || at, reasons: [...reasons].slice(0, 6) };
    return next;
  }

  function settleRestartRequired(notes, instance = {}) {
    const note = notes?.[instance.id];
    if (!note) return notes || {};
    const state = stateKey(instance.state);
    const startedAt = Date.parse(instance.startedAt || instance.lastStartedAt || "") || 0;
    const restarted = startedAt > note.since;
    if (state === "stopped" || state === "exited" || restarted) {
      const next = { ...notes };
      delete next[instance.id];
      return next;
    }
    return notes;
  }

  function restartRequiredFor(notes, instance = {}) {
    const note = notes?.[instance.id];
    if (!note) return null;
    if (!["running", "starting", "restarting"].includes(stateKey(instance.state))) return null;
    return note;
  }

  // Settings validation before anything is sent. Returns { field: message }.
  // The same rule as the app's save (normalizeMemoryLimit) and the Agent's
  // validation: anything this accepts must also save. No decimals, spaces,
  // "B" suffix or T.
  const MEMORY_PATTERN = /^[1-9][0-9]{0,5}[kKmMgG]?$/;
  function validateServerSettings(values = {}) {
    const errors = {};
    const name = String(values.displayName ?? "").trim();
    if ("displayName" in values && !name) errors.displayName = "Give the server a name.";
    else if (name.length > 80) errors.displayName = "Keep the name under 80 characters.";
    const memory = String(values.memoryLimit ?? "").trim();
    if (memory && !MEMORY_PATTERN.test(memory)) errors.memoryLimit = "Use a size such as 4G or 4096M.";
    if (memory && MEMORY_PATTERN.test(memory)) {
      const bytes = parseMemoryBytes(memory);
      if (bytes !== null && bytes < 256 * 1024 * 1024) errors.memoryLimit = "Use at least 256M.";
    }
    for (const field of ["startupTimeoutMs", "shutdownTimeoutMs"]) {
      const raw = values[field];
      if (raw === undefined || raw === null || raw === "") continue;
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1000 || number > 3600000) errors[field] = "Use a whole number of milliseconds between 1000 and 3600000.";
    }
    const env = values.environment;
    if (env && typeof env === "object") {
      for (const key of Object.keys(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) { errors.environment = `"${key}" is not a valid variable name.`; break; }
      }
    }
    return errors;
  }

  function parseMemoryBytes(value) {
    const match = String(value || "").trim().match(/^([\d.]+)\s*([kmgt]?)(?:i?b)?$/i);
    if (!match) return null;
    const multiplier = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[match[2].toLowerCase()];
    const amount = Number.parseFloat(match[1]);
    return Number.isFinite(amount) ? amount * multiplier : null;
  }

  // A hardware-aware memory suggestion: half of the computer's free memory,
  // clamped to 1–16 GB and rounded down to whole gigabytes. Null when the
  // computer's memory is unknown (no guess).
  function suggestMemory(availableBytes, totalBytes) {
    const available = Number(availableBytes);
    const total = Number(totalBytes);
    if (!Number.isFinite(available) || available <= 0 || !Number.isFinite(total) || total <= 0) return null;
    const gb = Math.floor(Math.min(available / 2, total * 0.75) / 1024 ** 3);
    const clamped = Math.max(1, Math.min(16, gb));
    return `${clamped}G`;
  }

  // Add-on support per game, through adapters. Only Minecraft has one today;
  // other games say so instead of pretending to work like Minecraft.
  const MINECRAFT_LOADERS = Object.freeze({
    paper: { kind: "plugins", label: "Paper plugins" },
    purpur: { kind: "plugins", label: "Purpur plugins" },
    spigot: { kind: "plugins", label: "Spigot plugins" },
    fabric: { kind: "mods", label: "Fabric mods" },
    quilt: { kind: "mods", label: "Quilt mods" },
    forge: { kind: "mods", label: "Forge mods" },
    neoforge: { kind: "mods", label: "NeoForge mods" },
  });

  function describeAddonSupport(instance = {}, options = {}) {
    const isMinecraft = options.isMinecraft === true;
    if (!isMinecraft) return { show: false, supported: false, kind: null, reason: "Add-ons are not available for this game in AnxHost yet." };
    const software = String(instance.serverSoftware || "").trim().toLowerCase();
    const loader = MINECRAFT_LOADERS[software];
    if (!loader) {
      const vanilla = !software || software === "vanilla" || software === "minecraft";
      return {
        show: true,
        supported: false,
        kind: null,
        reason: vanilla
          ? "This is a vanilla Minecraft server. Vanilla can't load mods or plugins. Create a Paper server for plugins, or a Fabric, Forge or NeoForge server for mods."
          : `AnxHost can't manage add-ons for ${instance.serverSoftware} servers yet.`,
      };
    }
    if (!String(instance.minecraftVersion || "").trim()) {
      return { show: true, supported: false, kind: loader.kind, reason: "AnxHost doesn't know this server's Minecraft version yet, so it can't pick compatible add-ons. Start the server once to detect it." };
    }
    return { show: true, supported: true, kind: loader.kind, label: loader.label, reason: "" };
  }

  return {
    FRESH_MS,
    MAIN_TABS,
    RESTART_FIELDS,
    TAB_LABELS,
    TAB_PARENT,
    changedRestartFields,
    describeAddonSupport,
    describeServerStatus,
    mainTabFor,
    markRestartRequired,
    parseMemoryBytes,
    readingFreshness,
    reportsUsage,
    restartRequiredFor,
    settleRestartRequired,
    suggestMemory,
    validateServerSettings,
  };
});
