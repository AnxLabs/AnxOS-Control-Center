// Moving a server to another computer (Build 213-D): the checks that run
// BEFORE anything is copied. The move itself stays workloadTransferService
// (full backup on the source, verify, copy, checksum, import, restore
// preview, confirmed restore); this only decides whether it is safe to
// start, and says why not in plain words.
//
// Every check is read-only. A "block" stops the move; a "warn" is shown in
// the confirmation. Nothing here changes either computer.

const WORKLOAD_IMPORT_LIMIT_BYTES = Math.floor((256 * 1024 * 1024 * 3) / 4);
const RUNNING_STATES = new Set(["running", "starting", "restarting", "reloading", "stopping"]);

function memoryBytes(value) {
  const match = String(value || "").trim().match(/^([1-9][0-9]{0,5})([kKmMgG]?)$/);
  if (!match) return null;
  const units = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function instancePorts(instance) {
  const ports = new Set();
  for (const value of Array.isArray(instance?.ports) ? instance.ports : []) {
    const port = Number(typeof value === "object" ? value?.port ?? value?.hostPort : value);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  for (const key of ["port", "primaryPort", "queryPort", "rconPort"]) {
    const port = Number(instance?.[key]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return ports;
}

function nodePlatform(node) {
  return String(node?.platform || node?.connection?.platform || node?.agentIdentity?.platform || "").toLowerCase() || null;
}

// What the server needs from the target operating system.
function platformRequirement(instance) {
  const game = String(instance?.gameAdapter || instance?.game || instance?.templateId || "").toLowerCase();
  if (game.includes("hytale")) return { platform: "linux", reason: "Hytale servers run on Linux computers only." };
  const command = [instance?.command, instance?.startCommand, instance?.executable, ...(Array.isArray(instance?.args) ? instance.args : [])]
    .filter(Boolean).join(" ").toLowerCase();
  if (/\.(exe|bat|cmd|ps1)\b/.test(command)) return { platform: "win32", reason: "This server starts a Windows program." };
  if (/\.sh\b/.test(command)) return { platform: "linux", reason: "This server starts a Linux shell script." };
  return null;
}

// Pure: every input was already read by the caller.
function evaluateMigration({ sourceNode, targetNode, instance, targetInstances = [], targetStats = null, latestBackupBytes = null, targetInstanceId = null }) {
  const items = [];
  const add = (id, level, title, detail = "") => items.push({ id, level, title, detail });
  const name = instance?.displayName || instance?.id || "This server";
  const targetName = targetNode?.displayName || targetNode?.name || targetNode?.id || "the target computer";

  if (!instance) {
    add("server", "block", "Server not found", "It may have been removed or renamed on its computer.");
    return summarize(items);
  }
  if (!targetNode) add("target", "block", "Choose a target computer");
  else if (targetNode.id === sourceNode?.id) add("target", "block", "Pick a different computer", "The server is already on this one.");
  else if (String(targetNode.connection?.status || "").toLowerCase() !== "online") add("target", "block", `${targetName} is not connected`, "Connect it first; nothing is copied to a computer AnxHost cannot reach.");
  else add("target", "ok", `${targetName} is connected`);

  if (RUNNING_STATES.has(String(instance.state || "").toLowerCase())) {
    add("stopped", "block", `Stop ${name} first`, "A copy taken while it runs can miss the latest world changes. Stop it, then move it; the original stays as it is.");
  } else {
    add("stopped", "ok", `${name} is stopped`, "Its files will be copied as they are now.");
  }

  const requirement = platformRequirement(instance);
  const targetPlatform = nodePlatform(targetNode);
  if (requirement && targetPlatform && requirement.platform !== targetPlatform) {
    add("platform", "block", `${targetName} can't run this server`, requirement.reason);
  } else if (requirement && !targetPlatform) {
    add("platform", "warn", "Target operating system unknown", requirement.reason);
  } else {
    add("platform", "ok", "Runs on the target's operating system");
  }

  const wantedId = String(targetInstanceId || instance.id);
  const sameId = targetInstances.find((candidate) => candidate?.id === wantedId);
  if (sameId) {
    add("identity", "block", `${targetName} already has a server with this ID`, `Moving it would replace "${sameId.displayName || sameId.id}". Choose another ID, or remove that server first.`);
  } else {
    add("identity", "ok", "No server with the same ID on the target");
  }
  const sameName = targetInstances.find((candidate) => candidate?.id !== wantedId && (candidate?.displayName || "").trim().toLowerCase() === String(instance.displayName || "").trim().toLowerCase() && candidate.displayName);
  if (sameName) add("name", "warn", `${targetName} already has a server called "${sameName.displayName}"`, "Both will be listed; rename one afterwards to tell them apart.");

  const ports = instancePorts(instance);
  const clashes = [];
  for (const other of targetInstances) {
    if (!other || other.id === wantedId) continue;
    const shared = [...instancePorts(other)].filter((port) => ports.has(port));
    if (shared.length) clashes.push(`${other.displayName || other.id} (${shared.join(", ")})`);
  }
  if (clashes.length) {
    add("ports", "block", "Port already used on the target", `${clashes.join("; ")} already use${clashes.length === 1 ? "s" : ""} this server's port. Change one of the ports first, or the two servers can't run together.`);
  } else if (ports.size) {
    add("ports", "ok", `Port${ports.size === 1 ? "" : "s"} ${[...ports].join(", ")} free among the target's servers`);
  }

  const wanted = memoryBytes(instance.memory || instance.memoryLimit);
  const totalMemory = Number(targetStats?.memory?.total);
  if (wanted && Number.isFinite(totalMemory) && totalMemory > 0) {
    if (wanted > totalMemory) add("memory", "block", "Not enough memory on the target", `It is set to use ${formatBytes(wanted)}; ${targetName} has ${formatBytes(totalMemory)} in total.`);
    else if (wanted > totalMemory * 0.75) add("memory", "warn", "Memory will be tight", `It is set to use ${formatBytes(wanted)} of ${targetName}'s ${formatBytes(totalMemory)}.`);
    else add("memory", "ok", `Memory: ${formatBytes(wanted)} of ${formatBytes(totalMemory)}`);
  }

  const freeDisk = Number(targetStats?.disk?.free);
  if (Number.isFinite(latestBackupBytes) && latestBackupBytes > 0) {
    if (latestBackupBytes > WORKLOAD_IMPORT_LIMIT_BYTES) {
      add("size", "block", "Too large to move this way yet", `Its latest backup is ${formatBytes(latestBackupBytes)}; moving between computers handles up to ${formatBytes(WORKLOAD_IMPORT_LIMIT_BYTES)} today.`);
    }
    if (Number.isFinite(freeDisk)) {
      if (freeDisk < latestBackupBytes * 3) add("disk", "block", "Not enough free space on the target", `${targetName} has ${formatBytes(freeDisk)} free; moving needs about ${formatBytes(latestBackupBytes * 3)} (the copy, the unpacked server and room to start).`);
      else add("disk", "ok", `${formatBytes(freeDisk)} free on the target`);
    }
  } else if (Number.isFinite(freeDisk)) {
    add("disk", "warn", "Server size unknown until the backup is made", `${targetName} has ${formatBytes(freeDisk)} free.`);
  }

  return summarize(items);
}

function summarize(items) {
  const blockers = items.filter((item) => item.level === "block");
  const warnings = items.filter((item) => item.level === "warn");
  return { ok: blockers.length === 0, blockers, warnings, items };
}

// Reads what the checks need, through the same per-computer routes the app
// already uses, and evaluates them.
async function checkMigration({ sourceNodeId, targetNodeId, instanceId, targetInstanceId, deps }) {
  const nodes = await deps.listNodes();
  const sourceNode = nodes.find((node) => node.id === sourceNodeId) || null;
  const targetNode = nodes.find((node) => node.id === targetNodeId) || null;
  const listed = await deps.listInstances({ nodeId: sourceNodeId });
  const instances = Array.isArray(listed) ? listed : Array.isArray(listed?.instances) ? listed.instances : [];
  const instance = instances.find((candidate) => candidate?.id === instanceId) || null;
  let targetInstances = [];
  let targetStats = null;
  if (targetNode && String(targetNode.connection?.status || "").toLowerCase() === "online") {
    const targetListed = await deps.listInstances({ nodeId: targetNodeId }).catch(() => []);
    targetInstances = Array.isArray(targetListed) ? targetListed : Array.isArray(targetListed?.instances) ? targetListed.instances : [];
    targetStats = await deps.getStats({ nodeId: targetNodeId }).catch(() => null);
  }
  let latestBackupBytes = null;
  try {
    const backups = await deps.listBackups({ nodeId: sourceNodeId });
    const full = (Array.isArray(backups?.backups) ? backups.backups : [])
      .filter((backup) => backup?.instanceId === instanceId && backup?.type === "full" && Number(backup.size) > 0)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    latestBackupBytes = full.length ? Number(full[0].size) : null;
  } catch {
    latestBackupBytes = null;
  }
  return evaluateMigration({ sourceNode, targetNode, instance, targetInstances, targetStats, latestBackupBytes, targetInstanceId });
}

module.exports = { WORKLOAD_IMPORT_LIMIT_BYTES, checkMigration, evaluateMigration, _test: { memoryBytes, instancePorts, platformRequirement } };
