#!/usr/bin/env node
// Second-machine comparison.
//
// Compares a second-machine summary.json (produced by
// scripts/second-machine-acceptance.js) against a baseline summary using the
// rules documented in docs/SECOND_MACHINE_ACCEPTANCE.md:
//
//   must match: summary.status; the commit (against --baseline-commit when
//   given, otherwise the baseline summary's commit); and, per harness, the
//   pass flag/status, the failed names (failedResults / failed / failures), the
//   renderer error count, and the onboarding checks total.
//
//   ignored: label, startedAt, node, platform, artifactDir and every other
//   absolute path, screenshot bytes, smallControlCount, executableSha256, and
//   any field not listed above. The responsive checks total is reported as an
//   informational delta only.
//
// Usage:
//   node scripts/second-machine-compare.js --summary <summary.json>
//     --baseline <summary.json|baseline-dir> [--baseline-commit <sha>]
//     [--out <report.json>]
//   node scripts/second-machine-compare.js --self-test
//
// Exit codes: 0 = REPLICATES, 1 = DIVERGES, 2 = INVALID (unusable input or
// bad usage). The report JSON is always printed to stdout; --out writes the
// same document to a file and is the only side effect.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HARNESS_KEYS = ["qaAcceptance", "onboarding", "responsive"];
// Matches MAX_SUMMARY_ENTRIES in scripts/second-machine-acceptance.js: the
// wrapper caps failure lists at this length, so a full list is a truncation
// signal rather than an exact count.
const TRUNCATION_LIMIT = 50;

const USAGE = [
  "Usage: node scripts/second-machine-compare.js --summary <summary.json> --baseline <summary.json|baseline-dir> [options]",
  "",
  "Options:",
  "  --summary <path>          Required. Second-machine summary.json (or the directory containing it).",
  "  --baseline <path>         Required. Baseline summary.json, or a baseline output directory containing summary.json.",
  "  --baseline-commit <sha>   Optional expected commit; when omitted, the baseline summary's commit is the anchor.",
  "  --out <path>              Optional report path. The report JSON is always printed to stdout.",
  "  --self-test               Run the hermetic self-test (synthetic REPLICATES/DIVERGES/INVALID cases).",
  "  --help, -h                Show this help.",
  "",
  "Exit codes: 0 = REPLICATES, 1 = DIVERGES, 2 = INVALID.",
].join("\n");

// Must-match ("must") fields drive the verdict; "info" fields are reported as
// deltas and notes only. The responsive checks total is informational by the
// documented rules; the onboarding checks total is must-match.
const HARNESS_RULES = {
  qaAcceptance: {
    scalars: [{ field: "pass", type: "boolean", mode: "must" }],
    counts: [{ field: "rendererErrors", report: "rendererErrorCount", mode: "must" }],
    lists: [{ field: "failedResults", report: "failedResults" }],
  },
  onboarding: {
    scalars: [
      { field: "status", type: "string", mode: "must" },
      { field: "checks", type: "number", mode: "must" },
    ],
    counts: [],
    lists: [{ field: "failed", report: "failed" }],
  },
  responsive: {
    scalars: [
      { field: "pass", type: "boolean", mode: "must" },
      { field: "checks", type: "number", mode: "info" },
    ],
    counts: [{ field: "rendererErrors", report: "rendererErrorCount", mode: "must" }],
    lists: [{ field: "failures", report: "failures" }],
  },
};

function parseArgs(argv) {
  const options = { summary: null, baseline: null, baselineCommit: null, out: null, selfTest: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === "--summary") options.summary = nextValue();
    else if (arg === "--baseline") options.baseline = nextValue();
    else if (arg === "--baseline-commit") options.baselineCommit = nextValue();
    else if (arg === "--out") options.out = nextValue();
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.selfTest && (!options.summary || !options.baseline)) {
    throw new Error("--summary and --baseline are required.");
  }
  return options;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareExitCode(comparison) {
  if (comparison === "REPLICATES") return 0;
  if (comparison === "DIVERGES") return 1;
  return 2;
}

