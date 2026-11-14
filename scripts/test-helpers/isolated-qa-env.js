const fs = require("fs");
const os = require("os");
const path = require("path");

function createIsolatedQaEnv(prefix = "anx-qa-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(root, "config");
  const logDir = path.join(root, "logs");
  const tempDir = path.join(root, "tmp");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  return {
    root,
    configDir,
    logDir,
    tempDir,
    env: {
      ANXHUB_CONFIG_DIR: configDir,
      ANXOS_CONFIG_DIR: configDir,
      ANXOS_QA_CONFIG_DIR: configDir,
      ANXOS_LOG_DIR: logDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
      // Without this the QA app falls back to http://127.0.0.1:47131, which is the
      // developer's real Local Agent: every QA run sent it requests (stats,
      // backups, firewall-rule writes) that were refused only for lack of a token.
      // Port 9 (discard) on loopback is closed, so the default route fails fast.
      // A test that starts its own Agent still sets its own node URL.
      AGENT_URL: "http://127.0.0.1:9",
      TMP: tempDir,
      TEMP: tempDir,
      TMPDIR: tempDir,
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

module.exports = { createIsolatedQaEnv };
