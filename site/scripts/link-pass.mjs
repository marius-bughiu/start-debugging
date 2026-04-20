#!/usr/bin/env node
/**
 * link-pass.mjs
 *
 * Internal-linking pass. Scans site/src/content/blog/ for posts, builds a
 * lightweight TF-IDF similarity index over title + tags + first paragraph,
 * and for each target post proposes up to N new internal links to older
 * topically-similar posts.
 *
 * Usage:
 *   node scripts/link-pass.mjs                 # dry run on all posts, writes diff to stdout
 *   node scripts/link-pass.mjs --apply         # actually rewrite post bodies
 *   node scripts/link-pass.mjs --backfill      # include posts older than 180 days
 *   node scripts/link-pass.mjs --limit=10      # only process the first N candidate posts
 *   node scripts/link-pass.mjs --max-links=2   # change per-post link cap (default 3)
 *   node scripts/link-pass.mjs --verbose
 *
 * Guardrails (roadmap task 2.1):
 *   - Max 3 new links per post per run.
 *   - Posts older than 180 days are skipped unless --backfill.
 *   - Never links a post to itself.
 *   - Skips anchor-text matches inside fenced code blocks, inline code, and
 *     existing markdown links.
 *   - Anchor text must appear verbatim in the target body (case-insensitive).
 *
 * This script is intentionally conservative. The first real-world run should
 * be reviewed as a diff before enabling the scheduled task
 * `start-debugging-link-pass` (weekly cron `0 3 * * 0`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const CONTENT_ROOT = path.join(SITE_ROOT, "src", "content", "blog");

// --- CLI flags -------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const flagValue = (name) => {
  const hit = [...args].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
};
const APPLY = args.has("--apply");
const BACKFILL = args.has("--backfill");
const VERBOSE = args.has("--verbose");
const MAX_LINKS = Number(flagValue("max-links") ?? 3);
const LIMIT = Number(flagValue("limit") ?? 0);
const MAX_AGE_DAYS = 180;

// --- Helpers ---------------------------------------------------------------

const STOP = new Set(
  "a an and are as at be but by for from has have if in into is it its of on or that the their then there they this to was were will with you your we our us do does did so not no non yes over under via when where what how why which while more most less least also can could should would may might must just like one two three new old"
    .split(/\s+/),
);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9\-+.#]*/g) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function firstParagraph(body) {
  const stripped = body.replace(/```[\s\S]*?```/g, " ").trim();
  const para = stripped.split(/\n\s*\n/)[0] ?? "";
  return para.slice(0, 1200);
}

function termFreq(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function computeIdf(docs) {
  const N = docs.length;
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map();
  for (const [t, f] of df) idf.set(t, Math.log(1 + N / (1 + f)));
  return idf;
}

function tfidfVector(tokens, idf) {
  const tf = termFreq(tokens);
  const vec = new Map();
  for (const [t, f] of tf) vec.set(t, f * (idf.get(t) ?? 0));
  return vec;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  const small = a.size < b.size ? a : b;
  const large = a.size < b.size ? b : a;
  for (const [t, v] of small) {
    const u = large.get(t);
    if (u) dot += v * u;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- Corpus ---------------------------------------------------------------

async function walk(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && full.endsWith(".md")) out.push(full);
  }
  return out;
}

async function loadPosts() {
  const files = await walk(CONTENT_ROOT);
  const posts = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const { data, content } = matter(raw);
    if (data.draft) continue;
    const relFromBlog = path.relative(CONTENT_ROOT, file).replace(/\\/g, "/");
    // src/content/blog/YYYY/MM/slug.md → slug = YYYY/MM/slug
    const slug = relFromBlog.replace(/\.md$/, "");
    const textForIndex = [
      data.title ?? "",
      (data.tags ?? []).join(" "),
      firstParagraph(content),
    ].join(" ");
    posts.push({
      file,
      slug,
      title: data.title ?? "",
      tags: data.tags ?? [],
      pubDate: data.pubDate ? new Date(data.pubDate) : null,
      body: content,
      tokens: tokenize(textForIndex),
    });
  }
  return posts;
}

// --- Anchor detection -----------------------------------------------------

