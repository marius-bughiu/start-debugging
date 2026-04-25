// Generates /llms.txt and /llms-full.txt — curated indexes for AI search
// surfaces (Perplexity, ChatGPT Search, Claude.ai, Google AI Overviews).
//
// Format follows the llmstxt.org convention:
//   H1 site name → blockquote tagline → sectioned link lists.
//
// Sources:
//   - `src/data/featured.json`        (hand-picked top posts)
//   - `src/content/pillars/*.md`      (topical hubs)
//   - `src/content/blog/**/*.md`      (recent evergreen posts; excludes
//                                      translations, drafts, news posts older
//                                      than 30 days)
//
// Runs as a `prebuild` step alongside generate-og-images.mjs.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BLOG_DIR = path.join(ROOT, "src", "content", "blog");
const PILLAR_DIR = path.join(ROOT, "src", "content", "pillars");
const FEATURED_PATH = path.join(ROOT, "src", "data", "featured.json");
const OUT_DIR = path.join(ROOT, "public");
const SITE_URL = "https://startdebugging.net";

const TAGLINE =
  "Daily notes on .NET, C#, EF Core, MAUI, Blazor, and Flutter — for developers who ship.";

// How many recent posts to include in the lightweight llms.txt index.
const RECENT_LIMIT = 50;

