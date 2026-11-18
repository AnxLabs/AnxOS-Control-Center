#!/usr/bin/env node
"use strict";

// Build 214: Docker-backed Marketplace services (databases and applications).
//   S1 every Docker template in the catalog is valid, and the cards that were
//      "coming soon" are installable; unsafe Docker options make a template
//      invalid instead of installable
//   S2 an install checks the computer, downloads the image, then creates the
//      container with its volume, settings, labels and chosen port
//   S3 generated passwords differ per install, reach only the container and
//      the one-time result, and are redacted from saved records
//   S4 data from an earlier install of the same name blocks the install
//      before anything is downloaded
//   S5 a busy port blocks the install before anything is downloaded
//   S6 a failed image download creates nothing
//   S7 a container that exits right after starting fails the install, shows
//      its last output, and is removed together with the volume it created
//   S8 an Agent that cannot report container state does not fail the install
//   S10 Minecraft Bedrock is not installed until the Minecraft EULA is
//      accepted, and then gets the EULA setting and a volume for its world
//   S9 the Agent's check reads published ports as the Docker CLI prints them,
//      and a port Docker itself refuses (older Agents) is reported as a busy
//      port, with the volume the failed create left behind removed
// The Agent client is faked and the network is blocked, so no Docker engine,
// registry or computer is touched. This is not real installation acceptance.
// Run: node scripts/marketplace-docker-service-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-docker-service-"));
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
});
for (const key of ["ANXOS_CONFIG_DIR", "ANXOS_LOG_DIR", "AGENT_INSTANCE_ROOT", "AGENT_BACKUP_ROOT", "AGENT_TEMP_DIR", "AGENT_LOG_DIR"]) fs.mkdirSync(process.env[key], { recursive: true });

const blocked = [];
global.fetch = async (url) => { blocked.push(`fetch ${url}`); throw new Error(`blocked fetch ${url}`); };
for (const name of ["http", "https"]) {
  const mod = require(name);
  mod.request = () => { blocked.push(`${name}.request`); throw new Error(`blocked ${name}.request`); };
  mod.get = () => { blocked.push(`${name}.get`); throw new Error(`blocked ${name}.get`); };
}
const childProcess = require("child_process");
for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[fn] = (command) => { blocked.push(`${fn} ${String(command).slice(0, 40)}`); throw new Error(`blocked ${fn}`); };
}
const quiet = () => {};
console.info = quiet; console.warn = quiet; console.debug = quiet;

const repo = path.resolve(__dirname, "..");
const jobLifecycle = require(path.join(repo, "src/shared/instances/jobLifecycle"));
jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(process.env.AGENT_INSTANCE_ROOT, "jobs") });
const agentClient = require(path.join(repo, "src/services/agentClient"));
const marketplaceService = require(path.join(repo, "src/services/marketplaceService"));
const { validateMarketplaceCatalog, validateMarketplaceTemplate, getTemplateInstallerType } = require(path.join(repo, "src/services/marketplaceInstallerRegistry"));
const { generateSecret } = require(path.join(repo, "src/shared/marketplaceDockerTemplate"));
const { policeContainerRequest } = require(path.join(repo, "src/shared/dockerPolicy"));
const { sanitizeForDiagnostics } = require(path.join(repo, "src/shared/redaction"));

const templates = JSON.parse(fs.readFileSync(path.join(repo, "config/marketplace-templates.json"), "utf8"));
const template = (id) => templates.find((entry) => entry.id === id);
const OPTIONS = { version: "", providerVersionId: "", serverType: "", storageLocation: "data", memory: "", ports: [], playitTunnel: false, acceptEula: false, start: true };
const SERVICE_IDS = ["postgresql", "mariadb", "redis", "grafana", "prometheus", "uptime-kuma", "gitea", "nextcloud", "docker-nginx", "jellyfin"];

