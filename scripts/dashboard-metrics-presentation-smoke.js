const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const readText = (filePath) => fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
const app = readText(path.join(root, "app.js"));
const styles = readText(path.join(root, "styles.css"));
const index = readText(path.join(root, "index.html"));

function requireSource(source, needle, message) {
  assert(source.includes(needle), message || `Expected source to include ${needle}`);
}

requireSource(app, "function normalizePlatformLabel", "Dashboard must normalize platform labels.");
requireSource(app, "if (normalized === \"win32\" || normalized === \"windows\") return \"Windows\";", "win32 must render as Windows.");
requireSource(app, "if (normalized === \"darwin\" || normalized === \"macos\" || normalized === \"mac\") return \"macOS\";", "darwin must render as macOS.");
requireSource(app, "return build ? `Windows · Build ${build}` : \"Windows\";", "Windows_NT releases must render as a friendly Windows build.");
requireSource(app, "function formatDiskMountLabel", "Dashboard must use platform-aware disk terminology.");
requireSource(app, "if (label === \"Windows\") return \"Drive\";", "Windows disk label must be Drive.");
requireSource(app, "if (/^[a-zA-Z]:$/.test(value)) return `${value}\\\\`;", "Windows drive values must include a trailing backslash.");
requireSource(index, "data-field=\"diskMountLabel\"", "Disk label must be updated by renderer state.");

requireSource(app, "explicitlyUnavailable", "Temperature rendering must honor unsupported/unavailable metadata.");
requireSource(app, "unsupported|unavailable|placeholder|not[-_ ]?reported", "Unsupported temperature sources must not classify as healthy.");
requireSource(app, "number !== 0 || explicitRealZero", "Placeholder zero temperatures must not render as real readings.");
requireSource(app, "setField(\"temperature\", text)", "Temperature field must be rendered through the shared field updater.");
requireSource(app, "delete field.dataset.temperatureState", "Unavailable temperature must not keep a Cool/Warm/Hot badge state.");
requireSource(app, "getCpuTemperatureUnavailableLabel(reason, source)", "Unavailable temperature must render through bounded friendly labels.");
requireSource(app, "Unavailable on this system", "Unsupported local temperature sensors must render honestly.");
requireSource(app, "Requires sensor support", "Missing sensor support must render honestly.");
requireSource(app, "Not supported by this node", "Remote nodes without temperature support must render honestly.");

requireSource(app, "function formatRate", "Dashboard must use a consistent network rate formatter.");
requireSource(app, "formatRate(safeSnapshot.network.downloadPerSecond)", "Network download rates must use the formatter.");
requireSource(app, "formatRate(safeSnapshot.network.uploadPerSecond)", "Network upload rates must use the formatter.");

requireSource(styles, ".page[data-page=\"dashboard\"]", "Dashboard should have its own content width for wide displays.");
requireSource(styles, ".status-grid.dashboard-grid {\n  grid-template-columns: repeat(3, minmax(260px, 1fr));", "Dashboard metrics should use a three-column desktop grid.");
requireSource(styles, "align-items: start;", "Dashboard metrics should top-align cards.");
requireSource(styles, ".status-grid.dashboard-grid .status-card {\n  gap: 9px;\n  min-height: 0;\n  height: auto;", "Dashboard metric cards must be content-sized.");
requireSource(styles, ".status-grid.dashboard-grid .status-card p {\n  min-height: 0;", "Dashboard card descriptions must not reserve large blank areas.");
requireSource(styles, ".dashboard-grid {\n    grid-template-columns: repeat(2, minmax(260px, 1fr));", "Medium Dashboard layout should use two columns.");
requireSource(styles, ".status-grid.dashboard-grid,\n  .status-grid.status-grid--two", "Narrow layout must collapse dashboard metrics to one column through existing responsive rules.");

assert(!/setField\("platform",\s*safeSnapshot\.platform/.test(app), "Dashboard must not expose raw platform identifiers directly.");
assert(!/setField\("osVersion",\s*safeSnapshot\.osVersion/.test(app), "Dashboard must not expose raw Windows_NT labels directly.");

console.log("Dashboard metrics presentation smoke checks passed.");
