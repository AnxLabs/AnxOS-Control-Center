// Drag-and-drop upload on the Files page (Phase 8). Files dropped on the list
// are uploaded one at a time to the folder being shown, on whatever is
// connected (this PC, a computer's Agent, or an SFTP server), through the
// page's own runFileMutation path, so they appear in Transfers and the list
// refreshes. Content goes as base64 and is written byte for byte. Names that
// already exist are listed in one confirmation before anything is replaced.
(function initializeFilesDrop(root) {
  "use strict";

  const MAX_BYTES = 100 * 1024 * 1024;
  let busy = false;

  function safe(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function zone() {
    const list = document.querySelector("[data-file-list]");
    return list ? list.closest(".docker-table-wrap, .file-table-wrap, section") || list.parentElement : null;
  }

  function connected() {
    return safe(() => filesConnectionState.connected, false) === true && safe(() => latestFilesListing, null);
  }

  function currentPath() {
    return safe(() => filesConnectionState.currentPath || filesConnectionState.homePath, "") || "/";
  }

  function hasFiles(event) {
    return [...(event.dataTransfer?.types || [])].includes("Files");
  }

  async function upload(files) {
    if (busy || !files.length) return;
    if (!connected()) {
      safe(() => showToast("Connect to a folder first, then drop files onto the list.", "warning"), null);
      return;
    }
    const tooLarge = files.filter((file) => file.size > MAX_BYTES);
    const usable = files.filter((file) => file.size <= MAX_BYTES);
    if (tooLarge.length) safe(() => showToast(`${tooLarge.map((file) => file.name).join(", ")} ${tooLarge.length === 1 ? "is" : "are"} over 100 MB; use Upload for large files.`, "warning"), null);
    if (!usable.length) return;
    const existing = new Set((safe(() => latestFilesListing.entries, []) || []).map((entry) => entry.name));
    const clashes = usable.filter((file) => existing.has(file.name));
    let replace = false;
    if (clashes.length) {
      replace = Boolean(await safe(() => createSecurityConfirmation({
        title: "Replace existing files?",
        message: `${clashes.map((file) => file.name).join(", ")} already ${clashes.length === 1 ? "exists" : "exist"} in ${currentPath()}. Replace ${clashes.length === 1 ? "it" : "them"}?`,
        confirmLabel: "Replace",
      }), Promise.resolve(false)));
      if (!replace) {
        safe(() => showToast("Nothing was uploaded, so no file was overwritten.", "warning"), null);
        return;
      }
    }
    busy = true;
    const folder = currentPath();
    let done = 0;
    try {
      for (const [index, file] of usable.entries()) {
        let content;
        try {
          content = await readFileAsBase64(file);
        } catch {
          safe(() => showToast(`${file.name} could not be read (folders can't be dropped).`, "warning"), null);
          continue;
        }
        const last = index === usable.length - 1;
        const result = await runFileMutation(
          "uploadContent",
          {
            profileId: getFilesRequestProfileId(),
            storageId: getFilesRequestStorageId(),
            directoryPath: folder,
            name: file.name,
            contentBase64: content,
            conflictPolicy: replace && existing.has(file.name) ? "replace" : "fail",
          },
          null,
          last ? folder : null,
          { filename: file.name, retryable: false },
        );
        if (result && result.uploaded) done += 1;
      }
    } finally {
      busy = false;
    }
    if (done) safe(() => showToast(`Uploaded ${done} ${done === 1 ? "file" : "files"} to ${folder}.`, "success"), null);
  }

  function mount() {
    const target = zone();
    if (!target || target.dataset.filesDropReady) return;
    target.dataset.filesDropReady = "true";
    target.dataset.filesDropZone = "";
    const hint = document.createElement("p");
    hint.className = "files-drop-hint";
    hint.textContent = "Drop files on the list to upload them to this folder.";
    target.after(hint);
    target.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = connected() ? "copy" : "none";
      target.classList.toggle("is-file-drop-target", Boolean(connected()));
    });
    target.addEventListener("dragleave", (event) => {
      if (!target.contains(event.relatedTarget)) target.classList.remove("is-file-drop-target");
    });
    target.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      target.classList.remove("is-file-drop-target");
      upload([...(event.dataTransfer?.files || [])]);
    });
  }

  root.AnxFilesDrop = { upload };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})(typeof window !== "undefined" ? window : globalThis);
