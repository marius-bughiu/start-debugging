#!/usr/bin/env node
// Idempotently syncs content-strategy/translation-tasks.md with
// the set of English blog posts under site/src/content/blog/.
// Adds missing rows (status `-` per language) without touching existing
// status values. Run after merging new posts or at the top of a backfill
// run to ensure the queue is complete.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BLOG_ROOT = join(REPO_ROOT, "site", "src", "content", "blog");
const QUEUE_PATH = join(REPO_ROOT, "content-strategy", "translation-tasks.md");
const LOCALES = ["es", "pt-br", "de", "ru", "ja"];

function walkEnglishPosts(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip language-prefixed directories at the top level
      if (dir === BLOG_ROOT && LOCALES.includes(entry)) continue;
      walkEnglishPosts(full, out);
    } else if (entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function slugOf(absPath) {
  const rel = relative(BLOG_ROOT, absPath).split(sep).join("/");
  return rel.replace(/\.md$/, "");
}

function extractPubDate(md) {
  const m = md.match(/^pubDate:\s*(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : "0000-00-00";
}

function parseExistingQueue(text) {
  // Returns Map<slug, { pubDate, statuses: Record<locale, string> }>
  const byslug = new Map();
  const body = text.split(/<!-- queue:start -->/)[1]?.split(/<!-- queue:end -->/)[0] ?? "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((s) => s.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length !== 7) continue;
    const [slug, pubDate, es, ptbr, de, ru, ja] = cells;
    if (!/^\d{4}\/\d{2}\//.test(slug)) continue;
    byslug.set(slug, {
      pubDate,
      statuses: { es, "pt-br": ptbr, de, ru, ja },
    });
  }
  return byslug;
}

function main() {
  const paths = walkEnglishPosts(BLOG_ROOT).sort();
  const posts = paths.map((p) => {
    const md = readFileSync(p, "utf8");
    return { slug: slugOf(p), pubDate: extractPubDate(md) };
  });

  let original = "";
  try {
    original = readFileSync(QUEUE_PATH, "utf8");
  } catch {
    console.error(`[translation-queue-sync] ${QUEUE_PATH} not found. Create it first.`);
    process.exit(1);
  }
  if (!original.includes("<!-- queue:start -->") || !original.includes("<!-- queue:end -->")) {
    console.error("[translation-queue-sync] queue file missing <!-- queue:start --> / <!-- queue:end --> markers");
    process.exit(1);
  }

  const existing = parseExistingQueue(original);
  const merged = new Map(existing);
  let added = 0;
  for (const { slug, pubDate } of posts) {
    if (!merged.has(slug)) {
      merged.set(slug, {
        pubDate,
        statuses: { es: "-", "pt-br": "-", de: "-", ru: "-", ja: "-" },
      });
      added++;
    } else {
      // Keep existing statuses; refresh pubDate in case the post was backdated
      merged.get(slug).pubDate = pubDate;
    }
  }

  // Emit sorted newest-first by pubDate, tiebreaker by slug desc
  const rows = [...merged.entries()]
    .map(([slug, v]) => ({ slug, ...v }))
    .sort((a, b) => {
      if (b.pubDate !== a.pubDate) return b.pubDate.localeCompare(a.pubDate);
      return b.slug.localeCompare(a.slug);
    });

  const table = rows
    .map(
      (r) =>
        `| ${r.slug} | ${r.pubDate} | ${r.statuses.es} | ${r.statuses["pt-br"]} | ${r.statuses.de} | ${r.statuses.ru} | ${r.statuses.ja} |`,
    )
    .join("\n");

  const out = original.replace(
    /<!-- queue:start -->[\s\S]*?<!-- queue:end -->/,
    `<!-- queue:start -->\n${table}\n<!-- queue:end -->`,
  );

  writeFileSync(QUEUE_PATH, out, "utf8");
  console.log(
    `[translation-queue-sync] ${rows.length} rows total, ${added} added, 0 removed (never removes rows).`,
  );
}

main();
