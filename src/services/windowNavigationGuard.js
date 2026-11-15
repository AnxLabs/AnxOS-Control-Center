"use strict";

const { pathToFileURL } = require("url");

// Every app window loads preload.js, so whatever page it shows gets the full
// desktop bridge. A window may therefore only navigate to its own app page.
// Chromium navigates a window to anything dropped outside a drop zone (a local
// file, a UNC share, a dragged web link), and `file://` alone does not mean
// "our page". Query and hash are ignored because the app passes its surface
// and QA flags that way.

function normalizePagePath(pathname, platform) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Windows paths are case-insensitive and Chromium may change the drive
  // letter's case.
  return platform === "win32" ? decoded.toLowerCase() : decoded;
}

function toAllowedPagePaths(allowedPages = [], platform = process.platform) {
  return allowedPages
    .map((page) => normalizePagePath(pathToFileURL(page).pathname, platform))
    .filter(Boolean);
}

function isAllowedAppNavigation(targetUrl, allowedPages = [], { platform = process.platform } = {}) {
  let parsed;
  try {
    parsed = new URL(String(targetUrl || ""));
  } catch {
    return false;
  }
  // A host means a UNC share (file://server/share/...), never an app page.
  if (parsed.protocol !== "file:" || parsed.host) return false;
  const targetPath = normalizePagePath(parsed.pathname, platform);
  if (!targetPath) return false;
  return toAllowedPagePaths(allowedPages, platform).includes(targetPath);
}

function applyWindowNavigationGuard(webContents, options = {}) {
  const {
    allowedPages = [],
    openExternalUrl,
    openSource = "window-open",
    navigationSource = "window-navigation",
    platform = process.platform,
  } = options;
  const forwardExternal = (url, source) => {
    // openExternalUrl allows only http, https and mailto and logs the rest.
    if (typeof openExternalUrl !== "function") return;
    try {
      Promise.resolve(openExternalUrl(url, { source })).catch(() => {});
    } catch {}
  };

  webContents.setWindowOpenHandler(({ url } = {}) => {
    forwardExternal(url, openSource);
    return { action: "deny" };
  });

  webContents.on("will-navigate", (event, legacyUrl) => {
    const url = typeof legacyUrl === "string" ? legacyUrl : event?.url;
    if (isAllowedAppNavigation(url, allowedPages, { platform })) return;
    event.preventDefault();
    forwardExternal(url, navigationSource);
  });
}

module.exports = {
  applyWindowNavigationGuard,
  isAllowedAppNavigation,
};
