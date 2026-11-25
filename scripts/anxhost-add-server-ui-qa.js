#!/usr/bin/env node
"use strict";

// Build 216-A4 Add Server: Marketplace and Create Server in the MAIN window,
// in the REAL app. Off-screen, isolated profile, real Agent test fixture,
// signed-in disposable owner; see scripts/test-helpers/anxhost-real-app.js.
//
//   AS1 no window opens: the sidebar's Add Server, Home's New Server, My
//       Servers' Create Server, "Create Your First Server", package details'
//       "Continue to Create Server" and the first-server guide all stay in the
//       main window (0 new BrowserWindows)
//   AS2 browse mode: every curated template has a card, categories filter,
//       search narrows, a favourite is kept across a reload, the Modrinth /
//       CurseForge choice switches
//   AS3 art: all 50 curated cards show their bundled art (loaded), no card
//       loads a remote image for a curated template, a missing art file falls
//       back to the monogram
//   AS4 package details, then "Continue to Create Server" opens Create Server
//       for that template in place (title, heading, wizard, browser hidden)
//   AS5 Cancel returns to browsing with the Add Server heading
//   AS6 Home's New Server: browse view with the first-server guide; a game in
//       the guide opens Create Server for it; "Browse all games" browses
//   AS7 layout: no horizontal overflow or clipped header text in browse and
//       create mode at 900x640, 1280x800 and 1920x1080
//   AS8 contrast: WCAG AA for Add Server text in both modes
//   AS9 no renderer errors
//
// Usage: node scripts/anxhost-add-server-ui-qa.js [--shots=<dir>]

const fs = require("fs");
const path = require("path");
const { launchRealApp, waitFor, evaluateMain } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");

const shotsArg = process.argv.find((arg) => arg.startsWith("--shots="));
const SHOTS = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketplace-templates.json"), "utf8"));
const CURATED = (Array.isArray(TEMPLATES) ? TEMPLATES : TEMPLATES.templates).map((template) => template.id);

const results = [];
const check = (id, ok, message) => {
  results.push({ id, ok: Boolean(ok), message });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
};

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 15000 }).catch(() => {});
}

const CONTRAST_HELPERS = `
  const parse = (value) => {
    const s = String(value || "").trim();
    let m = /^rgba?\\(([^)]+)\\)/.exec(s);
    if (m) {
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    m = /^color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) {
      const parts = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
    }
    return null;
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    let colour = { r: 8, g: 6, b: 13, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) colour = over(layers[i], colour);
    return colour;
  };
  const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
`;

