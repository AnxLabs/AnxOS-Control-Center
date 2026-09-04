const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
// Normalize CRLF to LF so assertions match on both Unix and Windows checkouts
// regardless of Git autocrlf; styles.css already relied on this.
const normalize = (value) => value.replace(/\r\n/g, "\n");
const readSource = (relativePath) => normalize(fs.readFileSync(path.join(root, relativePath), "utf8"));

const index = readSource("index.html");
const app = readSource("app.js");
const styles = readSource("styles.css");
const main = readSource("main.js");
const preload = readSource("preload.js");
const addStorageHtml = readSource("windows/add-storage.html");
const addStorageCss = readSource("windows/add-storage.css");

const expectedPages = ["dashboard", "amp", "playit", "coolpals", "docker", "marketplace", "instances", "ssh", "files", "console", "backups", "operations", "maintenance", "security", "owner-workspace", "agent-control", "nodes", "settings"];
expectedPages.forEach((page) => assert(index.includes(`data-page="${page}"`), `Missing workspace root: ${page}`));

function pageMarkup(page) {
  const start = index.indexOf(`data-page="${page}"`);
  assert(start >= 0, `Missing page markup: ${page}`);
  const next = index.indexOf('<section class="page"', start + 1);
  return index.slice(start, next === -1 ? index.length : next);
}

const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.strictEqual(new Set(ids).size, ids.length, "Desktop HTML must not contain duplicate IDs.");

const buttons = [...index.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
buttons.forEach(([, attributes, content]) => {
  const visibleText = content.replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, "x").trim();
  assert(visibleText || /aria-label=/.test(attributes), `Button is missing an accessible name: ${attributes}`);
});

[
  "function activateModal",
  "getModalFocusables",
  'appShell.inert = true',
  "appShell.inert = modalBackgroundWasInert",
  'event.key !== "Tab"',
  'event.key === "Escape"',
  "event.target === updateModal",
  "previousFocus?.isConnected",
].forEach((needle) => assert(app.includes(needle), `Modal lifecycle is missing: ${needle}`));

