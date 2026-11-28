#!/usr/bin/env node
"use strict";

// Read-only checks of the LIVE website for the AnxHost domain move. Only GET
// requests to the public site, Cloudflare DNS-over-HTTPS and a TLS handshake;
// nothing is changed. Exit code 1 when a check for the chosen stage fails.
//
//   --stage=dns        anxhost.anxlabs.net resolves, has a valid certificate
//                      and serves the site over HTTPS
//   --stage=legacy     what installed apps rely on is up on anxoscontrolcenter.org:
//                      config.js, release-notes.json, sign-in pages, the
//                      IndexNow key, the www redirect, the download API
//   --stage=deployed   after the approved deploy of the routing worker (legacy
//                      still canonical): legacy checks, every download API
//                      request redirects to the official release (no 502),
//                      the new host is noindex and serves sign-in itself
//   --stage=switched   after the approved canonical switch: legacy pages 301
//                      to the new host, app and sign-in paths stay on legacy,
//                      and the new host serves sign-in itself (no 302 since
//                      2026-11-27)
//   --samples=<n>      download API requests per platform (default 8)
// Run: node scripts/website-launch-check.js --stage=dns

const tls = require("tls");

const LEGACY = "anxoscontrolcenter.org";
const NEW = "anxhost.anxlabs.net";
const RELEASES = "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/";
const INDEXNOW_KEY = "63065fedd3db1e49b0c6286f2bfa4350";
const PLATFORMS = ["windows", "windows-portable", "linux-appimage", "linux-deb"];
const UA = { "user-agent": "AnxHost-launch-check/1 (read-only)" };

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.length ? rest.join("=") : true]; }));
const stage = String(args.stage || "legacy");
const samples = Math.max(1, Number(args.samples) || 8);
const results = [];

function record(ok, label, detail = "") {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

async function get(url) {
  const response = await fetch(url, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(15000) });
  const body = response.status >= 300 && response.status < 400 ? "" : await response.text();
  return { status: response.status, location: response.headers.get("location"), robots: response.headers.get("x-robots-tag"), type: response.headers.get("content-type") || "", body };
}

async function check(label, url, expect) {
  try {
    const response = await get(url);
    const problem = expect(response);
    record(!problem, label, problem || `${response.status}${response.location ? ` -> ${response.location}` : ""}`);
    return response;
  } catch (error) {
    record(false, label, error.message);
    return null;
  }
}

async function resolve(name) {
  const answers = {};
  for (const type of ["CNAME", "A", "AAAA"]) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10000) });
    const json = await response.json();
    answers[type] = (json.Answer || []).filter((answer) => answer.type === { CNAME: 5, A: 1, AAAA: 28 }[type]).map((answer) => answer.data);
  }
  return answers;
}

function certificate(host) {
  return new Promise((resolvePromise) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      resolvePromise({ authorized: socket.authorized, error: socket.authorizationError || null, subject: cert?.subject?.CN || "", altNames: cert?.subjectaltname || "", issuer: cert?.issuer?.O || cert?.issuer?.CN || "", validTo: cert?.valid_to || "" });
      socket.end();
    });
    socket.on("error", (error) => resolvePromise({ authorized: false, error: error.message }));
    socket.on("timeout", () => { socket.destroy(); resolvePromise({ authorized: false, error: "timeout" }); });
  });
}

const expectStatus = (status) => (r) => (r.status === status ? null : `expected ${status}, got ${r.status}`);
const expectRedirect = (status, location) => (r) => (r.status === status && r.location === location ? null : `expected ${status} -> ${location}, got ${r.status} -> ${r.location}`);

async function dnsStage() {
  const answers = await resolve(NEW);
  const resolves = answers.A.length > 0 || answers.AAAA.length > 0;
  record(resolves, `${NEW} resolves`, `CNAME ${answers.CNAME.join(", ") || "-"} · A ${answers.A.length} · AAAA ${answers.AAAA.length}`);
  if (!resolves) return;
  const cert = await certificate(NEW);
  const covers = new RegExp(`DNS:${NEW.replace(/\./g, "\\.")}(,|$)`).test(cert.altNames || "") || cert.subject === NEW;
  record(cert.authorized && covers, `${NEW} HTTPS certificate`, cert.error ? cert.error : `issuer ${cert.issuer}, valid to ${cert.validTo}`);
  await check(`${NEW} serves the site over HTTPS`, `https://${NEW}/`, (r) => (r.status === 200 && /AnxHost Control Center/.test(r.body) ? null : `status ${r.status}`));
}

