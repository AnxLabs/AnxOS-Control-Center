#!/usr/bin/env node
// Keeps every static, crawler-readable statement of "the current release" in step
// with the generated website metadata.
//
// Source of truth chain (no second catalog):
//   release.json  --(sync-website-release.js)-->  website/config.js + website/release-notes.json
//   website/config.js  --(this script)-->  static HTML fallbacks, JSON-LD, README managed sections
//
// The script only touches markup that opts in:
//   HTML: the attributes site.js already renders at runtime (data-release-meta,
//         data-config, data-config-href, data-config-text, data-release-title,
//         data-release-summary, data-release-latest-summary, data-release-notes,
//         data-download-*, data-file) plus two static-only markers:
//         data-release-managed (rewrite "Version x Build y" and release dates in
//         that element or meta tag) and <script type="application/ld+json"
//         data-release-jsonld> (structured release metadata).
//   Markdown: the region between <!-- anxos-release:current:start --> and
//         <!-- anxos-release:current:end -->. Everything outside it is preserved.
//
// It is deterministic (no clock, no network) and idempotent: a second run changes
// nothing. --check exits 1 and lists the files that are out of date without
// writing; --dry-run reports the same without failing.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MARK_START = "<!-- anxos-release:current:start -->";
const MARK_END = "<!-- anxos-release:current:end -->";
const RELEASE_NOTES_VISIBLE_COUNT = 6; // must match site.js
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
// 216-B: the product is AnxHost Control Center (formerly AnxOS Control
// Center). Release titles keep the name each release was published under.
const PRODUCT_NAME = "AnxHost Control Center";
const FORMER_PRODUCT_NAME = "AnxOS Control Center";
const PUBLISHER = { name: "AnxLabs", url: "https://anxlabs.net" };

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Same lightweight markdown site.js renders: **bold** and `code`, everything else text.
function renderInline(value) {
  const text = String(value ?? "");
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let out = "";
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text))) {
    out += escapeHtml(text.slice(cursor, match.index));
    out += match[1] !== undefined ? `<strong>${escapeHtml(match[1])}</strong>` : `<code>${escapeHtml(match[2])}</code>`;
    cursor = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(cursor));
}

