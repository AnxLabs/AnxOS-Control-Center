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
      TMP: tempDir,
      TEMP: tempDir,
      TMPDIR: tempDir,
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createIsolatedQaEnv };