async function legacyStage() {
  await check(`${LEGACY} home`, `https://${LEGACY}/`, expectStatus(200));
  await check(`${LEGACY}/config.js (update fallback)`, `https://${LEGACY}/config.js`, (r) => (r.status === 200 && /buildNumber/.test(r.body) ? null : `status ${r.status}`));
  await check(`${LEGACY}/release-notes.json`, `https://${LEGACY}/release-notes.json`, (r) => { if (r.status !== 200) return `status ${r.status}`; try { JSON.parse(r.body); return null; } catch { return "not JSON"; } });
  for (const page of ["/signin/", "/activate/", "/account/"]) {
    await check(`${LEGACY}${page} (sign-in, not redirected)`, `https://${LEGACY}${page}`, expectStatus(200));
  }
  await check(`${LEGACY} IndexNow key`, `https://${LEGACY}/${INDEXNOW_KEY}.txt`, (r) => (r.status === 200 && r.body.trim() === INDEXNOW_KEY ? null : `status ${r.status}`));
  await check(`www.${LEGACY} redirects`, `https://www.${LEGACY}/download?x=1`, (r) => (r.status === 301 && /^https:\/\/(anxoscontrolcenter\.org|anxhost\.anxlabs\.net)\/download\?x=1$/.test(r.location || "") ? null : `got ${r.status} -> ${r.location}`));
}

async function downloadApi(host, { strict }) {
  const counts = {};
  let failures = 0;
  for (let index = 0; index < samples; index += 1) {
    for (const platform of PLATFORMS) {
      try {
        const r = await get(`https://${host}/api/download/latest/${platform}`);
        const ok = r.status === 302 && String(r.location || "").startsWith(RELEASES);
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (!ok) failures += 1;
      } catch {
        counts.error = (counts.error || 0) + 1;
        failures += 1;
      }
    }
  }
  const summary = Object.entries(counts).map(([status, count]) => `${status}×${count}`).join(", ");
  if (strict) record(failures === 0, `${host} download API, ${samples * PLATFORMS.length} requests all redirect to the official release`, summary);
  else console.log(`INFO ${host} download API (${samples * PLATFORMS.length} requests): ${summary}`);
}

// The new host serves its own sign-in pages (no redirect), and they load the
// account configuration that talks to the shared account service.
async function newHostSignIn() {
  for (const page of ["/signin/?return=%2Faccount", "/activate/?code=TEST-CODE", "/account/", "/forgot-password/", "/reset-password/"]) {
    await check(`${NEW}${page} served on the new host`, `https://${NEW}${page}`, (r) => (r.status === 200 && !r.location && /account-config.js/.test(r.body) ? null : `status ${r.status}${r.location ? ` -> ${r.location}` : ""}`));
  }
}

async function deployedStage() {
  await legacyStage();
  await downloadApi(LEGACY, { strict: true });
  await check(`${LEGACY} home is indexable`, `https://${LEGACY}/`, (r) => (r.status === 200 && !r.robots ? null : `status ${r.status}, x-robots-tag ${r.robots}`));
  await check(`${LEGACY} serves the redesign`, `https://${LEGACY}/anxhost-site.css`, expectStatus(200));
  await check(`${NEW} home is noindex before the switch`, `https://${NEW}/`, (r) => (r.status === 200 && /noindex/.test(r.robots || "") ? null : `status ${r.status}, x-robots-tag ${r.robots}`));
  await newHostSignIn();
  await downloadApi(NEW, { strict: true });
}

async function switchedStage() {
  await check(`${LEGACY}/download 301 to the new host`, `https://${LEGACY}/download?x=1`, expectRedirect(301, `https://${NEW}/download?x=1`));
  await check(`${LEGACY}/ 301 to the new host`, `https://${LEGACY}/`, expectRedirect(301, `https://${NEW}/`));
  await check(`${LEGACY}/config.js stays (update fallback)`, `https://${LEGACY}/config.js`, expectStatus(200));
  await check(`${LEGACY}/release-notes.json stays`, `https://${LEGACY}/release-notes.json`, expectStatus(200));
  await check(`${LEGACY}/activate/ stays (sign-in)`, `https://${LEGACY}/activate/?code=TEST-CODE`, expectStatus(200));
  await check(`${LEGACY}/signin/ stays (sign-in)`, `https://${LEGACY}/signin/`, expectStatus(200));
  await downloadApi(LEGACY, { strict: true });
  await check(`${NEW} home is indexable with its own canonical`, `https://${NEW}/`, (r) => (r.status === 200 && !r.robots && r.body.includes(`<link rel="canonical" href="https://${NEW}/">`) ? null : `status ${r.status}, x-robots-tag ${r.robots}`));
  await check(`${NEW}/robots.txt names the new sitemap`, `https://${NEW}/robots.txt`, (r) => (r.body.includes(`Sitemap: https://${NEW}/sitemap.xml`) ? null : "sitemap line missing"));
  await newHostSignIn();
  await check(`${NEW} IndexNow key`, `https://${NEW}/${INDEXNOW_KEY}.txt`, (r) => (r.status === 200 && r.body.trim() === INDEXNOW_KEY ? null : `status ${r.status}`));
}

async function main() {
  console.log(`Website launch check, stage ${stage}`);
  if (stage === "dns") await dnsStage();
  else if (stage === "legacy") { await legacyStage(); await downloadApi(LEGACY, { strict: false }); }
  else if (stage === "deployed") await deployedStage();
  else if (stage === "switched") await switchedStage();
  else throw new Error("--stage must be dns, legacy, deployed or switched");
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed} of ${results.length} checks passed.`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
