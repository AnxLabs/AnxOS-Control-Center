"use strict";

// Mutation check (service-managed instances): deliberately breaks each safety hook in a COPY of the source
// tree and requires the matching test file to FAIL. A guard whose removal does
// not fail a test is not protected. Run: node scripts/service-managed-mutation-check.js
// The real source is never modified; mutants live in a temp copy.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..");
// Only these trees are needed to run the smokes; copying the whole repo per mutant is wasteful.
const COPY_DIRS = ["src", "agent", "scripts", "config", "package.json"];
const CORE = "src/shared/instances/instanceServiceCore.js";
const RUNTIME = "src/shared/instances/serviceManagedRuntime.js";

const MUTANTS = [
  // Controls: the UNMUTATED copy must pass, or a "killed" mutant proves nothing (it could just be a broken harness).
  { control: true, name: "control: runtime smoke passes unmutated", file: RUNTIME, test: "service-managed-runtime-smoke.js" },
  { control: true, name: "control: instance smoke passes unmutated", file: CORE, test: "service-managed-instance-smoke.js" },
  { control: true, name: "control: routing smoke passes unmutated", file: CORE, test: "service-managed-agent-routing-smoke.js" },
  { control: true, name: "control: port smoke passes unmutated", file: CORE, test: "port-ownership-fail-closed-smoke.js" },
  { control: true, ui: true, name: "control: UI QA (running) passes unmutated", file: "app.js", test: "service-managed-ui-qa.js" },
  { control: true, ui: true, scenario: "unknown", name: "control: UI QA (unknown) passes unmutated", file: "app.js", test: "service-managed-ui-qa.js" },
  { name: "reconcile hook removed (would allow adoption)", file: CORE, test: "service-managed-instance-smoke.js",
    from: "  if (isServiceManaged(config)) {\n    return observeServiceManaged(config);\n  }\n  const detachedRuntime", to: "  const detachedRuntime" },
  { name: "start hook removed (would spawn)", file: CORE, test: "service-managed-instance-smoke.js",
    from: "  if (isServiceManaged(storedConfig)) {\n    return startServiceManaged(storedConfig);\n  }\n", to: "" },
  { name: "stop hook removed", file: CORE, test: "service-managed-instance-smoke.js",
    from: "  if (isServiceManaged(storedConfig)) {\n    return stopServiceManaged(storedConfig);\n  }\n", to: "" },
  { name: "restart becomes stop+start", file: CORE, test: "service-managed-instance-smoke.js",
    from: "    return restartServiceManaged(config);", to: "    await stopServiceManaged(config); return startServiceManaged(config);" },
  { name: "start-spawn guard removed", file: CORE, test: "service-managed-instance-smoke.js",
    from: "  assertNotServiceManaged(config, \"start-spawn\");\n", to: "" },
  { name: "console input allowed", file: CORE, test: "service-managed-instance-smoke.js",
    from: "    throw serviceManagedUnsupported(stored, \"console-command\");", to: "    /* mutated */" },
  { name: "force-kill allowed", file: CORE, test: "service-managed-instance-smoke.js",
    from: "    throw serviceManagedUnsupported(stored, \"force-kill\");", to: "    /* mutated */" },
  { name: "delete allowed", file: CORE, test: "service-managed-instance-smoke.js",
    from: "    throw serviceManagedUnsupported(config, \"delete\");", to: "    /* mutated */" },
  { name: "update allowed", file: CORE, test: "service-managed-instance-smoke.js",
    from: "    throw serviceManagedUnsupported(current, \"update\");", to: "    /* mutated */" },
  { name: "agent persists a PID", file: CORE, test: "service-managed-instance-smoke.js",
    from: "const base = { ...config, pid: null, runtimeProcess: null };", to: "const base = { ...config, pid: 4242, runtimeProcess: null };" },
  { name: "unreadable state treated as stopped", file: CORE, test: "service-managed-instance-smoke.js",
    from: "      state: INSTANCE_STATES.UNKNOWN,\n      readinessState: \"unknown\",\n      failureReason: error?.code || \"SERVICE_QUERY_FAILED\",", to: "      state: INSTANCE_STATES.STOPPED,\n      readinessState: \"stopped\",\n      failureReason: error?.code || \"SERVICE_QUERY_FAILED\"," },
  { name: "allowlist ignored", file: RUNTIME, test: "service-managed-runtime-smoke.js",
    from: "if (!getAllowlist().includes(unit)) {", to: "if (false) {" },
  { name: "dangerous verbs allowed", file: RUNTIME, test: "service-managed-runtime-smoke.js",
    from: "if (!CONTROL_VERBS.includes(verb)) {", to: "if (false) {" },
  { name: "reads elevate", file: RUNTIME, test: "service-managed-runtime-smoke.js",
    from: "const result = await exec(SYSTEMCTL_PATH, [\"show\"", to: "const result = await exec(\"/usr/bin/sudo\", [\"-n\", SYSTEMCTL_PATH, \"show\"" },
  { name: "unknown state mapped to stopped", file: RUNTIME, test: "service-managed-runtime-smoke.js",
    from: "return { stateKey: \"UNKNOWN\", failureReason: \"SERVICE_STATE_UNRECOGNIZED\" };", to: "return { stateKey: \"STOPPED\", failureReason: null };" },
  // Desktop integration
  { name: "desktop dependency pre-check gates service-managed start", file: "src/services/serviceRouter.js", test: "service-managed-agent-routing-smoke.js",
    from: "  if (instance?.type === \"systemd-service\") {\n    return;\n  }\n  const template = findMarketplaceTemplateById", to: "  const template = findMarketplaceTemplateById" },
  { name: "backups of a service-managed instance allowed", file: "agent/src/services/backupService.js", test: "service-managed-agent-routing-smoke.js",
    from: "  await assertBackupAllowedForInstance(instanceId);\n", to: "" },
  { name: "agent persists a PID (end to end)", file: CORE, test: "service-managed-agent-routing-smoke.js",
    from: "const base = { ...config, pid: null, runtimeProcess: null };", to: "const base = { ...config, pid: 4242, runtimeProcess: null };" },
  // Desktop UI (real Electron + real Agent; slower)
  { ui: true, name: "ui: console input not locked", file: "app.js", test: "service-managed-ui-qa.js",
    from: "  \"[data-instance-console-command]\",\n  \"[data-instance-console-form] button\",\n", to: "  \"[data-instance-console-form] button\",\n" },
  { ui: true, name: "ui: locks never released for ordinary instances", file: "app.js", test: "service-managed-ui-qa.js",
    from: "  serviceManagedLockedControls.forEach((element) => {\n    element.disabled = false;", to: "  serviceManagedLockedControls.forEach((element) => {\n    /* mutated: stay locked */" },
  { ui: true, name: "ui: delete/rename/duplicate stay enabled", file: "app.js", test: "service-managed-ui-qa.js",
    from: "  '[data-instance-action=\"rename\"]',\n  '[data-instance-action=\"duplicate\"]',\n", to: "" },
  { ui: true, name: "ui: backups stay enabled", file: "app.js", test: "service-managed-ui-qa.js",
    from: "  '[data-instance-backup-action=\"backup-now\"]',\n", to: "" },
  { ui: true, scenario: "unknown", name: "ui: Unknown shows raw code, not a reason", file: "app.js", test: "service-managed-ui-qa.js",
    from: "  const serviceManagedReason = isServiceManagedInstance(instance) ? describeServiceManagedFailure(instance?.failureReason) : \"\";", to: "  const serviceManagedReason = \"\";" },
  { ui: true, name: "ui: systemd notice never hidden", file: "app.js", test: "service-managed-ui-qa.js",
    from: "    card.hidden = !managed;", to: "    card.hidden = false;" },
  { ui: true, name: "ui: settings editable", file: "app.js", test: "service-managed-ui-qa.js",
    from: "    if (element.matches('[data-instance-action=\"forget\"]')) return;\n    lock(element);", to: "    return;" },
  ...require("./service-managed-operations-mutants"),
  // Port-conflict fail-closed
  { name: "unowned ports ignored (fail open)", file: CORE, test: "port-ownership-fail-closed-smoke.js",
    from: "for (const row of snapshot.unownedPorts || []) {", to: "for (const row of []) {" },
  { name: "incomplete snapshot tolerated", file: CORE, test: "port-ownership-fail-closed-smoke.js",
    from: "if (snapshot.complete === false && !snapshot.unsupported) {", to: "if (false) {" },
  { name: "inspection error swallowed", file: CORE, test: "port-ownership-fail-closed-smoke.js",
    from: "const portConflicts = await findUnrelatedPortConflicts(config);", to: "const portConflicts = await findUnrelatedPortConflicts(config).catch(() => []);" },
  { name: "pid-less owner row skipped", file: CORE, test: "port-ownership-fail-closed-smoke.js",
    from: "    if (!pid) {\n      conflicts.push({ port, protocol: row.protocol || null, pid: null, processName: null, ownerUnknown: true });\n      continue;\n    }", to: "    if (!pid) {\n      continue;\n    }" },
];

