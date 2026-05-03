#!/usr/bin/env node
// Push URLs of changed/added blog and pillar pages to IndexNow on every deploy.
// Bing, Yandex, Seznam, Naver consume this; Google does not.
//
// Change set comes from `git diff --name-only HEAD~1 HEAD` over the content
// dirs. Renamed files surface as the new path (good — pings the new URL); old
// paths drop out (the 410 happens on the next crawl).
//
// Wired into .github/workflows/deploy-pages.yml. INDEXNOW_KEY must match
// site/public/<key>.txt — IndexNow validates ownership by fetching that file
// over HTTPS, so the key in the env, the key in the file name, and the file
// contents must all be the same string.

import { execSync } from "node:child_process";
import path from "node:path";
import url from "node:url";
import { entryFromFile } from "../src/lib/content-paths.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SITE_DIR = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(SITE_DIR, "src", "content");
const BLOG_DIR = path.join(CONTENT_DIR, "blog");
const PILLAR_DIR = path.join(CONTENT_DIR, "pillars");

const HOST = "startdebugging.net";
const ORIGIN = `https://${HOST}`;
const ENDPOINT = "https://api.indexnow.org/indexnow";

const key = process.env.INDEXNOW_KEY;
if (!key) {
  console.log("[indexnow] INDEXNOW_KEY not set; skipping.");
  process.exit(0);
}

const RANGE = process.env.INDEXNOW_RANGE ?? "HEAD~1..HEAD";

let changed;
try {
  changed = execSync(
    `git diff --name-only ${RANGE} -- site/src/content/blog site/src/content/pillars`,
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
} catch (err) {
  console.log(`[indexnow] git diff failed (${err.message}); skipping.`);
  process.exit(0);
}

if (changed.length === 0) {
  console.log("[indexnow] No content changes in range; nothing to ping.");
  process.exit(0);
}

const urls = new Set();
for (const rel of changed) {
  const abs = path.join(REPO_ROOT, rel);
  const entry = entryFromFile(abs, BLOG_DIR, PILLAR_DIR);
  if (!entry) continue; // file deleted, outside trees, or unreadable
  if (entry.draft) continue;
  urls.add(`${ORIGIN}${entry.urlPath}`);
}

if (urls.size === 0) {
  console.log("[indexnow] Changed files yielded no publishable URLs; nothing to ping.");
  process.exit(0);
}

const urlList = [...urls].sort();
console.log(`[indexnow] Submitting ${urlList.length} URL(s):`);
for (const u of urlList) console.log(`  ${u}`);

const body = {
  host: HOST,
  key,
  keyLocation: `${ORIGIN}/${key}.txt`,
  urlList,
};

let res;
try {
  res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
} catch (err) {
  console.log(`[indexnow] Network error: ${err.message}`);
  process.exit(0);
}

const text = await res.text().catch(() => "");
if (res.status === 200 || res.status === 202) {
  console.log(`[indexnow] OK ${res.status}: ${text || "(empty body)"}`);
  process.exit(0);
}

// 422 = key file not reachable / mismatch. Surface loudly so a misconfigured
// secret doesn't silently fail every deploy.
console.log(`[indexnow] FAIL ${res.status}: ${text || "(empty body)"}`);
process.exit(0);
