// Home dashboard and Computers view model (Phase 4). Pure functions only: the
// renderer passes in what it already has (computers, their latest readings
// and a bounded reading history, the selected computer's servers, fleet
// counts) and gets back what to show. Node smokes load the same file.
//
// Two rules run through everything here:
//   * A reading is only "live" while it is fresh. Older readings are shown as
//     stale with their age, and readings that are too old or missing are
//     "unavailable"; CPU and RAM are never presented as live when they are not.
//   * Warnings need sustained evidence. A brief CPU or memory spike never
//     raises an alert; pressure must hold across a window of readings.
(function initializeHomeDashboardModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxHomeDashboardModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createHomeDashboardModelApi() {
  "use strict";

  const THRESHOLDS = Object.freeze({
    // Fresh while younger than this; the selected computer is read every
    // 2 s and the others every 10 s, so both allow a few missed polls.
    freshSelectedMs: 10 * 1000,
    freshOtherMs: 35 * 1000,
    // After this a reading is not shown at all, only "unavailable".
    unavailableAfterMs: 5 * 60 * 1000,
    cpuPercent: 90,
    cpuSustainMs: 2 * 60 * 1000,
    memoryPercent: 90,
    memorySustainMs: 60 * 1000,
    // Same disk rules as the alert engine and node health
    // (NODE_HEALTH_RESOURCE_THRESHOLDS in app.js, alertService.js), so Home
    // and Activity never disagree about a disk.
    diskWarnPercent: 85,
    diskCriticalPercent: 95,
    diskCriticalFreeBytes: 2 * 1024 * 1024 * 1024,
  });

  // Bounded reading history per computer.
  const HISTORY_LIMIT = 180;

  const SECTION_IDS = Object.freeze(["attention", "servers", "computers", "setup"]);
  const DEFAULT_PREFERENCES = Object.freeze({ order: SECTION_IDS, hidden: [] });
  // Needs attention is never hideable: it is where problems surface.
  const REQUIRED_SECTIONS = Object.freeze(["attention"]);

  // Number(null) and Number("") are 0, so missing values are checked first:
  // an unmeasured reading must stay null, never become 0.
  function finite(value) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // ---------------------------------------------------------------------------
  // Freshness
  // ---------------------------------------------------------------------------

  function freshnessOf(at, now, { freshMs = THRESHOLDS.freshOtherMs, unavailableAfterMs = THRESHOLDS.unavailableAfterMs } = {}) {
    const time = finite(at);
    if (!time) return { state: "unavailable", ageMs: null };
    const ageMs = Math.max(0, now - time);
    if (ageMs > unavailableAfterMs) return { state: "unavailable", ageMs };
    return { state: ageMs <= freshMs ? "fresh" : "stale", ageMs };
  }

  function formatAge(ageMs) {
    if (!Number.isFinite(ageMs)) return "";
    const seconds = Math.round(ageMs / 1000);
    if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  }

  // ---------------------------------------------------------------------------
  // Readings and history
  // ---------------------------------------------------------------------------

  // The handful of numbers the views use, taken from an Agent system summary.
  function readingFromSnapshot(snapshot, at) {
    const memory = snapshot && snapshot.memory ? snapshot.memory : {};
    const disk = snapshot && snapshot.disk ? snapshot.disk : {};
    const network = snapshot && snapshot.network ? snapshot.network : {};
    const cpu = snapshot && snapshot.cpu ? snapshot.cpu : {};
    const gpu = snapshot && snapshot.gpuUsage && snapshot.gpuUsage.available ? snapshot.gpuUsage.devices : [];
    return {
      at,
      cpuPercent: finite(cpu.usagePercent),
      perCore: Array.isArray(cpu.perCore) ? cpu.perCore.map(finite) : [],
      memoryPercent: finite(memory.percent),
      memoryUsed: finite(memory.used),
      memoryTotal: finite(memory.total),
      diskPercent: finite(disk.percent),
      diskFree: finite(disk.free),
      diskTotal: finite(disk.total),
      netDown: finite(network.downloadPerSecond),
      netUp: finite(network.uploadPerSecond),
      gpus: Array.isArray(gpu) ? gpu : [],
      cpuModel: cpu.model ? String(cpu.model) : "",
      cpuCores: finite(cpu.cores),
      platform: snapshot && snapshot.platform ? String(snapshot.platform) : "",
      osVersion: snapshot && snapshot.osVersion ? String(snapshot.osVersion) : "",
      uptimeSeconds: finite(snapshot && snapshot.uptimeSeconds),
      networkDetails: snapshot && snapshot.networkDetails && typeof snapshot.networkDetails === "object" ? snapshot.networkDetails : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Network (Phase 8)
  // ---------------------------------------------------------------------------

  const ADAPTER_KIND_LABELS = Object.freeze({ ethernet: "Wired", wifi: "Wi-Fi", vpn: "VPN", virtual: "Virtual", other: "Other" });

  // The speed the adapter negotiated with the router or switch, never
  // presented as internet speed.
  function linkSpeedText(mbps) {
    if (!(mbps > 0)) return "Not reported";
    return mbps >= 1000 ? `${Math.round(mbps / 100) / 10} Gb/s` : `${mbps} Mb/s`;
  }

  // What the Network section of a computer shows. Connected wired and Wi-Fi
  // adapters come first; virtual, VPN and disconnected adapters are listed
  // separately so they do not crowd the ones that carry the traffic.
  function describeNetworkDetails(details) {
    const empty = { main: [], other: [], router: null, dnsServers: [], warming: false };
    if (!details || typeof details !== "object") return { ...empty, available: false, reason: "This computer's Agent does not report network details yet." };
    if (details.supported === false) return { ...empty, available: false, reason: "Network details are not available on this operating system." };
    const rows = (Array.isArray(details.interfaces) ? details.interfaces : []).map((entry) => {
      const errors = finite(entry.errors);
      const dropped = finite(entry.dropped);
      const kind = ADAPTER_KIND_LABELS[entry.kind] ? entry.kind : "other";
      return {
        name: String(entry.name || ""),
        kind,
        kindLabel: ADAPTER_KIND_LABELS[kind],
        connected: entry.up === true,
        status: entry.up === true ? "Connected" : "Not connected",
        address: [...(Array.isArray(entry.ipv4) ? entry.ipv4 : []), ...(Array.isArray(entry.ipv6) ? entry.ipv6 : [])][0] || "",
        link: linkSpeedText(finite(entry.linkSpeedMbps)),
        down: finite(entry.downloadPerSecond),
        up: finite(entry.uploadPerSecond),
        errors,
        dropped,
        issuesText: errors === null || dropped === null ? "Not reported" : errors + dropped === 0 ? "None" : `${errors} errors, ${dropped} dropped`,
      };
    });
    const isMain = (row) => row.connected && (row.kind === "ethernet" || row.kind === "wifi" || (row.kind === "other" && Boolean(row.address)));
    return {
      available: true,
      reason: details.reason === "counters_unreadable" ? "The network counters could not be read." : "",
      warming: details.reason === "warming_up",
      main: rows.filter(isMain),
      other: rows.filter((row) => !isMain(row)),
      router: details.gateway && details.gateway.address ? String(details.gateway.address) : null,
      dnsServers: Array.isArray(details.dnsServers) ? details.dnsServers.map(String) : [],
    };
  }

  // One line per step of a connection check, in plain words.
  function describeNetworkCheck(check) {
    if (!check || typeof check !== "object") return [];
    const latency = (ms) => (finite(ms) === null ? "" : ` · ${ms < 1 ? "under 1" : Math.round(ms)} ms`);
    const router = check.router || {};
    const lookup = check.nameLookup || {};
    const internet = check.internet || {};
    let routerText = "Did not answer";
    if (router.reason === "no_gateway") routerText = "No router found (no default route)";
    else if (router.reason === "ping_unavailable") routerText = "Can't test: ping is not available on this computer";
    else if (router.ok) routerText = `Reachable${latency(router.latencyMs)}${finite(router.lossPercent) ? ` · ${router.lossPercent}% of checks lost` : ""}`;
    return [
      { id: "router", label: router.address ? `Router (${router.address})` : "Router", ok: router.ok === true, text: routerText },
      { id: "lookup", label: "Name lookup", ok: lookup.ok === true, text: lookup.ok ? `Working${latency(lookup.latencyMs)}` : "Failed: names can't be looked up" },
      { id: "internet", label: "Internet", ok: internet.ok === true, text: internet.ok ? `Reachable${latency(internet.latencyMs)}` : internet.reason === "name_lookup_failed" ? "Not tested (name lookup failed)" : "Not reachable" },
    ];
  }

  function appendHistory(history, reading, limit = HISTORY_LIMIT) {
    const next = Array.isArray(history) ? history.slice(-(limit - 1)) : [];
    next.push({ at: reading.at, cpuPercent: reading.cpuPercent, memoryPercent: reading.memoryPercent });
    return next;
  }

  // True only when every reading in the last `sustainMs` is at or above the
  // threshold and those readings actually cover most of the window.
  function isSustained(history, key, threshold, sustainMs, now) {
    const window = (Array.isArray(history) ? history : []).filter((entry) => now - entry.at <= sustainMs);
    const values = window.map((entry) => entry[key]).filter((value) => value !== null && value !== undefined);
    if (values.length < 3 || values.length !== window.length) return false;
    const covered = window[window.length - 1].at - window[0].at;
    if (covered < sustainMs * 0.8) return false;
    return values.every((value) => value >= threshold);
  }

  // ---------------------------------------------------------------------------
  // Computers
  // ---------------------------------------------------------------------------

  const CONNECTION_LABELS = Object.freeze({
    online: "Online",
    warning: "Needs attention",
    installing: "Connecting",
    offline: "Offline",
    error: "Not connected",
  });

  function platformLabel(platform) {
    const text = String(platform || "").toLowerCase();
    if (text === "win32" || text.includes("windows")) return "Windows";
    if (text === "linux") return "Linux";
    if (text === "darwin") return "macOS";
    return platform ? String(platform) : "";
  }

  // computer: { id, name, connection ("online" | "warning" | "installing" |
  // "offline" | "error"), selected, isAnxOS, serverCount, runningServerCount }
  function buildComputerCard(computer, vitals, now) {
    const reading = vitals && vitals.reading ? vitals.reading : null;
    const freshness = freshnessOf(reading && reading.at, now, { freshMs: computer.selected ? THRESHOLDS.freshSelectedMs : THRESHOLDS.freshOtherMs });
    const connected = computer.connection === "online" || computer.connection === "warning";
    const show = reading && connected && freshness.state !== "unavailable";
    const os = reading && (reading.osVersion || platformLabel(reading.platform));
    return {
      id: computer.id,
      name: computer.name,
      selected: Boolean(computer.selected),
      connection: computer.connection,
      connectionLabel: CONNECTION_LABELS[computer.connection] || "Unknown",
      os: computer.isAnxOS ? `AnxOS${os ? ` (${os})` : ""}` : os || "",
      freshness: connected ? freshness.state : "unavailable",
      freshnessLabel: !connected
        ? "Not connected"
        : freshness.state === "fresh"
          ? "Live"
          : freshness.state === "stale"
            ? `Last reading ${formatAge(freshness.ageMs)}`
            : vitals && vitals.error ? "Readings unavailable" : "Waiting for readings",
      cpuPercent: show ? reading.cpuPercent : null,
      memoryPercent: show ? reading.memoryPercent : null,
      memoryUsed: show ? reading.memoryUsed : null,
      memoryTotal: show ? reading.memoryTotal : null,
      diskPercent: show ? reading.diskPercent : null,
      diskFree: show ? reading.diskFree : null,
      netDown: show ? reading.netDown : null,
      netUp: show ? reading.netUp : null,
      gpus: show ? reading.gpus : [],
      serverCount: finite(computer.serverCount),
      runningServerCount: finite(computer.runningServerCount),
    };
  }

  // The same Agent (same deviceId) added more than once, e.g. by its LAN
  // address and its Tailscale name. Adding the same URL twice is already
  // refused; this catches the same machine under different addresses.
  function findDuplicateComputers(computers = []) {
    const byDevice = new Map();
    computers.forEach((computer) => {
      const deviceId = String(computer && computer.deviceId || "").trim();
      if (!deviceId) return;
      if (!byDevice.has(deviceId)) byDevice.set(deviceId, []);
      byDevice.get(deviceId).push(computer);
    });
    return [...byDevice.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([deviceId, list]) => ({ deviceId, ids: list.map((computer) => computer.id), names: list.map((computer) => computer.name) }));
  }

  // ---------------------------------------------------------------------------
  // Needs attention
  // ---------------------------------------------------------------------------

  // Returns items { id, severity ("critical" | "warning"), title, detail,
  // action: { label, kind ("computer" | "server" | "page"), target } },
  // most severe first.
  function buildAttentionItems({ computers = [], vitalsById = {}, servers = [], now = Date.now(), explainFailure = null, extra = [] } = {}) {
    const items = [];
    computers.forEach((computer) => {
      const vitals = vitalsById[computer.id] || {};
      if (computer.connection === "offline" || computer.connection === "error") {
        items.push({
          id: `computer-offline:${computer.id}`,
          severity: "critical",
          title: `${computer.name} is not connected`,
          detail: computer.connectionDetail || "AnxHost cannot reach the AnxHost Agent on this computer. Servers on it cannot be managed until it reconnects.",
          action: { label: "Open computer", kind: "computer", target: computer.id },
        });
        return;
      }
      if (computer.connection !== "online" && computer.connection !== "warning") return;
      const reading = vitals.reading || null;
      const freshness = freshnessOf(reading && reading.at, now, { freshMs: computer.selected ? THRESHOLDS.freshSelectedMs : THRESHOLDS.freshOtherMs });
      if (vitals.error && freshness.state !== "fresh") {
        items.push({
          id: `monitoring:${computer.id}`,
          severity: "warning",
          title: `No live readings from ${computer.name}`,
          detail: `The computer is connected, but its CPU and memory readings could not be read${reading ? ` (last reading ${formatAge(freshness.ageMs)})` : ""}.`,
          action: { label: "Open computer", kind: "computer", target: computer.id },
        });
      }
      if (!reading || freshness.state === "unavailable") return;
      if (isSustained(vitals.history, "memoryPercent", THRESHOLDS.memoryPercent, THRESHOLDS.memorySustainMs, now)) {
        items.push({
          id: `memory:${computer.id}`,
          severity: "warning",
          title: `${computer.name} is running low on memory`,
          detail: `Memory has stayed above ${THRESHOLDS.memoryPercent}% for over a minute. Servers may slow down or crash.`,
          action: { label: "Open computer", kind: "computer", target: computer.id },
        });
      }
      if (isSustained(vitals.history, "cpuPercent", THRESHOLDS.cpuPercent, THRESHOLDS.cpuSustainMs, now)) {
        items.push({
          id: `cpu:${computer.id}`,
          severity: "warning",
          title: `${computer.name} is very busy`,
          detail: `CPU has stayed above ${THRESHOLDS.cpuPercent}% for over two minutes.`,
          action: { label: "Open computer", kind: "computer", target: computer.id },
        });
      }
      const diskPercent = reading.diskPercent;
      const diskFree = reading.diskFree;
      const diskCritical = (diskPercent !== null && diskPercent >= THRESHOLDS.diskCriticalPercent)
        || (diskFree !== null && diskFree < THRESHOLDS.diskCriticalFreeBytes);
      const diskLow = diskCritical || (diskPercent !== null && diskPercent >= THRESHOLDS.diskWarnPercent);
      if (diskLow) {
        items.push({
          id: `disk:${computer.id}`,
          severity: diskCritical ? "critical" : "warning",
          title: `${computer.name} is running out of disk space`,
          detail: `${diskPercent !== null ? `${Math.round(diskPercent)}% used` : "Little space left"}. Servers and backups need free space to save.`,
          action: { label: "Open computer", kind: "computer", target: computer.id },
        });
      }
    });
    servers.forEach((server) => {
      const state = String(server.state || "").toLowerCase();
      if (!/fail|crash/.test(state)) return;
      const explained = typeof explainFailure === "function" ? explainFailure(server.failureReason) : null;
      items.push({
        id: `server:${server.id}`,
        severity: "critical",
        title: explained ? `${server.name}: ${explained.title.charAt(0).toLowerCase()}${explained.title.slice(1)}` : `${server.name} stopped unexpectedly`,
        detail: explained ? explained.fix : "Open the server to see what happened.",
        action: { label: "Open server", kind: "server", target: server.id },
      });
    });
    findDuplicateComputers(computers).forEach((duplicate) => {
      items.push({
        id: `duplicate:${duplicate.deviceId}`,
        severity: "warning",
        title: `The same computer is added ${duplicate.ids.length} times`,
        detail: `${duplicate.names.join(" and ")} are the same AnxHost Agent added under different addresses. Keep one and remove the others under Computers.`,
        action: { label: "Open Computers", kind: "computer", target: duplicate.ids[0] },
      });
    });
    (Array.isArray(extra) ? extra : []).forEach((item) => {
      if (item && item.id && item.title) items.push(item);
    });
    const rank = { critical: 0, warning: 1 };
    return items.sort((left, right) => (rank[left.severity] ?? 2) - (rank[right.severity] ?? 2));
  }

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  function buildOverview({ computers = [], servers = [], serversKnown = false, fleetRunning = null, fleetTotal = null, players = null, attention = [], unknownServersDetail = "Checking servers" } = {}) {
    const online = computers.filter((computer) => computer.connection === "online" || computer.connection === "warning").length;
    const running = fleetRunning !== null ? fleetRunning : servers.filter((server) => server.running).length;
    const total = fleetTotal !== null ? fleetTotal : servers.length;
    return {
      servers: { value: serversKnown || fleetTotal !== null ? `${running}` : "—", detail: serversKnown || fleetTotal !== null ? `of ${total} running` : unknownServersDetail },
      computers: { value: `${online}`, detail: `of ${computers.length} online` },
      players: players === null ? { value: "—", detail: "Not reported by these servers" } : { value: `${players}`, detail: players === 1 ? "player online" : "players online" },
      attention: { value: `${attention.length}`, detail: attention.length ? (attention.some((item) => item.severity === "critical") ? "need you now" : "to look at") : "All good" },
    };
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  function normalizePreferences(value) {
    const source = value && typeof value === "object" ? value : {};
    const order = Array.isArray(source.order) ? source.order.filter((id) => SECTION_IDS.includes(id)) : [];
    SECTION_IDS.forEach((id) => { if (!order.includes(id)) order.push(id); });
    const hidden = Array.isArray(source.hidden)
      ? [...new Set(source.hidden.filter((id) => SECTION_IDS.includes(id) && !REQUIRED_SECTIONS.includes(id)))]
      : [];
    return { order: [...new Set(order)], hidden };
  }

  function moveSection(preferences, sectionId, direction) {
    const prefs = normalizePreferences(preferences);
    const index = prefs.order.indexOf(sectionId);
    const target = index + (direction < 0 ? -1 : 1);
    if (index < 0 || target < 0 || target >= prefs.order.length) return prefs;
    const order = prefs.order.slice();
    [order[index], order[target]] = [order[target], order[index]];
    return { ...prefs, order };
  }

  return Object.freeze({
    THRESHOLDS,
    HISTORY_LIMIT,
    SECTION_IDS,
    DEFAULT_PREFERENCES,
    REQUIRED_SECTIONS,
    freshnessOf,
    formatAge,
    readingFromSnapshot,
    appendHistory,
    isSustained,
    platformLabel,
    buildComputerCard,
    describeNetworkDetails,
    describeNetworkCheck,
    linkSpeedText,
    buildAttentionItems,
    findDuplicateComputers,
    buildOverview,
    normalizePreferences,
    moveSection,
  });
});
