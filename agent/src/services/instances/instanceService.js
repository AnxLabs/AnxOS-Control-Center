const instanceService = require("../../../../src/shared/instances/instanceServiceCore");
const { getConfig } = require("../../config");

instanceService.configureInstanceService({
  getConfig,
  // Lazy: the backup service itself requires this module.
  createPreUpdateBackup: (instanceId, { buildIdBefore } = {}) => require("../backupService").createBackup({
    instanceId,
    type: "full",
    // The server is stopped for the update, so the copy is at rest.
    consistency: "crash",
    name: `Pre-update backup build ${buildIdBefore || "unknown"}`,
    createdBy: "steamcmd-update",
    reason: "pre-update",
  }),
});

module.exports = instanceService;
