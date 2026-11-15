#!/usr/bin/env node
"use strict";

// Regressions for the Docker, dependency and marketplace install engines.
//   M1 a second SteamCMD update runs SteamCMD again (the job engine used to
//      replay the first success under a key derived from the instance)
//   M2 reinstalling a server with the same name creates it again, and a Docker
//      template publishes the host port the user chose ("8081:80", not "8080:80")
//   M3 Windows TShock and FiveM do not require the Linux-only unzip / xz, and
//      the start gate checks the Windows variant, not the raw Linux template
//   M4 the .NET check reads the highest installed runtime, not the oldest
//   M5 a failed `docker start` removes the container it just created and says
//      why; container logs include stderr in time order
//   M6 the container terminal falls back to sh, returns a failing command's
//      output and exit code, and container errors are not "Docker is not installed"
// Every data path is a temp dir; child processes, sockets and HTTP are faked or
// blocked before any repo module loads, so nothing on this machine is touched.
// Run: node scripts/docker-marketplace-engine-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-docker-marketplace-"));
const configDir = path.join(root, "config");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, "agent.json"), `${JSON.stringify({ backendMode: "local", agentUrl: "http://127.0.0.1:9", agentToken: "", schemaVersion: 1 }, null, 2)}\n`);
Object.assign(process.env, {
  ANXHUB_CONFIG_DIR: configDir,
  ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
  ANXOS_CONFIG_DIR: path.join(root, "anxos-config"),
  ANXOS_LOG_DIR: path.join(root, "logs"),
  AGENT_INSTANCE_ROOT: path.join(root, "instances"),
  AGENT_BACKUP_ROOT: path.join(root, "backups"),
  AGENT_TEMP_DIR: path.join(root, "tmp"),
  AGENT_LOG_DIR: path.join(root, "agent-logs"),
  AGENT_IDENTITY_PATH: path.join(root, "identity.json"),
  AGENT_URL: "http://127.0.0.1:9",
  DOCKER_BINARY: path.join(root, "docker"),
});
for (const key of ["ANXOS_CONFIG_DIR", "ANXOS_LOG_DIR", "AGENT_INSTANCE_ROOT", "AGENT_BACKUP_ROOT", "AGENT_TEMP_DIR", "AGENT_LOG_DIR"]) fs.mkdirSync(process.env[key], { recursive: true });
fs.writeFileSync(process.env.DOCKER_BINARY, "");

// ---- guards and the fake docker CLI (installed before any repo module) ----
const blocked = [];
global.fetch = async (url) => { blocked.push(`fetch ${url}`); throw new Error(`blocked fetch ${url}`); };
for (const name of ["http", "https"]) {
  const mod = require(name);
  mod.request = () => { blocked.push(`${name}.request`); throw new Error(`blocked ${name}.request`); };
  mod.get = () => { blocked.push(`${name}.get`); throw new Error(`blocked ${name}.get`); };
}
const childProcess = require("child_process");
const dockerCalls = [];
let dockerScript = () => ({ code: 0, stdout: "" });
childProcess.execFile = (command, args, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  const name = path.basename(String(command)).replace(/\.exe$/i, "").toLowerCase();
  if (name !== "docker") {
    blocked.push(`execFile ${name}`);
    setImmediate(() => done(Object.assign(new Error(`blocked ${name}`), { code: "ENOENT" }), "", ""));
    return { on() {}, once() {}, kill() {} };
  }
  dockerCalls.push(args.join(" "));
  const result = dockerScript(args) || { code: 0, stdout: "" };
  const error = result.code ? Object.assign(new Error(result.stderr || "docker failed"), { code: result.code }) : null;
  setImmediate(() => done(error, result.stdout || "", result.stderr || ""));
  return { on() {}, once() {}, kill() {} };
};
for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFileSync", "fork"]) {
  childProcess[fn] = (command) => { blocked.push(`${fn} ${String(command).slice(0, 40)}`); throw new Error(`blocked ${fn}`); };
}
const quiet = () => {};
console.info = quiet; console.warn = quiet; console.debug = quiet;

const repo = path.resolve(__dirname, "..");
const jobLifecycle = require(path.join(repo, "src/shared/instances/jobLifecycle"));
jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(process.env.AGENT_INSTANCE_ROOT, "jobs") });
const agentClient = require(path.join(repo, "src/services/agentClient"));
const marketplaceInstallService = require(path.join(repo, "src/services/marketplaceInstallService"));
const marketplaceService = require(path.join(repo, "src/services/marketplaceService"));
const { resolveTemplateDependencyIds } = require(path.join(repo, "src/shared/marketplaceDependencies"));
const dockerService = require(path.join(repo, "src/shared/dockerService"));
const dependencyService = require(path.join(repo, "agent/src/services/dependencyService"));

