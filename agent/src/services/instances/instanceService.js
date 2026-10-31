const instanceService = require("../../../../src/shared/instances/instanceServiceCore");
const { getConfig } = require("../../config");

instanceService.configureInstanceService({
  getConfig,
  // Lazy: keeps a plain require of the instance service free of the alert store.
  onInstanceEvent: (event, details) => require("../notificationService").notify(event, details),
});

module.exports = instanceService;