// Copy of site.js gracefulReleaseSummary (the summary card is line-clamped).
function gracefulReleaseSummary(value) {
  const text = String(value || "").trim();
  if (!text || /[.!?]["')\]]?$/.test(text)) return text;
  const sentenceEnd = text.lastIndexOf(". ");
  if (sentenceEnd >= 60) return text.slice(0, sentenceEnd + 1);
  return `${text.replace(/[\s,;:]+$/, "")}…`;
}

function loadWebsiteConfig(root) {
  const file = path.join(root, "website", "config.js");
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file, timeout: 1000 });
  const config = sandbox.window.ANXOS_DOWNLOAD_CONFIG;
  if (!config || typeof config !== "object") throw new Error("website/config.js does not define window.ANXOS_DOWNLOAD_CONFIG.");
  return JSON.parse(JSON.stringify(config));
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

// One release identity, derived from the generated config and checked against the
// release notes it was generated with. Any disagreement is an error, never a guess.
function resolveRelease(config) {
  const problems = [];
  const notes = Array.isArray(config.releaseNotes) ? config.releaseNotes : [];
  const latest = notes[0] || null;
  const build = Number.parseInt(config.buildNumber, 10);
  const version = String(config.latestVersion || "");
  const tag = String(config.releaseTag || "");
  if (!Number.isInteger(build)) problems.push("config.buildNumber is not a number");
  if (!version) problems.push("config.latestVersion is missing");
  if (!/^v\d+\.\d+-build\d+(-[A-Za-z0-9]+)*$/.test(tag)) problems.push(`config.releaseTag "${tag}" is not a release tag`);
  if (Number.isInteger(build) && !new RegExp(`build${build}(?!\\d)`).test(tag)) problems.push(`config.releaseTag ${tag} does not name build ${build}`);
  if (String(config.build) !== String(config.buildNumber)) problems.push("config.build and config.buildNumber disagree");
  if (!latest) problems.push("config.releaseNotes is empty");
  else {
    if (latest.tag !== tag) problems.push(`newest release note is ${latest.tag}, config says ${tag}`);
    if (Number(latest.build) !== build) problems.push(`newest release note is build ${latest.build}, config says ${build}`);
    if (String(latest.version) !== version) problems.push(`newest release note is version ${latest.version}, config says ${version}`);
    if (String(latest.channel || "") !== String(config.channel || "")) problems.push(`newest release note channel "${latest.channel}" differs from config "${config.channel}"`);
    if (String(latest.date || "") !== String(config.releaseDate || "")) problems.push(`newest release note date "${latest.date}" differs from config "${config.releaseDate}"`);
  }
  const releaseUrl = String(config.releaseUrl || "");
  if (!isHttpsUrl(releaseUrl) || !releaseUrl.endsWith(`/releases/tag/${tag}`)) problems.push(`config.releaseUrl ${releaseUrl} is not the ${tag} release page`);
  const assets = Array.isArray(config.releaseAssets) ? config.releaseAssets : [];
  const setup = assets.find((asset) => /^AnxOS-Control-Center-Setup-.+\.exe$/.test(String(asset?.fileName || "")));
  if (!setup) problems.push("config.releaseAssets has no Windows Setup installer");
  for (const asset of assets) {
    const name = String(asset?.fileName || "");
    if (!name || !isHttpsUrl(asset.url) || !String(asset.url).endsWith(`/releases/download/${tag}/${name}`)) {
      problems.push(`release asset ${name || "(unnamed)"} has an invalid URL ${asset?.url}`);
    }
  }
  if (problems.length) {
    const error = new Error(`Release metadata is inconsistent:\n- ${problems.join("\n- ")}`);
    error.problems = problems;
    throw error;
  }
  const artifactVersion = setup.fileName.replace(/^AnxOS-Control-Center-Setup-/, "").replace(/\.exe$/, "");
  const downloadBase = `${config.repositoryUrl}/releases/download/${tag}`;
  const assetUrl = (fileName) => `${downloadBase}/${fileName}`;
  const files = {
    windows: `AnxOS-Control-Center-Setup-${artifactVersion}.exe`,
    windowsPortable: `AnxOS-Control-Center-${artifactVersion}-portable.exe`,
    linuxAppImage: `AnxOS-Control-Center-${artifactVersion}.AppImage`,
    linuxDeb: `AnxOS-Control-Center-${artifactVersion}.deb`,
    linuxAgentDeb: `AnxOS-Agent-${artifactVersion}.deb`,
  };
  return {
    config,
    notes,
    latest,
    version,
    build,
    channel: String(config.channel || ""),
    tag,
    date: String(config.releaseDate || ""),
    datetime: String(latest.datetime || ""),
    summary: String(latest.summary || ""),
    title: String(latest.title || `${PRODUCT_NAME} v${version} — Build ${build}`),
    siteUrl: String(config.siteUrl || "").replace(/\/+$/, ""),
    repositoryUrl: String(config.repositoryUrl || ""),
    releaseUrl,
    latestUrl: `${config.repositoryUrl}/releases/latest`,
    artifactVersion,
    files,
    fileUrls: Object.fromEntries(Object.entries(files).map(([key, name]) => [key, assetUrl(name)])),
    meta: [`Version ${version}`, `Build ${build}`, config.channel, config.releaseDate ? `Released ${config.releaseDate}` : ""].filter(Boolean).join(" · "),
  };
}

// ---------------------------------------------------------------- HTML editing

const TAG_PATTERN = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=<>"'\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>/g;

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s=<>"'\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
  let match;
  while ((match = pattern.exec(source || ""))) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function setAttribute(openTag, name, value) {
  const escaped = escapeHtml(value);
  const pattern = new RegExp(`(\\s${name.replace(/[-]/g, "\\-")}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'<>]+)`, "i");
  if (pattern.test(openTag)) return openTag.replace(pattern, `$1"${escaped}"`);
  return openTag.replace(/\s*(\/?)>$/, ` ${name}="${escaped}"$1>`);
}

// Index just past the matching close tag of `tagName`, counting nested tags of the same name.
function findClose(html, tagName, from) {
  const pattern = new RegExp(`<(/?)${tagName}(?=[\\s>/])[^>]*>`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[1]) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return { innerEnd: match.index, end: match.index + match[0].length };
  }
  return null;
}

