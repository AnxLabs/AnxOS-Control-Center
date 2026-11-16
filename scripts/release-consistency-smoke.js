#!/usr/bin/env node
// Release documentation consistency, against local fixtures only (no network).
//   A  the current release is named everywhere
//   B  historical builds stay in the history and are unchanged
//   C  a mismatched current version fails the check
//   D  an invalid asset URL or an unpublished asset is detected
//   E  a simulated future release updates every generated output
//   F  generating twice changes nothing
//   G  the no-JavaScript page says what site.js renders
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const docs = require("./release-docs");
const { checkRelease, missingPublishedAssets, stripHistory } = require("./release-consistency-check");

const repoRoot = path.resolve(__dirname, "..");
const results = [];

function copyInto(target, relative) {
  const source = path.join(repoRoot, relative);
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function listHtml(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "functions" || entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listHtml(full, base);
    return entry.name.endsWith(".html") ? [path.relative(repoRoot, full)] : [];
  });
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-release-docs-"));
  for (const file of [...listHtml(path.join(repoRoot, "website")), "website/config.js", "README.md", "docs/releases-repository/README.md"]) {
    copyInto(root, file);
  }
  return root;
}

function writeConfig(root, config) {
  fs.writeFileSync(path.join(root, "website", "config.js"), `window.ANXOS_DOWNLOAD_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
}

function writePlan(plan) {
  for (const output of plan.changed) fs.writeFileSync(output.file, output.after);
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function futureConfig(config) {
  const next = JSON.parse(JSON.stringify(config));
  const build = Number(config.buildNumber) + 1;
  const tag = `v${config.latestVersion}-build${build}`;
  const artifact = `${config.latestVersion}-build${build}`;
  next.build = String(build);
  next.buildNumber = String(build);
  next.releaseTag = tag;
  next.releaseDate = "December 3, 2026";
  next.releaseLabel = `Version ${config.latestVersion} Build ${build} ${config.channel}`;
  next.releaseUrl = `${config.repositoryUrl}/releases/tag/${tag}`;
  next.releaseAssets = config.releaseAssets.map((asset) => {
    const fileName = asset.fileName.replace(/\d+\.\d+-build\d+/, artifact);
    return { fileName, url: `${config.repositoryUrl}/releases/download/${tag}/${fileName}` };
  });
  next.releaseNotes = [{
    version: config.latestVersion,
    build,
    channel: config.channel,
    tag,
    date: "December 3, 2026",
    datetime: "2026-12-03",
    title: `AnxOS Control Center v${config.latestVersion} — Build ${build}`,
    summary: `Build ${build} is a simulated release used by the consistency smoke.`,
    changes: ["**Simulated** change with `code`."],
    url: next.releaseUrl,
  }, ...config.releaseNotes];
  return next;
}

function run(name, fn) {
  fn();
  results.push(name);
  console.log(`  ok ${name}`);
}

const fixtures = [];
try {
  // ---- A: the real repository names the current release everywhere.
  run("A current release everywhere", () => {
    const result = checkRelease({ root: repoRoot });
    assert.deepStrictEqual(result.problems, [], `repository is inconsistent:\n${result.problems.join("\n")}`);
    const { release } = result;
    for (const readme of ["README.md", "docs/releases-repository/README.md"]) {
      const text = read(repoRoot, readme);
      assert(text.includes(release.tag) && text.includes(`Build ${release.build}`), `${readme} must name ${release.tag}`);
    }
    for (const page of ["website/index.html", "website/download.html", "website/download/index.html", "website/release-notes.html"]) {
      const html = read(repoRoot, page);
      assert(html.includes(`"softwareVersion": "${release.version} Build ${release.build}"`), `${page} must carry JSON-LD for Build ${release.build}`);
    }
  });

  // ---- B: Build 205 survives only as history, and history is unchanged.
  run("B historical builds stay historical", () => {
    const html = read(repoRoot, "website/release-notes.html");
    assert(html.includes("Build 205"), "the release history must still list Build 205");
    assert(!/Build 205/.test(stripHistory(html)), "Build 205 must not appear outside the history");
    for (const page of listHtml(path.join(repoRoot, "website")).filter((page) => !page.endsWith("release-notes.html"))) {
      assert(!/Build 205|build205/.test(read(repoRoot, page)), `${page} must not mention Build 205`);
    }
    const notes = JSON.parse(read(repoRoot, "website/release-notes.json"));
    const build205 = notes.find((entry) => entry.tag === "v2.0-build205-rc3");
    assert(build205 && build205.date === "September 26, 2026", "the Build 205 history entry must be kept as published");
  });

  // ---- C: a mismatched current version fails.
  run("C mismatches fail", () => {
    const root = makeFixture();
    fixtures.push(root);
    const index = path.join(root, "website", "index.html");
    fs.writeFileSync(index, read(root, "website/index.html").replace(/data-release-meta>Version [^<]+</, "data-release-meta>Version 2.0 · Build 211 · Private Alpha · Released November 13, 2026<"));
    let result = checkRelease({ root });
    assert(!result.ok && result.problems.some((problem) => problem.includes("website/index.html")), "a stale index release line must fail");

    const root2 = makeFixture();
    fixtures.push(root2);
    const readme = path.join(root2, "README.md");
    fs.writeFileSync(readme, read(root2, "README.md").replace(/Build \d+ —/, "Build 199 —"));
    result = checkRelease({ root: root2 });
    assert(!result.ok && result.problems.some((problem) => problem.includes("README.md")), "a stale README section must fail");

    const root3 = makeFixture();
    fixtures.push(root3);
    const config = docs.loadWebsiteConfig(root3);
    config.releaseTag = "v2.0-build205-rc3";
    writeConfig(root3, config);
    result = checkRelease({ root: root3 });
    assert(!result.ok && result.problems.some((problem) => /does not name build|newest release note/.test(problem)), "a config whose tag disagrees with its build must fail");

    const root4 = makeFixture();
    fixtures.push(root4);
    const page = path.join(root4, "website", "faq", "index.html");
    fs.writeFileSync(page, read(root4, "website/faq/index.html").replace("</main>", "<p>Version 2.0 Build 205 is the latest.</p></main>"));
    result = checkRelease({ root: root4 });
    assert(!result.ok && result.problems.some((problem) => problem.includes("names build 205")), "an unmanaged old build on a page must fail");
  });

  // ---- D: invalid URLs and unpublished assets are detected.
  run("D invalid or missing assets detected", () => {
    const config = docs.loadWebsiteConfig(repoRoot);
    const broken = JSON.parse(JSON.stringify(config));
    broken.releaseAssets[0].url = "http://example.invalid/AnxOS.exe";
    assert.throws(() => docs.resolveRelease(broken), /invalid URL/, "a non-https or wrong-tag asset URL must be rejected");
    const release = docs.resolveRelease(config);
    const published = Object.values(release.files).filter((name) => !name.endsWith(".AppImage"));
    assert.deepStrictEqual(missingPublishedAssets(release, published), [release.files.linuxAppImage], "a file the site links to but the release does not publish must be reported");
    assert.deepStrictEqual(missingPublishedAssets(release, Object.values(release.files)), [], "a complete release must report nothing missing");
  });

  // ---- E + F: a future release updates every output, once.
  let futureRoot;
  run("E simulated future release updates all outputs", () => {
    futureRoot = makeFixture();
    fixtures.push(futureRoot);
    const before = docs.loadWebsiteConfig(futureRoot);
    const next = futureConfig(before);
    writeConfig(futureRoot, next);
    const plan = docs.planReleaseDocs({ root: futureRoot });
    assert(plan.changed.length >= 10, `expected most outputs to change, got ${plan.changed.length}`);
    writePlan(plan);
    const result = checkRelease({ root: futureRoot });
    assert.deepStrictEqual(result.problems, [], `future release is inconsistent:\n${result.problems.join("\n")}`);
    const build = Number(next.buildNumber);
    assert(read(futureRoot, "website/index.html").includes(`Version ${next.latestVersion} · Build ${build} · ${next.channel} · Released December 3, 2026`));
    assert(read(futureRoot, "website/download.html").includes(`/releases/download/${next.releaseTag}/AnxOS-Control-Center-Setup-${next.latestVersion}-build${build}.exe`));
    assert(read(futureRoot, "website/features/index.html").includes(`Version ${next.latestVersion} · Build ${build}`));
    assert(read(futureRoot, "README.md").includes(next.releaseTag));
    assert(read(futureRoot, "docs/releases-repository/README.md").includes(`AnxOS-Agent-${next.latestVersion}-build${build}.deb`));
    const notesHtml = read(futureRoot, "website/release-notes.html");
    assert(notesHtml.includes("<strong>Simulated</strong> change with <code>code</code>."), "inline markdown must render as in site.js");
    // The previous release is now history, word for word.
    const previous = before.releaseNotes[0];
    assert(notesHtml.includes(`<h3>${docs.escapeHtml(previous.title)}</h3>`), "the previous release must stay listed");
    assert(!stripHistory(notesHtml).includes(`Build ${previous.build}`), "the previous build must only appear as history");
    // Hand-written README text outside the markers is kept.
    assert(read(futureRoot, "README.md").includes("Made with care by AnxLabs."));
    assert(read(futureRoot, "docs/releases-repository/README.md").includes("## Verify your download"));
  });

  run("F second generation is a no-op", () => {
    const plan = docs.planReleaseDocs({ root: futureRoot });
    assert.deepStrictEqual(plan.changed.map((output) => output.file), [], "a second run must not change anything");
    const repoPlan = docs.planReleaseDocs({ root: repoRoot });
    assert.deepStrictEqual(repoPlan.changed.map((output) => path.relative(repoRoot, output.file)), [], "the repository outputs must already be current");
    // CRLF checkouts stay CRLF and stay current.
    const crlf = path.join(futureRoot, "README.md");
    fs.writeFileSync(crlf, read(futureRoot, "README.md").replace(/\r?\n/g, "\r\n"));
    assert.deepStrictEqual(docs.planReleaseDocs({ root: futureRoot }).changed.map((output) => output.file), [], "a CRLF copy must also be current");
  });

  // ---- G: no-JS content equals what site.js renders from the same config.
  run("G JavaScript-disabled pages agree with site.js", () => {
    const site = read(repoRoot, "website/site.js");
    const visible = site.match(/const RELEASE_NOTES_VISIBLE_COUNT = (\d+);/);
    assert(visible, "site.js must define RELEASE_NOTES_VISIBLE_COUNT");
    const graceful = site.match(/function gracefulReleaseSummary\(value\) \{[\s\S]*?\n\}/);
    assert(graceful, "site.js must define gracefulReleaseSummary");
    const sandbox = {};
    vm.runInNewContext(`${graceful[0]}; this.fn = gracefulReleaseSummary;`, sandbox);
    const config = docs.loadWebsiteConfig(repoRoot);
    const release = docs.resolveRelease(config);
    for (const sample of [release.summary, "A short line without an end", `${"x".repeat(70)}. And then more without a stop`]) {
      assert.strictEqual(docs.gracefulReleaseSummary(sample), sandbox.fn(sample), "summary clamping must match site.js");
    }
    // site.js: Version · Build · channel · Released date.
    for (const piece of ["metaParts.push(`Version ${config.latestVersion}`)", "metaParts.push(`Build ${config.buildNumber}`)", "metaParts.push(String(config.channel))", "metaParts.push(`Released ${config.releaseDate}`)", 'node.textContent = metaParts.join(" · ")']) {
      assert(site.includes(piece), `site.js release line must still be built from ${piece}`);
    }
    const dynamicMeta = [`Version ${config.latestVersion}`, `Build ${config.buildNumber}`, String(config.channel), `Released ${config.releaseDate}`].join(" · ");
    const download = read(repoRoot, "website/download.html");
    const notes = read(repoRoot, "website/release-notes.html");
    assert(download.includes(`data-release-meta>${dynamicMeta}<`) && notes.includes(`data-release-meta>${dynamicMeta}<`), "static release lines must equal the site.js line");
    assert(download.includes(`data-download-build>${config.buildNumber}<`) && download.includes(`data-download-date>${config.releaseDate}<`), "download facts must be readable without JavaScript");
    assert(download.includes(`data-download="windows" href="${release.fileUrls.windows}"`), "the Windows button must link to the current installer without JavaScript");
    const cards = (notes.match(/<article class="release-note-card[ "]/g) || []).length;
    assert.strictEqual(cards, config.releaseNotes.length, "every release must be readable without JavaScript");
    const visibleCards = notes.slice(0, notes.indexOf('<details class="release-notes-history">')).match(/<article class="release-note-card[ "]/g) || [];
    assert.strictEqual(visibleCards.length, Math.min(Number(visible[1]), config.releaseNotes.length), "the same number of releases must be visible before the disclosure");
    assert(notes.indexOf("badge-current") < notes.indexOf(`>${docs.escapeHtml(config.releaseNotes[0].title)}<`), "the first card must be the current release");
  });

  console.log(`Release consistency smoke passed (${results.length} cases).`);
} finally {
  for (const root of fixtures) fs.rmSync(root, { recursive: true, force: true });
}