const templates = JSON.parse(fs.readFileSync(path.join(repo, "config/marketplace-templates.json"), "utf8"));
const template = (id) => templates.find((entry) => entry.id === id);
const RENDERER_OPTIONS = { version: "", providerVersionId: "", serverType: "", storageLocation: "data", memory: "", ports: [], playitTunnel: false, acceptEula: false, start: true };

async function main() {
  // M1
  let executes = 0;
  agentClient.repairLegacySteamCmdMetadata = async () => ({ repaired: false });
  agentClient.beginSteamCmdUpdateSession = async (_id, payload) => ({ token: "t", operationId: payload.operationId });
  agentClient.executeSteamCmdUpdate = async () => { executes += 1; return { buildIdBefore: String(999 + executes), buildIdAfter: String(1000 + executes), buildChanged: true }; };
  agentClient.getSteamCmdUpdateStatus = async () => ({ stage: "updating", percent: 50 });
  agentClient.closeSteamCmdUpdateSession = async () => ({ closed: true });
  const update1 = await marketplaceInstallService.updateSteamCmdInstance({ nodeId: "application-host", instanceId: "palworld" });
  const update2 = await marketplaceInstallService.updateSteamCmdInstance({ nodeId: "application-host", instanceId: "palworld" });
  assert.strictEqual(executes, 2, "the second update runs SteamCMD again");
  assert.notStrictEqual(update1.operationId, update2.operationId, "each update is its own operation");
  assert.strictEqual(update2.result.buildIdAfter, "1002", "the second update reports its own build");
  console.log("PASS M1 a second SteamCMD update runs SteamCMD again");

  // M2
  const created = [];
  agentClient.createDockerContainer = async (payload) => { created.push(payload); return { container: { id: `cid-${created.length}`, name: payload.name } }; };
  await marketplaceService.installTemplate({ templateId: "docker-nginx", nodeId: "application-host", requestId: "r1", options: { ...RENDERER_OPTIONS, name: "web" } });
  await marketplaceService.installTemplate({ templateId: "docker-nginx", nodeId: "application-host", requestId: "r2", options: { ...RENDERER_OPTIONS, name: "web", port: 8081, ports: [8081] } });
  assert.strictEqual(created.length, 2, "reinstalling a same-name server creates it again");
  assert.deepStrictEqual(created[0].ports, ["8080:80"], "no chosen port keeps the template mapping");
  assert.deepStrictEqual(created[1].ports, ["8081:80"], "the chosen host port is published on the template's container port");
  const map = marketplaceService._test.buildDockerTemplatePortMappings;
  assert.deepStrictEqual(map(["19132:19132/udp"], [19133]), ["19133:19132/udp"], "the protocol is kept");
  assert.deepStrictEqual(map(["127.0.0.1:8080:80"], [9000]), ["127.0.0.1:9000:80"], "a bind address is kept");
  console.log("PASS M2 same-name reinstalls run again and Docker templates use the chosen port");

  // M3
  const resolve = marketplaceService._test.resolveTemplateForPlatform;
  assert.deepStrictEqual(resolveTemplateDependencyIds(resolve(template("terraria-tshock"), "windows")), ["dotnet-runtime"], "Windows TShock needs only .NET");
  const fivemWindows = resolveTemplateDependencyIds(resolve(template("fivem"), "windows"));
  assert.ok(fivemWindows.includes("tar") && !fivemWindows.includes("unzip") && !fivemWindows.includes("xz"), `Windows FiveM needs tar for the resource pack only (${fivemWindows})`);
  const fivemLinux = resolveTemplateDependencyIds(resolve(template("fivem"), "linux"));
  assert.ok(["unzip", "tar", "xz"].every((id) => fivemLinux.includes(id)), `Linux keeps the archive tools (${fivemLinux})`);
  assert.ok(resolveTemplateDependencyIds(template("terraria-tshock")).includes("unzip"), "a template without a resolved platform keeps the Linux tool set");
  const routerSource = fs.readFileSync(path.join(repo, "src/services/serviceRouter.js"), "utf8");
  assert.ok(/resolveTemplateForNode\(rawTemplate, getRequestNodeId\(options\)\)/.test(routerSource), "the start gate resolves the node's template variant");
  console.log("PASS M3 Windows TShock and FiveM no longer require the Linux-only unzip");

  // M4
  const runtimes = [
    "Microsoft.AspNetCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]",
    "Microsoft.AspNetCore.App 8.0.11 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]",
    "Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
    "Microsoft.NETCore.App 8.0.11 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
    "Microsoft.WindowsDesktop.App 6.0.36 [C:\\Program Files\\dotnet\\shared\\Microsoft.WindowsDesktop.App]",
    "Microsoft.WindowsDesktop.App 8.0.11 [C:\\Program Files\\dotnet\\shared\\Microsoft.WindowsDesktop.App]",
  ].join("\n");
  const strip = (value) => path.basename(String(value || "")).replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
  dependencyService.__setTestHooks({
    readFileText: (filePath) => { if (filePath === "/etc/os-release") return "ID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\n"; throw new Error(`unexpected read ${filePath}`); },
    accessExecutable: (filePath) => { if (strip(filePath) === "dotnet") return; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    commandRunner: async (command, args = []) => (strip(command) === "dotnet" && args[0] === "--list-runtimes"
      ? { ok: true, exitCode: 0, stdout: runtimes, stderr: "" }
      : { ok: false, exitCode: 1, stdout: "", stderr: "unexpected command" }),
  });
  const check = await dependencyService.checkDependencies({ dependencyIds: ["dotnet-runtime", "dotnet-desktop-runtime"] });
  for (const id of ["dotnet-runtime", "dotnet-desktop-runtime"]) {
    const entry = check.dependencies.find((dependency) => dependency.id === id);
    assert.strictEqual(entry.version, "8.0.11", `${id} reports the highest installed runtime (${entry.version})`);
    assert.notStrictEqual(entry.state, "update-required", `${id} is not reported as too old`);
  }
  console.log("PASS M4 the .NET check reads the highest installed runtime");

  // M5
  dockerCalls.length = 0;
  dockerScript = (args) => (args[0] === "start"
    ? { code: 1, stderr: "Error response from daemon: driver failed programming external connectivity on endpoint web: Bind for 0.0.0.0:8080 failed: port is already allocated\nError: failed to start containers: web" }
    : { code: 0, stdout: args[0] === "create" ? "abc123" : "" });
  await assert.rejects(dockerService.createContainer({ name: "web", image: "nginx:stable-alpine", start: true }), (error) => {
    assert.strictEqual(error.code, "DOCKER_COMMAND_FAILED");
    assert.match(error.message, /port is already allocated/, "the daemon's reason reaches the user");
    return true;
  });
  assert.deepStrictEqual(dockerCalls.map((call) => call.split(" ")[0]), ["create", "start", "rm"], "the container created by this call is removed after a failed start");
  assert.ok(dockerCalls[2] === "rm -f web", dockerCalls[2]);
  dockerScript = (args) => (args[0] === "logs"
    ? { code: 0, stdout: "2026-11-14T10:00:00.000000002Z GET / 200", stderr: "2026-11-14T10:00:00.000000001Z [emerg] unknown directive" }
    : { code: 0, stdout: "" });
  const logs = await dockerService.getContainerLogs("web", { tail: 50 });
  assert.strictEqual(logs.logs, "[emerg] unknown directive\nGET / 200", "stderr lines appear, in time order, without timestamps");
  const stamped = await dockerService.getContainerLogs("web", { tail: 50, timestamps: true });
  assert.ok(stamped.logs.startsWith("2026-11-14T10:00:00.000000001Z [emerg]"), "timestamps stay when asked for");
  console.log("PASS M5 a failed start cleans up and explains itself; logs include stderr");

  // M6
  dockerCalls.length = 0;
  dockerScript = (args) => {
    if (args[0] !== "exec") return { code: 0, stdout: "" };
    if (args[2] === "bash") return { code: 126, stderr: "OCI runtime exec failed: exec failed: unable to start container process: exec: \"bash\": executable file not found in $PATH: unknown" };
    if (args[4] === "ls /missing") return { code: 2, stderr: "ls: /missing: No such file or directory" };
    return { code: 0, stdout: "nginx: configuration file /etc/nginx/nginx.conf test is successful" };
  };
  const ran = await dockerService.execContainer("web", { command: "nginx -t" });
  assert.strictEqual(ran.shell, "sh", "an image without bash falls back to sh");
  assert.match(ran.output, /test is successful/);
  const failed = await dockerService.execContainer("web", { command: "ls /missing", shell: "sh" });
  assert.strictEqual(failed.exitCode, 2, "a failing command is a result with its exit code");
  assert.match(failed.errorOutput, /No such file or directory/);
  const classify = dockerService.classifyDockerFailure;
  assert.notStrictEqual(classify({ errorCode: 1, stderr: "Error response from daemon: failed to create task for container: exec: \"/entrypoint.sh\": stat /entrypoint.sh: no such file or directory" }).code, "DOCKER_NOT_INSTALLED", "a missing entrypoint is not a missing Docker");
  assert.notStrictEqual(classify({ errorCode: 1, stderr: "cat: /root/secret: Permission denied" }).code, "DOCKER_PERMISSION_DENIED", "a container file permission is not a Docker permission problem");
  assert.strictEqual(classify({ errorCode: null, stderr: "bash: docker: command not found" }).code, "DOCKER_NOT_INSTALLED", "a shell that cannot find docker still means not installed");
  console.log("PASS M6 the container terminal falls back to sh and reports command results");

  assert.deepStrictEqual(blocked.filter((entry) => !/^execFile /.test(entry)), [], `no network or process escaped: ${blocked.join(", ")}`);
  console.log("Docker and marketplace engine smoke passed (6 checks).");
}

main()
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });
