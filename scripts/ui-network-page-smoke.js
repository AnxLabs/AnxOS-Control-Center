const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
// Normalize CRLF to LF so assertions match on both Unix and Windows checkouts
// regardless of Git autocrlf, matching scripts/ui-polish-smoke.js.
const normalize = (value) => value.replace(/\r\n/g, "\n");
const readSource = (relativePath) => normalize(fs.readFileSync(path.join(root, relativePath), "utf8"));

const index = readSource("index.html");
const app = readSource("app.js");
const styles = readSource("styles.css");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const countMatches = (source, pattern) => (source.match(pattern) || []).length;
// The negative lookahead keeps prefix-shaped hooks distinct: data-network-graph
// must not be satisfied by data-network-graph-empty.
const assertOnce = (source, hook, label) => {
  const pattern = new RegExp(`${escapeRegExp(hook)}(?![\\w-])`, "g");
  assert.strictEqual(countMatches(source, pattern), 1, `${label} must appear exactly once in index.html: ${hook}`);
};

// ---------------------------------------------------------------------------
// 1. Sidebar navigation
// ---------------------------------------------------------------------------
const navStart = index.indexOf('id="app-sidebar-nav"');
assert(navStart > -1, "Sidebar navigation container (#app-sidebar-nav) must exist.");
const navEnd = index.indexOf("</nav>", navStart);
const navSource = index.slice(navStart, navEnd === -1 ? index.length : navEnd);
assert(navSource.includes('data-page-target="network"'), "Sidebar must expose the Network page target.");
assert(navSource.includes('data-page-label="Network"'), "Network nav item must declare data-page-label.");
assert(
  navSource.includes('data-nav-description="Endpoints, providers and connectivity"'),
  "Network nav item must carry the standardized description.",
);
const nodesNavAt = navSource.indexOf('data-page-target="nodes"');
const networkNavAt = navSource.indexOf('data-page-target="network"');
assert(nodesNavAt > -1 && networkNavAt > nodesNavAt, "The Network nav item must follow the Nodes nav item.");

// ---------------------------------------------------------------------------
// 2. Page section and every data hook exactly once
// ---------------------------------------------------------------------------
assert(index.includes('data-page="network">') || index.includes('data-page="network" '), "Missing Network workspace root.");
const networkPageStart = index.indexOf('data-page="network"');
const nextPageAt = index.indexOf('<section class="page"', networkPageStart + 1);
assert(nextPageAt > networkPageStart, "The Network page section must be a top-level page section.");
const networkPageSource = index.slice(networkPageStart, nextPageAt);

[
  "data-network-shell",
  "data-network-providers",
  "data-network-providers-empty",
  "data-network-loading",
  "data-network-empty",
  "data-network-endpoint-list",
  "data-network-status",
  "data-network-diagnostics",
  "data-diagnostics-summary",
  "data-diagnostics-scopes",
  "data-diagnostics-stages",
  "data-network-graph",
  "data-network-graph-empty",
].forEach((hook) => assertOnce(networkPageSource, hook, "Network page hook"));

[
  'data-network-summary="endpoints"',
  'data-network-summary="enabled"',
  'data-network-summary="issues"',
  'data-network-summary="providers"',
  'data-network-action="refresh"',
  'data-network-action="add-endpoint"',
  'data-network-action="sync-provider"',
  'data-network-action="run-diagnostics"',
].forEach((hook) => assertOnce(networkPageSource, hook, "Network page hook"));

assert(
  networkPageSource.includes('role="status" aria-live="polite"'),
  "The endpoint status line must be a polite live region.",
);
assert(networkPageSource.includes('data-network-diagnostics hidden'), "The diagnostics panel must start hidden.");
assert(
  /data-network-graph-empty[^>]*>Run diagnostics to build the connectivity graph\.</.test(networkPageSource),
  "The graph empty state must instruct the operator to run diagnostics.",
);

