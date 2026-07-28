const {
  beginInstallationSession,
  beginSteamCmdUpdateSession,
  repairLegacySteamCmdMetadata,
  cancelInstallationSession,
  clearLogs,
  closeInstallationSession,
  createInstance,
  createInstanceFolder,
  deleteInstance,
  deleteInstanceFile,
  duplicateInstance,
  executeInstallationPhase,
  executeSteamCmdUpdate,
  forgetInstance,
  forceKillInstance,
  readGameServerConfig,
  getMetrics,
  getStatus,
  instanceFileExists,
  listInstanceFiles,
  listInstances,
  readInstanceFile,
  readLogs,
  readMinecraftProperties,
  repairNeoForgeRuntime,
  refreshFiveMReadiness,
  renameInstance,
  renameInstanceFile,
  restartInstance,
  saveFiveMLicenseKey,
  writeGameServerConfig,
  startInstance,
  stopInstance,
  updateInstance,
  writeInstanceFile,
  writeInstanceInput,
  writeMinecraftProperties,
} = require("../services/instances/instanceService");

function parseJsonBody(request) {
  if (!request.body) {
    return {};
  }

  try {
    return JSON.parse(request.body);
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    error.statusCode = 400;
    throw error;
  }
}

function result(statusCode, body) {
  return {
    statusCode,
    body,
  };
}

function errorResult(error) {
  const validation = getValidationErrorDetails(error);
  const runtimeDetails = getRuntimeErrorDetails(error);
  return result(error.statusCode || 500, {
    error: {
      code: error.code || "INSTANCE_REQUEST_FAILED",
      message: error.message && error.message !== error.code
        ? error.message
        : validation?.userMessage || "Request failed.",
      details: validation || runtimeDetails || (error.result ? { result: error.result } : undefined),
    },
  });
}

function getRuntimeErrorDetails(error) {
  if (/^(?:INSTALLER_|INSTALLATION_)/.test(String(error?.code || ""))) {
    return {
      code: error.code,
      operationId: error.operationId || null,
      installerFamily: error.installerFamily || null,
      phase: error.phase || null,
      installationState: error.installationState || null,
      exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null,
      signal: error.signal || null,
      timeoutMs: Number.isFinite(error.timeoutMs) ? error.timeoutMs : null,
      durationMs: Number.isFinite(error.durationMs) ? error.durationMs : null,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
      causeCode: error.causeCode || null,
    };
  }
  if (error?.code === "JAVA_RUNTIME_REQUIRED" || error?.code === "JAVA_RUNTIME_OVERRIDE_INVALID") {
    return {
      code: error.code,
      requiredMajor: error.requiredMajor || null,
      detectedMajors: Array.isArray(error.detectedMajors) ? error.detectedMajors : [],
      dependencyId: error.dependencyId || "java",
      userMessage: error.message,
      suggestion: error.suggestion || "Open Dependencies and install or repair the required Java runtime, then retry.",
    };
  }
  if (error?.code === "INSTANCE_ALREADY_RUNNING") {
    return {
      code: error.code,
      state: error.state || "ALREADY_RUNNING",
      pid: error.pid || error.runtime?.pid || error.instance?.pid || null,
      runtime: error.runtime ? {
        pid: error.runtime.pid || null,
        ppid: error.runtime.ppid || null,
        processName: error.runtime.processName || null,
        executablePath: error.runtime.executablePath || null,
        workingDirectory: error.runtime.workingDirectory || null,
        ports: Array.isArray(error.runtime.ports) ? error.runtime.ports : [],
        detectionMethod: error.runtime.detectionMethod || null,
      } : undefined,
      userMessage: "This instance is already running.",
      suggestion: "Refresh the instance list or stop the running server before starting it again.",
    };
  }
  if (error?.code === "PORT_IN_USE") {
    return {
      code: error.code,
      field: error.field || "ports",
      expected: error.expected || "configured ports must be available",
      conflicts: Array.isArray(error.conflicts) ? error.conflicts.map((conflict) => ({
        port: conflict.port || null,
        protocol: conflict.protocol || null,
        pid: conflict.pid || null,
        processName: conflict.processName || null,
      })) : [],
      userMessage: "One or more configured ports are already in use by another process.",
      suggestion: "Stop the conflicting process or choose different ports before starting this instance.",
    };
  }
  if (error?.code === "FIVEM_SETUP_REQUIRED") {
    return {
      code: error.code,
      setupRequired: true,
      readiness: error.readiness || null,
      userMessage: "FiveM setup is required before this server can start.",
      suggestion: "Open Configure FiveM and add a license key from the official Cfx.re Keymaster service.",
    };
  }
  return undefined;
}

