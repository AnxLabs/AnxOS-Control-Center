// Sharing health for one server: can friends join, and if not, why.
//
// The renderer gathers what it already knows (server process, the game's
// listening port, Playit service and tunnel match, usable addresses) and this
// module decides the status. Side-effect free; Node smokes load the same file.
//
// Rule that matters most: an active tunnel is never reported as "ready" until
// the game itself is confirmed to accept connections. A running tunnel in
// front of a server whose port is unknown reads "Tunnel ready, game not
// verified", and a connection test (connectivity diagnostics) settles it.
(function initializeShareHealth(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxShareHealth = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createShareHealthApi() {
  "use strict";

  // Status vocabulary. Existing values are kept stable: Instances badges and
  // smokes read them.
  const STATUS = Object.freeze({
    NODE_DISCONNECTED: "Node disconnected",
    SERVER_FAILED: "Server failed",
    SERVER_STOPPED: "Server stopped",
    PORT_NOT_LISTENING: "Port not listening",
    GAME_NOT_VERIFIED: "Tunnel ready, game not verified",
    PROTOCOL_MISMATCH: "Tunnel protocol does not fit the game",
    PUBLIC_READY: "Public access ready",
    MULTIPLE_TUNNELS: "Multiple tunnels matched",
    PLAYIT_STOPPED: "Playit stopped",
    LOCAL_ONLY: "Local only",
    NO_TUNNEL: "No tunnel matched",
    READY: "Ready",
    UNKNOWN: "Unknown",
  });

  function classifyShareHealth(input = {}) {
    const {
      nodeUnavailable = false,
      processState = "unknown",
      portState = "unknown",
      playitState = "unknown",
      tunnelMatch = "unknown",
      tunnelProtocol = "unknown",
      usablePublic = false,
      usableLan = false,
      usableTailscale = false,
    } = input || {};
    if (nodeUnavailable) return STATUS.NODE_DISCONNECTED;
    if (processState === "failed") return STATUS.SERVER_FAILED;
    if (processState === "stopped") return STATUS.SERVER_STOPPED;
    if (portState === "not-listening") return STATUS.PORT_NOT_LISTENING;
    const tunnelUp = usablePublic && playitState === "running" && tunnelMatch === "matched";
    // A known wrong protocol beats everything after it: friends cannot join
    // whatever the game does. An unknown protocol is never a problem.
    if (tunnelUp && tunnelProtocol === "mismatch") return STATUS.PROTOCOL_MISMATCH;
    if (tunnelUp) return portState === "listening" ? STATUS.PUBLIC_READY : STATUS.GAME_NOT_VERIFIED;
    if (usablePublic && tunnelMatch === "multiple") return STATUS.MULTIPLE_TUNNELS;
    if (playitState === "stopped" && !usablePublic) return STATUS.PLAYIT_STOPPED;
    if (tunnelMatch === "not-matched" && !usablePublic) return usableLan || usableTailscale ? STATUS.LOCAL_ONLY : STATUS.NO_TUNNEL;
    if (usableLan || usableTailscale) return STATUS.LOCAL_ONLY;
    if (processState === "running") return STATUS.READY;
    return STATUS.UNKNOWN;
  }

  // Headline, tone and the one next step a beginner should take.
  const DESCRIPTIONS = Object.freeze({
    [STATUS.NODE_DISCONNECTED]: { tone: "planned", headline: "The computer running this server is not connected", next: "Reconnect the computer (bottom-left switcher), then check again." },
    [STATUS.SERVER_FAILED]: { tone: "critical", headline: "The server crashed or failed to start", next: "Open the server's console to see why it stopped, then start it again." },
    [STATUS.SERVER_STOPPED]: { tone: "planned", headline: "The server is stopped", next: "Start the server. Friends can only join while it is running." },
    [STATUS.PORT_NOT_LISTENING]: { tone: "warning", headline: "The server is running but not accepting connections yet", next: "Wait for it to finish starting. If this stays, check the console and that no other program uses the port." },
    [STATUS.PROTOCOL_MISMATCH]: { tone: "warning", headline: "The Playit tunnel uses a different protocol than this game", next: "On playit.gg, change this server's tunnel to the protocol shown below (or TCP+UDP), then click Test connection." },
    [STATUS.GAME_NOT_VERIFIED]: { tone: "warning", headline: "The tunnel is up, but the game has not been confirmed to answer", next: "Click Test connection to check the whole path from the internet to your game." },
    [STATUS.PUBLIC_READY]: { tone: "ok", headline: "Friends can join from anywhere", next: "Copy the public address and send it to your friends." },
    [STATUS.MULTIPLE_TUNNELS]: { tone: "warning", headline: "More than one Playit tunnel points at this port", next: "Open Sharing settings and keep one tunnel for this server." },
    [STATUS.PLAYIT_STOPPED]: { tone: "warning", headline: "Playit is stopped, so friends outside your home cannot join", next: "Start Playit in Sharing settings." },
    [STATUS.LOCAL_ONLY]: { tone: "planned", headline: "Only people on your network can join", next: "To let friends join from anywhere, set up a Playit tunnel in Sharing settings." },
    [STATUS.NO_TUNNEL]: { tone: "planned", headline: "No internet address yet", next: "Set up a Playit tunnel for this server in Sharing settings." },
    [STATUS.READY]: { tone: "planned", headline: "The server is running", next: "Click Test connection to check that friends can reach it." },
    [STATUS.UNKNOWN]: { tone: "planned", headline: "Sharing status is not known yet", next: "Click Test connection." },
  });

  function describeShareHealth(status) {
    const entry = DESCRIPTIONS[status] || DESCRIPTIONS[STATUS.UNKNOWN];
    return { status: DESCRIPTIONS[status] ? status : STATUS.UNKNOWN, tone: entry.tone, headline: entry.headline, nextStep: entry.next };
  }

  // The checklist shown to beginners, in the order a connection travels.
  function buildShareChecklist(health = {}) {
    // With the computer disconnected, everything below it is last-known data
    // at best, so nothing is marked as working or broken.
    const disconnected = health.nodeState === "disconnected";
    const mark = (ok, problem) => (disconnected ? "unknown" : ok ? "ok" : problem ? "problem" : "unknown");
    return [
      { id: "server", label: "Server is running", state: mark(health.processState === "running", ["stopped", "failed"].includes(health.processState)) },
      { id: "game", label: "Game accepts connections", state: mark(health.portState === "listening", health.portState === "not-listening") },
      { id: "playit", label: "Playit is running", state: mark(health.playitState === "running", ["stopped", "unavailable"].includes(health.playitState)) },
      { id: "tunnel", label: "A tunnel points at this server", state: mark(health.tunnelMatch === "matched", ["not-matched", "multiple"].includes(health.tunnelMatch)) },
      { id: "address", label: "Public address available", state: mark(health.publicAddress === "available", false) },
    ];
  }

  // Connectivity diagnostics settle the game's port: the local-socket stage
  // probes the server's port on its own computer.
  function portStateFromDiagnostics(result) {
    const stage = (Array.isArray(result && result.stages) ? result.stages : []).find((entry) => entry && entry.id === "local-socket");
    if (!stage) return null;
    if (stage.state === "healthy") return "listening";
    if (stage.state === "failed") return "not-listening";
    return null;
  }

  const STAGE_PLAIN_LABELS = Object.freeze({
    "service-process": "Server program",
    "local-socket": "Game accepts connections on its computer",
    "host-network": "Computer's network",
    agent: "AnxOS Agent on that computer",
    provider: "Playit tunnel",
    "public-endpoint": "Reachable from the internet",
  });

  const STATE_PLAIN = Object.freeze({
    healthy: "OK",
    degraded: "Partly working",
    failed: "Problem",
    unknown: "Not checked",
    unsupported: "Not available",
    not_configured: "Not set up",
  });

  // A connection test result as plain rows, plus the first stage that failed:
  // that is where the connection breaks, so it is the one to fix first.
  function explainDiagnostics(result) {
    const stages = (Array.isArray(result && result.stages) ? result.stages : []).filter(Boolean);
    const rows = stages.map((stage) => ({
      id: String(stage.id || ""),
      label: STAGE_PLAIN_LABELS[stage.id] || String(stage.label || stage.id || "Check"),
      state: String(stage.state || "unknown"),
      stateLabel: STATE_PLAIN[stage.state] || "Not checked",
      detail: String(stage.detail || ""),
    }));
    const firstFailure = rows.find((row) => row.state === "failed") || null;
    return { rows, firstFailure };
  }

  // Whether a tunnel's protocol carries the game's protocol. Playit's
  // official IPC often omits the protocol, so "unknown" is common and is never
  // treated as a problem.
  function assessTunnelProtocol(tunnelProtocol, requiredProtocol) {
    const tunnel = String(tunnelProtocol || "").trim().toUpperCase();
    const required = String(requiredProtocol || "").trim().toUpperCase();
    if (!tunnel || !required) return "unknown";
    if (tunnel === "TCP+UDP" || tunnel === required) return "match";
    if (["TCP", "UDP"].includes(tunnel) && ["TCP", "UDP"].includes(required)) return "mismatch";
    return "unknown";
  }

  // One plain sentence about whether Playit's own service manager keeps it
  // running. Unknown facts produce no sentence rather than a guess.
  function describePlayitServiceRecovery(service = {}) {
    const manager = String(service?.manager || "");
    const parts = [];
    if (service?.startsOnBoot === true && service?.restartOnFailure === true) {
      return "Playit starts with the computer and restarts itself if it stops.";
    }
    if (service?.startsOnBoot === false) parts.push("Playit does not start with the computer.");
    if (service?.restartOnFailure === false) {
      parts.push(manager === "windows-service"
        ? "Playit will not restart itself if it crashes. To change this, open Services on that computer, choose Playit > Recovery, and set failures to Restart the Service."
        : "Playit will not restart itself if it crashes. To change this, set Restart=on-failure in its systemd service on that computer.");
    }
    return parts.join(" ");
  }

  // Ports AnxOS never offers to share automatically: remote shells, container
  // and desktop management, and the AnxOS Agent itself. A user can still
  // configure a custom service by hand in Advanced Mode.
  const MANAGEMENT_PORTS = Object.freeze({
    22: "SSH",
    2375: "Docker API",
    2376: "Docker API (TLS)",
    3389: "Remote Desktop",
    5900: "VNC",
    5985: "Windows Remote Management",
    5986: "Windows Remote Management (TLS)",
    6566: "AnxOS Agent",
    47131: "AnxOS Agent",
    47800: "AnxOS Phone Access",
  });

  function getManagementPortName(port) {
    const number = Number.parseInt(String(port ?? ""), 10);
    return Object.prototype.hasOwnProperty.call(MANAGEMENT_PORTS, number) ? MANAGEMENT_PORTS[number] : "";
  }

  function upperProtocol(protocol) {
    return String(protocol || "tcp").trim().toUpperCase() || "TCP";
  }

  // What the user approves before a server is shared: exactly one port and
  // protocol, nothing else.
  function describeShareExposure({ serverName = "this server", port, protocol = "tcp", providerName = "Playit", privateNetwork = false } = {}) {
    const portText = `${upperProtocol(protocol)} port ${port}`;
    if (privateNetwork) {
      return `People in your ${providerName} network will be able to connect to ${serverName} on ${portText}.\n\nNothing else on this computer is shared.`;
    }
    return `Anyone with the address will be able to connect to ${serverName} on ${portText} from the internet, through ${providerName}.\n\nOnly this game port is shared. AnxOS never shares SSH, Docker, Remote Desktop, admin panels or the AnxOS Agent.\n\nYou can stop sharing at any time from this server's Share dialog.`;
  }

  // Playit tunnels are created on playit.gg (the detected integration does not
  // create them), so the user gets the exact settings to enter there.
  function describePlayitTunnelSetup({ port, protocol = "tcp" } = {}) {
    return [
      "Open playit.gg and sign in to the account linked to this computer.",
      `Add a tunnel of type ${upperProtocol(protocol)} that points to local port ${port}.`,
      "Come back here and click Test connection. AnxOS finds the tunnel by its port.",
    ];
  }

  return Object.freeze({
    STATUS,
    assessTunnelProtocol,
    describePlayitServiceRecovery,
    MANAGEMENT_PORTS,
    getManagementPortName,
    describeShareExposure,
    describePlayitTunnelSetup,
    classifyShareHealth,
    describeShareHealth,
    buildShareChecklist,
    portStateFromDiagnostics,
    explainDiagnostics,
  });
});