assert(index.includes('role="dialog" aria-modal="true"') && index.includes('tabindex="-1"'), "Static dialogs must be modal and programmatically focusable.");
assert(index.includes('aria-live="polite" aria-atomic="true"'), "Toast feedback must be announced atomically.");
assert(index.includes("settings-workspace") && index.includes("data-settings-category-target=\"general\"") && index.includes("data-settings-search"), "Settings workspace must expose category navigation and search.");
assert(index.includes("data-settings-category=\"updates\"") && index.includes("data-settings-category=\"integrations\""), "Settings workspace must separate Updates and Integrations categories.");
assert(app.includes("setActiveSettingsCategory") && app.includes("renderSettingsSearch") && app.includes("settingsSearchInput"), "Renderer must wire Settings category switching and search.");
assert(!/window\.prompt|prompt\(|window\.alert|alert\(|window\.confirm|confirm\(/.test(app), "Renderer workflows must not use browser prompt, alert, or confirm dialogs.");
assert(preload.includes("settings:getPreferences") && preload.includes("settings:savePreferences") && preload.includes("settings:resetPreferences"), "Preload must expose centralized settings preference IPC.");
assert(preload.includes("dependencies:plan") && app.includes("typeof api?.dependencies?.plan === \"function\""), "Dependency preparation planning must be exposed before install actions.");
assert(main.includes("registerSettingsIpc"), "Main process must register settings IPC.");
assert(main.includes("function openWorkspaceWindow") && main.includes('"marketplace", "create-server"'), "Main process must provide singleton Marketplace and Create Server workspace windows.");
assert(preload.includes("window:openWorkspace") && preload.includes("workspaceWindow:init"), "Preload must expose narrow workspace-window handoff IPC.");
assert(preload.includes("window:focusMain") && preload.includes("window:navigate"), "Dedicated workflow navigation must use narrow trusted IPC.");
assert(main.includes('ipcMain.handle("window:focusMain"'), "Main process must focus and navigate the primary window for workflow exits.");
assert(index.includes('data-workspace-nav="back"') && index.includes('data-workspace-nav="dashboard"'), "Marketplace and Create Server must expose Back and Dashboard navigation.");
assert(!index.includes("data-marketplace-loading"), "Marketplace must not render a blocking catalog loading screen.");
assert(app.includes('return !workspaceSurface && readStoredSettings()["startup.enabled"] !== false'), "Dedicated workflows must bypass the application startup splash.");
assert(app.includes("WORKSPACE_NAVIGATION_STORAGE_KEY") && app.includes('request.page === "dashboard"'), "Dashboard navigation must synchronize across independently loaded workflow windows.");
assert(styles.includes("body.workspace-window .startup-screen") && styles.includes("display: none !important"), "Workspace-window CSS must prevent startup-splash flashes.");
assert(app.includes("function openCreateServerWorkspace") && app.includes("applyWorkspaceWindowContext"), "Marketplace selection must hand off to the authoritative Create Server workspace.");
assert(app.includes("function renderMarketplacePackageDetails") && styles.includes("body.marketplace-window .marketplace-deployment-panel"), "Dedicated Marketplace must show discovery details and hide deployment configuration.");
assert(index.includes("data-create-server-step-nav") && index.includes('data-create-server-step-panel="review"') && index.includes('data-create-server-step-panel="deployment"'), "Create Server must expose a staged wizard with explicit review and deployment surfaces.");
assert(app.includes("const CREATE_SERVER_STEPS") && app.includes("function validateCreateServerStep") && app.includes("function renderCreateServerWizard"), "Create Server must use one validated universal wizard state machine.");
assert(app.includes("function normalizeCreateServerDraft") && app.includes("function validateCreateServerDraftSummary"), "Create Server must normalize every entry source before stage validation.");
assert(app.includes('openMarketplaceWizard(templateId, { source: "manual" })'), "Manual templates must enter the universal Create Server pipeline with an explicit source.");
assert(!app.includes('document.querySelector("[data-first-server-modal]")?.remove()'), "Manual template selection must use modal cleanup so the application shell is not left inert.");
assert(app.includes("const templateButton = event.target.closest(\"[data-first-server-template]\")") && app.includes("closeModal();"), "Manual template selection must close the guide through its lifecycle-safe cleanup path.");
assert(app.includes('draft.source === "marketplace" && !draft.projectId') && app.includes('draft.source === "manual" && !draft.templateId'), "Create Server validation must keep Marketplace-only identifiers out of manual template requirements.");
assert(app.includes('providerPackage\n    ? "provider-server-pack"'), "Provider packages must derive their installation strategy from the resolved server-pack pipeline.");
assert(app.includes("DEPLOYMENT_LIFECYCLE_STORAGE_KEY") && app.includes("refreshIntegratedDeploymentSurfaces"), "Completed deployments must notify every open window and refresh Dashboard, Nodes, and Instances together.");
assert(app.includes('loadOperationHistory({ recoverInterrupted: false })'), "Cross-window operation synchronization must not misclassify active work as interrupted.");
assert(app.includes("relatedInstanceId") && app.includes("relatedNodeId"), "Deployment notifications must preserve instance and node deep-link context.");
assert(app.includes("Math.max(Number(operation.percent) || 0, incomingPercent)"), "Operation progress must remain monotonic.");
assert(app.includes('Object.prototype.hasOwnProperty.call(context || {}, "template")'), "Manual Create Server entry must override a stale Marketplace query template in the singleton window.");
assert(app.includes('title: "Deployment started"') && app.includes('title: "Server ready"') && app.includes('title: "Deployment failed"'), "Create Server milestones must synchronize with Notification Center.");
assert(app.includes('createServerWizardStep = "deployment"') && app.includes("startMarketplaceInstallProgressListener"), "Create Server deployment must transition into the shared Download Manager progress pipeline.");
assert(!app.includes("Resolved server-pack metadata: file ${capability.serverPackFileId}"), "Create Server review must not expose raw provider file identifiers.");
assert(app.includes('filter((item) => !/^(?:provider file|server pack)$/i.test'), "Create Server review must omit identifier-bearing provider metadata rows.");
assert(styles.includes(".create-server-step-nav") && styles.includes(".create-server-wizard-actions") && styles.includes("position: sticky"), "Create Server must keep responsive step navigation and fixed actions visible.");
assert(index.includes("create-server-validation-message") && styles.includes(".create-server-validation-message"), "Create Server validation feedback must remain visible beside the fixed wizard actions.");
assert(app.includes("MARKETPLACE_VIEW_STATE_KEY") && app.includes("restoreMarketplaceViewState"), "Dedicated Marketplace must preserve search, filters, and scroll state.");
assert(app.includes("seenProjects") && app.includes("requestId !== marketplaceProviderRequestId"), "Marketplace search must deduplicate packages and ignore stale provider responses.");
assert(app.includes("ensureWorkspaceMarketplaceCatalog") && app.includes('instancesCreateToggleButton?.addEventListener("click", () => openCreateServerWorkspace())'), "Create Server must wait for the catalog and remain the single visible instance-creation entry point.");
assert(app.includes("project.displayName || project.name || project.title"), "Provider-template handoff must preserve the friendly Marketplace title instead of exposing a project ID.");
assert(styles.includes("body.workspace-window .sidebar") && styles.includes("body.create-server-window .marketplace-browser"), "Dedicated workspace windows must remove unrelated navigation and keep Create Server focused.");
assert(styles.includes("body.create-server-window .app-modal--first-server") && styles.includes("grid-template-columns: minmax(0, 1fr)"), "Create Server guidance must use a readable stacked header at dedicated-window widths.");
assert(styles.includes(".settings-shell:not(.settings-shell--workspace) > .settings-section--amp"), "Settings integration cards must not create implicit narrow columns inside the single-column workspace.");
assert(styles.includes(".settings-shell--workspace > .settings-section--minecraft") && styles.includes("grid-column: 1 / -1"), "Settings connection cards must remain full-width at compact desktop sizes.");
assert(index.includes("nodes-summary-grid") && index.includes('data-node-summary="online"'), "Nodes workspace must expose a compact dashboard summary.");
assert(index.includes("Switch System / Node") && index.includes("Choose a system to manage.") && index.includes("selected system"), "New-user language should consistently teach system/node terminology.");
assert(index.includes("This PC is always available.") && app.includes("This PC is ready. Add a remote Agent node") && !index.includes("This Device is always available."), "Local system copy should consistently use This PC in the desktop shell.");
assert((index.includes("Your AnxOS Overview") || index.includes("Control Center")) && index.includes("data-dashboard-friendly-grid") && index.includes("data-dashboard-next-action"), "Dashboard must include the beginner-friendly overview and next-step action.");
assert(index.includes("dashboard-context-strip") && index.includes('data-dashboard-friendly="selectedSystem"') && index.includes('data-dashboard-friendly="metricsUpdated"'), "Dashboard must show selected system and metrics freshness context.");
assert(index.includes("Setup Health") && index.includes("data-setup-health-center") && index.includes("Core setup") && index.includes("Optional features"), "Dashboard must include a setup health checklist with separate core and optional progress.");
assert(app.includes("function renderFriendlyDashboard") && app.includes("getFriendlyDashboardState") && app.includes("runDashboardFriendlyAction"), "Dashboard friendly overview must be wired to real renderer state and actions.");
assert(app.includes("const activeTarget = resolveActiveManagementTarget()") && app.includes("selectedSystemStatus: activeTarget.connectionState.label") && app.includes("const nodeHealth = getSharedNodeHealthModel(selectedNode)") && app.includes('setDashboardFriendlyField("nodeHealth"'), "Dashboard context must reuse selected target and node health state.");
assert(app.includes("function getSetupHealthState") && app.includes("getPublicAccessSetupReadiness") && app.includes("setupHealthActionState"), "Setup Health must derive from existing readiness state and keep optional features separate.");
assert(app.includes('setSetupHealthField("optionalProgress", `${optionalComplete}/${state.optional.length} complete`)'), "Setup Health optional progress must count the Optional group separately from Recommended items.");
assert(app.includes("first-server-guide-title") && app.includes("first-server-guide-description"), "First-server guide modal must have accessible title and description bindings.");
assert(styles.includes(".dashboard-welcome") && styles.includes(".dashboard-context-strip") && styles.includes(".dashboard-friendly-grid") && styles.includes(".dashboard-next-step"), "Dashboard friendly overview CSS must exist.");
assert(styles.includes(".dashboard-setup-health") && styles.includes(".setup-health-groups"), "Setup Health CSS must exist.");
assert(index.includes('data-nav-description="System overview"') && index.includes('data-nav-description="Install servers and tools"'), "Primary navigation should expose friendly expanded descriptions.");
assert(app.includes("label.dataset.navDescription") && app.includes("PAGE_INTRODUCTIONS"), "Renderer should wire nav descriptions and page introductions.");
assert(styles.includes(".page-introduction") && styles.includes(".nav-item[data-nav-description] .nav-item__label::after"), "Friendly navigation and page introduction CSS must exist.");
assert(styles.includes('.page[data-page="files"].is-active') && styles.includes("grid-template-rows: auto auto minmax(0, 1fr)") && styles.includes('.page[data-page="files"] .file-manager-shell'), "Files page introduction must occupy a normal full-width row above the Files workspace.");
assert(styles.includes('.page[data-page="files"] {\n  width: 100%;\n  max-width: none;'), "Files must use the available full-screen workspace instead of leaving a large empty column.");
assert(styles.includes('.page[data-page="backups"] .backup-summary-grid') && styles.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), "Backup summary cards must collapse before compact-window content clips.");
assert(app.includes("function getBackupErrorMessage") && app.includes("BACKUP_SOURCE_LIMIT_EXCEEDED"), "Backup failures must use friendly user-facing messages instead of raw IPC errors.");
assert(index.includes("Help and Learning") && index.includes("data-contextual-help-modal"), "Settings must include in-app Help and Learning with a contextual help modal.");
assert(app.includes("CONTEXTUAL_HELP_TOPICS") && app.includes("openContextualHelp") && app.includes("dismissContextualHelpTip"), "Contextual help must render through the reusable renderer component.");
assert(index.includes("[data-node-list]") || index.includes("data-node-list"), "Nodes workspace must expose the node card list.");
assert(index.includes("data-node-modal") && index.includes('data-node-action="open-add"'), "Nodes registration form must live in an Add Node modal.");
assert(index.includes("node-modal-layout") && index.indexOf("node-pairing-section") < index.indexOf("node-manual-section"), "Node editor modal must use a balanced pairing/manual setup layout.");
assert(index.indexOf("node-manual-section") < index.indexOf("node-form-actions"), "Node editor action buttons must stay aligned with the manual setup form.");
assert(styles.includes(".node-modal-layout") && styles.includes("grid-template-columns: minmax(260px, 0.86fr) minmax(420px, 1.4fr)"), "Node editor modal must keep a balanced two-column desktop layout.");
assert(styles.includes(".node-modal-layout > .node-pairing-section {\n  grid-column: 1;") && styles.includes(".node-modal-layout > .node-manual-section {\n  grid-column: 2;"), "Node editor sections must override unrelated Settings nth-child grid placement with modal-owned specificity.");
assert(styles.includes("@media (max-width: 1320px)") && styles.includes(".marketplace-layout {\n    grid-template-columns: minmax(0, 1fr) minmax(300px, 340px);"), "Marketplace must keep the installer visible beside the catalog at common desktop widths.");
assert(!app.includes("download.id ? `Operation: ${download.id}`"), "Download Manager logs must not expose raw operation identifiers.");
assert(styles.includes(".app-modal--node .modal-header .icon-action") && styles.includes("position: absolute") && styles.includes("right: 0"), "Node editor close button must stay aligned in the modal header.");
assert(styles.includes("@media (max-width: 900px)") && styles.includes(".node-modal-layout") && styles.includes("grid-template-columns: minmax(0, 1fr)"), "Node editor modal must collapse cleanly on smaller windows.");
assert(index.includes("data-node-details-modal") && index.includes("node-details-drawer"), "Nodes workspace must include a details drawer.");
assert(app.includes('setAttribute("aria-busy"'), "Async workspace loading must expose aria-busy.");
assert(app.includes("isNodeSwitching() || document.hidden"), "Background polling must pause while the document is hidden.");
assert(app.includes("renderNodeSummary") && app.includes("startNodeRefreshPolling"), "Nodes workspace must render summary stats and page-scoped live refresh.");
assert(app.includes("setNodeModalVisible") && app.includes("openNodeDetails") && app.includes("handleNodeCardAction"), "Nodes modal, details, and quick actions must be wired.");
assert(index.indexOf("data-development-badge") < index.indexOf("data-titlebar-connection"), "Developer Mode badge must sit beside and before the Connected badge.");
assert(index.includes('data-development-badge aria-label="Open Developer Update status"') && app.includes('developmentBadge.setAttribute("aria-label"'), "Developer update badge must keep an explicit accessible name.");
assert(app.includes('item.hidden || item.getAttribute("aria-disabled") === "true"'), "Navigation clicks must ignore hidden or disabled shell items.");
assert(app.includes('button.setAttribute("aria-current", "page")') && app.includes("owner-nav-page"), "Owner Workspace sidebar links must expose current-page state.");
assert(styles.includes("@media (max-width: 1180px)") && styles.includes(".app-titlebar__search kbd") && styles.includes("display: none"), "Titlebar shortcuts must collapse before shell controls clip.");
assert(styles.includes(".app-titlebar__search span") && styles.includes("width: 34px"), "Titlebar search actions must collapse to icon controls on compact shells.");
assert(index.includes("data-dev-update-modal") && index.includes('data-dev-update-field="branch"') && index.includes('data-dev-update-action="update"'), "Developer update modal must expose Git status and actions.");
assert(styles.includes('data-dev-state="available"') && styles.includes("devBadgePulse"), "Developer update badge must include a subtle available-update state.");
assert(app.includes("setupDeveloperUpdates") && app.includes("openDeveloperUpdateModal") && app.includes("renderDevelopmentBadge"), "Developer update badge must be wired in the renderer.");
assert(preload.includes("developerUpdates") && preload.includes("developerUpdates:check") && preload.includes("developerUpdates:restart"), "Preload must expose developer update IPC.");
const updatesIpc = fs.readFileSync(path.join(root, "src", "ipc", "updatesIpc.js"), "utf8");
assert(main.includes("DeveloperGitUpdater") && main.includes("registerDeveloperUpdatesIpc") && updatesIpc.includes("developerUpdates:restart"), "Main process must own developer update detection and restart through trusted IPC.");
assert(main.includes("requestSingleInstanceLock") && main.includes("second-instance"), "Main process must prevent duplicate desktop instances from fighting over Electron cache paths.");
[
  "function normalizeWindowStateForDisplays",
  "Saved window bounds were invalid or invisible; reset to centered default bounds.",
  "MAIN_WINDOW_SHOW_FALLBACK_MS",
  "MAIN_WINDOW_WATCHDOG_RECREATE_MS",
  "ready-to-show-timeout",
  "startup-watchdog",
  "startup-safe-mode",
  "function ensureMainWindowVisible",
  "function startMainWindowWatchdog",
  "function recreateMainWindow",
  "function createStartupDiagnosticWindow",
  "window-recreate",
  "window-recreate-unusable",
  "window-show-focus",
  "window-state-save-skipped",
  "window-startup-recovery.json",
  "recreateIfUnusable",
  "second-instance",
  "renderer-process-gone",
  "renderer-fail-load",
  "AnxOS Control Center failed to load",
].forEach((needle) => assert(main.includes(needle), `Main window launch recovery must include ${needle}.`));
assert(main.includes("show: false") && main.includes("showMainWindow(\"did-finish-load\")") && main.includes("showMainWindow(\"ready-to-show\")"), "Main window must not depend only on ready-to-show before becoming visible.");
assert(
  addStorageHtml.indexOf('class="storage-form-body"') < addStorageHtml.indexOf('class="add-storage-actions"') &&
    addStorageHtml.includes('data-storage-secret="password"') &&
    addStorageHtml.includes('data-storage-secret="privateKey"') &&
    addStorageHtml.includes('class="add-storage-actions__primary"'),
  "SFTP Add Storage modal must keep form fields in a scrollable body before a separate action footer."
);
[
  ".storage-form-body",
  "grid-template-rows: minmax(0, 1fr) auto",
  "overflow: hidden",
  "scrollbar-gutter: stable",
  ".add-storage-actions__primary",
  "justify-content: space-between",
  "@media (max-width: 620px), (max-height: 620px)",
].forEach((needle) => assert(addStorageCss.includes(needle), `SFTP Add Storage modal polish CSS is missing: ${needle}`));
assert(main.includes("getCenteredChildBounds(parent, 720, 680)") && main.includes("minWidth: 560"), "Add Storage child window must use a wider desktop layout for SFTP fields.");
assert(index.includes('data-agent-control-action="start"') && index.includes('data-agent-control-action="installService"'), "Agent Control must expose real lifecycle and service actions.");
assert(app.includes("Backup was already removed. Refreshed backup list."), "Backup UI must recover cleanly from stale already-deleted backup IDs.");
assert(fs.readFileSync(path.join(root, "src", "services", "agentControlService.js"), "utf8").includes("Run AnxOS Control Center as Administrator"), "Windows Agent service install failures must explain elevation requirements.");
assert(pageMarkup("agent-control").includes("Agent Connection") && pageMarkup("agent-control").includes('data-agent-setting="backendMode"'), "Agent configuration controls must render in Agent Control.");
assert(pageMarkup("agent-control").includes("Application Host, Local Agent, and the selected Remote Agent") && pageMarkup("agent-control").includes("data-agent-local-host-list"), "Agent Control must show the local application host separately from remote Agents.");
assert(pageMarkup("agent-control").includes("Diagnostics") && pageMarkup("agent-control").includes("Agent Connection"), "Agent Control must expose Diagnostics and Agent Connection sections.");
assert(!pageMarkup("settings").includes("data-agent-setting"), "Settings must not render the Agent configuration form.");
assert(index.includes("data-agent-log-viewer") && index.includes("data-agent-diagnostics"), "Agent Control must include logs and diagnostics.");
assert(app.includes("runAgentControlAction") && app.includes("refreshAgentControl"), "Agent Control actions must be wired in the renderer.");
assert(app.includes("startAgentControlPolling") && app.includes("agentControlRefreshInFlight"), "Agent Control polling must prevent duplicate overlapping refreshes.");
assert(app.includes("remoteDiagnosticsInFlight") && app.includes("Remote diagnostics were just captured."), "Remote Agent diagnostics capture must be guarded against repeated exports.");
assert(app.includes("function summarizeDependencyStatus") && app.includes("dependencyOperationState") && app.includes("latestDependencyNodeId"), "Prepare Node status must aggregate from current dependency snapshot and node scope.");
assert(app.includes("summary.state === \"ready\" ? \"Healthy\"") && app.includes("optional === true"), "Dependency health must treat installed required dependencies as ready and skip optional dependencies.");
assert(app.includes("function isInstanceRunningError") && app.includes("Stop and delete this running server?") && app.includes("Stop and Delete") && app.includes("Instance stopped and deleted."), "Instance delete must offer a guarded stop-then-delete retry for running instances.");
assert(app.includes("instancesForceKillButtons") && app.includes('actionName === "forceKill" && !canStopInstance(selectedInstance)') && app.includes("Instance is already stopped. Use Delete or Forget to remove it."), "Instance force-kill controls must be disabled and guarded for stopped instances.");
assert(app.includes("instancesForgetButtons") && app.includes('actionName === "forget"') && app.includes("Files may remain on disk."), "Instance UI must expose a separate metadata-only Forget fallback.");
assert(index.includes('data-instance-detail="failureReason"') && index.includes('data-instance-detail="command"'), "Instance inspector must expose failure reason and startup command details.");
assert(app.includes("function formatInstanceCommandForDisplay") && app.includes("quoteCommandPartForDisplay") && !app.includes("const command = [instance.executable, ...(Array.isArray(instance.args) ? instance.args : [])].filter(Boolean).join(\" \");"), "Instance command display must quote structured argv without whitespace-splitting it.");
assert(app.includes("formatAgentCpu") && app.includes("formatAgentMemory") && app.includes("formatAgentProcess"), "Agent Control must format normalized runtime metrics.");
assert(app.includes("agentControlLastRuntimeSnapshot"), "Agent Control must preserve brief stale metrics during transient failures.");
assert(!app.includes('"Service managed"'), "Agent Control must not render Service managed as the primary process value.");
assert(styles.includes(".agent-overview-actions .primary-button:disabled"), "Disabled lifecycle buttons must not keep the active primary styling.");
assert(styles.includes(".docker-empty-actions") && styles.includes(".docker-empty-state > *"), "Docker empty states must use non-overlapping content and action layout.");
assert(index.includes("No matching servers found") && index.includes("Try another search, clear your filters, or choose a different category."), "Marketplace empty state must explain no results and recovery.");
assert(index.includes("marketplace-readiness-strip") && index.includes('data-marketplace-readiness="dependencies"') && app.includes("function renderMarketplaceReadiness"), "Marketplace installer panel must summarize readiness before install.");
assert(index.includes("You have not installed any servers yet.") && app.includes("Install a server from the Marketplace to get started."), "Instances empty state must point new users to Marketplace.");
assert(app.includes("Docker is not installed on this system.") && app.includes("Install Docker") && app.includes("No containers yet"), "Docker empty states must distinguish missing Docker from an empty container list.");
assert(app.includes("const isInitialLoad = !latestDockerSnapshot;") && app.includes("if (isInitialLoad) {\n    setDockerEmpty(false);"), "Docker initial loading must hide the empty-state panel to prevent overlapping grouped states.");
assert(app.includes("Connect a supported system to browse its files.") && app.includes("This folder is empty"), "Files empty states must distinguish no target from an empty folder.");
assert(index.includes("No backups yet") && app.includes("Create a backup before making major server changes."), "Backups empty state must be calm and actionable.");
assert(app.includes("No access services created yet") && app.includes("Choose a provider to securely access supported services."), "Public Access empty state must explain provider setup without stale data.");
assert(app.includes("No security issues found."), "Security Center empty state must avoid warning styling for a clean state.");
assert(app.includes("function getFriendlyStatusFailureMessage") && app.includes("AMP status could not be refreshed.") && app.includes("Public Access status could not be refreshed."), "Workspace status failures must use friendly contextual messages.");
assert(app.includes("SSH profiles could not be loaded.") && app.includes("Maintenance could not inspect this item.") && app.includes("Operation stopped before a final result was reported."), "Loading, error, and failed-operation states must avoid vague Unknown error fallbacks.");
assert(styles.includes(".node-card__actions") && styles.includes(".node-details-drawer") && styles.includes("@keyframes nodeDrawerIn"), "Nodes polish CSS must include compact cards, drawer, and subtle animation.");
assert(app.includes("function isWindowsAgentNode") && app.includes("Windows Agent MVP") && app.includes("Hosting later"), "Windows Agent MVP nodes must render compact Windows badges and clear deferred-hosting copy.");
assert(app.includes("Docker Desktop or Docker Engine") && app.includes("WINDOWS_DOCKER_UNSUPPORTED"), "Windows Agent Docker controls must be conditional on supported Docker detection.");
assert(app.includes("Windows Agent MVP does not enable game-server hosting yet"), "Windows MVP nodes must not show unsupported game-server hosting as a scary health failure.");
assert(pageMarkup("operations").includes("data-operation-list") && pageMarkup("operations").includes('data-operation-filter="running"'), "Operations Center must expose filterable operation history.");
assert(pageMarkup("operations").includes('data-operation-action="clear-completed"') && pageMarkup("operations").includes("data-operation-detail"), "Operations Center must expose history cleanup and details.");
assert(app.includes("SECURE_SESSION_DECRYPT_FAILED|SECURE_SESSION_CORRUPT") && app.includes("seenLockedRecoveryFailures"), "Operations Center must normalize legacy recovery errors and collapse duplicate locked-action failures.");
assert(app.includes("function startOperation") && app.includes("function updateOperation") && app.includes("function renderOperationsCenter"), "Renderer must own centralized operation tracking.");
assert(app.includes("updateMarketplaceOperationFromEvent") && app.includes("activeMarketplaceOperationId"), "Marketplace installs must feed the Operations Center from real progress events.");
assert(styles.includes(".marketplace-readiness-strip") && styles.includes(".marketplace-readiness-strip strong"), "Marketplace readiness strip CSS must exist.");
assert(app.includes("async function clearInstanceConsole") && app.includes("Clear logs for ${selectedInstance.displayName || selectedInstance.id}?") && app.includes("createSecurityConfirmation"), "Instance console clear must use the in-app confirmation modal.");
assert(app.includes("async function clearConsoleRows") && app.includes("Clear console output?") && app.includes("Console logs cleared."), "Monitoring console clear must use the in-app confirmation modal.");
assert(styles.includes(".instance-console-toolbar") && styles.includes("position: sticky") && styles.includes(".instance-console-input") && styles.includes(".console-command-row"), "Console toolbars and command rows must remain sticky during long log sessions.");
assert(app.includes("operationId = startOperation") && app.includes("fileTransfers.set(id"), "File transfers and subsystem actions must create Operations Center entries.");
assert(styles.includes(".operations-shell") && styles.includes("@keyframes operationIndeterminate"), "Operations Center CSS must include page layout and indeterminate progress styling.");
assert(index.includes('data-files-resizer="storage" role="separator"') && index.includes('tabindex="0" aria-valuemin="220"') && app.includes("function handleFilesResizeSeparatorKeydown") && app.includes('handleFilesResizeSeparatorKeydown("explorer", event)'), "Files splitters must be keyboard-focusable and arrow-key resizable.");
assert(pageMarkup("maintenance").includes("data-maintenance-list") && pageMarkup("maintenance").includes('data-maintenance-action="scan"'), "Maintenance Center must expose real scan controls and category history.");
assert(pageMarkup("maintenance").includes('data-maintenance-action="clear-selected"') && pageMarkup("maintenance").includes('data-maintenance-action="reset-ui"'), "Maintenance Center must expose supported cleanup and UI reset actions.");
assert(app.includes("function scanMaintenanceStorage") && app.includes("function clearMaintenanceCategories") && app.includes("function resetRendererUiState"), "Renderer must wire Maintenance scan, cleanup, and safe UI state reset.");
assert(preload.includes("maintenance:scan") && preload.includes("maintenance:clear"), "Preload must expose narrow Maintenance IPC.");
assert(main.includes("registerMaintenanceIpc"), "Main process must register Maintenance IPC.");
assert(styles.includes(".maintenance-shell") && styles.includes(".maintenance-detail-list"), "Maintenance Center CSS must include page and detail styling.");
assert(index.includes("data-global-search-open") && index.includes("data-global-search-results") && index.includes("data-global-search-recents"), "Global Search must expose a visible trigger, results, and recent searches.");
assert(app.includes("function getGlobalSearchProviders") && app.includes("function runGlobalSearch") && app.includes("GLOBAL_SEARCH_RECENTS_STORAGE_KEY"), "Renderer must wire provider-based Global Search and recent search storage.");
assert(styles.includes(".global-search-dialog") && styles.includes(".global-search-result.is-active"), "Global Search CSS must include dialog and active result styling.");
assert(index.includes("data-command-palette-open") && index.includes("data-command-palette-results") && index.includes("data-command-palette-recents"), "Command Palette must expose a visible trigger, command results, and recent commands.");
assert(app.includes("function getCommandRegistry") && app.includes("function runCommandPaletteCommand") && app.includes("COMMAND_PALETTE_RECENTS_STORAGE_KEY"), "Renderer must wire a registry-backed Command Palette and recent command storage.");
assert(styles.includes(".command-palette-dialog") && styles.includes(".command-palette-result.is-active"), "Command Palette CSS must include dialog and active command styling.");
assert(pageMarkup("playit").includes("<h1>Public Access</h1>") && pageMarkup("playit").includes("data-public-access-service-card") && pageMarkup("playit").includes("data-public-access-service-actions"), "Playit workspace must be presented as Public Access with clickable service actions.");
assert(pageMarkup("playit").includes("Cloudflare Tunnel") && pageMarkup("playit").includes("Tailscale") && pageMarkup("playit").includes("AnxOS Relay"), "Public Access must show future providers as disabled options.");
assert(app.includes("hasPublicAccess") && app.includes("renderPublicAccessSnapshot") && preload.includes("publicAccess:getSnapshot") && main.includes("registerPublicAccessIpc"), "Public Access must use the provider abstraction while preserving Playit compatibility.");
assert(styles.includes('.page[data-page="instances"] .instances-controlbar {\n    grid-template-columns: repeat(3, minmax(0, 1fr));\n  }') && styles.includes('.page[data-page="instances"] .instances-controlbar .docker-actions {\n    grid-column: 1 / -1;'), "Instances responsive controls must override the desktop grid at normal restored window sizes.");
assert(styles.includes('.page[data-page="instances"] .instances-table th:first-child') && styles.includes('min-width: 180px;') && styles.includes('.page[data-page="instances"] .instance-name-cell strong'), "Instances names must retain a readable column and normal word wrapping.");
assert(styles.includes('.settings-check--toggle > span,') && styles.includes('.settings-check--toggle > small') && styles.includes('grid-column: 2;') && styles.includes('overflow-wrap: normal;'), "Settings toggles must keep labels and descriptions in the readable content column.");
assert(app.includes("function renderPublicAccessProviders") && app.includes("Tailnet-only"), "Public Access UI must render provider capability and exposure scope from the provider snapshot.");
assert(styles.includes(".public-access-grid") && styles.includes(".public-access-provider.is-disabled"), "Public Access CSS must include provider and service layout.");
assert(app.includes("function createTextElement") && app.includes("function createSecurityBadgeElement"), "Renderer must keep safe DOM helper coverage for dynamic desktop surfaces.");
assert(app.includes("pre = createTextElement(\"pre\", JSON.stringify(event.details || {}, null, 2)") && app.includes("createSvgElement(\"path\""), "High-risk diagnostics/security/icon surfaces must render through DOM APIs.");
assert(app.includes("function isConfiguredStorageRootPath") && app.includes("Configured storage roots cannot be deleted from AnxOS"), "Files UI must prevent configured storage roots from being presented as deletable items.");
assert(app.includes('/^(?:provider|unknown|n\\/a)$/i.test(text)'), "Marketplace cards must suppress internal provider placeholder versions.");
assert(
  styles.includes("body.create-server-window .create-server-wizard-actions {\n  position: static;") &&
    styles.includes("body.create-server-window .marketplace-wizard {\n  grid-template-rows: auto minmax(180px, 1fr) auto auto;\n  min-height: 0;\n  padding-bottom: 0;"),
  "Create Server actions must remain in the wizard flow so default-size windows cannot cover configuration controls.",
);

[
  "@media (max-width: 640px), (max-height: 560px)",
  "max-height: calc(100dvh - var(--titlebar-height) - 12px)",
  "overscroll-behavior: contain",
  "@media (max-width: 760px)",
  "@media (prefers-reduced-motion: reduce)",
  "button:focus-visible",
  "scrollbar-gutter: stable",
].forEach((needle) => assert(styles.includes(needle), `Shared responsive/accessibility CSS is missing: ${needle}`));

[
  "function getMarketplaceDownloadErrorSummary",
  "function getMarketplaceDownloadRecovery",
  'bar.hidden = terminal',
  'if (!terminal && download.canCancel)',
  'if (terminal && download.canRetry)',
  'marketplaceConfigInput.disabled = false',
  '"Saved key unavailable — enter a new key"',
  "function getFriendlyOperationTarget",
  "function getFriendlyOperationText",
  "A server with this name already exists.",
  "projectId|fileId|versionId",
  "Interrupted when AnxOS closed. Retry from the originating workspace.",
  "function isGenericDownloadTitle",
  "technicalDetails: failed",
].forEach((needle) => assert(app.includes(needle), `Marketplace reliability UI contract is missing: ${needle}`));

[
  ".download-item__error",
  ".download-item__logs pre",
  "grid-template-columns: auto minmax(0, 1fr) auto",
  "min-width: max-content",
  "overflow-wrap: break-word",
  ".settings-section--marketplace .settings-inline-status",
].forEach((needle) => assert(styles.includes(needle), `Download Manager responsive contract is missing: ${needle}`));

console.log("UI polish smoke checks passed.");