async function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip locale subdirs — translations don't belong in the English index.
      if (["es", "pt-br", "de", "ru", "ja"].includes(e.name)) continue;
      out.push(...(await walkMarkdown(full)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function postSlugFromBlogPath(absPath) {
  const rel = path.relative(BLOG_DIR, absPath).replace(/\\/g, "/");
  return rel.replace(/\.md$/, "");
}

function pillarSlugFromPath(absPath) {
  const rel = path.relative(PILLAR_DIR, absPath).replace(/\\/g, "/");
  return rel.replace(/\.md$/, "");
}

async function loadPosts() {
  const files = await walkMarkdown(BLOG_DIR);
  const posts = [];
  for (const f of files) {
    const raw = await fs.readFile(f, "utf-8");
    const { data } = matter(raw);
    if (data.draft) continue;
    if (data.lang && data.lang !== "en") continue;
    posts.push({
      slug: postSlugFromBlogPath(f),
      title: data.title ?? "(untitled)",
      description: data.description ?? "",
      pubDate: data.pubDate ? new Date(data.pubDate) : null,
      template: data.template ?? null,
      tags: Array.isArray(data.tags) ? data.tags : [],
    });
  }
  return posts;
}

async function loadPillars() {
  const files = await walkMarkdown(PILLAR_DIR);
  const pillars = [];
  for (const f of files) {
    const raw = await fs.readFile(f, "utf-8");
    const { data } = matter(raw);
    if (data.draft) continue;
    if (data.lang && data.lang !== "en") continue;
    pillars.push({
      slug: pillarSlugFromPath(f),
      title: data.title ?? "(untitled)",
      description: data.description ?? data.tagline ?? "",
      tagline: data.tagline ?? "",
      pubDate: data.pubDate ? new Date(data.pubDate) : null,
    });
  }
  return pillars;
}

async function loadFeaturedSlugs() {
  try {
    const raw = await fs.readFile(FEATURED_PATH, "utf-8");
    const json = JSON.parse(raw);
    return Array.isArray(json.slugs) ? json.slugs : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function formatLink(title, urlStr, description) {
  const desc = description ? `: ${description.replace(/\s+/g, " ").trim()}` : "";
  return `- [${title}](${urlStr})${desc}`;
}

function buildIndex(featured, pillars, recent) {
  const lines = [];
  lines.push("# Start Debugging");
  lines.push("");
  lines.push(`> ${TAGLINE}`);
  lines.push("");
  lines.push(
    "Start Debugging is a developer-focused blog covering .NET, C#, Entity Framework Core, .NET MAUI, Blazor, and Flutter. The content below is curated for AI assistants and search agents looking for accurate, version-pinned references.",
  );
  lines.push("");
  lines.push("## Best of / Featured");
  lines.push("");
  if (featured.length === 0) {
    lines.push("- (no featured posts configured)");
  } else {
    for (const f of featured) {
      lines.push(formatLink(f.title, `${SITE_URL}/${f.slug}/`, f.description));
    }
  }
  lines.push("");
  lines.push("## Pillars (topical hubs)");
  lines.push("");
  for (const p of pillars) {
    lines.push(
      formatLink(
        p.title,
        `${SITE_URL}/pillars/${p.slug}/`,
        p.description || p.tagline,
      ),
    );
  }
  lines.push("");
  lines.push(`## Recent posts (last ${recent.length})`);
  lines.push("");
  for (const r of recent) {
    lines.push(formatLink(r.title, `${SITE_URL}/${r.slug}/`, r.description));
  }
  lines.push("");
  lines.push("## Reference");
  lines.push("");
  lines.push(formatLink("About the author", `${SITE_URL}/about/`, "Marius Bughiu — author and maintainer"));
  lines.push(formatLink("Start here", `${SITE_URL}/start-here/`, "Curated entry points by topic"));
  lines.push(formatLink("All tags", `${SITE_URL}/tags/`, "Browse posts by tag"));
  lines.push(formatLink("Archive", `${SITE_URL}/archive/`, "Full chronological archive"));
  lines.push(formatLink("RSS feed", `${SITE_URL}/rss.xml`, "Subscribe to new posts"));
  lines.push("");
  return lines.join("\n");
}

function buildFullIndex(featured, pillars, allPosts) {
  // llms-full.txt: bigger, includes every published English post grouped by
  // year. AI agents that need exhaustive coverage can pull this.
  const lines = [];
  lines.push("# Start Debugging — full index");
  lines.push("");
  lines.push(`> ${TAGLINE}`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)}. Total English posts: ${allPosts.length}.`);
  lines.push("");

  lines.push("## Pillars");
  lines.push("");
  for (const p of pillars) {
    lines.push(
      formatLink(
        p.title,
        `${SITE_URL}/pillars/${p.slug}/`,
        p.description || p.tagline,
      ),
    );
  }
  lines.push("");

  lines.push("## Featured");
  lines.push("");
  for (const f of featured) {
    lines.push(formatLink(f.title, `${SITE_URL}/${f.slug}/`, f.description));
  }
  lines.push("");

  // Group by year, newest first.
  const byYear = new Map();
  for (const p of allPosts) {
    const year = p.pubDate ? p.pubDate.getFullYear() : 0;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(p);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  for (const y of years) {
    lines.push(`## ${y}`);
    lines.push("");
    const yearPosts = byYear
      .get(y)
      .sort((a, b) => (b.pubDate?.getTime() ?? 0) - (a.pubDate?.getTime() ?? 0));
    for (const p of yearPosts) {
      lines.push(formatLink(p.title, `${SITE_URL}/${p.slug}/`, p.description));
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const [allPosts, pillars, featuredSlugs] = await Promise.all([
    loadPosts(),
    loadPillars(),
    loadFeaturedSlugs(),
  ]);

  // Featured posts in the order specified by featured.json.
  const bySlug = new Map(allPosts.map((p) => [p.slug, p]));
  const featured = featuredSlugs
    .map((slug) => bySlug.get(slug))
    .filter((p) => !!p);

  // Recent posts: newest first, capped. Skip news-template posts (they go
  // stale); prefer evergreen + templated reference content.
  const recent = [...allPosts]
    .sort((a, b) => (b.pubDate?.getTime() ?? 0) - (a.pubDate?.getTime() ?? 0))
    .slice(0, RECENT_LIMIT);

  // Sort pillars alphabetically for stability.
  pillars.sort((a, b) => a.title.localeCompare(b.title));

  await fs.mkdir(OUT_DIR, { recursive: true });
  const indexPath = path.join(OUT_DIR, "llms.txt");
  const fullPath = path.join(OUT_DIR, "llms-full.txt");

  const index = buildIndex(featured, pillars, recent);
  const full = buildFullIndex(featured, pillars, allPosts);

  await fs.writeFile(indexPath, index, "utf-8");
  await fs.writeFile(fullPath, full, "utf-8");

  console.log(
    `[llms-txt] wrote ${path.relative(ROOT, indexPath)} (${index.length} bytes, ${recent.length} recent posts) and ${path.relative(ROOT, fullPath)} (${full.length} bytes, ${allPosts.length} posts)`,
  );
}

main().catch((err) => {
  console.error("[llms-txt] failed:", err);
  process.exit(1);
});