function isSkipped(entry) {
  return entry?.skipped === true || entry?.status === "SKIPPED";
}

// Summary entries are strings in practice; object forms are tolerated so a
// future wrapper change (or a hand-built baseline) cannot silently drop names.
function listNames(value) {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (isObject(item) && typeof item.name === "string") return item.name;
    return JSON.stringify(item);
  });
}

function scalarValid(type, value) {
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length > 0;
}

// Compact projection used only when a harness cannot be compared (absent from
// one side), so the report still shows what the present side recorded.
function harnessSummaryView(key, entry) {
  const view = {};
  for (const { field } of HARNESS_RULES[key].scalars) view[field] = entry[field] ?? null;
  for (const { field, report } of HARNESS_RULES[key].counts) {
    view[report] = Array.isArray(entry[field]) ? entry[field].length : null;
  }
  for (const { field, report } of HARNESS_RULES[key].lists) view[report] = listNames(entry[field]);
  return view;
}

function compareHarness(key, baselineEntry, secondEntry) {
  const rules = HARNESS_RULES[key];
  const baseline = {};
  const second = {};
  const deltas = [];
  const notes = [];
  const newFailures = [];
  let incomparable = false;
  let mustDiffer = false;

  const recordMissing = (side, field) => {
    incomparable = true;
    notes.push(`${key}: the ${side} summary is missing a comparable "${field}" field.`);
  };

  for (const { field, type, mode } of rules.scalars) {
    const baselineValue = baselineEntry[field];
    const secondValue = secondEntry[field];
    const baselineOk = scalarValid(type, baselineValue);
    const secondOk = scalarValid(type, secondValue);
    if (!baselineOk) recordMissing("baseline", field);
    if (!secondOk) recordMissing("second-machine", field);
    baseline[field] = baselineOk ? baselineValue : null;
    second[field] = secondOk ? secondValue : null;
    if (baselineOk && secondOk && baselineValue !== secondValue) {
      deltas.push(`${field}: ${baselineValue} -> ${secondValue}`);
      if (mode === "must") mustDiffer = true;
      else notes.push(`${key}: ${field} changed (informational; not a must-match field).`);
    }
  }

  for (const { field, report, mode } of rules.counts) {
    const baselineList = baselineEntry[field];
    const secondList = secondEntry[field];
    const baselineOk = Array.isArray(baselineList);
    const secondOk = Array.isArray(secondList);
    if (!baselineOk) recordMissing("baseline", field);
    if (!secondOk) recordMissing("second-machine", field);
    const baselineCount = baselineOk ? baselineList.length : null;
    const secondCount = secondOk ? secondList.length : null;
    baseline[report] = baselineCount;
    second[report] = secondCount;
    if (baselineOk && secondOk && baselineCount !== secondCount) {
      deltas.push(`${report}: ${baselineCount} -> ${secondCount}`);
      if (mode === "must") mustDiffer = true;
    }
    if (
      (baselineOk && baselineList.length >= TRUNCATION_LIMIT)
      || (secondOk && secondList.length >= TRUNCATION_LIMIT)
    ) {
      notes.push(`${key}: ${field} is at the ${TRUNCATION_LIMIT}-entry summary cap; counts compare the recorded list.`);
    }
  }

  for (const { field, report } of rules.lists) {
    const baselineNames = listNames(baselineEntry[field]);
    const secondNames = listNames(secondEntry[field]);
    if (!baselineNames) recordMissing("baseline", field);
    if (!secondNames) recordMissing("second-machine", field);
    baseline[report] = baselineNames;
    second[report] = secondNames;
    if (!baselineNames || !secondNames) continue;
    const baselineSet = new Set(baselineNames);
    const secondSet = new Set(secondNames);
    const added = secondNames.filter((name) => !baselineSet.has(name));
    const dropped = baselineNames.filter((name) => !secondSet.has(name));
    for (const name of added) {
      deltas.push(`new failure: ${name}`);
      newFailures.push(name);
    }
    for (const name of dropped) {
      deltas.push(`missing failure (present in baseline): ${name}`);
    }
    if (added.length > 0 || dropped.length > 0) mustDiffer = true;
    if (baselineNames.length >= TRUNCATION_LIMIT || secondNames.length >= TRUNCATION_LIMIT) {
      notes.push(`${key}: ${field} is at the ${TRUNCATION_LIMIT}-entry summary cap; names compare the recorded list.`);
    }
  }

  const verdict = incomparable ? "INCOMPARABLE" : mustDiffer ? "DIVERGES" : "REPLICATES";
  return { baseline, second, deltas, verdict, newFailures, notes };
}

