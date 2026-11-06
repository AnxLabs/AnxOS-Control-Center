"use strict";

// Channel selection for desktop and Agent update checks.
//
// GitHub's `prerelease` flag and the order of `GET /releases` are not channel
// identity. This repository's public release feed has marked release-candidate
// tags `prerelease: false` and Private Alpha tags `prerelease: true`, and
// `/releases/latest` follows that flag. A stable check must refuse those
// candidates. A non-stable channel must not accept a different channel just
// because the flag or the list position says otherwise.
//
// Identity is the release tag, name, release label, and explicit channel
// field. Release-note bodies are ignored: they often mention older channels.
// A release-candidate marker in the tag or name outranks a conflicting
// channel string, so an RC tag cannot become stable or Private Alpha by
// labeling itself as one.

const RELEASE_LIST_PAGE_SIZE = 100;
const MAX_RELEASE_LIST_PAGES = 5;
const NON_STABLE_MARKER = /(?:^|[^a-z0-9])rc\d*(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])(?:alpha|beta|preview)(?:[^a-z0-9]|$)|release[\s-]*candidate|private[\s-]*alpha|public[\s-]*alpha/i;
const RELEASE_CANDIDATE_MARKER = /(?:^|[^a-z0-9])rc\d*(?:[^a-z0-9]|$)|release[\s-]*candidate/i;

function identityText(release) {
  return [release?.tag_name, release?.tagName, release?.name, release?.releaseLabel, release?.channel]
    .map((value) => (typeof value === "string" ? value : ""))
    .join("\n");
}

function normalizeSelectionChannel(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!key || key === "stable") return "stable";
  if (key === "private-alpha" || key === "privatealpha") return "private-alpha";
  if (key === "public-alpha" || key === "publicalpha" || key === "alpha") return "public-alpha";
  if (key === "beta") return "beta";
  if (key === "release-candidate" || key === "rc") return "release-candidate";
  if (key === "prerelease") return "prerelease";
  // An unrecognized channel fails closed onto stable selection.
  return "stable";
}

function isStableChannelRelease(release) {
  if (!release || typeof release !== "object" || Array.isArray(release)) return false;
  if (release.draft === true || release.prerelease === true) return false;
  if (NON_STABLE_MARKER.test(identityText(release))) return false;
  const channel = String(release.channel || "").trim().toLowerCase();
  return !channel || channel === "stable";
}

function classifyReleaseChannel(release) {
  if (!release || typeof release !== "object" || Array.isArray(release) || release.draft === true) return "draft";
  const text = identityText(release);
  if (RELEASE_CANDIDATE_MARKER.test(text)) return "release-candidate";
  if (/private[\s-]*alpha/i.test(text)) return "private-alpha";
  if (/public[\s-]*alpha|(?:^|[^a-z0-9])alpha(?:[^a-z0-9]|$)/i.test(text)) return "public-alpha";
  if (/(?:^|[^a-z0-9])(?:beta|preview)(?:[^a-z0-9]|$)/i.test(text)) return "beta";
  if (release.prerelease === true) return "prerelease";
  if (isStableChannelRelease(release)) return "stable";
  return "unknown";
}

function releaseMatchesSelectionChannel(release, channel) {
  const normalized = normalizeSelectionChannel(channel);
  const inferred = classifyReleaseChannel(release);
  if (normalized === "stable") return inferred === "stable";
  // Plain GitHub prereleases with no RC/beta/public marker are this product's
  // Private Alpha tags (v2.0-build207 and later). They are not stable.
  if (normalized === "private-alpha") return inferred === "private-alpha" || inferred === "prerelease";
  if (normalized === "prerelease") return inferred === "prerelease" || inferred === "private-alpha";
  return inferred === normalized;
}