// ---------------------------------------------------------------------------
// 3. Endpoint modal markup, roles, and field hooks
// ---------------------------------------------------------------------------
const modalStart = index.indexOf("data-endpoint-modal");
assert(modalStart > -1, "Missing endpoint modal backdrop.");
const modalEnd = index.indexOf('<div class="app-modal-backdrop app-modal-backdrop--drawer"', modalStart);
assert(modalEnd > modalStart, "The endpoint modal must appear before the node details drawer.");
const modalSource = index.slice(modalStart, modalEnd);
assert(modalSource.includes('role="dialog" aria-modal="true"'), "The endpoint modal must be a modal dialog.");
assert(modalSource.includes('aria-labelledby="endpoint-modal-title"'), "The endpoint modal must be labelled by its title.");
assert(modalSource.includes('id="endpoint-modal-title"'), "The endpoint modal title id must exist.");
assert(modalSource.includes('data-endpoint-modal-title'), "The endpoint modal title must be addressable for create/edit text.");
assert(modalSource.includes('tabindex="-1"'), "The endpoint modal must be programmatically focusable.");
assert(
  modalSource.includes('class="app-modal__close"') && /aria-label="[^"]+"/.test(modalSource),
  "The endpoint modal close button must be an app-modal__close with an accessible name.",
);
["cancel", "save"].forEach((action) => {
  assert(
    modalSource.includes(`data-endpoint-modal-action="${action}"`),
    `The endpoint modal must expose the ${action} action.`,
  );
});
assert(modalSource.includes("data-endpoint-form") , "The endpoint modal must contain its form.");
assert(
  modalSource.includes("data-endpoint-form-error") && modalSource.includes('role="alert"') && modalSource.includes("hidden"),
  "The endpoint form error region must be a hidden role=alert element.",
);
["id", "name", "type", "host", "port", "protocol", "providerId", "serviceId", "computerId", "notes", "enabled"].forEach(
  (field) => {
    assertOnce(modalSource, `data-endpoint-input="${field}"`, `Endpoint form field ${field}`);
  },
);

// ---------------------------------------------------------------------------
// 4. Shared script order: healthModel -> connectivityDiagnostics ->
//    connectivityPresentation -> app.js
// ---------------------------------------------------------------------------
const healthAt = index.indexOf('src="src/shared/healthModel.js"');
const diagnosticsAt = index.indexOf('src="src/shared/connectivityDiagnostics.js"');
const presentationAt = index.indexOf('src="src/shared/connectivityPresentation.js"');
const appScriptAt = index.indexOf('src="app.js"');
assert(healthAt > -1 && diagnosticsAt > healthAt, "healthModel.js must load before connectivityDiagnostics.js.");
assert(presentationAt > diagnosticsAt, "connectivityDiagnostics.js must load before connectivityPresentation.js.");
assert(appScriptAt > presentationAt, "connectivityPresentation.js must load before app.js.");
const presentationTagEnd = index.indexOf("</script>", presentationAt);
const nextScriptAt = index.indexOf("<script", presentationTagEnd);
assert(nextScriptAt > -1 && index.slice(nextScriptAt, nextScriptAt + 60).includes('src="app.js"'), "app.js must be the script tag immediately after connectivityPresentation.js.");

// ---------------------------------------------------------------------------
// 5. Renderer state and frozen function surface
// ---------------------------------------------------------------------------
assert(app.includes("let networkState = {"), "app.js must declare networkState.");
[
  "endpoints: []",
  "summary: null",
  "providers: null",
  "providerSyncs: null",
  "diagnostics: null",
  "selectedEndpointId: null",
  "loading: false",
  "requestId: 0",
  "lastError: null",
  "degraded: false",
].forEach((key) => assert(app.includes(key), `networkState must keep the frozen key: ${key}`));

[
  "refreshNetworkPage",
  "renderNetworkSummary",
  "renderNetworkProviders",
  "renderNetworkEndpoints",
  "buildNetworkEndpointCard",
  "formatNetworkAddress",
  "handleNetworkEndpointAction",
  "openEndpointModal",
  "closeEndpointModal",
  "submitEndpointForm",
  "copyNetworkEndpointAddress",
  "testNetworkEndpoint",
  "runNetworkDiagnostics",
  "syncNetworkProviders",
  "renderNetworkDiagnostics",
  "renderNetworkGraph",
  "updateNetworkToolbarState",
].forEach((name) => assert(app.includes(`function ${name}(`), `app.js must define ${name}().`));

assert(app.includes("PAGE_INTRODUCTIONS") && app.includes("network: [\"Endpoints and connectivity\""), "PAGE_INTRODUCTIONS must include the network entry.");
assert(app.includes('"nodes",\n  "network",'), "PRIMARY_NAVIGATION_ORDER must include network after nodes.");