// A scriptable fake of the Agent's Docker API. `calls` records the order.
function fakeAgent(overrides = {}) {
  const calls = [];
  const state = { created: [], deletedContainers: [], removedVolumes: [], ...overrides };
  agentClient.preflightDockerContainer = async (payload) => {
    calls.push("preflight");
    state.preflightPayload = payload;
    return { engineAvailable: true, name: payload.name, findings: state.findings || [], policy: { allowed: true, deniedKeys: [] } };
  };
  // Each planned volume is looked up by name; listing every volume is slow.
  agentClient.listDockerVolumes = async () => { throw new Error("the install must not list every volume"); };
  agentClient.inspectDockerVolume = async (name) => {
    calls.push("volumes");
    if ((state.existingVolumes || []).includes(name)) return { volume: name, inspect: [{ Name: name }] };
    if (state.volumeError) throw new Error(state.volumeError);
    throw Object.assign(new Error(`Docker command failed: Error response from daemon: get ${name}: no such volume`), { code: "DOCKER_COMMAND_FAILED" });
  };
  agentClient.pullDockerImage = async (image) => {
    calls.push(`pull ${image}`);
    if (state.pullError) throw Object.assign(new Error(state.pullError), { code: "DOCKER_COMMAND_FAILED" });
    return { image };
  };
  agentClient.createDockerContainer = async (payload) => {
    calls.push("create");
    if (state.createError) throw Object.assign(new Error(state.createError), { code: "DOCKER_COMMAND_FAILED" });
    state.created.push(payload);
    return { container: { id: `cid-${state.created.length}`, name: payload.name, image: payload.image, started: payload.start === true } };
  };
  agentClient.inspectDockerContainer = async () => {
    calls.push("inspect");
    if (state.inspectError) throw new Error(state.inspectError);
    return { inspect: [{ State: state.containerState || { Running: true, Restarting: false, Status: "running", ExitCode: 0 } }] };
  };
  agentClient.getDockerContainerLogs = async () => { calls.push("logs"); return { logs: state.logs || "" }; };
  agentClient.execDockerContainer = async (_name, payload) => { calls.push(`exec ${payload.command}`); return { exitCode: 0, output: state.folderListing ?? "film.mkv" }; };
  agentClient.deleteDockerContainer = async (name) => {
    calls.push("delete");
    if (state.createError) throw new Error("No such container");
    state.deletedContainers.push(name);
    return { deleted: true };
  };
  agentClient.removeDockerVolume = async (name) => { calls.push("volume-rm"); state.removedVolumes.push(name); return { deleted: true }; };
  return { calls, state };
}

function install(templateId, name, extra = {}) {
  return marketplaceService.installTemplate({
    templateId,
    nodeId: "application-host",
    requestId: `r-${templateId}-${name}`,
    options: { ...OPTIONS, name, ...extra },
  });
}

