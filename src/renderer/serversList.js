// My Servers list tools (Phase 8): sorting, a "Select servers" mode and bulk
// Start / Stop / Restart. The table, its rows and their hooks stay as they
// are (the Phase 5 server view opens from a row); this module only orders the
// rows, adds a checkbox to each name while selecting, and runs the chosen
// action through the same runInstanceAction path a single row uses, one
// server at a time, after a confirmation that names every server.
(function initializeServersList(root) {
  "use strict";

  const SORT_KEY = "anxos.servers.sort.v1";
  const SORTS = [
    ["status", "Status"],
    ["name", "Name"],
    ["cpu", "Most CPU"],
    ["memory", "Most memory"],
  ];
  const STATUS_ORDER = { failed: 0, unhealthy: 0, crashed: 0, starting: 1, stopping: 1, restarting: 1, reloading: 1, running: 2, stopped: 3 };
  const ACTIONS = {
    start: { label: "Start", can: (instance) => safe(() => canStartInstance(instance), false), verb: "start" },
    stop: { label: "Stop", can: (instance) => safe(() => canStopInstance(instance), false), verb: "stop" },
    restart: { label: "Restart", can: (instance) => safe(() => canRestartInstance(instance), false), verb: "restart" },
  };

  let selecting = false;
  const selected = new Set();
  let running = false;

  function safe(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function readSort() {
    const value = safe(() => root.localStorage.getItem(SORT_KEY), "");
    return SORTS.some(([key]) => key === value) ? value : "status";
  }

  function stateClass(instance) {
    return safe(() => getInstanceStateClass(instance.state), String(instance?.state || "").toLowerCase());
  }

  function metric(instance, key) {
    const metrics = safe(() => getInstanceRowMetrics(instance), null);
    const value = Number(key === "cpu" ? metrics?.cpuPercent : metrics?.memoryRssBytes);
    return Number.isFinite(value) ? value : -1;
  }

  function nameOf(instance) {
    return String(instance?.displayName || instance?.id || "");
  }

  // Returns a new array; the caller's list is not changed.
  function sort(instances) {
    const list = Array.isArray(instances) ? instances.slice() : [];
    const by = readSort();
    const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base", numeric: true });
    if (by === "name") return list.sort(byName);
    if (by === "cpu" || by === "memory") return list.sort((a, b) => metric(b, by) - metric(a, by) || byName(a, b));
    return list.sort((a, b) => (STATUS_ORDER[stateClass(a)] ?? 4) - (STATUS_ORDER[stateClass(b)] ?? 4) || byName(a, b));
  }

  // Called while a row's name cell is built: adds the checkbox in select mode.
  // `checked` is set as an attribute so the row's markup reflects it (rows are
  // reconciled by markup).
  function decorateNameCell(wrapper, instance) {
    if (!selecting || !wrapper || !instance?.id) return;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "servers-select";
    box.dataset.serverSelect = instance.id;
    box.setAttribute("aria-label", `Select ${nameOf(instance)}`);
    if (selected.has(instance.id)) box.setAttribute("checked", "");
    wrapper.prepend(box);
  }

  function instances() {
    return safe(() => getInstances(), []) || [];
  }

  function rerender() {
    safe(() => renderInstanceRows(instances()), null);
    safe(() => updateTitlebar(), null);
    renderBar();
  }

  function renderBar() {
    const bar = document.querySelector("[data-servers-bulk]");
    if (!bar) return;
    const known = new Set(instances().map((instance) => instance.id));
    [...selected].forEach((id) => { if (!known.has(id)) selected.delete(id); });
    bar.hidden = !selecting;
    const toggle = document.querySelector("[data-servers-select-toggle]");
    if (toggle) {
      toggle.textContent = selecting ? "Done selecting" : "Select servers";
      toggle.setAttribute("aria-pressed", selecting ? "true" : "false");
    }
    const count = bar.querySelector("[data-servers-bulk-count]");
    if (count) count.textContent = selected.size ? `${selected.size} selected` : "Select servers to act on several at once.";
    const chosen = instances().filter((instance) => selected.has(instance.id));
    bar.querySelectorAll("[data-servers-bulk-action]").forEach((button) => {
      const action = ACTIONS[button.dataset.serversBulkAction];
      button.disabled = running || !chosen.some((instance) => action.can(instance));
    });
  }

  async function runBulk(actionKey) {
    const action = ACTIONS[actionKey];
    if (!action || running) return;
    const chosen = instances().filter((instance) => selected.has(instance.id));
    const eligible = chosen.filter((instance) => action.can(instance));
    const skipped = chosen.filter((instance) => !action.can(instance));
    if (!eligible.length) return;
    const names = eligible.map(nameOf);
    const message = `${action.label} ${eligible.length === 1 ? "this server" : `these ${eligible.length} servers`}: ${names.join(", ")}.${skipped.length ? ` Skipped (already ${action.verb === "start" ? "running" : "stopped"} or busy): ${skipped.map(nameOf).join(", ")}.` : ""} They are handled one at a time.`;
    const confirmed = await safe(() => createSecurityConfirmation({ title: `${action.label} ${eligible.length === 1 ? "server" : "servers"}?`, message, confirmLabel: action.label }), Promise.resolve(false));
    if (!confirmed) return;
    running = true;
    renderBar();
    const failures = [];
    try {
      for (const instance of eligible) {
        // Re-check against the latest state: another action may have run.
        const current = safe(() => findInstance(instance.id), instance);
        if (!current || !action.can(current)) continue;
        try {
          selectInstance(current.id);
          await runInstanceAction(actionKey, { confirmed: true });
        } catch (error) {
          failures.push(`${nameOf(current)} (${safe(() => getAgentErrorMessage(error, "failed"), "failed")})`);
        }
      }
    } finally {
      running = false;
      renderBar();
    }
    safe(() => showToast(failures.length ? `${action.label} finished with problems: ${failures.join("; ")}` : `${action.label} sent to ${eligible.length} ${eligible.length === 1 ? "server" : "servers"}.`, failures.length ? "warning" : "success"), null);
  }

  function mount() {
    const controls = document.querySelector('.page[data-page="instances"] .instances-controlbar');
    if (!controls || controls.querySelector("[data-servers-sort]")) return;
    const sortLabel = document.createElement("label");
    sortLabel.className = "docker-filter";
    const sortText = document.createElement("span");
    sortText.textContent = "Sort";
    const select = document.createElement("select");
    select.dataset.serversSort = "";
    SORTS.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
    select.value = readSort();
    select.addEventListener("change", () => {
      safe(() => root.localStorage.setItem(SORT_KEY, select.value), null);
      rerender();
    });
    sortLabel.append(sortText, select);
    const actions = controls.querySelector(".docker-actions");
    controls.insertBefore(sortLabel, actions || null);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "inline-action";
    toggle.dataset.serversSelectToggle = "";
    toggle.textContent = "Select servers";
    toggle.addEventListener("click", () => {
      selecting = !selecting;
      if (!selecting) selected.clear();
      rerender();
    });
    if (actions) actions.prepend(toggle);

    const bar = document.createElement("div");
    bar.className = "servers-bulk";
    bar.dataset.serversBulk = "";
    bar.hidden = true;
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Selected servers");
    const count = document.createElement("span");
    count.dataset.serversBulkCount = "";
    bar.append(count);
    Object.entries(ACTIONS).forEach(([key, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "inline-action";
      button.dataset.serversBulkAction = key;
      button.textContent = `${action.label} selected`;
      button.addEventListener("click", () => runBulk(key));
      bar.append(button);
    });
    controls.after(bar);

    const list = document.querySelector("[data-instances-list]");
    // A checkbox click selects; it must not open the server.
    list?.addEventListener("click", (event) => {
      const box = event.target.closest("[data-server-select]");
      if (!box) return;
      event.stopPropagation();
      if (box.checked) selected.add(box.dataset.serverSelect);
      else selected.delete(box.dataset.serverSelect);
      if (box.checked) box.setAttribute("checked", "");
      else box.removeAttribute("checked");
      renderBar();
    }, true);
    list?.addEventListener("keydown", (event) => {
      if (event.target.closest("[data-server-select]")) event.stopPropagation();
    }, true);
    renderBar();
  }

  // Re-draw the rows when the selected computer connects or disconnects, so a
  // server on a computer that went away stops looking live.
  // Node health is otherwise only re-checked on Home and Computers, so on My
  // Servers the selected computer is checked every 15 s (one health request)
  // and the node list reloaded when the answer differs from what is shown.
  let lastConnection = null;
  let lastHealthCheck = 0;
  let healthInFlight = false;
  async function checkSelectedComputer(node) {
    const api = safe(() => getDesktopApiState().api.nodes, null);
    // Never while a server action runs: reloading the node list could make
    // that action look out of date and stop it.
    if (running || safe(() => instanceActionRequestInFlight, false)) return;
    if (healthInFlight || !node || node.kind === "application-host" || typeof api?.health !== "function") return;
    healthInFlight = true;
    lastHealthCheck = Date.now();
    try {
      const health = await api.health(node.id);
      const reachable = health && health.ok !== false && health.connected !== false;
      const shownOnline = ["online", "warning"].includes(safe(() => getNodeVisualState(node), ""));
      if (reachable !== shownOnline && !running && !safe(() => instanceActionRequestInFlight, false)) await safe(() => refreshNodes(), Promise.resolve());
    } catch {
      if (["online", "warning"].includes(safe(() => getNodeVisualState(node), ""))) await safe(() => refreshNodes(), Promise.resolve());
    } finally {
      healthInFlight = false;
    }
  }
  root.setInterval(() => {
    if (document.hidden || safe(() => getActivePageName(), "") !== "instances") return;
    const node = safe(() => getSelectedNode(), null);
    if (Date.now() - lastHealthCheck >= 15000) checkSelectedComputer(node);
    const connection = node ? `${node.id}:${safe(() => getNodeVisualState(node), "")}:${safe(() => isInstanceListStale(), false)}` : "";
    if (lastConnection !== null && connection !== lastConnection) rerender();
    lastConnection = connection;
  }, 3000);

  root.AnxServersList = { sort, decorateNameCell, renderBar, isSelecting: () => selecting, selected: () => [...selected] };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})(typeof window !== "undefined" ? window : globalThis);
