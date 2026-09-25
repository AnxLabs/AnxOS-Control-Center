const PUBLIC_ACCESS_PROVIDERS = [
  {
    id: "playit",
    dependencyId: "playit",
    className: "PlayitProvider",
    name: "Playit.gg",
    status: "supported",
    description: "Expose selected local services through Playit.gg tunnels.",
    exposureScope: "public-internet",
    capabilities: {
      detection: true,
      authenticationStatus: true,
      connectionStatus: true,
      serviceExposure: true,
      listServices: true,
      createService: true,
      editService: true,
      deleteService: true,
      refreshService: true,
      publicInternet: true,
      privateNetwork: false,
      tcp: true,
      udp: true,
      http: true,
      https: true,
      generatedAddress: true,
      createProviderResource: false,
      createTunnel: false,
      listTunnels: true,
      startTunnel: false,
      stopTunnel: false,
      deleteTunnel: false,
      publicAddress: true,
      healthCheck: true,
      diagnostics: true,
    },
  },
  {
    id: "cloudflare-tunnel",
    dependencyId: "cloudflared",
    className: "CloudflareTunnelProvider",
    name: "Cloudflare Tunnel",
    status: "foundation",
    description: "Expose compatible HTTP and HTTPS services through Cloudflare Tunnel.",
    exposureScope: "public-internet",
    capabilities: {
      detection: true,
      authenticationStatus: true,
      connectionStatus: true,
      serviceExposure: true,
      listServices: true,
      createService: true,
      editService: true,
      deleteService: true,
      refreshService: true,
      publicInternet: true,
      privateNetwork: false,
      tcp: false,
      udp: false,
      http: true,
      https: true,
      generatedAddress: false,
      createProviderResource: false,
      createTunnel: false,
      listTunnels: true,
      startTunnel: false,
      stopTunnel: false,
      deleteTunnel: false,
      publicAddress: false,
      healthCheck: true,
      diagnostics: true,
      httpServices: true,
    },
  },
  {
    id: "tailscale",
    dependencyId: "tailscale",
    className: "TailscaleProvider",
    name: "Tailscale",
    status: "foundation",
    description: "Share services privately across your Tailscale tailnet.",
    exposureScope: "tailnet-only",
    capabilities: {
      detection: true,
      authenticationStatus: true,
      connectionStatus: true,
      serviceExposure: true,
      listServices: true,
      createService: true,
      editService: true,
      deleteService: true,
      refreshService: true,
      publicInternet: false,
      privateNetwork: true,
      tcp: true,
      udp: true,
      http: true,
      https: true,
      generatedAddress: true,
      createProviderResource: false,
      createTunnel: false,
      listTunnels: false,
      startTunnel: false,
      stopTunnel: false,
      deleteTunnel: false,
      publicAddress: false,
      healthCheck: true,
      diagnostics: true,
      privateAddress: true,
      serve: true,
      funnel: false,
    },
  },
  {
    id: "anxos-relay",
    dependencyId: null,
    className: "AnxOSRelayProvider",
    name: "AnxOS Relay",
    status: "disabled",
    description: "Provider not available in this build.",
    exposureScope: "unavailable",
    capabilities: {
      detection: false,
      authenticationStatus: false,
      connectionStatus: false,
      serviceExposure: false,
      listServices: false,
      createService: false,
      editService: false,
      deleteService: false,
      refreshService: false,
      publicInternet: false,
      privateNetwork: false,
      tcp: false,
      udp: false,
      http: false,
      https: false,
      generatedAddress: false,
      createProviderResource: false,
      createTunnel: false,
      listTunnels: false,
      startTunnel: false,
      stopTunnel: false,
      deleteTunnel: false,
      publicAddress: false,
      healthCheck: false,
      diagnostics: false,
    },
  },
  {
    id: "manual-port-forwarding",
    dependencyId: null,
    className: "ManualPortForwardingProvider",
    name: "Manual Port Forwarding",
    status: "foundation",
    description: "Use router port forwarding and local firewall rules for services you choose to expose.",
    exposureScope: "public-internet",
    capabilities: {
      detection: true,
      authenticationStatus: false,
      connectionStatus: false,
      serviceExposure: true,
      listServices: true,
      createService: true,
      editService: true,
      deleteService: true,
      refreshService: true,
      publicInternet: true,
      privateNetwork: false,
      tcp: true,
      udp: true,
      http: true,
      https: true,
      generatedAddress: false,
      createProviderResource: false,
      createTunnel: false,
      listTunnels: false,
      startTunnel: false,
      stopTunnel: false,
      deleteTunnel: false,
      publicAddress: false,
      healthCheck: true,
      diagnostics: true,
      firewallRules: true,
      routerConfiguration: true,
    },
  },
];

