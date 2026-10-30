"use strict";

// playit account IPC (src/ipc/publicAccessIpc.js) and Agent routes
// (agent/src/routes/playit.js): playit.gg claim and sign-in links are opened by
// the main process and never handed to the renderer or to read-only callers.
// Transports are stubbed; no playit command runs.
// Run: node scripts/playit-account-ipc-smoke.js

const assert = require("assert");
const Module = require("module");

const CLAIM = "https://playit.gg/claim/AbC123xyz";
const handlers = new Map();
const opened = [];
const audits = [];
let session = null;
let manage = { linkUrl: "https://playit.gg/login/guest-account/Zx9" };

const stubs = {
  electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
  "../services/externalUrlService": {
    openExternalUrl: async (url, options) => { opened.push({ url, source: options.source }); return { opened: true, url }; },
  },
  "../services/securityService": {
    requirePermission: () => true,
    audit: (entry) => audits.push(entry.action),
  },
  "./nodeContext": { requireNodeContext: (payload) => payload },
  "../services/agentClient": {},
  "../services/publicAccessProviderService": new Proxy({
    getPlayitAccountForNode: async () => ({ installed: true, running: true, linked: false, step: "link" }),
    startPlayitLinkForNode: async () => session,
    getPlayitLinkForNode: async (options) => {
      assert.strictEqual(options.withLink, true, "the main process asks for the link so it can open it");
      return session;
    },
    cancelPlayitLinkForNode: async () => ({ ...session, state: "cancelled", endedAt: "now", linkUrl: CLAIM }),
    getPlayitManageLinkForNode: async () => manage,
  }, { get: (target, name) => target[name] || (async () => ({})) }),
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

const { registerPublicAccessIpc } = require("../src/ipc/publicAccessIpc");
registerPublicAccessIpc();
const invoke = (channel, payload = { nodeId: "local" }) => handlers.get(channel)({}, payload);
const noLink = (value, label) => assert.ok(!JSON.stringify(value).includes("playit.gg/"), `${label} must not carry a playit.gg link`);

async function main() {
  // Start: no link yet, then the link appears while polling and opens once.
  session = { id: "s1", state: "starting", startedAt: "t", endedAt: null, message: null, linkUrl: null };
  let view = await invoke("publicAccess:startPlayitLink");
  assert.deepStrictEqual([view.id, view.state, view.hasLink, view.opened], ["s1", "starting", false, false]);
  assert.strictEqual(opened.length, 0);
  session = { ...session, state: "awaiting-approval", linkUrl: CLAIM };
  view = await invoke("publicAccess:getPlayitLink", { nodeId: "local", linkId: "s1" });
  noLink(view, "a polled linking attempt");
  assert.deepStrictEqual([view.state, view.hasLink, view.opened], ["awaiting-approval", true, true]);
  assert.deepStrictEqual(opened, [{ url: CLAIM, source: "playit-account-link" }], "the approval link opens in the browser");
  view = await invoke("publicAccess:getPlayitLink", { nodeId: "local", linkId: "s1" });
  assert.strictEqual(view.opened, false);
  assert.strictEqual(opened.length, 1, "polling does not reopen the link");
  view = await invoke("publicAccess:openPlayitLink", { nodeId: "local", linkId: "s1" });
  noLink(view, "a reopened linking attempt");
  assert.strictEqual(opened.length, 2, "Open again reopens it on request");
  view = await invoke("publicAccess:cancelPlayitLink", { nodeId: "local", linkId: "s1" });
  noLink(view, "a cancelled linking attempt");
  assert.strictEqual(view.state, "cancelled");
  console.log("PASS B1 the approval link opens once in the browser and never reaches the renderer");

  // A link that is not https://playit.gg is never opened.
  session = { id: "s2", state: "awaiting-approval", startedAt: "t", endedAt: null, linkUrl: "https://evil.example/claim" };
  view = await invoke("publicAccess:getPlayitLink", { nodeId: "local", linkId: "s2" });
  assert.strictEqual(view.ok, false);
  assert.strictEqual(opened.length, 2, "non-playit links are refused");
  noLink(view, "a refused link error");
  manage = { linkUrl: "javascript:alert(1)" };
  view = await invoke("publicAccess:openPlayitManage");
  assert.strictEqual(view.ok, false);
  assert.strictEqual(opened.length, 2);
  manage = { linkUrl: "https://playit.gg/login/guest-account/Zx9" };
  view = await invoke("publicAccess:openPlayitManage");
  assert.deepStrictEqual(view, { opened: true }, "Manage reports only that the page opened");
  assert.strictEqual(opened[2].source, "playit-account-manage");
  view = await invoke("publicAccess:openPlayitDownload");
  assert.deepStrictEqual(view, { opened: true });
  assert.strictEqual(opened[3].url, "https://playit.gg/download");
  console.log("PASS B2 only allowlisted playit.gg links open; Manage and Download return no link");

  assert.ok(["publicAccess.startPlayitLink", "publicAccess.openPlayitLink", "publicAccess.cancelPlayitLink", "publicAccess.openPlayitManage"].every((action) => audits.includes(action)), "account actions are audited");
  assert.ok(!audits.includes("publicAccess.getPlayitLink"), "polling is not audited per request");
  console.log("PASS B3 account actions are audited; polling is not");

  // Agent: read-scoped progress never includes the link.
  Module._load = originalLoad;
  const { withoutLinkUrl } = require("../agent/src/routes/playit");
  const stripped = withoutLinkUrl({ id: "s1", state: "awaiting-approval", linkUrl: CLAIM });
  assert.deepStrictEqual(stripped, { id: "s1", state: "awaiting-approval", hasLink: true });
  const { handlePublicAccessPlayit } = require("../agent/src/routes/playit");
  const missing = await handlePublicAccessPlayit({ method: "GET" }, new URL("http://agent/api/v1/public-access/playit/account/link/none"));
  assert.strictEqual(missing.statusCode, 404);
  assert.strictEqual(missing.body.error.code, "PLAYIT_LINK_NOT_FOUND");
  console.log("PASS B4 Agent link progress for read-scoped callers carries no link");

  console.log("playit account IPC smoke passed (4 checks).");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
