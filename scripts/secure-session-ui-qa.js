#!/usr/bin/env node
"use strict";

// Build 216-E real-app check (docs/anxhost/SECURITY_REVIEW_216E.md), off
// screen, isolated profile, real Windows secure storage (DPAPI):
//
// E1 Security settings show the idle lock (default 15 minutes) and "Remember
//    me on this device", available because secure storage is.
// E2 Locking in the main process shows the lock screen at once (the
//    security:locked event), without a status refresh by the page.
// E3 "Trust this device" on the lock screen is available, and signing in
//    with it ticked restores without a prompt after the app restarts.
// E4 After logout, the restarted app asks for the password.
// E5 No renderer errors.

const crypto = require("crypto");
const { launchRealApp, waitFor } = require("./test-helpers/anxhost-real-app");

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`);
}

const gateVisible = () => {
  const gate = document.querySelector("[data-security-gate]");
  return Boolean(gate && !gate.hidden && gate.getBoundingClientRect().height > 0);
};

async function signInThroughLockScreen(page, password, trust) {
  await waitFor(page, gateVisible, null, "lock screen");
  await page.fill('[data-security-field="username"]', "qa-owner");
  await page.fill('[data-security-field="password"]', password);
  await page.setChecked('[data-security-field="staySignedIn"]', trust);
  await page.click("[data-security-submit]");
  await waitFor(page, () => typeof isAppLockedForBackgroundWork === "function" && !isAppLockedForBackgroundWork(), null, "unlock");
}

async function main() {
  const password = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
  const run = await launchRealApp({ prefix: "anx-216-e-" });
  let { page } = run;
  try {
    const setup = await page.evaluate(async (secret) => {
      const result = await window.anxos.security.setupAdmin({ username: "qa-owner", password: secret, passwordConfirm: secret }).catch((error) => ({ error: error?.message }));
      return result?.error || null;
    }, password);
    if (setup) throw new Error(`owner setup failed: ${setup}`);
    await page.reload();
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer");
    await waitFor(page, () => typeof isAppLockedForBackgroundWork === "function" && !isAppLockedForBackgroundWork(), null, "unlocked after setup");

    // E1
    await page.evaluate(async () => { showPage("security"); await refreshSecurityState(); });
    await waitFor(page, () => document.querySelector("[data-security-idle-lock]")?.value === "15", null, "idle lock value");
    const e1 = await page.evaluate(() => {
      const idle = document.querySelector("[data-security-idle-lock]");
      const trust = document.querySelector('[data-security-session-toggle="trustDevice"]');
      return { idle: idle?.value, trustChecked: trust?.checked, trustDisabled: trust?.disabled };
    });
    record("E1", e1.idle === "15" && e1.trustChecked === true && e1.trustDisabled === false, `idle lock ${e1.idle} min, remember me ${e1.trustChecked ? "on" : "off"}${e1.trustDisabled ? " (disabled)" : ""}`);

    // E2
    const started = Date.now();
    await page.evaluate(() => window.anxos.security.lockOwnerWorkspace());
    let e2 = true;
    try { await waitFor(page, gateVisible, null, "lock screen after lock", 34); } catch { e2 = false; }
    const status = await page.evaluate(() => window.anxos.security.getStatus());
    record("E2", e2 && status.localOwnerAuthenticated === false, `lock screen shown ${e2 ? `in ${Date.now() - started} ms` : "not within 5 s"}; main process ${status.localOwnerAuthenticated ? "still unlocked" : "locked"}`);

    // E3
    const option = await page.evaluate(() => ({
      disabled: document.querySelector('[data-security-field="staySignedIn"]')?.disabled,
      note: !document.querySelector("[data-security-trust-note]")?.hidden,
      label: document.querySelector("[data-security-stay-row]")?.textContent.replace(/\s+/g, " ").trim(),
    }));
    await signInThroughLockScreen(page, password, true);
    ({ page } = await run.relaunch());
    let restored = true;
    try {
      await waitFor(page, () => typeof isAppLockedForBackgroundWork === "function" && !isAppLockedForBackgroundWork(), null, "restored session", 120);
    } catch { restored = false; }
    const shownGate = await page.evaluate(gateVisible);
    record("E3", option.disabled === false && option.note === false && /Trust this device/.test(option.label || "") && restored && !shownGate, `"${option.label}" ${option.disabled ? "disabled" : "available"}; after restart ${restored && !shownGate ? "unlocked without a prompt" : "asked for the password"}`);

    // E4
    await page.evaluate(() => window.anxos.security.logout());
    ({ page } = await run.relaunch());
    let prompted = true;
    try { await waitFor(page, gateVisible, null, "lock screen after logout", 120); } catch { prompted = false; }
    record("E4", prompted, `after logout and restart ${prompted ? "the password is required" : "the app opened unlocked"}`);

    record("E5", run.rendererErrors.length === 0, `${run.rendererErrors.length} renderer errors${run.rendererErrors.length ? `: ${run.rendererErrors.slice(0, 3).join(" | ")}` : ""}`);
  } finally {
    await run.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`Secure session UI QA: ${results.length - failed.length} of ${results.length} passed.`);
  if (failed.length) process.exit(1);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
