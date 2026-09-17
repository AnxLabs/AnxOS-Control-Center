#!/usr/bin/env node
"use strict";
// One-off: backfill placeholder release-notes entries for builds 200-203 from
// the RELEASE_NOTES_*.md files. Uses the same parser as sync-website-release.js.
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const jsonPath = path.join(rootDir, "website", "release-notes.json");
const notes = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

const builds = [200, 201, 202, 203];
let updated = 0;

for (const build of builds) {
  const entry = notes.find((n) => n.version === "1.9" && Number(n.build) === build);
  if (!entry) { console.log(`No entry for build ${build}`); continue; }
  const isPlaceholder = entry.summary === "Latest AnxOS-Control-Center release.";
  if (!isPlaceholder) { console.log(`Build ${build} already has content`); continue; }
  const mdPath = path.join(rootDir, `RELEASE_NOTES_1.9-build${build}.md`);
  if (!fs.existsSync(mdPath)) { console.log(`No markdown for build ${build}`); continue; }
  const raw = fs.readFileSync(mdPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const title = (lines.find((l) => l.startsWith("# ")) || "").replace(/^#\s+/, "").trim() || entry.title;
  const firstPara = lines.find((l, i) => i > 0 && l.trim() && !l.startsWith("#") && !l.startsWith("**"));
  const summary = (firstPara || entry.summary).trim().slice(0, 300);
  const changes = lines
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^- /, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  entry.title = title;
  entry.summary = summary;
  entry.changes = changes.length ? changes : entry.changes;
  updated++;
  console.log(`Backfilled build ${build}: "${summary.slice(0, 60)}..."`);
}

fs.writeFileSync(jsonPath, JSON.stringify(notes, null, 2) + "\n");
console.log(`Updated ${updated} entries.`);
