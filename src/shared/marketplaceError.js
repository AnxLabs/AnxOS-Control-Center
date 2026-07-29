(function attachMarketplaceErrorHelper(root, factory) {
  const helper = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = helper;
  }
  if (root) {
    root.marketplaceErrorHelper = helper;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createMarketplaceErrorHelper() {
  const IPC_PREFIX_PATTERN = /^\s*Error invoking remote method '[^']+':\s*/i;
  const ERROR_PREFIX_PATTERN = /^\s*Error:\s*/i;

  function stripIpcErrorWrapper(value) {
    let text = String(value || "").trim();
    let previous = "";

    while (text && text !== previous) {
      previous = text;
      text = text
        .replace(IPC_PREFIX_PATTERN, "")
        .replace(ERROR_PREFIX_PATTERN, "")
        .trim();
    }

    return text;
  }

  function getRawMessage(error) {
    return error?.payload?.error?.message || error?.message || String(error || "");
  }

  function buildDebugText(details, rawMessage, cleanMessage) {
    const explicit = details.debugMessage || details.originalMessage || "";
    const fields = {
      code: details.code || null,
      stage: details.stage || details.step || null,
      url: details.url || null,
      causeCode: details.causeCode || null,
      originalMessage: details.originalMessage || null,
      templateId: details.templateId || null,
      installerType: details.installerType || null,
      runtimeType: details.runtimeType || null,
    };
    const summary = Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${value}`)
      .join(" | ");
    return [explicit || rawMessage || cleanMessage, summary].filter(Boolean).join(" | ");
  }

  function getEffectiveCode(error, details, payloadError, cleanMessage) {
    const explicitCode = details.code || payloadError.code || error?.code || "";
    if (explicitCode && explicitCode !== "AGENT_HTTP_ERROR") {
      return explicitCode;
    }
    return String(cleanMessage || "").match(/\bcode=([A-Z][A-Z0-9_]{2,})\b/)?.[1]
      || String(cleanMessage || "").match(/\b(INSTANCE_[A-Z0-9_]+|INVALID_[A-Z0-9_]+)\b/)?.[1]
      || explicitCode;
  }

  function normalizeMarketplaceError(error = {}, context = {}) {
    const payloadError = error?.payload?.error || {};
    const details = error?.details || payloadError.details || {};
    const rawMessage = getRawMessage(error);
    const cleanMessage = stripIpcErrorWrapper(rawMessage);
    const code = getEffectiveCode(error, details, payloadError, cleanMessage);
    const friendlyMessage = details.friendlyMessage || payloadError.friendlyMessage || error?.friendlyMessage || "";
    const file = details.file || details.fileName || details.name || null;
    const provider = details.provider || payloadError.provider || error?.provider || "";
    const providerName = details.providerName || (provider ? String(provider).replace(/^./, (letter) => letter.toUpperCase()) : "Provider");
    const projectId = details.projectId || details.projectID || null;
    const fileId = details.fileId || details.fileID || null;
    const suggestion = details.suggestion || "";
    const expectedFileName = details.expectedFileName || payloadError.expectedFileName || null;
    const actualFileName = details.actualFileName || payloadError.actualFileName || null;
    const manualRequired = [
      "PROVIDER_REQUIRED_FILE_RESTRICTED",
      "PROVIDER_MANUAL_DOWNLOAD_REQUIRED",
      "CURSEFORGE_REQUIRED_FILE_RESTRICTED",
      "MODRINTH_REQUIRED_FILE_RESTRICTED",
      "CURSEFORGE_DOWNLOAD_URL_MISSING",
      "CURSEFORGE_INVALID_DOWNLOAD_URL",
      "CURSEFORGE_UNSAFE_URL",
      "CURSEFORGE_DOWNLOAD_FAILED",
      "CURSEFORGE_REQUEST_FAILED",
      "MODRINTH_DOWNLOAD_URL_MISSING",
      "MODRINTH_INVALID_DOWNLOAD_URL",
      "MODRINTH_UNSAFE_URL",
      "MODRINTH_DOWNLOAD_FAILED",
      "MODRINTH_REQUEST_FAILED",
      "PROVIDER_DOWNLOAD_URL_MISSING",
      "PROVIDER_DOWNLOAD_FAILED",
      "PROVIDER_REQUEST_FAILED",
    ].includes(code) ||
      details.recoveryState === "waiting-manual-download" ||
      /CurseForge blocked one required server file/i.test(cleanMessage) ||
      /required modpack file needs manual download/i.test(cleanMessage) ||
      /download url/i.test(cleanMessage) ||
      /required server file is restricted/i.test(cleanMessage);

    if (manualRequired) {
      return {
        code: "PROVIDER_MANUAL_DOWNLOAD_REQUIRED",
        originalCode: code || details.originalCode || null,
        title: "A required modpack file needs manual download.",
        body: friendlyMessage || "This provider does not allow AnxOS to download one required file automatically.",
        action: suggestion,
        provider,
        providerName,
        file,
        projectId,
        fileId,
        sessionId: details.sessionId || null,
        manualDownload: details.manualDownload || null,
        rawMessage,
        cleanMessage,
        debug: buildDebugText(details, rawMessage, cleanMessage),
        details,
      };
    }

    if ([
      "PROVIDER_IMPORT_FILE_NAME_MISMATCH",
      "PROVIDER_IMPORT_FILE_SIZE_MISMATCH",
      "PROVIDER_IMPORT_FILE_HASH_MISMATCH",
      "PROVIDER_MANUAL_FILE_NOT_IMPORTED",
      "PROVIDER_MANUAL_SESSION_NOT_FOUND",
      "PROVIDER_PAGE_UNAVAILABLE",
    ].includes(code)) {
      const titleMap = {
        PROVIDER_IMPORT_FILE_NAME_MISMATCH: "Selected file name does not match.",
        PROVIDER_IMPORT_FILE_SIZE_MISMATCH: "Selected file size does not match.",
        PROVIDER_IMPORT_FILE_HASH_MISMATCH: "Selected file hash does not match.",
        PROVIDER_MANUAL_FILE_NOT_IMPORTED: "Import the required file first.",
        PROVIDER_MANUAL_SESSION_NOT_FOUND: "Manual download session not found.",
        PROVIDER_PAGE_UNAVAILABLE: "Official provider page is unavailable.",
      };
      const bodyMap = {
        PROVIDER_IMPORT_FILE_NAME_MISMATCH: expectedFileName && actualFileName
          ? `Expected ${expectedFileName}, but you selected ${actualFileName}.`
          : "Select the matching file and try again.",
        PROVIDER_IMPORT_FILE_SIZE_MISMATCH: "The selected file size does not match the provider metadata.",
        PROVIDER_IMPORT_FILE_HASH_MISMATCH: "The selected file hash does not match the provider metadata.",
        PROVIDER_MANUAL_FILE_NOT_IMPORTED: "Import the missing file before resuming the installation.",
        PROVIDER_MANUAL_SESSION_NOT_FOUND: "The manual download session is no longer available.",
        PROVIDER_PAGE_UNAVAILABLE: "Open the provider page from the project listing and retry.",
      };
      return {
        code,
        originalCode: details.originalCode || null,
        title: titleMap[code] || friendlyMessage || cleanMessage || "Marketplace install failed.",
        body: bodyMap[code] || friendlyMessage || cleanMessage || "Marketplace install failed.",
        action: suggestion,
        provider,
        providerName,
        file,
        projectId,
        fileId,
        sessionId: details.sessionId || null,
        manualDownload: details.manualDownload || null,
        rawMessage,
        cleanMessage,
        debug: buildDebugText(details, rawMessage, cleanMessage),
        details,
      };
    }

    const friendlyFailures = {
      INSTANCE_ALREADY_EXISTS: {
        title: "A server with this name already exists.",
        body: "Choose a different server name, then retry the deployment.",
        action: "Return to Review and update the server name.",
      },
      INVALID_INSTANCE_ID: {
        title: "This server name cannot be used.",
        body: "Use a name with letters, numbers, spaces, underscores, or dashes.",
        action: "Return to Review and update the server name.",
      },
      MINECRAFT_PORT_IN_USE: {
        title: "The selected Minecraft port is already in use.",
        body: "Choose another available port, then retry the deployment.",
        action: "Return to Review and update the port.",
      },
    };
    if (friendlyFailures[code]) {
      return {
        code,
        ...friendlyFailures[code],
        provider,
        providerName,
        file,
        projectId,
        fileId,
        rawMessage,
        cleanMessage,
        debug: buildDebugText({ ...details, code }, rawMessage, cleanMessage),
        details,
      };
    }

    const title = friendlyMessage || cleanMessage || context.fallback || "Marketplace install failed.";
    const action = suggestion || details.userMessage || "Review the technical details, fix the reported install stage, then retry.";
    return {
      code: code || "MARKETPLACE_INSTALL_FAILED",
      title,
      body: title,
      action,
      provider,
      providerName,
      file,
      projectId,
      fileId,
      rawMessage,
      cleanMessage,
      debug: buildDebugText(details, rawMessage, cleanMessage),
      details,
    };
  }

  return {
    normalizeMarketplaceError,
    stripIpcErrorWrapper,
  };
});
