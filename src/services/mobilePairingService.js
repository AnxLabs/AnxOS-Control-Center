const crypto = require("crypto");
const QRCode = require("qrcode");
const diagnostics = require("./diagnosticsService");
const {
  getNode,
  postPairingComplete,
  postPairingStart,
} = require("./nodeService");
const { getNodeToken, setNodeToken } = require("./nodeCredentialStore");
const { APPLICATION_HOST_NODE_ID } = require("./applicationHostService");

// Mobile pairing = a deliberate credential handoff.
//
// The Agent holds one permanent credential and refuses network pairing of an
// enrolled node unless the caller proves possession of it (security P1 in
// agent/src/routes/pairing.js). So the Desktop — which already holds the node
// credential — opens a pairing session with that proof, completes it with a
// freshly minted token, verifies the new token works, and only then hands the
// token to the phone. The Desktop stores the new token itself, so nothing is
// left behind: after this flow exactly the Desktop and the paired phone hold
// the node credential, and the previous one is retired.
//
// If verification fails, the previous token is reinstalled (session opened with
// the new token as proof) and the store is restored before the error is
// reported. The claim string never contains anything but the node URL and the
// token, and neither is ever logged.
const CLAIM_SCHEME = "anxos";
const CLAIM_HOST = "pair";
const TOKEN_BYTES = 36;
const DEFAULT_ADAPTER_PORT = 8001;

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex").slice(0, 12);
}

// A browser cannot call the Agent directly (the Agent deliberately sends no
// permissive CORS headers), so the claim also carries the LAN address of the
// mobile adapter when one can be derived. Phones running the web build then have
// a working target by default; native builds keep using the Agent address.
function resolveAdapterUrl() {
  const configured = String(process.env.ANXOS_MOBILE_ADAPTER_URL || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^ ]+$/i.test(configured)) return configured;
  const port = Number.parseInt(process.env.ANXOS_MOBILE_ADAPTER_PORT || "", 10) || DEFAULT_ADAPTER_PORT;
  try {
    const os = require("os");
    const candidates = [];
    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (!entry || entry.family !== "IPv4" || entry.internal) continue;
        if (String(entry.address).startsWith("169.254.")) continue;
        candidates.push({ address: entry.address, preferred: /ethernet|wi-?fi|wlan|en\d/i.test(name) });
      }
    }
    const chosen = candidates.find((candidate) => candidate.preferred) || candidates[0];
    return chosen ? `http://${chosen.address}:${port}` : "";
  } catch {
    return "";
  }
}

function buildClaimCode(agentUrl, token, adapterUrl = "") {
  const url = String(agentUrl || "").trim().replace(/\/+$/, "");
  if (!url) throw Object.assign(new Error("The node has no Agent address to pair against."), { code: "MOBILE_PAIRING_AGENT_URL_MISSING" });
  if (!token) throw Object.assign(new Error("The pairing token is missing."), { code: "MOBILE_PAIRING_TOKEN_MISSING" });
  const adapter = /^https?:\/\/[^ ]+$/i.test(String(adapterUrl || "").trim()) ? String(adapterUrl).trim().replace(/\/+$/, "") : "";
  const adapterParam = adapter ? `&adapter=${encodeURIComponent(adapter)}` : "";
  return `${CLAIM_SCHEME}://${CLAIM_HOST}?url=${encodeURIComponent(url)}${adapterParam}&token=${encodeURIComponent(token)}`;
}

