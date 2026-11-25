"use strict";

// Add Storage in the main window (Build 216-A8).
//
// Until Build 215 this was a separate window (windows/add-storage.html). Its
// script called window.desktopApi, a name the preload never exposed, so that
// window could not save, test, cancel or load the connection being edited.
// This dialog does the same work through the bridge the main window already
// uses (files.saveConnection and files.testConnection, the same IPC handlers
// and permission checks), and tells the Files page through the same handler
// the window's "saved" event used (handleStorageConnectionSaved).
//
// Secrets are only read from the form for the request itself; the form is
// cleared on every open and close, and nothing is logged.

(function addStorageDialog(root) {
  const modal = document.querySelector("[data-add-storage-modal]");
  if (!modal) return;
  const form = modal.querySelector("[data-add-storage-form]");
  const title = modal.querySelector("[data-add-storage-title]");
  const message = modal.querySelector("[data-add-storage-message]");
  const providerButtons = [...modal.querySelectorAll("[data-add-storage-provider]")];
  const fields = [...modal.querySelectorAll("[data-add-storage-field]")];
  const secretGroups = [...modal.querySelectorAll("[data-add-storage-secret]")];

  let provider = "sftp";
  let editingId = null;
  let busy = false;
  let deactivate = null;

  const api = () => (typeof getDesktopApi === "function" ? getDesktopApi() : root.anxos || null);
  // The app's own wording for IPC errors, not "Error invoking remote method".
  const errorText = (error, fallback) => (typeof normalizeIpcErrorMessage === "function" ? normalizeIpcErrorMessage(error, fallback) : error?.message || fallback);
  const field = (name) => modal.querySelector(`[data-add-storage-field="${name}"]`);

  function setMessage(text, tone = null) {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle("is-ok", tone === "ok");
    message.classList.toggle("is-warn", tone === "warn");
  }

  function setBusy(value) {
    busy = Boolean(value);
    form?.setAttribute("aria-busy", busy ? "true" : "false");
    modal.querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = busy; });
  }

  function syncAuthFields() {
    const authType = field("authType")?.value || "password";
    secretGroups.forEach((group) => {
      const kind = group.dataset.addStorageSecret;
      group.hidden = provider === "local" || (authType === "password" ? kind !== "password" : kind === "password");
    });
  }

  function setProvider(next) {
    provider = next === "local" ? "local" : "sftp";
    providerButtons.forEach((button) => {
      const active = button.dataset.addStorageProvider === provider;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    fields.forEach((input) => {
      const wrapper = input.closest(".settings-field");
      if (wrapper && input.dataset.addStorageField !== "name") wrapper.hidden = provider === "local";
    });
    syncAuthFields();
  }

  function clearForm() {
    editingId = null;
    fields.forEach((input) => {
      const name = input.dataset.addStorageField;
      if (name === "port") input.value = "22";
      else if (name === "authType") input.value = "password";
      else if (name === "rootDirectory") input.value = "/home/container";
      else input.value = "";
    });
    if (title) title.textContent = "Add Storage";
    setProvider("sftp");
    setMessage("Credentials are encrypted before being written to disk.");
  }

  function payload() {
    const result = { id: editingId, provider, type: provider };
    fields.forEach((input) => { result[input.dataset.addStorageField] = input.value; });
    if (provider === "local") result.name = result.name || "This Device";
    return result;
  }

  function open(connection = null) {
    clearForm();
    if (connection && connection.id && connection.id !== "local") {
      editingId = connection.id;
      if (title) title.textContent = "Edit Storage";
      setProvider(connection.provider || connection.type || "sftp");
      fields.forEach((input) => {
        const name = input.dataset.addStorageField;
        // Saved secrets are never sent back to the page; blank keeps them.
        if (["password", "privateKey", "passphrase"].includes(name)) return;
        if (connection[name] !== undefined && connection[name] !== null) input.value = connection[name];
      });
      setMessage("Leave password/key blank to keep the saved secret.");
      syncAuthFields();
    }
    modal.hidden = false;
    deactivate?.();
    deactivate = typeof activateModal === "function"
      ? activateModal(modal, { initialFocus: () => field("name") })
      : null;
  }

  function close() {
    if (busy) return;
    modal.hidden = true;
    deactivate?.();
    deactivate = null;
    clearForm();
  }

  async function save(event) {
    event?.preventDefault();
    const files = api()?.files;
    if (busy || !files?.saveConnection) {
      setMessage("File service is unavailable.", "warn");
      return;
    }
    setMessage("Saving storage...");
    setBusy(true);
    let saved = null;
    try {
      const result = await files.saveConnection(payload());
      saved = { connectionId: result?.connection?.id || editingId || null };
      setMessage("Storage saved.", "ok");
    } catch (error) {
      setMessage(errorText(error, "Storage connection could not be saved."), "warn");
    } finally {
      setBusy(false);
    }
    if (saved) {
      close();
      if (typeof handleStorageConnectionSaved === "function") {
        handleStorageConnectionSaved(saved).catch((error) => showToast?.(error?.message || "Storage list could not be refreshed."));
      }
    }
  }

  async function test() {
    const files = api()?.files;
    if (busy || !files?.testConnection) {
      setMessage("File service is unavailable.", "warn");
      return;
    }
    setMessage("Testing connection...");
    setBusy(true);
    try {
      const result = await files.testConnection(payload());
      setMessage(result?.message || "Connection verified.", "ok");
    } catch (error) {
      setMessage(errorText(error, "Connection test failed."), "warn");
    } finally {
      setBusy(false);
    }
  }

  providerButtons.forEach((button) => button.addEventListener("click", () => setProvider(button.dataset.addStorageProvider || "sftp")));
  form?.addEventListener("submit", save);
  modal.querySelector('[data-add-storage-action="test"]')?.addEventListener("click", test);
  modal.querySelectorAll('[data-add-storage-action="cancel"]').forEach((button) => button.addEventListener("click", close));
  field("authType")?.addEventListener("change", syncAuthFields);
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });

  clearForm();
  root.AnxAddStorageDialog = { open, close, isOpen: () => !modal.hidden };
})(window);