async function main() {
  marketplaceService._test.setDockerVerifySettings({ attempts: 2, delayMs: 1 });

  // S1
  const catalog = validateMarketplaceCatalog(templates);
  assert.deepStrictEqual(catalog.errors, [], "the shipped catalog is valid");
  for (const id of SERVICE_IDS) {
    const entry = template(id);
    assert.ok(entry, `${id} is in the catalog`);
    assert.ok(!entry.comingSoon && !entry.disabled, `${id} is installable, not coming soon`);
    assert.strictEqual(getTemplateInstallerType(entry), "docker-image", `${id} installs through the Docker adapter`);
    assert.strictEqual(entry.workloadKind, "service", `${id} is labelled as a service`);
    assert.ok(/[:@]/.test(entry.docker.image), `${id} names an image tag`);
    assert.ok(entry.id === "docker-nginx" || /not a game server/.test(entry.configNotes), `${id} says it is not a game server`);
  }
  for (const id of ["postgresql", "mariadb", "redis", "grafana", "prometheus", "uptime-kuma", "gitea", "nextcloud"]) {
    assert.ok(template(id).docker.volumes.length > 0, `${id} keeps its data in a volume`);
  }
  // Every "coming soon" card from the start of Build 214 is now installable.
  assert.deepStrictEqual(templates.filter((entry) => entry.comingSoon).map((entry) => entry.id), [], "no card is left as coming soon");
  const base = template("postgresql");
  const unsafe = [
    { docker: { ...base.docker, privileged: true } },
    { docker: { ...base.docker, network: "host" } },
    { docker: { ...base.docker, binds: ["/:/host"] } },
    { docker: { ...base.docker, entrypoint: "/bin/sh" } },
    { docker: { ...base.docker, volumes: [{ name: "data", target: "/var/run/docker.sock:/x" }] } },
    { docker: { ...base.docker, volumes: ["/etc:/etc"] } },
    { docker: { ...base.docker, volumes: [{ name: "data", target: "/data/../etc" }] } },
    { docker: { ...base.docker, environment: { POSTGRES_PASSWORD: "{secret:missing}" } } },
    { docker: { ...base.docker, environment: { "BAD KEY": "x" } } },
    { docker: { ...base.docker, image: "postgres" }, downloadSource: { type: "docker", image: "postgres" } },
    { docker: { ...base.docker, somethingNew: true } },
  ];
  for (const change of unsafe) {
    assert.throws(() => validateMarketplaceTemplate({ ...base, ...change }), (error) => error.code === "MARKETPLACE_MANIFEST_INVALID",
      `an unsafe Docker template is invalid: ${JSON.stringify(change.docker).slice(0, 120)}`);
  }
  console.log("PASS S1 the Docker catalog is valid and unsafe Docker options are refused");

  // S2
  let agent = fakeAgent();
  const pg = await install("postgresql", "My Database", { port: 5433, ports: [5433] });
  assert.deepStrictEqual(agent.calls.slice(0, 4), ["preflight", "volumes", "pull postgres:17-alpine", "create"], `order: ${agent.calls.join(", ")}`);
  const sent = agent.state.created[0];
  assert.strictEqual(sent.name, "my-database");
  assert.deepStrictEqual(sent.ports, ["5433:5432"], "the chosen port is published on the database port");
  assert.deepStrictEqual(sent.volumes, ["my-database-data:/var/lib/postgresql/data"], "data lives in a named volume");
  assert.strictEqual(sent.labels["anxos.template"], "postgresql");
  assert.strictEqual(sent.labels["anxos.managed"], "true");
  assert.strictEqual(sent.memory, "1G");
  assert.strictEqual(sent.start, true);
  assert.ok(policeContainerRequest(sent).allowed, "the request passes the Agent's Docker policy without any grant");
  assert.strictEqual(sent.policyGrant, undefined, "no policy grant is requested");
  assert.strictEqual(agent.state.preflightPayload.environment, undefined, "the pre-install check is not sent the passwords");
  assert.deepStrictEqual(pg.volumes, [{ name: "my-database-data", target: "/var/lib/postgresql/data" }]);
  assert.strictEqual(pg.runtimeType, "docker");
  assert.ok(pg.progress.some((step) => step.label === "Download image" && step.status === "complete"));
  assert.ok(pg.progress.some((step) => step.label === "Verify installation" && step.status === "complete"));
  // Redis reads its password from the environment; it is not on the command line.
  agent = fakeAgent();
  const redis = await install("redis", "cache");
  assert.ok(!agent.state.created[0].command.join(" ").includes(redis.credentials[0].secret), "the Redis password is not in the command");
  assert.strictEqual(agent.state.created[0].environment.REDIS_PASSWORD, redis.credentials[0].secret);
  // Two published ports follow the two chosen ports.
  agent = fakeAgent();
  await install("gitea", "git", { ports: [3100, 2223] });
  assert.deepStrictEqual(agent.state.created[0].ports, ["3100:3000", "2223:22"]);
  console.log("PASS S2 an install checks, downloads, then creates the container with its volume and port");

  // S3
  assert.strictEqual(pg.credentials.length, 1);
  const secret = pg.credentials[0].secret;
  assert.match(secret, /^[A-Za-z0-9]{24}$/, "a generated password is 24 letters and digits");
  assert.strictEqual(pg.credentials[0].username, "anxos");
  assert.strictEqual(sent.environment.POSTGRES_PASSWORD, secret, "the container gets the same password the user is shown");
  agent = fakeAgent();
  const pg2 = await install("postgresql", "second-db");
  assert.notStrictEqual(pg2.credentials[0].secret, secret, "each install gets its own password");
  assert.strictEqual(new Set(Array.from({ length: 50 }, () => generateSecret())).size, 50, "generated passwords do not repeat");
  agent = fakeAgent();
  const maria = await install("mariadb", "maria");
  assert.strictEqual(maria.credentials.length, 2);
  assert.notStrictEqual(maria.credentials[0].secret, maria.credentials[1].secret, "the user and administrator passwords differ");
  const withoutCredentials = JSON.stringify({ ...pg, credentials: undefined });
  assert.ok(!withoutCredentials.includes(secret), "the password appears nowhere else in the result (progress, downloads, template)");
  assert.ok(!JSON.stringify(sanitizeForDiagnostics(pg)).includes(secret), "saved records and diagnostics redact the password");
  assert.ok(!JSON.stringify(marketplaceService.getDownloads ? marketplaceService.getDownloads({ nodeId: "application-host" }) : {}).includes(secret), "install records do not hold the password");
  console.log("PASS S3 generated passwords are per install, shown once and redacted from records");

  // S4
  agent = fakeAgent({ existingVolumes: ["old-db-data"] });
  await assert.rejects(install("postgresql", "old-db"), (error) => {
    assert.strictEqual(error.code, "DOCKER_DATA_EXISTS");
    assert.match(error.message, /earlier "old-db".*old-db-data/);
    assert.strictEqual(error.details.retryable, false);
    return true;
  });
  assert.deepStrictEqual(agent.calls, ["preflight", "volumes"], "nothing is downloaded or created over earlier data");
  // An Agent older than Build 214 answers a free name with Docker's bare "[]".
  agent = fakeAgent({ volumeError: "Docker command failed: []" });
  await install("postgresql", "older-agent-db");
  assert.ok(agent.calls.includes("create"), "a free volume name reported the older way does not block the install");
  // An unreadable answer is not treated as "no earlier data".
  agent = fakeAgent({ volumeError: "Agent request timed out" });
  await assert.rejects(install("postgresql", "unsure-db"), /timed out/);
  assert.ok(!agent.calls.includes("create"), "the install does not continue when it cannot tell whether earlier data exists");
  console.log("PASS S4 earlier data of the same name blocks the install");

  // S5
  agent = fakeAgent({ findings: [{ severity: "warning", code: "HOST_PORT_IN_USE", field: "ports", message: "Host port 3000 is already published by another container. The create may fail with a port conflict." }] });
  await assert.rejects(install("grafana", "graphs"), (error) => {
    assert.strictEqual(error.code, "PORT_IN_USE");
    assert.match(error.message, /Host port 3000 is already published by another container\. Choose another port/);
    return true;
  });
  assert.deepStrictEqual(agent.calls, ["preflight"], "a busy port stops the install before the download");
  console.log("PASS S5 a busy port blocks the install before anything is downloaded");

  // S6
  agent = fakeAgent({ pullError: "manifest unknown" });
  await assert.rejects(install("uptime-kuma", "uptime"), (error) => {
    assert.match(error.message, /manifest unknown/);
    assert.ok(!/left behind|removed/.test(error.message), "nothing was created, so nothing is reported as cleaned up");
    assert.strictEqual(error.details.stage, "Download image");
    return true;
  });
  assert.ok(!agent.calls.includes("create") && !agent.calls.includes("delete"), "a failed download creates and deletes nothing");
  console.log("PASS S6 a failed image download creates nothing");

  // S7
  agent = fakeAgent({ containerState: { Running: false, Restarting: false, Status: "exited", ExitCode: 1 }, logs: "starting\nError: Database is uninitialized\npassword=hunter2hunter2" });
  await assert.rejects(install("mariadb", "broken"), (error) => {
    assert.strictEqual(error.code, "DOCKER_CONTAINER_EXITED");
    assert.match(error.message, /stopped right after starting \(exit code 1\)/);
    assert.match(error.message, /Database is uninitialized/, "the container's last output is shown");
    assert.ok(!error.message.includes("hunter2hunter2"), "log output is redacted before it is shown");
    assert.match(error.message, /Nothing was left behind/);
    return true;
  });
  assert.deepStrictEqual(agent.state.deletedContainers, ["broken"], "the container this install created is removed");
  assert.deepStrictEqual(agent.state.removedVolumes, ["broken-data"], "the volume this install created is removed");
  console.log("PASS S7 a container that exits at once fails the install and is cleaned up");

  // S8
  agent = fakeAgent({ inspectError: "not found" });
  const kuma = await install("uptime-kuma", "uptime-ok");
  assert.ok(kuma.progress.some((step) => step.label === "Verify installation" && step.status === "skipped"), "an unknown state is reported as not checked, not as running");
  assert.deepStrictEqual(agent.state.deletedContainers, []);
  console.log("PASS S8 an Agent that cannot report container state does not fail the install");

  // S9
  const { readPublishedHostPorts } = require(path.join(repo, "src/shared/dockerService"));
  assert.deepStrictEqual(readPublishedHostPorts("0.0.0.0:3000->8080/tcp, [::]:3000->8080/tcp"), [3000], "the CLI's text form is read");
  assert.deepStrictEqual(readPublishedHostPorts("0.0.0.0:7000-7002->7000-7002/udp, 9000/tcp"), [7000, 7001, 7002], "a published range is read; an unpublished port is not");
  assert.deepStrictEqual(readPublishedHostPorts([{ PublicPort: 8080, PrivatePort: 80 }, { PrivatePort: 443 }]), [8080], "the Engine API form is still read");
  assert.deepStrictEqual(readPublishedHostPorts(""), []);
  agent = fakeAgent({ createError: "Docker command failed: Bind for 0.0.0.0:8080 failed: port is already allocated" });
  await assert.rejects(install("docker-nginx", "busy-site"), (error) => {
    assert.strictEqual(error.code, "PORT_IN_USE");
    assert.match(error.message, /already in use on this computer\. Choose another port/);
    assert.match(error.message, /Nothing was left behind/);
    return true;
  });
  assert.deepStrictEqual(agent.state.removedVolumes, ["busy-site-site"], "the volume a failed create left is removed, so a retry is not blocked by it");
  const agentServer = fs.readFileSync(path.join(repo, "agent", "src", "server.js"), "utf8");
  // Image downloads get the long request limit, not the default 2 minutes:
  // they were cut off mid-way and reported as "Agent unavailable".
  const downloadRoute = agentServer.match(/const isDockerDownload = [^;]+;/)?.[0] || "";
  const downloadPattern = new RegExp(downloadRoute.match(/\/(\\\/docker.+)\$\//)?.[1] + "$");
  for (const route of ["/api/v1/docker/images/pull", "/api/v1/docker/image/pull", "/api/v1/docker/compose/up", "/api/v1/docker/compose/pull"]) {
    assert.ok(downloadPattern.test(route), `${route} gets the long request limit`);
  }
  assert.ok(downloadPattern.test("/api/v1/docker/containers"), "container create (create, start, cleanup) gets the long limit");
  assert.ok(!downloadPattern.test("/api/v1/docker/containers/web/stop") && !downloadPattern.test("/api/v1/docker/preflight/container"), "ordinary requests keep the default limit");
  const dockerSource = fs.readFileSync(path.join(repo, "src", "shared", "dockerService.js"), "utf8");
  assert.ok(dockerSource.includes("await runDockerCommand(args, { timeout: CONTAINER_CREATE_TIMEOUT_MS })") && dockerSource.includes('await runDockerCommand(["start", name], { timeout: CONTAINER_CREATE_TIMEOUT_MS })'), "create and start are not held to the 8-second limit for quick commands");
  assert.ok(agentServer.includes("isLongInstallerOperation || isDockerDownload"), "the download routes use the 11-minute limit");
  // A port another (non-Docker) program holds is found by binding it.
  const { findHostPortsHeldByOtherPrograms } = require(path.join(repo, "src/shared/dockerService"));
  const net = require("net");
  for (const holderHost of ["0.0.0.0", "127.0.0.1"]) {
    const holder = net.createServer();
    await new Promise((done) => holder.listen(0, holderHost, done));
    const heldPort = holder.address().port;
    const held = await findHostPortsHeldByOtherPrograms([`${heldPort}:80`, `127.0.0.1:${heldPort}:8080`]);
    assert.strictEqual(held.length, 2, `a program on ${holderHost}:${heldPort} blocks both mappings`);
    await new Promise((done) => holder.close(done));
    assert.deepStrictEqual(await findHostPortsHeldByOtherPrograms([`${heldPort}:80`]), [], "a released port is free");
  }
  console.log("PASS S9 busy ports are detected, and a refused create leaves nothing behind");

  // S10
  agent = fakeAgent();
  await assert.rejects(install("docker-minecraft-bedrock", "bedrock"), (error) => {
    assert.strictEqual(error.code, "EULA_REQUIRED");
    assert.strictEqual(error.details.retryable, false);
    return true;
  });
  assert.deepStrictEqual(agent.calls, [], "nothing is checked, downloaded or created before the EULA is accepted");
  await install("docker-minecraft-bedrock", "bedrock", { acceptEula: true, port: 19140, ports: [19140] });
  const bedrock = agent.state.created[0];
  assert.strictEqual(bedrock.environment.EULA, "TRUE");
  assert.deepStrictEqual(bedrock.volumes, ["bedrock-data:/data"], "the world is kept in a volume");
  assert.deepStrictEqual(bedrock.ports, ["19140:19132/udp"]);
  const appSource = fs.readFileSync(path.join(repo, "app.js"), "utf8");
  assert.ok(appSource.includes('template?.requiresEula === "minecraft"') && appSource.includes('field === "acceptEula" && marketplaceTemplateNeedsEula(template)'), "the wizard shows and enforces the EULA box for this template");
  console.log("PASS S10 Minecraft Bedrock needs the EULA and keeps its world");

  // S11 (game templates, Build 214-D)
  const resolveConfigPath = marketplaceService._test.resolveTemplateConfigFilePath;
  const unturned = template("unturned");
  assert.strictEqual(resolveConfigPath(unturned.configFiles[0].path, unturned, { name: "My Server" }, [27015]), "server/Servers/my-server/Server/Commands.dat", "{id} names the server folder Unturned reads");
  assert.strictEqual(resolveConfigPath("server/Servers/{id}/x", unturned, { name: "../../etc" }, []), "server/Servers/etc/x", "a hostile name becomes a plain slug");
  assert.throws(() => resolveConfigPath("server/{name}/x", unturned, { name: "a" }, []), /not allowed in paths/);
  for (const id of ["v-rising", "enshrouded"]) {
    const resolveForPlatform = marketplaceService._test.resolveTemplateForPlatform;
    assert.strictEqual(resolveForPlatform(template(id), "linux").disabled, true, `${id} is unavailable on Linux computers`);
    assert.ok(!resolveForPlatform(template(id), "windows").disabled, `${id} installs on Windows computers`);
  }
  const dst = template("dont-starve-together");
  assert.deepStrictEqual(dst.defaultPorts, [10999], "DST defaults to a LAN port (10998-11018)");
  assert.strictEqual(marketplaceService._test.resolveTemplateForPlatform(dst, "linux").disabled, true, "DST on Linux is labelled untested");
  assert.deepStrictEqual(dst.configFiles.map((file) => resolveConfigPath(file.path, dst, { name: "Friends" }, [10999])), ["server/saves/Cluster/cluster.ini", "server/saves/Cluster/Master/server.ini"]);
  assert.ok(/cluster token/.test(dst.configNotes), "DST says internet play needs a Klei cluster token");
  // A hostile server name cannot add settings to a config file.
  const buildConfig = marketplaceService._test.buildConfigFileContent;
  const sdtd = template("seven-days-to-die");
  const evil = 'x"/><property name="TelnetEnabled" value="true"/><x a="';
  const xml = buildConfig(sdtd.configFiles[0], sdtd, { name: evil }, [26900]);
  assert.strictEqual((xml.match(/name="TelnetEnabled"/g) || []).length, 1, "the name cannot add a second TelnetEnabled");
  assert.ok(xml.includes('value="x&quot;/&gt;&lt;property'), "the name is escaped inside its XML value");
  const enshrouded = template("enshrouded");
  const json = JSON.parse(buildConfig(enshrouded.configFiles[0], enshrouded, { name: 'My "best"\nserver' }, [15637]));
  assert.strictEqual(json.name, 'My "best" server', "a quote stays inside the JSON name and a line break becomes a space");
  assert.strictEqual(json.queryPort, 15637);
  const ini = buildConfig(dst.configFiles[0], dst, { name: "Friends\n[NETWORK]\noffline_cluster = false" }, [10999]);
  assert.ok(!/^offline_cluster = false$/m.test(ini), "a line break in the name cannot add an INI setting");
  console.log("PASS S11 game config paths use the server folder safely; Windows-only games say so");

  // S12 Jellyfin: one media folder, read-only, with the single policy grant
  assert.ok(!template("jellyfin").comingSoon, "Jellyfin is installable");
  agent = fakeAgent();
  await assert.rejects(install("jellyfin", "films"), (error) => error.code === "HOST_FOLDER_INVALID");
  await assert.rejects(install("jellyfin", "films", { hostFolder: "/etc" }), (error) => error.code === "HOST_FOLDER_INVALID");
  assert.deepStrictEqual(agent.calls, [], "a missing or system folder is refused before anything is checked or downloaded");
  const jf = await install("jellyfin", "films", { hostFolder: "/srv/media" });
  const jfSent = agent.state.created[0];
  assert.deepStrictEqual(jfSent.binds, ["type=bind,source=/srv/media,target=/media,readonly"], "the media folder is mounted read-only");
  assert.deepStrictEqual(jfSent.policyGrant, { hostMount: true }, "only the host-folder grant is requested");
  assert.deepStrictEqual(jfSent.volumes.sort(), ["films-cache:/cache", "films-config:/config"]);
  assert.ok(policeContainerRequest(jfSent).allowed, "the Agent's Docker policy allows exactly this request");
  assert.ok(!policeContainerRequest({ ...jfSent, policyGrant: {} }).allowed, "without the grant the policy refuses the mount");
  assert.deepStrictEqual(jf.hostFolder, { source: "/srv/media", target: "/media", label: "Media folder" });
  assert.ok(jf.progress.some((step) => step.label === "Check media folder" && step.status === "complete"));
  agent = fakeAgent({ folderListing: "" });
  const empty = await install("jellyfin", "films-empty", { hostFolder: "D:\\Media" });
  assert.deepStrictEqual(agent.state.created[0].binds, ["type=bind,source=D:\\Media,target=/media,readonly"]);
  assert.ok(empty.progress.some((step) => step.label === "Check media folder" && step.status === "warning" && /is empty/.test(step.detail)), "an empty media folder is reported, not hidden");
  assert.throws(() => validateMarketplaceTemplate({ ...template("jellyfin"), docker: { ...template("jellyfin").docker, hostFolder: { ...template("jellyfin").docker.hostFolder, readOnly: false } } }), /read-only/);
  console.log("PASS S12 Jellyfin mounts one chosen folder read-only and reports an empty one");

  // S13 Utilities: IT-Tools and Stirling PDF stay private to the computer,
  // and Stirling PDF's first account gets a generated password
  agent = fakeAgent();
  await install("it-tools", "tools", { port: 9100, ports: [9100] });
  assert.deepStrictEqual(agent.state.created[0].ports, ["127.0.0.1:9100:80"], "IT-Tools is published on 127.0.0.1 only, on the chosen port");
  agent = fakeAgent();
  const pdf = await install("stirling-pdf", "pdf", { port: 9101, ports: [9101] });
  const pdfSent = agent.state.created[0];
  assert.deepStrictEqual(pdfSent.ports, ["127.0.0.1:9101:8080"], "Stirling PDF is published on 127.0.0.1 only");
  assert.strictEqual(pdfSent.environment.SECURITY_ENABLELOGIN, "true");
  assert.strictEqual(pdfSent.environment.SECURITY_INITIALLOGIN_USERNAME, "admin");
  assert.strictEqual(pdfSent.environment.SECURITY_INITIALLOGIN_PASSWORD, pdf.credentials[0].secret, "the first account uses the generated password, not a default");
  assert.match(pdf.credentials[0].secret, /^[A-Za-z0-9]{24}$/);
  for (const id of ["it-tools", "stirling-pdf"]) {
    assert.strictEqual(template(id).category, "Utilities");
    const tag = template(id).docker.image.split(":").pop();
    assert.ok(/\d/.test(tag) && !/latest|nightly/.test(tag), `${id} pins a released version (${tag})`);
  }
  console.log("PASS S13 IT-Tools and Stirling PDF are private by default; Stirling PDF has no default password");

  // S14 Immich: a shipped Compose file run through the Agent's Compose routes
  marketplaceService._test.setComposeReadySettings({ attempts: 3, delayMs: 1 });
  const composeAgent = (overrides = {}) => {
    const state = { calls: [], written: null, ...overrides };
    agentClient.preflightDockerContainer = async (payload) => { state.calls.push("preflight"); state.preflightPorts = payload.ports; return { findings: state.findings || [] }; };
    agentClient.inspectDockerVolume = async (name) => {
      state.calls.push(`volume ${name}`);
      if ((state.existingVolumes || []).includes(name)) return { volume: name };
      throw new Error(`Docker command failed: get ${name}: no such volume`);
    };
    agentClient.writeManagedComposeProject = async (payload) => { state.calls.push("write"); state.written = payload; return { projectName: payload.projectName, projectDirectory: `/srv/anxos/anxos-compose-projects/${payload.projectName}` }; };
    agentClient.dockerComposeAction = async (action, payload) => {
      state.calls.push(`compose ${action}${payload.volumes ? " volumes" : ""}`);
      if (action === "status") return { services: [{ Service: "immich-server", State: "running", Health: state.health || "healthy" }] };
      return { output: "" };
    };
    agentClient.removeManagedComposeProject = async () => { state.calls.push("remove project"); return { removed: true }; };
    return state;
  };
  assert.ok(!template("immich").comingSoon, "Immich is installable");
  let compose = composeAgent();
  const immich = await install("immich", "photos", { port: 2290, ports: [2290] });
  assert.deepStrictEqual(compose.calls, ["preflight", "volume photos_library", "volume photos_postgres", "write", "compose pull", "compose up", "compose status"]);
  assert.deepStrictEqual(compose.preflightPorts, ["2290:2283"], "the chosen port is checked against other programs");
  assert.strictEqual(compose.written.composeYaml, fs.readFileSync(path.join(repo, "config/compose/immich/docker-compose.yml"), "utf8"), "the shipped Compose file is sent unchanged");
  assert.strictEqual(compose.written.env.ANXOS_IMMICH_PORT, "2290");
  assert.ok(!("IMMICH_PORT" in compose.written.env), "the host port setting is not IMMICH_PORT, which Immich reads as its own listening port");
  assert.strictEqual(compose.written.env.IMMICH_VERSION, "v3.4.1");
  assert.match(compose.written.env.DB_PASSWORD, /^[A-Za-z0-9]{24}$/, "the database password is generated");
  assert.ok(!JSON.stringify(immich).includes(compose.written.env.DB_PASSWORD), "the database password is not in the result");
  assert.strictEqual(immich.runtimeType, "docker-compose");
  compose = composeAgent({ findings: [{ severity: "error", code: "HOST_PORT_IN_USE", message: "Port 2290 (TCP) is already used by another program on this computer. Choose another port, or stop that program first." }] });
  await assert.rejects(install("immich", "photos", { port: 2290, ports: [2290] }), (error) => error.code === "PORT_IN_USE");
  assert.deepStrictEqual(compose.calls, ["preflight"], "a busy port stops the install before anything is written");
  compose = composeAgent({ existingVolumes: ["photos_postgres"] });
  await assert.rejects(install("immich", "photos"), (error) => error.code === "DOCKER_DATA_EXISTS");
  assert.ok(!compose.calls.includes("write"), "earlier data stops the install before anything is written");
  compose = composeAgent({ health: "unhealthy" });
  await assert.rejects(install("immich", "photos"), (error) => {
    assert.strictEqual(error.code, "COMPOSE_NOT_HEALTHY");
    assert.match(error.message, /Nothing was left behind/);
    return true;
  });
  assert.deepStrictEqual(compose.calls.slice(-2), ["compose down volumes", "remove project"], "a failed start removes the project and the volumes it created");

  // The Agent writes only docker-compose.yml and .env, in its own folder.
  const managed = require(path.join(repo, "agent/src/services/managedComposeProjects"));
  const composeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-compose-root-"));
  const instancesDir = path.join(composeRoot, "instances");
  const yaml = fs.readFileSync(path.join(repo, "config/compose/immich/docker-compose.yml"), "utf8");
  const written = await managed.writeManagedComposeProject(instancesDir, { projectName: "photos", composeYaml: yaml, env: { DB_PASSWORD: "abc123", IMMICH_PORT: "2290" } });
  assert.strictEqual(written.projectDirectory, path.join(composeRoot, "anxos-compose-projects", "photos"));
  assert.deepStrictEqual(fs.readdirSync(written.projectDirectory).sort(), [".env", "docker-compose.yml"]);
  assert.strictEqual(fs.readFileSync(path.join(written.projectDirectory, ".env"), "utf8"), "DB_PASSWORD=abc123\nIMMICH_PORT=2290\n");
  await assert.rejects(managed.writeManagedComposeProject(instancesDir, { projectName: "photos", composeYaml: yaml, env: {} }), (error) => error.code === "COMPOSE_PROJECT_EXISTS", "an existing project is never overwritten");
  await assert.rejects(managed.writeManagedComposeProject(instancesDir, { projectName: "../etc", composeYaml: yaml, env: {} }), (error) => error.code === "COMPOSE_PROJECT_NAME_INVALID");
  await assert.rejects(managed.writeManagedComposeProject(instancesDir, { projectName: "evil", composeYaml: yaml, env: { X: "a\nPRIVILEGED=true" } }), (error) => error.code === "COMPOSE_ENV_INVALID");
  await assert.rejects(managed.writeManagedComposeProject(instancesDir, { projectName: "evil", composeYaml: "services:\n  x:\n    image: alpine:3\n    privileged: true\n", env: {} }), (error) => error.code === "DOCKER_POLICY_DENIED", "the Compose policy runs before anything is written");
  assert.ok(!fs.existsSync(path.join(composeRoot, "anxos-compose-projects", "evil")), "a refused project leaves no folder");
  await managed.removeManagedComposeProject(instancesDir, { projectName: "photos" });
  assert.ok(!fs.existsSync(written.projectDirectory), "removal deletes the project folder");
  fs.rmSync(composeRoot, { recursive: true, force: true });
  console.log("PASS S14 Immich installs from the shipped Compose file; the Agent writes only that project");

  assert.deepStrictEqual(blocked, [], `no network or process escaped: ${blocked.join(", ")}`);
  console.log("Marketplace Docker service smoke passed (14 checks).");
}

main()
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });
