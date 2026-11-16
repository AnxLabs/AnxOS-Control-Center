// My Servers › All computers (Build 213-B). One list of the servers on every
// paired computer, each with the computer it runs on. A computer that is
// offline keeps its servers on the list as "last known" (from the main
// process cache), and nothing can be started or stopped there.
//
// Open switches to the server's own computer first and then opens the
// Phase 5 server page through the existing flow, so a server is never opened
// against the wrong computer. Start / Stop / Restart on several servers go
// through instances:fleetAction, which sends each server's action to its own
// computer, one at a time, after a confirmation that names every server and
// its computer. All text goes in with textContent.
(function initializeServerFleet(root) {
  "use strict";

  const MODE_KEY = "anxos.servers.allComputers.v1";
  const REFRESH_MS = 30000;
  const STATE_LABELS = {
    running: "Running",
    starting: "Starting",
    stopping: "Stopping",
    stopped: "Stopped",
    crashed: "Crashed",
    "setup-required": "Setup required",
    "last-known": "Computer offline",
    unknown: "Unknown",
  };
  const STATE_ORDER = { crashed: 0, starting: 1, stopping: 1, running: 2, "setup-required": 3, stopped: 4, "last-known": 5, unknown: 6 };

  let enabled = false;
  let data = { computers: [], servers: [] };
  let loading = false;
  let timer = null;
  const selected = new Set();
  const view = { search: "", state: "all", sort: "computer" };

  function api() {
    return root.anx?.instances || null;
  }

  function el(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function safe(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function formatMemory(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    return safe(() => root.formatBytes(bytes), `${Math.round(bytes / 1048576)} MB`);
  }

  function formatAgo(iso) {
    const at = Date.parse(iso || "");
    if (!Number.isFinite(at)) return "unknown time";
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
  }

  function panel() { return root.document.querySelector("[data-server-fleet]"); }
  function toggleButton() { return root.document.querySelector("[data-servers-all-computers]"); }
  function singleComputerShell() { return root.document.querySelector(".instances-main-shell"); }

  function visibleServers() {
    const query = view.search.trim().toLowerCase();
    const list = data.servers.filter((server) => {
      if (view.state !== "all" && server.state !== view.state) return false;
      if (!query) return true;
      return [server.name, server.nodeName, server.game, server.instanceId].some((value) => String(value || "").toLowerCase().includes(query));
    });
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    const sorters = {
      computer: (a, b) => a.nodeName.localeCompare(b.nodeName, undefined, { sensitivity: "base" }) || byName(a, b),
      name: byName,
      status: (a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || byName(a, b),
      cpu: (a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || byName(a, b),
    };
    return list.sort(sorters[view.sort] || sorters.computer);
  }

  function renderSummary(container) {
    const line = el("p", "platform-note");
    const parts = data.computers.map((computer) => {
      if (computer.status === "online") return `${computer.name}: ${computer.serverCount} server${computer.serverCount === 1 ? "" : "s"}`;
      const when = computer.fetchedAt ? `, last known ${formatAgo(computer.fetchedAt)}` : "";
      return `${computer.name}: not connected${computer.lastKnown ? when : ", no saved list"}`;
    });
    line.textContent = parts.length ? parts.join(" · ") : "No computers are paired yet.";
    container.append(line);
  }

  function renderControls(container) {
    const bar = el("div", "instances-controlbar");
    const search = el("label", "docker-search");
    search.append(el("span", "", "Search all computers"));
    const input = el("input");
    input.type = "search";
    input.placeholder = "Server, computer or game";
    input.value = view.search;
    input.addEventListener("input", () => { view.search = input.value; renderTable(); });
    search.append(input);
    const stateLabel = el("label", "docker-filter");
    stateLabel.append(el("span", "", "Status"));
    const state = el("select");
    [["all", "All statuses"], ["running", "Running"], ["stopped", "Stopped"], ["starting", "Starting"], ["crashed", "Crashed"], ["last-known", "Computer offline"]].forEach(([value, label]) => {
      const option = el("option", "", label);
      option.value = value;
      option.selected = view.state === value;
      state.append(option);
    });
    state.addEventListener("change", () => { view.state = state.value; renderTable(); });
    stateLabel.append(state);
    const sortLabel = el("label", "docker-filter");
    sortLabel.append(el("span", "", "Sort"));
    const sort = el("select");
    [["computer", "By computer"], ["status", "By status"], ["name", "By name"], ["cpu", "Most CPU"]].forEach(([value, label]) => {
      const option = el("option", "", label);
      option.value = value;
      option.selected = view.sort === value;
      sort.append(option);
    });
    sort.addEventListener("change", () => { view.sort = sort.value; renderTable(); });
    sortLabel.append(sort);
    const actions = el("div", "docker-actions");
    const refresh = el("button", "inline-action", loading ? "Refreshing…" : "Refresh");
    refresh.type = "button";
    refresh.disabled = loading;
    refresh.addEventListener("click", () => load());
    actions.append(refresh);
    ["start", "stop", "restart"].forEach((verb) => {
      const button = el("button", "inline-action", `${verb[0].toUpperCase()}${verb.slice(1)} selected`);
      button.type = "button";
      button.dataset.serverFleetBulk = verb;
      button.disabled = selected.size === 0;
      button.addEventListener("click", () => runBulk(verb));
      actions.append(button);
    });
    bar.append(search, stateLabel, sortLabel, actions);
    container.append(bar);
  }

  function renderTable() {
    const host = panel()?.querySelector("[data-server-fleet-table]");
    if (!host) return;
    host.replaceChildren();
    const servers = visibleServers();
    if (!servers.length) {
      host.append(el("p", "platform-note", loading ? "Reading servers from every computer…" : "No servers match."));
      updateBulkButtons();
      return;
    }
    const table = el("table", "docker-table instances-table");
    const head = el("thead");
    const headRow = el("tr");
    ["", "Server", "Computer", "Status", "CPU", "RAM", "Actions"].forEach((label) => {
      const th = el("th", "", label);
      th.scope = "col";
      headRow.append(th);
    });
    head.append(headRow);
    const body = el("tbody");
    servers.forEach((server) => {
      const row = el("tr");
      row.dataset.serverFleetRow = server.key;
      const pick = el("td");
      const box = el("input");
      box.type = "checkbox";
      box.disabled = server.lastKnown;
      box.checked = selected.has(server.key);
      box.setAttribute("aria-label", `Select ${server.name} on ${server.nodeName}`);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(server.key); else selected.delete(server.key);
        updateBulkButtons();
      });
      pick.append(box);
      const name = el("td");
      name.append(el("strong", "", server.name));
      if (server.game) name.append(el("span", "platform-note", ` ${server.game}`));
      const computer = el("td", "", server.nodeName);
      const status = el("td");
      const pill = el("span", `status-pill ${safe(() => root.getInstanceStateClass(server.reportedState), "")}`.trim(), STATE_LABELS[server.state] || "Unknown");
      if (server.lastKnown) pill.title = `Last seen ${STATE_LABELS[server.reportedState] || "unknown"}, ${formatAgo(server.fetchedAt)}.`;
      if (server.failureReason) pill.title = String(server.failureReason);
      status.append(pill);
      const cpu = el("td", "", Number.isFinite(server.cpuPercent) ? `${server.cpuPercent.toFixed(1)}%` : "—");
      const ram = el("td", "", formatMemory(server.memoryBytes));
      const actions = el("td");
      const open = el("button", "inline-action", "Open");
      open.type = "button";
      open.disabled = server.lastKnown;
      open.title = server.lastKnown ? `${server.nodeName} is not connected.` : `Open ${server.name} on ${server.nodeName}`;
      open.addEventListener("click", () => openServer(server));
      actions.append(open);
      row.append(pick, name, computer, status, cpu, ram, actions);
      body.append(row);
    });
    table.append(head, body);
    const wrap = el("div", "docker-table-wrap");
    wrap.append(table);
    host.append(wrap);
    updateBulkButtons();
  }

  function updateBulkButtons() {
    panel()?.querySelectorAll("[data-server-fleet-bulk]").forEach((button) => { button.disabled = selected.size === 0; });
  }

  function render() {
    const container = panel();
    if (!container) return;
    container.replaceChildren();
    const header = el("div", "settings-section__header");
    const titles = el("div");
    titles.append(el("h2", "", "Servers on all computers"), el("p", "platform-note", "Every server on every paired computer. Open switches to that server's computer first."));
    header.append(titles);
    container.append(header);
    renderSummary(container);
    renderControls(container);
    const table = el("div");
    table.dataset.serverFleetTable = "";
    container.append(table);
    renderTable();
  }

  async function load() {
    const instancesApi = api();
    if (!instancesApi?.listAcrossComputers || loading) return;
    loading = true;
    render();
    try {
      data = await instancesApi.listAcrossComputers();
      const keys = new Set(data.servers.filter((server) => !server.lastKnown).map((server) => server.key));
      [...selected].forEach((key) => { if (!keys.has(key)) selected.delete(key); });
    } catch (error) {
      safe(() => root.showToast(error?.message || "Servers could not be read from every computer.", "warning"));
    } finally {
      loading = false;
      if (enabled) render();
    }
  }

  async function openServer(server) {
    if (server.lastKnown) return;
    setEnabled(false);
    const switched = await safe(() => root.selectNode(server.nodeId), null);
    if (switched && switched.error) return;
    await safe(() => root.openDashboardInstanceDetails(server.instanceId), null);
  }

  async function runBulk(verb) {
    const instancesApi = api();
    const targets = data.servers.filter((server) => selected.has(server.key) && !server.lastKnown);
    if (!instancesApi?.fleetAction || !targets.length) return;
    const names = targets.map((server) => `${server.name} (${server.nodeName})`).join(", ");
    const needsConfirm = verb !== "start";
    if (needsConfirm) {
      const confirmed = await safe(() => root.createSecurityConfirmation({
        title: `${verb === "stop" ? "Stop" : "Restart"} ${targets.length} server${targets.length === 1 ? "" : "s"}?`,
        message: `Players on these servers are disconnected: ${names}.`,
        confirmLabel: verb === "stop" ? "Stop servers" : "Restart servers",
      }), false);
      if (!confirmed) return;
    }
    try {
      const result = await instancesApi.fleetAction(verb, targets.map((server) => ({ nodeId: server.nodeId, instanceId: server.instanceId })), { confirm: needsConfirm });
      const failures = (result?.results || []).filter((entry) => !entry.ok);
      safe(() => root.showToast(failures.length
        ? `${result.succeeded} done, ${failures.length} not: ${failures.map((entry) => `${entry.nodeName || entry.nodeId}: ${entry.message}`).join("; ")}`
        : `${verb[0].toUpperCase()}${verb.slice(1)} sent to ${result.succeeded} server${result.succeeded === 1 ? "" : "s"}.`, failures.length ? "warning" : "success"));
      selected.clear();
    } catch (error) {
      safe(() => root.showToast(error?.message || "The action failed.", "warning"));
    }
    await load();
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    safe(() => root.localStorage.setItem(MODE_KEY, enabled ? "1" : "0"));
    const button = toggleButton();
    if (button) {
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("is-active", enabled);
    }
    const container = panel();
    if (container) container.hidden = !enabled;
    const shell = singleComputerShell();
    if (shell) shell.hidden = enabled;
    if (timer) { root.clearInterval(timer); timer = null; }
    if (enabled) {
      render();
      load();
      timer = root.setInterval(() => {
        const locked = safe(() => root.isAppLockedForBackgroundWork(), false);
        if (!root.document.hidden && !locked && panel() && !panel().hidden) load();
      }, REFRESH_MS);
    }
  }

  function mount() {
    const button = toggleButton();
    if (!button) return;
    button.addEventListener("click", () => setEnabled(!enabled));
    if (safe(() => root.localStorage.getItem(MODE_KEY), "0") === "1") setEnabled(true);
  }

  root.AnxServerFleet = { setEnabled, load, _test: { visibleServers: () => visibleServers(), setData: (next) => { data = next; } } };
  if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", mount);
  else mount();
})(window);
