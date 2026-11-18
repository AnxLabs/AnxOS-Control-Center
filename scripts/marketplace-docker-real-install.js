#!/usr/bin/env node
"use strict";

// Build 214-F: REAL installation acceptance for the Docker-backed services.
//
// This is not a smoke test and is not part of release validation. It needs a
// running Docker engine and internet access, downloads real images, and takes
// several minutes. It starts a disposable Agent on a free loopback port with
// its own temp folders, installs each service through the real Marketplace
// install path, and checks the service actually works:
//   - sign in or connect with the generated password
//   - a wrong or missing password is refused
//   - data written before a restart is still there after it
//   - a busy port and a same-name reinstall over earlier data are refused
// Everything it creates is named anx214-* and is removed at the end
// (containers, volumes, and images that were not on the computer before).
// It never touches the installed app, the real Local Agent or other computers.
//
// Run: node scripts/marketplace-docker-real-install.js [template-id ...]
//      KEEP=1 keeps containers, volumes and images for inspection.

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-docker-real-install-desktop-");

const nodeService = require("../src/services/nodeService");
const agentClient = require("../src/services/agentClient");
const marketplaceService = require("../src/services/marketplaceService");
const { generateAgentToken, writeAgentConfigToken } = require("../src/shared/agentTokenStore");

const PREFIX = "anx214-";
const OPTIONS = { version: "", providerVersionId: "", serverType: "", storageLocation: "data", memory: "", playitTunnel: false, acceptEula: false, start: true };
const results = [];
const createdNames = [];

function docker(args, { timeout = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? error.code : 0, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() });
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

async function httpGet(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, text: await response.text().catch(() => "") };
}

// Services need a moment after the container starts; poll until `check`
// returns a truthy value or the deadline passes.
async function waitFor(label, check, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} was not ready in ${Math.round(timeoutMs / 1000)} s${last ? `: ${last.message}` : ""}`);
}

const basic = (user, password) => ({ Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` });
const secretOf = (install, id) => install.credentials.find((entry) => entry.id === id)?.secret;