// The UI mutants launch the real Electron app, which needs most of the repo.
const UI_EXCLUDED_TOP_LEVEL = new Set(["node_modules", ".git", "artifacts", "release-artifacts", "logs", ".dev-logs"]);

function copyTree(src, dest, depth = 0, excludeTopLevel = null) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (depth === 0 && excludeTopLevel?.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to, depth + 1, excludeTopLevel); else fs.copyFileSync(from, to);
  }
}
function copyNeeded(repoRoot, work) {
  for (const name of COPY_DIRS) {
    const from = path.join(repoRoot, name);
    if (!fs.existsSync(from)) continue;
    if (fs.statSync(from).isDirectory()) copyTree(from, path.join(work, name)); else fs.copyFileSync(from, path.join(work, name));
  }
}

const only = process.argv[2];
const nameFilter = process.argv[3];
const results = [];
const leftovers = [];
for (const mutant of MUTANTS) {
  if (only && !mutant.test.includes(only)) continue;
  if (nameFilter && !mutant.name.includes(nameFilter)) continue;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "anx-mut-"));
  try {
    if (mutant.ui) copyTree(repo, work, 0, UI_EXCLUDED_TOP_LEVEL); else copyNeeded(repo, work);
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(work, "node_modules"), "junction");
    const target = path.join(work, mutant.file);
    // Working copies are CRLF on Windows; match on LF.
    const source = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
    if (!mutant.control) {
      // A mutant is one edit, or several that must all apply together (redundant guards).
      const edits = mutant.edits || [[mutant.from, mutant.to]];
      let mutated = source;
      let applicable = true;
      for (const [from, to] of edits) {
        if (mutated.split(from).length !== 2) { applicable = false; break; }
        mutated = mutated.replace(from, () => to);
      }
      if (!applicable) {
        results.push({ name: mutant.name, status: "BAD-MUTANT (pattern not unique/found)" });
        continue;
      }
      fs.writeFileSync(target, mutated);
    }
    let run;
    if (mutant.ui) {
      // Real Electron + real Agent. ELECTRON_RUN_AS_NODE (exported by VS Code extension hosts) must not leak in.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE" && !key.startsWith("VSCODE_")));
      run = spawnSync(process.execPath, [path.join(work, "scripts", mutant.test), mutant.scenario || "running"], { cwd: work, env, encoding: "utf8", timeout: 240000 });
    } else {
      run = spawnSync(process.execPath, ["--test", path.join(work, "scripts", mutant.test)], { cwd: work, encoding: "utf8", timeout: 120000 });
    }
    if (mutant.control) {
      const lines = String(run.stderr || run.stdout).split(/\r?\n/).filter(Boolean);
      if (run.status !== 0) {
        const logPath = path.join(os.tmpdir(), `mutation-control-${mutant.name.replace(/[^a-z0-9]+/gi, "-")}.log`);
        fs.writeFileSync(logPath, `${run.stdout || ""}\n${run.stderr || ""}`);
        lines.push(`(full output: ${logPath})`);
      }
      const headline = lines.find((line) => /Error|Timed out|assert/i.test(line) && !/^\s+at /.test(line)) || "";
      const tail = `${headline} | ${lines.slice(-2).join(" | ")}`.slice(0, 400);
      results.push({ name: mutant.name, control: true, status: run.status === 0 ? "killed" : `CONTROL FAILED (harness broken): ${tail}` });
    } else {
      results.push({ name: mutant.name, status: run.status === 0 ? "SURVIVED (test gap!)" : "killed" });
    }
  } finally {
    // Remove the node_modules junction first and non-recursively (rmdir removes only
    // the link), so a recursive delete can never follow it into the real node_modules.
    try { fs.rmdirSync(path.join(work, "node_modules")); } catch {}
    // Best effort: Windows (antivirus, a just-exited Electron) can briefly lock the
    // copy. A leftover temp directory must never abort the mutation report.
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
    } catch {
      leftovers.push(work);
    }
  }
}
// By now every spawned process has exited, so any copy that was still locked can go.
for (const work of leftovers) {
  try {
    try { fs.rmdirSync(path.join(work, "node_modules")); } catch {}
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
  } catch (error) {
    console.warn(`warning: could not remove ${work} (${error.code}); delete it manually`);
  }
}
let problems = 0;
for (const result of results) {
  const ok = result.status === "killed";
  if (!ok) problems += 1;
  const label = ok ? (result.control ? "CONTROL " : "KILLED  ") : "PROBLEM ";
  console.log(`${label} ${result.name}${ok ? "" : ` -> ${result.status}`}`);
}
const mutants = results.filter((result) => !result.control);
const controls = results.filter((result) => result.control);
console.log(`\n${mutants.filter((result) => result.status === "killed").length}/${mutants.length} mutants killed; ${controls.filter((result) => result.status === "killed").length}/${controls.length} controls pass unmutated`);
process.exit(problems === 0 ? 0 : 1);