function buildReport({ baseline, second, baselineError, secondError, options }) {
  const notes = [];
  const missingHarnesses = [];
  const newFailures = [];
  const harnesses = {};
  const baselineCommit = baseline && typeof baseline.commit === "string" && baseline.commit ? baseline.commit : null;
  const secondCommit = second && typeof second.commit === "string" && second.commit ? second.commit : null;
  const assertedCommit = options.baselineCommit || null;
  const expectedCommit = assertedCommit || baselineCommit;
  const committed = Boolean(baseline) && Boolean(second);
  let commitMatch = false;
  let statusComparable = false;
  let statusMismatch = false;

  if (baselineError) notes.push(baselineError);
  if (secondError) notes.push(secondError);

  if (committed) {
    if (!expectedCommit) {
      notes.push("No commit anchor is available: the baseline summary records no commit and --baseline-commit was not given.");
    } else {
      const baselineConsistent = baselineCommit ? baselineCommit === expectedCommit : true;
      const secondConsistent = secondCommit === expectedCommit;
      commitMatch = baselineConsistent && secondConsistent;
      if (!baselineConsistent) {
        notes.push(`The baseline summary records commit ${baselineCommit}, which does not match the asserted --baseline-commit ${expectedCommit}.`);
      }
      if (assertedCommit && !baselineCommit) {
        notes.push("The baseline summary records no commit; --baseline-commit was used as the anchor.");
      }
      if (!secondConsistent) {
        if (assertedCommit) {
          notes.push(`Commit mismatch: expected ${expectedCommit} but the second-machine summary records ${secondCommit}.`);
        } else {
          notes.push(`Commits differ: baseline ${baselineCommit}, second ${secondCommit}. Pass --baseline-commit to assert the expected commit.`);
        }
      }
    }

    const baselineStatus = typeof baseline.status === "string" && baseline.status ? baseline.status : null;
    const secondStatus = typeof second.status === "string" && second.status ? second.status : null;
    if (!baselineStatus || !secondStatus) {
      notes.push("A summary is missing its overall status field; the comparison is invalid.");
    } else {
      statusComparable = true;
      if (baselineStatus !== secondStatus) {
        statusMismatch = true;
        notes.push(`Overall status differs: baseline ${baselineStatus}, second ${secondStatus}.`);
      }
    }

    for (const key of HARNESS_KEYS) {
      const baselineEntry = baseline.harnesses && baseline.harnesses[key];
      const secondEntry = second.harnesses && second.harnesses[key];
      if (!isObject(baselineEntry) || !isObject(secondEntry)) {
        missingHarnesses.push(key);
        harnesses[key] = {
          baseline: isObject(baselineEntry) ? harnessSummaryView(key, baselineEntry) : null,
          second: isObject(secondEntry) ? harnessSummaryView(key, secondEntry) : null,
          deltas: [],
          verdict: "MISSING",
        };
        const sides = !isObject(baselineEntry) && !isObject(secondEntry)
          ? "both summaries"
          : !isObject(baselineEntry) ? "the baseline summary" : "the second-machine summary";
        notes.push(`Harness ${key} is absent from ${sides}; the comparison is invalid.`);
        continue;
      }
      const baselineSkipped = isSkipped(baselineEntry);
      const secondSkipped = isSkipped(secondEntry);
      if (baselineSkipped || secondSkipped) {
        const bothSkipped = baselineSkipped && secondSkipped;
        harnesses[key] = {
          baseline: { skipped: true, status: baselineEntry.status || "SKIPPED" },
          second: { skipped: true, status: secondEntry.status || "SKIPPED" },
          deltas: bothSkipped ? [] : ["skipped: true on one machine only"],
          verdict: bothSkipped ? "REPLICATES" : "DIVERGES",
        };
        notes.push(`${key} was skipped on ${bothSkipped ? "both machines" : baselineSkipped ? "the baseline machine" : "the second machine"}.`);
        continue;
      }
      const result = compareHarness(key, baselineEntry, secondEntry);
      harnesses[key] = {
        baseline: result.baseline,
        second: result.second,
        deltas: result.deltas,
        verdict: result.verdict,
      };
      for (const note of result.notes) notes.push(note);
      for (const name of result.newFailures) newFailures.push({ harness: key, name });
    }
  }

  let comparison = "REPLICATES";
  if (!committed) {
    comparison = "INVALID";
  } else {
    const anyIncomparable = HARNESS_KEYS.some((key) => harnesses[key].verdict === "INCOMPARABLE" || harnesses[key].verdict === "MISSING");
    const anyDiverges = HARNESS_KEYS.some((key) => harnesses[key].verdict === "DIVERGES");
    if (!commitMatch || missingHarnesses.length > 0 || !statusComparable || anyIncomparable) comparison = "INVALID";
    else if (anyDiverges || statusMismatch) comparison = "DIVERGES";
  }

  return {
    comparison,
    commitMatch,
    baselineCommit,
    secondCommit,
    harnesses,
    newFailures,
    missingHarnesses,
    notes,
  };
}

