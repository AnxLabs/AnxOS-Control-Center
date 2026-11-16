// Package-managed Agent update: the Linux twin of the push update for Agents
// installed from the official `anxos-agent` .deb (systemd system unit).
//
// Called by remoteAgentUpdateService.updateRemoteAgent once it has verified
// the SSH target, confirmed the Agent is healthy, refused a downgrade and
// discovered a package-managed unit. It reuses that function's step list,
// health probe and update record. The order is:
//
//   preflight  architecture, installed version, passwordless sudo, and whether
//              any server process runs inside the Agent's own cgroup (an
//              Agent restart stops those; Docker containers and servers that
//              run as their own systemd unit are not in it and keep running)
//   download   the target build's .deb, and the installed build's .deb for
//              rollback, from the official release; each SHA-256 must match
//              the release's SHA256SUMS that the Desktop fetched itself, and
//              the package must name itself anxos-agent at the target build
//   backup     the Agent's config directory and identity file
//   install    sudo -n apt-get install of the verified file
//   verify     the Agent answers and reports the target build
//   rollback   on failure, reinstall the previous verified .deb and confirm the
//              Agent answers again on that build
//
// Nothing here widens privilege. When the SSH user cannot run sudo without a
// password, the update stops after the package is downloaded and verified and
// returns the exact command for the owner to run on the node.

const DEFAULT_RELEASE_BASE_URL = "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download";
const PACKAGE_NAME = "anxos-agent";
const UPDATE_DIRNAME = ".anxos-agent-package-update";
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300000;
const DEFAULT_INSTALL_TIMEOUT_MS = 300000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function agentDebName(build) {
  return `AnxOS-Agent-${build}.deb`;
}

function releaseTagForBuild(build) {
  return `v${build}`;
}

// "KEY=value" lines, one per marker; anything else is ignored.
function parseMarkers(output = "") {
  const markers = {};
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) markers[match[1]] = match[2].trim();
  }
  return markers;
}

function parseSha256Sums(text = "") {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

async function defaultFetchText(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "anxos-control-center" } });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), { code: "RELEASE_FETCH_FAILED", status: response.status });
  }
  return response.text();
}

// The digest comes from the Desktop's own HTTPS read of the release's
// SHA256SUMS, never from a file the node downloaded.
async function resolveReleasePackage(build, { fetchText = defaultFetchText, releaseBaseUrl = DEFAULT_RELEASE_BASE_URL } = {}) {
  const tag = releaseTagForBuild(build);
  const fileName = agentDebName(build);
  const sumsUrl = `${releaseBaseUrl}/${tag}/SHA256SUMS`;
  let sums;
  try {
    sums = parseSha256Sums(await fetchText(sumsUrl));
  } catch (error) {
    return { ok: false, tag, fileName, code: "AGENT_PACKAGE_RELEASE_UNAVAILABLE", message: `The ${tag} release or its SHA256SUMS could not be read (${error.message}).` };
  }
  const sha256 = sums.get(fileName) || null;
  if (!sha256) {
    return { ok: false, tag, fileName, code: "AGENT_PACKAGE_NOT_IN_RELEASE", message: `The ${tag} release does not list ${fileName} in SHA256SUMS.` };
  }
  return { ok: true, tag, fileName, sha256, url: `${releaseBaseUrl}/${tag}/${fileName}` };
}

