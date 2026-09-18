const fs = require("fs");
const path = require("path");
const packageJson = require("../../package.json");
const {
  StructuredLogger,
  correlationFields,
  correlationMetadata,
  createCorrelationId,
  createCorrelationScope,
  currentCorrelation,
  currentCorrelationId,
  isCorrelationId,
  runWithCorrelationScope,
  withOperationScope,
} = require("../../../src/shared/structuredLogger");

// V2-J bullet 2: the Agent side of the shared correlation primitive. The Agent
// runs the same `StructuredLogger` implementation as the desktop main process,
// so the canonical field name (`correlationId`) and the propagation semantics
// are identical on both sides — no agent-specific correlation concept exists.
// `withOperationScope()`/`runWithCorrelationScope()` open an Agent
// request/action scope: every `logger.*` line emitted inside it carries the
// scope id, and Agent action audit lines / workload log lines stamped inside it
// join on the same value. Boundaries that only see the leaf call can read
// `currentCorrelationId()` or spread `correlationMetadata()`.
function getDirectory() {
  if (process.env.ANXOS_LOG_DIR) return process.env.ANXOS_LOG_DIR;
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  if (process.env.NODE_ENV === "development" || fs.existsSync(path.join(repositoryRoot, ".git"))) return path.join(repositoryRoot, ".dev-logs");
  return path.join(process.env.ANXHUB_CONFIG_DIR ? path.dirname(process.env.ANXHUB_CONFIG_DIR) : process.cwd(), "logs");
}

const logger = new StructuredLogger({ directory: getDirectory(), source: "agent", processName: "agent", agentVersion: packageJson.version });

module.exports = {
  correlationFields,
  correlationMetadata,
  createCorrelationId,
  createCorrelationScope,
  currentCorrelation,
  currentCorrelationId,
  getDirectory,
  isCorrelationId,
  logger,
  runWithCorrelationScope,
  withOperationScope,
};