// ---------------------------------------------------------------------------
// 6. Wiring: showPage, refreshActiveWorkspace, refresh task, delegation,
//    modal lifecycle, delete confirmation
// ---------------------------------------------------------------------------
assert(app.includes('if (safePageName === "network")'), "showPage() must trigger the Network refresh.");
assert(app.includes('case "network":'), "refreshActiveWorkspace() must refresh the Network page.");
assert(
  app.includes("refreshTasks = [refreshNetworkPage({ force: true })]"),
  "refreshActiveWorkspace() must force-refresh the Network page.",
);
assert(
  /registerRefreshTask\(\(\) => \{[\s\S]{0,400}getActivePageName\(\) === "network"[\s\S]{0,200}\}, 15000\);/.test(app),
  "The bootstrap must register a 15000 ms Network refresh task.",
);
assert(app.includes("networkActionButtons.forEach"), "The Network toolbar must be wired by delegation.");
assert(app.includes("button.dataset.networkAction"), "Toolbar delegation must read data-network-action.");
assert(app.includes("networkEndpointList?.addEventListener"), "Endpoint card actions must be delegated from the list container.");
assert(app.includes("handleNetworkEndpointAction(actionButton.dataset.endpointAction, actionButton.dataset.endpointId)"), "Endpoint delegation must pass action and endpoint id.");
assert(app.includes("networkDiagnosticsStages?.addEventListener"), "Diagnostics stage actions must be delegated.");
assert(app.includes("networkGraphPanel?.addEventListener"), "Graph nodes must be selectable through delegation.");
assert(app.includes("endpointForm?.addEventListener(\"submit\", submitEndpointForm)"), "The endpoint form submit must be wired.");
assert(app.includes("activateModal(endpointModal"), "The endpoint modal must use the shared modal lifecycle.");
assert(app.includes("[data-endpoint-modal-action=\"save\"]"), "The endpoint modal save action must be wired.");
assert(app.includes("closeEndpointModal"), "The endpoint modal close path must exist.");
assert(app.includes("if (event.target === endpointModal) closeEndpointModal();"), "Backdrop click must close the endpoint modal.");
assert(
  /endpointModal\?\.addEventListener\("keydown"[\s\S]{0,200}event\.key === "Escape"[\s\S]{0,120}closeEndpointModal\(\);/.test(app),
  "Escape must close the endpoint modal.",
);
assert(app.includes("await confirmDestructiveAction({"), "Endpoint removal must use confirmDestructiveAction().");
assert(app.includes('confirmLabel: "Remove endpoint"'), "Endpoint removal must confirm with the frozen label.");
assert(!/window\.prompt|prompt\(|window\.alert|alert\(|window\.confirm|confirm\(/.test(app), "Renderer workflows must not use browser prompt, alert, or confirm dialogs (regression check).");

// ---------------------------------------------------------------------------
// 7. Data contract: desktop API calls and shared presentation usage
// ---------------------------------------------------------------------------
assert(app.includes("api.endpoints.list({ nodeId })"), "The page must list endpoints through the desktop API.");
assert(app.includes("api.providers.getStatus({ nodeId })"), "Provider status must be read through the desktop API.");
assert(app.includes("api.connectivity.runDiagnostics({"), "Diagnostics must run through connectivity.runDiagnostics().");
assert(app.includes("endpointId: endpointId || null"), "The diagnostics run must carry the scoped endpoint id.");
assert(app.includes("refresh: true"), "The diagnostics run must request a refresh.");
assert(app.includes("Unknown — provider status unavailable."), "A failed provider read must render an explicit unknown state, not hide the panel.");
assert(app.includes("summarizeConnectivity("), "Diagnostics summary must come from connectivityPresentation.summarizeConnectivity().");
assert(app.includes("formatDiagnosticsEvidence("), "Stage evidence must come from connectivityPresentation.formatDiagnosticsEvidence().");
assert(app.includes("presentation.stateLabel") || app.includes("presentation?.stateLabel"), "State pill labels must come from the shared presentation model.");
assert(app.includes("function createConnectivityPill(") && app.includes('pill.dataset.state = normalized'), "State pills must carry data-state for tone mapping.");

// ---------------------------------------------------------------------------
// 8. Rendering discipline: DOM built with createElement, never innerHTML
// ---------------------------------------------------------------------------
const regionStart = app.indexOf("function refreshNetworkPage");
const regionEnd = app.indexOf("function updateNetworkToolbarState");
assert(regionStart > -1 && regionEnd > regionStart, "The Network function region must be discoverable for the innerHTML guard.");
const networkRegion = app.slice(regionStart, regionEnd);
assert(!networkRegion.includes("innerHTML"), "Network rendering must build DOM with createElement/createTextElement, not innerHTML.");

const cardStart = app.indexOf("function buildNetworkEndpointCard");
const cardEnd = app.indexOf("async function refreshNetworkPage");
assert(cardStart > -1 && cardEnd > cardStart, "buildNetworkEndpointCard() must precede refreshNetworkPage().");
const cardRegion = app.slice(cardStart, cardEnd);
assert(cardRegion.includes('document.createElement("article")'), "Endpoint cards must be created with document.createElement.");
assert(cardRegion.includes("createTextElement"), "Endpoint card fields must be created with createTextElement.");
assert(cardRegion.includes("card.dataset.endpointId"), "Endpoint cards must expose data-endpoint-id.");
assert(cardRegion.includes("dataset.endpointField"), "Endpoint card fields must expose data-endpoint-field.");
assert(cardRegion.includes("dataset.endpointAction"), "Endpoint cards must expose data-endpoint-action buttons.");
assert(
  ["copy", "test", "edit", "toggle", "associate", "delete"].every((action) => cardRegion.includes(`action: "${action}"`)),
  "Endpoint cards must expose copy/test/edit/toggle/associate/delete actions.",
);
assert(cardRegion.includes('button.setAttribute("aria-label"'), "Endpoint action buttons must carry aria-labels.");
assert(app.includes('button.dataset.graphNode = ""'), "Graph nodes must be buttons with data-graph-node.");
assert(app.includes("button.dataset.nodeId") && app.includes("button.dataset.state") && app.includes("button.dataset.stageId"), "Graph nodes must expose node id, state, and stage id.");
assert(app.includes('button.setAttribute("aria-label", `${node?.label || "Node"}: ${networkStateLabel(state)}`)'), "Graph nodes must announce label and state label.");

// ---------------------------------------------------------------------------
// 9. Stylesheet contract
// ---------------------------------------------------------------------------
[
  ".network-shell",
  ".network-page",
  ".network-summary-grid",
  ".network-panel",
  ".network-toolbar",
  ".network-endpoint-list",
  ".network-endpoint-card",
  ".network-endpoint-card__top",
  ".network-endpoint-card__title",
  ".network-endpoint-card__meta",
  ".network-endpoint-card__actions",
  ".connectivity-state-pill",
  ".network-provider-row",
  ".network-diagnostics-stage",
  ".network-scope-row",
  ".connectivity-graph",
  ".connectivity-node",
  ".network-empty",
  ".network-loading",
].forEach((selector) => assert(styles.includes(selector), `styles.css must define ${selector}.`));

["healthy", "degraded", "failed", "unknown", "unsupported", "not_configured"].forEach((state) => {
  assert(
    styles.includes(`.connectivity-state-pill[data-state="${state}"]`),
    `styles.css must map the ${state} pill tone.`,
  );
});
assert(styles.includes(".network-diagnostics-stage.is-selected"), "The selected diagnostics stage must be highlighted.");
assert(styles.includes(".connectivity-node.is-selected"), "The selected graph node must be highlighted.");
assert(
  /@media \(max-width: 980px\) \{[\s\S]{0,200}\.network-summary-grid/.test(styles),
  "styles.css must stack the Network summary grid at 980px.",
);
assert(
  /@media \(max-width: 720px\) \{[\s\S]{0,200}\.network-summary-grid/.test(styles),
  "styles.css must stack the Network summary grid at 720px.",
);
assert(
  /html\[data-reduce-motion="true"\] \.network-endpoint-card/.test(styles),
  "Network transitions must respect reduced motion.",
);

// V2-K D1: a refresh must not erase provider last-sync records, and every
// write goes through the shared merge so the state keeps one shape.
assert(!/networkState\.providerSyncs\s*=\s*null/.test(app), "Network refresh must not reset provider sync records to null.");
assert(!/networkState\.providerSyncs\s*=(?!=)(?!\s*mergeNetworkProviderSyncs\()/.test(app), "Every provider sync write must use mergeNetworkProviderSyncs.");
assert(app.includes("last sync ${formatNetworkCheckedAt(sync.lastSyncAt)}"), "The provider detail line must show the last sync.");

console.log("Network page smoke checks passed.");
