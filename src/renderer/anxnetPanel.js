// Phase 6: AnxNet in the app. The Computers page gets an AnxNet section
// (create or join a network, invite and approve devices, see how each device
// is connected, remove devices, relay and gateway settings), and each
// server's Share dialog gets AnxNet sharing (Invite only / Anyone can join).
// All work happens in the main process (src/services/anxnetService.js).
// Loaded after app.js, whose top-level functions are globals.
(function () {
  "use strict";

  const panel = document.querySelector("[data-anxnet-panel]");
  let latest = null;
  let dnsInfo = null;
  let dnsCheckedAt = 0;
  let lastInvite = null;
  let busy = false;
  let timer = null;

  function api() {
    return getDesktopApiState().api?.anxnet || null;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, onClick, options = {}) {
    const node = el("button", `inline-action${options.primary ? " instance-action--primary" : ""}${options.danger ? " instance-danger-action" : ""}`, label);
    node.type = "button";
    node.disabled = busy || options.disabled === true;
    if (options.title) node.title = options.title;
    node.addEventListener("click", onClick);
    return node;
  }

  function unwrap(result, fallback) {
    if (result && result.ok === false) throw Object.assign(new Error(result.error?.message || fallback), { code: result.error?.code });
    return result;
  }

  async function run(label, work, success) {
    if (busy) return null;
    busy = true;
    render();
    try {
      const result = unwrap(await work(), `${label} failed.`);
      if (success) showToast(typeof success === "function" ? success(result) : success, "success");
      await refresh();
      return result;
    } catch (error) {
      showToast(error?.message || `${label} failed.`, "warning");
      return null;
    } finally {
      busy = false;
      render();
    }
  }

  async function refresh() {
    if (!api()) return null;
    try {
      latest = unwrap(await api().status(), "AnxNet status is unavailable.");
    } catch (error) {
      latest = { error: error.message };
    }
    if (latest?.network && Date.now() - dnsCheckedAt > 60000 && typeof api().dnsStatus === "function") {
      dnsCheckedAt = Date.now();
      try { dnsInfo = unwrap(await api().dnsStatus(), "Name lookup status is unavailable."); } catch (error) { dnsInfo = { available: false, reason: error.message }; }
    }
    render();
    return latest;
  }

  const CONNECTION_LABELS = {
    self: "This computer",
    direct: "Connected directly",
    relay: "Connected through the relay",
    udp: "Direct UDP path",
    "not-connected": "Not connected right now",
  };

  // ---- Computers page ---------------------------------------------------------------

  function renderSetup(container) {
    container.append(el("p", "anxnet-lede", "AnxNet is AnxOS's own private network. Your computers and friends' devices get names like desktop.anx-frost72.internal, and you can share game servers with them without port forwarding when a path exists. No domain to buy, and no third-party account needed."));
    const actions = el("div", "anxnet-actions");
    actions.append(button("Create a network", () => run("Create network", () => api().createNetwork({}), (result) => `Created ${result.network?.name || "your network"}.`), { primary: true }));
    const joinForm = el("form", "anxnet-join");
    const input = el("input");
    input.placeholder = "Paste an invite code (anx1.…)";
    input.setAttribute("aria-label", "Invite code");
    input.autocomplete = "off";
    input.spellcheck = false;
    joinForm.append(input, button("Join", () => joinForm.requestSubmit()));
    joinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      run("Join network", () => api().joinNetwork({ code }), (result) => (result.pendingApproval ? "Asked to join. The network owner needs to approve this computer." : `Joined ${result.network?.name}.`));
    });
    actions.append(joinForm);
    container.append(actions);
  }

  function renderNetworkHeader(container, status) {
    const network = status.network;
    const head = el("div", "anxnet-head");
    const titles = el("div");
    titles.append(el("strong", "anxnet-name", network.name), el("span", "anxnet-domain", `${network.domain} · ${network.role === "owner" ? "you own this network" : "member"}`));
    const coordinator = network.coordinator?.state;
    const stateText = network.role === "owner" ? "This computer coordinates the network"
      : coordinator === "connected" ? "Connected to the network"
        : coordinator === "pending-approval" ? "Waiting for the owner to approve this computer"
          : coordinator === "removed" ? "Removed from the network"
            : coordinator === "reconnecting" ? "Reconnecting…" : "Connecting…";
    const chip = el("span", `anxnet-state is-${network.role === "owner" || coordinator === "connected" ? "ok" : coordinator === "removed" ? "bad" : "busy"}`, stateText);
    if (network.coordinator?.message) chip.title = network.coordinator.message;
    head.append(titles, chip);
    container.append(head);
    if (network.coordinator?.message && network.role !== "owner") container.append(el("p", "anxnet-note", network.coordinator.message));
    const actions = el("div", "anxnet-actions");
    if (network.role === "owner") {
      actions.append(button("Invite a device", async () => {
        const result = await run("Create invite", () => api().createInvite({ ttlMinutes: 60, maxUses: 1 }));
        if (result?.code) { lastInvite = { code: result.code, expiresAt: result.invite?.expiresAt }; render(); }
      }, { primary: true }));
      actions.append(button("Rename", async () => {
        const name = await promptText("Rename network", "New name (anx-…)", network.name);
        if (name) run("Rename", () => api().renameNetwork(name), "Network renamed.");
      }));
    }
    actions.append(button("Leave network", async () => {
      const ok = await createSecurityConfirmation({ title: network.role === "owner" ? "Leave and close this network?" : "Leave this network?", message: network.role === "owner" ? "This computer owns the network. Other devices lose their connection to it and its shared servers." : "This computer stops being part of the network. You'll need a new invite to come back.", confirmLabel: "Leave" });
      if (!ok) return;
      const hadNames = dnsInfo?.enabled === true;
      await run("Leave", () => api().leaveNetwork(), "Left the network.");
      if (hadNames && await createSecurityConfirmation({ title: "Remove the AnxNet name rule too?", message: "This computer still sends AnxNet names to AnxNet, which is no longer running. Removing the rule restores the previous setting. Windows will ask for administrator permission.", confirmLabel: "Remove rule" })) {
        await run("Remove name rule", () => api().dnsDisable(), "The AnxNet name rule was removed.");
      }
      dnsInfo = null;
    }, { danger: true }));
    container.append(actions);
  }

  // Can servers be opened to everyone right now? Only when a gateway is
  // configured and this computer is actually connected to it.
  function renderAvailability(container, status) {
    const gateway = (status.edgeLinks || []).find((link) => link.role === "gateway");
    const relay = (status.edgeLinks || []).find((link) => link.role === "relay");
    const line = el("div", "anxnet-availability");
    const gatewayText = !status.network.gateways?.length
      ? "Anyone can join: needs an AnxNet gateway (or use Playit)."
      : gateway?.state === "connected"
        ? `Anyone can join: available through ${gateway.host}.`
        : status.network.role !== "owner"
          ? "Anyone can join: set up by the network owner."
          : `Anyone can join: gateway ${status.network.gateways[0].host} isn't reachable right now${gateway?.message ? ` (${gateway.message})` : ""}.`;
    const relayText = !status.network.relays?.length
      ? "No relay: devices that can't reach each other directly won't connect."
      : relay?.state === "connected" ? `Relay ${relay.host} connected.` : `Relay ${status.network.relays[0].host} isn't reachable right now.`;
    line.append(el("span", `anxnet-chip is-${gateway?.state === "connected" ? "ok" : "muted"}`, gatewayText), el("span", `anxnet-chip is-${relay?.state === "connected" ? "ok" : "muted"}`, relayText));
    container.append(line);
  }

  function renderInvite(container) {
    if (!lastInvite) return;
    const box = el("div", "anxnet-invite");
    box.append(el("strong", "", "Invite code (shown once)"));
    const code = el("code", "anxnet-invite__code", lastInvite.code);
    box.append(code, el("span", "anxnet-note", `Works once, until ${lastInvite.expiresAt ? new Date(lastInvite.expiresAt).toLocaleTimeString() : "it expires"}. Paste it in AnxOS on the other device, under Computers > AnxNet > Join. You'll approve the device here.`));
    const actions = el("div", "anxnet-actions");
    actions.append(button("Copy", () => { navigator.clipboard?.writeText(lastInvite.code).then(() => showToast("Invite copied.", "success")); }), button("Hide", () => { lastInvite = null; render(); }));
    box.append(actions);
    container.append(box);
  }

  function renderInvites(container, status) {
    if (status.network.role !== "owner" || !status.invites?.length) return;
    const section = el("div", "anxnet-pending");
    section.append(el("h4", "", "Open invites"));
    status.invites.forEach((invite) => {
      const row = el("div", "anxnet-row");
      row.append(el("div", "anxnet-row__text", `Invite ${invite.inviteId}: ${invite.maxUses - invite.uses} use${invite.maxUses - invite.uses === 1 ? "" : "s"} left, expires ${new Date(invite.expiresAt).toLocaleString()}${invite.preApproved ? " (joins without approval)" : ""}`));
      row.append(button("Cancel", () => run("Cancel invite", () => api().revokeInvite(invite.inviteId), "Invite cancelled.")));
      section.append(row);
    });
    container.append(section);
  }

  function renderPending(container, status) {
    if (!status.pending?.length) return;
    const section = el("div", "anxnet-pending");
    section.append(el("h4", "", "Waiting for your approval"));
    status.pending.forEach((entry) => {
      const row = el("div", "anxnet-row");
      row.append(el("div", "anxnet-row__text", `${entry.name} wants to join (${entry.deviceId})`));
      const actions = el("div", "anxnet-actions");
      actions.append(
        button("Approve", () => run("Approve", () => api().approveDevice(entry.deviceId), `${entry.name} joined.`), { primary: true }),
        button("Reject", () => run("Reject", () => api().rejectDevice(entry.deviceId), "Request rejected.")),
      );
      row.append(actions);
      section.append(row);
    });
    container.append(section);
  }

  function renderDevices(container, status) {
    const section = el("div", "anxnet-devices");
    section.append(el("h4", "", "Devices"));
    const list = el("ul", "anxnet-list");
    status.devices.forEach((device) => {
      const item = el("li", "anxnet-row");
      const text = el("div", "anxnet-row__text");
      text.append(el("strong", "", device.name), el("span", "anxnet-host", device.hostname));
      const facts = [CONNECTION_LABELS[device.connection] || device.connection];
      if (Number.isFinite(device.latencyMs)) facts.push(`${device.latencyMs} ms`);
      if (device.udp && device.connection !== "udp") facts.push("UDP direct");
      text.append(el("span", `anxnet-conn is-${device.connection}`, facts.join(" · ")));
      if (device.lastError) text.append(el("span", "anxnet-error", device.lastError));
      const actions = el("div", "anxnet-actions");
      if (!device.self) actions.append(button("Test", () => run("Test connection", () => api().testPeer(device.deviceId), (result) => `${device.name}: ${result.path === "relay" ? "connected through the relay" : "connected directly"} in ${result.connectMs} ms${Number.isFinite(result.latencyMs) ? `, ${result.latencyMs} ms round trip` : ""}.`)));
      if (status.network.role === "owner" && !device.self) {
        actions.append(button("Remove", async () => {
          const ok = await createSecurityConfirmation({ title: `Remove ${device.name}?`, message: "It loses access to the network straight away, including connections that are open now. It would need a new invite to come back.", confirmLabel: "Remove" });
          if (ok) run("Remove device", () => api().revokeDevice(device.deviceId), `${device.name} removed.`);
        }, { danger: true }));
      }
      item.append(text, actions);
      list.append(item);
    });
    section.append(list);
    container.append(section);
  }

  // Name lookup on this computer: whether apps (games, browsers) can use the
  // .internal names. Turning it on changes one scoped OS setting, so it asks
  // first and the OS asks for administrator permission.
  function renderNameLookup(container, status) {
    const box = el("div", "anxnet-dns");
    box.append(el("h4", "", "Names on this computer"));
    if (!dnsInfo) { box.append(el("p", "anxnet-note", "Checking…")); container.append(box); return; }
    if (!dnsInfo.available) { box.append(el("p", "anxnet-note", dnsInfo.reason || "Not available here.")); container.append(box); return; }
    const self = status.devices.find((device) => device.self);
    if (dnsInfo.enabled) {
      box.append(el("p", "", `On: apps on this computer can use names like ${self?.hostname || status.network.domain}.`));
      box.append(button("Turn off", async () => {
        const ok = await createSecurityConfirmation({ title: "Stop using AnxNet names on this computer?", message: "Removes the AnxNet name rule. Windows will ask for administrator permission. Your normal DNS is not affected either way.", confirmLabel: "Turn off" });
        if (ok) { await run("Turn off names", () => api().dnsDisable(), "AnxNet names are off on this computer."); dnsCheckedAt = 0; refresh(); }
      }));
    } else {
      box.append(el("p", "anxnet-note", dnsInfo.conflict
        ? "Another program already handles these names on this computer, so AnxNet leaves them alone."
        : `Off: games and browsers here can't use ${status.network.domain} names yet. Use the addresses shown (for example ${self?.address}).`));
      if (!dnsInfo.conflict) box.append(button("Turn on", async () => {
        const ok = await createSecurityConfirmation({ title: "Use AnxNet names on this computer?", message: `${dnsInfo.summary} Windows will ask for administrator permission.`, confirmLabel: "Turn on" });
        if (!ok) return;
        const result = await run("Turn on names", () => api().dnsEnable());
        dnsCheckedAt = 0;
        if (result?.verify) showToast(result.verify.ok ? `${result.verify.name} now resolves to ${result.verify.address} on this computer.` : `The rule is in place, but ${result.verify.name} didn't resolve yet (${result.verify.error || result.verify.address}).`, result.verify.ok ? "success" : "warning");
        refresh();
      }));
    }
    container.append(box);
  }

  function renderServices(container, status) {
    if (!status.services?.length) return;
    const section = el("div", "anxnet-services");
    section.append(el("h4", "", "Shared servers"));
    const list = el("ul", "anxnet-list");
    status.services.forEach((service) => {
      const item = el("li", "anxnet-row");
      const text = el("div", "anxnet-row__text");
      text.append(el("strong", "", service.name), el("span", "anxnet-host", `${service.hostname}:${service.port} (${service.protocol.toUpperCase()})`));
      const route = (status.publicRoutes || []).find((entry) => entry.serviceId === service.serviceId);
      if (route) text.append(el("span", "anxnet-conn is-direct", `Public: ${route.publicHost}:${route.publicPort} (${route.protocol.toUpperCase()})`));
      const actions = el("div", "anxnet-actions");
      if (service.local || status.network.role === "owner") actions.append(button("Stop sharing", () => run("Stop sharing", () => api().unshareService(service.serviceId), `${service.name} is no longer shared.`)));
      item.append(text, actions);
      list.append(item);
    });
    section.append(list);
    container.append(section);
  }

  function renderAdvanced(container, status) {
    const details = el("details", "anxnet-advanced");
    details.append(el("summary", "", "Relay, gateway and technical details"));
    const facts = el("dl", "anxnet-facts");
    const fact = (label, value) => { facts.append(el("dt", "", label), el("dd", "", value)); };
    fact("This device", `${status.deviceId} · ${status.fingerprint}`);
    fact("Listening", status.listening ? `TCP ${status.listening.tcpPort}, UDP ${status.listening.udpPort}` : "Not listening");
    fact("Runs in", status.mode === "background" ? `its own background process (pid ${status.host?.pid}, ${status.host?.rssMb} MB), so it keeps working when AnxOS is closed` : "AnxOS itself (stops when AnxOS closes)");
    fact("Private DNS", status.dns ? `${status.dns.host}:${status.dns.port} answers *.${status.dns.domain}. Windows and Linux don't use it automatically yet; use the addresses shown instead.` : "Not running");
    fact("Relay", status.network.relays?.length ? status.network.relays.map((relay) => `${relay.host}:${relay.port}`).join(", ") : "None. Devices that can't reach each other directly can't connect.");
    fact("Gateway", status.network.gateways?.length ? status.network.gateways.map((gateway) => `${gateway.host}:${gateway.port}`).join(", ") : "None. Anyone-can-join needs a gateway on a server with a public address.");
    details.append(facts);
    const relayOnly = el("label", "console-toggle");
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.checked = status.settings?.directInbound === false;
    checkbox.addEventListener("change", () => run("Change setting", () => api().setDirectInbound(!checkbox.checked), checkbox.checked ? "Other devices now reach this computer only through the relay." : "Other devices can connect to this computer directly again."));
    relayOnly.append(checkbox, el("span", "", "Relay only: don't accept direct connections from other devices"));
    details.append(relayOnly);
    if (status.mode === "background") {
      const keep = el("label", "console-toggle");
      const keepBox = el("input");
      keepBox.type = "checkbox";
      keepBox.checked = status.settings?.keepRunningWhenClosed !== false;
      keepBox.addEventListener("change", () => run("Change setting", () => api().setKeepRunning(keepBox.checked), keepBox.checked ? "AnxNet keeps running when AnxOS is closed." : "AnxNet stops when AnxOS closes."));
      keep.append(keepBox, el("span", "", "Keep AnxNet running when AnxOS is closed"));
      details.append(keep);
    }
    if (status.network.role === "owner") {
      const form = el("form", "anxnet-edges");
      form.append(el("p", "anxnet-note", "Run the AnxNet edge on a server you control (node src/anxnet/bin/anxnet-edge.js --config edge.json), then enter its address and the fingerprint it prints. AnxOS never sets this up on a computer by itself."));
      const field = (label, value) => { const wrap = el("label", "ssh-field"); const input = el("input"); input.value = value || ""; wrap.append(el("span", "", label), input); form.append(wrap); return input; };
      const current = status.network.relays?.[0] || status.network.gateways?.[0] || {};
      const host = field("Edge host or IP", current.host);
      const port = field("Edge port", current.port || 47700);
      const fingerprint = field("Edge fingerprint (SHA256:…)", current.fingerprint);
      const useRelay = el("label", "console-toggle"); const relayBox = el("input"); relayBox.type = "checkbox"; relayBox.checked = Boolean(status.network.relays?.length); useRelay.append(relayBox, el("span", "", "Use as relay"));
      const useGateway = el("label", "console-toggle"); const gatewayBox = el("input"); gatewayBox.type = "checkbox"; gatewayBox.checked = Boolean(status.network.gateways?.length); useGateway.append(gatewayBox, el("span", "", "Use as public gateway"));
      form.append(useRelay, useGateway, button("Save", () => form.requestSubmit()));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const entry = { host: host.value.trim(), port: Number(port.value), fingerprint: fingerprint.value.trim() };
        run("Save edge", () => api().setEdges({ relays: relayBox.checked ? [entry] : [], gateways: gatewayBox.checked ? [entry] : [] }), "Saved. Devices pick up the change automatically.");
      });
      details.append(form);
    }
    container.append(details);
  }

  function render() {
    if (!panel) return;
    const content = el("div", "anxnet-content");
    const head = el("div", "anxnet-title");
    head.append(el("h3", "", "AnxNet"), el("span", "anxnet-badge", "Private network"));
    content.append(head);
    if (!api()) content.append(el("p", "anxnet-note", "AnxNet is unavailable in this window."));
    else if (!latest) content.append(el("p", "anxnet-note", "Loading…"));
    else if (latest.error) content.append(el("p", "anxnet-error", latest.error));
    else if (!latest.network) renderSetup(content);
    else {
      renderNetworkHeader(content, latest);
      renderAvailability(content, latest);
      renderInvite(content);
      renderInvites(content, latest);
      renderPending(content, latest);
      renderDevices(content, latest);
      renderNameLookup(content, latest);
      renderServices(content, latest);
      renderAdvanced(content, latest);
    }
    // Keep an open <details> open across redraws.
    const wasOpen = panel.querySelector(".anxnet-advanced")?.open;
    const focusedPlaceholder = document.activeElement?.closest?.("[data-anxnet-panel]") ? document.activeElement.placeholder : null;
    if (focusedPlaceholder) return; // don't redraw under someone typing
    panel.replaceChildren(content);
    if (wasOpen) panel.querySelector(".anxnet-advanced")?.setAttribute("open", "");
  }

  function promptText(title, label, initialValue) {
    if (typeof createSecurityTextPrompt === "function") return createSecurityTextPrompt({ title, message: "", label, initialValue, confirmLabel: "Save" });
    return Promise.resolve(window.prompt(label, initialValue));
  }

  // Light polling only while the Computers page is visible.
  function tick() {
    if (document.hidden || typeof getActivePageName !== "function" || getActivePageName() !== "nodes") return;
    refresh();
  }

  // ---- Share dialog -------------------------------------------------------------------

  function instanceProtocol(instance) {
    const suggestion = (typeof getInstanceAccessSuggestions === "function" ? getInstanceAccessSuggestions(instance) : []).find((entry) => entry.providerId === "playit");
    const value = String(suggestion?.protocol || "TCP").toUpperCase();
    return value.includes("TCP") && value.includes("UDP") ? "both" : value.includes("UDP") ? "udp" : "tcp";
  }

  function instanceTarget(instance) {
    const node = typeof getSelectedNode === "function" ? getSelectedNode() : null;
    const host = node && node.kind === "agent" && typeof getInstanceConnectionHost === "function" ? getInstanceConnectionHost(instance) : "127.0.0.1";
    return { host: !host || host === "Unavailable" || host === "0.0.0.0" ? "127.0.0.1" : host, port: Number(getInstancePrimaryPort(instance)) };
  }

  function createShareSection(instance, { reopen }) {
    const section = el("section", "share-server-controls anxnet-share");
    section.append(el("h3", "", "Share with AnxNet"), el("p", "anxnet-note", "Checking AnxNet…"));
    if (!api()) { section.remove(); return section; }
    api().status().then((result) => {
      const status = result?.ok === false ? null : result;
      section.replaceChildren(el("h3", "", "Share with AnxNet"));
      if (!status?.network) {
        section.append(el("p", "anxnet-note", "AnxNet is AnxOS's own free private network: no port forwarding when a path exists, no third-party account. Create a network on the Computers page first."));
        section.append(button("Set up AnxNet", () => { document.querySelector("[data-share-server-close]")?.click(); showPage("nodes"); }));
        return;
      }
      const service = (status.services || []).find((entry) => entry.instanceId === instance.id && entry.local);
      const target = instanceTarget(instance);
      if (!service) {
        const managementPort = AnxShareHealth.getManagementPortName(target.port);
        if (managementPort) { section.append(el("p", "anxnet-error", `Port ${target.port} is used by ${managementPort}. AnxOS never shares management ports.`)); return; }
        if (!target.port) { section.append(el("p", "anxnet-note", "This server has no port to share yet.")); return; }
        section.append(el("p", "anxnet-note", `Invite only: devices in ${status.network.name} can join. Anyone can join: ordinary players without AnxNet, through your AnxNet gateway.`));
        const actions = el("div", "anxnet-actions");
        actions.append(button("Invite only", async () => {
          const ok = await createSecurityConfirmation({ title: `Share ${instance.displayName || instance.id} with ${status.network.name}?`, message: `Devices in your AnxNet network can reach port ${target.port} (${instanceProtocol(instance).toUpperCase()}) of this server. Nothing is opened to the internet.`, confirmLabel: "Share" });
          if (!ok) return;
          const shared = await run("Share", () => api().shareService({ name: instance.displayName || instance.id, port: target.port, protocol: instanceProtocol(instance), targetHost: target.host, targetPort: target.port, instanceId: instance.id }), "Shared with your AnxNet network.");
          if (shared) reopen();
        }, { primary: true }));
        actions.append(button("Anyone can join", () => showToast("First share it with your network (Invite only), then turn on Anyone can join.", "info"), { title: "Share with your network first" }));
        section.append(actions);
        return;
      }
      const host = status.devices.find((device) => device.self);
      section.append(el("p", "", `Invite only is on. Network members join at ${service.hostname}:${service.port}.`));
      section.append(el("p", "anxnet-note", `On their computers the game address is ${host.address}:${service.port} until private DNS is set up on them.`));
      const route = (status.publicRoutes || []).find((entry) => entry.serviceId === service.serviceId);
      const actions = el("div", "anxnet-actions");
      if (route) {
        section.append(el("p", "", `Anyone can join is on: ${route.publicHost}:${route.publicPort}.`));
        actions.append(button("Turn off Anyone can join", () => run("Stop public access", () => api().unpublishService(service.serviceId), "The public address is closed.").then(() => reopen())));
      } else {
        const gateway = status.network.gateways?.[0];
        actions.append(button("Anyone can join", async () => {
          if (!gateway) { showToast("Anyone can join needs an AnxNet gateway on a server with a public address. Add one in Computers > AnxNet > Relay and gateway, or use Playit below.", "warning"); return; }
          const ok = await createSecurityConfirmation({
            title: `Let anyone on the internet join ${instance.displayName || instance.id}?`,
            message: `Your AnxNet gateway at ${gateway.host} will forward a public port to port ${service.port} (${service.protocol.toUpperCase()}) of this server. Anyone who has the address can connect. Only this game port is shared.`,
            confirmLabel: "Open to everyone",
          });
          if (!ok) return;
          const game = typeof getInstanceAccessGameKind === "function" ? getInstanceAccessGameKind(instance) || "" : "";
          const published = await run("Publish", () => api().publishService(service.serviceId, { game }));
          if (!published) return;
          const test = published.test || {};
          const address = published.routes?.map((entry) => `${entry.publicHost}:${entry.publicPort} (${entry.protocol.toUpperCase()})`).join(", ");
          // "Friends can join" only after a real test reached the server.
          showToast(test.ok ? `Friends can join at ${address}. ${test.reason}` : `Public address ${address} is set up, but it isn't confirmed yet: ${test.reason || "not tested"}`, test.ok ? "success" : "warning");
          reopen();
        }, { disabled: false, title: gateway ? "" : "Needs an AnxNet gateway" }));
      }
      actions.append(button("Stop sharing", () => run("Stop sharing", () => api().unshareService(service.serviceId), "No longer shared through AnxNet.").then(() => reopen())));
      section.append(actions);
    }).catch(() => section.remove());
    return section;
  }

  if (panel) {
    timer = window.setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    refresh();
  }

  window.AnxNetUi = { refresh, render, createShareSection, _state: () => latest };
})();