function getValidationErrorDetails(error) {
  if (error?.validation && typeof error.validation === "object") {
    return {
      fieldErrors: error.validation,
      userMessage: "Review the highlighted settings.",
      suggestion: "Correct the invalid game configuration values, then retry.",
    };
  }
  const code = error?.code || "INSTANCE_REQUEST_FAILED";
  const numericFieldMessages = {
    startupTimeoutMs: "Startup timeout must be a whole number within the allowed installer timeout range.",
    shutdownTimeoutMs: "Shutdown timeout must be a whole number within the allowed shutdown timeout range.",
    number: "Use a valid numeric value.",
  };
  const definitions = {
    INVALID_INSTANCE_ID: { field: "id", expected: "2-64 letters, numbers, underscores, or dashes", userMessage: "Use a valid instance ID." },
    INVALID_DISPLAY_NAME: { field: "displayName", expected: "1-120 characters without line breaks", userMessage: "Enter a valid instance name." },
    INVALID_INSTANCE_TYPE: { field: "type", expected: "custom-command, node-app, python-app, java-app, or minecraft-paper", userMessage: "This installer generated an unsupported instance type." },
    INVALID_EXECUTABLE: { field: "executable", expected: "safe executable name or approved absolute path", userMessage: "The generated startup executable is invalid." },
    EXECUTABLE_NOT_ALLOWED: { field: "executable", expected: "absolute executable inside approved roots, or executable name resolved by PATH", userMessage: "The selected executable is outside approved paths." },
    INVALID_ARGS: { field: "args", expected: "argument array with safe string values", userMessage: "The generated startup arguments are invalid." },
    INVALID_PORTS: { field: "ports", expected: "ports between 1 and 65535", userMessage: "Enter valid ports between 1 and 65535." },
    INVALID_MEMORY_LIMIT: { field: "memoryLimit", expected: "memory value such as 512M, 2G, or 2048M", userMessage: "Use memory like 512M, 2G, or 2048M." },
    INVALID_NUMBER: {
      field: error?.field || "number",
      expected: error?.expected || "positive integer within the allowed range",
      userMessage: numericFieldMessages[error?.field || "number"] || `${error?.field || "Value"} must be a valid whole number.`,
      suggestion: "Check the generated install settings and retry with a whole number inside the allowed range.",
    },
    INVALID_FIVEM_LICENSE_KEY: {
      field: error?.field || "sv_licenseKey",
      expected: error?.expected || "a valid Cfx.re FiveM server license key",
      userMessage: "Enter a valid FiveM license key.",
      suggestion: error?.suggestion || "Generate a key through the official Cfx.re Keymaster service, then paste it here.",
    },
    INVALID_RESTART_POLICY: { field: "restartPolicy", expected: "never, on-failure, or always", userMessage: "The restart policy is invalid." },
    RUNTIME_FIELDS_READ_ONLY: { field: "state", expected: "runtime fields omitted from create/update requests", userMessage: "Runtime-only fields cannot be changed by install requests." },
    PATH_NOT_ALLOWED: { field: "workingDirectory", expected: "path inside the approved instance directory", userMessage: "The generated path is outside the instance directory." },
  };
  const base = definitions[code];
  if (!base) {
    return undefined;
  }
  return {
    ...base,
    code,
    received: error?.received,
  };
}

function getValidationFieldForCode(code) {
  return getValidationErrorDetails({ code })?.field || null;
}

function attachReceivedValidationValue(error, body = {}) {
  if (!error || error.received !== undefined) {
    return error;
  }
  const field = getValidationFieldForCode(error.code);
  if (!field || !body || typeof body !== "object" || Array.isArray(body)) {
    return error;
  }
  if (Object.prototype.hasOwnProperty.call(body, field)) {
    error.received = body[field];
  } else if (field === "displayName") {
    error.received = body.displayName ?? body.name;
  } else if (field === "executable") {
    error.received = body.executable ?? body.command;
  } else if (field === "memoryLimit") {
    error.received = body.memoryLimit ?? body.memory;
  }
  if (error.received === undefined && error.field && Object.prototype.hasOwnProperty.call(body, error.field)) {
    error.received = body[error.field];
  }
  return error;
}

function getInstanceIdFromPath(pathname, suffix = "") {
  const prefix = "/api/v1/instances/";

  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const raw = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  return decodeURIComponent(raw.replace(/\/$/, ""));
}