// Returns the canonical anchor phrase we'll look for in bodies. We prefer
// the full post title with a little noise stripped. Short titles are dropped
// to avoid false-positive matches on common phrases.
function anchorPhraseForPost(post) {
  let t = post.title || "";
  // Drop "Start Debugging" suffix, trailing parentheticals, colons/ellipses.
  t = t.replace(/\s*-\s*Start Debugging$/i, "");
  t = t.replace(/\s*\([^)]*\)\s*$/g, "");
  t = t.replace(/[:\u2014\u2013].*$/, ""); // strip after ":" or em/en dash
  t = t.replace(/\s+/g, " ").trim();
  if (t.length < 10) return null;
  return t;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split the body into segments marked as "code" (fenced or inline code, or
// inside an existing markdown link) vs "prose" we may rewrite.
function maskUnsafeSpans(body) {
  const mask = new Uint8Array(body.length);
  const re = /```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\([^)]*\)/g;
  let m;
  while ((m = re.exec(body))) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = 1;
  }
  return mask;
}

// Find the first safe (case-insensitive) occurrence of phrase in body that
// isn't inside code/existing-link spans. Returns the match index, or -1.
function findSafeOccurrence(body, mask, phrase) {
  const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
  let m;
  while ((m = re.exec(body))) {
    if (!mask[m.index]) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

// --- Main -----------------------------------------------------------------

async function main() {
  const posts = await loadPosts();
  if (VERBOSE) console.error(`[link-pass] loaded ${posts.length} posts`);

  const idf = computeIdf(posts);
  const byFile = new Map(posts.map((p) => [p.file, p]));
  const vectors = new Map(posts.map((p) => [p.file, tfidfVector(p.tokens, idf)]));

  const now = Date.now();
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  const candidates = posts.filter((p) => {
    if (!p.pubDate) return false;
    if (BACKFILL) return true;
    return now - p.pubDate.valueOf() <= maxAgeMs;
  });
  const pool = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;

  const proposals = []; // { target, body patches, diff text }
  let scannedCount = 0;

  for (const target of pool) {
    scannedCount++;
    const targetVec = vectors.get(target.file);
    const targetPub = target.pubDate?.valueOf() ?? 0;

    // Score every *older* post. "Older" = strictly earlier pubDate.
    const scored = [];
    for (const other of posts) {
      if (other.file === target.file) continue;
      const otherPub = other.pubDate?.valueOf() ?? 0;
      if (otherPub >= targetPub) continue;
      const sim = cosine(targetVec, vectors.get(other.file));
      if (sim > 0) scored.push({ post: other, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    const top = scored.slice(0, 5);

    if (top.length === 0) continue;

    // Greedily propose up to MAX_LINKS from the top similar posts.
    let body = target.body;
    const mask = maskUnsafeSpans(body);
    const patches = [];
    for (const { post: candidate, sim } of top) {
      if (patches.length >= MAX_LINKS) break;
      const phrase = anchorPhraseForPost(candidate);
      if (!phrase) continue;
      const hit = findSafeOccurrence(body, mask, phrase);
      if (!hit) continue;

      // Build the markdown link and mark the span as consumed so subsequent
      // candidates in this run can't double-link the same text.
      const href = `/${candidate.slug}/`;
      const original = body.slice(hit.start, hit.end);
      const replacement = `[${original}](${href})`;
      patches.push({
        start: hit.start,
        end: hit.end,
        original,
        replacement,
        sim,
        targetSlug: candidate.slug,
      });
      for (let i = hit.start; i < hit.end; i++) mask[i] = 1;
    }

    if (patches.length === 0) continue;

    // Apply patches in reverse order so indices stay valid.
    let newBody = body;
    const reverse = [...patches].sort((a, b) => b.start - a.start);
    for (const p of reverse) {
      newBody = newBody.slice(0, p.start) + p.replacement + newBody.slice(p.end);
    }

    proposals.push({ target, patches, oldBody: body, newBody });
  }

  // --- Report ------------------------------------------------------------
  const report = [];
  report.push(`# Internal-linking pass ${new Date().toISOString().slice(0, 10)}`);
  report.push(`- candidates scanned: ${scannedCount}`);
  report.push(`- posts with proposals: ${proposals.length}`);
  report.push(
    `- total link proposals: ${proposals.reduce((n, p) => n + p.patches.length, 0)}`,
  );
  report.push(
    `- mode: ${APPLY ? "APPLY" : "dry-run"}, backfill=${BACKFILL}, max-links=${MAX_LINKS}`,
  );
  report.push("");

  for (const proposal of proposals) {
    report.push(`## ${proposal.target.slug}`);
    for (const p of proposal.patches) {
      report.push(
        `- sim=${p.sim.toFixed(3)} → [${p.original}](/${p.targetSlug}/)`,
      );
    }
    report.push("");
  }

  process.stdout.write(report.join("\n") + "\n");

  if (APPLY) {
    for (const proposal of proposals) {
      const raw = await fs.readFile(proposal.target.file, "utf8");
      const parsed = matter(raw);
      const rebuilt = matter.stringify(proposal.newBody, parsed.data);
      await fs.writeFile(proposal.target.file, rebuilt, "utf8");
    }
    process.stdout.write(`\nApplied ${proposals.length} file(s).\n`);
  } else {
    process.stdout.write(
      "\nDry run - no files modified. Re-run with --apply once the proposed diff looks good.\n",
    );
  }
}

main().catch((err) => {
  console.error("[link-pass] failed:", err);
  process.exit(1);
});
