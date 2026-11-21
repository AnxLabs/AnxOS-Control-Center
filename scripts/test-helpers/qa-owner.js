"use strict";

// Signs a disposable owner in to an isolated QA profile, the way
// phasex-ui-qa.js does. Since Build 212, background polling stops while the
// app is locked (isAppLockedForBackgroundWork in app.js), so a suite that
// waits for a poll must run as a signed-in owner. The password is generated
// per run and never leaves the test's temporary profile.

const crypto = require("crypto");

async function signInQaOwner(page) {
  const password = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
  const outcome = await page.evaluate(async (secret) => {
    const security = window.anxos.security;
    const setup = await security.setupAdmin({ username: "qa-owner", password: secret, passwordConfirm: secret }).catch((error) => ({ error: error?.message }));
    const login = await security.login({ username: "qa-owner", password: secret }).catch((error) => ({ error: error?.message }));
    return { setupError: setup?.error || null, loginError: login?.error || null };
  }, password);
  if (outcome.setupError || outcome.loginError) {
    throw new Error(`QA owner sign-in failed: ${outcome.setupError || outcome.loginError}`);
  }
  await page.reload();
  await page.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 60000 });
  const useDevice = page.getByRole("button", { name: "Use this device" }).first();
  if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="shell-sidebar"]')?.getBoundingClientRect().width || 0) > 0, null, { timeout: 60000 });
  await page.waitForFunction(() => typeof isAppLockedForBackgroundWork === "function" && !isAppLockedForBackgroundWork(), null, { timeout: 20000 });
}

module.exports = { signInQaOwner };