// Resolves a summary input: a summary.json path, or a baseline output directory
// containing summary.json (the wrapper's --out directory). Read failures are
// reported as notes, never thrown, so an INVALID report is still emitted.
function readSummaryInput(rawInput) {
  const resolved = path.resolve(rawInput);
  let target = resolved;
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) target = path.join(resolved, "summary.json");
  } catch {
    // Fall through; the read below reports the usable error.
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!isObject(parsed)) return { summary: null, error: `could not read ${target}: the summary must be a JSON object.` };
    return { summary: parsed, error: null };
  } catch (error) {
    if (error instanceof SyntaxError) return { summary: null, error: `could not read ${target}: not valid JSON.` };
    if (error && error.code === "ENOENT") return { summary: null, error: `could not read ${target}: file not found.` };
    return { summary: null, error: `could not read ${target}: ${error?.message || error}` };
  }
}

function runCompare(options) {
  const baselineLoad = readSummaryInput(options.baseline);
  const secondLoad = readSummaryInput(options.summary);
  const report = buildReport({
    baseline: baselineLoad.summary,
    second: secondLoad.summary,
    baselineError: baselineLoad.error,
    secondError: secondLoad.error,
    options,
  });
  if (options.out) {
    const outPath = path.resolve(options.out);
    try {
      fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      return { exitCode: 2, report, writeError: `could not write ${outPath}: ${error?.message || error}` };
    }
  }
  return { exitCode: compareExitCode(report.comparison), report, writeError: null };
}

const FIXTURE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function fixtureSummary(overrides = {}) {
  return {
    commit: FIXTURE_COMMIT,
    label: "fixture-machine",
    platform: "win32",
    node: "v22.0.0",
    executableSha256: null,
    startedAt: "2026-09-25T00:00:00.000Z",
    harnesses: {
      qaAcceptance: { pass: true, artifactDir: "C:\\fixture\\qa-acceptance", failedResults: [], rendererErrors: [] },
      onboarding: { status: "PASS", checks: 39, failed: [], artifactDir: "C:\\fixture\\onboarding" },
      responsive: { pass: true, artifactDir: "C:\\fixture\\responsive", checks: 45, failures: [], rendererErrors: [] },
    },
    status: "PASS",
    ...overrides,
  };
}

