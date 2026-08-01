const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const agentControl = fs.readFileSync(path.join(root, "src", "services", "agentControlService.js"), "utf8");
const ipc = fs.readFileSync(path.join(root, "src", "ipc", "agentControlIpc.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

[
  "async function installLocalAgent",
  "ensureManagedAgentDirectories",
  "getAgentLogsDirectory",
  "getAgentInstancesDirectory",
  "getAgentBackupsDirectory",
  "getAgentTempDirectory",
  "pairLocalAgent",
  "readLocalAgentPairingStatus",
  "testConnection",
  "LOCAL_AGENT_RUNTIME_MISSING",
  "LOCAL_AGENT_VERIFY_FAILED",
  "restoreLocalAgentCredential",
  "snapshotLocalAgentCredential",
  "rollbackPendingChanges",
  "Local Agent installation was stopped before credentials changed.",
  "pending credentials were rolled back",
  "serviceWarning",
  "installerSteps",
  "buildWindowsAgentTaskDefinition",
  "schtasks.exe",
  "AGENT_TASK_DEFINITION_MISMATCH",
  "AGENT_PRIVILEGED_OPERATION_UNAVAILABLE",
  "repairWindowsAgentTask",
  "parseWindowsNetstatListener",
  "listeningProcess",
  "isVerifiedOldLocalAgentProcess",
  "stopOldLocalAgentAndRepair",
  "LOCAL_AGENT_PROCESS_UNVERIFIED",
  "operationInFlight = null;",
  "operationInFlight = \"install\";",
  "operationInFlight = \"repair-old-local-agent\";",
  "status: await getStatus()",
].forEach((needle) => {
  assert(agentControl.includes(needle), `Local Agent installer service should include ${needle}.`);
});

assert(!agentControl.includes("token: token.token"), "Installer results must not return raw tokens.");
assert(!agentControl.includes("agentToken: token.token"), "Installer results must not expose generated Agent tokens.");
assert(!agentControl.includes('["create", SERVICE_NAME, "binPath="'), "Windows Local Agent must not register a non-service Electron process with sc.exe.");
assert(agentControl.includes("pairLocalAgentSecurely"), "Agent Control should expose local pairing repair without manual token copying.");

[
  "agentControl:installLocalAgent",
  "agentControl:stopOldLocalAgentAndRepair",
  "agentControl:pairLocalAgent",
  "runLocalLifecycle(\"install-local-agent\"",
  "runLocalLifecycle(\"stop-old-local-agent-and-repair\"",
].forEach((needle) => assert(ipc.includes(needle), `Agent Control IPC should expose ${needle}.`));

assert(preload.includes("installLocalAgent: (payload = {}) => ipcRenderer.invoke(\"agentControl:installLocalAgent\", payload)"), "Preload should expose installLocalAgent.");
assert(preload.includes("stopOldLocalAgentAndRepair: (payload = {}) => ipcRenderer.invoke(\"agentControl:stopOldLocalAgentAndRepair\", payload)"), "Preload should expose stopOldLocalAgentAndRepair.");
assert(preload.includes("pairLocalAgent: (payload = {}) => ipcRenderer.invoke(\"agentControl:pairLocalAgent\", payload)"), "Preload should expose pairLocalAgent.");

[
  "data-agent-local-installer",
  "Install Local Agent",
  "AnxOS Local Agent lets AnxOS manage servers, files, backups, dependencies, and services on this computer.",
  "data-agent-control-action=\"installLocalAgent\"",
  "data-agent-control-action=\"stopOldLocalAgentAndRepair\"",
  "data-agent-control-action=\"learnLocalAgent\"",
  "data-agent-control-action=\"useRemoteAgent\"",
  "data-agent-local-installer-steps",
].forEach((needle) => assert(index.includes(needle), `Agent Control UI should include ${needle}.`));

[
  "renderLocalAgentInstallerSteps",
  "agentLocalInstallerStatus",
  "agentLocalInstallerSteps",
  "Needs attention",
  "api.installLocalAgent({ autoStart: true, installService: true })",
  "api.stopOldLocalAgentAndRepair({ autoStart: true, installService: true })",
  "Stop Old Local Agent and Repair",
  "repair-local-agent",
  "api.pairLocalAgent({ rotate: true",
  "The Local Agent runs on this PC",
  "Remote Agent mode stays available",
  "await refreshNodes()",
].forEach((needle) => assert(app.includes(needle), `Renderer installer flow should include ${needle}.`));

assert(!app.includes("agentToken copied"), "Renderer must not offer to copy Local Agent tokens.");

console.log("Local Agent installer smoke checks passed.");
