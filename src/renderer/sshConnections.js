// SSH: saved connections grouped by computer (Phase 8). The SSH page's own
// Server and Profile pickers only show profiles assigned to the selected
// computer (the SSH service refuses to connect a profile from another
// computer), so a profile saved for another computer used to be invisible.
// This list shows every saved connection under its computer: on the selected
// computer it fills the pickers; on another computer it offers to switch to
// that computer first. It never connects by itself (a password may be needed)
// and never shows credentials.
(function initializeSshConnections(root) {
  "use strict";

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

  function nodeName(nodeId) {
    if (!nodeId) return "Not assigned to a computer";
    const node = safe(() => (nodesState.nodes || []).find((entry) => entry.id === nodeId), null);
    return node ? node.displayName || node.name || node.id : "A removed computer";
  }

  function host() {
    return document.querySelector('.page[data-page="ssh"] .ssh-sidebar-panel');
  }

  function render() {
    const panel = host();
    if (!panel) return;
    let section = panel.querySelector("[data-ssh-saved]");
    if (!section) {
      section = el("section", "ssh-saved");
      section.dataset.sshSaved = "";
      const anchor = panel.querySelector(".ssh-connect-bar");
      if (anchor) anchor.before(section);
      else panel.append(section);
    }
    const profiles = safe(() => sshProfilesState.profiles, []) || [];
    const selectedNode = safe(() => getSelectedNodeId(), null);
    const draft = el("div");
    draft.append(el("h4", "", "Saved connections"));
    if (!profiles.length) {
      draft.append(el("p", "ssh-saved__empty", "No saved servers yet. Select New, enter the server's address and user name, and save it."));
    } else {
      const groups = new Map();
      profiles.forEach((profile) => {
        const key = profile.nodeId || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(profile);
      });
      // The selected computer first, then the others by name.
      const keys = [...groups.keys()].sort((a, b) => (a === selectedNode ? -1 : b === selectedNode ? 1 : nodeName(a).localeCompare(nodeName(b))));
      keys.forEach((key) => {
        const group = el("div", "ssh-saved__group");
        group.dataset.sshSavedComputer = key || "none";
        group.append(el("span", "ssh-saved__computer", `${nodeName(key)}${key === selectedNode ? " · this computer is selected" : ""}`));
        groups.get(key).forEach((profile) => {
          const row = el("div", "ssh-saved__row");
          row.dataset.sshSavedProfile = profile.id;
          const text = el("div", "ssh-saved__text");
          text.append(el("strong", "", profile.displayName || profile.host), el("span", "", `${profile.username}@${profile.host}:${profile.port || 22}`));
          const other = Boolean(key) && key !== selectedNode;
          const button = el("button", "inline-action", other ? "Switch" : "Use");
          button.type = "button";
          if (other) {
            button.title = `Switch to ${nodeName(key)} to use this connection`;
            button.setAttribute("aria-label", `Switch to ${nodeName(key)} and use ${profile.displayName || profile.host}`);
          }
          button.dataset.sshSavedUse = profile.id;
          row.append(text, button);
          group.append(row);
        });
        draft.append(group);
      });
    }
    section.replaceChildren(...draft.childNodes);
  }

  async function use(profileId) {
    const profile = (safe(() => sshProfilesState.profiles, []) || []).find((entry) => entry.id === profileId);
    if (!profile) return;
    if (profile.nodeId && profile.nodeId !== safe(() => getSelectedNodeId(), null)) {
      await safe(() => selectNode(profile.nodeId), Promise.resolve());
    }
    safe(() => {
      sshSelectedServerId = profile.serverId || null;
      sshSelectedProfileId = profile.id;
      activeSshSessionId = null;
      renderSshView();
    }, null);
    render();
  }

  function mount() {
    const panel = host();
    if (!panel || panel.dataset.sshSavedReady) return;
    panel.dataset.sshSavedReady = "true";
    panel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ssh-saved-use]");
      if (button) use(button.dataset.sshSavedUse);
    });
    render();
  }

  root.AnxSshConnections = { render, use };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})(typeof window !== "undefined" ? window : globalThis);
