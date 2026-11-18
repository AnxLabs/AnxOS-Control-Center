// Shared smoke helper (eb13b83 lesson): pin every runtime root a smoke could
// leak into inside one per-run temp tree. The agent-layer instance service
// re-configures the shared job store to <instanceRoot>/jobs when it loads, so
// an unpinned AGENT_INSTANCE_ROOT leaks job records into the real machine
// root and can replay succeeded jobs across runs. Call this BEFORE requiring
// any src/ service module.
//
// isolateLocalAgent (Build 214): nodeService.saveNode lists nodes with Local
// Agent discovery, which probes 127.0.0.1:47131 unless the config folder's
// agent-runtime.json names another port. A temp config folder has none, so
// every real-install harness reached the developer's real Local Agent (its
// token refused them: 3 "authorization failed" lines per run). With this
// option the temp config points discovery at a port nothing listens on.
const fs = require("fs");
const os = require("os");
const path = require("path");

// A loopback port that was free a moment ago: nothing listens on it, so a
// discovery probe is refused at once.
function closedLoopbackPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    if (port === 47131) continue;
    const probe = require("child_process").spawnSync(process.execPath, ["-e", `const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(${port},"127.0.0.1",()=>s.close(()=>process.exit(0)));`], { timeout: 5000 });
    if (probe.status === 0) return port;
  }
  return 9;
}

function pinAgentRoots(prefix = "anx-smoke-roots-", options = {}) {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.ANXHUB_CONFIG_DIR = process.env.ANXHUB_CONFIG_DIR || path.join(smokeRoot, "config");
  process.env.AGENT_INSTANCE_ROOT = path.join(smokeRoot, "instances");
  if (options.isolateLocalAgent) {
    fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
    const runtimePath = path.join(process.env.ANXHUB_CONFIG_DIR, "agent-runtime.json");
    if (!fs.existsSync(runtimePath)) {
      const { saveAgentRuntimeConfig } = require("../src/shared/agentRuntimeConfigStore");
      saveAgentRuntimeConfig(runtimePath, { port: closedLoopbackPort() });
    }
  }
  const jobLifecycle = require("../src/shared/instances/jobLifecycle");
  jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(process.env.AGENT_INSTANCE_ROOT, "jobs") });
  let cleaned = false;
  process.on("exit", () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
  });
  return smokeRoot;
}

module.exports = { pinAgentRoots };