// One entry per service: how to prove it works, with the generated password.
const SERVICES = {
  postgresql: {
    async verify({ name, port, install }) {
      const env = { PGPASSWORD: secretOf(install, "password") };
      const psql = (sql, password = env.PGPASSWORD) => docker(["exec", "-e", `PGPASSWORD=${password}`, name, "psql", "-h", "127.0.0.1", "-U", "anxos", "-d", "anxos", "-tAc", sql]);
      await waitFor("PostgreSQL", async () => (await psql("select 1")).stdout === "1");
      // The image trusts connections made inside its own container, so the
      // password is proven the way a real client connects: from another
      // container, through the published port.
      const remote = (password) => docker(["run", "--rm", "--add-host=host.docker.internal:host-gateway", "-e", `PGPASSWORD=${password}`, install.template.docker.image,
        "psql", "-h", "host.docker.internal", "-p", String(port), "-U", "anxos", "-d", "anxos", "-tAc", "select 1"]);
      assert.strictEqual((await remote(env.PGPASSWORD)).stdout, "1", "the generated password works through the published port");
      const refused = await remote("wrong-password");
      assert.ok(!refused.ok && /password authentication failed/.test(refused.stderr), `a wrong password is refused (${refused.stderr.slice(0, 120)})`);
      assert.ok((await psql("create table anx214(v text); insert into anx214 values ('kept');")).ok);
      return { read: async () => (await psql("select v from anx214")).stdout, expected: "kept" };
    },
  },
  mariadb: {
    async verify({ name, install }) {
      const sql = (user, password, statement) => docker(["exec", "-e", `MYSQL_PWD=${password}`, name, "mariadb", "-h", "127.0.0.1", `-u${user}`, "-N", "-B", "-e", statement, ...(user === "anxos" ? ["anxos"] : [])]);
      const password = secretOf(install, "password");
      await waitFor("MariaDB", async () => (await sql("anxos", password, "select 1")).stdout === "1", { timeoutMs: 180000 });
      assert.strictEqual((await sql("root", secretOf(install, "root-password"), "select 1")).stdout, "1", "the administrator password works");
      assert.ok(!(await sql("anxos", "wrong-password", "select 1")).ok, "a wrong password is refused");
      assert.ok((await sql("anxos", password, "create table anx214(v text); insert into anx214 values ('kept');")).ok);
      return { read: async () => (await sql("anxos", password, "select v from anx214")).stdout, expected: "kept" };
    },
  },
  redis: {
    async verify({ name, install }) {
      const cli = (password, ...command) => docker(["exec", ...(password ? ["-e", `REDISCLI_AUTH=${password}`] : []), name, "redis-cli", ...command]);
      const password = secretOf(install, "password");
      await waitFor("Redis", async () => (await cli(password, "ping")).stdout === "PONG");
      assert.match((await cli(null, "ping")).stdout, /NOAUTH/, "no password is refused");
      assert.strictEqual((await cli(password, "set", "anx214", "kept")).stdout, "OK");
      return { read: async () => (await cli(password, "get", "anx214")).stdout, expected: "kept" };
    },
  },
  grafana: {
    async verify({ port, install }) {
      const password = secretOf(install, "admin-password");
      const base = `http://127.0.0.1:${port}`;
      await waitFor("Grafana", async () => (await httpGet(`${base}/api/health`)).status === 200);
      assert.strictEqual((await httpGet(`${base}/api/org`, { headers: basic("admin", password) })).status, 200, "admin signs in with the generated password");
      assert.strictEqual((await httpGet(`${base}/api/org`, { headers: basic("admin", "admin") })).status, 401, "the default admin password is refused");
      const created = await fetch(`${base}/api/folders`, { method: "POST", headers: { ...basic("admin", password), "Content-Type": "application/json" }, body: JSON.stringify({ uid: "anx214", title: "anx214 kept" }) });
      assert.strictEqual(created.status, 200, "a folder can be created");
      return {
        read: async () => { const reply = await httpGet(`${base}/api/folders/anx214`, { headers: basic("admin", password) }); return reply.status === 200 ? JSON.parse(reply.text).title : `status ${reply.status}`; },
        expected: "anx214 kept",
      };
    },
  },
  prometheus: {
    async verify({ name, port }) {
      const base = `http://127.0.0.1:${port}`;
      await waitFor("Prometheus", async () => (await httpGet(`${base}/-/ready`)).status === 200);
      const config = await docker(["exec", name, "cat", "/etc/prometheus/prometheus.yml"]);
      assert.ok(config.ok && /scrape_configs/.test(config.stdout), "the settings volume holds the image's default prometheus.yml");
      // A marker file in the data volume stands in for collected metrics.
      assert.ok((await docker(["exec", name, "sh", "-c", "echo kept > /prometheus/anx214"])).ok, "the data volume is writable");
      return { read: async () => (await docker(["exec", name, "cat", "/prometheus/anx214"])).stdout, expected: "kept" };
    },
  },
  "uptime-kuma": {
    async verify({ name, port }) {
      await waitFor("Uptime Kuma", async () => [200, 302].includes((await httpGet(`http://127.0.0.1:${port}/`)).status));
      assert.ok((await docker(["exec", name, "sh", "-c", "echo kept > /app/data/anx214"])).ok, "the data volume is writable");
      return { read: async () => (await docker(["exec", name, "cat", "/app/data/anx214"])).stdout, expected: "kept" };
    },
  },
  gitea: {
    ports: 2,
    async verify({ name, port }) {
      await waitFor("Gitea", async () => (await httpGet(`http://127.0.0.1:${port}/`)).status === 200);
      assert.ok((await docker(["exec", name, "sh", "-c", "echo kept > /data/anx214"])).ok, "the data volume is writable");
      return { read: async () => (await docker(["exec", name, "cat", "/data/anx214"])).stdout, expected: "kept" };
    },
  },
  nextcloud: {
    async verify({ name, port }) {
      const status = await waitFor("Nextcloud", async () => {
        const reply = await httpGet(`http://127.0.0.1:${port}/status.php`);
        return reply.status === 200 ? JSON.parse(reply.text) : null;
      }, { timeoutMs: 240000 });
      assert.strictEqual(status.installed, false, "Nextcloud waits for the user to finish setup in the browser");
      assert.ok((await docker(["exec", name, "sh", "-c", "echo kept > /var/www/html/anx214"])).ok, "the data volume is writable");
      return { read: async () => (await docker(["exec", name, "cat", "/var/www/html/anx214"])).stdout, expected: "kept" };
    },
  },
  "docker-nginx": {
    async verify({ name, port }) {
      await waitFor("Nginx", async () => /nginx/i.test((await httpGet(`http://127.0.0.1:${port}/`)).text));
      assert.ok((await docker(["exec", name, "sh", "-c", "echo anx214-kept > /usr/share/nginx/html/anx214.txt"])).ok, "the site volume is writable");
      return { read: async () => (await httpGet(`http://127.0.0.1:${port}/anx214.txt`)).text.trim(), expected: "anx214-kept" };
    },
  },
};

