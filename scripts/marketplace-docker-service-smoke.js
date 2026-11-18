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
const SERVICE_IDS = ["postgresql", "mariadb", "redis", "grafana", "prometheus", "uptime-kuma", "gitea", "nextcloud", "docker-nginx"];

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
  for (const id of ["immich", "jellyfin", "java-app"]) {
    assert.strictEqual(template(id).comingSoon, true, `${id} stays unavailable until its installer exists`);
    assert.ok(template(id).comingSoonMessage.length > 30 && !/not ready yet/.test(template(id).comingSoonMessage), `${id} says why it is unavailable`);
  }
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
  console.log("PASS S11 game config paths use the server folder safely; Windows-only games say so");

  assert.deepStrictEqual(blocked, [], `no network or process escaped: ${blocked.join(", ")}`);
  console.log("Marketplace Docker service smoke passed (11 checks).");
}

main()
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });
