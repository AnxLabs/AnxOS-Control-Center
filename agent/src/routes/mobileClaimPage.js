const os = require("os");

// Browser-reachable mobile pairing page.
//
// Phone camera apps refuse custom schemes, so a QR that carries an `anxos://`
// claim is reported as "no usable data". This page gives the camera a plain
// http URL it can open: the claim travels in the query string (the claim *is*
// the capability, exactly as it is in the QR), and the page shows it for the
// phone to paste into the ANXOS app.
//
// It is deliberately unauthenticated (the caller must already hold the claim)
// and deliberately dumb: nothing is stored, nothing is echoed unescaped, and no
// other Agent surface is reachable from it. Responses are no-store with a
// no-referrer policy so the token cannot leak onward through caches or referrers.
const CLAIM_PAGE_PATH = "/pair";
const CLAIM_SCHEME_PREFIX = "anxos://pair";
const MAX_URL_LENGTH = 300;
const MAX_TOKEN_LENGTH = 128;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function isSafeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_URL_LENGTH) return false;
  if (/[<>"'`\s]/.test(text)) return false;
  return /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/i.test(text);
}

function isSafeToken(value) {
  const text = String(value || "").trim();
  return text.length >= 32 && text.length <= MAX_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(text);
}

function buildClaimString({ agentUrl, adapterUrl = "", token }) {
  const adapter = adapterUrl ? `&adapter=${encodeURIComponent(adapterUrl)}` : "";
  return `${CLAIM_SCHEME_PREFIX}?url=${encodeURIComponent(agentUrl)}${adapter}&token=${encodeURIComponent(token)}`;
}

function renderPage({ hostname, claim, agentUrl, adapterUrl, valid }) {
  const title = valid ? "Pair your phone" : "Pairing link incomplete";
  const claimBlock = valid
    ? `<p class="hint">In the ANXOS app open <strong>Pair this device</strong> and paste this code (or scan the QR there):</p>
       <pre id="claim" class="claim">${escapeHtml(claim)}</pre>
       <button id="copy" class="copy" type="button">Copy claim</button>
       <p class="meta">Agent <strong>${escapeHtml(hostname)}</strong> · ${escapeHtml(agentUrl)}${adapterUrl ? ` · adapter ${escapeHtml(adapterUrl)}` : ""}</p>`
    : `<p class="hint">This link is missing a valid claim. Generate a new one from the Desktop Control Center (Agent Control → Pair This Agent → Pair Mobile Device).</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>ANXOS · ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 20px; background: #0A0A0C; color: #F8F8F8; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 560px; margin: 0 auto; display: grid; gap: 14px; }
  .eyebrow { margin: 0; color: #A78BFA; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 26px; }
  .hint, .meta { margin: 0; color: #A1A1AA; font-size: 13px; }
  .claim { margin: 0; padding: 12px; border: 1px solid #27272A; border-radius: 10px; background: #141417; color: #F8F8F8; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; user-select: all; }
  .copy { padding: 12px 16px; border: 0; border-radius: 10px; background: #8B5CF6; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .copy:active { background: #7C3AED; }
  .meta { font-size: 12px; }
</style></head>
<body><main>
  <p class="eyebrow">AnxOS Control Center</p>
  <h1>${escapeHtml(title)}</h1>
  ${claimBlock}
</main>
<script>
  var copyButton = document.getElementById("copy");
  if (copyButton) {
    copyButton.addEventListener("click", function () {
      var claim = document.getElementById("claim");
      if (!claim || !navigator.clipboard) return;
      navigator.clipboard.writeText(claim.textContent || "").then(function () {
        copyButton.textContent = "Copied";
      }).catch(function () {});
    });
  }
</script>
</body></html>`;
}

function handleMobileClaimPage(request, url) {
  if (!url || url.pathname !== CLAIM_PAGE_PATH || request?.method !== "GET") return null;
  const agentUrl = url.searchParams.get("url") || "";
  const adapterUrl = url.searchParams.get("adapter") || "";
  const token = url.searchParams.get("token") || "";
  const valid = isSafeHttpUrl(agentUrl) && isSafeToken(token) && (!adapterUrl || isSafeHttpUrl(adapterUrl));
  const body = renderPage({
    hostname: os.hostname(),
    claim: valid ? buildClaimString({ agentUrl, adapterUrl, token }) : "",
    agentUrl: valid ? agentUrl : "",
    adapterUrl: valid ? adapterUrl : "",
    valid,
  });
  return {
    statusCode: 200,
    rawBody: body,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  };
}

module.exports = {
  CLAIM_PAGE_PATH,
  handleMobileClaimPage,
  _test: {
    buildClaimString,
    escapeHtml,
    isSafeHttpUrl,
    isSafeToken,
    renderPage,
  },
};