function buildPreflightCommand(unitName = PACKAGE_NAME) {
  const unit = shellQuote(unitName);
  return [
    "set +e",
    `echo "ARCH=$(dpkg --print-architecture 2>/dev/null)"`,
    `echo "INSTALLED=$(dpkg-query -W -f='\${Version}' ${shellQuote(PACKAGE_NAME)} 2>/dev/null)"`,
    `if sudo -n true 2>/dev/null; then echo "SUDO=ok"; else echo "SUDO=password"; fi`,
    `if command -v curl >/dev/null 2>&1; then echo "CURL=yes"; else echo "CURL=no"; fi`,
    `MAIN=$(systemctl show ${unit} -p MainPID --value 2>/dev/null)`,
    `CG=$(systemctl show ${unit} -p ControlGroup --value 2>/dev/null)`,
    // Every process in the Agent's cgroup except the Agent itself is a server
    // (or helper) the Agent spawned; an Agent restart stops them.
    `if [ -n "$CG" ] && [ -r "/sys/fs/cgroup$CG/cgroup.procs" ]; then echo "CHILDREN=$(grep -vxc "$MAIN" "/sys/fs/cgroup$CG/cgroup.procs")"; else echo "CHILDREN=unknown"; fi`,
    `echo "ENV=$(systemctl show ${unit} -p Environment --value 2>/dev/null)"`,
    `echo "HOME=$HOME"`,
    `echo "HOMEFREE_KB=$(df -Pk "$HOME" | awk 'NR==2{print $4}')"`,
  ].join("\n");
}

function readUnitEnvironment(envLine = "") {
  const env = {};
  for (const token of String(envLine).split(/\s+/)) {
    const index = token.indexOf("=");
    if (index > 0) env[token.slice(0, index)] = token.slice(index + 1);
  }
  return env;
}

// Downloads one release file into the update directory and prints its digest
// and package identity. The Desktop decides whether those are acceptable.
function buildDownloadCommand({ dir, url, fileName, prefix }) {
  const target = `${dir}/${fileName}`;
  return [
    "set -e",
    `mkdir -p ${shellQuote(dir)}`,
    `curl -fsSL --retry 2 -o ${shellQuote(target)} ${shellQuote(url)}`,
    `echo "${prefix}_SHA256=$(sha256sum ${shellQuote(target)} | cut -d' ' -f1)"`,
    `echo "${prefix}_PACKAGE=$(dpkg-deb -f ${shellQuote(target)} Package)"`,
    `echo "${prefix}_VERSION=$(dpkg-deb -f ${shellQuote(target)} Version)"`,
    `echo "${prefix}_ARCH=$(dpkg-deb -f ${shellQuote(target)} Architecture)"`,
    `echo "${prefix}_RELEASE=$(dpkg-deb --fsys-tarfile ${shellQuote(target)} | tar -xO ./usr/lib/anxos-agent/agent-release.json 2>/dev/null | grep -o '"artifactVersion": *"[^"]*"' | sed -e 's/.*: *"//' -e 's/"$//')"`,
    `echo "${prefix}_PATH=${target}"`,
  ].join("\n");
}

function buildBackupCommand({ dir, env }) {
  const sources = [env.ANXHUB_CONFIG_DIR, env.AGENT_IDENTITY_PATH].filter(Boolean);
  const list = sources.length ? sources.map(shellQuote).join(" ") : "/var/lib/anxos-agent/config";
  return [
    "set -e",
    `sudo -n tar czf ${shellQuote(`${dir}/agent-state-backup.tgz`)} --ignore-failed-read ${list} /etc/anxos-agent 2>/dev/null || sudo -n tar czf ${shellQuote(`${dir}/agent-state-backup.tgz`)} --ignore-failed-read ${list}`,
    `sudo -n chown "$(id -u):$(id -g)" ${shellQuote(`${dir}/agent-state-backup.tgz`)}`,
    `echo "BACKUP_PATH=${dir}/agent-state-backup.tgz"`,
  ].join("\n");
}

function buildInstallCommand(debPath, { allowDowngrade = false } = {}) {
  return [
    "set +e",
    `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ${allowDowngrade ? "--allow-downgrades " : ""}${shellQuote(debPath)} > /tmp/anxos-agent-package-install.log 2>&1`,
    `echo "INSTALL_EXIT=$?"`,
    `echo "INSTALLED=$(dpkg-query -W -f='\${Version}' ${shellQuote(PACKAGE_NAME)} 2>/dev/null)"`,
    `echo "ACTIVE=$(systemctl is-active ${shellQuote(PACKAGE_NAME)} 2>/dev/null)"`,
    "tail -n 5 /tmp/anxos-agent-package-install.log | sed 's/^/LOG: /'",
  ].join("\n");
}

