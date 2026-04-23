#!/usr/bin/env node
// External link rot checker.
//
// Scans every markdown file under site/src/content/blog/ for Markdown links of
// the form [text](http://...) or [text](https://...), deduplicates by URL, and
// HEAD-checks each with a timeout. Writes broken links (non-2xx, timeouts, or
// connection errors) to content-strategy/link-rot-report.json.
//
// Does NOT modify any post. Broken-link removal is context-sensitive (some 404s
// are temporary, some URLs moved, some are false positives from anti-bot
// measures) and belongs in human review.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const BLOG_DIR = path.join(ROOT, "site", "src", "content", "blog");
const OUTPUT = path.join(ROOT, "content-strategy", "link-rot-report.json");

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 10;
const USER_AGENT =
  "Mozilla/5.0 (compatible; StartDebuggingLinkCheck/1.0; +https://startdebugging.net/)";

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

async function extractLinks(file) {
  const body = await fs.readFile(file, "utf8");
  const links = [];
  let m;
  while ((m = LINK_RE.exec(body)) !== null) {
    links.push({
      text: m[1],
      url: m[2],
      source: path.relative(ROOT, file).replaceAll("\\", "/"),
    });
  }
  return links;
}

async function checkUrl(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const opts = {
    redirect: "follow",
    signal: ctrl.signal,
    headers: { "user-agent": USER_AGENT },
  };
  try {
    let res = await fetch(u, { ...opts, method: "HEAD" });
    if (!res.ok && (res.status === 405 || res.status === 403)) {
      res = await fetch(u, { ...opts, method: "GET" });
    }
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return {
      status: null,
      ok: false,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

const files = await walk(BLOG_DIR);
console.log(`[link-rot] Scanning ${files.length} blog files`);

const allLinks = [];
for (const file of files) {
  allLinks.push(...(await extractLinks(file)));
}

const byUrl = new Map();
for (const link of allLinks) {
  if (!byUrl.has(link.url)) byUrl.set(link.url, []);
  byUrl.get(link.url).push(link.source);
}

console.log(
  `[link-rot] Checking ${byUrl.size} unique URLs (from ${allLinks.length} total links)`,
);

const urls = [...byUrl.keys()];
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < urls.length) {
    const idx = cursor++;
    const u = urls[idx];
    const r = await checkUrl(u);
    if (!r.ok) {
      results.push({ url: u, ...r, sources: byUrl.get(u) });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

results.sort((a, b) => a.url.localeCompare(b.url));

await fs.writeFile(OUTPUT, JSON.stringify(results, null, 2) + "\n");
console.log(
  `[link-rot] ${results.length} broken links written to ${path.relative(ROOT, OUTPUT)}`,
);
