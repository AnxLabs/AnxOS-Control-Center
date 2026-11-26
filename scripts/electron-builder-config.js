const fs = require("fs");
const path = require("path");

const { getAzureSigningConfig } = require("./azure-signing-config");

function readBuildConfiguration() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  return JSON.parse(JSON.stringify(packageJson.build || {}));
}

function createElectronBuilderConfig(environment = process.env) {
  const config = readBuildConfiguration();
  const azureSignOptions = getAzureSigningConfig(environment);
  config.win = { ...(config.win || {}) };
  delete config.win.signtoolOptions;
  if (azureSignOptions) config.win.azureSignOptions = azureSignOptions;
  else delete config.win.azureSignOptions;
  // Build 216-D: the uninstall copy of AnxHost Setup goes into the app's
  // resources (resources\AnxHost Setup.exe), where the NSIS uninstaller hands
  // an interactive uninstall to it. Built by scripts/build-anxhost-setup.js.
  const maintenance = environment.ANXHOST_SETUP_MAINTENANCE_EXE;
  if (maintenance && fs.existsSync(maintenance)) {
    config.win.extraResources = [
      ...(config.win.extraResources || []),
      { from: path.dirname(maintenance), to: ".", filter: [path.basename(maintenance)] },
    ];
  }
  return config;
}

module.exports = createElectronBuilderConfig();