function getDirectInstanceId(pathname) {
  const id = getInstanceIdFromPath(pathname);
  return id && !id.includes("/") ? id : null;
}

async function handleInstances(request, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/instances") {
      return result(200, await listInstances());
    }

    if (request.method === "POST" && url.pathname === "/api/v1/instances") {
      const body = parseJsonBody(request);
      try {
        return result(201, {
          instance: await createInstance(body),
        });
      } catch (error) {
        throw attachReceivedValidationValue(error, body);
      }
    }

    const updateId = getDirectInstanceId(url.pathname);
    if ((request.method === "PATCH" || request.method === "PUT") && updateId) {
      const body = parseJsonBody(request);
      try {
        return result(200, {
          instance: await updateInstance(updateId, body),
        });
      } catch (error) {
        throw attachReceivedValidationValue(error, body);
      }
    }

    const renameInstanceId = getInstanceIdFromPath(url.pathname, "/display-name");
    if (request.method === "POST" && renameInstanceId) {
      const body = parseJsonBody(request);
      return result(200, {
        instance: await renameInstance(renameInstanceId, body.displayName || body.name),
      });
    }

    const duplicateId = getInstanceIdFromPath(url.pathname, "/duplicate");
    if (request.method === "POST" && duplicateId) {
      return result(201, await duplicateInstance(duplicateId, parseJsonBody(request)));
    }

    const statusId = getInstanceIdFromPath(url.pathname, "/status");
    if (request.method === "GET" && statusId) {
      return result(200, {
        instance: await getStatus(statusId),
      });
    }

    const metricsId = getInstanceIdFromPath(url.pathname, "/metrics");
    if (request.method === "GET" && metricsId) {
      return result(200, {
        metrics: await getMetrics(metricsId),
      });
    }

    const logsId = getInstanceIdFromPath(url.pathname, "/logs");
    if (request.method === "GET" && logsId) {
      return result(200, await readLogs(logsId, {
        limit: url.searchParams.get("limit"),
        stream: url.searchParams.get("stream") || "all",
      }));
    }

    if (request.method === "DELETE" && logsId) {
      return result(200, await clearLogs(logsId, {
        stream: url.searchParams.get("stream") || "all",
      }));
    }

    const commandId = getInstanceIdFromPath(url.pathname, "/command");
    if (request.method === "POST" && commandId) {
      return result(200, await writeInstanceInput(commandId, parseJsonBody(request).command));
    }

    const forceKillId = getInstanceIdFromPath(url.pathname, "/force-kill");
    if (request.method === "POST" && forceKillId) {
      return result(200, {
        instance: await forceKillInstance(forceKillId),
      });
    }

    const filesId = getInstanceIdFromPath(url.pathname, "/files");
    if (request.method === "GET" && filesId) {
      return result(200, await listInstanceFiles(filesId, url.searchParams.get("path") || "."));
    }

    const fileId = getInstanceIdFromPath(url.pathname, "/file");
    if (request.method === "GET" && fileId) {
      return result(200, await readInstanceFile(fileId, url.searchParams.get("path") || "."));
    }

    if (request.method === "PUT" && fileId) {
      const body = parseJsonBody(request);
      return result(200, await writeInstanceFile(fileId, body.path, body.content, { encoding: body.encoding }));
    }

    if (request.method === "DELETE" && fileId) {
      return result(200, await deleteInstanceFile(fileId, url.searchParams.get("path") || "."));
    }

    const existsId = getInstanceIdFromPath(url.pathname, "/exists");
    if (request.method === "GET" && existsId) {
      return result(200, await instanceFileExists(existsId, url.searchParams.get("path") || "."));
    }

    const mkdirId = getInstanceIdFromPath(url.pathname, "/mkdir");
    if (request.method === "POST" && mkdirId) {
      return result(200, await createInstanceFolder(mkdirId, parseJsonBody(request).path));
    }

    const renameId = getInstanceIdFromPath(url.pathname, "/rename");
    if (request.method === "POST" && renameId) {
      const body = parseJsonBody(request);
      return result(200, await renameInstanceFile(renameId, body.oldPath, body.newPath));
    }

    const minecraftPropertiesId = getInstanceIdFromPath(url.pathname, "/minecraft/properties");
    if (request.method === "GET" && minecraftPropertiesId) {
      return result(200, await readMinecraftProperties(minecraftPropertiesId));
    }

    if (request.method === "PUT" && minecraftPropertiesId) {
      return result(200, await writeMinecraftProperties(minecraftPropertiesId, parseJsonBody(request).properties));
    }

    const gameConfigId = getInstanceIdFromPath(url.pathname, "/game-config");
    if (request.method === "GET" && gameConfigId) {
      return result(200, await readGameServerConfig(gameConfigId, {
        adapterId: url.searchParams.get("adapterId") || null,
      }));
    }

    if ((request.method === "PUT" || request.method === "PATCH") && gameConfigId) {
      return result(200, await writeGameServerConfig(gameConfigId, parseJsonBody(request)));
    }

    const installationSessionId = getInstanceIdFromPath(url.pathname, "/installation/session");
    if (request.method === "POST" && installationSessionId) {
      return result(201, await beginInstallationSession(installationSessionId, parseJsonBody(request)));
    }
    if (request.method === "DELETE" && installationSessionId) {
      return result(200, await closeInstallationSession(installationSessionId, parseJsonBody(request)));
    }

    const installationExecuteId = getInstanceIdFromPath(url.pathname, "/installation/execute");
    if (request.method === "POST" && installationExecuteId) {
      return result(200, await executeInstallationPhase(installationExecuteId, parseJsonBody(request)));
    }

    const installationCancelId = getInstanceIdFromPath(url.pathname, "/installation/cancel");
    if (request.method === "POST" && installationCancelId) {
      return result(200, await cancelInstallationSession(installationCancelId, parseJsonBody(request)));
    }

    const steamUpdateSessionId = getInstanceIdFromPath(url.pathname, "/steamcmd/update/session");
    if (request.method === "POST" && steamUpdateSessionId) {
      return result(201, await beginSteamCmdUpdateSession(steamUpdateSessionId, parseJsonBody(request)));
    }
    const steamMigrationId = getInstanceIdFromPath(url.pathname, "/steamcmd/update/migrate");
    if (request.method === "POST" && steamMigrationId) {
      return result(200, { instance: await repairLegacySteamCmdMetadata(steamMigrationId) });
    }
    if (request.method === "DELETE" && steamUpdateSessionId) {
      return result(200, await closeInstallationSession(steamUpdateSessionId, parseJsonBody(request)));
    }
    const steamUpdateId = getInstanceIdFromPath(url.pathname, "/steamcmd/update");
    if (request.method === "POST" && steamUpdateId) {
      return result(200, await executeSteamCmdUpdate(steamUpdateId, parseJsonBody(request)));
    }

    const fivemReadinessId = getInstanceIdFromPath(url.pathname, "/fivem/readiness");
    if (request.method === "GET" && fivemReadinessId) {
      return result(200, await refreshFiveMReadiness(fivemReadinessId));
    }

    const fivemLicenseId = getInstanceIdFromPath(url.pathname, "/fivem/license-key");
    if (request.method === "PUT" && fivemLicenseId) {
      return result(200, await saveFiveMLicenseKey(fivemLicenseId, parseJsonBody(request).licenseKey));
    }

    const neoForgeRepairId = getInstanceIdFromPath(url.pathname, "/neoforge/repair-runtime");
    if (request.method === "POST" && neoForgeRepairId) {
      return result(200, await repairNeoForgeRuntime(neoForgeRepairId, parseJsonBody(request)));
    }

    const neoForgeRepairAliasId = getInstanceIdFromPath(url.pathname, "/repair-neoforge-runtime");
    if (request.method === "POST" && neoForgeRepairAliasId) {
      return result(200, await repairNeoForgeRuntime(neoForgeRepairAliasId, parseJsonBody(request)));
    }

    const startId = getInstanceIdFromPath(url.pathname, "/start");
    if (request.method === "POST" && startId) {
      return result(200, {
        instance: await startInstance(startId),
      });
    }

    const stopId = getInstanceIdFromPath(url.pathname, "/stop");
    if (request.method === "POST" && stopId) {
      return result(200, {
        instance: await stopInstance(stopId),
      });
    }

    const restartId = getInstanceIdFromPath(url.pathname, "/restart");
    if (request.method === "POST" && restartId) {
      return result(200, {
        instance: await restartInstance(restartId),
      });
    }

    const deleteId = getDirectInstanceId(url.pathname);
    if (request.method === "DELETE" && deleteId) {
      return result(200, await deleteInstance(deleteId));
    }

    const forgetId = getInstanceIdFromPath(url.pathname, "/record");
    if (request.method === "DELETE" && forgetId) {
      return result(200, await forgetInstance(forgetId));
    }

    return result(404, {
      error: {
        code: "NOT_FOUND",
        message: "Request failed.",
      },
    });
  } catch (error) {
    return errorResult(error);
  }
}

module.exports = {
  handleInstances,
};