function parseClaimCode(claim) {
  const text = String(claim || "").trim();
  if (!text.toLowerCase().startsWith(`${CLAIM_SCHEME}://${CLAIM_HOST}`)) return null;
  const query = text.split("?")[1] || "";
  const params = {};
  for (const part of query.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    params[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(part.slice(separator + 1));
  }
  const url = (params.url || "").replace(/\/+$/, "");
  const adapterUrl = (params.adapter || "").replace(/\/+$/, "");
  const token = params.token || "";
  if (!/^https?:\/\/[^ ]+$/i.test(url) || token.length < 32) return null;
  return {
    agentUrl: url,
    adapterUrl: /^https?:\/\/[^ ]+$/i.test(adapterUrl) ? adapterUrl : "",
    token,
  };
}

async function probeAgentHealth(fetchImpl, agentUrl, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(`${agentUrl}/api/v1/health`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function createMobilePairing(nodeId, options = {}) {
  const resolveNode = options.resolveNode || ((id) => getNode(id));
  const readToken = options.readToken || ((id) => getNodeToken(id));
  const writeToken = options.writeToken || ((id, token) => setNodeToken(id, token));
  const postStart = options.postStart || ((url, body, opts) => postPairingStart(url, body, opts));
  const postComplete = options.postComplete || ((url, body, opts) => postPairingComplete(url, body, opts));
  const fetchImpl = options.fetchImpl || fetch;
  const qrEncoder = options.qrEncoder || QRCode;
  const generateToken = options.generateToken || (() => crypto.randomBytes(TOKEN_BYTES).toString("base64url"));

  const node = await resolveNode(nodeId);
  if (!node) {
    throw Object.assign(new Error("The node does not exist."), { code: "NODE_NOT_FOUND" });
  }
  if (node.id === APPLICATION_HOST_NODE_ID) {
    throw Object.assign(new Error("Pair mobile devices to a node Agent. The application host is paired from Agent Control → Pair This Agent."), {
      code: "MOBILE_PAIRING_HOST_TARGET_UNSUPPORTED",
    });
  }
  const agentUrl = String(node.agentUrl || node.baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^ ]+$/i.test(agentUrl)) {
    throw Object.assign(new Error("This node has no usable Agent address. Repair its connection first."), {
      code: "MOBILE_PAIRING_AGENT_URL_MISSING",
    });
  }
  const previousToken = String(readToken(node.id) || "").trim();
  if (!previousToken) {
    throw Object.assign(new Error("This Desktop does not hold a credential for the node. Repair the node connection first."), {
      code: "MOBILE_PAIRING_NODE_CREDENTIAL_MISSING",
    });
  }

  const token = generateToken();
  const session = await postStart(agentUrl, {}, { nodeId: node.id });
  const pairingCode = session?.pairingCode || session?.code;
  if (!pairingCode) {
    throw Object.assign(new Error("The node did not return a pairing session."), { code: "MOBILE_PAIRING_SESSION_MISSING" });
  }
  await postComplete(agentUrl, { pairingCode, permanentToken: token }, { nodeId: node.id });

  // Persist before probing: the restore path below proves possession with the
  // token the node currently trusts, which is only knowable from the store.
  writeToken(node.id, token);
  const verified = await probeAgentHealth(fetchImpl, agentUrl, token);
  if (!verified) {
    let restored = false;
    try {
      const restoreSession = await postStart(agentUrl, {}, { nodeId: node.id });
      const restoreCode = restoreSession?.pairingCode || restoreSession?.code;
      if (restoreCode) {
        await postComplete(agentUrl, { pairingCode: restoreCode, permanentToken: previousToken }, { nodeId: node.id });
        restored = await probeAgentHealth(fetchImpl, agentUrl, previousToken);
      }
    } catch {
      restored = false;
    }
    writeToken(node.id, restored ? previousToken : token);
    throw Object.assign(new Error(restored
      ? "The new mobile credential did not verify; the previous node credential was restored."
      : "The new mobile credential did not verify and the previous credential could not be restored. Repair the node connection."), {
      code: "MOBILE_PAIRING_VERIFY_FAILED",
      details: { nodeId: node.id, agentUrl, restored },
    });
  }

  const claimCode = buildClaimCode(agentUrl, token, resolveAdapterUrl());
  const qrDataUrl = await qrEncoder.toDataURL(claimCode, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
    color: { dark: "#0A0A0C", light: "#FFFFFF" },
  });
  diagnostics.log("info", "mobile-pairing", "create", "Mobile device claim created for a node.", {
    nodeId: node.id,
    agentUrl,
    tokenFingerprint: tokenFingerprint(token),
  }, { file: "service-manager" });
  return {
    ok: true,
    nodeId: node.id,
    nodeName: node.displayName || node.name || node.id,
    agentUrl,
    adapterUrl: parseClaimCode(claimCode)?.adapterUrl || "",
    claimCode,
    qrDataUrl,
    tokenFingerprint: tokenFingerprint(token),
    sessionExpiresAt: session?.expiresAt || null,
  };
}

module.exports = {
  CLAIM_SCHEME,
  buildClaimCode,
  createMobilePairing,
  parseClaimCode,
  tokenFingerprint,
  _test: {
    probeAgentHealth,
    resolveAdapterUrl,
  },
};