function checkDownloaded(markers, prefix, expected) {
  const problems = [];
  if ((markers[`${prefix}_SHA256`] || "").toLowerCase() !== expected.sha256) problems.push("its SHA-256 does not match the release's SHA256SUMS");
  if (markers[`${prefix}_PACKAGE`] !== PACKAGE_NAME) problems.push(`it is package "${markers[`${prefix}_PACKAGE`] || "unknown"}", not ${PACKAGE_NAME}`);
  if (markers[`${prefix}_VERSION`] !== expected.build) problems.push(`it is version ${markers[`${prefix}_VERSION`] || "unknown"}, not ${expected.build}`);
  if (markers[`${prefix}_RELEASE`] && markers[`${prefix}_RELEASE`] !== expected.build) problems.push(`its embedded release identity is ${markers[`${prefix}_RELEASE`]}`);
  if (expected.arch && markers[`${prefix}_ARCH`] && markers[`${prefix}_ARCH`] !== expected.arch) problems.push(`it is for ${markers[`${prefix}_ARCH`]}, the node is ${expected.arch}`);
  return problems;
}

async function updatePackageManagedAgent(ctx) {
  const {
    nodeId, profile, run, healthProbe, sleep, verifyAttempts, verifyDelayMs,
    targetBuild, installedBuild, unitName = PACKAGE_NAME, stamp,
    mark, fail, record, finishRecord, isVerified,
  } = ctx;
  const fetchText = ctx.fetchText || defaultFetchText;
  const runOn = (command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) => run(profile.id, command, { timeoutMs }).catch((error) => {
    throw fail(error.code || "REMOTE_AGENT_UPDATE_SSH_FAILED", error.message, { sshOutput: error.sshOutput || null });
  });
  record.method = "package";
  record.targetBuild = targetBuild;
  record.installedBuild = installedBuild || null;

  if (!targetBuild) {
    throw fail("AGENT_BUILD_UNVERIFIED", "This Desktop cannot read the build of its own bundled Agent, so it cannot choose which package to install. Reinstall AnxOS Control Center, then retry.");
  }

  // ---- preflight
  mark("workloads", "running");
  const preflight = parseMarkers((await runOn(buildPreflightCommand(unitName))).stdout);
  record.preflight = { arch: preflight.ARCH, installed: preflight.INSTALLED, sudo: preflight.SUDO, children: preflight.CHILDREN };
  if (preflight.INSTALLED === targetBuild) {
    mark("workloads", "complete", `The node already runs ${targetBuild}.`);
    return { ok: true, updated: false, upToDate: true, nodeId, method: "package", installedBuild: targetBuild, targetBuild };
  }
  if (preflight.ARCH !== "amd64") {
    throw fail("AGENT_PACKAGE_ARCH_UNSUPPORTED", `Agent packages are published for amd64; this node is ${preflight.ARCH || "unknown"}.`);
  }
  if (preflight.CURL !== "yes") {
    throw fail("AGENT_PACKAGE_CURL_MISSING", "The node needs curl to download the Agent package (sudo apt-get install curl).");
  }
  const children = Number.parseInt(preflight.CHILDREN, 10);
  if (!Number.isInteger(children)) {
    mark("workloads", "failed", "Could not tell whether servers are running under the Agent.");
    throw fail("REMOTE_AGENT_UPDATE_WORKLOADS_UNKNOWN", "AnxOS could not tell whether servers are running under this Agent, so it did not restart it. Stop the node's servers, then retry.");
  }
  if (children > 0) {
    mark("workloads", "failed", `${children} server process(es) run under the Agent.`);
    throw fail("REMOTE_AGENT_UPDATE_SERVERS_RUNNING", `${children} server process(es) are running under this Agent, and updating it restarts the Agent, which stops them. Back up and stop the node's servers, then update. Docker containers and servers that run as their own system service are not affected.`, { children });
  }
  mark("workloads", "complete", "No servers run under the Agent; Docker containers and separate system services are not affected by the restart.");

  // ---- download and verify (target, then rollback package)
  mark("stage", "running");
  const target = await resolveReleasePackage(targetBuild, { fetchText, releaseBaseUrl: ctx.releaseBaseUrl });
  if (!target.ok) throw fail(target.code, target.message);
  const previous = installedBuild ? await resolveReleasePackage(installedBuild, { fetchText, releaseBaseUrl: ctx.releaseBaseUrl }) : { ok: false, message: "The node's installed Agent does not report its build." };
  if (!previous.ok && ctx.allowWithoutRollback !== true) {
    mark("stage", "failed", "No verified package to roll back to.");
    throw fail("REMOTE_AGENT_UPDATE_ROLLBACK_UNAVAILABLE", `AnxOS can only update this Agent when it can roll back, and it has no verified package for the installed build (${installedBuild || "unknown"}): ${previous.message} Update this node once by hand; later updates can then roll back.`);
  }
  if (!preflight.HOME || !preflight.HOME.startsWith("/")) {
    throw fail("REMOTE_AGENT_UPDATE_SSH_FAILED", "Could not read the SSH user's home directory on the node.");
  }
  const dir = `${preflight.HOME}/${UPDATE_DIRNAME}/${stamp}`;
  const downloaded = parseMarkers((await runOn(buildDownloadCommand({ dir, url: target.url, fileName: target.fileName, prefix: "NEW" }), DEFAULT_DOWNLOAD_TIMEOUT_MS)).stdout);
  const targetProblems = checkDownloaded(downloaded, "NEW", { sha256: target.sha256, build: targetBuild, arch: preflight.ARCH });
  if (targetProblems.length) {
    mark("stage", "failed", "The downloaded package failed verification.");
    throw fail("AGENT_PACKAGE_VERIFICATION_FAILED", `The downloaded ${target.fileName} was refused: ${targetProblems.join("; ")}. Nothing was installed.`, { problems: targetProblems });
  }
  let previousPath = null;
  if (previous.ok) {
    const prev = parseMarkers((await runOn(buildDownloadCommand({ dir, url: previous.url, fileName: previous.fileName, prefix: "OLD" }), DEFAULT_DOWNLOAD_TIMEOUT_MS)).stdout);
    const previousProblems = checkDownloaded(prev, "OLD", { sha256: previous.sha256, build: installedBuild, arch: preflight.ARCH });
    if (previousProblems.length) {
      throw fail("AGENT_PACKAGE_VERIFICATION_FAILED", `The rollback package ${previous.fileName} was refused: ${previousProblems.join("; ")}. Nothing was installed.`, { problems: previousProblems });
    }
    previousPath = prev.OLD_PATH;
  }
  const newPath = downloaded.NEW_PATH;
  record.packagePath = newPath;
  record.rollbackPackagePath = previousPath;
  mark("stage", "complete", `${target.fileName} downloaded and verified against the ${target.tag} SHA256SUMS${previousPath ? `; rollback package ${previous.fileName} verified too` : ""}.`);

  // ---- privilege
  const manualCommand = `sudo apt-get install ${newPath}`;
  if (preflight.SUDO !== "ok") {
    mark("swap", "blocked", "The SSH user needs a password for sudo.");
    record.status = "awaiting-manual-install";
    finishRecord();
    throw fail("REMOTE_AGENT_UPDATE_SUDO_REQUIRED", `The package is downloaded and verified, but ${profile.username || "the SSH user"} needs a password for sudo on this node, so AnxOS did not install it. On the node, run: ${manualCommand}`, { manualCommand, packagePath: newPath });
  }

  // ---- backup + install
  mark("swap", "running");
  const env = readUnitEnvironment(preflight.ENV);
  const backup = parseMarkers((await runOn(buildBackupCommand({ dir, env }))).stdout);
  record.backupPath = backup.BACKUP_PATH || null;
  const install = parseMarkers((await runOn(buildInstallCommand(newPath), DEFAULT_INSTALL_TIMEOUT_MS)).stdout);
  record.install = install;
  if (install.INSTALL_EXIT !== "0" || install.INSTALLED !== targetBuild) {
    mark("swap", "failed", `apt-get exited ${install.INSTALL_EXIT}; installed version is ${install.INSTALLED || "unknown"}.`);
  } else {
    mark("swap", "complete", `Installed ${targetBuild}; state backed up to ${record.backupPath || "the update folder"}.`);
  }

  // ---- verify
  let verification = null;
  if (install.INSTALL_EXIT === "0" && install.INSTALLED === targetBuild) {
    mark("verify", "running");
    for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
      verification = await healthProbe(nodeId).catch((error) => ({ connected: false, probeError: error?.code || "probe-failed" }));
      if (isVerified(verification, targetBuild)) break;
      if (attempt < verifyAttempts - 1) await sleep(verifyDelayMs);
    }
    record.verification = verification;
    if (isVerified(verification, targetBuild)) {
      mark("verify", "complete", `The Agent answers and reports ${targetBuild}.`);
      record.status = "updated";
      const recordPath = finishRecord();
      return { ok: true, updated: true, nodeId, method: "package", installedBuild, targetBuild, packagePath: newPath, backupPath: record.backupPath, recordPath, verification };
    }
    mark("verify", "failed", `The Agent did not report ${targetBuild} in time.`);
  }

  // ---- rollback
  mark("rollback", "running");
  if (!previousPath) {
    mark("rollback", "failed", "No rollback package.");
    record.status = "failed-no-rollback";
    const recordPath = finishRecord();
    throw fail("REMOTE_AGENT_UPDATE_VERIFY_FAILED", `The ${targetBuild} Agent did not come up and there was no package to roll back to. Inspect the node (journalctl -u anxos-agent).`, { verification, install, recordPath });
  }
  const restore = parseMarkers((await runOn(buildInstallCommand(previousPath, { allowDowngrade: true }), DEFAULT_INSTALL_TIMEOUT_MS)).stdout);
  let afterRollback = null;
  for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
    afterRollback = await healthProbe(nodeId).catch((error) => ({ connected: false, probeError: error?.code || "probe-failed" }));
    if (isVerified(afterRollback, installedBuild)) break;
    if (attempt < verifyAttempts - 1) await sleep(verifyDelayMs);
  }
  const rolledBack = restore.INSTALL_EXIT === "0" && restore.INSTALLED === installedBuild && isVerified(afterRollback, installedBuild);
  record.rollback = { restore, verified: rolledBack, healthAfterRollback: afterRollback };
  record.status = rolledBack ? "rolled-back" : "rollback-failed";
  mark("rollback", rolledBack ? "complete" : "failed", rolledBack ? `Reinstalled ${installedBuild}; the Agent answers again.` : "The rollback could not be confirmed healthy.");
  const recordPath = finishRecord();
  throw fail("REMOTE_AGENT_UPDATE_VERIFY_FAILED", rolledBack
    ? `The ${targetBuild} Agent did not come up, so AnxOS reinstalled ${installedBuild} and it is healthy again.`
    : `The ${targetBuild} Agent did not come up and the rollback to ${installedBuild} could not be confirmed. Inspect the node (journalctl -u anxos-agent).`, { verification, install, rollback: record.rollback, recordPath });
}

module.exports = {
  updatePackageManagedAgent,
  resolveReleasePackage,
  _test: {
    agentDebName,
    buildBackupCommand,
    buildDownloadCommand,
    buildInstallCommand,
    buildPreflightCommand,
    checkDownloaded,
    parseMarkers,
    parseSha256Sums,
    readUnitEnvironment,
  },
};
