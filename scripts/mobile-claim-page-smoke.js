// Agent mobile-claim page — hermetic smoke.
//
// The page is browser-reachable and pre-auth, so its whole job is to be boring:
// validate strictly, escape everything, store nothing, and never leak the claim
// onward. These checks pin that, plus the claim format the mobile app parses.
const assert = require("assert");
const path = require("path");

const { CLAIM_PAGE_PATH, handleMobileClaimPage, _test } = require(path.join(__dirname, "..", "agent", "src", "routes", "mobileClaimPage.js"));

const VALID_URL = "http://192.168.1.134:47131";
const VALID_ADAPTER = "http://192.168.1.20:8001";
const VALID_TOKEN = "oCT11P0eJpXeOFR9m6kALIRS-VV9Q6nTLrEkcjVxYDI";

function request(pathname, params = {}) {
  const search = new URLSearchParams(params).toString();
  return {
    request: { method: "GET" },
    url: new URL(`http://192.168.1.134:47131${pathname}${search ? `?${search}` : ""}`),
  };
}

// Validation ------------------------------------------------------------------
{
  assert.strictEqual(_test.isSafeHttpUrl(VALID_URL), true);
  assert.strictEqual(_test.isSafeHttpUrl("ftp://x"), false);
  assert.strictEqual(_test.isSafeHttpUrl("http://x/\" onmouseover=alert(1)"), false);
  assert.strictEqual(_test.isSafeHttpUrl(`http://${"a".repeat(400)}`), false);
  assert.strictEqual(_test.isSafeToken(VALID_TOKEN), true);
  assert.strictEqual(_test.isSafeToken("short"), false);
  assert.strictEqual(_test.isSafeToken(`${VALID_TOKEN}<script>`), false);
  console.log("Phase 1 passed: URL and token validation refuse junk.");
}

// Claim format ----------------------------------------------------------------
{
  const claim = _test.buildClaimString({ agentUrl: VALID_URL, adapterUrl: VALID_ADAPTER, token: VALID_TOKEN });
  assert.strictEqual(claim.startsWith("anxos://pair?"), true);
  const params = new URLSearchParams(claim.split("?")[1]);
  assert.strictEqual(params.get("url"), VALID_URL);
  assert.strictEqual(params.get("adapter"), VALID_ADAPTER);
  assert.strictEqual(params.get("token"), VALID_TOKEN);
  console.log("Phase 2 passed: the page builds the same claim the Desktop and app use.");
}

// Response shape --------------------------------------------------------------
{
  const { request: req, url } = request(CLAIM_PAGE_PATH, { url: VALID_URL, adapter: VALID_ADAPTER, token: VALID_TOKEN });
  const result = handleMobileClaimPage(req, url);
  assert(result, "a GET on the claim path must be handled");
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.headers["Content-Type"], "text/html; charset=utf-8");
  assert.strictEqual(result.headers["Cache-Control"], "no-store");
  assert.strictEqual(result.headers["Referrer-Policy"], "no-referrer");
  assert.match(result.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(result.rawBody, /anxos:\/\/pair\?/);
  assert.match(result.rawBody, new RegExp(VALID_TOKEN));
  assert.match(result.rawBody, /Copy claim/);
  console.log("Phase 3 passed: a valid claim renders a no-store page with the claim and copy button.");
}

// Refusals and escaping -------------------------------------------------------
{
  // Missing/invalid params: a friendly page, never a crash or a reflection.
  for (const params of [{}, { url: VALID_URL }, { url: VALID_URL, token: "short" }, { url: "javascript:alert(1)", token: VALID_TOKEN }]) {
    const { request: req, url } = request(CLAIM_PAGE_PATH, params);
    const result = handleMobileClaimPage(req, url);
    assert.strictEqual(result.statusCode, 200);
    assert.match(result.rawBody, /Pairing link incomplete/);
    assert.doesNotMatch(result.rawBody, /anxos:\/\/pair\?/);
  }
  // An injection attempt must be escaped, never executed as markup.
  const evil = "http://x/\" ><script>alert(1)</script>";
  const { request: req, url } = request(CLAIM_PAGE_PATH, { url: evil, token: VALID_TOKEN });
  const result = handleMobileClaimPage(req, url);
  assert.doesNotMatch(result.rawBody, /<script>alert\(1\)<\/script>/);
  assert.match(result.rawBody, /Pairing link incomplete/);
  // Only GET on the exact path is handled; everything else falls through.
  assert.strictEqual(handleMobileClaimPage({ method: "POST" }, new URL(`http://x${CLAIM_PAGE_PATH}`)), null);
  assert.strictEqual(handleMobileClaimPage({ method: "GET" }, new URL("http://x/other")), null);
  console.log("Phase 4 passed: invalid claims and injections are refused, other routes fall through.");
}

console.log("Mobile claim page smoke passed.");