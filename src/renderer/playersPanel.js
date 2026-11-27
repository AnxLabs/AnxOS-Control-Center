// Live players on a server's Players tab (Phase 8). Shows who is online, the
// server's own per-player ping where the game reports it ("Not supported"
// where it does not), how long each player has been on, and the joins and
// leaves AnxOS saw. Data comes from instances:getPlayers (the Agent's
// playerMonitor). Polls every 10 s, and only while the Players tab of a
// server is open. Names are shown, never stored.
(function initializeLivePlayers(root) {
  "use strict";

  const POLL_MS = 10 * 1000;
  // Same families as src/shared/instances/playerMonitor.js.
  const SUPPORTED = /palworld|fivem|fxserver|valheim|counter-strike|\bcs2\b|\brust\b|minecraft|paper|purpur|spigot|bukkit|fabric|quilt|forge|neoforge|vanilla|velocity|waterfall|bungeecord/;
  // instanceId -> { result, nodeId, at }. Server ids can repeat across
  // computers, so a reading is returned only for the computer it was read on.
  const latest = new Map();
  let timer = null;
  let inFlight = false;

  function safe(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function el(tag, className = "", text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  function searchText(instance) {
    if (!instance) return "";
    return [instance.game, instance.templateId, instance.type, instance.displayName, instance.id, instance.serverSoftware, ...(Array.isArray(instance.tags) ? instance.tags : [])].join(" ").toLowerCase();
  }

  function supports(instance) {
    const text = searchText(instance);
    return Boolean(text) && !/hytale|terraria|tshock/.test(text) && SUPPORTED.test(text);
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  function panelHost() {
    return document.querySelector('[data-instance-panel="players"]');
  }

  function ensureSection() {
    const host = panelHost();
    if (!host) return null;
    let section = host.querySelector("[data-live-players]");
    if (!section) {
      section = el("section", "live-players");
      section.dataset.livePlayers = "";
      section.setAttribute("aria-live", "polite");
      host.prepend(section);
    }
    return section;
  }

  function pingText(player, result) {
    if (!result.ping || result.ping.supported !== true) return "Not supported";
    return Number.isFinite(player.pingMs) ? `${player.pingMs} ms` : "—";
  }

  function render(instance, result, error) {
    const section = ensureSection();
    if (!section) return;
    const draft = el("div");
    const head = el("div", "live-players__head");
    const title = el("div");
    title.append(el("h3", "", "Online now"), el("span", "", result?.sourceLabel ? `From the ${result.sourceLabel}, every 10 seconds while this tab is open.` : "Read from the game server while this tab is open."));
    head.append(title);
    draft.append(head);

    if (!supports(instance)) {
      draft.append(el("p", "live-players__note", "This kind of server does not offer a player list AnxHost can read."));
    } else if (error) {
      draft.append(el("p", "live-players__note live-players__note--warning", error));
    } else if (!result) {
      draft.append(el("p", "live-players__note", "Checking who is online…"));
    } else if (result.supported === false) {
      draft.append(el("p", "live-players__note", result.message || "Player information is not available for this server."));
    } else if (result.running === false) {
      draft.append(el("p", "live-players__note", "The server is not running."));
    } else if (result.available === false) {
      draft.append(el("p", "live-players__note live-players__note--warning", result.message || "The server did not answer."));
    } else {
      const summary = el("div", "live-players__summary");
      const count = el("div", "live-players__stat");
      count.dataset.livePlayersCount = "";
      count.append(el("span", "", "Players"), el("strong", "", `${result.online ?? "—"}${Number.isFinite(result.max) ? ` of ${result.max}` : ""}`));
      const ping = el("div", "live-players__stat");
      ping.dataset.livePlayersPing = result.ping?.supported ? "supported" : "not-supported";
      ping.append(el("span", "", "Average ping"), el("strong", "", result.ping?.supported ? (Number.isFinite(result.ping.averageMs) ? `${result.ping.averageMs} ms` : "—") : "Not supported"));
      summary.append(count, ping);
      if (result.ping?.supported && result.ping.highCount > 0) {
        const high = el("div", "live-players__stat live-players__stat--warning");
        high.append(el("span", "", "High ping"), el("strong", "", `${result.ping.highCount} ${result.ping.highCount === 1 ? "player" : "players"} at ${result.ping.highThresholdMs} ms or more`));
        summary.append(high);
      }
      draft.append(summary);

      const players = Array.isArray(result.players) ? result.players : [];
      if (!players.length) {
        draft.append(el("p", "live-players__note", result.online > 0 ? "The server reports players online but does not list their names." : "Nobody is online."));
      } else {
        const table = el("div", "live-players__table");
        table.setAttribute("role", "table");
        table.setAttribute("aria-label", "Players online");
        const header = el("div", "live-players__row live-players__row--head");
        header.setAttribute("role", "row");
        ["Player", "Ping", "Connected"].forEach((label) => { const cell = el("span", "", label); cell.setAttribute("role", "columnheader"); header.append(cell); });
        table.append(header);
        players.forEach((player, index) => {
          const row = el("div", "live-players__row");
          row.setAttribute("role", "row");
          row.dataset.livePlayer = player.name || `#${index + 1}`;
          const name = el("strong", "", player.name || `Player ${index + 1}`);
          const extra = [Number.isFinite(player.level) ? `level ${player.level}` : "", Number.isFinite(player.score) ? `score ${player.score}` : ""].filter(Boolean).join(" · ");
          const nameCell = el("span", "live-players__name");
          nameCell.append(name);
          if (extra) nameCell.append(el("small", "", extra));
          const pingCell = el("span", Number.isFinite(player.pingMs) && player.pingMs >= (result.ping?.highThresholdMs || 150) ? "is-high" : "", pingText(player, result));
          const connected = Number.isFinite(player.connectedSeconds) ? duration(player.connectedSeconds)
            : Number.isFinite(player.seenForSeconds) ? `${duration(player.seenForSeconds)} (seen by AnxHost)` : "—";
          [nameCell, pingCell, el("span", "", connected)].forEach((cell) => { cell.setAttribute("role", "cell"); row.append(cell); });
          table.append(row);
        });
        draft.append(table);
        if (result.namesShown === false) draft.append(el("p", "live-players__note", "Names are not shown for this service-managed server."));
        else if (!result.namesComplete) draft.append(el("p", "live-players__note", "The server lists only some of the names."));
      }
      draft.append(el("p", "live-players__note", result.ping?.note || ""));

      const events = Array.isArray(result.events) ? result.events.slice(-8).reverse() : [];
      if (events.length) {
        const list = el("ul", "live-players__events");
        list.setAttribute("aria-label", "Recent joins and leaves");
        events.forEach((event) => {
          const time = safe(() => new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "");
          list.append(el("li", `live-players__event live-players__event--${event.type}`, `${time} ${event.name} ${event.type === "join" ? "joined" : "left"}`));
        });
        const recent = el("div", "live-players__recent");
        recent.append(el("h4", "", "Recent joins and leaves"), list);
        draft.append(recent);
      }
    }
    section.replaceChildren(...draft.childNodes);
  }

  async function refresh() {
    if (inFlight) return;
    const instance = safe(() => findInstance(), null);
    if (!instance) return;
    if (!supports(instance)) {
      render(instance, null, null);
      return;
    }
    const api = safe(() => getDesktopApiState().api.instances, null);
    if (typeof api?.getPlayers !== "function") return;
    inFlight = true;
    try {
      const nodeId = selectedNodeId();
      const context = safe(() => getNodeRequestContext("live-players"), null);
      const result = await api.getPlayers(instance.id, safe(() => getNodeScopedPayload(context), {}));
      if (safe(() => findInstance()?.id, null) !== instance.id || selectedNodeId() !== nodeId) return;
      if (result && result.ok === false) {
        render(instance, null, result.error?.message || "Player information could not be read.");
        return;
      }
      latest.set(instance.id, { result, nodeId, at: Date.now() });
      render(instance, result, null);
    } catch (error) {
      render(instance, null, safe(() => getAgentErrorMessage(error, "Player information could not be read."), "Player information could not be read."));
    } finally {
      inFlight = false;
    }
  }

  function selectedNodeId() {
    return safe(() => getSelectedNodeId(), null);
  }

  // The last reading of a server on the selected computer; with maxAgeMs,
  // only one taken within that time.
  function latestReading(instanceId, { maxAgeMs = null } = {}) {
    const entry = latest.get(instanceId);
    if (!entry || entry.nodeId !== selectedNodeId()) return null;
    if (Number.isFinite(maxAgeMs) && Date.now() - entry.at > maxAgeMs) return null;
    return entry.result || null;
  }

  function tabOpen() {
    return safe(() => activeInstanceTab, "") === "players" && safe(() => getActivePageName(), "") === "instances" && !document.hidden;
  }

  function tick() {
    if (tabOpen() && !safe(() => isAppLockedForBackgroundWork(), false)) refresh();
  }

  function start() {
    if (!timer) timer = root.setInterval(tick, POLL_MS);
    tick();
  }

  root.AnxLivePlayers = {
    supports,
    refresh,
    latest: latestReading,
    start,
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
