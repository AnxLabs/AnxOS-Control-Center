// Turns the Agent's sanitized Project Forge health summary (see
// src/shared/forgeHealth.js) into what the Dashboard's Forge card shows.
// Pure and DOM-free so the renderer and smoke tests share one source of truth.
(function initializeForgeHealthPresentation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxForgeHealthPresentation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createForgeHealthPresentationApi() {
  "use strict";

  const STATUS_PRESENTATION = Object.freeze({
    ok: { pillKey: "ok", pillLabel: "OK", statusLabel: "OK" },
    warning: { pillKey: "warning", pillLabel: "Warning", statusLabel: "Warning" },
    critical: { pillKey: "critical", pillLabel: "Critical", statusLabel: "Critical" },
  });
  const SEVERITY_PRESENTATION = Object.freeze({
    critical: { severityKey: "critical", severityLabel: "Critical" },
    high: { severityKey: "critical", severityLabel: "High" },
    warning: { severityKey: "warning", severityLabel: "Warning" },
    info: { severityKey: "muted", severityLabel: "Info" },
  });

  function formatAge(ageSeconds) {
    if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return null;
    if (ageSeconds < 90) return `${Math.max(Math.round(ageSeconds), 0)}s ago`;
    const minutes = Math.round(ageSeconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function describeAlerts(alerts) {
    if (!Array.isArray(alerts)) return [];
    return alerts
      .filter((alert) => alert && (alert.title || alert.code))
      .map((alert) => ({
        ...(SEVERITY_PRESENTATION[alert.severity] || SEVERITY_PRESENTATION.info),
        code: alert.code || null,
        title: alert.title || alert.code,
        detail: alert.detail || null,
      }));
  }

  function unavailable(pillLabel, statusLabel, summary) {
    return {
      pillKey: "muted",
      pillLabel,
      statusLabel,
      summary,
      updatedLabel: "Unavailable",
      alerts: [],
      alertsCaption: null,
      showAlerts: false,
      current: false,
    };
  }

  // `forge` is snapshot.forge from the selected node; undefined means the
  // node's Agent predates the Forge reader.
  function describeForgeHealth(forge) {
    if (!forge || typeof forge !== "object") {
      return unavailable("Unknown", "Not reported", "This node's Agent does not report Project Forge health. Update the Agent to see it.");
    }
    if (forge.available !== true) {
      if (forge.state === "missing") {
        return unavailable(
          "Not running",
          "Forge not running",
          "No Project Forge health report on this node. Forge is not installed, has never run here, or publishing is turned off.",
        );
      }
      return unavailable(
        "Unreadable",
        "Report unreadable",
        forge.reason === "unsupported_schema"
          ? "Project Forge's health report uses a format this version of AnxHost does not understand."
          : "Project Forge's health report exists but could not be read.",
      );
    }

    const age = formatAge(forge.ageSeconds);
    const updatedLabel = age || "Unknown";
    const alerts = describeAlerts(forge.alerts);

    if (forge.fresh !== true) {
      const stopped = forge.state === "stopped";
      return {
        pillKey: "muted",
        pillLabel: stopped ? "Stopped" : "Stale",
        statusLabel: stopped ? "Forge stopped" : "Report stale",
        summary: stopped
          ? "Project Forge is not running, so nothing is being watched right now."
          : "Project Forge has not updated its health report recently, so it may not be running.",
        updatedLabel,
        alerts,
        // Never present an old report as current.
        alertsCaption: alerts.length ? `From Forge's last report (${age || "time unknown"}). May be out of date.` : null,
        showAlerts: alerts.length > 0,
        current: false,
      };
    }

    const status = STATUS_PRESENTATION[forge.status] || { pillKey: "muted", pillLabel: "Unknown", statusLabel: "Unknown" };
    const topAlert = alerts[0] || null;
    return {
      ...status,
      summary: topAlert
        ? `${alerts.length} alert${alerts.length === 1 ? "" : "s"} from Project Forge.`
        : "Project Forge reports no problems on this node.",
      updatedLabel,
      alerts,
      alertsCaption: null,
      showAlerts: alerts.length > 0,
      current: true,
    };
  }

  function describeGpuTemperature(gpu) {
    const core = gpu && typeof gpu === "object" ? gpu.core : null;
    const value = Number(core?.temperatureCelsius);
    if (!core || core.temperatureCelsius === null || !Number.isFinite(value) || value < 1 || value > 125) {
      return { text: "Not reported", title: "GPU temperature is not reported by this node.", celsius: null };
    }
    const source = core.temperatureSource || core.source || null;
    const sensor = core.temperatureSensor || core.sensorName || "GPU";
    return {
      text: `${Math.round(value)}°C`,
      title: `${sensor}${source ? ` — ${source}` : ""}: ${value.toFixed(1)}°C`,
      celsius: value,
    };
  }

  return {
    describeAlerts,
    describeForgeHealth,
    describeGpuTemperature,
    formatAge,
  };
});
