// Agent Control › Updates › Automatic Agent updates (Build 213-C).
// Reads and saves agent-auto-update.json through nodes:getAgentAutoUpdate /
// nodes:setAgentAutoUpdate; the main-process scheduler reads that same file
// on every tick, so Save and "Turn off now" change behavior, not only the
// screen. Shows the Agent update history (manual, Update all and automatic
// attempts). All text goes in with textContent.
(function initializeAgentAutoUpdate(root) {
  "use strict";

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const STATUS_LABELS = {
    running: "Running",
    succeeded: "Updated",
    "up-to-date": "Already up to date",
    skipped: "Skipped",
    failed: "Failed",
    "needs-approval": "Needs your approval",
    available: "Update available",
  };
  const TRIGGER_LABELS = { manual: "Update", "update-all": "Update all", automatic: "Automatic" };
  const ROLLBACK_LABELS = { "rolled-back": "Rolled back, healthy", "rollback-failed": "Rollback failed", unavailable: "No rollback package" };

  let state = { policy: null, history: [], overview: null };
  let dirty = false;
  let busy = false;
  // Each load is numbered; a slower, older response never replaces what a
  // newer one already drew (an update can finish while a check is running).
  let loadSequence = 0;

  function nodesApi() {
    return root.anx?.nodes || null;
  }

  function $(selector) {
    return root.document.querySelector(`[data-agent-auto-update] ${selector}`);
  }

  function el(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function toast(message, tone) {
    try { root.showToast(message, tone); } catch {}
  }

  function describe(policy) {
    if (!policy) return "Loading…";
    if (!policy.enabled) return "Off. Agents update only when you choose Update or Update all Agents.";
    const days = policy.days.length === 7 ? "every day" : policy.days.map((day) => DAYS[day]).join(", ");
    const hours = Math.round(policy.durationMinutes / 60 * 10) / 10;
    const what = policy.mode === "apply" ? "installs eligible updates" : "tells you about updates without installing them";
    const count = policy.nodeIds.length;
    return `On: ${what} ${days}, ${policy.start} for ${hours} h, on ${count} computer${count === 1 ? "" : "s"}.${count ? "" : " Choose at least one computer below."}`;
  }

  function readForm() {
    const base = state.policy || {};
    const days = [...root.document.querySelectorAll("[data-agent-auto-update-days] input:checked")].map((input) => Number(input.value));
    // Until the computer list has loaded there are no boxes to read: keep the
    // saved choice instead of saving "no computers".
    const boxes = [...root.document.querySelectorAll("[data-agent-auto-update-computers] input")];
    const nodeIds = boxes.length
      ? boxes.filter((input) => input.checked).map((input) => input.value)
      : [...(base.nodeIds || [])];
    return {
      ...base,
      enabled: $('[data-agent-auto-update-field="enabled"]')?.checked === true,
      mode: $('[data-agent-auto-update-field="mode"]')?.value === "apply" ? "apply" : "notify",
      start: $('[data-agent-auto-update-field="start"]')?.value || base.start,
      durationMinutes: Number($('[data-agent-auto-update-field="durationMinutes"]')?.value) || base.durationMinutes,
      days: days.length ? days : base.days,
      nodeIds,
    };
  }

  // What the list says next to a computer. "Can't update from here" only when
  // an update is actually blocked, never for one that is already up to date.
  function computerNote(entry) {
    if (entry.state === "up-to-date") return " · up to date";
    if (entry.state === "offline") return " · not connected";
    return entry.canUpdate ? "" : " · can't update from here";
  }

  function computerLabelText(entry) {
    return `${entry.name} · ${entry.installedBuild || "build not reported"}${computerNote(entry)}`;
  }

  // While the owner is editing, only the text next to each box is refreshed
  // (build, connected or not); the boxes they may have ticked stay as they are.
  function refreshComputerNotes() {
    const computers = $("[data-agent-auto-update-computers]");
    if (!computers) return;
    const entries = new Map((state.overview?.nodes || []).map((entry) => [entry.nodeId, entry]));
    computers.querySelectorAll("label").forEach((label) => {
      const input = label.querySelector("input");
      const entry = input ? entries.get(input.value) : null;
      if (!entry) return;
      label.title = entry.reason || "";
      const text = label.querySelector("span");
      if (text) text.textContent = computerLabelText(entry);
    });
  }

  function renderComputers() {
    const policy = state.policy;
    if (!policy) return;
    const computers = $("[data-agent-auto-update-computers]");
    if (computers) {
      [...computers.querySelectorAll("label, p")].forEach((node) => node.remove());
      const remote = (state.overview?.nodes || []).filter((entry) => entry.state !== "local");
      if (!state.overview) computers.append(el("p", "platform-note", "Checking computers…"));
      else if (!remote.length) computers.append(el("p", "platform-note", "No other computers are paired."));
      remote.forEach((entry) => {
        const label = el("label", "docker-check-option");
        const input = el("input");
        input.type = "checkbox";
        input.value = entry.nodeId;
        input.checked = policy.nodeIds.includes(entry.nodeId);
        label.title = entry.reason || "";
        label.append(input, el("span", "", computerLabelText(entry)));
        computers.append(label);
      });
    }
  }

  function renderForm() {
    const policy = state.policy;
    if (!policy) return;
    const status = $("[data-agent-auto-update-status]");
    if (status) status.textContent = describe(policy) + (dirty ? " (unsaved changes)" : "");
    if (dirty) return; // never overwrite what the owner is editing
    const enabled = $('[data-agent-auto-update-field="enabled"]');
    if (enabled) enabled.checked = policy.enabled;
    const mode = $('[data-agent-auto-update-field="mode"]');
    if (mode) mode.value = policy.mode;
    const start = $('[data-agent-auto-update-field="start"]');
    if (start) start.value = policy.start;
    const duration = $('[data-agent-auto-update-field="durationMinutes"]');
    if (duration) {
      if (![...duration.options].some((option) => Number(option.value) === policy.durationMinutes)) {
        const option = el("option", "", `${Math.round(policy.durationMinutes / 6) / 10} hours`);
        option.value = String(policy.durationMinutes);
        duration.append(option);
      }
      duration.value = String(policy.durationMinutes);
    }
    const daysBox = $("[data-agent-auto-update-days]");
    if (daysBox) {
      [...daysBox.querySelectorAll("label")].forEach((label) => label.remove());
      DAYS.forEach((name, index) => {
        const label = el("label", "docker-check-option");
        const input = el("input");
        input.type = "checkbox";
        input.value = String(index);
        input.checked = policy.days.includes(index);
        label.append(input, el("span", "", name));
        daysBox.append(label);
      });
    }
    renderComputers();
  }

  // "213 → 214", plus what the Agent reported afterwards when it differs or
  // is missing. Builds only: the Agent's package version is a placeholder.
  function buildCell(entry) {
    const planned = `${entry.fromBuild || "?"} → ${entry.toBuild || "?"}`;
    if (entry.status !== "succeeded") return planned;
    if (!entry.verifiedBuild) return planned;
    return entry.verifiedBuild === entry.toBuild ? `${planned} (verified)` : `${planned} (reports ${entry.verifiedBuild})`;
  }

  function renderHistory() {
    const host = root.document.querySelector("[data-agent-update-history]");
    if (!host) return;
    host.replaceChildren();
    // Only from a current overview: never a pending line from before an update.
    const pending = (state.overview?.nodes || []).filter((entry) => entry.state === "update-available");
    if (pending.length) {
      host.append(el("p", "platform-note", `Pending: ${pending.map((entry) => `${entry.name} ${entry.installedBuild} → ${entry.targetBuild}${entry.canUpdate ? "" : ` (${entry.reason})`}`).join(" · ")}`));
    }
    if (!state.history.length) {
      host.append(el("p", "platform-note", "No Agent updates yet."));
      return;
    }
    const table = el("table", "docker-table");
    const head = el("thead");
    const headRow = el("tr");
    ["When", "Computer", "Build", "How", "Result", "Rollback"].forEach((label) => {
      const th = el("th", "", label);
      th.scope = "col";
      headRow.append(th);
    });
    head.append(headRow);
    const body = el("tbody");
    state.history.slice(0, 20).forEach((entry) => {
      const row = el("tr");
      row.dataset.agentUpdateHistoryRow = entry.id || "";
      const when = Date.parse(entry.at || "");
      const result = el("td", "", STATUS_LABELS[entry.status] || entry.status || "");
      if (entry.message) result.title = entry.message;
      if (entry.manualCommand) result.title = `${entry.message || ""} Run on the computer: ${entry.manualCommand}`.trim();
      if (Array.isArray(entry.deferredRestarts) && entry.deferredRestarts.length) {
        result.title = `${result.title ? `${result.title} ` : ""}Not restarted by the update: ${entry.deferredRestarts.join(", ")}.`;
      }
      row.append(
        el("td", "", Number.isFinite(when) ? new Date(when).toLocaleString() : ""),
        el("td", "", entry.name || entry.nodeId || ""),
        el("td", "", buildCell(entry)),
        el("td", "", TRIGGER_LABELS[entry.trigger] || entry.trigger || ""),
        result,
        el("td", "", ROLLBACK_LABELS[entry.rollback] || (entry.status === "succeeded" ? "Previous package kept" : "")),
      );
      body.append(row);
    });
    table.append(head, body);
    const wrap = el("div", "docker-table-wrap");
    wrap.append(table);
    host.append(wrap);
  }

  // The form shows the saved settings only. Until they have loaded, every
  // control is disabled, so nothing placeholder-shaped can be saved.
  function setControlsReady(ready) {
    const container = root.document.querySelector("[data-agent-auto-update]");
    if (!container) return;
    container.querySelectorAll("input, select, button").forEach((control) => { control.disabled = !ready; });
    container.setAttribute("aria-busy", ready ? "false" : "true");
  }

  // options.overview: an overview request already running (Agent Control's
  // Updates summary passes its own, so every Agent is checked once).
  async function load(options = {}) {
    const api = nodesApi();
    if (!api?.getAgentAutoUpdate || busy) return;
    const sequence = ++loadSequence;
    // The settings are a local file and answer at once; the computer list
    // checks every Agent and can take seconds. Show each when it arrives.
    const overviewRequest = Promise.resolve(options.overview || (api.agentUpdateOverview ? api.agentUpdateOverview() : null)).catch(() => null);
    try {
      const settings = await api.getAgentAutoUpdate();
      if (sequence !== loadSequence) return;
      // Saved settings replace the form only when it has no unsaved edits
      // (renderForm checks); history always comes from the file.
      state = { ...state, policy: dirty ? state.policy || settings.policy : settings.policy, history: settings.history || [] };
      setControlsReady(true);
      renderForm();
      renderHistory();
    } catch (error) {
      const status = $("[data-agent-auto-update-status]");
      if (status) status.textContent = error?.message || "Automatic update settings are unavailable.";
      return;
    }
    const overview = await overviewRequest;
    if (sequence !== loadSequence) return;
    if (overview) {
      state = { ...state, overview };
      // While the owner is editing, only replace the placeholder, never
      // boxes they may have ticked; their notes are still brought up to date.
      const drawn = root.document.querySelectorAll("[data-agent-auto-update-computers] input").length > 0;
      if (!dirty || !drawn) renderComputers();
      else refreshComputerNotes();
      // The pending line belongs to this overview, not the one before it.
      renderHistory();
    } else if (!state.overview) {
      const computers = $("[data-agent-auto-update-computers]");
      computers?.querySelectorAll("p").forEach((node) => { node.textContent = "Computers could not be checked. Refresh to try again."; });
    }
  }

  async function save(policy, message) {
    const api = nodesApi();
    if (!api?.setAgentAutoUpdate || busy) return;
    busy = true;
    try {
      const saved = await api.setAgentAutoUpdate(policy);
      state.policy = saved.policy;
      state.history = saved.history || state.history;
      dirty = false;
      renderForm();
      renderHistory();
      toast(message || "Automatic Agent update settings saved.", "success");
    } catch (error) {
      toast(error?.message || "Settings could not be saved.", "warning");
    } finally {
      busy = false;
    }
  }

  function mount() {
    const container = root.document.querySelector("[data-agent-auto-update]");
    if (!container) return;
    if (!state.policy) setControlsReady(false);
    container.addEventListener("change", (event) => {
      if (event.target.closest("[data-agent-auto-update-field], [data-agent-auto-update-days], [data-agent-auto-update-computers]")) {
        dirty = true;
        const status = $("[data-agent-auto-update-status]");
        if (status && state.policy) status.textContent = `${describe(state.policy)} (unsaved changes)`;
      }
    });
    container.addEventListener("click", (event) => {
      const action = event.target.closest("[data-agent-auto-update-action]")?.dataset.agentAutoUpdateAction;
      if (action === "save") save(readForm());
      if (action === "off") {
        dirty = false;
        save({ ...(state.policy || {}), enabled: false }, "Automatic Agent updates are off.");
      }
    });
  }

  root.AnxAgentAutoUpdate = { load, _test: { describe, readForm, computerNote, buildCell, getState: () => state } };
  if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", mount);
  else mount();
})(window);
