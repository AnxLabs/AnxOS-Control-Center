#!/usr/bin/env node
// Checks that every place which states "the current release" agrees, without
// rebuilding anything:
//   1. website/config.js and website/release-notes.json describe one release
//      (tag, build, version, channel, date, asset URLs) — release-docs.resolveRelease.
//   2. The generated outputs are up to date (release-docs --check).
//   3. The crawler-readable current-release surfaces name that release: the
//      [data-release-meta] lines, JSON-LD softwareVersion, managed meta tags and
//      both README sections.
//   4. Outside the release-notes history, no site page names a different build.
//      Historical builds are allowed only inside [data-release-notes] (the
//      changelog) and in website/release-notes.json.
// With --live it also compares the config with the public GitHub Latest release
// and its asset names (one API call; the deploy guard does the same).
const fs = require("fs");
const path = require("path");
const docs = require("./release-docs");

const BUILD_REFERENCE = /\bBuild (\d{2,4})\b|\bbuild(\d{2,4})\b/g;

function stripHistory(html) {
  // Remove the changelog container's content: it is history by definition.
  const elements = docs.scanElements(html);
  const history = elements.filter((element) => element.attributes.has("data-release-notes") && element.innerEnd !== undefined);
  let out = html;
  for (const element of history.sort((left, right) => right.start - left.start)) {
    out = out.slice(0, element.openEnd) + out.slice(element.innerEnd);
  }
  return out;
}

function textOf(html, element) {
  return html.slice(element.openEnd, element.innerEnd).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function checkRelease({ root, plan: givenPlan } = {}) {
  const problems = [];
  let plan;
  try {
    plan = givenPlan || docs.planReleaseDocs({ root });
  } catch (error) {
    return { ok: false, problems: (error.problems || [error.message]).map((problem) => `metadata: ${problem}`) };
  }
  const { release } = plan;
  const relative = (file) => path.relative(plan.root, file).replace(/\\/g, "/");

  for (const output of plan.changed) problems.push(`${relative(output.file)} is out of date (run npm run release:docs)`);

  const pagesWithMeta = new Set();
  let jsonLdBlocks = 0;
  for (const output of plan.outputs) {
    const file = relative(output.file);
    if (!file.endsWith(".html")) continue;
    const html = output.before;
    const elements = docs.scanElements(html);
    for (const element of elements) {
      const attrs = element.attributes;
      if (attrs.has("data-release-meta") && element.innerEnd !== undefined) {
        pagesWithMeta.add(file);
        if (textOf(html, element) !== release.meta) problems.push(`${file}: release line reads "${textOf(html, element)}", expected "${release.meta}"`);
      }
      if (attrs.has("data-release-jsonld") && element.innerEnd !== undefined) {
        jsonLdBlocks += 1;
        try {
          const data = JSON.parse(html.slice(element.openEnd, element.innerEnd));
          if (data.softwareVersion !== `${release.version} Build ${release.build}`) problems.push(`${file}: JSON-LD softwareVersion is "${data.softwareVersion}"`);
          if (release.datetime && data.datePublished !== release.datetime) problems.push(`${file}: JSON-LD datePublished is "${data.datePublished}"`);
        } catch (error) {
          problems.push(`${file}: JSON-LD is not valid JSON (${error.message})`);
        }
      }
      if (attrs.has("data-release-managed") && element.tag === "meta") {
        const content = attrs.get("content") || "";
        if (/Build \d+/.test(content) && !content.includes(`Build ${release.build}`)) problems.push(`${file}: ${attrs.get("property") || attrs.get("name")} names another build`);
      }
      if (attrs.has("data-config-href") && attrs.get("data-config-href") === "releaseUrl" && attrs.get("href") !== release.releaseUrl) {
        problems.push(`${file}: a GitHub release link points to ${attrs.get("href")}`);
      }
    }
    const current = stripHistory(html);
    let match;
    BUILD_REFERENCE.lastIndex = 0;
    while ((match = BUILD_REFERENCE.exec(current))) {
      const build = Number(match[1] || match[2]);
      if (build !== release.build) {
        problems.push(`${file}: names build ${build} outside the release history ("${current.slice(Math.max(0, match.index - 40), match.index + 20).replace(/\s+/g, " ")}")`);
      }
    }
  }
  for (const page of ["website/index.html", "website/download.html", "website/download/index.html", "website/release-notes.html"]) {
    if (fs.existsSync(path.join(plan.root, page)) && !pagesWithMeta.has(page)) problems.push(`${page}: has no [data-release-meta] current-release line`);
  }
  if (!jsonLdBlocks) problems.push("no page carries [data-release-jsonld] structured release metadata");

  for (const output of plan.outputs) {
    const file = relative(output.file);
    if (!file.endsWith(".md")) continue;
    const start = output.before.indexOf(docs.MARK_START);
    const end = output.before.indexOf(docs.MARK_END);
    const section = start !== -1 && end > start ? output.before.slice(start, end) : "";
    if (!section.includes(release.tag) || !section.includes(`Build ${release.build}`) || !section.includes(release.date)) {
      problems.push(`${file}: managed release section does not name ${release.tag}, Build ${release.build} and ${release.date}`);
    }
  }
  return { ok: problems.length === 0, problems, release };
}

// Published asset names (from GitHub) must include every file the website links to.
function missingPublishedAssets(release, publishedNames) {
  const names = new Set(publishedNames);
  return Object.values(release.files).filter((name) => !names.has(name));
}

async function checkLive(release) {
  const guard = require("./verify-website-config-vs-stable");
  const stable = await guard.resolveStableRelease();
  const problems = [];
  if (stable.tag_name !== release.tag) problems.push(`GitHub Latest is ${stable.tag_name}, the website says ${release.tag}`);
  const names = (stable.assets || []).map((asset) => String(asset?.name || ""));
  if (names.length) {
    for (const name of missingPublishedAssets(release, names)) problems.push(`GitHub Latest does not publish ${name}`);
  }
  return problems;
}

async function main(argv = process.argv.slice(2)) {
  const rootArg = argv.find((arg) => arg.startsWith("--root="));
  const result = checkRelease({ root: rootArg ? rootArg.slice("--root=".length) : undefined });
  const problems = [...result.problems];
  if (argv.includes("--live") && result.release) problems.push(...(await checkLive(result.release)).map((problem) => `live: ${problem}`));
  if (problems.length) {
    console.error(`Release consistency check failed (${problems.length}):\n- ${problems.join("\n- ")}`);
    return 1;
  }
  console.log(`Release consistency check passed: ${result.release.tag} (${result.release.meta}) everywhere${argv.includes("--live") ? ", and it is the GitHub Latest release" : ""}.`);
  return 0;
}

module.exports = { checkRelease, missingPublishedAssets, stripHistory };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
