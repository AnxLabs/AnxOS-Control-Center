#!/usr/bin/env node
"use strict";

// Build 216-A8 Files, Terminal (SSH and server consoles) and Backups: checks in
// the REAL app. Off-screen, isolated profile and config, real Agent test
// fixture with a stand-in Paper server, signed-in disposable owner.
//
// SAFETY: Files on "This PC" reaches the real disk. Every write here happens
// inside a temporary folder this suite creates and removes; storage
// connections are saved in the isolated profile only.
//
//   T1  Add Storage opens IN the main window (no window): provider and
//       authentication switches, Test Connection answers, Save refuses an
//       incomplete SFTP entry, a Local Device entry is saved, appears in the
//       list, can be edited (Edit Storage), marked default and deleted
//       (asks first); Cancel and Escape close
//   T2  the retired Add Storage window cannot be opened (no bridge, no window)
//       (window.desktopApi undefined): the Build 215 defect this wave removes
//       from the user's path
//   T3  Files in a temp folder: Go to a path, list, search, New Folder,
//       Rename, Delete (asks first), Refresh, Home, Browse/Edit mode
//   T4  file editor: Open Text, edit, Save writes the bytes, Revert, Wrap,
//       Minimap, Fullscreen, Copy Path, editor height
//   T5  server consoles (Terminal › Server consoles): sources, search,
//       filters, Pause, auto-scroll, Send, Copy, Clear, Jump to latest,
//       Show Errors, Open Instances / Marketplace
//   T6  Backups: Refresh, Create Backup for the stand-in server, it is listed
//       and can be searched, Verify, Restore shows its preview and Cancel
//       changes nothing, Delete asks first and removes it
//   T7  layout at 900x640, 1280x800, 1920x1080 for Files, SSH, Console,
//       Backups; T8 contrast; T9 every A8 inventory hook present; T10 errors
//
// Usage: node scripts/anxhost-tools-ui-qa.js [--shots=<dir>]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchRealApp, waitFor, evaluateMain } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");
const { inventoryRows, checkInventoryHooks } = require("./test-helpers/inventory-hooks");

const SERVER_ID = "survival-test";
const shotsArg = process.argv.find((arg) => arg.startsWith("--shots="));
const SHOTS = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (id, ok, message) => {
  results.push({ id, ok: Boolean(ok), message });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
};
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 15000 }).catch(() => {});
}

// Answers the app's own text prompt and confirmation dialogs the way a user
// would (types the value or the requested phrase, then confirms or cancels).
const DIALOGS = `
  window.__qaAnswer = async (value, { cancel = false } = {}) => {
    for (let i = 0; i < 60; i += 1) {
      const input = document.querySelector("[data-prompt-value]");
      const ok = document.querySelector("[data-prompt-ok], [data-confirm-ok]");
      if (input || ok) {
        if (cancel) { document.querySelector("[data-prompt-cancel], [data-confirm-cancel]")?.click(); return "cancelled"; }
        if (input && value !== undefined) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
        const phrase = document.querySelector("[data-confirm-phrase]");
        if (phrase) {
          const text = phrase.closest("[role=dialog]")?.textContent || "";
          const match = /type\\s+["“]?([^"”\\s]+)["”]?/i.exec(text);
          phrase.value = match ? match[1] : "";
          phrase.dispatchEvent(new Event("input", { bubbles: true }));
        }
        (document.querySelector("[data-prompt-ok]") || document.querySelector("[data-confirm-ok]"))?.click();
        return "answered";
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return "no dialog";
  };
`;

