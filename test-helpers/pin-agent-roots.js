// Shared smoke helper (eb13b83 lesson): pin every runtime root a smoke could
// leak into inside one per-run temp tree. The agent-layer instance service
// re-configures the shared job store to <instanceRoot>/jobs when it loads, so
// an unpinned AGENT_INSTANCE_ROOT leaks job records into the real machine
// root and can replay succeeded jobs across runs. Call this BEFORE requiring
// any src/ service module.
const fs = require("fs");
const os = require("os");
const path = require("path");

function pinAgentRoots(prefix = "anx-smoke-roots-") {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.ANXHUB_CONFIG_DIR = process.env.ANXHUB_CONFIG_DIR || path.join(smokeRoot, "config");
  process.env.AGENT_INSTANCE_ROOT = path.join(smokeRoot, "instances");
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