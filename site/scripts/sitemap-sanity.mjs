#!/usr/bin/env node
// Strict, offline postbuild checks for the pages that we ask crawlers to index.
// Redirects outside the sitemap and RSS discovery links are intentionally ignored.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSeoBuild } from "./lib/seo-build-validation.mjs";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await validateSeoBuild({ distDir: path.join(siteDir, "dist") });
  console.log(`[sitemap-sanity] Checked ${result.sitemapPages} sitemap pages, ${result.htmlAlternateLinks} HTML and ${result.sitemapAlternateLinks} sitemap language links`);
  if (result.errors.length) {
    const counts = new Map();
    for (const error of result.errors) counts.set(error.code, (counts.get(error.code) ?? 0) + 1);
    console.error(`[sitemap-sanity] FAIL: ${result.errors.length} issue(s) (${[...counts].map(([code, count]) => `${code}: ${count}`).join(", ")})`);
    for (const error of result.errors.slice(0, 30)) {
      console.error(`  [${error.code}] ${error.url}: ${error.message}`);
    }
    if (result.errors.length > 30) console.error(`  ... and ${result.errors.length - 30} more`);
    process.exitCode = 1;
  } else {
    console.log("[sitemap-sanity] OK");
  }
} catch (error) {
  console.error(`[sitemap-sanity] FAIL: ${error.message}`);
  process.exitCode = 1;
}