async function run() {
  const real = await launchRealApp({ prefix: "anx-216-a4-qa-" });
  const { page, rendererErrors, app } = real;
  const windowIds = () => evaluateMain(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).map((win) => win.id));
  const mode = () => page.evaluate(() => ({ mode: document.body.dataset.addServerMode || "", page: document.querySelector(".page.is-active")?.dataset.page, heading: document.querySelector('[data-page="marketplace"] .page-header h1')?.textContent.trim(), title: document.querySelector("[data-titlebar-page]")?.textContent.trim() || "", selected: typeof marketplaceSelectedTemplateId === "undefined" ? null : marketplaceSelectedTemplateId, wizard: !document.querySelector("[data-marketplace-wizard]")?.hidden, guide: Boolean(document.querySelector("[data-first-server-modal]")) }));
  const closeGuide = () => page.evaluate(() => document.querySelector('[data-first-server-modal] [data-first-server-action="close"]')?.click());
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);
    const startWindows = await windowIds();

    // ------------------------------------------------------------ AS2 browse
    await page.locator('[data-testid="nav-item"][data-page-target="marketplace"]').first().click();
    await waitFor(page, (count) => document.querySelectorAll(".marketplace-card").length >= count, Math.min(10, CURATED.length), "Add Server cards", 400);
    await page.evaluate(() => { const all = [...document.querySelectorAll("[data-marketplace-categories] button")].find((button) => /^All\b/.test(button.textContent.trim())); all?.click(); });
    await page.waitForTimeout(500);
    const browse = await mode();
    check("AS2", browse.page === "marketplace" && browse.mode === "browse", `sidebar Add Server opens the browse view in the main window (mode=${browse.mode})`);
    // The main window always showed the deployment panel with the Downloads
    // list (Cancel for running updates is there); only the Marketplace window hid it.
    const downloadsVisible = await page.evaluate(() => { const list = document.querySelector("[data-download-list]"); list?.scrollIntoView({ block: "center" }); return Boolean(list && list.checkVisibility()); });
    check("AS2", downloadsVisible, `the Downloads list stays visible while browsing (${downloadsVisible})`);
    const cards = await page.evaluate(() => [...document.querySelectorAll(".marketplace-card")].map((card) => card.dataset.marketplaceTemplateId || card.dataset.templateId || ""));
    const cardIds = cards.filter(Boolean);
    check("AS2", CURATED.every((id) => cardIds.includes(id)), `every curated template has a card (${CURATED.filter((id) => cardIds.includes(id)).length}/${CURATED.length})`);
    await shot(page, "a4-1280-browse");

    const filters = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visibleCards = () => [...document.querySelectorAll(".marketplace-card")].filter((card) => card.getClientRects().length > 0).length;
      const all = visibleCards();
      const db = [...document.querySelectorAll("[data-marketplace-categories] button")].find((button) => /Databases/.test(button.textContent));
      db?.click();
      await wait(300);
      const databases = visibleCards();
      [...document.querySelectorAll("[data-marketplace-categories] button")].find((button) => /^All\b/.test(button.textContent.trim()))?.click();
      await wait(300);
      const search = document.querySelector("[data-marketplace-search]");
      search.value = "paper";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(600);
      const searched = visibleCards();
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(600);
      return { all, databases, searched, after: visibleCards() };
    });
    check("AS2", filters.databases > 0 && filters.databases < filters.all && filters.searched > 0 && filters.searched < filters.all && filters.after === filters.all, `category and search narrow the cards (all ${filters.all}, Databases ${filters.databases}, "paper" ${filters.searched})`);

    const favourite = await page.evaluate(async () => {
      const card = [...document.querySelectorAll(".marketplace-card")].find((entry) => /redis/i.test(entry.textContent));
      const button = card.querySelector(".marketplace-card__favorite");
      const before = button.classList.contains("is-active");
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { before, after: [...document.querySelectorAll(".marketplace-card")].find((entry) => /redis/i.test(entry.textContent)).querySelector(".marketplace-card__favorite").classList.contains("is-active") };
    });
    await page.reload();
    await waitFor(page, () => typeof window.showPage === "function" && (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "reload", 300);
    await page.evaluate(() => openWorkspaceSurface("marketplace"));
    await waitFor(page, () => document.querySelectorAll(".marketplace-card").length > 5, null, "cards after reload", 400);
    const favouriteKept = await page.evaluate(() => [...document.querySelectorAll(".marketplace-card")].find((entry) => /redis/i.test(entry.textContent))?.querySelector(".marketplace-card__favorite").classList.contains("is-active"));
    check("AS2", favourite.before === false && favourite.after === true && favouriteKept === true, `a favourite is set and kept across a reload (${favourite.before} → ${favourite.after} → ${favouriteKept})`);
    const providers = await page.evaluate(async () => {
      const tabs = [...document.querySelectorAll("[data-marketplace-provider]")];
      const curse = tabs.find((tab) => tab.dataset.marketplaceProvider === "curseforge");
      curse?.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const active = tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.marketplaceProvider;
      tabs.find((tab) => tab.dataset.marketplaceProvider === "modrinth")?.click();
      return { count: tabs.length, active };
    });
    check("AS2", providers.count >= 2 && providers.active === "curseforge", `Modrinth and CurseForge can be chosen (${providers.count} tabs, active ${providers.active})`);

    // ------------------------------------------------------------ AS3 art
    await page.evaluate(() => [...document.querySelectorAll("[data-marketplace-categories] button")].find((button) => /^All\b/.test(button.textContent.trim()))?.click());
    await page.waitForTimeout(1500);
    const art = await page.evaluate(async (curated) => {
      const rows = [...document.querySelectorAll(".marketplace-card")].map((card) => {
        const id = card.dataset.marketplaceTemplateId || card.dataset.templateId || "";
        const image = card.querySelector(".marketplace-card__icon img");
        return { id, src: image?.getAttribute("src") || "", loaded: Boolean(image && image.complete && image.naturalWidth > 0) };
      }).filter((row) => curated.includes(row.id));
      const fallback = createMarketplaceIcon({ id: "zz-no-such-art", icon: "ZZ" });
      document.body.append(fallback);
      for (let i = 0; i < 30 && fallback.querySelector("img"); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const fallbackText = fallback.textContent;
      fallback.remove();
      return {
        withArt: rows.filter((row) => /^src\/assets\/anxhost\/marketplace\/[a-z0-9-]+\.svg$/.test(row.src) && row.loaded).length,
        remote: rows.filter((row) => /^https?:/.test(row.src)).map((row) => row.id),
        missing: rows.filter((row) => !row.loaded).map((row) => row.id),
        total: rows.length,
        fallbackText,
      };
    }, CURATED);
    check("AS3", art.withArt === CURATED.length && art.total === CURATED.length, `${art.withArt}/${CURATED.length} curated cards show their bundled art${art.missing.length ? `; not loaded: ${art.missing.join(", ")}` : ""}`);
    check("AS3", art.remote.length === 0, `no curated card loads a remote image (${art.remote.length})`);
    check("AS3", art.fallbackText === "ZZ", `a missing art file falls back to the monogram ("${art.fallbackText}")`);

    // ------------------------------------------------------------ AS4 details → create
    // The card's own button (data-marketplace-installed-action) reads "View
    // Details" while browsing and opens the package details.
    const cardButton = await page.evaluate(() => { const button = document.querySelector('.marketplace-card[data-template-id="terraria-tshock"] [data-marketplace-installed-action]'); const label = button?.textContent.trim(); button?.click(); return label; });
    await page.waitForTimeout(500);
    const details = await page.evaluate(() => ({ continue: [...document.querySelectorAll(".marketplace-side-panel button")].find((button) => /Continue to Create Server/.test(button.textContent))?.textContent.trim() || null }));
    await page.evaluate(() => [...document.querySelectorAll(".marketplace-side-panel button")].find((button) => /Continue to Create Server/.test(button.textContent))?.click());
    await waitFor(page, () => document.body.dataset.addServerMode === "create" && !document.querySelector("[data-marketplace-wizard]")?.hidden, null, "Create Server in place", 200);
    await page.waitForTimeout(500);
    const created = await mode();
    const browserHidden = await page.evaluate(() => document.querySelector(".marketplace-browser")?.getClientRects().length === 0);
    check("AS4", cardButton === "View Details" && details.continue, `the card's "${cardButton}" button opens the package details`);
    check("AS4", details.continue && created.mode === "create" && /terraria/.test(created.selected || "") && created.wizard && browserHidden && created.heading === "Create Server" && created.title === "Create Server", `package details → "${details.continue}" opens Create Server for ${created.selected} in place (heading "${created.heading}", title "${created.title}", browser hidden=${browserHidden})`);
    await shot(page, "a4-1280-create");

    // ------------------------------------------------------------ AS5 cancel
    await page.evaluate(() => document.querySelector("[data-marketplace-cancel]")?.click());
    await page.waitForTimeout(500);
    const cancelled = await mode();
    check("AS5", cancelled.mode === "browse" && !cancelled.wizard && cancelled.heading === "Add a Server", `Cancel returns to browsing (mode=${cancelled.mode}, heading "${cancelled.heading}")`);

    // ------------------------------------------------------------ AS6 entry points
    await page.evaluate(() => { window.showPage("dashboard"); document.querySelector('[data-home-section="servers"] [data-dashboard-action="create-server"]').click(); });
    await waitFor(page, () => Boolean(document.querySelector("[data-first-server-modal]")), null, "the first-server guide", 200);
    const fromHome = await mode();
    check("AS6", fromHome.page === "marketplace" && fromHome.mode === "browse" && fromHome.guide, `Home's New Server opens Add Server with the first-server guide (mode=${fromHome.mode})`);
    await waitFor(page, () => Boolean(document.querySelector("[data-first-server-modal] [data-first-server-template]:not(:disabled)")), null, "an enabled game in the guide", 200);
    const picked = await page.evaluate(() => { const button = document.querySelector("[data-first-server-modal] [data-first-server-template]:not(:disabled)"); const id = button.dataset.firstServerTemplate; button.click(); return id; });
    await waitFor(page, () => document.body.dataset.addServerMode === "create" && !document.querySelector("[data-marketplace-wizard]")?.hidden, null, "Create Server from the guide", 200);
    const fromGuide = await mode();
    check("AS6", fromGuide.mode === "create" && fromGuide.selected === picked && !fromGuide.guide, `a game in the guide opens Create Server for ${picked} (selected ${fromGuide.selected})`);
    await page.evaluate(() => document.querySelector("[data-marketplace-cancel]")?.click());
    await page.evaluate(() => openCreateServerWorkspace());
    await waitFor(page, () => Boolean(document.querySelector("[data-first-server-modal]")), null, "the guide again", 200);
    await page.evaluate(() => document.querySelector('[data-first-server-modal] [data-first-server-action="marketplace"]').click());
    await page.waitForTimeout(400);
    const browseAll = await mode();
    check("AS6", browseAll.mode === "browse" && !browseAll.guide && browseAll.page === "marketplace", `"Browse all games" returns to browsing (mode=${browseAll.mode})`);
    await page.evaluate(() => window.showPage("instances"));
    // The button is disabled while My Servers refreshes.
    await waitFor(page, () => { const button = document.querySelector('.instances-toolbar [data-instance-action="create"], [data-instance-action="create"]'); return Boolean(button && !button.disabled && button.getClientRects().length); }, null, "My Servers' Create Server enabled", 200);
    const disabledReason = await page.evaluate(() => document.querySelector('[data-instance-action="create"]').title || "");
    await page.locator('[data-instance-action="create"]').first().click();
    await page.waitForTimeout(600);
    const fromServers = await mode();
    check("AS6", fromServers.page === "marketplace" && fromServers.guide, `My Servers' Create Server opens Add Server in place (page=${fromServers.page}${disabledReason ? `, title "${disabledReason}"` : ""})`);
    await closeGuide();
    await page.evaluate(() => document.querySelector('[data-marketplace-action="first-server"]')?.click());
    await page.waitForTimeout(400);
    const firstServer = await mode();
    check("AS6", firstServer.guide && firstServer.page === "marketplace", `"Create Your First Server" opens the guide in place`);
    await closeGuide();

    // ------------------------------------------------------------ AS10 rows no other suite exercised
    await page.evaluate(() => enterAddServer("browse"));
    await page.waitForTimeout(400);
    const shortcuts = await page.evaluate(async () => {
      const landed = [];
      for (const name of ["downloads", "notifications"]) {
        enterAddServer("browse");
        await new Promise((resolve) => setTimeout(resolve, 200));
        document.querySelector(`[data-marketplace-shortcut="${name}"]`).click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        landed.push(`${name}->${document.querySelector(".page.is-active")?.dataset.page}`);
      }
      await enterAddServer("browse");
      return landed;
    });
    check("AS10", shortcuts.join() === "downloads->operations,notifications->notifications", `Downloads and Notifications shortcuts open their pages (${shortcuts.join(", ")})`);

    const browseControls = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const modes = [];
      for (const name of ["trending", "updated", "featured"]) {
        document.querySelector(`[data-marketplace-provider-mode="${name}"]`)?.click();
        await wait(200);
        modes.push(document.querySelector(`[data-marketplace-provider-mode="${name}"]`)?.classList.contains("is-active"));
      }
      const filters = ["minecraftVersion", "loader", "releaseChannel", "sort"].filter((name) => document.querySelector(`[data-marketplace-provider-filter="${name}"]`));
      // The select filters are saved when changed (Minecraft Version is saved
      // with them, as in Build 215).
      const loader = document.querySelector('[data-marketplace-provider-filter="loader"]');
      const choice = [...loader.options].map((option) => option.value).find((value) => value && value !== loader.value) || loader.value;
      loader.value = choice;
      loader.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(300);
      const saved = JSON.parse(localStorage.getItem("anxos:marketplace-view-state") || "{}");
      saved.minecraftVersion = saved.loader === choice ? choice : `loader not saved (${saved.loader})`;
      const before = document.querySelectorAll(".marketplace-card").length;
      document.querySelector("[data-marketplace-refresh]").click();
      for (let i = 0; i < 60 && (typeof marketplaceRequestInFlight !== "undefined" && marketplaceRequestInFlight); i += 1) await wait(100);
      await wait(500);
      const node = [...(document.querySelector('[data-node-target="marketplace"]')?.options || [])].map((option) => option.textContent.trim());
      document.querySelector("[data-download-refresh]")?.click();
      return { modes, filters, savedVersion: saved.minecraftVersion, before, after: document.querySelectorAll(".marketplace-card").length, node, downloadRefresh: Boolean(document.querySelector("[data-download-refresh]")) };
    });
    check("AS10", browseControls.modes.every(Boolean), `provider modes Featured, Trending and Recently Updated each become active (${browseControls.modes.join(", ")})`);
    check("AS10", browseControls.filters.length === 4 && browseControls.savedVersion && !/not saved/.test(browseControls.savedVersion), `the four provider filters are kept; a changed loader is remembered (${browseControls.savedVersion})`);
    check("AS10", browseControls.after >= 50 && browseControls.after === browseControls.before && browseControls.node.some((label) => /QA Computer/.test(label)) && browseControls.downloadRefresh, `Refresh reloads the catalog (${browseControls.before} → ${browseControls.after} cards); the computer selector lists ${browseControls.node.join(", ")}; Downloads Refresh present`);

    const dialogs = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      [...document.querySelectorAll(".marketplace-card")].find((card) => card.dataset.templateId === "minecraft-paper")?.click();
      await wait(400);
      const planButton = [...document.querySelectorAll(".marketplace-side-panel button")].find((button) => /install plan/i.test(button.textContent));
      const planEnabled = Boolean(planButton && !planButton.disabled);
      planButton?.click();
      let plan = null;
      for (let i = 0; i < 100 && !plan; i += 1) { plan = [...document.querySelectorAll(".app-modal")].find((modal) => /install plan/i.test(modal.textContent)); if (!plan) await wait(100); }
      const planText = plan?.textContent.replace(/\s+/g, " ").slice(0, 80) || "";
      [...(plan?.querySelectorAll("button") || [])].find((button) => /^Close$/.test(button.textContent.trim()))?.click();
      await wait(300);
      const planClosed = ![...document.querySelectorAll(".app-modal")].some((modal) => /install plan/i.test(modal.textContent));
      // The passwords dialog a Docker service shows after it is created, with
      // made-up values (no real secret).
      const shown = showMarketplaceServiceCredentials({ displayName: "QA Service" }, [{ label: "Admin password", secret: "qa-not-a-real-secret" }]);
      await wait(300);
      const credentials = [...document.querySelectorAll(".app-modal")].find((modal) => /Save your passwords/i.test(modal.getAttribute("aria-label") || ""));
      const credentialsText = credentials?.textContent.includes("Admin password") || false;
      [...(credentials?.querySelectorAll("button") || [])].pop()?.click();
      const closed = await Promise.race([shown.then(() => true), wait(2000).then(() => false)]);
      return { planEnabled, planText, planClosed, credentialsText, closed };
    });
    check("AS10", dialogs.planEnabled && /install plan/i.test(dialogs.planText) && dialogs.planClosed, `the install plan dialog opens from package details and closes ("${dialogs.planText}")`);
    check("AS10", dialogs.credentialsText && dialogs.closed, "the Docker service passwords dialog shows its entries and closes");

    const createControls = await page.evaluate(async () => {
      await enterAddServer("create", { template: { id: "minecraft-paper" } });
      await new Promise((resolve) => setTimeout(resolve, 600));
      const panel = document.querySelector(".marketplace-side-panel");
      const fields = ["version", "storageLocation", "playitTunnel"].filter((name) => document.querySelector(`[data-marketplace-field="${name}"]`));
      const summaries = [...panel.querySelectorAll("summary")].map((summary) => summary.textContent.trim().split("\n")[0]);
      const toggle = document.querySelector("[data-marketplace-version-toggle]");
      document.querySelector("[data-create-server-advanced]").open = true;
      const toggleText = toggle?.textContent.trim();
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const toggled = typeof marketplaceVersionOpen !== "undefined" ? marketplaceVersionOpen : null;
      if (toggled) toggle.click();
      const result = { fields, summaries, toggleText, toggled, back: Boolean(document.querySelector("[data-create-server-back]")) };
      closeMarketplaceWizard();
      await enterAddServer("browse");
      return result;
    });
    check("AS10", createControls.fields.length === 3 && createControls.back, `Create Server keeps the version, storage and Playit fields and Back (${createControls.fields.join(", ")})`);
    check("AS10", ["Advanced options", "Technical details", "Logs"].every((label) => createControls.summaries.some((text) => text.startsWith(label))), `Advanced options, Technical details and Logs are kept (${createControls.summaries.join(" | ")})`);
    check("AS10", createControls.toggled === true, `the version "${createControls.toggleText}" button opens the version list (${createControls.toggled})`);

    const transfer = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const textarea = document.querySelector("[data-catalog-transfer-document]");
      const status = () => document.querySelector("[data-catalog-transfer-status]")?.textContent.trim();
      document.querySelector('[data-catalog-transfer-action="export"]').click();
      for (let i = 0; i < 50 && !/Exported/.test(status() || ""); i += 1) await wait(100);
      const exported = { status: status(), length: textarea.value.length };
      const copied = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => { copied.push(text.length); };
      document.querySelector('[data-catalog-transfer-action="copy-export"]').click();
      await wait(300);
      navigator.clipboard.writeText = original;
      document.querySelector('[data-catalog-transfer-action="validate"]').click();
      for (let i = 0; i < 50 && !/Validated/.test(status() || ""); i += 1) await wait(100);
      const validated = status();
      document.querySelector('[data-catalog-transfer-action="clear"]').click();
      await wait(200);
      return { exported, copied, validated, cleared: textarea.value === "" && status() === "Idle" };
    });
    check("AS10", /Exported/.test(transfer.exported.status) && transfer.exported.length > 100, `Export Catalog fills the document (${transfer.exported.length} characters, "${transfer.exported.status}")`);
    check("AS10", transfer.copied.length === 1 && /Validated/.test(transfer.validated || "") && transfer.cleared, `Copy Document copies it, Validate Import checks it ("${transfer.validated}"), Clear empties it`);

    // ------------------------------------------------------------ AS1 windows
    const endWindows = await windowIds();
    check("AS1", endWindows.length === startWindows.length && endWindows.every((id) => startWindows.includes(id)), `no window was opened by any Add Server entry point (${startWindows.length} → ${endWindows.length})`);

    // ------------------------------------------------------------ AS7 layout
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      for (const view of ["browse", "create"]) {
        if (view === "browse") await page.evaluate(() => enterAddServer("browse"));
        else await page.evaluate(() => enterAddServer("create", { template: { id: "minecraft-paper" } }));
        await page.waitForTimeout(700);
        const layout = await page.evaluate(() => {
          const pageEl = document.querySelector('.page[data-page="marketplace"]');
          const host = pageEl.closest("[data-page-host]") || pageEl.parentElement;
          const clipped = [...pageEl.querySelectorAll(".page-header h1, .marketplace-card__body strong, .marketplace-category, .create-server-step-nav button, [data-marketplace-install]")]
            .filter((element) => element.getClientRects().length > 0)
            .filter((element) => getComputedStyle(element).textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
            .map((element) => element.textContent.trim().slice(0, 24));
          return { overflow: host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped };
        });
        check("AS7", !layout.overflow && !layout.clipped.length, `${width}x${height} ${view}: no horizontal overflow (${layout.overflow}); clipped=[${layout.clipped.join("; ")}]`);
        await shot(page, `a4-${width}x${height}-${view}`);
        if (view === "create") await page.evaluate(() => { closeMarketplaceWizard(); return enterAddServer("browse"); });
      }
    }

    // ------------------------------------------------------------ AS8 contrast
    await real.setViewport(1280, 800);
    for (const view of ["browse", "create"]) {
      if (view === "browse") await page.evaluate(() => enterAddServer("browse"));
      else await page.evaluate(() => enterAddServer("create", { template: { id: "minecraft-paper" } }));
      await page.waitForTimeout(700);
      const contrast = await page.evaluate(new Function(`${CONTRAST_HELPERS}
        const pageEl = document.querySelector('.page[data-page="marketplace"]');
        const text = [...pageEl.querySelectorAll("h1, h2, h3, .lede, .marketplace-card__body strong, .marketplace-card__body p, .marketplace-category, .inline-action:not(:disabled), .primary-button:not(:disabled), .create-server-step-nav button, label > span, .status-pill")]
          .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]") && element.innerText.trim());
        const low = [];
        for (const element of text) {
          const fg = parse(getComputedStyle(element).color);
          if (!fg) continue;
          const bg = backgroundOf(element);
          const r = ratio(over(fg, bg), bg);
          if (r < 4.5) low.push(element.className.split(" ")[0] + " '" + element.innerText.trim().slice(0, 24) + "' " + r.toFixed(2));
        }
        return { count: text.length, low };
      `));
      check("AS8", contrast.count > 10 && contrast.low.length === 0, `${view}: Add Server text meets 4.5:1 (${contrast.count} elements)${contrast.low.length ? `; below: ${contrast.low.slice(0, 6).join(" | ")}` : ""}`);
      if (view === "create") await page.evaluate(() => { closeMarketplaceWizard(); return enterAddServer("browse"); });
    }

    // ------------------------------------------------------------ AS9 errors
    check("AS9", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-add-server-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