const DEFAULT_CHECKED_AT = () => new Date().toISOString();

function providerById(id) {
  return PUBLIC_ACCESS_PROVIDERS.find((entry) => entry.id === id);
}

function redactOutput(value) {
  return String(value || "")
    .replace(/(\b(?:token|secret|password|credential|certificate|cert|api[_-]?key|authkey)\b\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(--?(?:secret|token|password|credential|certificate|cert|api[_-]?key|authkey)(?:=|\s+))\S+/gi, "$1[redacted]");
}

function firstLine(value) {
  return redactOutput(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function normalizeCommandDiagnostic(command, result) {
  return {
    command,
    ok: result?.ok === true,
    errorCode: result?.errorCode || null,
    hasOutput: Boolean(result?.stdout || result?.stderr),
  };
}

function getProviderStatus(overrides = {}) {
  if (overrides.providerStatus) return overrides.providerStatus;
  if (overrides.lifecycleState === "not-installed") return "Not Installed";
  if (overrides.lifecycleState === "auth-required") return "Signed Out";
  if (overrides.lifecycleState === "setup-required") return "Configuration Required";
  if (overrides.lifecycleState === "running" || overrides.connected === true) return "Connected";
  if (overrides.lifecycleState === "stopped" || overrides.running === false && overrides.installed === true) return "Disconnected";
  if (overrides.lifecycleState === "degraded" || overrides.health === "degraded") return "Degraded";
  if (overrides.lifecycleState === "disabled") return "Unsupported";
  return "Not Installed";
}

function buildFirewallRequirements(providerId, platform, overrides = {}) {
  const windows = platform === "win32";
  const manual = providerId === "manual-port-forwarding";
  const tailscale = providerId === "tailscale";
  const tunnelProvider = providerId === "playit" || providerId === "cloudflare-tunnel";
  return {
    platform,
    windowsFirewall: windows,
    required: windows && (manual || tailscale),
    localInboundRuleRequired: windows && (manual || tailscale),
    outboundOnly: tunnelProvider,
    routerPortForwardRequired: manual,
    managedRulesSupported: windows && (manual || tailscale),
    explicitConsentRequired: windows && (manual || tailscale),
    status: windows
      ? manual || tailscale
        ? "Consent Required"
        : "Usually Not Required"
      : manual
        ? "Check host firewall"
        : "Provider Managed",
    message: windows
      ? manual
        ? "Manual Port Forwarding usually needs a Windows Firewall inbound rule and router port forwarding for the selected service port."
        : tailscale
          ? "Tailscale private services may need a Windows Firewall inbound rule for the selected service port."
          : "Tunnel providers usually use outbound connections; Windows Firewall inbound rules are normally not required for the tunnel process."
      : manual
        ? "Check the host firewall and router before relying on manual port forwarding."
        : "No Windows Firewall action applies on this platform.",
    actions: windows && (manual || tailscale)
      ? [{
          id: "create-windows-firewall-rule",
          label: "Create Windows Firewall Rule",
          supported: true,
          requiresAdministrator: true,
          requiresExplicitConsent: true,
        }]
      : [],
    ...overrides,
  };
}

function createProviderState(provider, overrides = {}) {
  const checkedAt = overrides.checkedAt || DEFAULT_CHECKED_AT();
  const platform = overrides.platform || null;
  return {
    ...provider,
    providerId: provider.id,
    nodeId: overrides.nodeId || null,
    platform,
    checkedAt,
    available: false,
    installed: false,
    daemonInstalled: null,
    daemonRunning: null,
    authenticated: null,
    connected: false,
    configured: null,
    running: false,
    health: "unavailable",
    lifecycleState: "unavailable",
    displayState: "Unavailable",
    providerStatus: getProviderStatus(overrides),
    firewall: buildFirewallRequirements(provider.id, platform, overrides.firewall || {}),
    publicAddress: null,
    tailnetAddress: null,
    version: null,
    diagnostics: [],
    recoveryAction: "Provider is not available in this build.",
    ...overrides,
    checkedAt,
    providerId: provider.id,
    providerStatus: getProviderStatus(overrides),
    firewall: buildFirewallRequirements(provider.id, platform, overrides.firewall || {}),
  };
}

function platformCommandExists(command, platform) {
  if (platform === "win32") {
    return { command: "where.exe", args: [command], label: `where ${command}` };
  }
  return { command: "sh", args: ["-lc", `command -v ${command}`], label: `command -v ${command}` };
}

async function commandExists(runCommand, command, platform) {
  const spec = platformCommandExists(command, platform);
  const result = await runCommand(spec.command, spec.args);
  return { ...result, commandLabel: spec.label, path: firstLine(result.stdout) };
}

function parseJson(stdout) {
  try {
    return stdout ? JSON.parse(stdout) : null;
  } catch {
    return null;
  }
}

function inferTailscaleState({ executable, daemonInstalled, daemonRunning, status, parsed, ipv4, ipv6 }) {
  if (!executable.ok) {
    return {
      health: "missing",
      lifecycleState: "not-installed",
      displayState: "Not Installed",
      recoveryAction: "Install Tailscale on this node, then refresh Public Access.",
    };
  }
  const backendState = String(parsed?.BackendState || "").trim();
  const loginRequired = /NeedsLogin|NoState|Stopped/i.test(backendState) || /logged out|not logged in|needs login/i.test(`${status.stdout}\n${status.stderr}`);
  const hasAddress = Boolean(ipv4 || ipv6 || (Array.isArray(parsed?.Self?.TailscaleIPs) && parsed.Self.TailscaleIPs.length));
  if (loginRequired) {
    return {
      health: "auth-required",
      lifecycleState: "auth-required",
      displayState: "Authentication Required",
      recoveryAction: "Sign in to Tailscale on this node, then refresh Public Access.",
    };
  }
  if (daemonInstalled && daemonRunning === false) {
    return {
      health: "stopped",
      lifecycleState: "stopped",
      displayState: "Stopped",
      recoveryAction: "Start the tailscaled service on this node, then refresh Public Access.",
    };
  }
  if (status.ok && hasAddress && /Running/i.test(backendState || "Running")) {
    return {
      health: "healthy",
      lifecycleState: "running",
      displayState: "Installed and connected",
      recoveryAction: "Tailscale is connected. You can share services privately across this tailnet.",
    };
  }
  if (executable.ok && (status.ok || backendState)) {
    return {
      health: "degraded",
      lifecycleState: "degraded",
      displayState: "Degraded",
      recoveryAction: "Tailscale is installed, but AnxOS could not verify a healthy connected state.",
    };
  }
  return {
    health: "installed",
    lifecycleState: "installed",
    displayState: "Installed",
    recoveryAction: "Tailscale is installed. Sign in or start the daemon on this node if private access is not available.",
  };
}

async function detectTailscaleProvider({ runCommand, nodeId = null, platform = process.platform } = {}) {
  const provider = providerById("tailscale");
  const checkedAt = DEFAULT_CHECKED_AT();
  const executable = await commandExists(runCommand, "tailscale", platform);
  const daemonExecutable = await commandExists(runCommand, "tailscaled", platform);
  const diagnostics = [
    normalizeCommandDiagnostic(executable.commandLabel, executable),
    normalizeCommandDiagnostic(daemonExecutable.commandLabel, daemonExecutable),
  ];

  if (!executable.ok) {
    return createProviderState(provider, {
      nodeId,
      platform,
      checkedAt,
      dependencyId: provider.dependencyId,
      diagnostics,
      ...inferTailscaleState({ executable }),
    });
  }

  const version = await runCommand("tailscale", ["version"]);
  const status = await runCommand("tailscale", ["status", "--json"]);
  const ipv4 = await runCommand("tailscale", ["ip", "-4"]);
  const ipv6 = await runCommand("tailscale", ["ip", "-6"]);
  const serviceActive = platform === "linux" ? await runCommand("systemctl", ["is-active", "tailscaled"]) : { ok: false };
  const serviceEnabled = platform === "linux" ? await runCommand("systemctl", ["is-enabled", "tailscaled"]) : { ok: false };
  const serveStatus = await runCommand("tailscale", ["serve", "status", "--json"]);
  const funnelStatus = await runCommand("tailscale", ["funnel", "status", "--json"]);
  const parsed = parseJson(status.stdout);
  const self = parsed?.Self || {};
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const ipv4Address = firstLine(ipv4.stdout) || addresses.find((entry) => /^\d+\./.test(entry)) || null;
  const ipv6Address = firstLine(ipv6.stdout) || addresses.find((entry) => String(entry).includes(":")) || null;
  const daemonRunning = serviceActive.ok ? /^active$/i.test(serviceActive.stdout) : null;
  const state = inferTailscaleState({
    executable,
    daemonInstalled: daemonExecutable.ok,
    daemonRunning,
    status,
    parsed,
    ipv4: ipv4Address,
    ipv6: ipv6Address,
  });

  diagnostics.push(
    normalizeCommandDiagnostic("tailscale version", version),
    normalizeCommandDiagnostic("tailscale status --json", status),
    normalizeCommandDiagnostic("tailscale ip -4", ipv4),
    normalizeCommandDiagnostic("tailscale ip -6", ipv6),
    normalizeCommandDiagnostic("systemctl is-active tailscaled", serviceActive),
    normalizeCommandDiagnostic("systemctl is-enabled tailscaled", serviceEnabled),
    normalizeCommandDiagnostic("tailscale serve status --json", serveStatus),
    normalizeCommandDiagnostic("tailscale funnel status --json", funnelStatus),
  );

  return createProviderState(provider, {
    nodeId,
    platform,
    checkedAt,
    available: true,
    installed: true,
    dependencyId: provider.dependencyId,
    daemonInstalled: daemonExecutable.ok,
    daemonRunning,
    authenticated: state.lifecycleState !== "auth-required",
    connected: state.lifecycleState === "running",
    running: state.lifecycleState === "running",
    backendState: parsed?.BackendState || null,
    hostname: self.HostName || parsed?.Hostname || null,
    DNSName: self.DNSName || null,
    IPv4: ipv4Address,
    IPv6: ipv6Address,
    online: self.Online === true || state.lifecycleState === "running",
    tailnetName: parsed?.CurrentTailnet?.Name || parsed?.CurrentTailnet?.MagicDNSSuffix || null,
    MagicDNS: Boolean(self.DNSName || parsed?.CurrentTailnet?.MagicDNSSuffix),
    serveCapability: serveStatus.ok,
    funnelCapability: funnelStatus.ok,
    tailnetAddress: ipv4Address || ipv6Address,
    version: firstLine(version.stdout || version.stderr),
    serviceState: {
      active: serviceActive.ok ? serviceActive.stdout : null,
      enabled: serviceEnabled.ok ? serviceEnabled.stdout : null,
    },
    diagnostics,
    ...state,
  });
}

function parseCloudflaredVersion(output) {
  const text = firstLine(output);
  const match = text?.match(/\bcloudflared\s+version\s+([^\s]+)/i) || text?.match(/\b(\d+\.\d+\.\d+[^\s]*)\b/);
  return match?.[1] || text;
}

function inferCloudflareState({ executable, tunnelCount, activeTunnelCount, processRunning, credentialFound }) {
  if (!executable.ok) {
    return {
      health: "missing",
      lifecycleState: "not-installed",
      displayState: "Not Installed",
      recoveryAction: "Install cloudflared on this node, then refresh Public Access.",
    };
  }
  if (activeTunnelCount > 0 || processRunning) {
    return {
      health: "healthy",
      lifecycleState: "running",
      displayState: "Running",
      recoveryAction: "cloudflared is running. HTTP and HTTPS services can be linked to configured tunnels.",
    };
  }
  if (tunnelCount > 0) {
    return {
      health: "stopped",
      lifecycleState: "stopped",
      displayState: "Configured",
      recoveryAction: "cloudflared has named tunnel configuration, but no active tunnel process was detected.",
    };
  }
  if (credentialFound) {
    return {
      health: "setup-required",
      lifecycleState: "setup-required",
      displayState: "Installed — tunnel setup required",
      recoveryAction: "cloudflared is authenticated. Create or select a named tunnel before exposing web services.",
    };
  }
  return {
    health: "auth-required",
    lifecycleState: "auth-required",
    displayState: "Authentication Required",
    recoveryAction: "Authenticate cloudflared on this node before creating tunnels.",
  };
}

async function detectCloudflareProvider({ runCommand, nodeId = null, platform = process.platform } = {}) {
  const provider = providerById("cloudflare-tunnel");
  const checkedAt = DEFAULT_CHECKED_AT();
  const executable = await commandExists(runCommand, "cloudflared", platform);
  const diagnostics = [normalizeCommandDiagnostic(executable.commandLabel, executable)];

  if (!executable.ok) {
    return createProviderState(provider, {
      nodeId,
      platform,
      checkedAt,
      dependencyId: provider.dependencyId,
      diagnostics,
      ...inferCloudflareState({ executable }),
    });
  }

  const version = await runCommand("cloudflared", ["--version"]);
  const processCheck = platform === "linux"
    ? await runCommand("pgrep", ["-af", "cloudflared"])
    : await runCommand("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe"]);
  const serviceActive = platform === "linux" ? await runCommand("systemctl", ["is-active", "cloudflared"]) : { ok: false };
  const tunnelList = await runCommand("cloudflared", ["tunnel", "list", "--output", "json"]);
  const configProbe = platform === "win32"
    ? await runCommand("cmd.exe", ["/d", "/s", "/c", "if exist \"%USERPROFILE%\\.cloudflared\\config.yml\" echo %USERPROFILE%\\.cloudflared\\config.yml"])
    : await runCommand("sh", ["-lc", "for p in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml \"$HOME/.cloudflared/config.yml\" \"$HOME/.cloudflared/config.yaml\"; do [ -f \"$p\" ] && echo \"$p\"; done"]);
  const certProbe = platform === "win32"
    ? await runCommand("cmd.exe", ["/d", "/s", "/c", "if exist \"%USERPROFILE%\\.cloudflared\\cert.pem\" echo present"])
    : await runCommand("sh", ["-lc", "for p in \"$HOME/.cloudflared/cert.pem\" /etc/cloudflared/cert.pem; do [ -f \"$p\" ] && echo present; done"]);
  const tunnels = parseJson(tunnelList.stdout);
  const tunnelEntries = Array.isArray(tunnels) ? tunnels : [];
  const processLines = String(processCheck.stdout || "").split(/\r?\n/).filter((line) => /cloudflared/i.test(line) && !/pgrep -af cloudflared/i.test(line));
  const activeTunnelCount = processLines.length || (serviceActive.ok && /^active$/i.test(serviceActive.stdout) ? 1 : 0);
  const configPath = firstLine(configProbe.stdout);
  const credentialFound = Boolean(firstLine(certProbe.stdout) || tunnelEntries.length);
  const state = inferCloudflareState({
    executable,
    tunnelCount: tunnelEntries.length,
    activeTunnelCount,
    processRunning: activeTunnelCount > 0,
    credentialFound,
  });

  diagnostics.push(
    normalizeCommandDiagnostic("cloudflared --version", version),
    normalizeCommandDiagnostic("cloudflared tunnel list --output json", tunnelList),
    normalizeCommandDiagnostic(platform === "linux" ? "pgrep -af cloudflared" : "tasklist cloudflared", processCheck),
    normalizeCommandDiagnostic("systemctl is-active cloudflared", serviceActive),
    normalizeCommandDiagnostic("cloudflared config probe", configProbe),
    normalizeCommandDiagnostic("cloudflared credential probe", certProbe),
  );

  return createProviderState(provider, {
    nodeId,
    platform,
    checkedAt,
    available: true,
    installed: true,
    dependencyId: provider.dependencyId,
    authenticated: credentialFound,
    configured: Boolean(configPath || tunnelEntries.length),
    connected: activeTunnelCount > 0,
    running: activeTunnelCount > 0,
    configPath,
    tunnelCount: tunnelEntries.length,
    activeTunnelCount,
    serviceState: serviceActive.ok ? serviceActive.stdout : null,
    setupRequired: state.lifecycleState === "setup-required",
    version: parseCloudflaredVersion(version.stdout || version.stderr),
    diagnostics,
    ...state,
  });
}

function buildPlayitProviderState(snapshot = {}, context = {}) {
  const provider = providerById("playit");
  const health = snapshot.connected === true
    ? "healthy"
    : snapshot.running === true
      ? "running"
      : snapshot.installed === true
        ? "stopped"
        : "missing";
  const displayState = snapshot.connected === true
    ? "Running"
    : snapshot.running === true
      ? "Running"
      : snapshot.installed === true
        ? "Stopped"
        : "Not Installed";
  return createProviderState(provider, {
    nodeId: context.nodeId || snapshot.nodeId || null,
    platform: context.platform || snapshot.platform || null,
    checkedAt: context.checkedAt || snapshot.checkedAt || DEFAULT_CHECKED_AT(),
    available: true,
    dependencyId: provider.dependencyId,
    installed: snapshot.installed === true,
    authenticated: snapshot.installed === true ? null : false,
    connected: snapshot.connected === true,
    running: snapshot.running === true,
    health,
    lifecycleState: health === "healthy" || health === "running" ? "running" : health === "stopped" ? "stopped" : "not-installed",
    displayState,
    publicAddress: snapshot.tunnelAddress || snapshot.tunnelDomain || null,
    version: snapshot.version || null,
    diagnostics: snapshot.diagnostics ? [{ provider: "playit", ...snapshot.diagnostics }] : [],
    capabilities: {
      ...provider.capabilities,
      createProviderResource: false,
      startService: false,
      stopService: false,
      unsupportedCreateReason: "The detected Playit integration does not expose a safe local API for creating provider tunnels from AnxOS yet. AnxOS can save the access service record and reconcile it after Playit reports the tunnel.",
    },
    recoveryAction: snapshot.installed
      ? "Manage the tunnel in Playit itself (playit.gg), then refresh AnxOS to see the new state."
      : "Install and configure Playit.gg on the selected node. AnxOS can check whether Playit is installed.",
  });
}

function buildServiceFromPlayitSnapshot(snapshot = {}, context = {}) {
  const publicAddress = snapshot.tunnelAddress || snapshot.tunnelDomain || null;
  const localPort = snapshot.localPort || null;
  const status = snapshot.connected === true
    ? "Public"
    : snapshot.running === true
      ? "Provider running"
      : snapshot.installed === true
        ? "Disabled"
        : "Unavailable";

  return {
    id: "playit-primary",
    nodeId: context.nodeId || snapshot.nodeId || null,
    providerId: "playit",
    providerName: "Playit.gg",
    name: publicAddress ? "Public service" : "Unconfigured service",
    localPort,
    publicAddress,
    exposureScope: publicAddress ? "public-internet" : "unavailable",
    status,
    protocol: snapshot.protocol || null,
    tunnelId: snapshot.tunnelId || null,
    lastCheckedAt: snapshot.lastSuccessfulRefreshAt || context.checkedAt || null,
  };
}

function createRelayProviderState(context = {}) {
  return createProviderState(providerById("anxos-relay"), {
    nodeId: context.nodeId || null,
    platform: context.platform || null,
    checkedAt: context.checkedAt || DEFAULT_CHECKED_AT(),
    status: "disabled",
    lifecycleState: "disabled",
    displayState: "Disabled",
    health: "disabled",
    recoveryAction: "Provider not available in this build.",
    publicAddress: null,
    tailnetAddress: null,
    version: null,
    installed: false,
    available: false,
    connected: false,
    running: false,
    diagnostics: [],
  });
}

function createManualPortForwardingProviderState(context = {}) {
  return createProviderState(providerById("manual-port-forwarding"), {
    nodeId: context.nodeId || null,
    platform: context.platform || null,
    checkedAt: context.checkedAt || DEFAULT_CHECKED_AT(),
    available: true,
    installed: true,
    authenticated: null,
    configured: false,
    connected: false,
    running: false,
    health: "setup-required",
    lifecycleState: "setup-required",
    displayState: "Configuration Required",
    providerStatus: "Configuration Required",
    publicAddress: null,
    tailnetAddress: null,
    version: null,
    diagnostics: [{
      provider: "manual-port-forwarding",
      ok: true,
      message: "Manual Port Forwarding depends on router configuration and host firewall rules chosen by the user.",
    }],
    recoveryAction: context.platform === "win32"
      ? "Choose a service port, explicitly allow a Windows Firewall inbound rule if required, then configure the same port on your router."
      : "Choose a service port, allow it in the host firewall if required, then configure the same port on your router.",
  });
}

async function buildPublicAccessSnapshot({ runCommand, getPlayitSnapshot, nodeId = null, platform = process.platform } = {}) {
  let playitSnapshot;
  try {
    playitSnapshot = await getPlayitSnapshot();
  } catch (error) {
    playitSnapshot = {
      installed: false,
      running: false,
      connected: false,
      diagnostics: {
        errorCode: error?.code || "PLAYIT_SNAPSHOT_FAILED",
        message: error?.message || "Playit snapshot failed.",
      },
    };
  }
  const checkedAt = DEFAULT_CHECKED_AT();
  const context = { nodeId, platform, checkedAt };
  const providerStates = [
    buildPlayitProviderState(playitSnapshot, context),
    await detectCloudflareProvider({ runCommand, nodeId, platform }),
    await detectTailscaleProvider({ runCommand, nodeId, platform }),
    createManualPortForwardingProviderState(context),
    createRelayProviderState(context),
  ];
  const service = buildServiceFromPlayitSnapshot(playitSnapshot, context);
  const provider = providerStates[0];
  return {
    nodeId,
    platform,
    checkedAt,
    provider,
    providers: providerStates,
    services: [service],
    activeTunnels: service.publicAddress ? 1 : 0,
    connectedProvider: provider.name,
    tunnelStatus: service.status,
    exposureScope: service.exposureScope,
    recentActivity: [
      {
        id: "playit-snapshot",
        label: playitSnapshot.lastSuccessfulRefreshAt ? "Provider status refreshed" : "Provider status checked",
        at: playitSnapshot.lastSuccessfulRefreshAt || checkedAt,
        providerId: "playit",
        nodeId,
      },
    ],
    playit: { ...playitSnapshot, nodeId, platform, checkedAt },
  };
}

module.exports = {
  PUBLIC_ACCESS_PROVIDERS,
  buildPlayitProviderState,
  buildPublicAccessSnapshot,
  buildServiceFromPlayitSnapshot,
  createProviderState,
  createManualPortForwardingProviderState,
  createRelayProviderState,
  detectCloudflareProvider,
  detectTailscaleProvider,
  redactOutput,
};
