// Phase 5 Add-ons tab: find, install, update and manage a Minecraft server's
// plugins or mods. All file work happens in the main process
// (src/services/modManagerService.js); this file draws the tab and asks for
// changes. Longer jobs are recorded in Activity through the existing
// operations store. Loaded after app.js, whose top-level functions are globals.
(function () {
  "use strict";

  const Model = window.AnxServerViewModel;
  const panel = document.querySelector("[data-addons]");
  const PROVIDER_KEY = "anxos.addons.provider.v1";
  if (!panel || !Model) return;

  const $ = (selector) => panel.querySelector(selector);
  let state = freshState(null);

  function freshState(instanceId) {
    let provider = "modrinth";
    try { provider = window.localStorage.getItem(PROVIDER_KEY) === "curseforge" ? "curseforge" : "modrinth"; } catch {}
    return { instanceId, list: null, updates: new Map(), results: [], provider, plan: null, busy: "", loading: false, lastSearch: "" };
  }

  function api() {
    return getDesktopApiState().api?.instances?.mods || null;
  }

  function unwrap(result, fallback) {
    if (result && result.ok === false) {
      throw Object.assign(new Error(result.error?.message || fallback), { code: result.error?.code });
    }
    return result;
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
    node.disabled = Boolean(state.busy) || options.disabled === true;
    if (options.title) node.title = options.title;
    node.addEventListener("click", onClick);
    return node;
  }

  function icon(url, name) {
    const box = el("span", "addon-icon");
    if (url && /^https:\/\/(cdn\.modrinth\.com|media\.forgecdn\.net)\//.test(url)) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => { image.remove(); box.textContent = String(name || "?").charAt(0).toUpperCase(); });
      box.append(image);
    } else {
      box.textContent = String(name || "?").charAt(0).toUpperCase();
    }
    return box;
  }

  function providerLabel(id) {
    return id === "curseforge" ? "CurseForge" : id === "modrinth" ? "Modrinth" : "Added by hand";
  }

  function instance() {
    return findInstance();
  }

  function support(target = instance()) {
    return Model.describeAddonSupport(target || {}, { isMinecraft: Boolean(target) && isMinecraftInstance(target) });
  }

  function nounFor(target = instance()) {
    return support(target).kind === "mods" ? "mod" : "plugin";
  }

  // ---- jobs ------------------------------------------------------------------

  async function runJob(label, activityTitle, work) {
    const target = instance();
    if (!target || state.busy) return null;
    state.busy = label;
    render();
    const operationId = typeof startOperation === "function"
      ? startOperation({ type: "Add-on", title: activityTitle, target: target.displayName || target.id, step: label })
      : null;
    try {
      const result = await work(target, getNodeScopedPayload(createNodeActionContext("instance-addons")));
      if (operationId) finishOperation(operationId, true, "Done");
      if (result?.restartRequired) window.AnxServerView?.markRestartRequired(target.id, "add-on changes");
      return result;
    } catch (error) {
      const message = getAgentErrorMessage(error, "The add-on change failed.");
      if (operationId) finishOperation(operationId, false, message);
      showToast(message, "warning");
      return null;
    } finally {
      state.busy = "";
      render();
    }
  }

  // ---- loading ---------------------------------------------------------------

  async function refresh() {
    const target = instance();
    if (!target) return;
    if (state.instanceId !== target.id) state = freshState(target.id);
    const info = support(target);
    if (!info.supported || !api()) {
      render();
      return;
    }
    state.loading = true;
    render();
    const requestContext = createNodeActionContext("instance-addons-list");
    try {
      const result = unwrap(await api().list(target.id, getNodeScopedPayload(requestContext)), "Add-ons could not be loaded.");
      if (!isNodeRequestCurrent(requestContext) || findInstance()?.id !== target.id) return;
      state.list = result;
      const curseforge = (result.providers || []).find((provider) => provider.id === "curseforge");
      if (state.provider === "curseforge" && curseforge && !curseforge.available) state.provider = "modrinth";
    } catch (error) {
      state.list = null;
      showToast(getAgentErrorMessage(error, "Add-ons could not be loaded."), "warning");
    } finally {
      state.loading = false;
      render();
    }
  }

  async function search(event) {
    event?.preventDefault();
    const target = instance();
    if (!target || state.busy) return;
    const query = String($("[data-mods-search-input]")?.value || "").trim();
    state.busy = "Searching…";
    state.plan = null;
    render();
    try {
      const result = unwrap(await api().search(target.id, query, { ...getNodeScopedPayload(createNodeActionContext("instance-addons-search")), provider: state.provider }), "Search failed.");
      state.results = Array.isArray(result?.hits) ? result.hits : [];
      state.lastSearch = query;
    } catch (error) {
      state.results = [];
      showToast(getAgentErrorMessage(error, "Search failed."), "warning");
    } finally {
      state.busy = "";
      render();
    }
  }

  // ---- install plan ------------------------------------------------------------

  async function openPlan(project) {
    const target = instance();
    if (!target || state.busy) return;
    state.busy = `Checking ${project.name}…`;
    state.plan = null;
    render();
    try {
      const plan = unwrap(await api().plan(target.id, String(project.id), { ...getNodeScopedPayload(createNodeActionContext("instance-addons-plan")), provider: project.provider || state.provider }), "The add-on could not be checked.");
      state.plan = { ...plan, forId: String(project.id) };
    } catch (error) {
      state.plan = { forId: String(project.id), error: getAgentErrorMessage(error, "The add-on could not be checked.") };
    } finally {
      state.busy = "";
      render();
    }
  }

  async function confirmInstall() {
    const plan = state.plan;
    if (!plan || !plan.canInstall) return;
    const names = [plan.project.name, ...plan.dependencies.map((dependency) => dependency.name)];
    const result = await runJob(`Installing ${plan.project.name}…`, `Install ${plan.project.name}`, (target, payload) => api().install(target.id, plan.project.projectId, {
      ...payload,
      provider: plan.provider,
      approvedDependencies: plan.dependencies.map((dependency) => dependency.projectId),
    }).then((value) => unwrap(value, "Install failed.")));
    if (!result) return;
    state.plan = null;
    showToast(`Installed ${names.join(", ")}.${result.restartRequired ? " Restart the server to load it." : " It loads the next time the server starts."}`, "success");
    await refresh();
  }

  // ---- installed actions ----------------------------------------------------------

  async function change(kind, mod) {
    if (kind === "remove") {
      const ok = await createSecurityConfirmation({
        title: `Remove ${mod.title}?`,
        message: `${mod.fileName} is taken out of the server. AnxOS keeps a copy in the add-on backups folder in case you want it back.`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }
    const verbs = { update: "Updating", toggle: mod.enabled ? "Disabling" : "Enabling", remove: "Removing", rollback: "Rolling back" };
    const titles = { update: "Update", toggle: mod.enabled ? "Disable" : "Enable", remove: "Remove", rollback: "Roll back" };
    const result = await runJob(`${verbs[kind]} ${mod.title}…`, `${titles[kind]} ${mod.title}`, async (target, payload) => {
      if (kind === "update") return unwrap(await api().update(target.id, mod.fileName, payload), "Update failed.");
      if (kind === "toggle") return unwrap(await api().setEnabled(target.id, mod.fileName, !mod.enabled, payload), "The change failed.");
      if (kind === "remove") return unwrap(await api().remove(target.id, mod.fileName, mod.enabled, payload), "Remove failed.");
      return unwrap(await api().rollback(target.id, mod.fileName, payload), "Roll back failed.");
    });
    if (!result) return;
    if (kind === "update") state.updates.delete(mod.fileName);
    const messages = {
      update: result.updated === false ? `${mod.title} is already up to date.` : `${mod.title} updated. The previous version is kept so you can roll back.`,
      toggle: `${mod.title} ${mod.enabled ? "disabled" : "enabled"}.`,
      remove: `${mod.title} removed.`,
      rollback: `${mod.title} is back on its previous version.`,
    };
    showToast(messages[kind], "success");
    await refresh();
  }

  async function checkUpdates() {
    const result = await runJob("Checking for updates…", "Check add-on updates", async (target, payload) => unwrap(await api().checkUpdates(target.id, payload), "Update check failed."));
    if (!result) return;
    state.updates = new Map((result.updates || []).map((update) => [update.fileName, update]));
    showToast(state.updates.size ? `${state.updates.size} update${state.updates.size === 1 ? "" : "s"} available.` : "Everything installed through AnxOS is up to date.", state.updates.size ? "warning" : "success");
    render();
  }

  async function updateAll() {
    const result = await runJob("Updating add-ons…", "Update all add-ons", async (target, payload) => unwrap(await api().updateAll(target.id, payload), "Update failed."));
    if (!result) return;
    state.updates = new Map();
    const failed = result.failed || [];
    showToast(`${result.updated?.length || 0} updated${failed.length ? `, ${failed.length} couldn't be updated (${failed.map((entry) => entry.title).join(", ")})` : ""}.`, failed.length ? "warning" : "success");
    await refresh();
  }

  async function importFile(file) {
    if (!file) return;
    if (!/\.jar$/i.test(file.name)) {
      showToast("Choose a .jar file.", "warning");
      return;
    }
    if (file.size > 64 * 1024 * 1024) {
      showToast("That file is larger than 64 MB.", "warning");
      return;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode.apply(null, buffer.subarray(index, index + 0x8000));
    const result = await runJob(`Importing ${file.name}…`, `Import ${file.name}`, async (target, payload) => unwrap(await api().importFile(target.id, file.name, window.btoa(binary), payload), "Import failed."));
    if (!result) return;
    const known = result.identifiedAs ? ` Recognised as ${result.identifiedAs.name} ${result.identifiedAs.versionNumber}, so it can be updated here.` : "";
    showToast(`${result.fileName} imported.${known}`, "success");
    if (result.compatibilityWarning) showToast(result.compatibilityWarning, "warning");
    await refresh();
  }

  // ---- rendering ----------------------------------------------------------------------

  function renderInstalled(list, mods) {
    const items = mods.map((mod) => {
      const update = state.updates.get(mod.fileName);
      const item = el("li", `addon-row${mod.enabled ? "" : " is-disabled"}`);
      const text = el("div", "addon-row__text");
      const title = el("strong", "", mod.title);
      const meta = el("span", "addon-row__meta", [
        mod.versionNumber,
        providerLabel(mod.provider),
        mod.dependencyOf ? "required by another add-on" : null,
        mod.enabled ? null : "disabled",
      ].filter(Boolean).join(" · "));
      text.append(title, meta);
      if (update) text.append(el("span", "addon-row__update", `Update available: ${update.latestVersion}`));
      const actions = el("div", "addon-row__actions");
      if (update) actions.append(button("Update", () => change("update", mod), { primary: true }));
      if (mod.canRollBack) actions.append(button("Roll back", () => change("rollback", mod), { title: "Go back to the version before the last update." }));
      actions.append(button(mod.enabled ? "Disable" : "Enable", () => change("toggle", mod)));
      if (mod.projectUrl) {
        const link = el("a", "inline-action", "Page");
        link.href = mod.projectUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        actions.append(link);
      }
      actions.append(button("Remove", () => change("remove", mod), { danger: true }));
      item.append(icon(mod.iconUrl, mod.title), text, actions);
      item.title = mod.fileName;
      return item;
    });
    list.replaceChildren(...items);
  }

  function renderPlan(plan) {
    const box = el("div", "addon-plan");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Install plan");
    if (plan.error) {
      box.classList.add("is-blocked");
      box.append(el("p", "", plan.error));
      box.append(button("Close", () => { state.plan = null; render(); }));
      return box;
    }
    box.append(el("strong", "addon-plan__title", `Install ${plan.project.name} ${plan.project.versionNumber}`));
    box.append(el("p", "addon-plan__where", `Goes into ${plan.folder}/ for ${plan.software} ${plan.minecraftVersion}.`));
    if (plan.dependencies.length) {
      box.append(el("p", "", `${plan.project.name} also needs:`));
      const deps = el("ul", "addon-plan__list");
      plan.dependencies.forEach((dependency) => deps.append(el("li", "", `${dependency.name} ${dependency.versionNumber}`)));
      box.append(deps);
    }
    [...plan.problems, ...plan.conflicts].forEach((problem) => box.append(el("p", "addon-plan__problem", `${problem.name}: ${problem.reason}`)));
    if (plan.restartRequired && plan.canInstall) box.append(el("p", "addon-plan__note", "The server is running. The add-on loads after a restart."));
    const actions = el("div", "addon-plan__actions");
    if (plan.canInstall) actions.append(button(plan.dependencies.length ? `Install all ${plan.dependencies.length + 1}` : "Install", confirmInstall, { primary: true }));
    else box.classList.add("is-blocked");
    actions.append(button("Cancel", () => { state.plan = null; render(); }));
    box.append(actions);
    return box;
  }

  function renderResults(list, installedIds) {
    const items = state.results.map((project) => {
      const item = el("li", "addon-row addon-row--result");
      const text = el("div", "addon-row__text");
      text.append(el("strong", "", project.name), el("span", "addon-row__meta", [project.author, `${Number(project.downloads || 0).toLocaleString()} downloads`, providerLabel(project.provider)].filter(Boolean).join(" · ")));
      if (project.description) text.append(el("span", "addon-row__desc", project.description));
      const installed = installedIds.has(`${project.provider}:${project.id}`);
      const actions = el("div", "addon-row__actions");
      actions.append(button(installed ? "Installed" : "Install", () => openPlan(project), { primary: !installed, disabled: installed }));
      item.append(icon(project.iconUrl, project.name), text, actions);
      if (state.plan && state.plan.forId === String(project.id)) item.append(renderPlan(state.plan));
      return item;
    });
    list.replaceChildren(...items);
    if (!state.results.length && state.lastSearch !== "" && !state.busy) list.replaceChildren(el("li", "addons-empty", `Nothing compatible found for "${state.lastSearch}".`));
  }

  function render() {
    const target = instance();
    const info = support(target);
    const noun = nounFor(target);
    const status = $("[data-mods-status]");
    const title = $("[data-mods-title]");
    const description = $("[data-mods-description]");
    const unsupported = $("[data-addons-unsupported]");
    const body = $("[data-addons-body]");
    if (title) title.textContent = info.kind === "mods" ? "Mods" : info.kind === "plugins" ? "Plugins" : "Add-ons";
    if (unsupported) {
      unsupported.hidden = info.supported;
      unsupported.textContent = info.supported ? "" : info.reason;
    }
    if (body) body.hidden = !info.supported;
    const list = state.instanceId === target?.id ? state.list : null;
    const mods = list?.mods || [];
    if (description) {
      description.textContent = list
        ? `${info.label} for Minecraft ${list.minecraftVersion}, kept in ${list.folder}/.`
        : info.supported ? `${info.label} for this server.` : "";
    }
    if (status) {
      status.textContent = state.loading ? "Loading…" : state.busy ? "Working…" : list ? `${mods.length} ${noun}${mods.length === 1 ? "" : "s"}${state.updates.size ? ` · ${state.updates.size} update${state.updates.size === 1 ? "" : "s"}` : ""}` : "Not loaded";
    }
    const job = $("[data-addons-job]");
    if (job) {
      job.hidden = !state.busy;
      job.textContent = state.busy;
    }
    if (!info.supported) return;

    const empty = $("[data-mods-empty]");
    if (empty) empty.hidden = mods.length > 0 || !list;
    const installedList = $("[data-mods-installed]");
    if (installedList) renderInstalled(installedList, mods);
    const updateAllButton = $('[data-mods-action="update-all"]');
    if (updateAllButton) {
      updateAllButton.hidden = state.updates.size === 0;
      updateAllButton.textContent = `Update all (${state.updates.size})`;
    }
    panel.querySelectorAll("[data-mods-action]").forEach((node) => { node.disabled = Boolean(state.busy) || !list; });

    const warnings = $("[data-addons-warnings]");
    if (warnings) {
      const items = list?.warnings || [];
      warnings.hidden = items.length === 0;
      warnings.replaceChildren(...items.map((warning) => el("p", "", `${warning.title} needs ${warning.missing}, which is no longer installed.`)));
    }

    const history = $("[data-addons-history]");
    const historyList = $("[data-addons-history-list]");
    if (history && historyList) {
      const entries = list?.history || [];
      history.hidden = entries.length === 0;
      const verbs = { install: "Installed", update: "Updated", remove: "Removed", enable: "Enabled", disable: "Disabled", rollback: "Rolled back", import: "Imported" };
      historyList.replaceChildren(...entries.slice(0, 20).map((entry) => {
        const item = el("li", "", `${verbs[entry.action] || entry.action} ${entry.title}${entry.versionNumber ? ` ${entry.from ? `${entry.from} → ` : ""}${entry.versionNumber}` : ""}`);
        const when = Date.parse(entry.at || "");
        if (Number.isFinite(when)) item.append(el("time", "", new Date(when).toLocaleString()));
        return item;
      }));
    }

    const providers = list?.providers || [];
    panel.querySelectorAll("[data-addons-provider]").forEach((node) => {
      const id = node.dataset.addonsProvider;
      const entry = providers.find((provider) => provider.id === id);
      node.setAttribute("aria-checked", id === state.provider ? "true" : "false");
      node.classList.toggle("is-active", id === state.provider);
      node.disabled = Boolean(state.busy);
      node.title = entry && !entry.available ? entry.reason : "";
      node.classList.toggle("is-unavailable", Boolean(entry && !entry.available));
    });
    const note = $("[data-addons-provider-note]");
    const curseforge = providers.find((provider) => provider.id === "curseforge");
    if (note) {
      const showNote = state.provider === "curseforge" || (curseforge && !curseforge.available);
      note.hidden = !showNote || (curseforge?.available && state.provider !== "curseforge");
      note.textContent = curseforge && !curseforge.available
        ? curseforge.reason
        : "Some CurseForge authors only allow downloads on CurseForge's website. AnxOS shows those as unavailable rather than working around it; download them there and use Import a file.";
    }
    const results = $("[data-mods-results]");
    const installedIds = new Set(mods.filter((mod) => mod.provider).map((mod) => `${mod.provider}:${mod.projectId}`));
    if (results) renderResults(results, installedIds);
  }

  // ---- events -------------------------------------------------------------------------

  $("[data-addons-search-form]")?.addEventListener("submit", search);
  panel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-mods-action]");
    if (action && !action.disabled) {
      if (action.dataset.modsAction === "check-updates") checkUpdates();
      else if (action.dataset.modsAction === "update-all") updateAll();
      else if (action.dataset.modsAction === "import") $("[data-addons-import-input]")?.click();
      return;
    }
    const provider = event.target.closest("[data-addons-provider]");
    if (provider && !provider.disabled) {
      const entry = (state.list?.providers || []).find((item) => item.id === provider.dataset.addonsProvider);
      if (entry && !entry.available) {
        state.provider = entry.id;
        state.results = [];
        state.plan = null;
        render();
        return;
      }
      state.provider = provider.dataset.addonsProvider === "curseforge" ? "curseforge" : "modrinth";
      try { window.localStorage.setItem(PROVIDER_KEY, state.provider); } catch {}
      state.results = [];
      state.plan = null;
      state.lastSearch = "";
      render();
    }
  });
  $("[data-addons-import-input]")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    importFile(file);
  });
  // Keyboard: arrow keys move between the two provider buttons.
  $("[data-addons-providers]")?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const buttons = [...panel.querySelectorAll("[data-addons-provider]")];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    next.focus();
    next.click();
  });

  window.AnxAddons = { refresh, render, _state: () => state };
})();
