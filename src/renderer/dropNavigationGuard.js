// Chromium's default for a file or link dropped on the page is to navigate the
// window to it. Only the registered drop zones accept drops (they cancel the
// event themselves); everywhere else the drop is refused so a near-miss on a
// drop zone never replaces the app with the dropped file. The main process
// also refuses such navigations; this keeps the cursor honest (no-drop).
(function installDropNavigationGuard(root) {
  "use strict";

  function dragTypes(event) {
    try {
      return Array.from(event?.dataTransfer?.types || []);
    } catch {
      return [];
    }
  }

  function isFileInput(target) {
    return String(target?.tagName || "").toUpperCase() === "INPUT" && String(target?.type || "").toLowerCase() === "file";
  }

  function isEditableTarget(target) {
    const tagName = String(target?.tagName || "").toUpperCase();
    if (tagName === "TEXTAREA" || tagName === "INPUT") return true;
    return Boolean(target?.isContentEditable);
  }

  function shouldRefuseDrop(event) {
    // A drop zone that accepted the drag has already cancelled it.
    if (!event || event.defaultPrevented) return false;
    const target = event.target;
    // Native file inputs handle file drops themselves.
    if (isFileInput(target)) return false;
    // Text and links dropped into a text field are inserted, not navigated to.
    if (isEditableTarget(target) && !dragTypes(event).includes("Files")) return false;
    return true;
  }

  function refuseDragOver(event) {
    if (!shouldRefuseDrop(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  }

  function refuseDrop(event) {
    if (shouldRefuseDrop(event)) event.preventDefault();
  }

  const doc = root?.document;
  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("dragover", refuseDragOver);
    doc.addEventListener("drop", refuseDrop);
  }
  if (root) root.AnxDropNavigationGuard = { shouldRefuseDrop };
})(typeof window !== "undefined" ? window : globalThis);
