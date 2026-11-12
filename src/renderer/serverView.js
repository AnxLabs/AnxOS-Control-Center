// Phase 5 server view. Opening a server shows only that server: one header
// (status, computer, address, live CPU/RAM/players, Start/Stop/Restart/Share
// and a More menu) and six tabs. The rules live in
// src/shared/serverViewModel.js; this file draws them using the app's own
// state (instances, metrics store, operations, notifications). Loaded after
// app.js, whose top-level functions are globals.
(function () {
  "use strict";

  const Model = window.AnxServerViewModel;
  const page = document.querySelector('.page[data-page="instances"]');
  const overview = document.querySelector("[data-server-overview]");
  const RESTART_STORAGE_KEY = "anxos.server.restartRequired.v1";
  if (!Model || !page) return;

  let restartNotes = readRestartNotes();
  let lastRenderedKey = "";

  function readRestartNotes() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(RESTART_STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeRestartNotes() {
    try { window.localStorage.setItem(RESTART_STORAGE_KEY, JSON.stringify(restartNotes)); } catch {}
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // ---- open / close -------------------------------------------------------

  function isOpen() {
    return page.dataset.serverView === "open";
  }

  function open(instanceId, tab) {
    if (instanceId && typeof selectInstance === "function" && selectedInstanceId !== instanceId) selectInstance(instanceId);
    if (!selectedInstanceId) return;
    page.dataset.serverView = "open";
    if (tab && typeof setActiveInstanceTab === "function") setActiveInstanceTab(tab);
    else syncTabs(typeof activeInstanceTab === "string" ? activeInstanceTab : "overview");
    render(findInstance(selectedInstanceId));
    page.scrollTop = 0;
    page.querySelector(".server-view-back")?.focus({ preventScroll: true });
  }

  async function close() {
    if (!isOpen()) return true;
    if (!(await confirmLeaveSettings("go back to all servers"))) return false;
    page.dataset.serverView = "list";
    document.querySelector("[data-server-more-menu]")?.removeAttribute("open");
    if (typeof stopInstanceConsolePolling === "function") stopInstanceConsolePolling();
    return true;
  }

  // Unsaved settings: leaving the Settings tab or the server asks first.
  async function confirmLeaveSettings(actionLabel) {
    if (typeof activeInstanceTab !== "string" || activeInstanceTab !== "settings") return true;
    if (typeof hasUnsavedInstanceSettings !== "function" || !hasUnsavedInstanceSettings()) return true;
    if (typeof createSecurityConfirmation !== "function") return window.confirm(`Discard unsaved settings and ${actionLabel}?`);
    return createSecurityConfirmation({
      title: "Discard unsaved settings?",
      message: `You have settings that are not saved yet. Discard them and ${actionLabel}?`,
      confirmLabel: "Discard changes",
    });
  }

  // ---- tabs -----------------------------------------------------------------

  function syncTabs(tab) {
    const main = Model.mainTabFor(tab);
    document.querySelectorAll("[data-instance-tab]").forEach((button) => {
      const name = button.dataset.instanceTab;
      const isDetail = button.classList.contains("instance-tab--detail");
      if (isDetail) {
        // A detail view shows its own tab only while it is open.
        button.hidden = name !== tab;
        button.classList.toggle("is-active", name === tab);
        return;
      }
      const active = name === main && !Model.TAB_PARENT[tab];
      button.classList.toggle("is-active", name === main);
      button.classList.toggle("is-parent", name === main && Boolean(Model.TAB_PARENT[tab]));
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  // ---- restart required -------------------------------------------------------

  function markRestartRequired(instanceId, reason) {
    const instance = findInstance(instanceId);
    if (!instance || !isInstanceRunning(instance)) return;
    restartNotes = Model.markRestartRequired(restartNotes, instanceId, reason);
    writeRestartNotes();
    render(instance);
  }

  function renderRestartBanner(instance) {
    const banner = document.querySelector("[data-server-restart-banner]");
    if (!banner) return;
    const settled = instance ? Model.settleRestartRequired(restartNotes, instance) : restartNotes;
    if (settled !== restartNotes) {
      restartNotes = settled;
      writeRestartNotes();
    }
    const note = instance ? Model.restartRequiredFor(restartNotes, instance) : null;
    banner.hidden = !note;
    if (note) {
      const message = banner.querySelector("[data-server-restart-message]");
      if (message) message.textContent = `Restart the server to apply: ${note.reasons.join(", ")}.`;
    }
  }

  // ---- header -------------------------------------------------------------------

  function metricsEntry(instance) {
    try { return instanceMetricsStore.get(instance.id); } catch { return null; }
  }

  function liveReadings(instance) {
    const running = isInstanceRunning(instance);
    const entry = running ? metricsEntry(instance) : null;
    const sample = entry?.sample || null;
    const freshness = sample ? Model.readingFreshness(entry.receivedAt) : "none";
    const cpu = Number.isFinite(sample?.cpuPercent) ? `${sample.cpuPercent.toFixed(0)}%` : null;
    const ram = Number.isFinite(sample?.memoryRssBytes) ? formatBytes(sample.memoryRssBytes) : null;
    const limit = parseInstanceMemoryLimitBytes(instance);
    return { running, freshness, cpu, ram, ramLimit: Number.isFinite(limit) ? formatBytes(limit) : null, uptimeSeconds: sample?.uptimeSeconds, status: entry?.status || "idle" };
  }

  function computerInfo(instance) {
    const node = typeof getSelectedNode === "function" ? getSelectedNode() : null;
    const name = (typeof getInstanceNodeLabel === "function" ? getInstanceNodeLabel(instance) : "") || node?.displayName || node?.name || "This computer";
    let connected = true;
    if (node && node.kind === "agent" && typeof getNodeVisualState === "function") connected = getNodeVisualState(node) !== "offline";
    // A fresh server list from this computer proves it answers, whatever the
    // connection badge last said.
    if (!connected && typeof latestInstancesSnapshotAt === "number" && latestInstancesSnapshotNodeId === getSelectedNodeId() && Date.now() - latestInstancesSnapshotAt < 60000) connected = true;
    return { name, connected };
  }

  function playersInfo(instance) {
    if (typeof isMinecraftInstance !== "function" || !isMinecraftInstance(instance)) return null;
    const minecraft = instance.minecraft || {};
    const players = minecraft.players || instance.players || instance.status?.players || {};
    const online = [players.online, minecraft.onlinePlayers, instance.onlinePlayers].find((value) => Number.isFinite(Number(value)) && value !== null && value !== "");
    const maxSource = [players.max, minecraft.maxPlayers, instance.maxPlayers, typeof latestMinecraftProperties === "object" ? latestMinecraftProperties["max-players"] : null]
      .find((value) => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)));
    return { online: online === undefined ? null : Number(online), max: maxSource === undefined ? null : Number(maxSource) };
  }

  function setChip(selector, text, title) {
    const chip = document.querySelector(selector);
    if (!chip) return;
    chip.hidden = !text;
    chip.textContent = text || "";
    chip.title = title || "";
  }

  // "Minecraft · Paper" reads better than the process type ("custom command").
  function gameLabel(instance) {
    const profile = typeof getInstanceWorkspaceProfile === "function" ? getInstanceWorkspaceProfile(instance) : null;
    const software = String(instance.serverSoftware || "").trim();
    if (profile && profile.id === "minecraft") return software ? `Minecraft · ${software.charAt(0).toUpperCase()}${software.slice(1)}` : "Minecraft";
    if (profile && profile.id !== "generic" && profile.label) return profile.label;
    return software || getInstanceTypeLabel(instance);
  }

  function renderHeader(instance, readings, computer, players) {
    const typeChip = document.querySelector("[data-server-header=\"game\"]");
    if (typeChip && instance) typeChip.textContent = gameLabel(instance);
    setChip('[data-server-header="computer"]', instance ? `On ${computer.name}` : "", computer.connected ? "" : "AnxOS can't reach this computer right now.");
    const stale = readings.freshness === "stale" ? " (last reading)" : "";
    setChip('[data-server-header="cpu"]', readings.running && readings.cpu ? `CPU ${readings.cpu}${stale}` : "");
    setChip('[data-server-header="ram"]', readings.running && readings.ram ? `RAM ${readings.ram}${readings.ramLimit ? ` of ${readings.ramLimit}` : ""}${stale}` : "");
    setChip('[data-server-header="players"]', players && players.online !== null && readings.running ? `${players.online}${players.max ? ` / ${players.max}` : ""} players` : "");
    const copy = document.querySelector("[data-server-copy-address]");
    if (copy) copy.disabled = !instance || !getInstancePrimaryPort(instance);
    const icon = document.querySelector("[data-instance-inspector-icon]");
    if (icon && instance) icon.dataset.gameKind = typeof getInstanceAccessGameKind === "function" ? getInstanceAccessGameKind(instance) || "" : "";
  }

  // ---- overview -------------------------------------------------------------------

  function card(title, extraClass) {
    const node = el("section", `server-card${extraClass ? ` ${extraClass}` : ""}`);
    node.append(el("h4", "server-card__title", title));
    return node;
  }

  function linkButton(label, attrs) {
    const button = el("button", "server-card__link", label);
    button.type = "button";
    Object.entries(attrs).forEach(([key, value]) => { button.dataset[key] = value; });
    return button;
  }

  function fact(label, value, extraClass) {
    const row = el("div", `server-fact${extraClass ? ` ${extraClass}` : ""}`);
    row.append(el("span", "server-fact__label", label), el("strong", "server-fact__value", value));
    return row;
  }

  function formatWhen(at) {
    const time = typeof at === "number" ? at : Date.parse(at || "");
    if (!Number.isFinite(time)) return "";
    const formatAge = window.AnxHomeDashboardModel?.formatAge;
    return formatAge ? formatAge(Date.now() - time) : new Date(time).toLocaleTimeString();
  }

  function recentEvents(instance) {
    const events = [];
    const operation = getInstanceOperation(instance.id);
    if (operation?.status === "running") events.push({ tone: "busy", text: getInstanceOperationLabel(operation.type), at: operation.startedAt || operation.updatedAt });
    const failure = typeof getInstanceOperationFailureText === "function" ? getInstanceOperationFailureText(operation) : null;
    if (failure) events.push({ tone: "critical", text: failure, at: operation.updatedAt || operation.finishedAt });
    const items = (typeof notificationState === "object" && Array.isArray(notificationState.items)) ? notificationState.items : [];
    items.filter((item) => item.relatedInstanceId === instance.id).slice(0, 4).forEach((item) => {
      events.push({ tone: item.severity === "critical" || item.severity === "error" ? "critical" : item.severity === "warning" ? "warning" : "info", text: item.title === item.message ? item.title : `${item.title}: ${item.message}`, at: item.lastSeen });
    });
    return events.slice(0, 5);
  }

  function buildOverview(instance, readings, computer, players) {
    const fragment = document.createDocumentFragment();
    const operation = getInstanceOperation(instance.id);
    const failureText = (typeof getInstanceOperationFailureText === "function" ? getInstanceOperationFailureText(operation) : null)
      || (typeof getInstanceFailureReason === "function" ? getInstanceFailureReason(instance) : "");
    const status = Model.describeServerStatus({ state: instance.state, operation, failureText: failureText && failureText !== "Unavailable" ? failureText : "", computerConnected: computer.connected });

    const statusCard = card("Status", `server-card--status is-${status.tone}`);
    statusCard.append(el("strong", "server-status__label", status.label), el("p", "server-status__detail", status.detail));
    if (readings.running && Number.isFinite(readings.uptimeSeconds)) statusCard.append(fact("Up for", formatDuration(readings.uptimeSeconds)));
    if (status.key === "error") statusCard.append(linkButton("Open the console", { serverOpenTab: "console" }));
    fragment.append(statusCard);

    if (players) {
      const playersCard = card("Players");
      const text = !readings.running ? "Server is stopped"
        : players.online === null ? "Not reported yet"
          : `${players.online}${players.max ? ` of ${players.max}` : ""} online`;
      playersCard.append(el("strong", "server-card__big", text));
      if (players.max && !readings.running) playersCard.append(fact("Room for", `${players.max} players`));
      playersCard.append(linkButton("Players, whitelist and operators", { serverOpenTab: "players" }));
      fragment.append(playersCard);
    }

    const resources = card("Resources");
    if (!readings.running) {
      resources.append(el("p", "server-card__muted", "Usage is shown while the server runs."));
    } else if (readings.freshness === "none") {
      resources.append(el("p", "server-card__muted", readings.status === "unavailable" ? "This computer doesn't report usage for this server." : "Measuring…"));
    } else {
      const label = readings.freshness === "live" ? "Live" : "Last reading";
      resources.append(
        fact("CPU", readings.cpu || "Measuring…"),
        fact("Memory", readings.ram ? `${readings.ram}${readings.ramLimit ? ` of ${readings.ramLimit}` : ""}` : "Not reported"),
      );
      if (readings.cpu || readings.ram) resources.append(el("span", `server-freshness is-${readings.freshness}`, label));
    }
    resources.append(linkButton("Performance history", { serverOpenTab: "performance" }));
    fragment.append(resources);

    const connect = card("Connect");
    const address = formatInstanceAddressLabel(instance);
    const addressRow = el("div", "server-address");
    addressRow.append(el("code", "", address));
    if (getInstancePrimaryPort(instance)) {
      const copy = el("button", "server-card__link", "Copy");
      copy.type = "button";
      copy.dataset.serverCopyAddress = "";
      addressRow.append(copy);
    }
    connect.append(addressRow);
    try {
      const health = getShareServerAccessHealth(instance);
      const described = AnxShareHealth.describeShareHealth(health.status);
      connect.append(fact("Friends outside your network", described.headline));
    } catch {}
    connect.append(linkButton("Share with friends", { serverAction: "share-server" }));
    fragment.append(connect);

    const about = card("About");
    const version = getInstanceVersionMetadata(instance);
    about.append(
      fact("Game", gameLabel(instance)),
      fact("Version", version.main || "Unknown"),
      fact("Computer", `${computer.name}${computer.connected ? "" : " (not connected)"}`),
    );
    fragment.append(about);

    const events = recentEvents(instance);
    const activity = card("Recent events", "server-card--wide");
    if (!events.length) activity.append(el("p", "server-card__muted", "Nothing new. Long tasks such as installs and backups also appear in Activity."));
    else {
      const list = el("ul", "server-events");
      events.forEach((event) => {
        const item = el("li", `server-event is-${event.tone}`);
        item.append(el("span", "server-event__text", event.text));
        if (event.at) item.append(el("time", "server-event__time", formatWhen(event.at)));
        list.append(item);
      });
      activity.append(list);
    }
    fragment.append(activity);
    return fragment;
  }

  function renderOverview(instance, readings, computer, players) {
    if (!overview) return;
    if (!instance) {
      overview.replaceChildren();
      lastRenderedKey = "";
      return;
    }
    const draft = document.createElement("div");
    draft.append(buildOverview(instance, readings, computer, players));
    // Reconcile so a refresh only touches cards whose content changed: focus
    // and hover on an unchanged card survive live updates.
    if (typeof reconcileChildren === "function") reconcileChildren(overview, draft);
    else overview.replaceChildren(...draft.childNodes);
  }

  // ---- add-ons tab visibility -------------------------------------------------------

  function syncAddonTab(instance) {
    const support = Model.describeAddonSupport(instance || {}, { isMinecraft: Boolean(instance) && typeof isMinecraftInstance === "function" && isMinecraftInstance(instance) });
    document.querySelectorAll('[data-instance-tab="mods"]').forEach((tab) => {
      tab.hidden = !support.show;
      tab.textContent = "Add-ons";
    });
    if (!support.show && typeof activeInstanceTab === "string" && activeInstanceTab === "mods") window.queueMicrotask(() => setActiveInstanceTab("overview"));
    return support;
  }

  // Memory hint from the computer's own latest reading (no guess without one).
  function renderMemoryHint() {
    const hint = document.querySelector("[data-server-memory-hint]");
    if (!hint) return;
    const reading = window.AnxComputerVitals?.get(typeof getSelectedNodeId === "function" ? getSelectedNodeId() : null)?.reading;
    const total = reading?.memoryTotal;
    const used = reading?.memoryUsed;
    const suggestion = Number.isFinite(total) && Number.isFinite(used) ? Model.suggestMemory(total - used, total) : null;
    hint.textContent = suggestion
      ? `This computer has ${formatBytes(total - used)} free of ${formatBytes(total)}. A good starting point: ${suggestion}.`
      : "Use a size such as 4G. Most small Minecraft servers run well with 2G to 4G.";
  }

  // ---- render ---------------------------------------------------------------------

  function render(instance) {
    if (!instance) {
      renderOverview(null);
      renderRestartBanner(null);
      if (isOpen()) page.dataset.serverView = "list";
      return;
    }
    const readings = liveReadings(instance);
    const computer = computerInfo(instance);
    const players = playersInfo(instance);
    renderHeader(instance, readings, computer, players);
    renderRestartBanner(instance);
    syncAddonTab(instance);
    if (typeof activeInstanceTab === "string" && activeInstanceTab === "settings") renderMemoryHint();
    if (!isOpen() || (typeof activeInstanceTab === "string" && activeInstanceTab !== "overview")) return;
    renderOverview(instance, readings, computer, players);
  }

  // ---- events ---------------------------------------------------------------------

  page.addEventListener("click", async (event) => {
    const back = event.target.closest("[data-server-view-back]");
    if (back) { await close(); return; }
    const copy = event.target.closest("[data-server-copy-address]");
    if (copy) {
      const instance = findInstance();
      if (instance) copyInstanceAddress(instance, copy);
      return;
    }
    const tabLink = event.target.closest("[data-server-open-tab]");
    if (tabLink) { setActiveInstanceTab(tabLink.dataset.serverOpenTab); return; }
    const action = event.target.closest("[data-server-action]");
    if (action) { document.querySelector(`.instance-quick-actions [data-instance-action="${action.dataset.serverAction}"]`)?.click(); return; }
    if (event.target.closest("[data-server-restart-now]")) {
      document.querySelector('.instance-quick-actions [data-instance-action="restart"]')?.click();
      return;
    }
    // Picking an action from the More menu closes the menu.
    const menu = event.target.closest("[data-server-more-menu]");
    if (menu && event.target.closest("button, a")) menu.removeAttribute("open");
  });

  document.addEventListener("click", (event) => {
    const menu = document.querySelector("[data-server-more-menu][open]");
    if (menu && !menu.contains(event.target)) menu.removeAttribute("open");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = document.querySelector("[data-server-more-menu][open]");
    if (menu) { menu.removeAttribute("open"); menu.querySelector("summary")?.focus(); }
  });

  // Live readings age even without a new poll ("Live" turns into "Last
  // reading"); a light tick re-renders only while a server page is visible.
  window.setInterval(() => {
    if (!isOpen() || document.hidden || typeof getActivePageName !== "function" || getActivePageName() !== "instances") return;
    const instance = findInstance();
    if (instance) render(instance);
  }, 5000);

  page.dataset.serverView = page.dataset.serverView || "list";

  window.AnxServerView = { open, close, isOpen, render, syncTabs, markRestartRequired, confirmLeaveSettings, syncAddonTab };
})();
