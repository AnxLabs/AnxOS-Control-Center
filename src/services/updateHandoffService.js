"use strict";

// 217-E: what must finish before the app closes for an update.
//
// The installer closes a running app by ending its processes. A normal close
// only hides the main window to the tray, so the installer then forces it:
// nothing is saved, servers on This PC are not stopped through their own stop
// command, and a transfer, install or restore in progress is cut off. The app
// now closes itself first (main.js runs its normal shutdown, then opens the
// installer), and refuses while sensitive work is still running.

const ACTIVE_OPERATION_STATUSES = new Set(["queued", "running", "paused"]);
const ACTIVE_JOB_STATES = new Set(["enqueued", "running"]);

const OPERATION_LABELS = {
  "file-transfer": "a file transfer",
  "marketplace-download": "a server install",
  pack: "a modpack install",
  "docker-image-pull": "a Docker image download",
};

// Job types of servers this app runs itself (instanceServiceCore). Backups
// and restores run in an Agent, which finishes a running restore before it
// stops (agent/src/services/backupService.js).
const JOB_LABELS = {
  "instance.create": "a server install",
  "instance.update": "a server settings change",
  "instance.start": "a server start",
  "instance.stop": "a server stop",
  "instance.restart": "a server restart",
};

function describeOperation(operation) {
  return OPERATION_LABELS[operation?.kind] || "a task in progress";
}

function describeJob(job) {
  return JOB_LABELS[job?.type] || "a server task";
}

// listOperations: () => long-operation records (src/shared/longOperationService)
// listInstanceJobs: async () => { jobs } for servers this app runs itself
async function findBlockingWork({ listOperations, listInstanceJobs } = {}) {
  const blocking = [];
  try {
    for (const operation of (typeof listOperations === "function" ? listOperations() : []) || []) {
      if (ACTIVE_OPERATION_STATUSES.has(operation?.status)) {
        blocking.push({ source: "operation", id: operation.id || null, kind: operation.kind || null, label: describeOperation(operation) });
      }
    }
  } catch {
    // An unreadable operation store is reported by its owner; it does not block.
  }
  try {
    const result = typeof listInstanceJobs === "function" ? await listInstanceJobs({ limit: 200 }) : null;
    for (const job of result?.jobs || []) {
      if (ACTIVE_JOB_STATES.has(job?.state)) {
        blocking.push({ source: "job", id: job.id || null, kind: job.type || null, label: describeJob(job) });
      }
    }
  } catch {
    // Same: a job store that cannot be read does not hold the update back.
  }
  return blocking;
}

function joinWords(words) {
  if (words.length <= 1) return words[0] || "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function describeBlockingWork(blocking = []) {
  const labels = [...new Set(blocking.map((entry) => entry.label).filter(Boolean))];
  if (!labels.length) return "";
  const what = joinWords(labels.slice(0, 3)) + (labels.length > 3 ? " and other tasks" : "");
  return `Wait until ${what} on this PC has finished, then install the update. Closing AnxHost now would cut it off.`;
}

module.exports = {
  ACTIVE_JOB_STATES,
  ACTIVE_OPERATION_STATUSES,
  describeBlockingWork,
  findBlockingWork,
};