async function startAgent(agentRoot) {
  const configDir = path.join(agentRoot, "config");
  for (const dir of [configDir, path.join(agentRoot, "instances"), path.join(agentRoot, "logs")]) fs.mkdirSync(dir, { recursive: true });
  const bootstrapToken = generateAgentToken();
  writeAgentConfigToken(path.join(configDir, "agent.json"), bootstrapToken, { backendMode: "agent" });
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(repoRoot, "agent", "src", "server.js")], {
    cwd: path.join(repoRoot, "agent"),
    env: {
      ...process.env,
      ANXHUB_CONFIG_DIR: configDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_IDENTITY_PATH: path.join(configDir, "identity.json"),
      AGENT_INSTANCE_ROOT: path.join(agentRoot, "instances"),
      ANXOS_LOG_DIR: path.join(agentRoot, "logs"),
    },
    stdio: "ignore",
  });
  await waitFor("the disposable Agent", async () => (await fetch(`${url}/api/v1/health`)).ok, { timeoutMs: 20000, intervalMs: 150 });
  const registered = await nodeService.saveNode({ displayName: "Docker real-install Agent", agentUrl: url, agentToken: bootstrapToken });
  const pairing = await (await fetch(`${url}/api/v1/pairing/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await nodeService.pairNodeFromCode({ pairingCode: pairing.pairingCode });
  return { child, nodeId: registered.node.id, url };
}

function install(templateId, nodeId, name, ports) {
  return marketplaceService.installTemplate({ templateId, nodeId, requestId: `real-${name}-${Date.now()}`, options: { ...OPTIONS, name, port: ports[0], ports } });
}

async function runService(templateId, nodeId, agentConfig) {
  const spec = SERVICES[templateId];
  const name = `${PREFIX}${templateId.replace(/^docker-/, "")}`;
  const ports = [];
  for (let index = 0; index < (spec.ports || 1); index += 1) ports.push(await getFreePort());
  const started = Date.now();
  const record = { templateId, name, ports, steps: [] };
  results.push(record);
  createdNames.push(name);
  try {
    const result = await install(templateId, nodeId, name, ports);
    record.installSeconds = Math.round((Date.now() - started) / 1000);
    record.steps.push("installed");
    assert.strictEqual(result.runtimeType, "docker");
    assert.ok(result.progress.some((step) => step.label === "Verify installation" && step.status === "complete"), "the install confirmed the container runs");

    const inspect = JSON.parse((await docker(["inspect", name])).stdout)[0];
    assert.strictEqual(inspect.State.Running, true, "the container is running");
    assert.strictEqual(inspect.Config.Labels["anxos.template"], templateId, "the container is labelled with its template");
    const mounted = inspect.Mounts.filter((mount) => mount.Type === "volume").map((mount) => mount.Name).sort();
    assert.deepStrictEqual(mounted, result.volumes.map((volume) => volume.name).sort(), "every declared volume is mounted");
    record.steps.push("running with its volumes");

    const kept = await spec.verify({ name, port: ports[0], install: result });
    assert.strictEqual(await kept.read(), kept.expected, "the data is readable before the restart");
    record.steps.push(result.credentials.length ? "works with the generated password" : "works");

    await agentClient.restartDockerContainer(name, agentConfig);
    const after = await waitFor(`${templateId} after restart`, async () => { const value = await kept.read(); return value === kept.expected ? value : null; }, { timeoutMs: 180000 });
    assert.strictEqual(after, kept.expected);
    record.steps.push("data kept after restart");
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.message || error).slice(0, 600);
    const logs = await docker(["logs", "--tail", "15", name]);
    record.logs = `${logs.stdout}\n${logs.stderr}`.trim().split(/\r?\n/).slice(-15).join("\n").replace(/[A-Za-z0-9]{24}/g, "<redacted>");
  }
  console.log(`${record.ok ? "PASS" : "FAIL"} ${templateId} (${record.installSeconds ?? "?"} s install): ${record.ok ? record.steps.join("; ") : record.error}`);
  if (!record.ok && record.logs) console.log(record.logs.split("\n").map((line) => `    ${line}`).join("\n"));
  return record;
}

// Refusals that must hold on a real engine.
async function runRefusals(nodeId) {
  const nginx = results.find((entry) => entry.templateId === "docker-nginx" && entry.ok);
  if (!nginx) { console.log("SKIP refusals: Nginx did not install"); return; }
  const record = { templateId: "refusals", steps: [] };
  results.push(record);
  try {
    createdNames.push(`${PREFIX}nginx-two`);
    await assert.rejects(install("docker-nginx", nodeId, `${PREFIX}nginx-two`, nginx.ports), (error) => {
      assert.strictEqual(error.code, "PORT_IN_USE", `busy port code (${error.code}: ${error.message})`);
      return true;
    });
    assert.ok(!(await docker(["inspect", `${PREFIX}nginx-two`])).ok, "a busy port creates no container");
    assert.ok(!(await docker(["volume", "inspect", `${PREFIX}nginx-two-site`])).ok, "a busy port creates no volume");
    record.steps.push("a busy port is refused before anything is created");

    // Remove only the container: its data stays, as after a removal on the Docker page.
    assert.ok((await docker(["rm", "-f", nginx.name])).ok);
    await assert.rejects(install("docker-nginx", nodeId, nginx.name, [await getFreePort()]), (error) => {
      assert.strictEqual(error.code, "DOCKER_DATA_EXISTS", `earlier data code (${error.code}: ${error.message})`);
      return true;
    });
    assert.ok((await docker(["volume", "inspect", `${nginx.name}-site`])).ok, "the earlier data is still there");
    assert.ok(!(await docker(["inspect", nginx.name])).ok, "no container was created over the earlier data");
    record.steps.push("a same-name reinstall over earlier data is refused and the data is untouched");
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.message || error).slice(0, 600);
  }
  console.log(`${record.ok ? "PASS" : "FAIL"} refusals: ${record.ok ? record.steps.join("; ") : record.error}`);
}

async function cleanup(imagesBefore, templates) {
  if (process.env.KEEP === "1") { console.log("KEEP=1: containers, volumes and images left in place."); return; }
  for (const name of new Set(createdNames)) {
    await docker(["rm", "-f", name]);
  }
  // Exact names only: every volume this run could have created.
  const volumes = (await docker(["volume", "ls", "--format", "{{.Name}}"])).stdout.split(/\r?\n/).filter((volume) => [...new Set(createdNames)].some((name) => volume.startsWith(`${name}-`)));
  for (const volume of volumes) await docker(["volume", "rm", volume]);
  const removedImages = [];
  for (const image of new Set(templates.map((entry) => entry.docker.image))) {
    if (!imagesBefore.has(image) && (await docker(["rmi", image])).ok) removedImages.push(image);
  }
  const left = (await docker(["ps", "-a", "--filter", `name=${PREFIX}`, "--format", "{{.Names}}"])).stdout;
  const leftVolumes = (await docker(["volume", "ls", "--filter", `name=${PREFIX}`, "--format", "{{.Name}}"])).stdout;
  console.log(`Cleanup: containers left: ${left || "none"}; volumes left: ${leftVolumes || "none"}; images removed: ${removedImages.length}`);
}

async function main() {
  const engine = await docker(["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"]);
  if (!engine.ok) throw new Error(`Docker engine is not reachable: ${engine.stderr.split("\n")[0]}`);
  console.log(`Docker engine ${engine.stdout} on ${os.platform()} ${os.release()}`);
  const stale = (await docker(["ps", "-a", "--filter", `name=${PREFIX}`, "--format", "{{.Names}}"])).stdout;
  if (stale) throw new Error(`Earlier ${PREFIX}* containers exist (${stale.replace(/\s+/g, ", ")}); remove them first.`);

  const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/marketplace-templates.json"), "utf8"));
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SERVICES);
  const templates = wanted.map((id) => { const entry = catalog.find((candidate) => candidate.id === id); assert.ok(entry && SERVICES[id], `unknown service ${id}`); return entry; });
  const imagesBefore = new Set((await docker(["images", "--format", "{{.Repository}}:{{.Tag}}"])).stdout.split(/\r?\n/).filter(Boolean));

  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-docker-real-install-agent-"));
  let agent = null;
  try {
    agent = await startAgent(agentRoot);
    const agentConfig = nodeService.getNodeAgentConfig(agent.nodeId);
    console.log(`Disposable Agent at ${agent.url}`);
    for (const entry of templates) await runService(entry.id, agent.nodeId, agentConfig);
    if (wanted.includes("docker-nginx")) await runRefusals(agent.nodeId);
  } finally {
    await cleanup(imagesBefore, templates).catch((error) => console.log(`Cleanup problem: ${error.message}`));
    if (agent?.child && agent.child.exitCode === null) agent.child.kill("SIGTERM");
    try { fs.rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed.`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((error) => { console.error("real install run FAILED:", error?.stack || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 500));
