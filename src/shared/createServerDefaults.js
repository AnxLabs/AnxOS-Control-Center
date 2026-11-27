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
            ? `Port ${preferred} is already in use on this computer by ${holder}, so AnxHost picked ${candidate}.`
            : `Port ${preferred} is already used by another server on this computer, so AnxHost picked ${candidate}.`,
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
      warning: `This server usually wants ${formatMemoryMiB(recommendedMiB)}, but this computer has about ${formatMemoryMiB(totalMiB)} in total, so AnxHost set ${formatMemoryMiB(fitted)}.`,
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

  const GIB = 1024 * MIB;
  const VERDICT_ORDER = { good: 0, unknown: 1, tight: 2, no: 3 };
  const PLATFORM_NAMES = { windows: "Windows", linux: "Linux", macos: "macOS" };

  function normalizePlatform(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return null;
    if (text === "win32" || text.startsWith("windows")) return "windows";
    if (text === "linux" || /ubuntu|debian|fedora|centos|rhel|arch/.test(text)) return "linux";
    if (text === "darwin" || text.startsWith("mac")) return "macos";
    return text;
  }

  function formatGiB(bytes) {
    if (!Number.isFinite(bytes)) return "unknown";
    const gib = bytes / GIB;
    return gib >= 10 ? `${Math.round(gib)} GB` : `${Math.round(gib * 10) / 10} GB`;
  }

  // "Will it run on this computer?" for the Create Server window (Build
  // 215-D). Plain-language reasons from what is actually known: the
  // template's platforms and memory setting, and the computer's connection,
  // operating system, memory and free disk. Game file sizes are not measured
  // in the catalog, so disk only flags a computer that is nearly full; it
  // never claims a server fits. verdict: good | tight | no | unknown.
  function assessComputerFit({
    computerName = "This computer",
    online = true,
    nodePlatform = null,
    templatePlatforms = [],
    isService = false,
    memory = null,
    templateMemory = null,
    disk = null,
  } = {}) {
    const reasons = [];
    const add = (verdict, text) => reasons.push({ verdict, text });
    if (!online) {
      add("no", `${computerName} is not connected.`);
    }
    const platforms = (Array.isArray(templatePlatforms) ? templatePlatforms : []).map(normalizePlatform).filter(Boolean);
    const platform = normalizePlatform(nodePlatform);
    if (platforms.length && platform) {
      if (platforms.includes(platform)) {
        add("good", `Runs on ${PLATFORM_NAMES[platform] || platform}.`);
      } else {
        const wanted = platforms.map((entry) => PLATFORM_NAMES[entry] || entry).join(" or ");
        add("no", isService
          ? `This service is offered for ${wanted} computers; ${computerName} runs ${PLATFORM_NAMES[platform] || platform}.`
          : `This server runs on ${wanted}; ${computerName} runs ${PLATFORM_NAMES[platform] || platform}.`);
      }
    }

    const wantMiB = parseMemoryMiB(templateMemory);
    const totalBytes = Number(memory?.total);
    const freeBytes = Number.isFinite(Number(memory?.available)) ? Number(memory.available)
      : Number.isFinite(Number(memory?.free)) ? Number(memory.free)
        : Number.isFinite(totalBytes) && Number.isFinite(Number(memory?.used)) ? totalBytes - Number(memory.used) : NaN;
    if (wantMiB && Number.isFinite(totalBytes) && totalBytes > 0) {
      const want = wantMiB * MIB;
      if (want > totalBytes) {
        add("no", `The server is set to use ${formatMemoryMiB(wantMiB)}, but ${computerName} has ${formatGiB(totalBytes)} in total. Lower its memory or choose a bigger computer.`);
      } else if (Number.isFinite(freeBytes) && want > freeBytes) {
        add("tight", `It is set to use ${formatMemoryMiB(wantMiB)} and ${formatGiB(freeBytes)} is free right now (of ${formatGiB(totalBytes)}). It can start, but may be slow while other programs or servers use the rest.`);
      } else {
        add("good", `Memory: ${formatMemoryMiB(wantMiB)} of ${Number.isFinite(freeBytes) ? `${formatGiB(freeBytes)} free` : `${formatGiB(totalBytes)} in total`}.`);
      }
    } else if (wantMiB) {
      add("unknown", `${computerName} has not reported its memory yet, so AnxHost cannot check the ${formatMemoryMiB(wantMiB)} this server is set to use.`);
    }

    const diskFree = Number(disk?.free);
    if (Number.isFinite(diskFree)) {
      if (diskFree < 2 * GIB) add("no", `Only ${formatGiB(diskFree)} of disk is free. Free some space first.`);
      else if (diskFree < 10 * GIB) add("tight", `${formatGiB(diskFree)} of disk is free. Game files and saves can need several GB (the size is not measured for this game).`);
      else add("good", `Disk: ${formatGiB(diskFree)} free.`);
    } else {
      add("unknown", "Free disk space is not reported yet for this computer.");
    }

    const verdict = reasons.reduce((worst, reason) => (VERDICT_ORDER[reason.verdict] > VERDICT_ORDER[worst] ? reason.verdict : worst), "good");
    const headline = {
      good: `${computerName} looks like a good fit.`,
      tight: `${computerName} can run it, with limits.`,
      no: `${computerName} is not a good fit.`,
      unknown: `${computerName} has not reported everything AnxHost checks.`,
    }[verdict];
    return { verdict, headline, reasons };
  }

  return Object.freeze({
    assessComputerFit,
    recommendPort,
    listenerPortOwners,
    isPortFree,
    recommendMemory,
    parseMemoryMiB,
    formatMemoryMiB,
  });
});
