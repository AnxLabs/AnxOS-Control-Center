#!/usr/bin/env node
// Phase 9 UI QA, in the real app with an isolated profile and config:
//   U1 Settings > Updates has a Verification row that starts as "Checked when
//      an update is downloaded."
//   U2 a refused installer (the updater's real status event shape) shows why
//      it was not opened, in the row and in the status line, without layout
//      overflow in the existing grid
//   U3 a verified installer names the publisher
//   U4 clicking Install when the updater refuses shows why (row and toast);
//      before Phase 9 the refusal result was discarded
// Screenshots go to PHASE9_SHOTS (default: a temporary folder).
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");
const shotsDir = process.env.PHASE9_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-phase9-shots-"));

async function waitFor(page, predicate, arg, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function sendUpdateStatus(app, message) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send("updates:status", payload);
  }, message);
}

async function main() {
  const qa = createIsolatedQaEnv("anx-phase9-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-phase9-qa-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer", 60000);
    // A fresh profile opens the first-run welcome; record it, then skip it.
    const welcome = page.locator("[data-onboarding-welcome]");
    await welcome.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if (await welcome.isVisible().catch(() => false)) {
      await page.screenshot({ path: path.join(shotsDir, "u0-first-run-welcome.png") });
      console.log(`INFO first-run welcome shown: "${(await page.locator("#onboarding-welcome-title").textContent()).trim()}"`);
      await page.locator('[data-onboarding-welcome] [data-onboarding-action="skip"]').click();
    }
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
    const unlocked = await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      const setup = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
      const login = await security.login({ username: "qa-owner", password }).catch((error) => ({ error: error?.message }));
      return { setupError: setup?.error || null, loginError: login?.error || null };
    }, testPassword);
    assert.ok(!unlocked.setupError && !unlocked.loginError, `QA owner unlock failed: ${unlocked.setupError || unlocked.loginError}`);
    await page.reload();
    await waitFor(page, () => typeof window.showPage === "function", null, "app after unlock", 60000);
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();

    // U1
    await page.evaluate(() => { window.showPage("settings"); setActiveSettingsCategory("updates"); });
    await waitFor(page, () => {
      const section = document.querySelector('[data-settings-category="updates"]');
      return section && !section.hidden && section.getBoundingClientRect().height > 0;
    }, null, "Settings > Updates", 20000);
    const initial = await page.locator("[data-update-verification]").textContent();
    assert.strictEqual(initial.trim(), "Checked when an update is downloaded.");
    console.log("PASS U1 Settings > Updates has a Verification row");

    // U2
    const refusal = "The downloaded installer is signed by \"Mallory\", not by the AnxOS Control Center publisher, so it was not opened.";
    await sendUpdateStatus(app, {
      type: "install-error",
      code: "UPDATE_INSTALLER_WRONG_PUBLISHER",
      message: refusal,
      state: { status: "error", error: refusal, signature: { applicable: true, verified: false, code: "UPDATE_INSTALLER_WRONG_PUBLISHER", publisher: "Mallory" }, logs: [] },
    });
    await waitFor(page, () => document.querySelector("[data-update-verification]")?.dataset.updateVerificationState === "refused", null, "refused state", 10000);
    const refused = await page.evaluate(() => {
      const field = document.querySelector("[data-update-verification]");
      const grid = field.closest(".settings-about-grid");
      return {
        text: field.textContent,
        status: document.querySelector("[data-update-status]")?.textContent || "",
        overflow: grid.scrollWidth > grid.clientWidth + 1,
        fieldOverflow: field.scrollWidth > field.clientWidth + 1,
      };
    });
    assert.match(refused.text, /^Not installed: .*Mallory.*not opened\.$/);
    assert.match(refused.status, /^Update not installed: the installer did not pass verification\.$/);
    assert.strictEqual(refused.overflow, false, "the about grid does not overflow");
    await page.evaluate(() => document.querySelector("[data-update-verification]").scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(shotsDir, "u2-refused.png") });
    console.log(`PASS U2 a refused installer explains why (row and status line), no overflow${refused.fieldOverflow ? " (long text wraps)" : ""}`);

    // U3
    await sendUpdateStatus(app, {
      type: "downloaded",
      state: { status: "downloaded", error: null, signature: { applicable: true, verified: true, publisher: "Anjo ROSIMO", issuer: "Microsoft ID Verified CS AOC CA 03" }, logs: [] },
    });
    await waitFor(page, () => document.querySelector("[data-update-verification]")?.dataset.updateVerificationState === "verified", null, "verified state", 10000);
    assert.strictEqual((await page.locator("[data-update-verification]").textContent()).trim(), "Checksum and AnxLabs signature verified (certificate: Anjo ROSIMO).");
    await page.screenshot({ path: path.join(shotsDir, "u3-verified.png") });
    console.log("PASS U3 a verified installer names the publisher");

    // U4: clicking Install when the updater refuses (it returns
    // { installed: false } rather than throwing) must tell the user why.
    await sendUpdateStatus(app, {
      type: "downloaded",
      path: "C:\\fake\\AnxOS-Control-Center-Setup-2.0-build999.exe",
      state: { status: "downloaded", downloadedPath: "C:\\fake\\AnxOS-Control-Center-Setup-2.0-build999.exe", error: null, signature: null, logs: [] },
    });
    const unsigned = "The downloaded installer is not signed, so it was not opened.";
    await app.evaluate(({ ipcMain }, message) => {
      ipcMain.removeHandler("updates:install");
      ipcMain.handle("updates:install", async () => ({
        installed: false,
        code: "UPDATE_INSTALLER_UNSIGNED",
        error: message,
        state: { status: "error", error: message, signature: { applicable: true, verified: false, code: "UPDATE_INSTALLER_UNSIGNED", status: "NotSigned" }, logs: [] },
      }));
    }, unsigned);
    // A finished download opens the update dialog; its primary button is the
    // install a user actually clicks.
    const dialogPrimary = page.locator('[data-update-modal] [data-update-action="primary"]');
    await dialogPrimary.waitFor({ state: "visible", timeout: 10000 });
    const primaryLabel = (await dialogPrimary.textContent()).trim();
    await dialogPrimary.click();
    await waitFor(page, () => document.querySelector("[data-update-verification]")?.dataset.updateVerificationState === "refused", null, "refusal after Install", 10000);
    const toast = await page.evaluate(() => [...document.querySelectorAll(".toast, [data-toast], .app-toast")].map((node) => node.textContent).join(" | "));
    assert.match(await page.locator("[data-update-verification]").textContent(), /not signed, so it was not opened/);
    assert.match(toast, /not signed/, `a toast explains the refusal (${toast})`);
    const dialog = await page.evaluate(() => ({
      open: !document.querySelector("[data-update-modal]").hidden,
      title: document.querySelector("[data-update-title]")?.textContent || "",
      message: document.querySelector("[data-update-message]")?.textContent || "",
      primary: document.querySelector('[data-update-modal] [data-update-action="primary"]')?.textContent || "",
    }));
    assert.ok(dialog.open, "the dialog stays open to explain");
    assert.match(dialog.message, /not signed, so it was not opened/, `the dialog explains the refusal (${JSON.stringify(dialog)})`);
    assert.notStrictEqual(dialog.primary.trim(), primaryLabel, "the dialog no longer offers the same install action");
    await page.screenshot({ path: path.join(shotsDir, "u4-install-refused.png") });
    console.log(`PASS U4 "${primaryLabel}" on a refused installer: the dialog switches to "${dialog.title.trim()}" with the reason ("${dialog.primary.trim()}"), Settings row and toast agree`);

    // U5: Settings > About names the publisher (owner decision: AnxLabs).
    await page.locator('[data-update-modal] [data-update-action="dismiss"]').first().click();
    await page.evaluate(() => setActiveSettingsCategory("about"));
    await waitFor(page, () => {
      const field = document.querySelector("[data-about-publisher]");
      return field && field.getBoundingClientRect().height > 0;
    }, null, "About publisher row", 10000);
    assert.strictEqual((await page.locator("[data-about-publisher]").textContent()).trim(), "AnxLabs");
    await page.screenshot({ path: path.join(shotsDir, "u5-about.png") });
    console.log("PASS U5 Settings > About shows Publisher: AnxLabs");

    assert.deepStrictEqual(errors, [], `no renderer errors (${errors.join(" | ")})`);
    console.log(`Phase 9 UI QA: 5 checks passed. Screenshots: ${shotsDir}`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    qa.cleanup?.();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