function scanElements(html) {
  const elements = [];
  TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAG_PATTERN.exec(html))) {
    const tag = match[1].toLowerCase();
    const element = {
      tag,
      start: match.index,
      openEnd: match.index + match[0].length,
      openTag: match[0],
      attributes: parseAttributes(match[2]),
    };
    if (!VOID_ELEMENTS.has(tag) && !match[3] && tag !== "script" && tag !== "style") {
      const close = findClose(html, tag, element.openEnd);
      if (close) Object.assign(element, close);
    } else if (tag === "script" || tag === "style") {
      const closeAt = html.toLowerCase().indexOf(`</${tag}>`, element.openEnd);
      if (closeAt !== -1) Object.assign(element, { innerEnd: closeAt, end: closeAt + tag.length + 3 });
    }
    elements.push(element);
  }
  return elements;
}

function hasClass(element, className) {
  return String(element.attributes.get("class") || "").split(/\s+/).includes(className);
}

function replaceReleaseTokens(text, release) {
  return String(text)
    .replace(/Version \d+\.\d+( ·)? Build \d+/g, (match, dot) => `Version ${release.version}${dot || ""} Build ${release.build}`)
    .replace(new RegExp(`(?:${MONTHS}) \\d{1,2}, \\d{4}`, "g"), release.date);
}

function renderReleaseCard(entry, index, release) {
  const badge = [entry.version ? `Version ${entry.version}` : entry.tag || "Release", entry.build ? `Build ${entry.build}` : "", entry.channel || ""].filter(Boolean).join(" · ");
  const title = entry.title || `Version ${entry.version || ""}`.trim();
  const parts = [];
  parts.push(index === 0
    ? `<article class="release-note-card release-note-card--latest" aria-label="Current release">`
    : `<article class="release-note-card">`);
  parts.push(`<div class="release-note-card__heading"><div>${index === 0 ? `<span class="badge badge-current">Current release</span>` : ""}<span class="badge">${escapeHtml(badge)}</span><h3>${escapeHtml(title)}</h3></div><time${entry.datetime ? ` datetime="${escapeHtml(entry.datetime)}"` : ""}>${escapeHtml(entry.date || "")}</time></div>`);
  if (entry.summary) parts.push(`<p>${renderInline(entry.summary)}</p>`);
  const sections = (Array.isArray(entry.sections) ? entry.sections : []).filter((section) => section && section.heading && Array.isArray(section.items) && section.items.length);
  if (sections.length) {
    for (const section of sections) {
      parts.push(`<div class="release-note-card__section"><h4>${escapeHtml(section.heading)}</h4><ul>${section.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul></div>`);
    }
  } else if (Array.isArray(entry.changes) && entry.changes.length) {
    parts.push(`<ul>${entry.changes.map((change) => `<li>${renderInline(change)}</li>`).join("")}</ul>`);
  }
  const url = entry.url || release.releaseUrl;
  if (url) parts.push(`<div class="release-note-card__actions"><a class="button button-ghost" href="${escapeHtml(url)}">GitHub release</a></div>`);
  parts.push(`</article>`);
  return parts.join("");
}