function versionParts(release) {
  const raw = String(release?.version || release?.tag_name || release?.tagName || release?.name || "");
  const match = raw.match(/(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function buildNumber(release) {
  if (Number.isInteger(release?.build) && release.build >= 0) return release.build;
  const parsedField = Number.parseInt(release?.build ?? release?.buildNumber, 10);
  if (Number.isInteger(parsedField) && parsedField >= 0 && String(release?.build ?? release?.buildNumber).trim() !== "") return parsedField;
  const raw = [release?.tag_name, release?.tagName, release?.name, release?.releaseLabel].join(" ");
  const match = raw.match(/build[-_. ]?(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function sameProductIdentity(left, right) {
  const leftVersion = versionParts(left);
  const rightVersion = versionParts(right);
  return leftVersion[0] === rightVersion[0]
    && leftVersion[1] === rightVersion[1]
    && buildNumber(left) === buildNumber(right);
}

function compareIdentityDesc(left, right) {
  const leftVersion = versionParts(left);
  const rightVersion = versionParts(right);
  if (leftVersion[0] !== rightVersion[0]) return rightVersion[0] - leftVersion[0];
  if (leftVersion[1] !== rightVersion[1]) return rightVersion[1] - leftVersion[1];
  const buildDifference = buildNumber(right) - buildNumber(left);
  if (buildDifference !== 0) return buildDifference;
  const leftTime = Date.parse(left?.published_at || left?.publishedAt || left?.created_at || "") || 0;
  const rightTime = Date.parse(right?.published_at || right?.publishedAt || right?.created_at || "") || 0;
  return rightTime - leftTime;
}

function nextReleasePageUrl(linkHeader, currentUrl, options = {}) {
  const maxPages = Number.isInteger(options.maxPages) ? options.maxPages : MAX_RELEASE_LIST_PAGES;
  const header = Array.isArray(linkHeader) ? linkHeader.join(",") : String(linkHeader || "");
  const match = header.match(/<([^>]+)>;\s*rel="next"/i);
  if (!match) return "";
  let next;
  let current;
  try {
    next = new URL(match[1]);
    current = new URL(currentUrl);
  } catch {
    return "";
  }
  if (next.origin !== current.origin || !next.pathname.endsWith("/releases")) return "";
  if (next.protocol !== "https:" && next.protocol !== "http:") return "";
  const pageParam = next.searchParams.get("page");
  if (pageParam !== null) {
    const page = Number(pageParam);
    if (!Number.isInteger(page) || page < 1 || page > maxPages) return "";
  }
  return next.toString();
}

// Reads a GitHub-style releases collection, following same-origin next links
// only. A short page ends the scan. The page cap stops a hostile or looping
// feed from being treated as endless, and `complete: false` means a later
// page was not read.
async function collectReleasePages(firstUrl, fetchPage, options = {}) {
  const maxPages = Number.isInteger(options.maxPages) ? options.maxPages : MAX_RELEASE_LIST_PAGES;
  const pageSize = Number.isInteger(options.pageSize) ? options.pageSize : RELEASE_LIST_PAGE_SIZE;
  const releases = [];
  const urls = [];
  const seen = new Set();
  let url = String(firstUrl || "");
  let complete = true;
  for (let page = 0; url && !seen.has(url) && page < maxPages; page += 1) {
    seen.add(url);
    urls.push(url);
    let result;
    try {
      result = await fetchPage(url);
    } catch (error) {
      if (!releases.length) throw error;
      complete = false;
      break;
    }
    const batch = result?.releases;
    if (!Array.isArray(batch)) {
      if (batch && typeof batch === "object") releases.push(batch);
      break;
    }
    releases.push(...batch);
    const next = nextReleasePageUrl(result?.link, url, { maxPages });
    if (batch.length < pageSize || !next) {
      if (batch.length >= pageSize && result?.link && !next) complete = false;
      break;
    }
    url = next;
  }
  return { releases, urls, complete };
}

function rankReleasesForChannel(releases, options = {}) {
  const channel = options.channel ? normalizeSelectionChannel(options.channel) : "";
  const allowPrerelease = options.allowPrerelease === true;
  const list = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && typeof release === "object" && !Array.isArray(release) && release.draft !== true);
  const eligible = list.filter((release) => {
    if (channel) return releaseMatchesSelectionChannel(release, channel);
    if (allowPrerelease) return true;
    return isStableChannelRelease(release);
  });
  eligible.sort(compareIdentityDesc);
  return eligible;
}

module.exports = {
  MAX_RELEASE_LIST_PAGES,
  NON_STABLE_MARKER,
  RELEASE_LIST_PAGE_SIZE,
  collectReleasePages,
  nextReleasePageUrl,
  buildNumber,
  classifyReleaseChannel,
  compareIdentityDesc,
  identityText,
  isStableChannelRelease,
  normalizeSelectionChannel,
  rankReleasesForChannel,
  releaseMatchesSelectionChannel,
  sameProductIdentity,
};
