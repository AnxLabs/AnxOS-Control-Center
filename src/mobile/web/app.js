// AnxHost phone app (Phase 7). No framework: a hash router, small views, and
// fetch calls to the gateway's API on the computer. Data is never stored on
// the phone; when the computer can't be reached the app says so, and old
// numbers are shown as old (with their age) or not at all.
(function () {
  "use strict";

  const Home = window.AnxHomeDashboardModel;
  const ServerView = window.AnxServerViewModel;
  const $ = (selector) => document.querySelector(selector);
  const view = $("[data-view]");
  const titleEl = $("[data-title]");
  const statusEl = $("[data-status]");
  const bannerEl = $("[data-banner]");
  const tabbar = $("[data-tabbar]");
  const backButton = $("[data-back]");
  const sheet = $("[data-sheet]");
  const backdrop = $("[data-sheet-backdrop]");
  const toastEl = $("[data-toast]");

  // 216-C: the phone follows its own colour scheme. The theme is applied as
  // <html data-theme>, the same switch the desktop uses for tokens.css, so
  // light and dark are defined once there.
  const darkScheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const applyTheme = () => {
    const theme = darkScheme && !darkScheme.matches ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--ahx-bg-app").trim() || meta.content;
  };
  applyTheme();
  darkScheme?.addEventListener?.("change", applyTheme);

  // Data older than this is shown as stale; older than UNAVAILABLE_MS it is
  // not shown at all.
  const STALE_MS = 30 * 1000;
  const UNAVAILABLE_MS = 5 * 60 * 1000;
  const POLL = { home: 10000, servers: 10000, computers: 10000, computer: 5000, server: 5000, console: 3000, sharing: 15000, other: 0 };

  const state = {
    session: null,
    csrf: "",
    route: { name: "home", params: [] },
    data: null,
    lastOk: 0,
    lastError: null,
    locked: false,
    pollTimer: null,
    failures: 0,
    renderToken: 0,
    seenAttention: new Set(),
    consoleFollow: true,
  };

  // ---- Helpers -------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, onClick, options = {}) {
    const node = el("button", `button${options.kind ? ` is-${options.kind}` : ""}${options.small ? " is-small" : ""}${options.wide ? " is-wide" : ""}`, label);
    node.type = "button";
    if (options.disabled) node.disabled = true;
    if (options.title) {
      // Icon-only buttons ("⋯") need a spoken name, not just a tooltip.
      node.title = options.title;
      node.setAttribute("aria-label", options.title);
    }
    node.addEventListener("click", onClick);
    return node;
  }

  function link(href, className, children) {
    const node = el("a", className);
    node.href = href;
    children.forEach((child) => node.append(child));
    return node;
  }

  function enc(value) {
    return encodeURIComponent(value);
  }

  function bytes(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = Number(value);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
  }

  function ageText(ms) {
    return Home && Home.formatAge ? Home.formatAge(ms) : `${Math.round(ms / 1000)} s ago`;
  }

  function when(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
  }

  function toast(message, tone) {
    toastEl.textContent = message;
    toastEl.className = `toast${tone === "warning" ? " is-warning" : ""}`;
    toastEl.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { toastEl.hidden = true; }, 4500);
  }

  function deviceLabel() {
    const agent = navigator.userAgent || "";
    if (/iPhone/.test(agent)) return "iPhone";
    if (/iPad/.test(agent)) return "iPad";
    if (/Android/.test(agent)) return "Android phone";
    return "Phone";
  }

  // ---- API -----------------------------------------------------------------------

  class ApiError extends Error {
    constructor(status, code, message, fields) {
      super(message);
      this.status = status;
      this.code = code;
      this.fields = fields;
    }
  }

  async function api(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetch(`/api${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-AnxOS-CSRF": state.csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "OFFLINE", "Can't reach AnxHost on your computer. Check that the phone is on the same network and that AnxHost is running.");
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || (payload && payload.ok === false)) {
      const error = payload?.error || {};
      throw new ApiError(response.status, error.code || "REQUEST_FAILED", error.message || `Request failed (${response.status}).`, error.fields);
    }
    return payload;
  }

  function handleApiError(error, { quiet = false } = {}) {
    if (error.status === 401 && error.code === "NOT_PAIRED") {
      state.session = null;
      renderUnpaired();
      return true;
    }
    if (error.status === 423) {
      state.locked = true;
      updateBanner();
      if (!quiet) toast(error.message, "warning");
      return true;
    }
    if (!quiet) toast(error.message, "warning");
    return false;
  }

  // ---- Confirmation sheet ----------------------------------------------------------

  function openSheet(build) {
    sheet.replaceChildren();
    build(sheet);
    sheet.hidden = false;
    backdrop.hidden = false;
    const focusable = sheet.querySelector("input, button");
    if (focusable) focusable.focus();
  }

  function closeSheet() {
    sheet.hidden = true;
    backdrop.hidden = true;
    sheet.replaceChildren();
  }

  backdrop.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !sheet.hidden) closeSheet(); });

  // Resolves true only when the person confirms; Cancel always resolves false.
  function confirmSheet({ title, message, lines = [], warnings = [], confirmLabel = "Continue", danger = false, phrase = "" }) {
    return new Promise((resolve) => {
      openSheet((container) => {
        const heading = el("h2", "", title);
        heading.id = "sheet-title";
        container.append(heading);
        if (message) container.append(el("p", "", message));
        if (lines.length) {
          const list = el("ul");
          lines.forEach((line) => list.append(el("li", "", line)));
          container.append(list);
        }
        warnings.forEach((warning) => container.append(el("p", "notice", warning)));
        let input = null;
        if (phrase) {
          const field = el("label", "field");
          field.append(el("span", "", `Type ${phrase} to confirm`));
          input = el("input", "input");
          input.autocomplete = "off";
          input.autocapitalize = "characters";
          field.append(input);
          container.append(field);
        }
        const actions = el("div", "actions");
        const ok = button(confirmLabel, () => { closeSheet(); resolve(true); }, { kind: danger ? "danger" : "primary", wide: true, disabled: Boolean(phrase) });
        if (input) input.addEventListener("input", () => { ok.disabled = input.value.trim() !== phrase; });
        actions.append(button("Cancel", () => { closeSheet(); resolve(false); }, { kind: "quiet", wide: true }), ok);
        container.append(actions);
      });
      const cancelOnBackdrop = () => { backdrop.removeEventListener("click", cancelOnBackdrop); resolve(false); };
      backdrop.addEventListener("click", cancelOnBackdrop);
    });
  }

  // ---- Pairing -----------------------------------------------------------------------

  // The pairing code arrives in the URL fragment (never sent over the network
  // in the URL). It's removed from the address bar at once.
  let pendingCode = null;
  const pairMatch = /^#pair=([A-Za-z0-9_-]{16,64})$/.exec(location.hash);
  if (pairMatch) {
    pendingCode = pairMatch[1];
    history.replaceState(null, "", `${location.pathname}#/home`);
  }

  function renderPairing() {
    tabbar.hidden = true;
    backButton.hidden = true;
    titleEl.textContent = "Pair this phone";
    statusEl.textContent = "";
    const box = el("div", "pairing");
    const logo = el("img", "pairing__logo");
    logo.src = "/icons/192.png";
    logo.alt = "";
    box.append(logo, el("p", "muted", "This connects the phone to AnxHost on your computer. It gets the access chosen on the computer, and the computer can remove it at any time."));
    const field = el("label", "field");
    field.append(el("span", "", "Name this phone"));
    const input = el("input", "input");
    input.value = deviceLabel();
    input.maxLength = 60;
    field.append(input);
    const error = el("p", "field-error");
    error.hidden = true;
    const pair = button("Pair", async () => {
      pair.disabled = true;
      try {
        await api("/pair", { method: "POST", body: { code: pendingCode, deviceName: input.value } });
        pendingCode = null;
        await start();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        pair.disabled = false;
      }
    }, { kind: "primary" });
    box.append(field, pair, error);
    view.replaceChildren(box);
  }

  function renderUnpaired() {
    stopPolling();
    tabbar.hidden = true;
    backButton.hidden = true;
    titleEl.textContent = "AnxHost";
    statusEl.textContent = "";
    bannerEl.hidden = true;
    const box = el("div", "pairing");
    const logo = el("img", "pairing__logo");
    logo.src = "/icons/192.png";
    logo.alt = "";
    box.append(
      logo,
      el("h2", "", "This phone isn't paired"),
      el("p", "muted", "On your computer, open AnxHost > Security > Phone Access, choose what this phone may do, and scan the code with the phone's camera."),
      el("p", "dim", "If this phone was paired before, its access ended or was removed on the computer."),
    );
    view.replaceChildren(box);
  }

  // ---- Routing ------------------------------------------------------------------------

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch { return ""; }
    });
    const name = parts[0] || "home";
    return { name, params: parts.slice(1) };
  }

  function topTab(route) {
    if (route.name === "server") return "servers";
    if (route.name === "computer") return "computers";
    return route.name;
  }

  function pollFor(route) {
    if (route.name === "server") return route.params[2] === "console" ? POLL.console : ["overview", undefined].includes(route.params[2]) ? POLL.server : POLL.other;
    return POLL[route.name] ?? POLL.other;
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePoll() {
    stopPolling();
    const base = pollFor(state.route);
    if (!base || document.hidden || !state.session) return;
    // Back off while the computer can't be reached, up to a minute.
    const delay = state.failures ? Math.min(60000, base * 2 ** Math.min(state.failures, 4)) : base;
    state.pollTimer = setTimeout(() => load({ background: true }), delay);
  }

  window.addEventListener("hashchange", () => {
    if (!state.session) return;
    const previous = state.route;
    state.route = parseRoute();
    const sameServer = previous.name === "server" && state.route.name === "server" && previous.params[0] === state.route.params[0] && previous.params[1] === state.route.params[1];
    if (!sameServer) state.data = null;
    state.consoleFollow = true;
    load({ background: false });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else if (state.session) load({ background: true });
  });
  window.addEventListener("online", () => { if (state.session) load({ background: true }); });

  backButton.addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.hash = state.route.name === "computer" ? "#/computers" : "#/servers";
  });

  // ---- Freshness ----------------------------------------------------------------------

  function freshness() {
    if (!state.lastOk) return "none";
    const age = Date.now() - state.lastOk;
    if (state.lastError && age > UNAVAILABLE_MS) return "unavailable";
    if (state.lastError || age > STALE_MS) return "stale";
    return "fresh";
  }

  function updateStatus() {
    const fresh = freshness();
    if (!state.lastOk) statusEl.textContent = state.lastError ? "Offline" : "";
    else if (fresh === "fresh") statusEl.textContent = "Live";
    else statusEl.textContent = `Updated ${ageText(Date.now() - state.lastOk)}`;
  }

  function updateBanner() {
    let message = "";
    let critical = false;
    if (state.locked) {
      message = "AnxHost is locked on the computer. Unlock it there; until then nothing can be read or changed from this phone.";
    } else if (state.lastError && state.lastError.code === "OFFLINE") {
      const fresh = freshness();
      message = fresh === "unavailable" || !state.lastOk
        ? "Can't reach AnxHost on your computer. Nothing is shown until it's back."
        : `Can't reach AnxHost on your computer. Showing what it last reported, ${ageText(Date.now() - state.lastOk)}.`;
      critical = fresh === "unavailable" || !state.lastOk;
    } else if (state.lastError && state.lastError.status >= 500) {
      message = state.lastError.message;
    }
    bannerEl.textContent = message;
    bannerEl.classList.toggle("is-critical", critical);
    bannerEl.hidden = !message;
  }

  setInterval(() => { if (state.session) { updateStatus(); updateBanner(); } }, 5000);

  // ---- Loading -------------------------------------------------------------------------

  async function fetchRoute(route) {
    const [a, b, tab] = route.params;
    switch (route.name) {
      case "home":
      case "servers":
      case "computers":
        return api("/home");
      case "computer":
        return api(`/computers/${enc(a)}`);
      case "server": {
        const base = `/servers/${enc(a)}/${enc(b)}`;
        const detail = await api(base);
        const extra = {};
        if (tab === "console") extra.logs = await api(`${base}/logs?limit=300`);
        if (tab === "settings") extra.settings = state.data?.settings && state.data.server?.server.id === b ? state.data.settings : await api(`${base}/settings`);
        if (tab === "backups") extra.backups = await api(`${base}/backups`);
        // The Add-ons tab is "mods" in ServerView.MAIN_TABS; checking "addons"
        // here never loaded the installed list (fixed in Build 216-F).
        if (tab === "mods" && detail.addons?.supported) extra.addons = await api(`${base}/addons`);
        if (tab === "files") extra.files = await api(`${base}/files?path=${enc(route.params[3] || ".")}`);
        return { server: detail, ...extra };
      }
      case "sharing":
        return api("/sharing");
      default:
        return {};
    }
  }

  async function load({ background }) {
    const token = ++state.renderToken;
    const route = state.route;
    if (!background) renderSkeleton();
    try {
      const data = await fetchRoute(route);
      if (token !== state.renderToken) return;
      state.data = data;
      state.lastOk = Date.now();
      state.lastError = null;
      state.locked = false;
      state.failures = 0;
      notifyAttention(data);
    } catch (error) {
      if (token !== state.renderToken) return;
      state.lastError = error;
      state.failures += 1;
      if (handleApiError(error, { quiet: true }) && !state.session) return;
      if (error.status === 404 || error.status === 403) {
        state.data = null;
        renderMessage(error.message);
        updateStatus();
        updateBanner();
        schedulePoll();
        return;
      }
    }
    updateStatus();
    updateBanner();
    render();
    schedulePoll();
  }

  // In-app alerts: a new "needs attention" item shows once while the app is
  // open. AnxHost doesn't send push notifications.
  function notifyAttention(data) {
    if (!data || !Array.isArray(data.attention)) return;
    const fresh = data.attention.filter((item) => item.severity === "critical" && !state.seenAttention.has(item.id));
    const firstLoad = state.seenAttention.size === 0 && !notifyAttention.primed;
    data.attention.forEach((item) => state.seenAttention.add(item.id));
    notifyAttention.primed = true;
    if (!firstLoad && fresh.length) toast(fresh[0].title, "warning");
  }

  // ---- Rendering -------------------------------------------------------------------------

  function setChrome(title, { back = false } = {}) {
    titleEl.textContent = title;
    backButton.hidden = !back;
    tabbar.hidden = false;
    tabbar.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("is-active", item.dataset.tab === topTab(state.route)));
  }

  function renderSkeleton() {
    const draft = el("div", "list");
    for (let index = 0; index < 4; index += 1) draft.append(el("div", "skeleton"));
    view.replaceChildren(draft);
  }

  function renderMessage(message) {
    view.replaceChildren(el("p", "empty", message));
  }

  function hasData() {
    return state.data && freshness() !== "unavailable";
  }

  function render() {
    const route = state.route;
    const views = { home: renderHome, servers: renderServers, computers: renderComputers, computer: renderComputer, server: renderServer, sharing: renderSharing, more: renderMore };
    const fn = views[route.name] || renderHome;
    if (route.name !== "more" && !hasData()) {
      setChrome({ home: "Home", servers: "Servers", computers: "Computers", sharing: "Sharing" }[route.name] || "AnxHost", { back: route.name === "server" || route.name === "computer" });
      view.replaceChildren(el("p", "empty", state.locked ? "AnxHost is locked on the computer." : "Nothing to show until AnxHost on your computer can be reached."));
      return;
    }
    const scroll = view.querySelector(".console");
    const consoleAtBottom = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40 : true;
    const active = document.activeElement;
    const keepFocus = active && view.contains(active) && active.matches("input, textarea, select") ? active.dataset.keep : null;
    if (keepFocus && route.name === "server") {
      // Don't redraw under someone typing; the next poll catches up.
      return;
    }
    fn();
    const nextConsole = view.querySelector(".console");
    if (nextConsole && (consoleAtBottom || state.consoleFollow)) {
      nextConsole.scrollTop = nextConsole.scrollHeight;
      state.consoleFollow = false;
    }
  }

  function staleClass() {
    return freshness() === "fresh" ? "" : " is-stale";
  }

  function tileGrid(overview) {
    const tiles = el("div", "tiles");
    [["servers", "Servers running"], ["computers", "Computers online"], ["players", "Players online"], ["attention", "Needs attention"]].forEach(([key, label]) => {
      const entry = overview[key] || { value: "—", detail: "" };
      const tile = el("div", `tile${staleClass()}`);
      tile.append(el("span", "", label), el("strong", "", entry.value), el("small", "", entry.detail));
      tiles.append(tile);
    });
    return tiles;
  }

  function attentionList(items) {
    const list = el("div", "list");
    items.forEach((item) => {
      const box = el("div", `attention${item.severity === "critical" ? " is-critical" : ""}`);
      box.append(el("strong", "", item.title), el("p", "", item.detail || ""));
      const target = item.action?.kind === "server" ? `#/server/${item.action.target.split("/").map(enc).join("/")}/overview`
        : item.action?.kind === "computer" ? `#/computer/${enc(item.action.target)}` : null;
      if (target) {
        const go = el("a", "dim", item.action.label || "Open");
        go.href = target;
        box.append(go);
      }
      list.append(box);
    });
    return list;
  }

  function serverRow(server) {
    const tone = server.status?.tone || "muted";
    const meta = [server.status?.label, server.players !== null && server.running ? `${server.players} online` : "", server.computer].filter(Boolean).join(" · ");
    return link(`#/server/${enc(server.nodeId)}/${enc(server.id)}/overview`, `row tone-${tone}`, [
      el("span", "dot"),
      (() => { const main = el("span", "row__main"); main.append(el("strong", "", server.name), el("span", "", meta)); return main; })(),
      el("span", "row__chevron", "›"),
    ]);
  }

  function meter(label, value, detail) {
    const row = el("div", "meter");
    row.dataset.level = value === null || value === undefined ? "none" : value >= 90 ? "high" : value >= 75 ? "medium" : "low";
    const head = el("div", "meter__head");
    head.append(el("span", "", label), el("strong", "", value === null || value === undefined ? "—" : `${Math.round(value)}%`));
    const bar = el("div", "meter__bar");
    const fill = el("span");
    fill.style.width = value === null || value === undefined ? "0%" : `${Math.max(0, Math.min(100, value))}%`;
    bar.append(fill);
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    if (value !== null && value !== undefined) bar.setAttribute("aria-valuenow", String(Math.round(value)));
    row.append(head, bar);
    if (detail) row.append(el("small", "dim", detail));
    return row;
  }

  // A card's own freshness comes from the computer; if the phone itself lost
  // the connection, the card can't claim "Live".
  function computerCard(card, { linkTo = true } = {}) {
    const box = linkTo ? link(`#/computer/${enc(card.id)}`, "card", []) : el("div", "card");
    const head = el("div", "row__main");
    const phoneFresh = freshness() === "fresh";
    const freshLabel = phoneFresh ? card.freshnessLabel : `As of ${ageText(Date.now() - state.lastOk)}`;
    const tone = card.connection === "online" ? "ok" : card.connection === "warning" ? "warning" : card.connection === "installing" ? "busy" : "critical";
    const title = el("div", "actions");
    title.append(el("strong", "", card.name), el("span", `pill tone-${tone}`, card.connectionLabel), el("span", "pill", freshLabel));
    head.append(title);
    if (card.os) head.append(el("span", "dim", card.os));
    box.append(head);
    const showValues = card.freshness !== "unavailable";
    if (showValues) {
      box.append(
        meter("CPU", card.cpuPercent),
        meter("Memory", card.memoryPercent, card.memoryTotal ? `${bytes(card.memoryUsed)} of ${bytes(card.memoryTotal)}` : ""),
        meter("Disk", card.diskPercent, card.diskFree !== null ? `${bytes(card.diskFree)} free` : ""),
      );
    }
    if (card.serverCount !== null && card.serverCount !== undefined) box.append(el("span", "dim", `${card.runningServerCount} of ${card.serverCount} servers running`));
    return box;
  }

  function renderHome() {
    setChrome("Home");
    const data = state.data;
    const draft = document.createDocumentFragment();
    draft.append(tileGrid(data.overview || {}));
    const needs = (data.attention || []).filter((item) => item.severity !== "info");
    draft.append(el("h2", "section-title", "Needs attention"));
    draft.append(needs.length ? attentionList(needs) : el("p", "notice", "All good. Nothing needs you right now."));
    const running = (data.servers || []).filter((server) => server.running);
    draft.append(el("h2", "section-title", "Running servers"));
    if (running.length) {
      const list = el("div", "list");
      running.forEach((server) => list.append(serverRow(server)));
      draft.append(list);
    } else {
      draft.append(el("p", "notice", (data.servers || []).length ? "No servers are running." : "No servers yet. Create one in AnxHost on your computer."));
    }
    (data.unknownComputers || []).forEach((entry) => draft.append(el("p", "notice", `${entry.name}: servers unknown. ${entry.reason || ""}`)));
    view.replaceChildren(draft);
  }

  function renderServers() {
    setChrome("Servers");
    const servers = state.data.servers || [];
    const draft = document.createDocumentFragment();
    if (!servers.length) {
      draft.append(el("p", "empty", "No servers to show. Servers on computers that aren't connected are hidden."));
    } else {
      const byComputer = new Map();
      servers.forEach((server) => {
        if (!byComputer.has(server.computer)) byComputer.set(server.computer, []);
        byComputer.get(server.computer).push(server);
      });
      byComputer.forEach((list, name) => {
        if (byComputer.size > 1) draft.append(el("h2", "section-title", name));
        const box = el("div", "list");
        list.forEach((server) => box.append(serverRow(server)));
        draft.append(box);
      });
    }
    (state.data.unknownComputers || []).forEach((entry) => draft.append(el("p", "notice", `${entry.name}: servers unknown. ${entry.reason || ""}`)));
    view.replaceChildren(draft);
  }

  function renderComputers() {
    setChrome("Computers");
    const draft = document.createDocumentFragment();
    const cards = state.data.computers || [];
    if (!cards.length) draft.append(el("p", "empty", "No computers yet."));
    cards.forEach((card) => draft.append(computerCard(card)));
    view.replaceChildren(draft);
  }

  function renderComputer() {
    const data = state.data;
    if (!data.card) { load({ background: false }); return; }
    setChrome(data.card.name, { back: true });
    const draft = document.createDocumentFragment();
    draft.append(computerCard(data.card, { linkTo: false }));
    if (data.connectionDetail) draft.append(el("p", "notice", data.connectionDetail));
    if (data.details && data.card.freshness !== "unavailable") {
      const card = el("div", "card");
      const facts = el("dl", "facts");
      const add = (label, value) => { if (value) facts.append(el("dt", "", label), el("dd", "", value)); };
      add("System", data.details.os);
      add("Processor", data.details.cpuModel ? `${data.details.cpuModel}${data.details.cpuCores ? ` (${data.details.cpuCores} cores)` : ""}` : "");
      add("Disk size", data.details.diskTotal ? bytes(data.details.diskTotal) : "");
      add("Up for", data.details.uptimeSeconds ? `${Math.floor(data.details.uptimeSeconds / 86400)} d ${Math.floor((data.details.uptimeSeconds % 86400) / 3600)} h` : "");
      card.append(el("h2", "", "Details"), facts);
      draft.append(card);
    }
    const items = (data.attention || []).filter((item) => item.severity !== "info");
    if (items.length) draft.append(el("h2", "section-title", "Needs attention"), attentionList(items));
    view.replaceChildren(draft);
  }

  // ---- Server page -----------------------------------------------------------------------

  function caps() {
    return state.session?.capabilities || {};
  }

  function roleNote(what) {
    return el("p", "notice", `This phone is paired as ${state.session?.device?.role || "Viewer"}, so it can't ${what}. Pair it again with a higher role on the computer to change that.`);
  }

  async function act(label, work, success) {
    try {
      const result = await work();
      if (success) toast(typeof success === "function" ? success(result) : success);
      await load({ background: true });
      return result;
    } catch (error) {
      if (!handleApiError(error)) { /* toast shown */ }
      return null;
    }
  }

  function renderServer() {
    const [nodeId, instanceId, tabName] = state.route.params;
    const tab = ServerView.mainTabFor(tabName || "overview");
    const data = state.data;
    if (!data.server) { load({ background: false }); return; }
    const { server } = data.server;
    setChrome(server.name, { back: true });
    const base = `#/server/${enc(nodeId)}/${enc(instanceId)}`;
    const draft = document.createDocumentFragment();
    const tabs = el("nav", "server-tabs");
    tabs.setAttribute("aria-label", "Server sections");
    ServerView.MAIN_TABS.forEach((name) => {
      const item = el("a", name === tab ? "is-active" : "", ServerView.TAB_LABELS[name]);
      item.href = `${base}/${name}`;
      if (name === tab) item.setAttribute("aria-current", "page");
      tabs.append(item);
    });
    draft.append(tabs);
    const apiBase = `/servers/${enc(nodeId)}/${enc(instanceId)}`;
    const panels = { overview: serverOverview, console: serverConsole, files: serverFiles, mods: serverAddons, backups: serverBackups, settings: serverSettings };
    draft.append(panels[tab](data, apiBase, base));
    view.replaceChildren(draft);
  }

  function serverOverview(data, apiBase) {
    const { server, computer, metrics } = data.server;
    const box = document.createDocumentFragment();
    const status = el("div", `card tone-${server.status.tone}`);
    const head = el("div", "actions");
    head.append(el("span", `pill tone-${server.status.tone}`, server.status.label));
    if (freshness() !== "fresh") head.append(el("span", "pill", `As of ${ageText(Date.now() - state.lastOk)}`));
    status.append(head, el("p", "muted", server.status.detail));
    const actions = el("div", "actions");
    const lifecycle = caps().lifecycle;
    const busy = ["busy", "starting"].includes(server.status.key);
    const offline = computer.connection !== "online" && computer.connection !== "warning";
    if (!server.running) {
      actions.append(button("Start", () => act("Start", () => api(`${apiBase}/start`, { method: "POST", body: {} }), "Starting the server."), { kind: "primary", disabled: !lifecycle || busy || offline }));
    } else {
      actions.append(
        button("Restart", async () => {
          if (!(await confirmSheet({ title: `Restart ${server.name}?`, message: "Players are disconnected while it restarts.", confirmLabel: "Restart" }))) return;
          await act("Restart", () => api(`${apiBase}/restart`, { method: "POST", body: {} }), "Restarting the server.");
        }, { disabled: !lifecycle || busy || offline }),
        button("Stop", async () => {
          if (!(await confirmSheet({ title: `Stop ${server.name}?`, message: "Players are disconnected and the server shuts down.", confirmLabel: "Stop server", danger: true }))) return;
          await act("Stop", () => api(`${apiBase}/stop`, { method: "POST", body: {} }), "Stopping the server.");
        }, { kind: "danger", disabled: !lifecycle || busy || offline }),
      );
    }
    status.append(actions);
    if (!lifecycle) status.append(roleNote("start or stop servers"));
    box.append(status);

    const facts = el("dl", "facts");
    const add = (label, value) => { if (value !== null && value !== undefined && value !== "") facts.append(el("dt", "", label), el("dd", "wrap", value)); };
    add("Computer", computer.name);
    add("Game", server.game || server.type);
    add("Version", server.version);
    add("Port", server.port);
    add("Players", server.running && server.players !== null ? `${server.players}${server.maxPlayers ? ` of ${server.maxPlayers}` : ""}` : "");
    if (server.playerNames?.length) add("Online now", server.playerNames.join(", "));
    if (metrics && metrics.freshness !== "none") {
      const tag = metrics.freshness === "live" && freshness() === "fresh" ? "" : " (not live)";
      add("CPU", metrics.cpuPercent !== null ? `${Math.round(metrics.cpuPercent)}%${tag}` : "");
      add("Memory", metrics.memoryBytes !== null ? `${bytes(metrics.memoryBytes)}${tag}` : "");
    }
    add("Starts with computer", server.autoStart ? "Yes" : "No");
    const factsCard = el("div", "card");
    factsCard.append(el("h2", "", "Overview"), facts);
    box.append(factsCard);
    return box;
  }

  function serverConsole(data, apiBase) {
    const box = document.createDocumentFragment();
    const lines = data.logs?.lines || [];
    const pre = el("pre", "console");
    pre.setAttribute("aria-label", "Console output");
    pre.setAttribute("tabindex", "0");
    if (!lines.length) pre.append(el("span", "muted", "No console output yet."));
    lines.forEach((line) => pre.append(el("span", `is-${line.stream}`, `${line.message}\n`)));
    box.append(pre);
    if (freshness() !== "fresh") box.append(el("p", "notice", `Console as of ${ageText(Date.now() - state.lastOk)}.`));
    if (caps().console) {
      const form = el("form", "command");
      const input = el("input", "input");
      input.placeholder = "Type a server command";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.dataset.keep = "command";
      input.setAttribute("aria-label", "Server command");
      const send = el("button", "button is-primary", "Send");
      send.type = "submit";
      form.append(input, send);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const command = input.value.trim();
        if (!command) return;
        send.disabled = true;
        try {
          await api(`${apiBase}/command`, { method: "POST", body: { command } });
          input.value = "";
          state.consoleFollow = true;
          input.blur();
          await load({ background: true });
        } catch (error) {
          handleApiError(error);
        } finally {
          send.disabled = false;
        }
      });
      box.append(form);
    } else {
      box.append(roleNote("send console commands"));
    }
    return box;
  }

  function serverFiles(data, apiBase, base) {
    const box = document.createDocumentFragment();
    const files = data.files || { path: ".", entries: [] };
    const current = files.path && files.path !== "." ? files.path : "";
    const crumbs = el("nav", "breadcrumb");
    crumbs.setAttribute("aria-label", "Folder");
    const go = (pathValue) => { location.hash = `${base}/files${pathValue ? `/${enc(pathValue)}` : ""}`; };
    crumbs.append(button("Server folder", () => go(""), { kind: "quiet", small: true }));
    let acc = "";
    current.split("/").filter(Boolean).forEach((part) => {
      acc = acc ? `${acc}/${part}` : part;
      const target = acc;
      crumbs.append(el("span", "dim", "/"), button(part, () => go(target), { kind: "quiet", small: true }));
    });
    box.append(crumbs);
    const canWrite = caps().files;
    if (canWrite) {
      const actions = el("div", "actions");
      const picker = el("input");
      picker.type = "file";
      picker.hidden = true;
      picker.addEventListener("change", async () => {
        const file = picker.files && picker.files[0];
        picker.value = "";
        if (!file) return;
        if (file.size > 25 * 1024 * 1024) { toast("Files over 25 MB can only be uploaded on the computer.", "warning"); return; }
        const target = current ? `${current}/${file.name}` : file.name;
        if (files.entries.some((entry) => entry.path === target) && !(await confirmSheet({ title: `Replace ${file.name}?`, message: "A file with this name is already in this folder.", confirmLabel: "Replace", danger: true }))) return;
        // Read as bytes and send base64, so binary files (jars, images,
        // worlds) arrive unchanged.
        const buffer = await file.arrayBuffer();
        let binary = "";
        const view8 = new Uint8Array(buffer);
        for (let index = 0; index < view8.length; index += 0x8000) binary += String.fromCharCode.apply(null, view8.subarray(index, index + 0x8000));
        await act("Upload", () => api(`${apiBase}/files/upload`, { method: "POST", body: { path: target, contentBase64: btoa(binary) } }), `Uploaded ${file.name}.`);
      });
      actions.append(button("Upload", () => picker.click(), { small: true }), picker, button("New folder", () => promptSheet("New folder", "Folder name", "", async (name) => {
        await act("New folder", () => api(`${apiBase}/files/folder`, { method: "POST", body: { path: current ? `${current}/${name}` : name } }), `Created ${name}.`);
      }), { small: true }));
      box.append(actions);
    }
    const list = el("div", "list");
    if (!files.entries.length) list.append(el("p", "empty", "This folder is empty."));
    files.entries.forEach((entry) => {
      const row = el("div", "row");
      const main = el("button", "row__main row__button");
      main.type = "button";
      main.append(el("strong", "", `${entry.type === "directory" ? "📁 " : ""}${entry.name}`), el("span", "", entry.type === "directory" ? "Folder" : `${bytes(entry.size)}${entry.modifiedAt ? ` · ${when(entry.modifiedAt)}` : ""}`));
      main.addEventListener("click", () => {
        if (entry.type === "directory") go(entry.path);
        else if (entry.type === "file") openFile(apiBase, entry, canWrite);
      });
      row.append(main);
      if (canWrite) {
        row.append(button("⋯", () => openSheet((container) => {
          const heading = el("h2", "", entry.name);
          heading.id = "sheet-title";
          container.append(heading);
          const actions = el("div", "list");
          actions.append(
            button("Rename", () => { closeSheet(); promptSheet("Rename", "New name", entry.name, async (name) => {
              const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "";
              await act("Rename", () => api(`${apiBase}/files/rename`, { method: "POST", body: { oldPath: entry.path, newPath: `${parent}${name}` } }), `Renamed to ${name}.`);
            }); }),
            button("Delete", async () => {
              closeSheet();
              if (!(await confirmSheet({ title: `Delete ${entry.name}?`, message: entry.type === "directory" ? "The folder and everything in it are deleted. This can't be undone from the phone." : "The file is deleted. This can't be undone from the phone.", confirmLabel: "Delete", danger: true }))) return;
              await act("Delete", () => api(`${apiBase}/files/delete`, { method: "POST", body: { path: entry.path, confirm: entry.path } }), `Deleted ${entry.name}.`);
            }, { kind: "danger" }),
            button("Cancel", closeSheet, { kind: "quiet" }),
          );
          container.append(actions);
        }), { kind: "quiet", small: true, title: "File actions" }));
      }
      list.append(row);
    });
    box.append(list);
    if (!canWrite) box.append(roleNote("change files"));
    return box;
  }

  function promptSheet(title, label, value, onSubmit) {
    openSheet((container) => {
      const heading = el("h2", "", title);
      heading.id = "sheet-title";
      const form = el("form", "list");
      const field = el("label", "field");
      field.append(el("span", "", label));
      const input = el("input", "input");
      input.value = value;
      input.autocapitalize = "off";
      input.maxLength = 200;
      field.append(input);
      const actions = el("div", "actions");
      const ok = el("button", "button is-primary is-wide", "Save");
      ok.type = "submit";
      actions.append(button("Cancel", closeSheet, { kind: "quiet", wide: true }), ok);
      form.append(field, actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name || /[\\/]/.test(name) || name === "." || name === "..") { toast("Use a name without slashes.", "warning"); return; }
        closeSheet();
        onSubmit(name);
      });
      container.append(heading, form);
    });
  }

  async function openFile(apiBase, entry, canWrite) {
    let file;
    try {
      file = await api(`${apiBase}/file?path=${enc(entry.path)}`);
    } catch (error) {
      handleApiError(error);
      return;
    }
    openSheet((container) => {
      const heading = el("h2", "", entry.name);
      heading.id = "sheet-title";
      container.append(heading);
      // Download keeps the exact bytes; text files can also be read here.
      const download = caps().filesDownload ? el("a", "button", "Download") : null;
      if (download) {
        download.href = `/api${apiBase}/file/download?path=${enc(entry.path)}`;
        download.setAttribute("download", entry.name);
      }
      if (!file.supported) {
        const reason = file.reason === "file_too_large"
          ? "This file is over 1 MB, too big to show here."
          : file.reason === "binary" ? "This file isn't text, so it can't be shown or edited here." : "This file can't be shown here.";
        const actions = el("div", "actions");
        actions.append(button("Close", closeSheet, { kind: "quiet", wide: true }));
        if (download) actions.append(download);
        container.append(el("p", "", download ? `${reason} Download it to open it on this phone.` : reason), actions);
        return;
      }
      const area = el("textarea", "textarea");
      area.value = file.content;
      area.readOnly = !canWrite;
      area.spellcheck = false;
      area.setAttribute("aria-label", `Contents of ${entry.name}`);
      container.append(area);
      const actions = el("div", "actions");
      actions.append(button("Close", closeSheet, { kind: "quiet", wide: true }));
      if (download) actions.append(download);
      if (canWrite) {
        actions.append(button("Save", async () => {
          if (area.value === file.content) { closeSheet(); return; }
          closeSheet();
          await act("Save file", () => api(`${apiBase}/file`, { method: "PUT", body: { path: entry.path, content: area.value } }), `Saved ${entry.name}. Restart the server if it reads this file only at start.`);
        }, { kind: "primary", wide: true }));
      }
      container.append(actions);
    });
  }

  function serverAddons(data, apiBase) {
    const box = document.createDocumentFragment();
    const support = data.server.addons;
    if (!support?.supported) {
      box.append(el("p", "empty", support?.reason || "Add-ons are not available for this server."));
      return box;
    }
    const addons = data.addons || { mods: [] };
    const canWrite = caps().addons;
    if (addons.running && canWrite) box.append(el("p", "notice", "Changes take effect after the server restarts."));
    if (canWrite) {
      const search = el("form", "command");
      const input = el("input", "input");
      input.placeholder = `Find ${support.label || "add-ons"}`;
      input.dataset.keep = "addon-search";
      input.setAttribute("aria-label", "Search add-ons");
      const go = el("button", "button", "Search");
      go.type = "submit";
      search.append(input, go);
      search.addEventListener("submit", async (event) => {
        event.preventDefault();
        input.blur();
        try {
          const results = await api(`${apiBase}/addons/search?q=${enc(input.value.trim())}`);
          showSearchResults(apiBase, results);
        } catch (error) {
          handleApiError(error);
        }
      });
      box.append(search);
      const updates = el("div", "actions");
      updates.append(button("Check for updates", async () => {
        try {
          const result = await api(`${apiBase}/addons/updates`);
          if (!result.updates.length) { toast(result.failed ? "Some add-ons couldn't be checked." : "Everything is up to date."); return; }
          if (!(await confirmSheet({ title: `${result.updates.length} update${result.updates.length === 1 ? "" : "s"} available`, lines: result.updates.map((update) => `${update.title}: ${update.currentVersion || "?"} → ${update.latestVersion}`), confirmLabel: "Update all" }))) return;
          await act("Update add-ons", () => api(`${apiBase}/addons/update-all`, { method: "POST", body: {} }), "Add-ons updated.");
        } catch (error) {
          handleApiError(error);
        }
      }, { small: true }));
      box.append(updates);
    }
    (addons.warnings || []).forEach((warning) => box.append(el("p", "notice", `${warning.title} needs ${warning.missing}, which isn't installed.`)));
    const list = el("div", "list");
    if (!addons.mods.length) list.append(el("p", "empty", `No ${support.kind || "add-ons"} installed.`));
    addons.mods.forEach((mod) => {
      const row = el("div", "row");
      const main = el("span", "row__main");
      main.append(el("strong", "", mod.title), el("span", "", [mod.versionNumber, mod.enabled ? "" : "Turned off", mod.provider || "Added by hand"].filter(Boolean).join(" · ")));
      row.append(el("span", `dot ${mod.enabled ? "tone-ok" : ""}`), main);
      if (canWrite) {
        row.append(button("⋯", () => openSheet((container) => {
          const heading = el("h2", "", mod.title);
          heading.id = "sheet-title";
          container.append(heading);
          const actions = el("div", "list");
          actions.append(button(mod.enabled ? "Turn off" : "Turn on", async () => {
            closeSheet();
            await act("Change add-on", () => api(`${apiBase}/addons/enabled`, { method: "POST", body: { fileName: mod.fileName, enabled: !mod.enabled } }), `${mod.title} turned ${mod.enabled ? "off" : "on"}.`);
          }));
          if (mod.provider) actions.append(button("Update", async () => { closeSheet(); await act("Update add-on", () => api(`${apiBase}/addons/update`, { method: "POST", body: { fileName: mod.fileName } }), (result) => (result.updated === false ? `${mod.title} is up to date.` : `${mod.title} updated.`)); }));
          if (mod.canRollBack) actions.append(button("Roll back", async () => { closeSheet(); await act("Roll back", () => api(`${apiBase}/addons/rollback`, { method: "POST", body: { fileName: mod.fileName } }), `${mod.title} rolled back.`); }));
          actions.append(button("Remove", async () => {
            closeSheet();
            if (!(await confirmSheet({ title: `Remove ${mod.title}?`, message: "AnxHost keeps a copy, so it can be put back on the computer.", confirmLabel: "Remove", danger: true }))) return;
            await act("Remove add-on", () => api(`${apiBase}/addons/remove`, { method: "POST", body: { fileName: mod.fileName, confirm: mod.fileName, enabled: mod.enabled } }), `${mod.title} removed.`);
          }, { kind: "danger" }), button("Cancel", closeSheet, { kind: "quiet" }));
          container.append(actions);
        }), { kind: "quiet", small: true, title: "Add-on actions" }));
      }
      list.append(row);
    });
    box.append(list);
    if (!canWrite) box.append(roleNote("install or remove add-ons"));
    return box;
  }

  function showSearchResults(apiBase, results) {
    openSheet((container) => {
      const heading = el("h2", "", results.hits.length ? `Results (${results.total})` : "Nothing found");
      heading.id = "sheet-title";
      container.append(heading);
      const list = el("div", "list");
      results.hits.forEach((hit) => {
        const row = el("div", "row");
        const main = el("span", "row__main");
        main.append(el("strong", "", hit.name), el("span", "", [hit.author, hit.description].filter(Boolean).join(" · ")));
        row.append(main, button("Add", async () => {
          closeSheet();
          let plan;
          try {
            plan = await api(`${apiBase}/addons/plan?provider=${enc(results.provider)}&projectId=${enc(hit.id)}`);
          } catch (error) {
            handleApiError(error);
            return;
          }
          const lines = [`${plan.project.name} ${plan.project.versionNumber}`, ...plan.dependencies.map((dependency) => `Also needed: ${dependency.name} ${dependency.versionNumber}`)];
          const warnings = [...plan.problems, ...plan.conflicts].map((problem) => `${problem.name}: ${problem.reason}`);
          if (!plan.canInstall) {
            await confirmSheet({ title: `Can't add ${plan.project.name}`, lines, warnings, confirmLabel: "OK" });
            return;
          }
          if (!(await confirmSheet({ title: `Add ${plan.project.name}?`, lines, warnings: plan.restartRequired ? ["The server is running; restart it afterwards to load the change."] : [], confirmLabel: plan.dependencies.length ? "Add all" : "Add" }))) return;
          await act("Add add-on", () => api(`${apiBase}/addons/install`, { method: "POST", body: { provider: results.provider, projectId: hit.id, approvedDependencies: plan.dependencies.map((dependency) => dependency.projectId) } }), `${plan.project.name} added.`);
        }, { small: true }));
        list.append(row);
      });
      container.append(list, button("Close", closeSheet, { kind: "quiet" }));
    });
  }

  function serverBackups(data, apiBase) {
    const box = document.createDocumentFragment();
    const backups = data.backups?.backups || [];
    const nodeId = state.route.params[0];
    const c = caps();
    if (c.backupsCreate) {
      box.append(button("Back up now", () => openSheet((container) => {
        const heading = el("h2", "", "Back up now");
        heading.id = "sheet-title";
        container.append(heading, el("p", "", "Whole server copies everything in its folder. World only copies just the world."));
        const actions = el("div", "list");
        const create = (type) => async () => {
          closeSheet();
          await act("Back up", () => api(`${apiBase}/backups`, { method: "POST", body: { type } }), "Backup started.");
        };
        actions.append(button("Whole server", create("full"), { kind: "primary" }), button("World only", create("world")), button("Cancel", closeSheet, { kind: "quiet" }));
        container.append(actions);
      }), { kind: "primary" }));
    }
    const list = el("div", "list");
    if (!backups.length) list.append(el("p", "empty", "No backups yet."));
    backups.forEach((backup) => {
      const row = el("div", "row");
      const main = el("span", "row__main");
      main.append(el("strong", "", backup.name), el("span", "", [when(backup.createdAt), backup.type === "world" ? "World" : "Whole server", bytes(backup.size), backup.verification].filter(Boolean).join(" · ")));
      row.append(main);
      if (c.backupsVerify || c.backupsRestore || c.backupsDownload) {
        row.append(button("⋯", () => openSheet((container) => {
          const heading = el("h2", "", backup.name);
          heading.id = "sheet-title";
          container.append(heading);
          const actions = el("div", "list");
          const backupPath = `/backups/${enc(nodeId)}/${enc(backup.id)}`;
          if (c.backupsVerify) actions.append(button("Check this backup", async () => { closeSheet(); await act("Check backup", () => api(`${backupPath}/verify`, { method: "POST", body: {} }), (result) => `Check finished: ${result.state || "done"}. ${result.detail || ""}`); }));
          if (c.backupsDownload) {
            const download = el("a", "button", "Download");
            download.href = `/api${backupPath}/download`;
            download.setAttribute("download", "");
            actions.append(download);
          }
          if (c.backupsRestore) actions.append(button("Restore…", async () => { closeSheet(); await restoreFlow(backupPath, backup); }, { kind: "danger" }));
          actions.append(button("Cancel", closeSheet, { kind: "quiet" }));
          container.append(actions);
        }), { kind: "quiet", small: true, title: "Backup actions" }));
      }
      list.append(row);
    });
    box.append(list);
    if (!c.backupsCreate) box.append(roleNote(c.backupsVerify ? "create or restore backups" : "create, check or restore backups"));
    return box;
  }

  async function restoreFlow(backupPath, backup) {
    let preview;
    try {
      preview = await api(`${backupPath}/restore-preview`, { method: "POST", body: {} });
    } catch (error) {
      handleApiError(error);
      return;
    }
    const lines = preview.available ? preview.lines : ["This replaces the server's files with the backup. Files changed since the backup are overwritten. AnxHost keeps a safety copy first."];
    if (!(await confirmSheet({ title: `Restore ${backup.name}?`, lines, warnings: preview.warnings || [], confirmLabel: "Restore", danger: true, phrase: "RESTORE" }))) return;
    await act("Restore", () => api(`${backupPath}/restore`, { method: "POST", body: { confirm: "RESTORE" } }), "Restore started. The server may be stopped while files are replaced.");
  }

  function serverSettings(data, apiBase) {
    const box = document.createDocumentFragment();
    const settings = data.settings;
    if (!settings) { box.append(el("div", "skeleton")); return box; }
    const canWrite = caps().settings;
    const form = el("form", "card");
    const errors = el("p", "field-error");
    errors.hidden = true;
    const field = (label, control) => { const wrap = el("label", "field"); wrap.append(el("span", "", label), control); return wrap; };
    const name = el("input", "input");
    name.value = settings.values.displayName;
    name.maxLength = 80;
    name.dataset.keep = "name";
    const memory = el("input", "input");
    memory.value = settings.values.memoryLimit;
    memory.placeholder = "For example 4G";
    memory.dataset.keep = "memory";
    const policy = el("select", "select");
    policy.dataset.keep = "policy";
    const policyLabels = { never: "Don't restart", "on-failure": "Restart if it crashes", always: "Always restart" };
    settings.restartPolicies.forEach((value) => { const option = el("option", "", policyLabels[value] || value); option.value = value; policy.append(option); });
    policy.value = settings.values.restartPolicy;
    const autoWrap = el("label", "check");
    const auto = el("input");
    auto.type = "checkbox";
    auto.checked = settings.values.autoStart;
    auto.dataset.keep = "auto";
    autoWrap.append(auto, el("span", "", "Start when the computer starts"));
    [name, memory, policy, auto].forEach((control) => { control.disabled = !canWrite; });
    form.append(el("h2", "", "Settings"), field("Name", name), field("Memory", memory), field("If the server stops", policy), autoWrap, errors);
    if (canWrite) {
      const save = el("button", "button is-primary", "Save");
      save.type = "submit";
      form.append(save);
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = { displayName: name.value.trim(), memoryLimit: memory.value.trim(), restartPolicy: policy.value, autoStart: auto.checked };
      const changes = {};
      Object.keys(values).forEach((key) => { if (values[key] !== settings.values[key]) changes[key] = values[key]; });
      if (!Object.keys(changes).length) { toast("Nothing changed."); return; }
      const problems = ServerView.validateServerSettings(changes);
      if (Object.keys(problems).length) { errors.textContent = Object.values(problems)[0]; errors.hidden = false; return; }
      errors.hidden = true;
      document.activeElement?.blur();
      try {
        const result = await api(`${apiBase}/settings`, { method: "PUT", body: { changes, expected: settings.expected } });
        toast(result.restartRecommended ? "Saved. Restart the server to use the new memory size." : "Saved.");
        state.data.settings = null;
        await load({ background: true });
      } catch (error) {
        if (error.code === "INSTANCE_CONFIG_CONFLICT") {
          errors.textContent = error.message;
          errors.hidden = false;
          state.data.settings = null;
        } else {
          errors.textContent = error.message;
          errors.hidden = false;
          handleApiError(error, { quiet: true });
        }
      }
    });
    box.append(form);
    if (!canWrite) box.append(roleNote("change settings"));
    box.append(el("p", "notice", `Only on the computer: ${settings.desktopOnly.join(", ")}.`));
    return box;
  }

  // ---- Sharing and More -------------------------------------------------------------------

  function renderSharing() {
    setChrome("Sharing");
    const anxnet = state.data.anxnet || {};
    const draft = document.createDocumentFragment();
    const card = el("div", "card");
    card.append(el("h2", "", "AnxNet"));
    if (!anxnet.network) {
      card.append(el("p", "muted", anxnet.error || "This computer isn't in an AnxNet network. Set it up in AnxHost on the computer (Computers > AnxNet)."));
    } else {
      const facts = el("dl", "facts");
      const add = (label, value) => facts.append(el("dt", "", label), el("dd", "wrap", value));
      add("Network", anxnet.network.name || "");
      add("Names", anxnet.network.domain || "");
      add("This computer", anxnet.network.role === "owner" ? "Owner of the network" : "Member");
      add("Running", anxnet.running ? "Yes" : "No");
      card.append(facts);
      if (anxnet.reachability) card.append(el("p", "muted", anxnet.reachability));
    }
    draft.append(card);
    if (anxnet.devices?.length) {
      draft.append(el("h2", "section-title", "Devices"));
      const list = el("div", "list");
      const labels = { self: "This computer", direct: "Connected directly", relay: "Through the relay", udp: "Direct UDP path", "not-connected": "Not connected" };
      anxnet.devices.forEach((device) => {
        const tone = device.self || device.connection === "direct" || device.connection === "udp" ? "ok" : device.connection === "relay" ? "busy" : "muted";
        const row = el("div", `row tone-${tone}`);
        const main = el("span", "row__main");
        main.append(el("strong", "", device.name), el("span", "", `${labels[device.connection] || device.connection}${device.latencyMs !== null ? ` · ${device.latencyMs} ms` : ""}`));
        row.append(el("span", "dot"), main);
        list.append(row);
      });
      draft.append(list);
    }
    if (anxnet.services?.length) {
      draft.append(el("h2", "section-title", "Shared servers"));
      const list = el("div", "list");
      anxnet.services.forEach((service) => {
        const row = el("div", "row");
        const main = el("span", "row__main");
        main.append(el("strong", "", service.name), el("span", "", `${String(service.protocol || "").toUpperCase()} ${service.port ?? ""} · ${service.local ? "On this computer" : "On another device"}`));
        row.append(main);
        list.append(row);
      });
      draft.append(list);
    }
    const publicNote = anxnet.publicRoutes
      ? `${anxnet.publicRoutes} public address${anxnet.publicRoutes === 1 ? "" : "es"} set up through an AnxNet gateway. Check them from the computer's Share dialog; this phone doesn't test them from the internet.`
      : "No public addresses through AnxNet. Friends outside your network can't join unless you set one up on the computer.";
    draft.append(el("p", "notice", publicNote));
    draft.append(el("p", "dim", "Sharing changes are made on the computer."));
    view.replaceChildren(draft);
  }

  function renderMore() {
    setChrome("More");
    const device = state.session?.device || {};
    const draft = document.createDocumentFragment();
    const card = el("div", "card");
    const facts = el("dl", "facts");
    const add = (label, value) => facts.append(el("dt", "", label), el("dd", "wrap", value));
    add("This phone", device.name || "");
    add("Access", device.role || "");
    add("Access ends", device.expiresAt ? `${when(device.expiresAt)} if not used before then` : "");
    if (state.session?.connection?.via) add("Connected through", state.session.connection.via);
    card.append(el("h2", "", "This phone"), facts);
    card.append(button("Sign out this phone", async () => {
      if (!(await confirmSheet({ title: "Sign out this phone?", message: "The phone loses access. Pair it again from the computer to come back.", confirmLabel: "Sign out", danger: true }))) return;
      try {
        await api("/logout", { method: "POST", body: {} });
      } catch {
        // Signing out locally still clears the session view.
      }
      state.session = null;
      renderUnpaired();
    }, { kind: "danger" }));
    draft.append(card);
    const about = el("div", "card");
    about.append(
      el("h2", "", "About"),
      el("p", "muted", "This app talks only to AnxHost on your computer, over your home network. It works while AnxHost is running and unlocked there."),
      el("p", "muted", "Alerts appear while the app is open. AnxHost doesn't send push notifications to phones."),
      el("p", "muted", "Server data isn't saved on the phone. When the computer can't be reached, old readings are marked with their age and hidden after five minutes."),
      el("p", "muted", "Install it: on iPhone, Share > Add to Home Screen. On Android, the browser menu > Install app."),
    );
    draft.append(about);
    const check = el("div", "card");
    check.append(
      el("h2", "", "Check this phone"),
      el("p", "muted", "Tests this phone's browser with AnxHost (certificate trust, installed app, screen, connection speed) and sends the result to Phone Access on the computer. It sends no server data."),
      button("Run the check", () => runPhoneCheck(check), { kind: "primary" }),
    );
    draft.append(check);
    view.replaceChildren(draft);
  }

  // ---- Phone check -----------------------------------------------------------------------------

  // Browser facts measured on the real device, so real-phone results are
  // recorded rather than assumed.
  async function collectPhoneCheck() {
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok, detail });
    add("secure-context", window.isSecureContext, window.isSecureContext ? "HTTPS page with a trusted certificate" : "Not a secure context");
    let serviceWorker = "unsupported";
    if ("serviceWorker" in navigator) {
      try {
        const registration = await Promise.race([navigator.serviceWorker.getRegistration("/"), new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
        serviceWorker = registration?.active ? "active" : registration ? "installing" : "none";
      } catch (error) {
        serviceWorker = "error";
      }
    }
    // Browsers refuse service workers on certificates they don't trust, so
    // this also shows whether the AnxHost certificate is really trusted.
    add("service-worker", serviceWorker === "active", `Offline app shell: ${serviceWorker}`);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    // Not installed isn't a fault, just a fact worth recording.
    add("installed", standalone ? true : null, standalone ? "Opened as an installed app" : "Opened in the browser (not installed, or installed but opened from the browser)");
    const times = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      try { await api("/session"); times.push(performance.now() - started); } catch { /* counted below */ }
    }
    times.sort((a, b) => a - b);
    const latencyMs = times.length ? times[Math.floor(times.length / 2)] : null;
    add("connection", times.length === 5, latencyMs === null ? "The computer didn't answer" : `${Math.round(latencyMs)} ms median over ${times.length} requests`);
    const probe = el("div");
    probe.className = "safe-area-probe";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const safeArea = { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 };
    probe.remove();
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    add("layout", !overflow, overflow ? `Page is ${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px screen` : "No sideways scrolling");
    const sample = el("input", "input");
    document.body.append(sample);
    const inputSize = parseFloat(getComputedStyle(sample).fontSize);
    sample.remove();
    add("input-zoom", inputSize >= 16, `Text fields use ${inputSize}px text${inputSize >= 16 ? "" : " (iPhone zooms in under 16px)"}`);
    const orientation = (screen.orientation && screen.orientation.type) || (window.matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait");
    return {
      userAgent: navigator.userAgent,
      standalone,
      secureContext: window.isSecureContext,
      serviceWorker,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      safeArea,
      orientation,
      touchPoints: navigator.maxTouchPoints || 0,
      latencyMs,
      checks,
    };
  }

  async function runPhoneCheck(container) {
    const result = el("div", "list");
    container.querySelectorAll(".list, .notice").forEach((node) => node.remove());
    container.append(el("p", "notice", "Checking…"));
    const report = await collectPhoneCheck();
    container.querySelectorAll(".notice").forEach((node) => node.remove());
    report.checks.forEach((entry) => {
      const row = el("div", `row tone-${entry.ok === true ? "ok" : entry.ok === false ? "warning" : "muted"}`);
      const main = el("span", "row__main");
      main.append(el("strong", "", entry.id.replace(/-/g, " ")), el("span", "", entry.detail));
      row.append(el("span", "dot"), main);
      result.append(row);
    });
    container.append(result);
    try {
      await api("/phone-check", { method: "POST", body: report });
      container.append(el("p", "notice", "Sent to Phone Access on the computer."));
    } catch (error) {
      container.append(el("p", "notice", `Not sent: ${error.message}`));
    }
  }

  // ---- Start ---------------------------------------------------------------------------------

  async function start() {
    if (pendingCode) {
      renderPairing();
      return;
    }
    try {
      const session = await api("/session");
      state.session = session;
      state.csrf = session.csrf;
    } catch (error) {
      if (error.status === 401) { renderUnpaired(); return; }
      view.replaceChildren(el("p", "empty", error.message));
      state.lastError = error;
      updateBanner();
      setTimeout(start, 10000);
      return;
    }
    state.route = parseRoute();
    if (!location.hash || location.hash === "#") history.replaceState(null, "", `${location.pathname}#/home`);
    load({ background: false });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  start();
})();