function renderReleaseTimeline(release) {
  const cards = release.notes.slice(0, RELEASE_NOTES_VISIBLE_COUNT).map((entry, index) => renderReleaseCard(entry, index, release));
  const older = release.notes.slice(RELEASE_NOTES_VISIBLE_COUNT);
  let html = `\n<!-- Generated by scripts/release-docs.js from website/config.js; site.js re-renders this list when JavaScript runs. -->\n${cards.join("\n")}\n`;
  if (older.length) {
    html += `<details class="release-notes-history"><summary>Show older releases (${older.length})</summary><p class="platform-note">Older entries are historical and may reference internal engineering details from earlier builds.</p><div class="release-notes-history__list" style="display: grid; gap: 16px;">\n${older.map((entry, offset) => renderReleaseCard(entry, RELEASE_NOTES_VISIBLE_COUNT + offset, release)).join("\n")}\n</div></details>\n`;
  }
  return `${html}        `;
}

function renderJsonLd(release) {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: PRODUCT_NAME,
    alternateName: FORMER_PRODUCT_NAME,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Windows 11 x64, Debian 11+ x64, Ubuntu 22.04+ x64",
    softwareVersion: `${release.version} Build ${release.build}`,
    releaseNotes: `${release.siteUrl}/release-notes`,
    datePublished: release.datetime || undefined,
    downloadUrl: `${release.siteUrl}/download`,
    url: `${release.siteUrl}/`,
    description: `${PRODUCT_NAME} ${release.channel} ${release.tag}: local-first management for game servers, Docker, files and the computers that run them.`,
    publisher: { "@type": "Organization", name: PUBLISHER.name, url: PUBLISHER.url },
  };
  return `\n${JSON.stringify(data, null, 2)}\n    `;
}

const DOWNLOAD_STATIC_TEXT = {
  "data-download-checksum": "A SHA256SUMS file with the SHA-256 checksum of every package is published on the GitHub release.",
};

