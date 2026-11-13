// Home dashboard and Computers page (Phase 4).
//
// Loaded after app.js and uses its globals (nodesState, getInstances,
// showPage, reconcileChildren, ...). It owns:
//   * AnxComputerVitals: the one store of live readings per computer. The
//     selected computer's existing dashboard poll records into it
//     (renderSnapshot in app.js); other connected computers are read here
//     through the same system snapshot route, one at a time, every 10 s, only
//     while Home or Computers is visible and the window is not hidden.
//   * Rendering of the Home overview, Needs attention, Computers cards and
//     section preferences, and the Computers page detail panel.
// All decisions (freshness, sustained pressure, attention items) come from
// src/shared/homeDashboardModel.js.
(function initializeHomeDashboard(root) {
  "use strict";

  const Model = root.AnxHomeDashboardModel;
  if (!Model) return;

  const REMOTE_POLL_MS = 10 * 1000;
  const FLEET_REFRESH_MS = 30 * 1000;
  const TICK_MS = 2 * 1000;
  const PREFERENCES_KEY = "anxos.home.sections.v1";
  const SELECTED_COMPUTER_KEY = "anxos.computers.viewing.v1";

  // ---------------------------------------------------------------------------
  // Reading store
  // ---------------------------------------------------------------------------

  const vitals = new Map();

  const AnxComputerVitals = {
    record(nodeId, snapshot, at = Date.now()) {
      if (!nodeId || !snapshot) return;
      const entry = vitals.get(nodeId) || { history: [] };
      const reading = Model.readingFromSnapshot(snapshot, at);
      vitals.set(nodeId, { reading, history: Model.appendHistory(entry.history, reading), error: null, errorAt: null });
    },
    recordError(nodeId, error, at = Date.now()) {
      if (!nodeId) return;
      const entry = vitals.get(nodeId) || { history: [], reading: null };
      vitals.set(nodeId, { ...entry, error: String(error?.message || error || "Readings unavailable"), errorAt: at });
    },
    get(nodeId) {
      return vitals.get(nodeId) || null;
    },
    all() {
      return Object.fromEntries(vitals);
    },
  };
  root.AnxComputerVitals = AnxComputerVitals;

  // ---------------------------------------------------------------------------
  // Inputs from app.js
  // ---------------------------------------------------------------------------

  function safe(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function selectedNodeId() {
    return safe(() => getSelectedNodeId(), "");
  }

  function fleetEntryFor(nodeId) {
    const nodes = safe(() => (fleetState && Array.isArray(fleetState.nodes) ? fleetState.nodes : []), []);
    return nodes.find((entry) => entry.nodeId === nodeId) || null;
  }

  function isAnxOSNode(node) {
    const identity = safe(() => getNodeIdentity(node), {}) || {};
    return /anxos/i.test([identity.osVersion, identity.os, identity.distro, node.platformLabel].filter(Boolean).join(" "));
  }

  // The computers to show. The application host ("Application Host" / this
  // desktop) is only listed when no Agent computer exists, so this PC does not
  // appear twice when its local Agent is paired.
  function getComputers() {
    const nodes = safe(() => (Array.isArray(nodesState.nodes) ? nodesState.nodes : []), []).filter((node) => node && node.enabled !== false);
    const agents = nodes.filter((node) => node.kind !== "application-host");
    const list = agents.length ? agents : nodes;
    const selected = selectedNodeId();
    return list.map((node) => {
      const fleet = fleetEntryFor(node.id);
      const connection = node.kind === "application-host" ? "online" : safe(() => getNodeVisualState(node), "error");
      const status = safe(() => getNodeConnectionState(node), null);
      return {
        id: node.id,
        name: node.displayName || node.name || node.id,
        kind: node.kind,
        connection,
        connectionDetail: status && status.secondary ? String(status.secondary) : "",
        selected: node.id === selected,
        isAnxOS: isAnxOSNode(node),
        deviceId: node.agentIdentity?.deviceId || node.deviceId || "",
        serverCount: fleet && fleet.instances && fleet.instances.available ? fleet.instances.instanceCount : null,
        runningServerCount: fleet && fleet.instances && fleet.instances.available ? fleet.instances.runningInstanceCount : null,
        node,
      };
    });
  }

  function getServers() {
    const instances = safe(() => getInstances(), []);
    const nodeLabel = (instance) => safe(() => getInstanceNodeLabel(instance), "");
    return instances.map((instance) => ({
      id: instance.id,
      name: instance.displayName || instance.id,
      state: String(instance.state || instance.status || ""),
      running: safe(() => isInstanceRunning(instance), false),
      failureReason: instance.failureReason || "",
      computer: nodeLabel(instance),
      players: playersOf(instance),
    }));
  }

  function playersOf(instance) {
    const data = safe(() => getMinecraftSummaryData(instance), null);
    const players = (data && data.players) || instance.players || {};
    const online = Number(players.online);
    return Number.isFinite(online) && players.online !== null && players.online !== undefined ? online : null;
  }

  // ---------------------------------------------------------------------------
  // Remote polling (computers other than the selected one)
  // ---------------------------------------------------------------------------

  let remoteInFlight = false;
  let lastFleetRefresh = 0;
  const lastRemotePoll = new Map();

  function pollingPageActive() {
    const page = safe(() => getActivePageName(), "");
    return !document.hidden && (page === "dashboard" || page === "nodes");
  }

  async function pollRemoteComputers() {
    if (remoteInFlight || !pollingPageActive()) return;
    const api = safe(() => getDesktopApiState().api, null);
    if (typeof api?.system?.getSnapshot !== "function") return;
    const now = Date.now();
    // The selected computer is read by the Home page's own 2 s poll; on the
    // Computers page this poller covers it too, so its readings stay live.
    const onHome = safe(() => getActivePageName(), "") === "dashboard";
    const due = getComputers().filter((computer) => !(computer.selected && onHome)
      && computer.kind !== "application-host"
      && (computer.connection === "online" || computer.connection === "warning")
      && now - (lastRemotePoll.get(computer.id) || 0) >= REMOTE_POLL_MS);
    if (!due.length) return;
    remoteInFlight = true;
    try {
      for (const computer of due) {
        if (!pollingPageActive()) break;
        lastRemotePoll.set(computer.id, Date.now());
        try {
          const snapshot = await api.system.getSnapshot({ nodeId: computer.id });
          if (snapshot && snapshot.ok !== false) AnxComputerVitals.record(computer.id, snapshot);
          else AnxComputerVitals.recordError(computer.id, snapshot?.error?.message || "Readings unavailable");
        } catch (error) {
          AnxComputerVitals.recordError(computer.id, error);
        }
      }
    } finally {
      remoteInFlight = false;
    }
  }

  function maybeRefreshFleet() {
    if (!pollingPageActive() || Date.now() - lastFleetRefresh < FLEET_REFRESH_MS) return;
    lastFleetRefresh = Date.now();
    safe(() => refreshFleetSummary(), null);
  }

  // ---------------------------------------------------------------------------
  // Preferences (per viewer, survive restarts; defaults when unreadable)
  // ---------------------------------------------------------------------------

  function readPreferences() {
    try {
      return Model.normalizePreferences(JSON.parse(root.localStorage.getItem(PREFERENCES_KEY) || "null"));
    } catch {
      return Model.normalizePreferences(null);
    }
  }

  function writePreferences(preferences) {
    try {
      root.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(Model.normalizePreferences(preferences)));
    } catch {
      // Storage can be unavailable; the layout still works for this session.
    }
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function el(tag, className = "", text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  function percentText(value) {
    return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
  }

  function bytes(value) {
    return value === null || value === undefined ? "—" : safe(() => formatBytes(value), `${value} B`);
  }

  function rate(value) {
    return value === null || value === undefined ? "—" : safe(() => formatRate(value), `${value} B/s`);
  }

  function meter(label, value, detail) {
    const row = el("div", "home-meter");
    row.dataset.level = value === null ? "none" : value >= 90 ? "high" : value >= 75 ? "medium" : "low";
    const head = el("div", "home-meter__head");
    head.append(el("span", "home-meter__label", label), el("strong", "home-meter__value", percentText(value)));
    const bar = el("div", "home-meter__bar");
    const fill = el("span");
    fill.style.width = value === null ? "0%" : `${Math.max(0, Math.min(100, value))}%`;
    bar.append(fill);
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    if (value !== null) bar.setAttribute("aria-valuenow", String(Math.round(value)));
    row.append(head, bar);
    if (detail) row.append(el("small", "home-meter__detail", detail));
    return row;
  }

  function reconcile(container, draft) {
    if (!container) return;
    if (typeof reconcileChildren === "function") reconcileChildren(container, draft);
    else container.replaceChildren(...draft.childNodes);
  }

  function openComputer(nodeId) {
    try {
      root.localStorage.setItem(SELECTED_COMPUTER_KEY, nodeId);
    } catch {
      // Remembering the computer is a convenience only.
    }
    safe(() => showPage("nodes"), null);
    renderComputerDetails();
  }

  function runAttentionAction(action) {
    if (!action) return;
    if (action.kind === "computer") openComputer(action.target);
    else if (action.kind === "server") safe(() => openDashboardInstanceDetails(action.target), null);
    else if (action.kind === "page") safe(() => runDashboardFriendlyAction(action.target), null);
  }

  // ---------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------

  function nextStepItem() {
    const state = safe(() => getFriendlyDashboardState(), null);
    const next = state && state.next;
    if (!next || !next.title || !next.action || next.action === "dashboard") return [];
    return [{
      id: `next-step:${next.action}`,
      severity: "info",
      title: next.title,
      detail: next.detail || "",
      action: { label: "Do it", kind: "page", target: next.action },
    }];
  }

  function buildState(now = Date.now()) {
    const computers = getComputers();
    const selected = computers.find((computer) => computer.selected);
    // Servers listed for a computer that is not connected are last-known
    // data: they are neither counted as running nor checked for crashes.
    const selectedConnected = !selected || selected.connection === "online" || selected.connection === "warning";
    const servers = selectedConnected ? getServers() : [];
    const serversKnown = selectedConnected && safe(() => isInstancesSnapshotCurrentForSelectedNode(), false);
    const totals = safe(() => (fleetState && fleetState.totals) || null, null);
    const attention = Model.buildAttentionItems({
      computers,
      vitalsById: AnxComputerVitals.all(),
      servers,
      now,
      explainFailure: root.AnxServerFailures ? root.AnxServerFailures.explainServerFailure : null,
      extra: nextStepItem(),
    });
    const reportedPlayers = servers.filter((server) => server.running && server.players !== null);
    const overview = Model.buildOverview({
      computers,
      servers,
      serversKnown,
      fleetRunning: totals && Number.isFinite(totals.runningInstanceCount) ? totals.runningInstanceCount : null,
      fleetTotal: totals && Number.isFinite(totals.instanceCount) ? totals.instanceCount : null,
      players: reportedPlayers.length ? reportedPlayers.reduce((sum, server) => sum + server.players, 0) : null,
      attention: attention.filter((item) => item.severity !== "info"),
      unknownServersDetail: selectedConnected ? "Checking servers" : "Computer not connected",
    });
    return { now, computers, servers, attention, overview };
  }

  function renderOverview(container, overview) {
    const draft = el("div");
    [
      ["servers", "Servers running"],
      ["computers", "Computers online"],
      ["players", "Players online"],
      ["attention", "Needs attention"],
    ].forEach(([key, label]) => {
      const tile = el("article", `home-tile home-tile--${key}`);
      tile.dataset.homeTile = key;
      if (key === "attention") tile.dataset.state = overview.attention.value === "0" ? "ok" : "alert";
      tile.append(el("span", "home-tile__label", label), el("strong", "home-tile__value", overview[key].value), el("small", "home-tile__detail", overview[key].detail));
      draft.append(tile);
    });
    reconcile(container, draft);
  }

  function renderAttention(container, items) {
    const draft = el("div");
    if (!items.length) {
      const ok = el("div", "home-attention__ok", "Everything looks good. AnxOS will tell you here if a computer disconnects, a server crashes, or memory or disk run low.");
      ok.setAttribute("role", "listitem");
      draft.append(ok);
    }
    items.forEach((item) => {
      const row = el("article", `home-attention__item home-attention__item--${item.severity}`);
      row.dataset.attentionId = item.id;
      row.setAttribute("role", "listitem");
      const text = el("div", "home-attention__text");
      text.append(el("strong", "", item.title), el("span", "", item.detail));
      row.append(text);
      if (item.action) {
        const button = el("button", "inline-action", item.action.label);
        button.type = "button";
        button.dataset.attentionAction = item.id;
        row.append(button);
      }
      draft.append(row);
    });
    reconcile(container, draft);
  }

  function computerCardElement(card) {
    const article = el("article", `home-computer${card.selected ? " is-selected" : ""}`);
    article.dataset.computerId = card.id;
    article.dataset.connection = card.connection;
    article.dataset.freshness = card.freshness;
    article.tabIndex = 0;
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", `${card.name}: ${card.connectionLabel}. Open details`);
    const head = el("div", "home-computer__head");
    const title = el("div", "home-computer__title");
    title.append(el("strong", "", card.name), el("span", "", card.os || "Operating system not reported"));
    const status = el("span", `home-status home-status--${card.connection}`, card.connectionLabel);
    head.append(title, status);
    const meters = el("div", "home-computer__meters");
    meters.append(
      meter("CPU", card.cpuPercent),
      meter("Memory", card.memoryPercent, card.memoryTotal ? `${bytes(card.memoryUsed)} of ${bytes(card.memoryTotal)}` : ""),
      meter("Disk", card.diskPercent, card.diskFree !== null ? `${bytes(card.diskFree)} free` : ""),
    );
    const foot = el("div", "home-computer__foot");
    foot.append(
      el("span", "", card.netDown !== null || card.netUp !== null ? `↓ ${rate(card.netDown)} · ↑ ${rate(card.netUp)}` : "Network —"),
      el("span", "", card.serverCount === null ? "Servers —" : `${card.runningServerCount ?? 0} of ${card.serverCount} servers running`),
      el("span", `home-freshness home-freshness--${card.freshness}`, card.freshnessLabel),
    );
    article.append(head, meters, foot);
    return article;
  }

  function renderComputers(container, state) {
    const draft = el("div");
    if (!state.computers.length) {
      draft.append(el("p", "home-empty", "No computers yet. Add the computer your servers will run on."));
    }
    state.computers.forEach((computer) => {
      draft.append(computerCardElement(Model.buildComputerCard(computer, AnxComputerVitals.get(computer.id), state.now)));
    });
    reconcile(container, draft);
  }

  // Delegated once per container: reconciliation keeps unchanged elements
  // only when their markup is identical, so handlers must not mark the DOM.
  function bindDelegatedHandlers() {
    const attention = document.querySelector("[data-home-attention]");
    if (attention && !attention.__anxBound) {
      attention.__anxBound = true;
      attention.addEventListener("click", (event) => {
        const button = event.target.closest("[data-attention-action]");
        if (!button) return;
        const item = (lastState?.attention || []).find((entry) => entry.id === button.dataset.attentionAction);
        runAttentionAction(item && item.action);
      });
    }
    const computers = document.querySelector("[data-home-computers]");
    if (computers && !computers.__anxBound) {
      computers.__anxBound = true;
      computers.addEventListener("click", (event) => {
        const card = event.target.closest("[data-computer-id]");
        if (card) openComputer(card.dataset.computerId);
      });
      computers.addEventListener("keydown", (event) => {
        const card = event.target.closest("[data-computer-id]");
        if (!card || event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        openComputer(card.dataset.computerId);
      });
    }
  }

  const SECTION_LABELS = Object.freeze({ attention: "Needs attention", servers: "My Servers", computers: "Computers", setup: "Setup checklist" });

  function applySectionPreferences() {
    const container = document.querySelector("[data-home-sections]");
    if (!container) return;
    const prefs = readPreferences();
    prefs.order.forEach((id) => {
      const section = container.querySelector(`[data-home-section="${id}"]`);
      if (section) {
        container.append(section);
        section.hidden = prefs.hidden.includes(id);
      }
    });
  }

  function renderCustomize() {
    const panel = document.querySelector("[data-home-customize]");
    if (!panel || panel.hidden) return;
    const prefs = readPreferences();
    const list = el("ol", "home-customize__list");
    prefs.order.forEach((id, index) => {
      const row = el("li", "home-customize__row");
      row.dataset.sectionId = id;
      const required = Model.REQUIRED_SECTIONS.includes(id);
      const show = el("label", "home-customize__show");
      const box = el("input");
      box.type = "checkbox";
      box.checked = !prefs.hidden.includes(id);
      box.disabled = required;
      box.addEventListener("change", () => {
        const next = readPreferences();
        next.hidden = box.checked ? next.hidden.filter((entry) => entry !== id) : [...next.hidden, id];
        writePreferences(next);
        applySectionPreferences();
        renderCustomize();
      });
      show.append(box, el("span", "", `${SECTION_LABELS[id] || id}${required ? " (always shown)" : ""}`));
      const up = el("button", "inline-action", "Move up");
      up.type = "button";
      up.disabled = index === 0;
      up.addEventListener("click", () => { writePreferences(Model.moveSection(readPreferences(), id, -1)); applySectionPreferences(); renderCustomize(); });
      const down = el("button", "inline-action", "Move down");
      down.type = "button";
      down.disabled = index === prefs.order.length - 1;
      down.addEventListener("click", () => { writePreferences(Model.moveSection(readPreferences(), id, 1)); applySectionPreferences(); renderCustomize(); });
      row.append(show, up, down);
      list.append(row);
    });
    const density = el("label", "home-customize__density");
    const select = el("select");
    [["comfortable", "Comfortable"], ["compact", "Compact"]].forEach(([value, label]) => {
      const option = el("option", "", label);
      option.value = value;
      select.append(option);
    });
    // Density is the existing app-wide appearance setting, not a second one.
    select.value = safe(() => (getCurrentSettings()["appearance.density"] === "compact" ? "compact" : "comfortable"), "comfortable");
    select.addEventListener("change", () => {
      safe(() => saveSettingsPatch({ "appearance.density": select.value }, { statusMessage: "Density saved." }), null);
    });
    density.append(el("span", "", "Density"), select);
    const reset = el("button", "inline-action", "Reset to default");
    reset.type = "button";
    reset.addEventListener("click", () => { writePreferences(Model.DEFAULT_PREFERENCES); applySectionPreferences(); renderCustomize(); });
    panel.replaceChildren(el("h2", "", "Customize Home"), el("p", "", "Choose which sections to show and their order. Your choices are kept on this computer."), list, density, reset);
  }

  function bindCustomizeToggle() {
    const toggle = document.querySelector("[data-home-customize-toggle]");
    const panel = document.querySelector("[data-home-customize]");
    if (!toggle || !panel || toggle.dataset.bound === "true") return;
    toggle.dataset.bound = "true";
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
      toggle.textContent = panel.hidden ? "Customize" : "Done";
      renderCustomize();
    });
  }

  let lastState = null;
  const notifiedPressure = new Set();

  // Sustained CPU and memory pressure is the one warning the alert engine
  // does not raise, so it goes to Activity through the existing notification
  // store (which also de-duplicates). Offline computers and low disk are
  // already alerted by the alert engine and are not notified twice.
  function notifyNewPressure(items) {
    const current = new Set();
    items.filter((item) => /^(memory|cpu):/.test(item.id)).forEach((item) => {
      current.add(item.id);
      if (notifiedPressure.has(item.id)) return;
      notifiedPressure.add(item.id);
      safe(() => createNotification({
        category: "Nodes",
        severity: "warning",
        title: item.title,
        message: item.detail,
        dedupKey: `home-pressure:${item.id}`,
        relatedNodeId: item.action?.target || "",
        relatedWorkspace: "nodes",
      }), null);
    });
    // A cleared condition can notify again if it comes back later.
    [...notifiedPressure].forEach((id) => { if (!current.has(id)) notifiedPressure.delete(id); });
  }

  function renderHome() {
    const overview = document.querySelector("[data-home-overview]");
    if (!overview) return;
    const state = buildState();
    lastState = state;
    renderOverview(overview, state.overview);
    renderAttention(document.querySelector("[data-home-attention]"), state.attention);
    notifyNewPressure(state.attention);
    renderComputers(document.querySelector("[data-home-computers]"), state);
  }

  // ---------------------------------------------------------------------------
  // Computers page detail panel
  // ---------------------------------------------------------------------------

  function viewingComputerId(computers) {
    let stored = "";
    try {
      stored = root.localStorage.getItem(SELECTED_COMPUTER_KEY) || "";
    } catch {
      stored = "";
    }
    if (computers.some((computer) => computer.id === stored)) return stored;
    return (computers.find((computer) => computer.selected) || computers[0] || {}).id || "";
  }

  // CPU and memory over the bounded in-memory history, as one SVG with two
  // lines. Gaps (missing readings) break the line instead of drawing 0.
  function historyGraph(history) {
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 300 80");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "computer-graph__svg");
    svg.setAttribute("role", "img");
    const points = Array.isArray(history) ? history : [];
    const label = points.length ? `CPU and memory over the last ${Model.formatAge(points[points.length - 1].at - points[0].at).replace(" ago", "")}` : "No readings yet";
    svg.setAttribute("aria-label", label);
    if (points.length >= 2) {
      const start = points[0].at;
      const span = Math.max(1, points[points.length - 1].at - start);
      ["memoryPercent", "cpuPercent"].forEach((key) => {
        let segment = [];
        const flush = () => {
          if (segment.length >= 2) {
            const line = document.createElementNS(svgNs, "polyline");
            line.setAttribute("points", segment.join(" "));
            line.setAttribute("class", `computer-graph__line computer-graph__line--${key === "cpuPercent" ? "cpu" : "memory"}`);
            svg.append(line);
          }
          segment = [];
        };
        points.forEach((point) => {
          const value = point[key];
          if (value === null || value === undefined) {
            flush();
            return;
          }
          const x = ((point.at - start) / span) * 300;
          const y = 80 - (Math.max(0, Math.min(100, value)) / 100) * 80;
          segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        });
        flush();
      });
    }
    return svg;
  }

  function detailRow(label, value) {
    const row = el("div", "computer-details__row");
    row.append(el("span", "", label), el("strong", "", value || "—"));
    return row;
  }

  let lastGraphSignature = "";

  // ---------------------------------------------------------------------------
  // Network section (Phase 8)
  // ---------------------------------------------------------------------------

  // Latest connection check per computer: { running, at, result, error }.
  const networkChecks = new Map();

  async function runNetworkCheck(nodeId) {
    const api = safe(() => getDesktopApiState().api, null);
    if (!nodeId || typeof api?.system?.networkCheck !== "function" || networkChecks.get(nodeId)?.running) return;
    networkChecks.set(nodeId, { ...(networkChecks.get(nodeId) || {}), running: true });
    lastGraphSignature = "";
    renderComputerDetails();
    let entry;
    try {
      const result = await api.system.networkCheck({ nodeId });
      entry = result && result.ok === false
        ? { running: false, at: Date.now(), result: null, error: result.error?.message || "The check could not run." }
        : { running: false, at: Date.now(), result, error: null };
    } catch (error) {
      entry = { running: false, at: Date.now(), result: null, error: String(error?.message || error || "The check could not run.") };
    }
    networkChecks.set(nodeId, entry);
    lastGraphSignature = "";
    renderComputerDetails();
  }

  function adapterRow(adapter) {
    const row = el("div", `computer-network__adapter${adapter.connected ? "" : " is-down"}`);
    row.setAttribute("role", "row");
    const name = el("div", "computer-network__name");
    name.setAttribute("role", "cell");
    name.append(el("strong", "", adapter.name), el("span", "", `${adapter.kindLabel} · ${adapter.status}`));
    const cells = [
      ["Address", adapter.address || "—"],
      ["Link speed", adapter.link],
      ["Download", rate(adapter.down)],
      ["Upload", rate(adapter.up)],
      ["Errors", adapter.issuesText],
    ].map(([label, value]) => {
      const cell = el("div", "computer-network__cell");
      cell.setAttribute("role", "cell");
      cell.append(el("span", "", label), el("strong", "", value));
      return cell;
    });
    row.append(name, ...cells);
    return row;
  }

  function renderNetworkSection(computer, reading) {
    const section = el("section", "computer-network");
    section.dataset.computerNetwork = computer.id;
    const head = el("div", "computer-network__head");
    head.append(el("h3", "", "Network"));
    const online = computer.connection === "online" || computer.connection === "warning";
    const check = networkChecks.get(computer.id) || null;
    const button = el("button", "inline-action", check?.running ? "Checking…" : "Check connection");
    button.type = "button";
    button.dataset.networkCheck = computer.id;
    button.disabled = !online || check?.running === true;
    button.title = "Pings the router three times, looks up one name and opens one HTTPS connection to example.com.";
    head.append(button);
    section.append(head);

    const details = Model.describeNetworkDetails(reading ? reading.networkDetails : null);
    if (!reading) {
      section.append(el("p", "home-empty", online ? "Collecting readings…" : "No readings: this computer is not connected."));
    } else if (!details.available) {
      section.append(el("p", "home-empty", details.reason));
    } else {
      const summary = el("div", "computer-network__summary");
      summary.append(
        detailRow("Router", details.router || "Not found"),
        detailRow("DNS servers", details.dnsServers.length ? details.dnsServers.join(", ") : "Not reported"),
      );
      section.append(summary);
      if (details.reason) section.append(el("p", "home-empty", details.reason));
      const table = el("div", "computer-network__table");
      table.setAttribute("role", "table");
      table.setAttribute("aria-label", "Network adapters");
      if (!details.main.length) table.append(el("p", "home-empty", "No wired or Wi-Fi connection is active."));
      details.main.forEach((adapter) => table.append(adapterRow(adapter)));
      section.append(table);
      if (details.other.length) {
        const more = el("details", "computer-network__other");
        more.append(el("summary", "", `Virtual, VPN and disconnected adapters (${details.other.length})`));
        const otherTable = el("div", "computer-network__table");
        otherTable.setAttribute("role", "table");
        otherTable.setAttribute("aria-label", "Other network adapters");
        details.other.forEach((adapter) => otherTable.append(adapterRow(adapter)));
        more.append(otherTable);
        section.append(more);
      }
      section.append(el("small", "", `${details.warming ? "Speeds appear after the next reading. " : ""}Link speed is the connection to your router or switch, not your internet speed.`));
    }

    if (check && !check.running) {
      const results = el("div", "computer-network__check");
      results.dataset.networkCheckResult = computer.id;
      if (check.error) {
        results.append(el("p", "home-attention__item home-attention__item--warning", check.error));
      } else {
        Model.describeNetworkCheck(check.result).forEach((step) => {
          const row = el("div", `computer-network__step computer-network__step--${step.ok ? "ok" : "bad"}`);
          row.dataset.step = step.id;
          row.append(el("span", "", step.label), el("strong", "", step.text));
          results.append(row);
        });
      }
      results.append(el("small", "", `Checked ${safe(() => new Date(check.at).toLocaleTimeString(), "just now")}.`));
      section.append(results);
    }
    return section;
  }

  function renderComputerDetails() {
    const panel = document.querySelector("[data-computer-details]");
    if (!panel) return;
    const computers = getComputers();
    const viewing = viewingComputerId(computers);
    const computer = computers.find((entry) => entry.id === viewing);
    const now = Date.now();

    const picker = el("div", "computer-details__picker");
    picker.setAttribute("role", "tablist");
    picker.setAttribute("aria-label", "Choose a computer");
    computers.forEach((entry) => {
      const chip = el("button", `computer-chip${entry.id === viewing ? " is-active" : ""}`, entry.name);
      chip.type = "button";
      chip.dataset.viewComputer = entry.id;
      chip.dataset.connection = entry.connection;
      chip.setAttribute("role", "tab");
      chip.setAttribute("aria-selected", entry.id === viewing ? "true" : "false");
      picker.append(chip);
    });

    const body = el("div", "computer-details__body");
    if (!computer) {
      body.append(el("p", "home-empty", "No computers yet."));
    } else {
      const vitalsEntry = AnxComputerVitals.get(computer.id);
      const card = Model.buildComputerCard(computer, vitalsEntry, now);
      const reading = vitalsEntry && vitalsEntry.reading;
      const header = el("div", "computer-details__header");
      const title = el("div");
      title.append(el("h2", "", card.name), el("span", "", card.os || "Operating system not reported"));
      const status = el("div", "computer-details__status");
      status.append(el("span", `home-status home-status--${card.connection}`, card.connectionLabel), el("span", `home-freshness home-freshness--${card.freshness}`, card.freshnessLabel));
      header.append(title, status);

      const cards = el("div", "computer-details__cards");
      const cpuCard = el("article", "computer-card");
      cpuCard.append(meter("CPU", card.cpuPercent, reading && reading.perCore.length && card.cpuPercent !== null ? `${reading.perCore.length} cores` : ""));
      if (card.cpuPercent !== null && reading && reading.perCore.length) {
        const cores = el("div", "computer-cores");
        cores.setAttribute("aria-label", "Per-core usage");
        reading.perCore.forEach((value, index) => {
          const core = el("span", "computer-cores__core");
          core.style.setProperty("--core", value === null ? "0" : String(Math.max(0, Math.min(100, value))));
          core.title = `Core ${index + 1}: ${percentText(value)}`;
          cores.append(core);
        });
        cpuCard.append(cores);
      }
      const memoryCard = el("article", "computer-card");
      memoryCard.append(meter("Memory", card.memoryPercent, card.memoryTotal ? `${bytes(card.memoryUsed)} used of ${bytes(card.memoryTotal)}` : ""));
      const diskCard = el("article", "computer-card");
      diskCard.append(meter("Disk", card.diskPercent, card.diskFree !== null ? `${bytes(card.diskFree)} free` : ""));
      const netCard = el("article", "computer-card computer-card--network");
      netCard.append(el("span", "home-meter__label", "Network"), el("strong", "", `↓ ${rate(card.netDown)}`), el("strong", "", `↑ ${rate(card.netUp)}`));
      cards.append(cpuCard, memoryCard, diskCard, netCard);
      if (card.gpus.length) {
        card.gpus.forEach((gpu) => {
          const gpuCard = el("article", "computer-card");
          gpuCard.append(meter(gpu.name || "GPU", gpu.utilizationPercent, gpu.memoryTotalBytes ? `${bytes(gpu.memoryUsedBytes)} of ${bytes(gpu.memoryTotalBytes)} video memory${gpu.temperatureCelsius !== null ? ` · ${Math.round(gpu.temperatureCelsius)}°C` : ""}` : ""));
          cards.append(gpuCard);
        });
      }

      const graph = el("section", "computer-graph");
      graph.append(el("h3", "", "Recent activity"));
      const legend = el("div", "computer-graph__legend");
      legend.append(el("span", "computer-graph__key computer-graph__key--cpu", "CPU"), el("span", "computer-graph__key computer-graph__key--memory", "Memory"));
      const hasHistory = Boolean(vitalsEntry && vitalsEntry.history && vitalsEntry.history.length >= 2);
    graph.append(legend, historyGraph(vitalsEntry && vitalsEntry.history));
    if (!hasHistory) graph.append(el("p", "home-empty", card.connection === "online" || card.connection === "warning" ? "Collecting readings…" : "No readings: this computer is not connected."));
    graph.append(el("small", "", "Recent readings are kept in memory while AnxOS is open. Longer history is kept by Telemetry in Settings."));

      const info = el("section", "computer-details__info");
      const node = computer.node || {};
      const identity = safe(() => getNodeIdentity(node), {}) || {};
      info.append(
        el("h3", "", "Computer and Agent"),
        detailRow("Operating system", card.os),
        detailRow("Processor", reading && reading.cpuModel ? `${reading.cpuModel}${reading.cpuCores ? ` · ${reading.cpuCores} cores` : ""}` : identity.cpuModel || ""),
        detailRow("Uptime", reading && reading.uptimeSeconds !== null ? safe(() => formatDuration(reading.uptimeSeconds), `${Math.round(reading.uptimeSeconds / 3600)} h`) : ""),
        detailRow("Agent version", node.kind === "application-host" ? "Not needed on this computer" : safe(() => describeNodeAgentBuild(node), "") || ""),
        detailRow("Connection", safe(() => getNodeStatusLabel(node), card.connectionLabel)),
        detailRow("Address", node.agentUrl || node.baseUrl || (node.kind === "application-host" ? "This computer" : "")),
      );

      const networkSection = renderNetworkSection(computer, reading);

      const servers = el("section", "computer-details__servers");
      servers.append(el("h3", "", "Servers on this computer"));
      if (computer.selected) {
        const list = getServers();
        if (!list.length) servers.append(el("p", "home-empty", "No servers on this computer yet."));
        list.forEach((server) => {
          const row = el("div", "computer-details__server");
          row.append(el("strong", "", server.name), el("span", `home-status home-status--${server.running ? "online" : /fail|crash/i.test(server.state) ? "error" : "offline"}`, server.running ? "Running" : server.state || "Stopped"));
          servers.append(row);
        });
      } else {
        servers.append(el("p", "", card.serverCount === null ? "Switch to this computer to see its servers." : `${card.runningServerCount ?? 0} of ${card.serverCount} servers running. Switch to this computer to manage them.`));
      }

      const alerts = el("section", "computer-details__alerts");
      alerts.append(el("h3", "", "Alerts"));
      const items = Model.buildAttentionItems({ computers: [computer], vitalsById: AnxComputerVitals.all(), now }).filter((item) => item.severity !== "info");
      if (!items.length) alerts.append(el("p", "home-empty", "No alerts for this computer."));
      items.forEach((item) => {
        const row = el("div", `home-attention__item home-attention__item--${item.severity}`);
        const text = el("div", "home-attention__text");
        text.append(el("strong", "", item.title), el("span", "", item.detail));
        row.append(text);
        alerts.append(row);
      });

      body.append(header, cards, graph, info, networkSection, servers, alerts);
      if (!computer.selected) {
        const manage = el("button", "inline-action inline-action--primary", `Switch to ${card.name}`);
        manage.type = "button";
        manage.dataset.switchComputer = computer.id;
        body.append(manage);
      }
    }

    // The graph is the costliest part; skip re-rendering when nothing changed.
    const historyEntry = computer ? AnxComputerVitals.get(computer.id) : null;
    const signature = [viewing, networkChecks.get(viewing)?.at || 0, networkChecks.get(viewing)?.running ? 1 : 0, historyEntry?.history?.length || 0, historyEntry?.reading?.at || 0, historyEntry?.error || "", computer?.connection || "", fleetState?.checkedAt || "", Math.floor(now / 10000)].join("|");
    if (signature === lastGraphSignature && panel.childElementCount) return;
    lastGraphSignature = signature;
    const draft = el("div");
    draft.append(picker, body);
    reconcile(panel, draft);
    if (!panel.__anxBound) {
      panel.__anxBound = true;
      panel.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-view-computer]");
        if (chip) {
          try {
            root.localStorage.setItem(SELECTED_COMPUTER_KEY, chip.dataset.viewComputer);
          } catch {
            // Remembering the computer is a convenience only.
          }
          lastGraphSignature = "";
          renderComputerDetails();
          return;
        }
        const checkButton = event.target.closest("[data-network-check]");
        if (checkButton) {
          runNetworkCheck(checkButton.dataset.networkCheck);
          return;
        }
        const switchButton = event.target.closest("[data-switch-computer]");
        if (switchButton) safe(() => selectNode(switchButton.dataset.switchComputer), null);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  function render() {
    bindCustomizeToggle();
    bindDelegatedHandlers();
    renderHome();
    renderComputerDetails();
  }

  function tick() {
    if (document.hidden) return;
    const page = safe(() => getActivePageName(), "");
    if (page === "dashboard") renderHome();
    if (page === "nodes") renderComputerDetails();
    maybeRefreshFleet();
    pollRemoteComputers();
  }

  function start() {
    applySectionPreferences();
    render();
    root.setInterval(tick, TICK_MS);
  }

  root.AnxHomeDashboard = { render, renderHome, renderComputerDetails, applySectionPreferences, _state: () => lastState };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(typeof window !== "undefined" ? window : globalThis);
