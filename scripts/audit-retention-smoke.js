// Hermetic smoke for V2-I audit retention / access review / export.
//
// Proves, against a seeded audit store shaped like the real one:
//   - the retention rule prunes exactly what it documents (positive control);
//   - NO protected class is ever pruned, including with a cap that forces it
//     (the operation is refused instead);
//   - an undeterminable class is treated as protected;
//   - the access-review projection is correct for a seeded window and carries
//     no seeded secret;
//   - the export is deterministic (byte-identical) and redacted;
//   - an oversized window is refused rather than truncated;
//   - the service layer reads the real store and gates on permission.
const assert = require("assert");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-audit-retention-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const policy = require("../src/shared/auditRetentionPolicy");
const security = require("../src/services/securityService");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = new Date(NOW - 40 * DAY_MS).toISOString();
const RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();
const SECRET_VALUE = "SEEDEDSECRETVALUE9f3a";
const SEEDED_PRIVATE_PATH = "C:\\Users\\seeduser\\instances\\world";

function check(condition, message) {
  assert(condition, message);
}

function serviceRecord(overrides) {
  return { at: OLD, actor: null, action: "unknown.action", outcome: "ok", target: null, reason: null, ...overrides };
}

const seeded = [
  // --- prunable routine ------------------------------------------------
  serviceRecord({ at: OLD, action: "alerts.list", outcome: "ok", target: "alerts" }),
  serviceRecord({ at: RECENT, action: "alerts.list", outcome: "ok", target: "alerts" }),
  // --- one seed per protected class ------------------------------------
  serviceRecord({ at: OLD, action: "security.login", outcome: "failed", target: "owner", reason: "INVALID_CREDENTIALS" }),
  serviceRecord({ at: OLD, action: "security.permission", outcome: "denied", target: "audit-log", reason: "settings:write" }),
  serviceRecord({ at: OLD, action: "security.session.revoke", outcome: "ok", target: "session-abc" }),
  serviceRecord({ at: OLD, action: "backup.delete", outcome: "ok", target: "backup-abc" }),
  serviceRecord({ at: OLD, action: "instance.neoforge.repairRuntime", outcome: "ok", target: "instance-abc" }),
  serviceRecord({ at: OLD, action: "agent.token.rotate", outcome: "ok", target: "fingerprint" }),
  serviceRecord({ at: OLD, action: "totally.unmapped.action", outcome: "ok", target: "mystery" }),
  // --- undeterminable ---------------------------------------------------
  { action: "alerts.list", outcome: "ok", target: "alerts", reason: null },
  { at: "not-a-date", action: "security.login", outcome: "ok" },
  { at: OLD, action: "alerts.list", outcome: "failed", target: "alerts", reason: null },
  {},
  // --- secret-bearing, inside the review window -------------------------
  {
    at: RECENT,
    actor: { id: "seed-actor-secret", username: "seeduser", role: "Admin" },
    action: "node.repair-credential",
    outcome: "ok",
    target: `Bearer ${SECRET_VALUE}`,
    reason: `AUTH_FAILED agentToken=${SECRET_VALUE} localPath=${SEEDED_PRIVATE_PATH}`,
  },
];

const EXPECTED_PROTECTED_CLASSES = {
  "security.login|failed": "authentication-failure",
  "security.permission|denied": "permission-denial",
  "security.session.revoke|ok": "revocation",
  "backup.delete|ok": "destructive",
  "instance.neoforge.repairRuntime|ok": "migration-repair",
  "agent.token.rotate|ok": "credential-rotation",
  "totally.unmapped.action|ok": "unknown",
};

