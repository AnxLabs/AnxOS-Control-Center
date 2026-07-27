const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function request(url, token, pathname, options = {}) {
  const response = await fetch(`${url}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitForAgent(url, token) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await request(url, token, "/api/v1/health")).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Game-config test Agent did not become ready.");
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anx-agent-game-config-"));
  const instanceRoot = path.join(tempRoot, "instances");
  const configRoot = path.join(tempRoot, "config");
  const port = await freePort();
  const token = `game-config-${crypto.randomBytes(32).toString("base64url")}`;
  const url = `http://127.0.0.1:${port}`;
  const instanceId = "minecraft-game-config-route";
  const dataRoot = path.join(instanceRoot, instanceId, "data");
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(path.join(configRoot, "agent.json"), `${JSON.stringify({
    backendMode: "agent",
    agentUrl: url,
    agentToken: token,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(instanceRoot, instanceId, "config.json"), `${JSON.stringify({
    id: instanceId,
    displayName: "Minecraft Game Config Route",
    type: "java-app",
    game: "minecraft",
    executable: "java",
    args: ["-jar", "server.jar", "nogui"],
    workingDirectory: "data",
    state: "Stopped",
  }, null, 2)}\n`);
  await fs.writeFile(path.join(dataRoot, "server.properties"), "server-port=25565\nmotd=Route Smoke\n");

  const agent = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: path.join(rootDir, "agent"),
    env: {
      ...process.env,
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_INSTANCE_ROOT: instanceRoot,
      ANXHUB_CONFIG_DIR: configRoot,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configRoot, "agent.json"),
      ANXOS_LOG_DIR: path.join(tempRoot, "logs"),
    },
    stdio: "ignore",
  });

  try {
    await waitForAgent(url, token);
    const loaded = await request(url, token, `/api/v1/instances/${instanceId}/game-config?adapterId=minecraft`);
    assert.strictEqual(loaded.status, 200, JSON.stringify(loaded.body));
    assert.strictEqual(loaded.body.adapterId, "minecraft");
    assert.strictEqual(loaded.body.filePath, "server.properties");
    assert.strictEqual(String(loaded.body.values["server-port"]), "25565");

    const saved = await request(url, token, `/api/v1/instances/${instanceId}/game-config`, {
      method: "PUT",
      body: {
        adapterId: "minecraft",
        sourceHash: loaded.body.sourceHash,
        values: { motd: "Saved From Route" },
      },
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.values.motd, "Saved From Route");
    const text = await fs.readFile(path.join(dataRoot, "server.properties"), "utf8");
    assert(text.includes("motd=Saved From Route"), "PUT /game-config should persist server.properties through the shared config writer.");

    console.log("Agent game-config route smoke checks passed.");
  } finally {
    agent.kill("SIGTERM");
    await new Promise((resolve) => agent.once("exit", resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
