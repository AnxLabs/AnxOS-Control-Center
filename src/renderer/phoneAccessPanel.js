// Phase 7: Phone access, in Security > Devices. Turn the phone gateway on or
// off, pair a phone with a QR code and a role, see paired phones and revoke
// them. All work happens in the main process (mobileGatewayService).
// Loaded after app.js, whose top-level functions are globals.
(function () {
  "use strict";

  const panel = document.querySelector("[data-phone-access-panel]");
  if (!panel) return;
  let latest = null;
  let pairing = null;
  let busy = false;
  let pairingTimer = null;

  const ROLE_TEXT = {
    Viewer: "Viewer: sees servers, computers, consoles and backups. Can't change anything.",
    Operator: "Operator: also starts, stops and restarts servers, and verifies backups.",
    Owner: "Owner: also sends console commands, edits settings and files, manages add-ons and restores backups.",
  };

  function api() {
    return getDesktopApiState().api?.mobile || null;
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
      return result;
    } catch (error) {
      showToast(error?.message || `${label} failed.`, "warning");
      return null;
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function refresh() {
    if (!api()) return;
    try {
      latest = unwrap(await api().status(), "Phone access status is unavailable.");
    } catch (error) {
      latest = { error: error.message };
    }
    // A used or cancelled code leaves no pending pairing behind.
    if (pairing && (Date.parse(pairing.expiresAt) <= Date.now() || latest.pendingPairings === 0)) pairing = null;
    render();
  }

  function when(value) {
    try {
      return typeof formatDateTime === "function" ? formatDateTime(value) : new Date(value).toLocaleString();
    } catch {
      return String(value || "");
    }
  }

  function timeLeft() {
    const left = Math.max(0, Math.round((Date.parse(pairing.expiresAt) - Date.now()) / 1000));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  }

  function renderPairing(container) {
    const box = el("div", "phone-pairing");
    if (pairing.qrDataUrl) {
      const image = el("img", "phone-pairing__qr");
      image.src = pairing.qrDataUrl;
      image.alt = "Pairing QR code. Scan it with your phone's camera.";
      box.append(image);
    }
    const text = el("div", "phone-pairing__text");
    const note = el("p");
    const countdown = el("span", "", timeLeft());
    countdown.dataset.phonePairingCountdown = "";
    note.append("This code works once and ends in ", countdown, ". Install the AnxOS certificate on the phone first (step 1), or the phone will warn that the connection isn't private.");
    text.append(el("strong", "", `Scan with your phone (${pairing.role})`), note);
    const linkRow = (link) => {
      const row = el("div", "phone-pairing__link");
      const code = el("code", "", link.replace(/#pair=.*/, "#pair=…"));
      row.append(code, button("Copy link", () => navigator.clipboard?.writeText(link).then(() => showToast("Pairing link copied. It works once.", "success"))));
      return row;
    };
    const [primary, ...others] = pairing.links || [];
    if (primary) text.append(linkRow(primary));
    // Other adapters (VPN, WSL, virtual machines) only if the first address
    // doesn't work from the phone.
    if (others.length) {
      const more = el("details", "phone-pairing__more");
      more.append(el("summary", "", `Other addresses on this computer (${others.length})`), ...others.map(linkRow));
      text.append(more);
    }
    text.append(button("Cancel", () => run("Cancel pairing", () => api().cancelPairings()).then(() => { pairing = null; render(); })));
    box.append(text);
    container.append(box);
  }

  function renderDevices(container) {
    const devices = latest.devices || [];
    const list = el("div", "phone-devices");
    list.setAttribute("role", "list");
    if (!devices.length) list.append(el("p", "settings-note", "No phones are paired."));
    devices.forEach((device) => {
      const row = el("div", "phone-device");
      row.setAttribute("role", "listitem");
      const info = el("div", "phone-device__info");
      info.append(
        el("strong", "", device.name),
        el("span", `status-pill phone-role phone-role--${device.role.toLowerCase()}`, device.role),
        el("small", "", `Paired ${when(device.createdAt)} · last used ${when(device.lastSeenAt)}${device.lastAddress ? ` from ${device.lastAddress}` : ""} · access ends ${when(device.expiresAt)} unless used`),
      );
      row.append(info, button("Remove", async () => {
        if (!(await confirmDestructiveAction({ title: `Remove ${device.name}?`, message: `${device.name} loses access to AnxOS immediately. You can pair it again later.`, confirmLabel: "Remove phone" }))) return;
        await run("Remove phone", () => api().revokeDevice(device.id), `${device.name} no longer has access.`);
      }, { danger: true }));
      list.append(row);
    });
    container.append(list);
    if (devices.length > 1) {
      container.append(button("Remove all phones", async () => {
        if (!(await confirmDestructiveAction({ title: "Remove all phones?", message: "Every paired phone loses access immediately.", confirmLabel: "Remove all" }))) return;
        await run("Remove all phones", () => api().revokeAll(), "All phones were removed.");
      }, { danger: true }));
    }
  }

  function render() {
    const draft = el("div", "phone-access");
    if (!latest) {
      draft.append(el("p", "settings-note", "Loading Phone access..."));
      panel.replaceChildren(draft);
      return;
    }
    if (latest.error && latest.enabled === undefined) {
      draft.append(el("p", "settings-note", latest.error));
      panel.replaceChildren(draft);
      return;
    }

    const state = el("div", "phone-access__state");
    const pill = el("span", `status-pill ${latest.running ? "status-pill--ok" : "status-pill--planned"}`, latest.running ? "On" : latest.enabled ? "Not running" : "Off");
    state.append(pill, latest.running
      ? button("Turn off", async () => {
        if (!(await confirmDestructiveAction({ title: "Turn off Phone access?", message: "Paired phones stay paired but can't reach AnxOS until you turn it back on.", confirmLabel: "Turn off" }))) return;
        await run("Turn off Phone access", () => api().disable(), "Phone access is off.");
      })
      : button("Turn on", () => run("Turn on Phone access", () => api().enable(), (result) => (result.running ? "Phone access is on." : result.error || "Phone access could not start.")), { primary: true }));
    draft.append(state);
    if (latest.error) draft.append(el("p", "settings-note settings-note--warning", latest.error));

    if (latest.running) {
      const where = el("p", "settings-note");
      where.textContent = latest.urls?.length
        ? `On your home network, phones open ${latest.urls[0]}${latest.urls.length > 1 ? ` (this computer has ${latest.urls.length - 1} other address${latest.urls.length === 2 ? "" : "es"}, listed when you pair)` : ""}. Only devices on your local network can connect; AnxOS never exposes this to the internet.`
        : "This computer has no local network address right now, so phones can't connect.";
      draft.append(where);

      const steps = el("ol", "phone-steps");
      const caStep = el("li");
      caStep.append(
        el("strong", "", "Install the AnxOS certificate on the phone (once). "),
        el("span", "", `Open ${latest.urls?.[0] || "the address above"}anxos-local-ca.crt on the phone, or save it here and send it to yourself. Then trust it: iPhone: Settings > Profile Downloaded > Install, then General > About > Certificate Trust Settings. Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate. Check that its fingerprint ends in ${String(latest.caFingerprint || "").slice(-11)}.`),
        button("Save certificate...", () => run("Save certificate", () => api().saveCaCertificate(), (result) => (result.canceled ? "Not saved." : `Saved to ${result.path}.`))),
      );
      const pairStep = el("li");
      pairStep.append(el("strong", "", "Pair the phone. "), el("span", "", "Choose what it may do, then scan the code."));
      const roles = el("div", "phone-roles");
      (latest.roles || ["Viewer", "Operator", "Owner"]).forEach((role) => {
        const option = el("div", "phone-role-option");
        option.append(
          button(`Pair as ${role}`, async () => {
            const result = await run("Pair a phone", () => api().createPairing(role));
            if (result) {
              pairing = result;
              render();
            }
          }, { primary: role === "Viewer" }),
          el("small", "", ROLE_TEXT[role] || ""),
        );
        roles.append(option);
      });
      pairStep.append(roles);
      steps.append(caStep, pairStep);
      draft.append(steps);
      if (pairing) renderPairing(draft);
      draft.append(el("p", "settings-note", "A phone never gets more than you choose here, and never more than the account signed in on this computer. Phones can't open SSH, run commands on this computer, change a server's start command or see saved credentials. Phone access only works while AnxOS is running and unlocked here."));
    } else {
      draft.append(el("p", "settings-note", "Phone access lets your phone check and manage your servers from the AnxOS web app on your home network. It's off until you turn it on."));
    }

    const heading = el("h3", "phone-access__heading", "Paired phones");
    draft.append(heading);
    renderDevices(draft);
    panel.replaceChildren(draft);
  }

  document.querySelector('[data-security-section-target="phone"]')?.addEventListener("click", () => refresh());
  try {
    api()?.onChanged?.(() => refresh());
  } catch {
    // Live updates are a convenience; the section refreshes when opened.
  }
  // Only the countdown text changes each second; the panel is redrawn when
  // the code expires, so buttons never move under the pointer.
  pairingTimer = setInterval(() => {
    if (!pairing) return;
    if (Date.parse(pairing.expiresAt) <= Date.now()) {
      pairing = null;
      render();
      return;
    }
    const countdown = panel.querySelector("[data-phone-pairing-countdown]");
    if (countdown) countdown.textContent = timeLeft();
  }, 1000);
  window.addEventListener("beforeunload", () => clearInterval(pairingTimer));
  refresh();
})();