// Returns the edited HTML. `relativePath` only feeds error messages.
function renderHtml(html, release) {
  const config = release.config;
  const elements = scanElements(html);
  const summaryCards = elements.filter((element) => hasClass(element, "release-summary-card") && element.end);
  const isDownloadPage = /<body[^>]*\sdata-download-page[\s>=]/i.test(html);
  const edits = [];
  const replaceInner = (element, inner) => {
    if (element.innerEnd === undefined) return;
    edits.push({ start: element.openEnd, end: element.innerEnd, text: inner, inner: true });
  };
  const replaceOpenTag = (element, openTag) => {
    if (openTag !== element.openTag) edits.push({ start: element.start, end: element.openEnd, text: openTag, inner: false });
  };

  for (const element of elements) {
    const attrs = element.attributes;
    let openTag = element.openTag;
    if (attrs.has("data-config-href")) {
      const value = config[attrs.get("data-config-href")];
      if (typeof value === "string" && value) openTag = setAttribute(openTag, "href", value);
    }
    if (isDownloadPage && attrs.has("data-download") && element.tag === "a") {
      const url = release.fileUrls[attrs.get("data-download")];
      if (url) openTag = setAttribute(openTag, "href", url);
    }
    if (attrs.has("data-release-managed") && element.tag === "meta" && attrs.has("content")) {
      openTag = setAttribute(openTag, "content", replaceReleaseTokens(attrs.get("content"), release));
    }
    if (attrs.has("data-release-managed") && element.tag === "img" && attrs.has("alt")) {
      openTag = setAttribute(openTag, "alt", replaceReleaseTokens(attrs.get("alt"), release));
    }
    replaceOpenTag(element, openTag);

    if (element.innerEnd === undefined) continue;
    const inner = html.slice(element.openEnd, element.innerEnd);
    if (attrs.has("data-release-meta")) replaceInner(element, escapeHtml(release.meta));
    else if (attrs.has("data-config")) {
      const value = config[attrs.get("data-config")];
      if (typeof value === "string" || typeof value === "number") replaceInner(element, escapeHtml(value));
    } else if (attrs.has("data-config-text")) {
      const value = config[attrs.get("data-config-text")];
      if (value !== undefined && value !== null && String(value).trim()) replaceInner(element, escapeHtml(String(value).trim()));
    } else if (attrs.has("data-release-title")) replaceInner(element, escapeHtml(`Version ${release.version}`));
    else if (attrs.has("data-release-latest-summary")) {
      const inCard = summaryCards.some((card) => card.start < element.start && card.end > element.end);
      replaceInner(element, renderInline(inCard ? gracefulReleaseSummary(release.summary) : release.summary));
    } else if (attrs.has("data-release-summary")) replaceInner(element, renderInline(release.summary));
    else if (attrs.has("data-release-notes")) replaceInner(element, renderReleaseTimeline(release));
    else if (attrs.has("data-download-version")) replaceInner(element, escapeHtml(release.version));
    else if (attrs.has("data-download-build")) replaceInner(element, escapeHtml(String(release.build)));
    else if (attrs.has("data-download-channel")) replaceInner(element, escapeHtml(release.channel));
    else if (attrs.has("data-download-date")) replaceInner(element, escapeHtml(release.date));
    else if (attrs.has("data-download-release-body")) replaceInner(element, renderInline(release.summary));
    else if (attrs.has("data-download-checksum")) replaceInner(element, escapeHtml(DOWNLOAD_STATIC_TEXT["data-download-checksum"]));
    else if (attrs.has("data-file") && release.files[attrs.get("data-file")]) replaceInner(element, escapeHtml(release.files[attrs.get("data-file")]));
    else if (attrs.has("data-release-jsonld") && element.tag === "script") replaceInner(element, renderJsonLd(release));
    else if (attrs.has("data-release-managed")) replaceInner(element, replaceReleaseTokens(inner, release));
  }

  // Apply back to front. Edits that fall inside a region whose content is being
  // replaced (for example the old cards inside [data-release-notes]) are dropped.
  edits.sort((left, right) => left.start - right.start || right.end - left.end);
  const kept = [];
  let coveredUntil = -1;
  for (const edit of edits) {
    if (edit.start < coveredUntil) continue;
    kept.push(edit);
    if (edit.inner) coveredUntil = edit.end;
  }
  let out = html;
  for (const edit of kept.sort((left, right) => right.start - left.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

// ------------------------------------------------------------ README sections

function renderMainReadmeSection(release) {
  return [
    MARK_START,
    "<!-- Generated by scripts/release-docs.js from website/config.js. Edit outside these markers. -->",
    "> [!IMPORTANT]",
    `> **Current release: [${PRODUCT_NAME} v${release.version} Build ${release.build} — ${release.channel}](${release.releaseUrl})**, released ${release.date}.`,
    `> Download it from [anxoscontrolcenter.org/download](${release.siteUrl}/download) or the [latest GitHub release](${release.latestUrl}). What changed: [release notes](${release.siteUrl}/release-notes).`,
    MARK_END,
  ].join("\n");
}

function renderReleasesReadmeSection(release) {
  const rows = [
    ["Windows 11 x64", "Setup installer (recommended)", release.files.windows],
    ["Windows 11 x64", "Portable, runs without installing", release.files.windowsPortable],
    ["Debian / Ubuntu x64 desktop", "Debian package", release.files.linuxDeb],
    ["Linux x64 desktop", "AppImage", release.files.linuxAppImage],
    ["Debian 11+ / Ubuntu 22.04+ server", "Headless AnxHost Agent (systemd)", release.files.linuxAgentDeb],
  ];
  return [
    MARK_START,
    "<!-- Generated by scripts/release-docs.js from the AnxHost website release metadata. Edit outside these markers. -->",
    `**${PRODUCT_NAME} v${release.version} Build ${release.build} — ${release.channel}**, published by ${PUBLISHER.name} on ${release.date}.`,
    "",
    `- **[Download from the latest release](${release.latestUrl})** · [${release.tag} release page](${release.releaseUrl})`,
    `- Website: [anxoscontrolcenter.org](${release.siteUrl}) · [Download page](${release.siteUrl}/download) · [Release notes](${release.siteUrl}/release-notes)`,
    "",
    "| Platform | Package | File |",
    "| --- | --- | --- |",
    ...rows.map(([platform, kind, file]) => `| ${platform} | ${kind} | [\`${file}\`](${release.releaseUrl.replace("/releases/tag/", "/releases/download/")}/${file}) |`),
    "",
    "Every release also publishes `SHA256SUMS`, a `.sha256` file for the Agent package, and the updater metadata (`latest.yml`, `latest-linux.yml`, `update-manifest.json`) that the app reads.",
    MARK_END,
  ].join("\n");
}

function replaceManagedSection(text, section, label) {
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${label} has no ${MARK_START} … ${MARK_END} section; add the markers once by hand.`);
  }
  if (text.indexOf(MARK_START, start + 1) !== -1) throw new Error(`${label} has more than one managed release section.`);
  return text.slice(0, start) + section + text.slice(end + MARK_END.length);
}

// ------------------------------------------------------------------- driver

function listHtmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "functions" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHtmlFiles(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out.sort();
}

// Render on LF text and write back with the file's own line endings, so a Windows
// checkout (CRLF) and a Linux checkout (LF) both see a second run as a no-op.
function renderPreservingEol(before, render) {
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const after = render(before.replace(/\r\n/g, "\n"));
  return eol === "\n" ? after : after.replace(/\r?\n/g, "\r\n");
}

function planReleaseDocs({ root, releasesReadmePath } = {}) {
  const resolvedRoot = path.resolve(root || path.join(__dirname, ".."));
  const release = resolveRelease(loadWebsiteConfig(resolvedRoot));
  const outputs = [];
  for (const file of listHtmlFiles(path.join(resolvedRoot, "website"))) {
    const before = fs.readFileSync(file, "utf8");
    outputs.push({ file, before, after: renderPreservingEol(before, (text) => renderHtml(text, release)) });
  }
  const readmes = [
    { file: path.join(resolvedRoot, "README.md"), render: renderMainReadmeSection, label: "README.md" },
    { file: path.join(resolvedRoot, "docs", "releases-repository", "README.md"), render: renderReleasesReadmeSection, label: "docs/releases-repository/README.md" },
  ];
  if (releasesReadmePath) readmes.push({ file: path.resolve(releasesReadmePath), render: renderReleasesReadmeSection, label: releasesReadmePath });
  for (const readme of readmes) {
    if (!fs.existsSync(readme.file)) continue;
    const before = fs.readFileSync(readme.file, "utf8");
    outputs.push({ file: readme.file, before, after: renderPreservingEol(before, (text) => replaceManagedSection(text, readme.render(release), readme.label)) });
  }
  return { root: resolvedRoot, release, outputs, changed: outputs.filter((output) => output.before !== output.after) };
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const dryRun = argv.includes("--dry-run");
  const rootArg = argv.find((arg) => arg.startsWith("--root="));
  const releasesReadmeArg = argv.find((arg) => arg.startsWith("--releases-readme="));
  const plan = planReleaseDocs({
    root: rootArg ? rootArg.slice("--root=".length) : undefined,
    releasesReadmePath: releasesReadmeArg ? releasesReadmeArg.slice("--releases-readme=".length) : undefined,
  });
  const relative = (file) => path.relative(plan.root, file).replace(/\\/g, "/") || file;
  if (!check && !dryRun) {
    for (const output of plan.changed) fs.writeFileSync(output.file, output.after);
  }
  const verb = check || dryRun ? "out of date" : "updated";
  console.log(`Release docs for ${plan.release.tag} (${plan.release.meta}): ${plan.changed.length} file(s) ${verb}.`);
  for (const output of plan.changed) console.log(`  ${relative(output.file)}`);
  if (check && plan.changed.length) {
    console.error("Run `npm run release:docs` to regenerate them.");
    return 1;
  }
  return 0;
}

module.exports = {
  MARK_START,
  MARK_END,
  escapeHtml,
  renderInline,
  gracefulReleaseSummary,
  loadWebsiteConfig,
  resolveRelease,
  renderHtml,
  scanElements,
  renderMainReadmeSection,
  renderReleasesReadmeSection,
  replaceManagedSection,
  planReleaseDocs,
  main,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}