// Hermetic self-test: synthetic REPLICATES/DIVERGES/INVALID cases are written
// to a fresh temp directory, compared in-process, and asserted. It writes only
// inside its own mkdtemp directory and removes it afterwards.
function runSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-second-machine-compare-"));
  const failures = [];
  let checks = 0;
  const check = (label, actual, expected) => {
    checks += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const writeJson = (relative, value) => {
    const file = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };
  const writeText = (relative, text) => {
    const file = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  try {
    // Case 1: ignored fields differ; must-match fields are identical.
    {
      const second = fixtureSummary({ label: "second-machine", node: "v22.9.9", startedAt: "2026-09-25T01:00:00.000Z", executableSha256: "f".repeat(64) });
      second.harnesses.qaAcceptance.artifactDir = "D:\\other\\qa-acceptance";
      second.harnesses.responsive.smallControlCount = 999;
      const { exitCode, report } = runCompare({
        summary: writeJson("replicates/second.json", second),
        baseline: writeJson("replicates/baseline.json", fixtureSummary()),
      });
      check("replicates exit code", exitCode, 0);
      check("replicates verdict", report.comparison, "REPLICATES");
      check("replicates commitMatch", report.commitMatch, true);
      check("replicates newFailures", report.newFailures, []);
      check("replicates missingHarnesses", report.missingHarnesses, []);
      check("replicates notes", report.notes, []);
    }

    // Case 2: harness verdicts, failed names, counts, and status all diverge.
    {
      const second = fixtureSummary({ status: "FAIL" });
      second.harnesses.qaAcceptance.pass = false;
      second.harnesses.qaAcceptance.failedResults = ["navigation: console"];
      second.harnesses.qaAcceptance.rendererErrors = ["uncaught renderer error"];
      second.harnesses.onboarding.status = "FAIL";
      second.harnesses.onboarding.checks = 38;
      second.harnesses.onboarding.failed = ["dashboard reachable"];
      second.harnesses.responsive.failures = ["390x844/instances"];
      const { exitCode, report } = runCompare({
        summary: writeJson("diverges/second.json", second),
        baseline: writeJson("diverges/baseline.json", fixtureSummary()),
      });
      check("diverges exit code", exitCode, 1);
      check("diverges verdict", report.comparison, "DIVERGES");
      check("diverges commitMatch", report.commitMatch, true);
      check("diverges newFailures", report.newFailures, [
        { harness: "qaAcceptance", name: "navigation: console" },
        { harness: "onboarding", name: "dashboard reachable" },
        { harness: "responsive", name: "390x844/instances" },
      ]);
      check("diverges harness verdicts", HARNESS_KEYS.map((key) => report.harnesses[key].verdict), ["DIVERGES", "DIVERGES", "DIVERGES"]);
    }

    // Case 3: the responsive checks total is informational, not must-match.
    {
      const second = fixtureSummary();
      second.harnesses.responsive.checks = 44;
      const { exitCode, report } = runCompare({
        summary: writeJson("responsive-checks/second.json", second),
        baseline: writeJson("responsive-checks/baseline.json", fixtureSummary()),
      });
      check("responsive-checks exit code", exitCode, 0);
      check("responsive-checks verdict", report.comparison, "REPLICATES");
      check("responsive-checks deltas", report.harnesses.responsive.deltas, ["checks: 45 -> 44"]);
    }

    // Case 4: commit mismatch without --baseline-commit is INVALID with a note.
    {
      const second = fixtureSummary({ commit: "b".repeat(40) });
      const { exitCode, report } = runCompare({
        summary: writeJson("commit-mismatch/second.json", second),
        baseline: writeJson("commit-mismatch/baseline.json", fixtureSummary()),
      });
      check("commit-mismatch exit code", exitCode, 2);
      check("commit-mismatch verdict", report.comparison, "INVALID");
      check("commit-mismatch commitMatch", report.commitMatch, false);
      check("commit-mismatch note present", report.notes.some((note) => note.startsWith("Commits differ:")), true);
    }

    // Case 5: commit mismatch against an asserted --baseline-commit is INVALID.
    {
      const second = fixtureSummary({ commit: "c".repeat(40) });
      const { exitCode, report } = runCompare({
        summary: writeJson("asserted-commit/second.json", second),
        baseline: writeJson("asserted-commit/baseline.json", fixtureSummary()),
        baselineCommit: FIXTURE_COMMIT,
      });
      check("asserted-commit exit code", exitCode, 2);
      check("asserted-commit verdict", report.comparison, "INVALID");
      check("asserted-commit note present", report.notes.some((note) => note.startsWith("Commit mismatch:")), true);
    }

    // Case 6: unparseable input is INVALID.
    {
      const { exitCode, report } = runCompare({
        summary: writeText("unparseable/second.json", "{this is not json\n"),
        baseline: writeJson("unparseable/baseline.json", fixtureSummary()),
      });
      check("unparseable exit code", exitCode, 2);
      check("unparseable verdict", report.comparison, "INVALID");
      check("unparseable note present", report.notes.some((note) => note.includes("not valid JSON")), true);
    }

    // Case 7: a harness absent from one side is INVALID and listed.
    {
      const second = fixtureSummary();
      delete second.harnesses.onboarding;
      const { exitCode, report } = runCompare({
        summary: writeJson("missing-harness/second.json", second),
        baseline: writeJson("missing-harness/baseline.json", fixtureSummary()),
      });
      check("missing-harness exit code", exitCode, 2);
      check("missing-harness verdict", report.comparison, "INVALID");
      check("missing-harness list", report.missingHarnesses, ["onboarding"]);
    }

    // Case 8: a baseline directory plus --baseline-commit and --out replicate.
    {
      const baselineFile = writeJson("baseline-dir/baseline/summary.json", fixtureSummary());
      const baselineDir = path.dirname(baselineFile);
      const outFile = path.join(tempRoot, "baseline-dir", "report.json");
      const { exitCode, report } = runCompare({
        summary: writeJson("baseline-dir/second.json", fixtureSummary({ label: "second-machine" })),
        baseline: baselineDir,
        baselineCommit: FIXTURE_COMMIT,
        out: outFile,
      });
      check("baseline-dir exit code", exitCode, 0);
      check("baseline-dir verdict", report.comparison, "REPLICATES");
      const written = JSON.parse(fs.readFileSync(outFile, "utf8"));
      check("baseline-dir report written", written.comparison, "REPLICATES");
      check("baseline-dir report harnesses", Object.keys(written.harnesses), HARNESS_KEYS);
    }

    // Case 9: usage errors (missing required args) are detected before any IO.
    {
      let usageFailed = false;
      try {
        parseArgs([]);
      } catch {
        usageFailed = true;
      }
      check("usage error on missing args", usageFailed, true);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`[second-machine-compare] self-test FAIL: ${failure}\n`);
    process.stderr.write(`[second-machine-compare] self-test: ${checks - failures.length}/${checks} checks passed\n`);
    return 1;
  }
  process.stdout.write(`[second-machine-compare] self-test: ${checks} checks passed\n`);
  return 0;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[second-machine-compare] ${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.selfTest) return runSelfTest();

  const { exitCode, report, writeError } = runCompare(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (writeError) {
    process.stderr.write(`[second-machine-compare] ${writeError}\n`);
    return 2;
  }
  process.stderr.write(`[second-machine-compare] ${report.comparison} (exit ${exitCode})\n`);
  return exitCode;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`[second-machine-compare] fatal: ${error?.stack || error?.message || error}\n`);
  process.exitCode = 2;
}
