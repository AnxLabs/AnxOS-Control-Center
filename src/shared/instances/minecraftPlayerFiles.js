(function initializeMinecraftPlayerFiles(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxMinecraftPlayerFiles = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMinecraftPlayerFilesApi() {
  "use strict";

  // The four vanilla Minecraft player files surfaced by the read-only Players
  // workspace tab. `identity` names the field every entry must carry (player
  // name or IP address); entries without it are dropped instead of guessed at.
  const MINECRAFT_PLAYER_FILE_SPECS = Object.freeze([
    Object.freeze({ key: "whitelist", path: "whitelist.json", label: "Whitelist", identity: "name" }),
    Object.freeze({ key: "ops", path: "ops.json", label: "Operators", identity: "name" }),
    Object.freeze({ key: "banned-players", path: "banned-players.json", label: "Banned Players", identity: "name" }),
    Object.freeze({ key: "banned-ips", path: "banned-ips.json", label: "Banned IPs", identity: "ip" }),
  ]);

  // Per-file view states the renderer can render honestly:
  // - ok: parsed JSON array with normalized entries
  // - empty: file exists but has no content
  // - invalid: corrupt JSON or not the expected array shape
  // - missing: file not on disk (normal until the feature is first used)
  // - too_large: file exceeds the instance file-read size limit
  // - read_error: the agent/file read itself failed
  const FILE_STATES = Object.freeze(["ok", "empty", "invalid", "missing", "too_large", "read_error"]);

  function getMinecraftPlayerFileSpec(specKey) {
    return MINECRAFT_PLAYER_FILE_SPECS.find((spec) => spec.key === specKey) || null;
  }

  function toTrimmedString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function pickTrimmedString(entry, keys) {
    for (const key of keys) {
      const value = toTrimmedString(entry?.[key]);
      if (value) {
        return value;
      }
    }
    return null;
  }

  function toFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return null;
  }

  function toOptionalBoolean(value) {
    if (typeof value === "boolean") {
      return value;
    }
    return null;
  }

  // Normalizes one raw entry object. Returns null for anything without the
  // identity field so corrupt/partial entries never render as fake data.
  function normalizeMinecraftPlayerEntry(spec, entry) {
    if (!spec || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const identity = pickTrimmedString(entry, [spec.identity]);
    if (!identity) {
      return null;
    }

    const normalized = {
      identity,
      name: spec.identity === "ip" ? null : identity,
      uuid: pickTrimmedString(entry, ["uuid"]),
      ip: spec.identity === "ip" ? identity : null,
      level: toFiniteNumber(entry.level),
      bypassesPlayerLimit: toOptionalBoolean(entry.bypassesPlayerLimit),
      reason: pickTrimmedString(entry, ["reason"]),
      source: pickTrimmedString(entry, ["source"]),
      created: pickTrimmedString(entry, ["created"]),
      expires: pickTrimmedString(entry, ["expires"]),
    };
    return normalized;
  }

  function describeMinecraftPlayerFileState(status) {
    const messages = {
      ok: "",
      empty: "File exists but is empty.",
      invalid: "File could not be parsed as a JSON player list.",
      missing: "Not present yet — Minecraft creates this file when the feature is first used.",
      too_large: "File is too large to display here (over the 1 MB file-read limit).",
      read_error: "Could not read the file from the server.",
    };
    return messages[status] ?? "Player file state unavailable.";
  }

  // Parses one player file's text content. Statuses follow FILE_STATES.
  // `rawText` is the decoded utf-8 content; null/undefined means the caller
  // determined the file was not readable content (missing file, read error).
  function parseMinecraftPlayerFile(specKey, rawText) {
    const spec = getMinecraftPlayerFileSpec(specKey);
    if (!spec) {
      return {
        key: String(specKey ?? ""),
        status: "invalid",
        entries: [],
        count: 0,
        message: "Unknown player file.",
      };
    }

    if (rawText === null || rawText === undefined) {
      return {
        key: spec.key,
        status: "missing",
        entries: [],
        count: 0,
        message: describeMinecraftPlayerFileState("missing"),
      };
    }

    const text = String(rawText);
    if (!text.trim()) {
      return {
        key: spec.key,
        status: "empty",
        entries: [],
        count: 0,
        message: describeMinecraftPlayerFileState("empty"),
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        key: spec.key,
        status: "invalid",
        entries: [],
        count: 0,
        message: describeMinecraftPlayerFileState("invalid"),
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        key: spec.key,
        status: "invalid",
        entries: [],
        count: 0,
        message: describeMinecraftPlayerFileState("invalid"),
      };
    }

    const entries = parsed
      .map((entry) => normalizeMinecraftPlayerEntry(spec, entry))
      .filter(Boolean);
    return {
      key: spec.key,
      status: "ok",
      entries,
      count: entries.length,
      message: "",
    };
  }

  // Maps a file-read outcome onto the renderer view model for one file card.
  // outcome is one of:
  //   { kind: "content", content: string }
  //   { kind: "missing" }
  //   { kind: "too_large" }
  //   { kind: "unsupported", reason? }   (agent refused the read: binary
  //     content, encoding, or any other unsupported reason)
  //   { kind: "read_error", message? }
  function summarizeMinecraftPlayerFile(specKey, outcome) {
    const spec = getMinecraftPlayerFileSpec(specKey);
    if (!spec) {
      return {
        key: String(specKey ?? ""),
        path: "",
        label: "Unknown",
        status: "invalid",
        entries: [],
        count: 0,
        message: "Unknown player file.",
      };
    }

    let parsed;
    if (!outcome || typeof outcome !== "object") {
      parsed = parseMinecraftPlayerFile(spec.key, null);
    } else if (outcome.kind === "content") {
      parsed = parseMinecraftPlayerFile(spec.key, outcome.content ?? "");
    } else if (outcome.kind === "missing") {
      parsed = parseMinecraftPlayerFile(spec.key, null);
    } else if (outcome.kind === "too_large") {
      parsed = {
        key: spec.key,
        status: "too_large",
        entries: [],
        count: 0,
        message: describeMinecraftPlayerFileState("too_large"),
      };
    } else if (outcome.kind === "unsupported") {
      parsed = {
        key: spec.key,
        status: "unsupported",
        entries: [],
        count: 0,
        message: `The agent could not read this file as text${outcome.reason ? ` (${outcome.reason})` : ""}.`,
      };
    } else {
      parsed = {
        key: spec.key,
        status: "read_error",
        entries: [],
        count: 0,
        message: describeMinecraftPlayerFileState("read_error"),
      };
    }

    return {
      key: spec.key,
      path: spec.path,
      label: spec.label,
      status: parsed.status,
      entries: parsed.entries,
      count: parsed.count,
      message: parsed.message,
    };
  }

  return {
    MINECRAFT_PLAYER_FILE_SPECS,
    FILE_STATES,
    getMinecraftPlayerFileSpec,
    normalizeMinecraftPlayerEntry,
    parseMinecraftPlayerFile,
    summarizeMinecraftPlayerFile,
    describeMinecraftPlayerFileState,
  };
});
