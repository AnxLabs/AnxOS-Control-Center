const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  dependencyIdsForGroups,
  resolveTemplateDependencyIds,
} = require("../src/shared/marketplaceDependencies");
const dependencyService = require("../agent/src/services/dependencyService");
const marketplaceService = require("../src/services/marketplaceService");

const templates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketplace-templates.json"), "utf8"));
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const dependenciesIpcSource = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "dependenciesIpc.js"), "utf8");
const marketplaceServiceSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "marketplaceService.js"), "utf8");
const agentDependencySource = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "services", "dependencyService.js"), "utf8");
const serviceRouterSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "serviceRouter.js"), "utf8");

function template(id) {
  const found = templates.find((entry) => entry.id === id);
  assert(found, `Template ${id} should exist.`);
  return found;
}

function createMockHooks(options = {}) {
  const installedCommands = new Set(options.installedCommands || []);
  const commandCalls = [];
  const osRelease = options.osRelease || [
    "ID=debian",
    "ID_LIKE=debian",
    "PRETTY_NAME=\"Debian GNU/Linux 13\"",
    "VERSION_ID=\"13\"",
  ].join("\n");

  return {
    commandCalls,
    hooks: {
      readFileText(filePath) {
        if (filePath === "/etc/os-release") return osRelease;
        throw new Error(`Unexpected read: ${filePath}`);
      },
      accessExecutable(filePath) {
        const command = path.basename(filePath);
        const normalized = command.replace(/\.(?:exe|cmd|bat|com)$/i, "");
        if (installedCommands.has(command) || installedCommands.has(normalized)) return;
        throw new Error(`not executable: ${command}`);
      },
      async commandRunner(command, args = []) {
        commandCalls.push({ command: path.basename(command), args });
        const commandName = path.basename(command);
        if (commandName === "sudo" && args[0] === "-n" && args[1] === "true") {
          return { ok: true, exitCode: 0, stdout: "", stderr: "" };
        }
        if (commandName === "sudo" && args[0] === "-n") {
          const delegated = path.basename(args[1] || "");
          if (delegated === "apt-get" && args.includes("install")) {
            installedCommands.add(options.installProvides || "dotnet");
          }
          return { ok: true, exitCode: 0, stdout: "installed token=should-not-leak", stderr: "" };
        }
        if (commandName === "dotnet") {
          return { ok: true, exitCode: 0, stdout: "Microsoft.NETCore.App 8.0.28 [/usr/share/dotnet/shared/Microsoft.NETCore.App]", stderr: "" };
        }
        if (commandName === "java") {
          return { ok: true, exitCode: 0, stdout: "", stderr: "openjdk version \"21.0.11\"" };
        }
        if (commandName === "node") {
          return { ok: true, exitCode: 0, stdout: "v22.23.1", stderr: "" };
        }
        if (commandName === "python3") {
          return { ok: true, exitCode: 0, stdout: "Python 3.13.5", stderr: "" };
        }
        if (["unzip", "tar", "xz", "curl", "docker", "steamcmd"].includes(commandName)) {
          return { ok: true, exitCode: 0, stdout: `${commandName} 1.0`, stderr: "" };
        }
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

async function run() {
  assert.deepStrictEqual(dependencyIdsForGroups(["steam-game-servers"]), ["steamcmd"]);
  assert(resolveTemplateDependencyIds(template("terraria-tshock")).includes("dotnet-runtime"), "TShock should require .NET.");
  assert(resolveTemplateDependencyIds(template("terraria-tshock")).includes("unzip"), "TShock should require unzip.");
  assert(resolveTemplateDependencyIds(template("palworld")).includes("steamcmd"), "Palworld should require SteamCMD.");
  assert(resolveTemplateDependencyIds(template("minecraft-paper")).includes("java"), "Minecraft should require Java.");
  assert(resolveTemplateDependencyIds(template("discord-js")).includes("nodejs"), "Discord.js should require Node.js.");
  assert(resolveTemplateDependencyIds(template("python-discord-bot")).includes("python"), "Python bot should require Python.");
  assert(resolveTemplateDependencyIds(template("immich")).includes("docker-compose"), "Docker Compose templates should require Docker Compose.");
  assert.deepStrictEqual(dependencyIdsForGroups(["public-access"]), ["playit", "cloudflared", "tailscale"]);
  assert(dependencyIdsForGroups(["development-tools"]).includes("git"), "Development tools should include Git.");
  assert(dependencyIdsForGroups(["windows-support"]).includes("dotnet-desktop-runtime"), "Windows support should include .NET Desktop Runtime.");
  assert(dependencyIdsForGroups(["windows-support"]).includes("vcredist-runtime"), "Windows support should include Visual C++ runtime.");
  assert(dependencyIdsForGroups(["media-tools"]).includes("ffmpeg"), "Media tools should include FFmpeg.");

  const parsed = dependencyService.parseOsRelease("ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME=\"Ubuntu\"\n");
  assert.strictEqual(parsed.packageManager, "apt");
  assert.strictEqual(parsed.family, "debian");

  let mock = createMockHooks({ installedCommands: ["java"] });
  dependencyService.__setTestHooks(mock.hooks);
  let check = await dependencyService.checkDependencies({ dependencyIds: ["java"] });
  assert.strictEqual(check.ok, true);
  assert.strictEqual(check.dependencies[0].state, "installed");

  if (process.platform === "win32") {
    const bundledJava = path.join(__dirname, "..", "resources", "bundled-runtimes", "win-x64", "java", "21", "bin", "java");
    mock = createMockHooks({ installedCommands: [] });
    dependencyService.__setTestHooks({
      ...mock.hooks,
      bundledRuntimeExecutable: (id) => id === "java-21" ? bundledJava : null,
    });
    check = await dependencyService.checkDependencies({ dependencyIds: ["java"] });
    assert.strictEqual(check.ok, true, "Bundled Java must satisfy Marketplace dependency preflight on Windows.");
    assert.strictEqual(check.dependencies[0].privateRuntime?.path, bundledJava, "Dependency results should identify the AnxOS bundled Java runtime.");
  }

  const installerCalls = [];
  dependencyService.__setTestHooks({
    commandRunner: async (command, args) => {
      installerCalls.push({ command, args });
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
    windowsInstallerCommand: () => "winget",
    windowsInstaller: () => ({ method: "winget", packageId: "Microsoft.DotNet.Runtime.8" }),
  });
  await dependencyService._test.installWindowsDependency("dotnet-runtime", { displayName: ".NET runtime" }, { events: [], output: [] });
  assert.deepStrictEqual(installerCalls[0], {
    command: "winget",
    args: ["install", "--id", "Microsoft.DotNet.Runtime.8", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
  }, "Trusted Windows dependency installation must dispatch the expected winget argv.");

  if (process.platform === "linux") {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin";
    mock = createMockHooks({ installedCommands: ["steamcmd"] });
    dependencyService.__setTestHooks(mock.hooks);
    check = await dependencyService.checkDependencies({ dependencyIds: ["steamcmd"] });
    assert.strictEqual(check.dependencies[0].state, "installed", "Linux dependency detection must include standard /usr/games executables when PATH omits it.");
    process.env.PATH = originalPath;
  }

  const isWindows = process.platform === "win32";
  mock = createMockHooks({ installedCommands: isWindows ? ["winget"] : ["sudo", "apt-get"], installProvides: "dotnet" });
  dependencyService.__setTestHooks(mock.hooks);
  let plan = await dependencyService.planDependencyPreparation({ dependencyIds: ["dotnet-runtime"] });
  assert.strictEqual(plan.installableActions.length, 1, "Missing .NET should produce an installable preparation action.");
  const expectedInstallCommand = isWindows ? "winget install --id Microsoft.DotNet.Runtime.8" : "sudo -n apt-get install -y dotnet-runtime-8.0";
  assert(plan.installableActions[0].commands.some((command) => command.display.includes(expectedInstallCommand)), "Preparation plan should show the exact platform install command.");
  if (!isWindows) {
  let install = await dependencyService.installDependencies({ dependencyIds: ["dotnet-runtime"], nodeId: "anxlab" });
  assert.strictEqual(install.ok, true);
  assert(install.job && install.job.id && install.job.state === "completed", "Dependency install should return a completed job.");
  assert.strictEqual(install.jobs.length, 1, "Dependency install should include a jobs array.");
  assert.strictEqual(install.job.nodeId, "anxlab", "Agent dependency jobs must preserve selected remote node id.");
  assert.strictEqual(install.job.executionBackend, "agent", "Remote dependency jobs must identify the Agent backend.");
  assert.strictEqual(install.job.installationMethod, "package-manager", "Remote dependency jobs must identify package-manager installation.");
  assert.strictEqual(install.job.externalTerminal, false, "Remote dependency jobs must not launch external terminals.");
  assert(install.job.events.some((event) => event.stage === "Installing files"), "Dependency job should include install stage events.");
  assert(!JSON.stringify(install.job).includes("should-not-leak"), "Dependency job output must redact token-like values.");
  assert(
    mock.commandCalls.some((call) => call.command === "sudo" && call.args.some((arg) => path.basename(String(arg)) === "apt-get")),
    "Install should use sudo -n with apt-get."
  );
  }

  mock = createMockHooks({ installedCommands: isWindows ? ["winget"] : ["apt-get"] });
  dependencyService.__setTestHooks(mock.hooks);
  plan = await dependencyService.planDependencyPreparation({ dependencyIds: [isWindows ? "nodejs" : "nodejs"] });
  assert.strictEqual(plan.installableActions.length, 0, "Preparation plan must not mark dependencies installable without elevation.");
  assert.strictEqual(plan.manualActions[0].action, "manual", "Missing elevation should become a guided manual step.");
  await assert.rejects(
    () => dependencyService.installDependencies({ dependencyIds: ["nodejs"], nodeId: "anxlab" }),
    (error) => isWindows ? error.code === "UNSUPPORTED_PLATFORM" || error.code === "PACKAGE_MANAGER_MISSING" : error.code === "AUTHORIZATION_REQUIRED",
    isWindows ? "Unsupported Windows dependency should remain a structured unsupported state." : "Missing elevation should become an authorization-required install state."
  );

  mock = createMockHooks({
    installedCommands: ["sudo", "apt-get"],
    osRelease: "ID=solus\nPRETTY_NAME=\"Solus\"\n",
  });
  dependencyService.__setTestHooks(mock.hooks);
  check = await dependencyService.checkDependencies({ dependencyIds: ["bash"] });
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.dependencies[0].state, "unsupported");

  assert.throws(() => dependencyIdsForGroups(["bad;group"]), /Unsupported dependency group/);
  await assert.rejects(() => dependencyService.checkDependencies({ dependencyIds: ["java;rm"] }), /Unsupported dependency ID/);

  mock = createMockHooks({ installedCommands: isWindows ? ["winget"] : ["sudo", "apt-get"], installProvides: "dotnet" });
  dependencyService.__setTestHooks(mock.hooks);
  await Promise.all([
    dependencyService.installDependencies({ dependencyIds: ["dotnet-runtime"] }),
    dependencyService.installDependencies({ dependencyIds: ["dotnet-runtime"] }),
  ]);
  const installCalls = isWindows
    ? mock.commandCalls.filter((call) => String(call.command).replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase() === "winget" && call.args.includes("install"))
    : mock.commandCalls.filter((call) => call.command === "sudo" && call.args.includes("install"));
  assert.strictEqual(installCalls.length, 1, "Concurrent installs for one dependency should coalesce.");

  const download = marketplaceService.createDependencyInstallRecord({ nodeId: "agent-smoke", dependencyIds: ["tailscale"] }, {
    installableActions: [{ id: "tailscale", displayName: "Tailscale" }],
  });
  assert(download.id && download.type === "Dependency", "Dependency installs should create Download Manager dependency records.");
  assert.strictEqual(download.progressMode, "indeterminate", "Running dependency installs must use indeterminate progress until real progress exists.");
  assert.strictEqual(download.progress, null, "Dependency install records must not invent a fake running percentage.");
  marketplaceService.updateDependencyInstallRecord(download.id, {
    stage: "Verifying installation",
    progress: null,
    progressMode: "indeterminate",
    logs: [{ step: "Verifying installation", message: "Checking Tailscale." }],
  });
  const finalized = marketplaceService.finalizeDependencyInstallRecord(download.id, {
    ok: true,
    jobs: [{
      id: "dep-tailscale-smoke",
      dependencyId: "tailscale",
      dependencyName: "Tailscale",
      nodeId: "agent-smoke",
      platform: "linux",
      state: "completed",
      stage: "Installation complete",
      progressMode: "determinate",
      progressPercent: 100,
      message: "Tailscale verified.",
      events: [{ state: "completed", stage: "Installation complete", message: "Tailscale verified." }],
      output: [],
    }],
  });
  assert.strictEqual(finalized.status, "complete", "Dependency Download Manager record should complete after verification.");
  assert.strictEqual(finalized.progress, 100, "Completed dependency records should report 100% progress.");
  assert.strictEqual(finalized.progressMode, "determinate", "Completed dependency records should report determinate progress.");
  assert.strictEqual(finalized.dependencyJobs[0].nodeId, "agent-smoke", "Dependency job summaries must preserve target node ownership.");
  assert.strictEqual(finalized.dependencyJobs[0].dependencyName, "Tailscale", "Dependency job summaries must preserve dependency identity.");
  assert.strictEqual(finalized.dependencyJobs[0].executionBackend, null, "Job summaries should include backend only when reported by the backend.");

  const degradedDownload = marketplaceService.createDependencyInstallRecord({ nodeId: "agent-smoke", dependencyIds: ["cloudflared"] }, {
    installableActions: [{ id: "cloudflared", displayName: "cloudflared" }],
  });
  const degraded = marketplaceService.finalizeDependencyInstallRecord(degradedDownload.id, {
    ok: false,
    degraded: true,
    jobs: [{
      id: "dep-cloudflared-smoke",
      dependencyId: "cloudflared",
      dependencyName: "cloudflared",
      nodeId: "agent-smoke",
      state: "degraded",
      stage: "Verifying installation",
      error: { code: "VERIFICATION_FAILED", message: "Verification failed." },
      cancellationSupported: false,
      cancellationReason: "Installation cannot be safely interrupted during package configuration.",
      events: [{ state: "degraded", stage: "Verifying installation", message: "Verification failed." }],
      output: [],
    }],
  });
  assert.strictEqual(degraded.status, "degraded", "Verification failures should produce a degraded dependency record.");
  assert.strictEqual(degraded.errorCode, "VERIFICATION_FAILED", "Verification failures should keep a structured retryable code.");
  assert.strictEqual(degraded.canRetryVerification, true, "Degraded dependency records should expose Retry Verification.");
  assert.strictEqual(degraded.dependencyJobs[0].cancellationSupported, false, "Dependency job summaries should expose cancellation safety.");

  assert(dependenciesIpcSource.includes("progressMode: \"indeterminate\"") && !dependenciesIpcSource.includes("progress: 25"), "Dependency IPC must not seed fake progress percentages.");
  assert(marketplaceServiceSource.includes("dependencyJobs") && marketplaceServiceSource.includes("progressMode: \"indeterminate\""), "Dependency Download Manager records must preserve job summaries and progress mode.");
  assert(marketplaceServiceSource.includes("linkChildDownloadRecord") && marketplaceServiceSource.includes('source: "marketplace"'), "Marketplace dependency installs must use shared dependency child jobs and diagnostics state.");
  assert(dependenciesIpcSource.includes("diagnostics.updateRuntimeState") && dependenciesIpcSource.includes("dependencyInstall"), "Dependency IPC must publish sanitized install state into diagnostics/readiness.");
  assert(agentDependencySource.includes("windowsHide: true"), "Dependency command execution must hide Windows command windows.");
  assert(agentDependencySource.includes("getDependencyCommands") && agentDependencySource.includes("windowsCommands"), "Dependency scanning must choose platform-aware Windows commands.");
  assert(agentDependencySource.includes("detectWindowsRegistryDependency") && agentDependencySource.includes("windowsRegistry"), "Dependency scanning must support Windows registry-backed runtime detection.");
  assert(agentDependencySource.includes("installed-unavailable") && agentDependencySource.includes("detection-failed"), "Dependency scanning must distinguish installed-but-unavailable and detection-failed states.");
  assert(agentDependencySource.includes("ANXOS_LOCAL_AGENT_RUNTIME_ROOT") && agentDependencySource.includes("privateRuntime"), "Dependency scanning must honor the AnxOS managed private Local Agent runtime.");
  assert(agentDependencySource.includes("installWindowsDependency") && agentDependencySource.includes("\"winget\""), "Windows dependencies must use the managed Windows Package Manager install path.");
  assert(agentDependencySource.includes("--accept-package-agreements") && agentDependencySource.includes("--accept-source-agreements"), "Windows dependency installs must use fixed non-interactive package-manager arguments.");
  assert(agentDependencySource.includes("WINDOWS_DEPENDENCY_INSTALL_FAILED") && agentDependencySource.includes("WINDOWS_INSTALLER_UNAVAILABLE"), "Windows dependency installs must report structured failures.");
  assert(agentDependencySource.includes("externalTerminal: false") && agentDependencySource.includes("executionBackend: \"agent\""), "Agent dependency jobs must declare backend execution without external terminals.");
  assert(agentDependencySource.includes("AUTHORIZATION_REQUIRED") && agentDependencySource.includes("VERIFICATION_FAILED"), "Dependency lifecycle must expose structured authorization and verification states.");
  assert(serviceRouterSource.includes("executionBackend: \"desktop\"") && serviceRouterSource.includes("installationMethod: \"local-noop\""), "Local Desktop dependency routing must stay owned by the Desktop backend.");
  [
    "function buildDependencyInstallPanel",
    "Install Dependency",
    "Installation Details",
    "Selected node backend",
    "Retry Verification",
    "formatDependencyProgress",
    "getDependencyFriendlyState",
    "Installed but unavailable",
    "Detection failed",
    "isDependencyDownload",
    "dataset.downloadType",
  ].forEach((needle) => assert(appSource.includes(needle), `Renderer dependency install interface should include ${needle}.`));
  [
    ".download-item--dependency",
    ".dependency-install-panel",
    ".download-progress.is-indeterminate",
    "@keyframes dependency-progress-sweep",
  ].forEach((needle) => assert(stylesSource.includes(needle), `Dependency install UI styles should include ${needle}.`));

  dependencyService.__setTestHooks();
  console.log("Dependency smoke passed.");
}

run().catch((error) => {
  dependencyService.__setTestHooks();
  console.error(error);
  process.exit(1);
});
