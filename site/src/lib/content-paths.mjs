// Shared helpers for mapping content source files to their public URL paths.
// Used by astro.config.mjs (sitemap lastmod) and scripts/indexnow-ping.mjs.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdown(full));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

// Resolve a content markdown file to its public URL path. Returns null when the
// file is outside the blog/pillar trees or can't be read.
export function entryFromFile(absFilePath, blogDir, pillarDir) {
  let kind, slug;
  if (
    absFilePath === blogDir ||
    absFilePath.startsWith(blogDir + path.sep)
  ) {
    kind = "blog";
    slug = path
      .relative(blogDir, absFilePath)
      .replace(/\\/g, "/")
      .replace(/\.md$/, "");
  } else if (
    absFilePath === pillarDir ||
    absFilePath.startsWith(pillarDir + path.sep)
  ) {
    kind = "pillar";
    slug = path
      .relative(pillarDir, absFilePath)
      .replace(/\\/g, "/")
      .replace(/\.md$/, "");
  } else {
    return null;
  }

  let raw;
  try {
    raw = fs.readFileSync(absFilePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const { data } = matter(raw);
  const lang = data.lang ?? "en";
  const prefix = `${lang}/`;
  const base = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
  let urlPath;
  if (kind === "blog") {
    urlPath = lang === "en" ? `/${base}/` : `/${lang}/${base}/`;
  } else {
    urlPath = lang === "en" ? `/pillars/${base}/` : `/${lang}/pillars/${base}/`;
  }
  return { urlPath, lang, kind, draft: !!data.draft, data };
}

// URL-path → lastmod ISO map, covering blog posts and pillar pages in every
// locale. Tag/archive pages stay without lastmod (no canonical "last changed"
// date).
export function buildLastmodMap(contentDir) {
  const map = new Map();
  const blogDir = path.join(contentDir, "blog");
  const pillarDir = path.join(contentDir, "pillars");
  for (const file of [...walkMarkdown(blogDir), ...walkMarkdown(pillarDir)]) {
    const entry = entryFromFile(file, blogDir, pillarDir);
    if (!entry || entry.draft) continue;
    const iso = toIso(
      entry.data.updatedDate ?? entry.data.translationDate ?? entry.data.pubDate,
    );
    if (!iso) continue;
    map.set(entry.urlPath, iso);
  }
  return map;
}
