#!/usr/bin/env node
// Postbuild guard: walk every URL in dist/sitemap-index.xml and verify the
// generated HTML doesn't ship the kind of silent SEO regression that's hard
// to spot in review.
//
// Hard fail (exit 1):
//   - <meta name="robots" content="...noindex...">
//
// Warnings only (logged but don't fail the build):
//   - canonical link doesn't match the page's own URL
//   - missing or empty <h1>
//   - missing meta description
//
// Designed to be fast: regex-driven, runs in a single pass over the file
// tree. On a 3,000-page build it adds ~1s to postbuild.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(__dirname, "..");
const DIST = path.join(SITE_DIR, "dist");
const SITE_ORIGIN = "https://startdebugging.net";

const LOC_RE = /<loc>([^<]+)<\/loc>/g;
const ROBOTS_RE = /<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i;
const CANONICAL_RE = /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i;
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const DESCRIPTION_RE = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i;

function extractLocs(xml) {
  const out = [];
  for (const m of xml.matchAll(LOC_RE)) out.push(m[1]);
  return out;
}

function urlToHtmlPath(u) {
  // Astro is configured with trailingSlash: 'always', so every URL maps to
  // <pathname>/index.html under dist/.
  const pathname = new URL(u).pathname;
  const rel = pathname.endsWith("/") ? pathname + "index.html" : pathname + "/index.html";
  return path.join(DIST, rel.replace(/^\//, ""));
}

const indexPath = path.join(DIST, "sitemap-index.xml");
let indexXml;
try {
  indexXml = await fs.readFile(indexPath, "utf8");
} catch (err) {
  console.error(`[sitemap-sanity] Cannot read ${indexPath}: ${err.message}`);
  process.exit(1);
}

const childSitemaps = extractLocs(indexXml).map((u) => {
  const pathname = new URL(u).pathname.replace(/^\//, "");
  return path.join(DIST, pathname);
});

const urls = [];
for (const child of childSitemaps) {
  const xml = await fs.readFile(child, "utf8");
  urls.push(...extractLocs(xml));
}

const failures = [];
const canonicalWarnings = [];
const h1Warnings = [];
const descriptionWarnings = [];
const readErrors = [];

await Promise.all(
  urls.map(async (u) => {
    const filePath = urlToHtmlPath(u);
    let html;
    try {
      html = await fs.readFile(filePath, "utf8");
    } catch (err) {
      readErrors.push({ url: u, error: err.message });
      return;
    }

    const robotsMatch = ROBOTS_RE.exec(html);
    if (robotsMatch && /\bnoindex\b/i.test(robotsMatch[1])) {
      failures.push({ url: u, robots: robotsMatch[1] });
    }

    const canonicalMatch = CANONICAL_RE.exec(html);
    if (canonicalMatch && canonicalMatch[1] !== u) {
      canonicalWarnings.push({ url: u, canonical: canonicalMatch[1] });
    }

    const h1Match = H1_RE.exec(html);
    if (!h1Match || h1Match[1].replace(/<[^>]+>/g, "").trim() === "") {
      h1Warnings.push(u);
    }

    const descriptionMatch = DESCRIPTION_RE.exec(html);
    if (!descriptionMatch || descriptionMatch[1].trim() === "") {
      descriptionWarnings.push(u);
    }
  }),
);

console.log(`[sitemap-sanity] Checked ${urls.length} URL(s)`);

if (readErrors.length > 0) {
  console.log(`[sitemap-sanity] WARN: ${readErrors.length} URL(s) had no matching HTML file:`);
  for (const r of readErrors.slice(0, 10)) console.log(`  ${r.url}`);
  if (readErrors.length > 10) console.log(`  ... and ${readErrors.length - 10} more`);
}

if (canonicalWarnings.length > 0) {
  console.log(`[sitemap-sanity] WARN: ${canonicalWarnings.length} canonical mismatch(es):`);
  for (const w of canonicalWarnings.slice(0, 10)) {
    console.log(`  ${w.url}`);
    console.log(`    canonical: ${w.canonical}`);
  }
  if (canonicalWarnings.length > 10) {
    console.log(`  ... and ${canonicalWarnings.length - 10} more`);
  }
}

if (h1Warnings.length > 0) {
  console.log(`[sitemap-sanity] WARN: ${h1Warnings.length} URL(s) missing <h1>:`);
  for (const u of h1Warnings.slice(0, 10)) console.log(`  ${u}`);
  if (h1Warnings.length > 10) console.log(`  ... and ${h1Warnings.length - 10} more`);
}

if (descriptionWarnings.length > 0) {
  console.log(`[sitemap-sanity] WARN: ${descriptionWarnings.length} URL(s) missing meta description:`);
  for (const u of descriptionWarnings.slice(0, 10)) console.log(`  ${u}`);
  if (descriptionWarnings.length > 10) {
    console.log(`  ... and ${descriptionWarnings.length - 10} more`);
  }
}

if (failures.length > 0) {
  console.error(`[sitemap-sanity] FAIL: ${failures.length} URL(s) ship robots=noindex while listed in the sitemap:`);
  for (const f of failures) console.error(`  ${f.url} (robots: ${f.robots})`);
  process.exit(1);
}

console.log("[sitemap-sanity] OK");
