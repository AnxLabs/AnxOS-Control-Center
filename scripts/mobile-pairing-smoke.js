// Mobile pairing (Desktop-side credential handoff) — hermetic smoke.
//
// Proves the security-relevant shape of the handoff without any node:
//   - the Desktop opens a pairing session with the credential it already holds
//     and only then installs a freshly minted token;
//   - the new token is persisted BEFORE verification (that ordering is what
//     makes the restore path possible) and the claim string carries exactly the
//     token the node now trusts;
//   - a failed verification reinstalls the previous credential and reports it;
//   - a failed verification where the restore also fails keeps the store on the
//     token the node actually accepted instead of a token that authenticates
//     nothing;
//   - app-host targets, missing credentials, and missing Agent URLs refuse
//     before any network call;
//   - claim strings round-trip and reject junk.
const assert = require("assert");
const path = require("path");
const Module = require("module");

const repo = path.join(__dirname, "..");
const servicePath = path.join(repo, "src", "services", "mobilePairingService.js");

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => path.join(require("os").tmpdir(), "kilo"), isPackaged: false } };
  if (parent?.filename === servicePath && request === "./nodeService") {
    return {
      getNode: () => null,
      postPairingComplete: async () => ({}),
      postPairingStart: async () => ({}),
    };
  }
  if (parent?.filename === servicePath && request === "./nodeCredentialStore") {
    return { getNodeToken: () => "", setNodeToken: () => {} };
  }
  if (parent?.filename === servicePath && request === "./applicationHostService") {
    return { APPLICATION_HOST_NODE_ID: "application-host" };
  }
  if (parent?.filename === servicePath && request === "./diagnosticsService") {
    return { log: () => {}, logError: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let mobilePairingService;
try {
  mobilePairingService = require(servicePath);
} finally {
  Module._load = originalLoad;
}

const { buildClaimCode, createMobilePairing, parseClaimCode, tokenFingerprint } = mobilePairingService;

const NODE = { id: "agent-device-a", displayName: "Anxlab", agentUrl: "http://192.168.1.134:47131" };
const PREVIOUS = "previous-node-credential-value-0123456789abcdef";
const qrEncoder = { toDataURL: async (text) => `data:image/png;base64,QR(${text.length})` };

function baseOptions(overrides = {}) {
  const calls = [];
  const store = { token: PREVIOUS };
  return {
    calls,
    store,
    options: {
      resolveNode: async () => NODE,
      readToken: () => store.token,
      writeToken: (nodeId, token) => {
        calls.push(`write:${token === PREVIOUS ? "previous" : "new"}`);
        store.token = token;
      },
      postStart: async (agentUrl, body, opts) => {
        calls.push("start");
        assert.strictEqual(agentUrl, NODE.agentUrl);
        assert.strictEqual(opts.nodeId, NODE.id);
        return { pairingCode: `ANX-000${calls.length}-SESSION`, expiresAt: "2026-09-24T18:00:00Z" };
      },
      postComplete: async (agentUrl, body, opts) => {
        const isRestore = body.permanentToken === PREVIOUS;
        calls.push(`complete:${isRestore ? "previous" : "new"}`);
        assert.strictEqual(agentUrl, NODE.agentUrl);
        assert.strictEqual(opts.nodeId, NODE.id);
        assert.ok(String(body.pairingCode || "").startsWith("ANX-"));
        return { status: "paired" };
      },
      fetchImpl: async (url, init) => {
        const token = String(init?.headers?.Authorization || "").replace(/^Bearer /, "");
        calls.push(`verify:${token === PREVIOUS ? "previous" : "new"}`);
        return { status: 200 };
      },
      qrEncoder,
      generateToken: () => "minted-phone-token-abcdefghijklmnopqrstuvwxyz-0123456789",
      ...overrides,
    },
  };
}

async function main() {
  // Happy path ---------------------------------------------------------------
  {
    const { calls, store, options } = baseOptions();
    const result = await createMobilePairing(NODE.id, options);
    assert.deepStrictEqual(calls, ["start", "complete:new", "write:new", "verify:new"], `unexpected sequence: ${calls.join(" -> ")}`);
    assert.strictEqual(store.token, "minted-phone-token-abcdefghijklmnopqrstuvwxyz-0123456789", "the store must end on the token the node accepted");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.nodeName, "Anxlab");
    assert.strictEqual(result.agentUrl, NODE.agentUrl);
    assert.match(result.qrDataUrl, /^data:image\/png;base64,QR\(/);
    assert.strictEqual(result.tokenFingerprint, tokenFingerprint(store.token));
    const claim = parseClaimCode(result.claimCode);
    assert(claim, "the claim string must parse");
    assert.strictEqual(claim.agentUrl, NODE.agentUrl);
    assert.strictEqual(claim.token, store.token, "the claim must carry the credential the node now trusts");
    console.log("Phase 1 passed: credential handoff mints, persists, verifies, and claims the right token.");
  }

  // Verification failure restores the previous credential --------------------
  {
    const { calls, store, options } = baseOptions({
      fetchImpl: async (url, init) => {
        const token = String(init?.headers?.Authorization || "").replace(/^Bearer /, "");
        calls.push(`verify:${token === PREVIOUS ? "previous" : "new"}`);
        return { status: token === PREVIOUS ? 200 : 500 };
      },
    });
    let failure = null;
    try {
      await createMobilePairing(NODE.id, options);
    } catch (error) {
      failure = error;
    }
    assert(failure, "a failed verification must reject");
    assert.strictEqual(failure.code, "MOBILE_PAIRING_VERIFY_FAILED");
    assert.strictEqual(failure.details.restored, true);
    assert.deepStrictEqual(calls, ["start", "complete:new", "write:new", "verify:new", "start", "complete:previous", "verify:previous", "write:previous"], `unexpected sequence: ${calls.join(" -> ")}`);
    assert.strictEqual(store.token, PREVIOUS, "the store must return to the credential that still authenticates");
    console.log("Phase 2 passed: a failed verification reinstalls the previous credential.");
  }

  // Verification and restore both fail: keep what the node accepted ----------
  {
    const { calls, store, options } = baseOptions({
      fetchImpl: async (url, init) => {
        const token = String(init?.headers?.Authorization || "").replace(/^Bearer /, "");
        calls.push(`verify:${token === PREVIOUS ? "previous" : "new"}`);
        return { status: 500 };
      },
      postComplete: async (agentUrl, body) => {
        const isRestore = body.permanentToken === PREVIOUS;
        calls.push(`complete:${isRestore ? "previous" : "new"}`);
        if (isRestore) throw Object.assign(new Error("restore refused"), { code: "PAIRING_REJECTED" });
        return { status: "paired" };
      },
    });
    let failure = null;
    try {
      await createMobilePairing(NODE.id, options);
    } catch (error) {
      failure = error;
    }
    assert.strictEqual(failure?.code, "MOBILE_PAIRING_VERIFY_FAILED");
    assert.strictEqual(failure.details.restored, false);
    assert.strictEqual(store.token, "minted-phone-token-abcdefghijklmnopqrstuvwxyz-0123456789", "an unconfirmed restore must not leave a token that authenticates nothing");
    assert(/could not be restored/i.test(failure.message));
    console.log("Phase 3 passed: an unconfirmed restore is reported and never fakes a working credential.");
  }

  // Refusals run before any session is opened --------------------------------
  {
    const cases = [
      [{ resolveNode: async () => null }, "NODE_NOT_FOUND"],
      [{ resolveNode: async () => ({ ...NODE, id: "application-host" }) }, "MOBILE_PAIRING_HOST_TARGET_UNSUPPORTED"],
      [{ resolveNode: async () => ({ id: "node-x", displayName: "No URL" }) }, "MOBILE_PAIRING_AGENT_URL_MISSING"],
      [{ readToken: () => "" }, "MOBILE_PAIRING_NODE_CREDENTIAL_MISSING"],
    ];
    for (const [override, expectedCode] of cases) {
      const { calls, options } = baseOptions(override);
      let failure = null;
      try {
        await createMobilePairing("agent-device-a", options);
      } catch (error) {
        failure = error;
      }
      assert.strictEqual(failure?.code, expectedCode, `expected ${expectedCode}, saw ${failure?.code}`);
      assert.deepStrictEqual(calls, [], `refusals must not reach the node (${expectedCode} reached ${calls.join(",")})`);
    }
    console.log("Phase 4 passed: every refusal happens before the node is contacted.");
  }

  // Claim round-trip and junk rejection --------------------------------------
  {
    const claim = buildClaimCode("http://192.168.1.134:47131/", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH");
    assert.strictEqual(claim.startsWith("anxos://pair?"), true);
    const parsed = parseClaimCode(claim);
    assert.deepStrictEqual(parsed, { agentUrl: "http://192.168.1.134:47131", adapterUrl: "", token: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" });
    // A claim can carry the adapter address for browser-based phones; the Agent
    // address stays the target for native builds.
    const withAdapter = buildClaimCode("http://192.168.1.134:47131", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH", "http://192.168.1.20:8001");
    const parsedWithAdapter = parseClaimCode(withAdapter);
    assert.strictEqual(parsedWithAdapter.agentUrl, "http://192.168.1.134:47131");
    assert.strictEqual(parsedWithAdapter.adapterUrl, "http://192.168.1.20:8001");
    assert.strictEqual(parseClaimCode(withAdapter.replace("&adapter=", "&junk=")).adapterUrl, "");
    assert.strictEqual(parseClaimCode("https://example.com/?token=abcdefghijklmnopqrstuvwxyz0123456789"), null);
    assert.strictEqual(parseClaimCode("anxos://pair?url=http://x&token=short"), null);
    assert.throws(() => buildClaimCode("", "a".repeat(40)), (error) => error.code === "MOBILE_PAIRING_AGENT_URL_MISSING");
    assert.throws(() => buildClaimCode("http://x", ""), (error) => error.code === "MOBILE_PAIRING_TOKEN_MISSING");
    // The derived adapter address is a LAN http URL (or empty on a host with no
    // non-internal IPv4); it must never be loopback.
    const derived = mobilePairingService._test.resolveAdapterUrl();
    assert(derived === "" || /^http:\/\/(?!127\.|localhost)\d+\.\d+\.\d+\.\d+:\d+$/.test(derived), `unexpected adapter URL: ${derived}`);
    console.log("Phase 5 passed: claim strings round-trip (incl. adapter) and reject junk.");
  }

  console.log("Mobile pairing smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});