function main() {
  // ---- 1. classification -------------------------------------------------
  for (const [key, expectedClass] of Object.entries(EXPECTED_PROTECTED_CLASSES)) {
    const [action, outcome] = key.split("|");
    const classification = policy.classifyAuditRecord({ at: OLD, action, outcome, reason: null });
    assert.strictEqual(classification.class, expectedClass, `Seed for ${action} must classify as ${expectedClass}, got ${classification.class}.`);
    check(classification.protected === true, `Class ${expectedClass} must be protected.`);
    check(policy.isProtectedClass(classification.class), `isProtectedClass must accept ${classification.class}.`);
  }
  const routine = policy.classifyAuditRecord({ at: OLD, action: "alerts.list", outcome: "ok", reason: null });
  check(routine.class === policy.ROUTINE_CLASS && routine.protected === false, "alerts.list/ok must be the prunable routine class.");

  // Undeterminable -> protected (fail closed).
  [
    [{}, "empty record"],
    [{ action: null, at: OLD, outcome: "ok" }, "null action"],
    [{ at: OLD, outcome: "ok" }, "missing action"],
    [{ at: OLD, action: "alerts.list", outcome: "ok", reason: "AUTH_FAILED" }, "routine-looking action with a reason"],
    [{ at: "not-a-date", action: "alerts.list", outcome: "ok", reason: null }, "unparseable timestamp"],
    [null, "null record"],
  ].forEach(([record, label]) => {
    const classification = policy.classifyAuditRecord(record);
    check(classification.protected === true, `Undeterminable record (${label}) must be protected.`);
  });

  // ---- 2. retention: prunes what it says, never a protected class --------
  const plan = policy.applyRetention(seeded, { now: NOW, windowMs: 30 * DAY_MS, maxRecords: 1000 });
  assert.strictEqual(plan.refused, false, "Retention must not refuse when routine pruning is sufficient.");
  // POSITIVE CONTROL: a policy that prunes nothing must fail this smoke.
  check(
    plan.prunedCount >= 1,
    "POSITIVE CONTROL FAILED: the retention policy pruned nothing, so the prune assertions below prove nothing. A policy that never prunes cannot pass this smoke.",
  );
  check(
    plan.pruned.some((entry) => entry.classification.action === "alerts.list" && entry.reason === "aged-out-of-window"),
    "The aged routine record (alerts.list older than the window) must be pruned.",
  );
  check(
    plan.pruned.every((entry) => entry.classification.protected === false),
    "No protected class may appear in the pruned set.",
  );
  check(
    plan.kept.some((entry) => entry.action === "alerts.list" && entry.at === RECENT),
    "A routine record inside the window must be kept.",
  );

  // Every protected class has at least one seeded record retained, and the
  // undeterminable records are retained too.
  for (const protectedClass of policy.PROTECTED_CLASSES) {
    check(
      plan.kept.some((entry) => policy.classifyAuditRecord(entry).class === protectedClass),
      `Protected class ${protectedClass} must be retained by retention.`,
    );
  }
  check(plan.kept.some((entry) => entry && entry.at === undefined && entry.action === "alerts.list"), "The record with no timestamp must be retained.");
  check(plan.kept.some((entry) => entry && entry.at === "not-a-date"), "The record with an unparseable timestamp must be retained.");
  check(plan.kept.some((entry) => entry && Object.keys(entry).length === 0), "The empty record must be retained.");

  // ---- 3. a cap that would need a protected record is refused ------------
  const protectedOnly = Object.keys(EXPECTED_PROTECTED_CLASSES).map((key) => {
    const [action, outcome] = key.split("|");
    return serviceRecord({ at: OLD, action, outcome });
  });
  const refusedPlan = policy.applyRetention(protectedOnly, { now: NOW, windowMs: 30 * DAY_MS, maxRecords: 1 });
  check(refusedPlan.refused === true, "A cap larger than the prunable population must be refused.");
  assert.strictEqual(refusedPlan.refusalReason, "CAP_EXCEEDED_PROTECTED_ONLY", "The refusal must name the protected-only cap reason.");
  assert.strictEqual(refusedPlan.prunedCount, 0, "A refusal must prune nothing at all.");
  assert.strictEqual(refusedPlan.keptCount, protectedOnly.length, "A refusal must return the input untouched.");

  // A satisfiable cap prunes the OLDEST routine records first, never a
  // protected one.
  const capSeeded = [
    serviceRecord({ at: new Date(NOW - 20 * DAY_MS).toISOString(), action: "alerts.list", outcome: "ok", target: "oldest" }),
    serviceRecord({ at: new Date(NOW - 10 * DAY_MS).toISOString(), action: "alerts.list", outcome: "ok", target: "middle" }),
    serviceRecord({ at: RECENT, action: "alerts.list", outcome: "ok", target: "newest" }),
    serviceRecord({ at: OLD, action: "agent.token.rotate", outcome: "ok", target: "rotation" }),
  ];
  const capPlan = policy.applyRetention(capSeeded, { now: NOW, windowMs: 365 * DAY_MS, maxRecords: 2 });
  assert.strictEqual(capPlan.refused, false, "A satisfiable cap must prune rather than refuse.");
  assert.strictEqual(capPlan.keptCount, 2, "The cap must be satisfied exactly.");
  check(capPlan.kept.some((entry) => entry.target === "rotation"), "The protected rotation record must survive cap pruning.");
  check(
    capPlan.pruned.some((entry) => entry.record.target === "oldest") && capPlan.pruned.some((entry) => entry.record.target === "middle"),
    "Cap pruning must take the oldest routine records first.",
  );

  // ---- 4. access review projection ---------------------------------------
  const windowFrom = new Date(NOW - 2 * DAY_MS).toISOString();
  const windowTo = new Date(NOW + DAY_MS).toISOString();
  const reviewSeeded = [
    { at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), actor: { id: "actor-a", username: "owner-a", role: "Owner" }, action: "security.login", outcome: "ok", target: "local", reason: null },
    { at: new Date(NOW - 60 * 60 * 1000).toISOString(), actor: { id: "actor-a", username: "owner-a", role: "Owner" }, action: "security.login", outcome: "ok", target: "local", reason: null },
    { at: new Date(NOW - 30 * 60 * 1000).toISOString(), actor: { id: "actor-a", username: "owner-a", role: "Owner" }, action: "security.permission", outcome: "denied", target: "audit-log", reason: "settings:write" },
    { at: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), actor: { id: "actor-b", username: "owner-b", role: "Admin" }, action: "docker.delete", outcome: "ok", target: "container-x", reason: null },
    // Out of window, must not be projected.
    { at: OLD, actor: { id: "actor-c", username: "owner-c", role: "Viewer" }, action: "security.login", outcome: "ok", target: "local", reason: null },
  ];
  const review = policy.buildAccessReview(reviewSeeded, { from: windowFrom, to: windowTo, now: NOW });
  assert.strictEqual(review.recordCount, 4, "Exactly the four in-window records must be projected.");
  assert.strictEqual(review.actorCount, 2, "The window must show exactly two actors.");
  assert.strictEqual(review.protectedEventCount, 2, "The denied permission and the destructive delete must count as protected events.");
  const loginEntry = review.entries.find((entry) => entry.actorReference === "actor-a" && entry.action === "security.login" && entry.outcome === "ok");
  check(loginEntry, "The window must project actor-a's successful sign-ins.");
  assert.strictEqual(loginEntry.count, 2, "Actor-a's sign-ins must be counted twice.");
  assert.strictEqual(loginEntry.firstSeen, new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), "First-seen must be the earliest projected event.");
  assert.strictEqual(loginEntry.lastSeen, new Date(NOW - 60 * 60 * 1000).toISOString(), "Last-seen must be the latest projected event.");
  assert.strictEqual(loginEntry.class, "routine", "A successful sign-in is prunable routine, and the projection must say so.");
  const denyEntry = review.entries.find((entry) => entry.action === "security.permission");
  check(denyEntry && denyEntry.protected === true && denyEntry.class === "permission-denial", "The denied permission must project as a protected permission-denial.");

  const reviewJson = JSON.stringify(review) + JSON.stringify(policy.buildAccessReview(seeded, { now: NOW }));
  check(!reviewJson.includes(SECRET_VALUE), "The access review must not contain the seeded secret value.");
  check(!reviewJson.includes("seeduser\\"), "The access review must not contain the seeded private path.");

  // ---- 5. deterministic + redacted export --------------------------------
  const exportRecords = [
    { at: RECENT, actor: { id: "seed-actor-secret", username: "seeduser", role: "Admin" }, action: "node.repair-credential", outcome: "ok", target: `Bearer ${SECRET_VALUE}`, reason: `agentToken=${SECRET_VALUE} localPath=${SEEDED_PRIVATE_PATH}` },
    { at: new Date(NOW - 30 * 60 * 1000).toISOString(), actor: null, action: "alerts.list", outcome: "ok", target: "alerts", reason: null },
  ];
  const exportOptions = { from: windowFrom, to: windowTo, now: NOW };
  const first = policy.buildAuditExport(exportRecords, exportOptions);
  const second = policy.buildAuditExport(exportRecords.slice().reverse(), exportOptions);
  assert.strictEqual(first.json, second.json, "Two exports of the same window must be byte-identical, regardless of input order.");
  assert.strictEqual(
    policy.stableStringify(JSON.parse(first.json)),
    first.json.trim(),
    "The export document must already be in canonical (sorted-key) form so it diffs cleanly.",
  );
  assert.strictEqual(first.document.schema, "anxos.audit.export", "The export document must carry its schema name.");
  check(first.document.redacted === true, "The export must declare itself redacted.");
  assert.deepStrictEqual(
    first.document.protectedClasses,
    policy.PROTECTED_CLASSES.slice(),
    "The export must publish the protected-class list it applied.",
  );
  check(!first.json.includes(SECRET_VALUE), "The export must not contain the seeded secret value.");
  check(!first.json.includes("seeduser\\"), "The export must not contain the seeded private path.");
  check(first.json.includes("[redacted"), "The export must actually redact the seeded credential material.");

  // ---- 6. oversized / invalid windows are refused ------------------------
  assert.throws(
    () => policy.buildAuditExport(seeded, { now: NOW, maxExportRecords: 2 }),
    (error) => error?.code === "AUDIT_EXPORT_WINDOW_TOO_LARGE",
    "An export window above the record cap must be refused, not truncated.",
  );
  assert.throws(
    () => policy.buildAuditExport(exportRecords, { now: NOW, from: new Date(NOW - 400 * DAY_MS).toISOString(), to: new Date(NOW).toISOString() }),
    (error) => error?.code === "AUDIT_EXPORT_WINDOW_TOO_WIDE",
    "An export window wider than the supported span must be refused.",
  );
  assert.throws(
    () => policy.buildAuditExport(exportRecords, { now: NOW, from: windowTo, to: windowFrom }),
    (error) => error?.code === "AUDIT_WINDOW_INVALID",
    "An inverted audit window must be refused.",
  );

  // ---- 7. service integration over the real store ------------------------
  const auditPath = path.join(process.env.ANXHUB_CONFIG_DIR, "audit.log");
  fs.writeFileSync(auditPath, `${seeded.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  assert.strictEqual(security._test.readAuditLogRecords().length, seeded.length, "The service must read back every seeded audit line.");

  const report = security.getAuditRetentionReport({ now: NOW, windowMs: 30 * DAY_MS });
  assert.strictEqual(report.enforced, false, "The retention report must state that it is a decision, not an enforcement.");
  assert.strictEqual(report.totalRecords, seeded.length, "The report must cover the whole store.");
  check(report.prunedByClass[policy.ROUTINE_CLASS] >= 1, "The report must show the aged routine record as prunable.");
  policy.PROTECTED_CLASSES.forEach((protectedClass) => {
    check(
      Number(report.protectedRetained[protectedClass] || 0) >= 1,
      `The report must show at least one retained record for protected class ${protectedClass}.`,
    );
  });
  assert.strictEqual(report.policy.rules.length, policy.describeRetentionPolicy().rules.length, "The report must publish the documented retention rules.");

  const serviceReview = security.getAuditAccessReview({ from: windowFrom, to: windowTo, now: NOW });
  assert.strictEqual(serviceReview.recordCount, 2, "The service review must project the two in-window seeded records.");
  check(!JSON.stringify(serviceReview).includes(SECRET_VALUE), "The service review must not leak the seeded secret value.");

  const serviceExportA = security.exportAuditWindow({ from: windowFrom, to: windowTo, now: NOW });
  const serviceExportB = security.exportAuditWindow({ from: windowFrom, to: windowTo, now: NOW });
  assert.strictEqual(serviceExportA.json, serviceExportB.json, "The service export must be deterministic.");
  check(serviceExportA.redacted === true && serviceExportA.deterministic === true, "The service export must declare itself redacted and deterministic.");
  check(!serviceExportA.json.includes(SECRET_VALUE), "The service export must not leak the seeded secret value.");
  assert.throws(
    () => security.exportAuditWindow({ now: NOW, maxExportRecords: 2 }),
    (error) => error?.code === "AUDIT_EXPORT_WINDOW_TOO_LARGE",
    "The service must refuse an oversized export window with the policy's own error code.",
  );

  // A line the store cannot parse must be counted and treated as protected, not
  // silently dropped and not pruned.
  fs.appendFileSync(auditPath, "{not-json\n");
  const withUnparseable = security._test.readAuditLogRecords();
  assert.strictEqual(withUnparseable.length, seeded.length + 1, "An unparseable audit line must still be counted.");
  const unparseableReport = security.getAuditRetentionReport({ now: NOW, windowMs: 30 * DAY_MS });
  assert.strictEqual(unparseableReport.totalRecords, seeded.length + 1, "The unparseable line must appear in the retention report.");
  check(
    Number(unparseableReport.protectedRetained.unknown || 0) >= 2,
    "The unparseable line must be classified as the protected `unknown` class.",
  );
  assert.strictEqual(
    unparseableReport.prunedCount,
    report.prunedCount,
    "An unparseable line must not change what the policy prunes.",
  );

  // ---- 8. permission gate over the real store ----------------------------
  return (async () => {
    await security.setupAdmin({ username: "owner", password: "correct horse battery staple" });
    const securityPath = path.join(process.env.ANXHUB_CONFIG_DIR, "security.json");
    const state = JSON.parse(fs.readFileSync(securityPath, "utf8"));
    state.users.push({
      id: "viewer-1",
      username: "viewer1",
      role: "Viewer",
      passwordHash: bcrypt.hashSync("viewer password 123", 12),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null,
    });
    fs.writeFileSync(securityPath, `${JSON.stringify(state, null, 2)}\n`);
    security.logout();
    await security.login({ username: "viewer1", password: "viewer password 123" });
    assert.throws(
      () => security.getAuditAccessReview({ now: NOW }),
      (error) => error?.code === "PERMISSION_DENIED",
      "A Viewer must not reach the audit access review.",
    );
    assert.throws(
      () => security.exportAuditWindow({ now: NOW }),
      (error) => error?.code === "PERMISSION_DENIED",
      "A Viewer must not reach the audit export.",
    );

    security.logout();
    await security.login({ username: "owner", password: "correct horse battery staple" });
    const afterDenial = security.getAuditAccessReview({ now: NOW });
    const denials = afterDenial.entries.filter((entry) => entry.action === "security.permission" && entry.outcome === "denied");
    const denial = denials.find((entry) => entry.actorReference === "viewer-1");
    check(denial, "The refused Viewer must appear in the access review as a denied permission event attributed to viewer-1.");
    assert.strictEqual(denial.class, "permission-denial", "The refused Viewer's event must project as a protected permission-denial.");
    check(afterDenial.protectedEventCount >= 1, "The review must count the refusal as a protected event.");

    security.logout();
    assert.throws(
      () => security.exportAuditWindow({ now: NOW }),
      (error) => error?.code === "LOGIN_REQUIRED",
      "With an owner configured and nobody signed in, the audit export must be refused.",
    );

    console.log("Audit retention, access review and export smoke checks passed.");
  })();
}

Promise.resolve()
  .then(main)
  .catch((error) => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    console.error(error);
    process.exit(1);
  })
  .then(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });