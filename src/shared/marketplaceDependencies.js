const DEPENDENCY_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

const DEPENDENCY_REGISTRY = Object.freeze({
  java: {
    id: "java",
    displayName: "Java runtime",
    commands: ["java"],
    versionCommand: { command: "java", args: ["-version"], stream: "stderr" },
    versionPattern: /version "?(\d+(?:\.\d+){0,2})/,
    minVersion: "17",
    groups: ["minecraft-hosting"],
    reason: "Required by Minecraft servers, Java applications, and Java-based installers.",
    packages: {
      apt: ["openjdk-21-jre-headless"],
      dnf: ["java-21-openjdk-headless"],
      win32: ["eclipse-temurin-21-jre"],
    },
    installSources: { win32: "Eclipse Temurin or Microsoft Build of OpenJDK" },
    installers: { win32: { method: "winget", packageId: "EclipseAdoptium.Temurin.21.JRE" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
  },
  "dotnet-runtime": {
    id: "dotnet-runtime",
    displayName: ".NET runtime",
    commands: ["dotnet"],
    versionCommand: { command: "dotnet", args: ["--list-runtimes"], stream: "stdout" },
    versionPattern: /Microsoft\.NETCore\.App\s+(\d+(?:\.\d+){0,2})/,
    // --list-runtimes prints every installed runtime, oldest first: rank them.
    versionSelection: "highest",
    minVersion: "8.0",
    groups: ["dotnet-game-servers"],
    reason: "Required by TShock and other .NET-based servers.",
    packages: {
      apt: ["dotnet-runtime-8.0"],
      dnf: ["dotnet-runtime-8.0"],
      win32: ["Microsoft .NET Runtime 8"],
    },
    installSources: { win32: "Microsoft .NET runtime installer" },
    installers: { win32: { method: "winget", packageId: "Microsoft.DotNet.Runtime.8" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    notes: "If your distribution does not publish .NET packages, add the Microsoft package repository using the official Microsoft instructions, then retry.",
  },
  "dotnet-desktop-runtime": {
    id: "dotnet-desktop-runtime",
    displayName: ".NET Desktop Runtime",
    commands: ["dotnet"],
    versionCommand: { command: "dotnet", args: ["--list-runtimes"], stream: "stdout" },
    versionPattern: /Microsoft\.WindowsDesktop\.App\s+(\d+(?:\.\d+){0,2})/,
    // --list-runtimes prints every installed runtime, oldest first: rank them.
    versionSelection: "highest",
    minVersion: "8.0",
    groups: ["dotnet-game-servers", "windows-support"],
    reason: "Required by Windows desktop-runtime server tools and launchers when a template declares it.",
    packages: {
      apt: [],
      dnf: [],
      win32: ["Microsoft .NET Desktop Runtime 8"],
    },
    installSources: { win32: "Microsoft .NET Desktop Runtime installer" },
    installers: { win32: { method: "winget", packageId: "Microsoft.DotNet.DesktopRuntime.8" } },
    supportedDistributions: [],
    supportedPlatforms: ["win32"],
    requiresElevation: true,
  },
  steamcmd: {
    id: "steamcmd",
    displayName: "SteamCMD",
    commands: ["steamcmd"],
    groups: ["steam-game-servers"],
    reason: "Required by Steam dedicated servers such as Palworld, Valheim, Rust, and Counter-Strike 2.",
    packages: {
      apt: ["steamcmd"],
      dnf: ["steamcmd"],
      win32: ["SteamCMD"],
    },
    installSources: { win32: "Valve SteamCMD ZIP" },
    installers: { win32: { method: "winget", packageId: "Valve.SteamCMD" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    notes: "Some distributions require non-free or multilib repositories before SteamCMD is available.",
  },
  docker: {
    id: "docker",
    displayName: "Docker",
    commands: ["docker"],
    versionCommand: { command: "docker", args: ["--version"], stream: "stdout" },
    versionPattern: /Docker version\s+(\d+(?:\.\d+){0,2})/i,
    verificationCommands: [
      { command: "docker", args: ["--version"], description: "Docker CLI executes from PATH." },
    ],
    groups: ["container-workloads"],
    reason: "Required by Docker-backed Marketplace templates.",
    packages: {
      apt: ["docker.io"],
      dnf: ["docker"],
      win32: ["Docker Desktop"],
    },
    installSources: { win32: "Docker Desktop installer" },
    installers: { win32: { method: "winget", packageId: "Docker.DockerDesktop" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    service: "docker",
    serviceRestartRequired: true,
    notes: "Users may need to sign out and back in after being added to the docker group.",
  },
  "docker-compose": {
    id: "docker-compose",
    displayName: "Docker Compose",
    commands: ["docker"],
    versionCommand: { command: "docker", args: ["compose", "version"], stream: "stdout" },
    versionPattern: /Docker Compose version\s+v?(\d+(?:\.\d+){0,2})/i,
    verificationCommands: [
      { command: "docker", args: ["compose", "version"], description: "Docker Compose plugin executes through the Docker CLI." },
    ],
    groups: ["container-workloads"],
    reason: "Required by Docker Compose Marketplace templates and multi-container workloads.",
    packages: {
      apt: ["docker-compose"],
      dnf: ["docker", "docker-compose-plugin"],
      win32: ["Docker Desktop"],
    },
    installSources: { win32: "Docker Desktop installer" },
    installers: { win32: { method: "winget", packageId: "Docker.DockerDesktop" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    service: "docker",
    serviceRestartRequired: true,
    notes: "Users may need to sign out and back in after being added to the docker group.",
  },
  nodejs: {
    id: "nodejs",
    displayName: "Node.js",
    commands: ["node"],
    versionCommand: { command: "node", args: ["--version"], stream: "stdout" },
    versionPattern: /v?(\d+(?:\.\d+){0,2})/,
    minVersion: "18",
    groups: ["application-runtimes"],
    reason: "Required by Node.js app and bot templates.",
    packages: {
      apt: ["nodejs"],
      dnf: ["nodejs"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  npm: {
    id: "npm",
    displayName: "npm",
    commands: ["npm"],
    versionCommand: { command: "node", args: ["-p", "require('child_process').execFileSync('npm',['--version'],{encoding:'utf8'}).trim()"], stream: "stdout" },
    versionPattern: /(\d+(?:\.\d+){0,2})/,
    verificationCommands: [
      { command: "node", args: ["-p", "require('child_process').execFileSync('npm',['--version'],{encoding:'utf8'}).trim()"], description: "npm executes from PATH." },
    ],
    minVersion: "9",
    groups: ["application-runtimes", "development-tools"],
    reason: "Required to install Node.js project dependencies and run npm-backed templates.",
    packages: {
      apt: ["npm"],
      dnf: ["npm"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  python: {
    id: "python",
    displayName: "Python",
    commands: ["python3"],
    versionCommand: { command: "python3", args: ["--version"], stream: "stdout" },
    versionPattern: /Python\s+(\d+(?:\.\d+){0,2})/,
    minVersion: "3.10",
    groups: ["application-runtimes"],
    reason: "Required by Python app and bot templates.",
    packages: {
      apt: ["python3"],
      dnf: ["python3"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  unzip: {
    id: "unzip",
    displayName: "Unzip",
    commands: ["unzip"],
    versionCommand: { command: "unzip", args: ["-v"], stream: "stdout" },
    versionPattern: /UnZip\s+(\d+(?:\.\d+){0,2})/i,
    groups: ["archive-tools"],
    reason: "Required to extract ZIP-based server archives.",
    packages: {
      apt: ["unzip"],
      dnf: ["unzip"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  tar: {
    id: "tar",
    displayName: "tar",
    commands: ["tar"],
    versionCommand: { command: "tar", args: ["--version"], stream: "stdout" },
    versionPattern: /tar\s+\(GNU tar\)\s+(\d+(?:\.\d+){0,2})/i,
    groups: ["archive-tools"],
    reason: "Required to extract tar archives and nested Linux server payloads.",
    packages: {
      apt: ["tar"],
      dnf: ["tar"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  xz: {
    id: "xz",
    displayName: "XZ tools",
    commands: ["xz"],
    versionCommand: { command: "xz", args: ["--version"], stream: "stdout" },
    versionPattern: /xz\s+\(XZ Utils\)\s+(\d+(?:\.\d+){0,2})/i,
    groups: ["archive-tools"],
    reason: "Required to extract .tar.xz server archives.",
    packages: {
      apt: ["xz-utils"],
      dnf: ["xz"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  curl: {
    id: "curl",
    displayName: "curl",
    commands: ["curl"],
    versionCommand: { command: "curl", args: ["--version"], stream: "stdout" },
    versionPattern: /curl\s+(\d+(?:\.\d+){0,2})/i,
    groups: ["archive-tools"],
    reason: "Required by templates that fetch external runtime assets.",
    packages: {
      apt: ["curl", "ca-certificates"],
      dnf: ["curl", "ca-certificates"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  git: {
    id: "git",
    displayName: "Git",
    commands: ["git"],
    versionCommand: { command: "git", args: ["--version"], stream: "stdout" },
    versionPattern: /git version\s+(\d+(?:\.\d+){0,2})/i,
    groups: ["development-tools"],
    reason: "Required by provider-backed downloads, source-based templates, release diagnostics, and development workflows.",
    packages: {
      apt: ["git"],
      dnf: ["git"],
      win32: ["Git for Windows"],
    },
    installSources: { win32: "Git for Windows installer" },
    installers: { win32: { method: "winget", packageId: "Git.Git" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
  },
  bash: {
    id: "bash",
    displayName: "Bash",
    commands: ["bash"],
    versionCommand: { command: "bash", args: ["--version"], stream: "stdout" },
    versionPattern: /GNU bash,\s+version\s+(\d+(?:\.\d+){0,2})/i,
    groups: ["shell-runtimes"],
    reason: "Required by Linux script-based Marketplace templates and agent maintenance scripts.",
    packages: {
      apt: ["bash"],
      dnf: ["bash"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  powershell: {
    id: "powershell",
    displayName: "PowerShell",
    commands: ["pwsh"],
    windowsCommands: ["pwsh", "powershell"],
    commandMode: "any",
    versionCommand: { command: "pwsh", args: ["--version"], stream: "stdout" },
    windowsVersionCommand: { command: "pwsh", fallbackCommand: "powershell", args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], stream: "stdout" },
    versionPattern: /PowerShell\s+(\d+(?:\.\d+){0,2})/i,
    windowsVersionPattern: /(\d+(?:\.\d+){0,3})/,
    minVersion: "7",
    groups: ["shell-runtimes", "windows-support"],
    reason: "Required by Windows support scripts and cross-platform PowerShell automation.",
    packages: {
      apt: ["powershell"],
      dnf: ["powershell"],
      win32: ["PowerShell 7"],
    },
    installSources: { win32: "Microsoft PowerShell installer" },
    installers: { win32: { method: "winget", packageId: "Microsoft.PowerShell" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    notes: "Linux package managers usually require the Microsoft package repository before PowerShell can be installed.",
  },
  tailscale: {
    id: "tailscale",
    displayName: "Tailscale",
    commands: ["tailscale"],
    versionCommand: { command: "tailscale", args: ["version"], stream: "stdout" },
    versionPattern: /(\d+\.\d+(?:\.\d+)?)/,
    verificationCommands: [
      { command: "tailscale", args: ["version"], description: "Tailscale CLI executes from PATH." },
      { command: "tailscale", args: ["status", "--json"], allowFailure: true, description: "Tailscale daemon/authentication status can be queried." },
    ],
    groups: ["public-access"],
    reason: "Required for tailnet-only Public Access provider status and remote private network access.",
    packages: {
      apt: ["tailscale"],
      dnf: ["tailscale"],
      win32: ["Tailscale"],
    },
    installSources: { win32: "Tailscale MSI installer" },
    installers: { win32: { method: "winget", packageId: "Tailscale.Tailscale" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    service: "tailscaled",
    serviceRestartRequired: true,
    notes: "Automatic install requires the Tailscale package repository to already be configured.",
  },
  cloudflared: {
    id: "cloudflared",
    displayName: "Cloudflare Tunnel",
    commands: ["cloudflared"],
    versionCommand: { command: "cloudflared", args: ["--version"], stream: "stdout" },
    versionPattern: /cloudflared version\s+(\d+(?:\.\d+){0,2})/i,
    verificationCommands: [
      { command: "cloudflared", args: ["--version"], description: "cloudflared CLI executes from PATH." },
    ],
    groups: ["public-access"],
    reason: "Required for Cloudflare Tunnel Public Access provider detection and tunnel diagnostics.",
    packages: {
      apt: ["cloudflared"],
      dnf: ["cloudflared"],
      win32: ["cloudflared"],
    },
    installSources: { win32: "Cloudflare cloudflared release" },
    installers: { win32: { method: "winget", packageId: "Cloudflare.cloudflared" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    notes: "Automatic install requires the Cloudflare package repository to already be configured.",
  },
  playit: {
    id: "playit",
    displayName: "Playit.gg",
    commands: ["playit"],
    versionCommand: { command: "playit", args: ["version"], stream: "stdout" },
    versionPattern: /(\d+(?:\.\d+){0,3})/,
    verificationCommands: [
      { command: "playit", args: ["version"], description: "Playit CLI executes from PATH." },
    ],
    groups: ["public-access"],
    reason: "Required for Playit Public Access tunnel diagnostics and tunnel metadata discovery.",
    packages: {
      apt: [],
      dnf: [],
      win32: ["Playit"],
    },
    installSources: { win32: "Playit official Windows release" },
    installers: { win32: { method: "winget", packageId: "playit.playit" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
    service: "playit",
    serviceRestartRequired: true,
    notes: "Install Playit using the official Playit installer for your platform, then authenticate the daemon.",
  },
  wine: {
    id: "wine",
    displayName: "Wine",
    commands: ["wine"],
    versionCommand: { command: "wine", args: ["--version"], stream: "stdout" },
    versionPattern: /wine-(\d+(?:\.\d+){0,2})/i,
    groups: ["application-runtimes"],
    reason: "Required by Windows-only server runtimes running on Linux.",
    packages: {
      apt: ["wine"],
      dnf: ["wine"],
    },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    requiresElevation: true,
  },
  ffmpeg: {
    id: "ffmpeg",
    displayName: "FFmpeg",
    commands: ["ffmpeg"],
    versionCommand: { command: "ffmpeg", args: ["-version"], stream: "stdout" },
    versionPattern: /ffmpeg version\s+([^\s]+)/i,
    groups: ["media-tools"],
    reason: "Required by templates and tools that process audio or video assets.",
    packages: {
      apt: ["ffmpeg"],
      dnf: ["ffmpeg"],
      win32: ["FFmpeg"],
    },
    installSources: { win32: "FFmpeg official or trusted Windows build" },
    installers: { win32: { method: "winget", packageId: "Gyan.FFmpeg" } },
    supportedDistributions: ["debian", "ubuntu", "fedora", "rocky", "almalinux"],
    supportedPlatforms: ["linux", "win32"],
    requiresElevation: true,
  },
  "vcredist-runtime": {
    id: "vcredist-runtime",
    displayName: "Visual C++ runtime",
    commands: [],
    windowsRegistry: {
      path: "HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
      value: "Version",
    },
    minVersion: "14.0",
    groups: ["windows-support"],
    reason: "Required by Windows native game-server binaries and launchers that depend on the Microsoft Visual C++ runtime.",
    packages: {
      apt: [],
      dnf: [],
      win32: ["Microsoft Visual C++ Redistributable"],
    },
    installSources: { win32: "Microsoft Visual C++ Redistributable installer" },
    installers: { win32: { method: "winget", packageId: "Microsoft.VCRedist.2015+.x64" } },
    supportedDistributions: [],
    supportedPlatforms: ["win32"],
    requiresElevation: true,
    serviceRestartRequired: true,
  },
});

const DEPENDENCY_GROUPS = Object.freeze({
  "minecraft-hosting": {
    id: "minecraft-hosting",
    displayName: "Minecraft hosting",
    dependencyIds: ["java", "curl"],
  },
  "steam-game-servers": {
    id: "steam-game-servers",
    displayName: "Steam game servers",
    dependencyIds: ["steamcmd"],
  },
  "dotnet-game-servers": {
    id: "dotnet-game-servers",
    displayName: ".NET game servers",
    dependencyIds: ["dotnet-runtime", "unzip", "tar"],
  },
  "container-workloads": {
    id: "container-workloads",
    displayName: "Container workloads",
    dependencyIds: ["docker", "docker-compose"],
  },
  "archive-tools": {
    id: "archive-tools",
    displayName: "General archive and download tools",
    dependencyIds: ["curl", "unzip", "tar", "xz"],
  },
  "application-runtimes": {
    id: "application-runtimes",
    displayName: "Application and bot runtimes",
    dependencyIds: ["nodejs", "npm", "python"],
  },
  "development-tools": {
    id: "development-tools",
    displayName: "Development tools",
    dependencyIds: ["git", "npm"],
  },
  "shell-runtimes": {
    id: "shell-runtimes",
    displayName: "Shell runtimes",
    dependencyIds: ["bash", "powershell"],
  },
  "windows-support": {
    id: "windows-support",
    displayName: "Windows support",
    dependencyIds: ["powershell", "dotnet-desktop-runtime", "vcredist-runtime"],
  },
  "media-tools": {
    id: "media-tools",
    displayName: "Media tools",
    dependencyIds: ["ffmpeg"],
  },
  "public-access": {
    id: "public-access",
    displayName: "Public Access providers",
    dependencyIds: ["playit", "cloudflared", "tailscale"],
  },
});

const COMMAND_DEPENDENCY_MAP = Object.freeze({
  java: "java",
  dotnet: "dotnet-runtime",
  steamcmd: "steamcmd",
  docker: "docker",
  "docker-compose": "docker-compose",
  node: "nodejs",
  nodejs: "nodejs",
  npm: "npm",
  python: "python",
  python3: "python",
  unzip: "unzip",
  tar: "tar",
  xz: "xz",
  curl: "curl",
  git: "git",
  bash: "bash",
  sh: "bash",
  pwsh: "powershell",
  powershell: "powershell",
  tailscale: "tailscale",
  cloudflared: "cloudflared",
  playit: "playit",
  ffmpeg: "ffmpeg",
  wine: "wine",
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeDependencyId(id) {
  const normalized = String(id || "").trim().toLowerCase();
  return DEPENDENCY_ID_PATTERN.test(normalized) ? normalized : null;
}

function assertKnownDependencyId(id) {
  const normalized = normalizeDependencyId(id);
  if (!normalized || !DEPENDENCY_REGISTRY[normalized]) {
    const error = new Error(`Unsupported dependency ID: ${id}`);
    error.code = "DEPENDENCY_UNSUPPORTED";
    error.statusCode = 400;
    error.details = { dependencyId: id };
    throw error;
  }
  return normalized;
}

function normalizeDependencyIds(ids = []) {
  return unique((Array.isArray(ids) ? ids : []).map(assertKnownDependencyId));
}

function commandToDependencyId(command) {
  return COMMAND_DEPENDENCY_MAP[String(command || "").trim().toLowerCase()] || null;
}

function dependencyIdsForGroups(groupIds = []) {
  const ids = [];
  for (const groupId of Array.isArray(groupIds) ? groupIds : []) {
    const normalized = normalizeDependencyId(groupId);
    const group = normalized ? DEPENDENCY_GROUPS[normalized] : null;
    if (!group) {
      const error = new Error(`Unsupported dependency group: ${groupId}`);
      error.code = "DEPENDENCY_GROUP_UNSUPPORTED";
      error.statusCode = 400;
      error.details = { groupId };
      throw error;
    }
    ids.push(...group.dependencyIds);
  }
  return normalizeDependencyIds(ids);
}

function getTemplateExplicitDependencyIds(template = {}) {
  const raw = [
    ...(Array.isArray(template.hostDependencies) ? template.hostDependencies : []),
    ...(Array.isArray(template.dependencies?.host) ? template.dependencies.host : []),
    ...(Array.isArray(template.runtimeDependencies) ? template.runtimeDependencies : []),
  ];
  return raw.map((entry) => {
    if (typeof entry === "string") return entry;
    return entry?.id || entry?.dependencyId || "";
  });
}

// Archive tools depend on the platform the template variant targets. Windows
// installers extract .zip with PowerShell Expand-Archive and .tar/.tar.gz with
// the tar.exe Windows ships (they refuse .tar.xz), so asking a Windows node for
// the Linux-only unzip and xz blocked every TShock and FiveM install and start
// there. A template without a resolved platform keeps the Linux tool set.
function archiveToolDependencyIds(template = {}) {
  const primaryArchive = String(template.installer?.archive || template.downloadSource?.fileName || "").toLowerCase();
  if (template.targetPlatform === "windows") {
    const archives = [
      primaryArchive,
      ...(Array.isArray(template.installer?.additionalArchives) ? template.installer.additionalArchives.map((entry) => String(entry?.archive || "").toLowerCase()) : []),
    ];
    return archives.some((name) => /\.(?:tar|tar\.gz|tgz)$/.test(name)) ? ["tar"] : [];
  }
  return primaryArchive.endsWith(".xz") ? ["unzip", "tar", "xz"] : ["unzip", "tar"];
}

function resolveTemplateDependencyIds(template = {}) {
  const ids = [];
  ids.push(...getTemplateExplicitDependencyIds(template));

  const installerType = String(template.installerType || template.installer?.type || template.downloadSource?.type || "").toLowerCase();
  const runtime = String(template.runtime || template.startupType || template.instanceType || "").toLowerCase();
  const category = String(template.category || "").toLowerCase();

  if (category === "minecraft" || runtime.includes("java") || template.startupType === "java-jar") {
    ids.push("java");
  }
  if (runtime.includes("steamcmd") || installerType.includes("steamcmd") || template.downloadSource?.type === "steamcmd") {
    ids.push("steamcmd");
  }
  if (runtime.includes("docker") || template.startupType === "docker-image" || template.runtime === "docker") {
    ids.push("docker");
  }
  if (runtime.includes("docker-compose") || template.startupType === "docker-compose" || template.installer?.type === "docker-compose") {
    ids.push("docker", "docker-compose");
  }
  if (template.instanceType === "node-app") {
    ids.push("nodejs");
  }
  if (template.instanceType === "python-app") {
    ids.push("python");
  }
  if (template.installer?.type === "archive" || installerType.includes("archive")) {
    ids.push(...archiveToolDependencyIds(template));
  }

  const requiredCommands = Array.isArray(template.startup?.requiredCommands) ? template.startup.requiredCommands : [];
  for (const command of requiredCommands) {
    ids.push(commandToDependencyId(command));
  }

  return normalizeDependencyIds(ids);
}

function serializeDependency(definition) {
  return {
    id: definition.id,
    displayName: definition.displayName,
    commands: [...definition.commands],
    verificationCommands: (definition.verificationCommands || []).map((command) => ({
      command: command.command,
      args: [...(command.args || [])],
      allowFailure: Boolean(command.allowFailure),
      description: command.description || null,
    })),
    minVersion: definition.minVersion || null,
    groups: [...(definition.groups || [])],
    reason: definition.reason || null,
    requiresElevation: Boolean(definition.requiresElevation),
    serviceRestartRequired: Boolean(definition.serviceRestartRequired),
    service: definition.service || null,
    supportedDistributions: [...(definition.supportedDistributions || [])],
    supportedPlatforms: [...(definition.supportedPlatforms || ["linux"])],
    packages: {
      apt: [...(definition.packages?.apt || [])],
      dnf: [...(definition.packages?.dnf || [])],
      win32: [...(definition.packages?.win32 || [])],
    },
    installSources: { ...(definition.installSources || {}) },
    installers: { ...(definition.installers || {}) },
    notes: definition.notes || null,
  };
}

function listDependencyDefinitions() {
  return Object.values(DEPENDENCY_REGISTRY).map(serializeDependency);
}

function listDependencyGroups() {
  return Object.values(DEPENDENCY_GROUPS).map((group) => ({
    id: group.id,
    displayName: group.displayName,
    dependencyIds: [...group.dependencyIds],
  }));
}

function compareVersions(actual, minimum) {
  const parse = (value) => String(value || "0").replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(actual);
  const right = parse(minimum);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

module.exports = {
  COMMAND_DEPENDENCY_MAP,
  DEPENDENCY_GROUPS,
  DEPENDENCY_REGISTRY,
  assertKnownDependencyId,
  commandToDependencyId,
  compareVersions,
  dependencyIdsForGroups,
  listDependencyDefinitions,
  listDependencyGroups,
  normalizeDependencyIds,
  resolveTemplateDependencyIds,
  serializeDependency,
};
