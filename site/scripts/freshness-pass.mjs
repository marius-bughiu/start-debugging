#!/usr/bin/env node
/**
 * freshness-pass.mjs
 *
 * Re-checks posts in the last N days (default 30) by re-fetching the
 * canonical source URLs they cite. When the upstream page's content hash
 * differs from the last snapshot we stored, we:
 *   - bump `updatedDate` in the post frontmatter to today
 *   - append an "## Updates" section with a one-line note
 *
 * The goal is to keep time-sensitive posts (".NET 11 Preview N", "Flutter
 * 3.x release", etc.) honest: if the upstream moved, say so. JSON-LD
 * `dateModified` and the article:modified_time meta then reflect the
 * refresh date.
 *
 * Snapshots live in `content-strategy/freshness-index.json`:
 *   { "YYYY/MM/slug": { "url": "https://...", "sha": "abc123", "at": "..." } }
 *
 * This script is INTENTIONALLY CONSERVATIVE:
 *   - Dry-run by default. `--apply` actually rewrites posts and the index.
 *   - Never touches posts older than --max-age (default 30 days).
 *   - Never rewrites the post body except to append a new "## Updates" line.
 *   - Only tracks URLs it has seen before OR discovers on first run.
 *   - First run builds the index without bumping any dates (it needs a
 *     baseline before it can detect drift).
 *
 * Usage:
 *   node scripts/freshness-pass.mjs                 # dry run over last 30 days
 *   node scripts/freshness-pass.mjs --apply         # rewrite posts + index
 *   node scripts/freshness-pass.mjs --max-age=60
 *   node scripts/freshness-pass.mjs --first-run     # build index, no bumps
 *   node scripts/freshness-pass.mjs --verbose
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");
const CONTENT_ROOT = path.join(SITE_ROOT, "src", "content", "blog");
const INDEX_PATH = path.join(REPO_ROOT, "content-strategy", "freshness-index.json");

// --- CLI flags -------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const flagValue = (name) => {
  const hit = [...args].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
};
const APPLY = args.has("--apply");
const FIRST_RUN = args.has("--first-run");
const VERBOSE = args.has("--verbose");
const MAX_AGE_DAYS = Number(flagValue("max-age") ?? 30);

// --- Helpers ---------------------------------------------------------------

async function walk(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && full.endsWith(".md")) out.push(full);
  }
  return out;
}

async function loadIndex() {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveIndex(index) {
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf8");
}

// Grab every http(s) URL that appears inside a markdown link `[text](url)`.
// We skip bare URLs and non-http schemes - markdown-link form is a strong
// signal the author treats the URL as a real citation.
function extractCitedUrls(body) {
  const urls = new Set();
  const re = /\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(body))) {
    // Trim a trailing punctuation mark that sometimes sneaks in.
    let u = m[1];
    while (u.endsWith(".") || u.endsWith(",") || u.endsWith(";")) u = u.slice(0, -1);
    urls.add(u);
  }
  return Array.from(urls);
}

async function fetchContentHash(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "startdebugging-freshness-pass/1.0 (+https://startdebugging.net)",
      },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    // Strip <script>, <style>, comments, and whitespace-only lines so minor
    // asset hash / analytics-tag churn doesn't look like content drift.
    const normalized = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const sha = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return { ok: true, sha };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(t);
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// --- Main -----------------------------------------------------------------

async function main() {
  const files = await walk(CONTENT_ROOT);
  const index = await loadIndex();
  const now = Date.now();
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  const report = [];
  report.push(`# Freshness pass ${todayIso()}`);
  report.push(
    `- mode: ${APPLY ? "APPLY" : "dry-run"}, first-run=${FIRST_RUN}, max-age=${MAX_AGE_DAYS}d`,
  );

  let scanned = 0;
  let bumped = 0;
  let checkedUrls = 0;
  let driftedUrls = 0;

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const { data, content } = matter(raw);
    if (data.draft) continue;
    if (!data.pubDate) continue;

    const pub = new Date(data.pubDate).valueOf();
    if (now - pub > maxAgeMs) continue;

    const relFromBlog = path.relative(CONTENT_ROOT, file).replace(/\\/g, "/");
    const slug = relFromBlog.replace(/\.md$/, "");
    scanned++;

    const urls = extractCitedUrls(content);
    if (urls.length === 0) continue;

    const entry = index[slug] ?? {};
    const drifted = [];

    for (const url of urls) {
      checkedUrls++;
      const res = await fetchContentHash(url);
      if (!res.ok) {
        if (VERBOSE) {
          report.push(`  ! ${slug}: unreachable ${url} (${res.status ?? res.error})`);
        }
        continue;
      }
      const prev = entry[url];
      if (!prev) {
        // First time seeing this URL. Record the baseline only; do not bump.
        entry[url] = { sha: res.sha, at: todayIso() };
        continue;
      }
      if (prev.sha !== res.sha) {
        drifted.push(url);
        driftedUrls++;
        entry[url] = { sha: res.sha, at: todayIso() };
      }
    }

    index[slug] = entry;

    if (drifted.length === 0) continue;
    if (FIRST_RUN) continue; // Baseline pass - just record, don't bump.

    bumped++;
    report.push(`## ${slug}`);
    for (const u of drifted) report.push(`  - drift: ${u}`);

    if (APPLY) {
      const today = todayIso();
      const newFrontmatter = { ...data, updatedDate: new Date(today) };
      const noteLines = [
        "",
        "## Updates",
        "",
        `- ${today}: upstream sources changed. Links re-verified:`,
        ...drifted.map((u) => `  - ${u}`),
        "",
      ];
      const newBody = content.replace(/\s*$/, "") + "\n" + noteLines.join("\n");
      const rebuilt = matter.stringify(newBody, newFrontmatter);
      await fs.writeFile(file, rebuilt, "utf8");
    }
  }

  report.push("");
  report.push(
    `scanned=${scanned} posts, checked=${checkedUrls} URLs, drifted=${driftedUrls} URLs, bumped=${bumped} posts`,
  );
  process.stdout.write(report.join("\n") + "\n");

  if (APPLY || FIRST_RUN) await saveIndex(index);
  else
    process.stdout.write(
      "\nDry run - no files modified. Re-run with --apply after reviewing the diff.\n",
    );
}

main().catch((err) => {
  console.error("[freshness-pass] failed:", err);
  process.exit(1);
});
