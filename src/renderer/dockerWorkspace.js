// Docker page layout (Phase 8). The Docker backend, its IPC and every control
// stay as they are; this module only arranges the page:
//   * one section at a time (Containers, Images, Volumes, Networks, Compose,
//     Create, Clean up) instead of everything stacked on one long page;
//   * shortcuts for the common jobs (create a container, view logs, manage
//     storage, view networks);
//   * the actions that work on one container (Start, Stop, Restart, Pause,
//     Resume, Kill, Remove, Logs, Terminal) move from the top toolbar into the
//     selected container's details panel, so it is clear what they act on.
//     The same button elements are moved, so their handlers and enable/disable
//     logic in app.js keep working; rows keep their own quick actions.
(function initializeDockerWorkspace(root) {
  "use strict";

  const SECTION_KEY = "anxos.docker.section.v1";
  const SECTIONS = [
    { id: "containers", label: "Containers" },
    { id: "images", label: "Images", heading: "Images", resource: "images" },
    { id: "volumes", label: "Storage (volumes)", heading: "Volumes", resource: "volumes" },
    { id: "networks", label: "Networks", heading: "Networks", resource: "networks" },
    { id: "compose", label: "Compose", heading: "Compose", resource: "compose" },
    { id: "create", label: "Create", heading: "Create Container" },
    { id: "cleanup", label: "Clean up", heading: "Cleanup" },
  ];
  const SHORTCUTS = [
    { label: "Create a container", section: "create" },
    { label: "View logs", section: "containers", logs: true },
    { label: "Manage storage", section: "volumes" },
    { label: "View networks", section: "networks" },
  ];
  const CONTAINER_ACTIONS = ["start", "stop", "restart", "pause", "unpause", "kill", "remove", "logs", "terminal"];

  function safe(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function page() {
    return document.querySelector('.page[data-page="docker"]');
  }

  function sectionElements(id) {
    const host = page();
    if (!host) return [];
    if (id === "containers") return [host.querySelector(".docker-toolbar"), host.querySelector(".docker-workspace")].filter(Boolean);
    const definition = SECTIONS.find((entry) => entry.id === id);
    return [...host.querySelectorAll(".docker-resource-panel")].filter((panel) => panel.querySelector("h3")?.textContent.trim() === definition?.heading);
  }

  function readSection() {
    const value = safe(() => root.localStorage.getItem(SECTION_KEY), "");
    return SECTIONS.some((entry) => entry.id === value) ? value : "containers";
  }

  function show(id, { focusLogs = false } = {}) {
    const host = page();
    if (!host) return;
    const active = SECTIONS.some((entry) => entry.id === id) ? id : "containers";
    SECTIONS.forEach((entry) => {
      sectionElements(entry.id).forEach((element) => element.classList.toggle("is-docker-section-hidden", entry.id !== active));
    });
    host.querySelector(".docker-resource-grid")?.classList.toggle("is-docker-single", active !== "containers");
    host.querySelectorAll("[data-docker-section]").forEach((button) => {
      const selected = button.dataset.dockerSection === active;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    safe(() => root.localStorage.setItem(SECTION_KEY, active), null);
    const definition = SECTIONS.find((entry) => entry.id === active);
    if (definition?.resource && safe(() => getActivePageName(), "") === "docker") safe(() => refreshDockerResources(definition.resource), null);
    if (focusLogs) host.querySelector('[data-docker-tab="logs"]')?.click();
  }

  function mount() {
    const host = page();
    if (!host || host.querySelector("[data-docker-sections]")) return;
    const shell = host.querySelector(".docker-shell");
    const summary = host.querySelector(".docker-summary-grid") || host.querySelector(".docker-summary-card")?.parentElement;
    if (!shell || !summary) return;

    const shortcuts = document.createElement("div");
    shortcuts.className = "docker-shortcuts";
    shortcuts.dataset.dockerShortcuts = "";
    shortcuts.setAttribute("aria-label", "Common Docker tasks");
    SHORTCUTS.forEach((shortcut) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "inline-action";
      button.textContent = shortcut.label;
      button.addEventListener("click", () => show(shortcut.section, { focusLogs: shortcut.logs === true }));
      shortcuts.append(button);
    });

    const strip = document.createElement("div");
    strip.className = "page-tabs docker-sections";
    strip.dataset.dockerSections = "";
    strip.setAttribute("role", "tablist");
    strip.setAttribute("aria-label", "Docker sections");
    SECTIONS.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "page-tabs__tab";
      button.dataset.dockerSection = entry.id;
      button.setAttribute("role", "tab");
      button.textContent = entry.label;
      button.addEventListener("click", () => show(entry.id));
      strip.append(button);
    });
    summary.after(shortcuts, strip);

    // Container actions: into the details panel, under its heading.
    const details = host.querySelector(".docker-details-panel");
    const heading = details?.querySelector(".panel-heading");
    const toolbarActions = host.querySelector(".docker-toolbar .docker-actions");
    if (details && heading && toolbarActions) {
      const actions = document.createElement("div");
      actions.className = "docker-details-actions";
      actions.dataset.dockerDetailsActions = "";
      actions.setAttribute("aria-label", "Actions for the selected container");
      CONTAINER_ACTIONS.forEach((action) => {
        const button = toolbarActions.querySelector(`[data-docker-action="${action}"]`);
        if (button) {
          if (action === "unpause") button.textContent = "Resume";
          if (action === "kill") button.title = "Stops the container immediately, without letting it shut down cleanly.";
          actions.append(button);
        }
      });
      heading.after(actions);
    }
    show(readSection());
  }

  root.AnxDockerWorkspace = { show, current: readSection };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})(typeof window !== "undefined" ? window : globalThis);
