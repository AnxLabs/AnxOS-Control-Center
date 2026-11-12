// Recommended Create Server settings, so beginners never have to choose a
// port or a memory size. Side-effect free: the renderer passes in what it
// already knows (ports used by servers on the selected computer, the
// computer's memory) and Node smokes load the same file.
(function initializeCreateServerDefaults(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxCreateServerDefaults = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCreateServerDefaultsApi() {
  "use strict";

  const MIB = 1024 * 1024;
  // Memory left for the operating system and the Agent when sizing a server.
  const SYSTEM_RESERVE_MIB = 1024;
  const MIN_SERVER_MIB = 512;
  // How far past the default port to look for a free one.
  const PORT_SEARCH_LIMIT = 50;

  function toPort(value) {
    const number = Number.parseInt(String(value ?? "").match(/\d{1,5}/)?.[0] || "", 10);
    return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : null;
  }

  // The template's default port when no other server on this computer uses
  // it, otherwise the next free port above it. Ports the template itself
  // reserves (e.g. a query or RCON port) are skipped too.
  // owners (optional) maps a busy port to who holds it, e.g. "java (PID 412)";
  // ports without an owner are other AnxOS servers.
  function recommendPort(defaultPort, usedPorts = [], { reserved = [], owners = {} } = {}) {
    const preferred = toPort(defaultPort);
    if (!preferred) return { port: null, changed: false, reason: "" };
    const taken = new Set([...usedPorts, ...reserved, ...Object.keys(owners || {})].map(toPort).filter(Boolean));
    if (!taken.has(preferred)) return { port: preferred, changed: false, reason: "" };
    const holder = owners?.[preferred];
    for (let candidate = preferred + 1; candidate <= Math.min(65535, preferred + PORT_SEARCH_LIMIT); candidate += 1) {
      if (!taken.has(candidate)) {
        return {
          port: candidate,
          changed: true,
          reason: holder
            ? `Port ${preferred} is already in use on this computer by ${holder}, so AnxOS picked ${candidate}.`
            : `Port ${preferred} is already used by another server on this computer, so AnxOS picked ${candidate}.`,
        };
      }
    }
    return { port: preferred, changed: false, reason: `Ports ${preferred}-${preferred + PORT_SEARCH_LIMIT} are all in use; choose a port under Advanced options.` };
  }

  // "4G" -> 4096, "512M" -> 512, "2048" (MiB) -> 2048. Invalid -> null.
  function parseMemoryMiB(value) {
    const match = String(value ?? "").trim().match(/^([1-9][0-9]{0,5})([kKmMgG]?)$/);
    if (!match) return null;
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2].toUpperCase();
    if (unit === "G") return amount * 1024;
    if (unit === "K") return Math.max(1, Math.round(amount / 1024));
    return amount;
  }

  function formatMemoryMiB(mib) {
    if (!Number.isFinite(mib) || mib <= 0) return "";
    return mib % 1024 === 0 ? `${mib / 1024}G` : `${Math.round(mib)}M`;
  }

  // Keeps the template's recommendation when the computer can hold it; on a
  // smaller computer lowers it to what fits (never below MIN_SERVER_MIB) and
  // says why. Without memory metrics the recommendation is kept unchanged.
  function recommendMemory(templateMemory, { totalBytes = null } = {}) {
    const recommendedMiB = parseMemoryMiB(templateMemory);
    if (!recommendedMiB) return { memory: String(templateMemory || ""), changed: false, warning: "" };
    const totalMiB = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes / MIB) : null;
    if (!totalMiB) return { memory: formatMemoryMiB(recommendedMiB), changed: false, warning: "" };
    const available = totalMiB - SYSTEM_RESERVE_MIB;
    if (recommendedMiB <= available) return { memory: formatMemoryMiB(recommendedMiB), changed: false, warning: "" };
    if (available < MIN_SERVER_MIB) {
      return {
        memory: formatMemoryMiB(recommendedMiB),
        changed: false,
        warning: `This computer has about ${formatMemoryMiB(totalMiB)} of memory in total, which is very little for this server. It may run slowly or not start.`,
      };
    }
    // Round down to a whole 512 MiB step so the value reads cleanly.
    const fitted = Math.max(MIN_SERVER_MIB, Math.floor(available / 512) * 512);
    return {
      memory: formatMemoryMiB(fitted),
      changed: true,
      warning: `This server usually wants ${formatMemoryMiB(recommendedMiB)}, but this computer has about ${formatMemoryMiB(totalMiB)} in total, so AnxOS set ${formatMemoryMiB(fitted)}.`,
    };
  }

  // Busy ports from the Agent's live listener list (TCP and UDP alike, since
  // templates do not declare a protocol): { port: "program (PID n)" }.
  function listenerPortOwners(listeners = []) {
    const owners = {};
    (Array.isArray(listeners) ? listeners : []).forEach((row) => {
      const port = toPort(row && row.localPort);
      if (!port || owners[port]) return;
      const name = String((row && row.processName) || "").trim();
      const pid = Number.isInteger(row && row.pid) ? row.pid : null;
      owners[port] = name ? `${name}${pid ? ` (PID ${pid})` : ""}` : pid ? `a program (PID ${pid})` : "another program";
    });
    return owners;
  }

  // Is this exact port free according to the listener list? null when the
  // list could be incomplete and the port is not in it.
  function isPortFree(port, owners = {}, { truncated = false } = {}) {
    const number = toPort(port);
    if (!number) return null;
    if (owners[number]) return false;
    return truncated ? null : true;
  }

  return Object.freeze({
    recommendPort,
    listenerPortOwners,
    isPortFree,
    recommendMemory,
    parseMemoryMiB,
    formatMemoryMiB,
  });
});