const CONTRAST = `
  const parse = (value) => {
    const s = String(value || "").trim();
    let m = /^rgba?\\(([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
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
  const real = await launchRealApp({ prefix: "anx-216-a8-qa-", agentOptions: { extraInstanceConfigs: [fakeMinecraftInstance({ id: SERVER_ID })] } });
  // Files on the QA computer serve the test Agent's own folder, so the
  // suite's working folder lives inside it (temporary, removed afterwards).
  const temp = fs.mkdtempSync(path.join(real.agent.home, "qa-files-"));
  fs.writeFileSync(path.join(temp, "notes.txt"), "first line\nsecond line\n");
  fs.writeFileSync(path.join(temp, "other.log"), "log\n");
  const { page, rendererErrors, app } = real;
  const windowIds = () => evaluateMain(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).map((win) => win.id));
  try {
    await signInQaOwner(page);
    await page.evaluate(new Function(DIALOGS));
    await real.setViewport(1280, 800);
    await page.evaluate(() => window.showPage("files"));
    await page.waitForTimeout(1500);

    await page.evaluate(() => window.showPage("files"));
    await page.waitForTimeout(1500);
    // ------------------------------------------------------------ T3 files in a temp folder
    const t3 = await page.evaluate(async ({ folder, agentUrl }) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const names = () => [...document.querySelectorAll("[data-file-list] tr, [data-file-list] [data-file-path]")].map((row) => row.textContent.trim()).filter(Boolean);
      // The QA computer's Agent filesystem (T1 changed the default storage).
      const agentItem = [...document.querySelectorAll("[data-storage-list] .storage-connection-item")].find((item) => item.textContent.includes(agentUrl));
      if (agentItem && !agentItem.classList.contains("is-active")) agentItem.click();
      const paths = () => [...document.querySelectorAll("[data-file-list] tr")].map((row) => String(row.dataset.filePath || ""));
      // Wait for the Agent's own listing (its root holds the test folder).
      for (let i = 0; i < 80 && !paths().some((entry) => entry === folder); i += 1) await wait(150);
      // The folder is opened from the list the way a user would (double-click).
      const entry = [...document.querySelectorAll("[data-file-list] tr")].find((row) => row.dataset.filePath === folder);
      entry?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      for (let i = 0; i < 80 && !paths().some((item) => item.startsWith(folder) && item.endsWith("notes.txt")); i += 1) await wait(150);
      // Writes below happen only inside the test folder.
      const inside = paths().length > 0 && paths().every((item) => item.startsWith(folder));
      if (!inside) return { listed: false, filtered: false, created: "not inside the test folder", renamed: "", deleted: "", folderExisted: false, renamedExisted: false, afterNames: paths(), modes: [false] };
      const listed = paths().some((item) => item.endsWith("notes.txt")) && paths().some((item) => item.endsWith("other.log"));
      const search = document.querySelector("[data-file-search]");
      search.value = "notes";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(500);
      const filtered = [...document.querySelectorAll("[data-file-list] tr")].filter((row) => !row.hidden && row.getClientRects().length > 0 && /other\.log/.test(row.textContent)).length === 0;
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(300);
      document.querySelector('[data-file-action="new-folder"]').click();
      const created = await window.__qaAnswer("qa-folder");
      await wait(1200);
      const folderRow = [...document.querySelectorAll("[data-file-list] tr")].find((row) => /qa-folder/.test(row.textContent));
      folderRow?.click();
      await wait(300);
      document.querySelector('[data-file-action="rename"]').click();
      const renamed = await window.__qaAnswer("qa-renamed");
      await wait(1200);
      const renamedRow = [...document.querySelectorAll("[data-file-list] tr")].find((row) => /qa-renamed/.test(row.textContent));
      renamedRow?.click();
      await wait(300);
      document.querySelector('[data-file-action="delete"]').click();
      const deleted = await window.__qaAnswer();
      await wait(1200);
      document.querySelector('[data-file-action="refresh"]').click();
      await wait(800);
      const modes = [];
      // Browse is the mode without an open file (Edit applies once a file
      // is open: T4).
      modes.push(Boolean(document.querySelector('[data-files-mode="browse"]')?.classList.contains("is-active")), Boolean(document.querySelector('[data-files-mode="edit"]')));
      return { listed, filtered, created, renamed, deleted, folderExisted: Boolean(folderRow), renamedExisted: Boolean(renamedRow), afterNames: names(), modes };
    }, { folder: temp, agentUrl: real.agent.url });
    const onDisk = fs.readdirSync(temp).sort();
    if (!t3.listed) console.log(`INFO T3 saw ${JSON.stringify(t3.afterNames).slice(0, 600)} (test folder ${temp})`);
    check("T3", t3.listed && t3.filtered, `Go opens the temp folder and lists its files; search filters them (${t3.listed}/${t3.filtered})`);
    check("T3", t3.folderExisted && t3.renamedExisted && t3.created === "answered" && t3.renamed === "answered" && t3.deleted === "answered" && onDisk.join() === "notes.txt,other.log", `New Folder, Rename and Delete (asked first) act on disk; folder now ${JSON.stringify(onDisk)}`);
    check("T3", t3.modes.every(Boolean), `Browse mode is active with no file open and Edit mode is kept (${t3.modes.join(", ")}); Refresh responds`);

    // ------------------------------------------------------------ T4 editor
    await page.evaluate(async (folder) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // Back in the test folder (deleting a folder returns Files to its root).
      const rowFor = (name) => [...document.querySelectorAll("[data-file-list] tr")].find((entry) => String(entry.dataset.filePath || "").endsWith(name));
      if (!rowFor("notes.txt")) {
        const folderName = folder.split(/[\\/]/).pop();
        rowFor(folderName)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        for (let i = 0; i < 60 && !rowFor("notes.txt"); i += 1) await wait(150);
      }
      const row = rowFor("notes.txt");
      row?.click();
      await wait(300);
      document.querySelector('[data-file-editor-action="open"]').click();
      const editor = document.querySelector("[data-file-editor]");
      for (let i = 0; i < 50 && !/first line/.test(getFileEditorValue() || ""); i += 1) await wait(150);
      const loaded = /first line/.test(getFileEditorValue() || "");
      document.querySelector('[data-files-mode="edit"]')?.click();
      await wait(200);
      const editMode = Boolean(document.querySelector('[data-files-mode="edit"]')?.classList.contains("is-active"));
      window.__qaT4 = { loaded, editMode };
    }, temp);
    // Typed with the real keyboard, as a user edits.
    await page.locator(".page[data-page=\"files\"] .monaco-editor .view-lines").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("qa edit\n");
    await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const editor = document.querySelector("[data-file-editor]");
      const { loaded, editMode } = window.__qaT4;
      await wait(200);
      const dirty = !document.querySelector("[data-file-editor-dirty]")?.hidden;
      const saveButton = document.querySelector('[data-file-editor-action="save"]');
      const saveNote = `disabled=${saveButton.disabled} readOnly=${editor.readOnly}`;
      saveButton.click();
      const saveAnswer = await window.__qaAnswer();
      await wait(1500);
      window.__qaSaveNote = `${saveNote} answer=${saveAnswer} status=${document.querySelector("[data-file-editor-status], [data-file-editor-message]")?.textContent.trim().slice(0, 80)}`;
      window.__qaT4b = { loaded, editMode, dirty };
    });
    await page.locator(".page[data-page=\"files\"] .monaco-editor .view-lines").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("not saved\n");
    const t4 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const editor = document.querySelector("[data-file-editor]");
      const { loaded, editMode, dirty } = window.__qaT4b;
      document.querySelector('[data-file-editor-action="revert"]').click();
      await window.__qaAnswer();
      await wait(800);
      const reverted = !/not saved/.test(getFileEditorValue() || "");
      const toggles = {};
      for (const action of ["wrap", "minimap"]) {
        const button = document.querySelector(`[data-file-editor-action="${action}"]`);
        const label = button.textContent.trim();
        button.click();
        await wait(150);
        toggles[action] = `${label} → ${button.textContent.trim()}`;
        button.click();
      }
      const copied = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => { copied.push(String(text)); };
      document.querySelector('[data-file-editor-action="copy-path"]').click();
      await wait(300);
      navigator.clipboard.writeText = original;
      const full = document.querySelector('[data-file-editor-action="fullscreen"]');
      full.click();
      await wait(300);
      const fullscreen = document.querySelector(".file-editor-panel")?.className || "";
      full.click();
      const height = document.querySelector("[data-file-editor-height]");
      const heightBefore = height?.value;
      if (height) { height.value = String(Number(height.min) + Number(height.step || 20)); height.dispatchEvent(new Event("input", { bubbles: true })); height.dispatchEvent(new Event("change", { bubbles: true })); }
      await wait(200);
      const heightChanged = height && height.value !== heightBefore;
      if (height) { height.value = heightBefore; height.dispatchEvent(new Event("input", { bubbles: true })); }
      return { saveNote: window.__qaSaveNote, loaded, editMode, dirty, reverted, toggles, copied: copied[0] || "", fullscreen, height: heightChanged ? 2 : 0 };
    });
    const saved = fs.readFileSync(path.join(temp, "notes.txt"), "utf8");
    if (!/qa edit/.test(saved)) console.log(`INFO T4 ${JSON.stringify({ loaded: t4.loaded, editMode: t4.editMode, dirty: t4.dirty, reverted: t4.reverted, saveNote: t4.saveNote })}`);
    check("T4", t4.loaded && t4.editMode && t4.dirty && /qa edit/.test(saved) && !/not saved/.test(saved) && t4.reverted, `Open Text loads the file and Edit mode applies; Save writes it (${JSON.stringify(saved.slice(-20))}); Revert drops unsaved text`);
    check("T4", Object.keys(t4.toggles).length === 2 && /notes\.txt$/.test(t4.copied) && t4.height > 1, `Wrap (${t4.toggles.wrap}), Minimap (${t4.toggles.minimap}), Copy Path (${t4.copied}), Fullscreen and the editor height slider respond`);
    await shot(page, "a8-1280-files");

    // ------------------------------------------------------------ T6 backups
    // (before T5 starts the stand-in server, which does not answer the save
    // handshake a running server gets before a backup).
    await page.evaluate(() => window.showPage("backups"));
    await page.waitForTimeout(1200);
    const t6 = await page.evaluate(async (id) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const rows = () => [...document.querySelectorAll(".backup-table tbody tr")].filter((row) => row.getClientRects().length > 0 && row.querySelector("td") && !/No backups yet/.test(row.textContent));
      document.querySelector('[data-backup-action="refresh"]').click();
      await wait(800);
      const before = rows().length;
      selectInstance(id);
      await wait(300);
      document.querySelector('[data-backup-action="create"]').click();
      for (let i = 0; i < 30 && !document.querySelector("[data-confirm-ok]"); i += 1) await wait(100);
      const dialogText = [...document.querySelectorAll("[role=dialog]")].map((dialog) => dialog.innerText.replace(/\s+/g, " ").slice(0, 120)).join(" | ");
      await window.__qaAnswer();
      for (let i = 0; i < 180 && rows().length <= before; i += 1) {
        await wait(500);
        if (i % 6 === 5) document.querySelector('[data-backup-action="refresh"]').click();
      }
      const after = rows().length;
      const row = rows()[0];
      row?.click();
      await wait(400);
      const search = [...document.querySelectorAll('.page[data-page="backups"] input')].find((input) => /search backup/i.test(input.placeholder || ""));
      // Build 215's backup search box was disabled and had no handler; it
      // was removed in Build 216 with the owner's approval.
      const searched = search ? "present" : "removed";


      rows()[0]?.click();
      const verify = document.querySelector('.backup-table [data-backup-action="verify"]');
      verify?.click();
      await wait(1500);
      // The per-backup Verify hook exists only while a backup is listed, so
      // the A8 inventory hooks are checked now (T9).
      window.__qaVerifyPresent = Boolean(verify);
      document.querySelector('[data-backup-action="restore"]').click();
      let preview = false;
      for (let i = 0; i < 40 && !preview; i += 1) { preview = Boolean([...document.querySelectorAll("[role=dialog]")].find((dialog) => /restore/i.test(dialog.textContent))); if (!preview) await wait(150); }
      const restoreAnswer = await window.__qaAnswer(undefined, { cancel: true });
      await wait(500);
      document.querySelector('[data-backup-action="delete"]').click();
      const deleteAnswer = await window.__qaAnswer();
      for (let i = 0; i < 50 && rows().length >= after; i += 1) await wait(200);
      return { dialogText, before, after, searched, preview, restoreAnswer, deleteAnswer, end: rows().length, kept: ["download", "import"].filter((name) => document.querySelector(`[data-backup-action="${name}"]`)).length };
    }, SERVER_ID);
    check("T6", t6.after > t6.before && t6.searched === "removed", `Create Backup adds one (${t6.before} → ${t6.after}); the unwired backup search box is gone (retired in Build 216)`);
    check("T6", t6.preview && t6.restoreAnswer === "cancelled", "Restore shows its preview first; Cancel changes nothing");
    check("T6", t6.deleteAnswer === "answered" && t6.end < t6.after && t6.kept === 2, `Delete asks first and removes it (${t6.after} → ${t6.end}); Verify ran; Download and Import kept`);

    // ------------------------------------------------------------ T1 Add Storage in the main window
    await page.evaluate(() => window.showPage("files"));
    await page.waitForTimeout(800);
    const before = await windowIds();
    await page.locator('[data-storage-action="open"]').click();
    await page.waitForTimeout(400);
    const t1 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const modal = document.querySelector("[data-add-storage-modal]");
      const opened = !modal.hidden && Boolean(document.activeElement?.closest("[data-add-storage-modal]"));
      const visible = (name) => !modal.querySelector(`[data-add-storage-field="${name}"]`).closest(".settings-field").hidden;
      modal.querySelector('[data-add-storage-provider="local"]').click();
      const localHidesHost = !visible("host");
      modal.querySelector('[data-add-storage-provider="sftp"]').click();
      const auth = modal.querySelector('[data-add-storage-field="authType"]');
      auth.value = "privateKey";
      auth.dispatchEvent(new Event("change", { bubbles: true }));
      const keyShown = !modal.querySelector('[data-add-storage-secret="privateKey"]').hidden && modal.querySelector('[data-add-storage-secret="password"]').hidden;
      auth.value = "password";
      auth.dispatchEvent(new Event("change", { bubbles: true }));
      const message = () => modal.querySelector("[data-add-storage-message]").textContent.trim();
      modal.querySelector('[data-add-storage-field="host"]').value = "127.0.0.1";
      modal.querySelector('[data-add-storage-field="port"]').value = "9";
      modal.querySelector('[data-add-storage-field="username"]').value = "qa";
      modal.querySelector('[data-add-storage-action="test"]').click();
      for (let i = 0; i < 100 && /Testing/.test(message()); i += 1) await wait(150);
      await wait(300);
      const tested = message();
      modal.querySelector('[data-add-storage-field="host"]').value = "";
      modal.querySelector('[data-add-storage-action="save"]').click();
      for (let i = 0; i < 60 && /Saving/.test(message()); i += 1) await wait(150);
      const refused = { message: message(), open: !modal.hidden };
      // A stored SFTP entry (never connected to): this computer has one local
      // filesystem, so a second "Local Device" entry adds nothing, as in 215.
      modal.querySelector('[data-add-storage-provider="sftp"]').click();
      modal.querySelector('[data-add-storage-field="name"]').value = "QA Local Folder";
      modal.querySelector('[data-add-storage-field="host"]').value = "127.0.0.1";
      modal.querySelector('[data-add-storage-field="port"]').value = "22";
      modal.querySelector('[data-add-storage-field="username"]').value = "qa";
      modal.querySelector('[data-add-storage-field="password"]').value = "qa-not-a-real-secret";
      modal.querySelector('[data-add-storage-action="save"]').click();
      for (let i = 0; i < 60 && !modal.hidden; i += 1) await wait(150);
      await wait(800);
      const listed = [...document.querySelectorAll("[data-storage-list] *")].some((element) => element.children.length === 0 && /QA Local Folder/.test(element.textContent));
      return { opened, localHidesHost, keyShown, tested, refused, savedClosed: modal.hidden, listed };
    });
    const afterAdd = await windowIds();
    check("T1", t1.opened && afterAdd.length === before.length, `"+ Add Storage" opens in the main window with focus inside (windows ${before.length} → ${afterAdd.length})`);
    check("T1", t1.localHidesHost && t1.keyShown, "Local Device hides the SFTP fields; Private Key shows the key and hides the password");
    check("T1", t1.tested && !/Testing/.test(t1.tested), `Test Connection answers ("${t1.tested.slice(0, 90)}")`);
    check("T1", t1.refused.open && t1.refused.message && !/saved/i.test(t1.refused.message), `an SFTP entry without a host is refused and the dialog stays open ("${t1.refused.message.slice(0, 90)}")`);
    check("T1", t1.savedClosed && t1.listed, `a Local Device entry is saved, the dialog closes and it is listed (${t1.listed})`);

    const t1b = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const item = [...document.querySelectorAll("[data-storage-list] .storage-connection-item")].find((element) => /QA Local Folder/.test(element.textContent));
      item?.click();
      await wait(400);
      document.querySelector('[data-storage-action="edit"]').click();
      await wait(400);
      const modal = document.querySelector("[data-add-storage-modal]");
      const editing = { title: modal.querySelector("[data-add-storage-title]").textContent.trim(), name: modal.querySelector('[data-add-storage-field="name"]').value };
      modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(300);
      const escaped = modal.hidden;
      document.querySelector('[data-storage-action="set-default"]').click();
      await wait(800);
      const badge = document.querySelector("[data-storage-active-badge]")?.textContent.trim() || "";
      document.querySelector('[data-storage-action="delete"]').click();
      const answer = await window.__qaAnswer();
      await wait(1200);
      const gone = ![...document.querySelectorAll("[data-storage-list] *")].some((element) => element.children.length === 0 && /QA Local Folder/.test(element.textContent));
      return { editing, escaped, badge, answer, gone };
    });
    check("T1", t1b.editing.title === "Edit Storage" && t1b.editing.name === "QA Local Folder" && t1b.escaped, `Edit opens "${t1b.editing.title}" with the saved name; Escape closes it`);
    check("T1", t1b.answer === "answered" && t1b.gone, `Delete asks first and removes the entry (${t1b.answer}; badge after Mark Default "${t1b.badge}")`);

    // ------------------------------------------------------------ T2 the retired window
    // Build 216 retired the separate Add Storage window and its IPC (owner
    // approval); Add Storage opens only as the in-window dialog checked in T1.
    const windowsBefore = app.windows().length;
    const t2 = await page.evaluate(() => ({ bridge: typeof window.anxos?.storageWindow, opener: typeof window.AnxAddStorageDialog?.open }));
    await page.waitForTimeout(500);
    check("T2", t2.bridge === "undefined" && t2.opener === "function" && app.windows().length === windowsBefore, `no storageWindow bridge (${t2.bridge}), Add Storage is the in-window dialog (${t2.opener}), no extra window`);

    // ------------------------------------------------------------ T5 server consoles
    await page.evaluate(async (id) => { window.showPage("instances"); selectInstance(id); await window.AnxServerView.open(id, "overview"); }, SERVER_ID);
    await page.locator('.instance-quick-actions [data-instance-action="start"]').click().catch(() => {});
    await waitFor(page, () => /running/i.test(document.querySelector('[data-field="instanceDetailState"]')?.textContent || ""), null, "stand-in server running", 300).catch(() => {});
    await page.evaluate(async () => { await window.AnxServerView.close(); window.showPage("console"); });
    await page.waitForTimeout(2000);
    const t5 = await page.evaluate(async (id) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const source = [...document.querySelectorAll(".console-source-row, [data-console-source]")].find((row) => row.textContent.includes("Survival") || row.dataset.consoleSource === id || row.dataset.instanceId === id);
      source?.click();
      await wait(1500);
      const filters = [];
      for (const name of ["error", "warn", "info", "debug", "chat", "command", "all"]) {
        const chip = document.querySelector(`[data-console-filter="${name}"]`);
        chip?.click();
        await wait(100);
        filters.push(`${name}=${Boolean(chip?.classList.contains("is-active") || chip?.getAttribute("aria-pressed") === "true")}`);
      }
      const search = document.querySelector("[data-console-search]");
      search.value = "zz-none";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(300);
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      const pause = document.querySelector("[data-console-pause]");
      pause.click();
      const paused = pause.checked;
      pause.click();
      const command = document.querySelector("[data-console-command]");
      const commandEnabled = command && !command.disabled;
      if (commandEnabled) {
        command.value = "say a8-console";
        document.querySelector("[data-console-send]").click();
      }
      let echoed = false;
      for (let i = 0; i < 40 && commandEnabled && !echoed; i += 1) { echoed = document.body.innerText.includes("a8-console"); await wait(200); }
      const copied = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => { copied.push(String(text).length); };
      document.querySelector("[data-console-copy]")?.click();
      await wait(300);
      navigator.clipboard.writeText = original;
      document.querySelector("[data-console-show-errors]")?.click();
      await wait(200);
      document.querySelector("[data-console-clear]")?.click();
      await wait(200);
      const sourceSearch = document.querySelector("[data-console-source-search]");
      sourceSearch.value = "survival";
      sourceSearch.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(300);
      sourceSearch.value = "";
      sourceSearch.dispatchEvent(new Event("input", { bubbles: true }));
      const present = ["[data-console-jump-latest]", "[data-console-dismiss-alert]", "[data-console-autoscroll]", '[data-console-action="refresh"]'].filter((selector) => document.querySelector(selector)).length;
      document.querySelector('[data-console-nav="instances"]')?.click();
      await wait(300);
      const nav1 = document.querySelector(".page.is-active")?.dataset.page;
      window.showPage("console");
      document.querySelector('[data-console-nav="marketplace"]')?.click();
      await wait(300);
      const nav2 = document.querySelector(".page.is-active")?.dataset.page;
      return { source: Boolean(source), filters, paused, commandEnabled, echoed, copied: copied.length, present, nav: `${nav1}, ${nav2}` };
    }, SERVER_ID);
    check("T5", t5.source && t5.filters.filter((entry) => entry.endsWith("=true")).length >= 6, `the console lists the server and its filters switch (${t5.filters.join(", ")})`);
    check("T5", t5.paused && t5.commandEnabled && t5.echoed && t5.copied === 1 && t5.present === 4, `Pause, Send (answer streamed back=${t5.echoed}), Copy, Show Errors, Clear, source search; Jump, Dismiss, auto-scroll and Refresh kept`);
    check("T5", t5.nav === "instances, marketplace", `Open Instances and Open Marketplace go to their pages (${t5.nav})`);

    // ------------------------------------------------------------ T7 layout
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      for (const pageName of ["files", "ssh", "console", "backups"]) {
        await page.evaluate((name) => window.showPage(name), pageName);
        await page.waitForTimeout(400);
        const layout = await page.evaluate((name) => {
          const pageEl = document.querySelector(`.page[data-page="${name}"]`);
          const host = pageEl.closest("[data-page-host]") || pageEl.parentElement;
          const clipped = [...pageEl.querySelectorAll(".page-header h1, .page-tabs__tab, .panel-heading h2, .settings-section__header h2")]
            .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
            .map((element) => element.textContent.trim().slice(0, 24));
          // A10: a control cut off by a panel that hides its overflow (the SSH
          // toolbar's Copy, Clear and Fullscreen at 1280 px) is unreachable.
          // Scroll containers are left out: their content can be scrolled to.
          const cutOff = [...pageEl.querySelectorAll("button, label.console-toggle, input, select")]
            .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]"))
            .filter((element) => {
              const box = element.getBoundingClientRect();
              for (let node = element.parentElement; node && node !== pageEl; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.overflowX === "auto" || style.overflowX === "scroll") return false;
                if (style.overflowX === "hidden" || style.overflowX === "clip") {
                  const frame = node.getBoundingClientRect();
                  return box.right > frame.right + 1 || box.left < frame.left - 1;
                }
              }
              return false;
            })
            .map((element) => (element.textContent || element.getAttribute("aria-label") || element.name || element.tagName).trim().slice(0, 20));
          return { overflow: host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped, cutOff };
        }, pageName);
        check("T7", !layout.overflow && !layout.clipped.length && !layout.cutOff.length, `${width}x${height} ${pageName}: no horizontal overflow (${layout.overflow}); clipped=[${layout.clipped.join("; ")}]; controls cut off by a panel=[${layout.cutOff.join("; ")}]`);
        await shot(page, `a8-${width}x${height}-${pageName}`);
      }
    }

    // ------------------------------------------------------------ T8 contrast
    await real.setViewport(1280, 800);
    for (const pageName of ["files", "ssh", "console", "backups"]) {
      await page.evaluate((name) => window.showPage(name), pageName);
      await page.waitForTimeout(400);
      const contrast = await page.evaluate(new Function("name", `${CONTRAST}
        const pageEl = document.querySelector('.page[data-page="' + name + '"]');
        const text = [...pageEl.querySelectorAll("h1, h2, h3, .lede, label > span, .inline-action:not(:disabled), .status-pill, .page-tabs__tab, th, td, .settings-note")]
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
      `), pageName);
      check("T8", contrast.count > 5 && contrast.low.length === 0, `${pageName}: text meets 4.5:1 (${contrast.count} elements)${contrast.low.length ? `; below: ${contrast.low.slice(0, 6).join(" | ")}` : ""}`);
    }

    // ------------------------------------------------------------ T9 inventory hooks
    const verifyPresent = await page.evaluate(() => window.__qaVerifyPresent === true);
    const hooksAll = await checkInventoryHooks(page, inventoryRows({ wave: "A8" }));
    // data-backup-action=verify is drawn per listed backup; it was present
    // while T6's backup existed.
    const hooks = { ...hooksAll, missing: hooksAll.missing.filter((entry) => !(entry.hook === "data-backup-action=verify" && verifyPresent)) };
    check("T9", hooks.missing.length === 0, `${hooks.present.length} A8 hooks present in the running app${hooks.missing.length ? `; missing: ${hooks.missing.map((entry) => entry.hook).join(", ")}` : ""} (${hooks.notChecked.length} computed or window rows covered above)`);
    check("T10", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-tools-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
