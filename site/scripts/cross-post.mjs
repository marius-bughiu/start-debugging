#!/usr/bin/env node
/**
 * cross-post.mjs
 *
 * Mirror a new blog post to dev.to and Hashnode. Both platforms respect a
 * `canonical_url` field, so the SEO value stays with startdebugging.net
 * while we pick up their distribution and follower graph.
 *
 * Dry-run by default. `--apply` actually publishes. Any platform whose
 * env vars are missing is skipped silently.
 *
 * Usage:
 *   node scripts/cross-post.mjs                                # latest post, dry run
 *   node scripts/cross-post.mjs --file=src/content/blog/...    # explicit
 *   node scripts/cross-post.mjs --apply
 *   node scripts/cross-post.mjs --platforms=devto
 *   node scripts/cross-post.mjs --draft                        # publish as draft
 *
 * Env vars:
 *   DEVTO_API_KEY
 *   HASHNODE_TOKEN
 *   HASHNODE_PUBLICATION_ID     (required for Hashnode posts)
 *
 * Re-running for the same slug is a no-op unless --force is passed; we
 * record the remote post id in `content-strategy/cross-post-log.json`.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");
const CONTENT_ROOT = path.join(SITE_ROOT, "src", "content", "blog");
// Per-platform log paths keep parallel GitHub Actions jobs from racing on
// a single shared file. Set CROSS_POST_LOG_PATH to redirect; default is
// the shared file for local / single-process use.
const LOG_PATH = process.env.CROSS_POST_LOG_PATH
  ? path.resolve(process.env.CROSS_POST_LOG_PATH)
  : path.join(REPO_ROOT, "content-strategy", "cross-post-log.json");
const SITE_URL = "https://startdebugging.net";

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (flag) => args.some((a) => a === flag);
const flagValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};

const APPLY = has("--apply");
const FORCE = has("--force");
const DRAFT = has("--draft");
const FILE_ARG = flagValue("file");
const PLATFORM_FILTER = (flagValue("platforms") ?? "devto,hashnode")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// --- Helpers --------------------------------------------------------------

async function resolvePostFile() {
  if (FILE_ARG) {
    const p = path.isAbsolute(FILE_ARG) ? FILE_ARG : path.resolve(process.cwd(), FILE_ARG);
    await fs.access(p);
    return p;
  }
  try {
    const raw = execSync(
      "git log --name-only --pretty=format: -- 'site/src/content/blog/**/*.md' | head -20",
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const seen = new Set();
    for (const line of raw.split("\n")) {
      const p = line.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      const full = path.resolve(REPO_ROOT, p);
      try {
        await fs.access(full);
        return full;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no git */
  }
  const files = await walk(CONTENT_ROOT);
  let best = null;
  let bestM = 0;
  for (const f of files) {
    const st = await fs.stat(f);
    if (st.mtimeMs > bestM) {
      best = f;
      bestM = st.mtimeMs;
    }
  }
  if (!best) throw new Error("No blog posts found under " + CONTENT_ROOT);
  return best;
}

async function walk(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && full.endsWith(".md")) out.push(full);
  }
  return out;
}

async function loadLog() {
  try {
    return JSON.parse(await fs.readFile(LOG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveLog(log) {
  await fs.writeFile(LOG_PATH, JSON.stringify(log, null, 2) + "\n", "utf8");
}

function slugFromFile(file) {
  return path.relative(CONTENT_ROOT, file).replace(/\\/g, "/").replace(/\.md$/, "");
}

function canonicalUrl(slug) {
  return `${SITE_URL}/${slug}/`;
}

// Strip our internal relative links so they resolve correctly on other
// platforms: `/2026/04/foo/` -> `https://startdebugging.net/2026/04/foo/`.
function rewriteInternalLinks(markdown) {
  return markdown.replace(
    /\]\((\/(?:\d{4}\/\d{2}\/[^)]+|tags\/[^)]+|archive\/[^)]*|start-here[^)]*|pillars\/[^)]+))\)/g,
    (_, p) => `](${SITE_URL}${p})`,
  );
}

// Append a short canonical footer. Some platforms strip <link rel="canonical">
// from user-submitted HTML, so an inline note is a belt-and-braces signal.
function appendCanonicalNote(markdown, slug) {
  const url = canonicalUrl(slug);
  return (
    markdown.trimEnd() +
    "\n\n---\n\n*This post was originally published on [Start Debugging](" +
    url +
    "). If you spot an issue, please let me know there — the canonical copy is kept up to date.*\n"
  );
}

// --- Platform: dev.to -----------------------------------------------------

async function postToDevto({ title, description, tags, body, slug }) {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) return { skipped: true, reason: "no DEVTO_API_KEY" };

  const canonical = canonicalUrl(slug);
  // dev.to allows up to 4 tags, alphanumeric only.
  const cleanTags = (tags ?? [])
    .map((t) => String(t).replace(/[^a-z0-9]/gi, "").toLowerCase())
    .filter(Boolean)
    .slice(0, 4);

  const article = {
    title,
    published: !DRAFT,
    body_markdown: body,
    tags: cleanTags,
    canonical_url: canonical,
    description: description ? description.slice(0, 250) : undefined,
  };

  if (!APPLY) return { skipped: false, dryRun: true, preview: { title, tags: cleanTags, canonical } };

  const res = await fetch("https://dev.to/api/articles", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ article }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`dev.to ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  return { id: data?.id, url: data?.url };
}

// --- Platform: Hashnode ---------------------------------------------------

async function postToHashnode({ title, description, tags, body, slug }) {
  const token = process.env.HASHNODE_TOKEN;
  const publicationId = process.env.HASHNODE_PUBLICATION_ID;
  if (!token || !publicationId) {
    return { skipped: true, reason: "no HASHNODE_TOKEN / HASHNODE_PUBLICATION_ID" };
  }

  const canonical = canonicalUrl(slug);

  // Hashnode uses GraphQL. Tags are objects with { slug, name }.
  const hashtags = (tags ?? [])
    .map((t) => {
      const s = String(t).replace(/[^a-z0-9-]/gi, "").toLowerCase();
      return s ? { slug: s, name: s } : null;
    })
    .filter(Boolean)
    .slice(0, 5);

  const input = {
    title,
    contentMarkdown: body,
    publicationId,
    tags: hashtags,
    originalArticleURL: canonical,
    subtitle: description ? description.slice(0, 250) : undefined,
    settings: DRAFT ? { scheduled: false } : undefined,
  };

  const mutation = DRAFT
    ? {
        query: `mutation CreateDraft($input: CreateDraftInput!) { createDraft(input: $input) { draft { id slug } } }`,
        variables: { input },
      }
    : {
        query: `mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { id slug url } } }`,
        variables: { input },
      };

  if (!APPLY) return { skipped: false, dryRun: true, preview: { title, tags: hashtags.map((h) => h.slug), canonical } };

  const res = await fetch("https://gql.hashnode.com/", {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(mutation),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Hashnode ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  if (data?.errors?.length) {
    throw new Error(`Hashnode GraphQL: ${JSON.stringify(data.errors).slice(0, 400)}`);
  }
  const node = data?.data?.publishPost?.post ?? data?.data?.createDraft?.draft;
  return { id: node?.id, url: node?.url ?? null };
}

// --- Main -----------------------------------------------------------------

async function main() {
  const file = await resolvePostFile();
  const raw = await fs.readFile(file, "utf8");
  const { data, content } = matter(raw);
  if (data.draft) {
    console.log(`[cross-post] ${file} is a draft - refusing to mirror.`);
    return;
  }
  if (!data.title) throw new Error(`Missing title in ${file}`);

  const slug = slugFromFile(file);
  const log = await loadLog();
  const entry = log[slug] ?? {};

  const rewritten = rewriteInternalLinks(content);
  const withNote = appendCanonicalNote(rewritten, slug);

  const payload = {
    title: data.title,
    description: data.description,
    tags: data.tags ?? [],
    body: withNote,
    slug,
  };

  console.log(`[cross-post] slug=${slug}`);
  console.log(`[cross-post] title=${data.title}`);
  console.log(`[cross-post] mode=${APPLY ? "APPLY" : "dry-run"} draft=${DRAFT}`);

  const platforms = [
    ["devto", postToDevto],
    ["hashnode", postToHashnode],
  ].filter(([name]) => PLATFORM_FILTER.includes(name));

  for (const [name, fn] of platforms) {
    if (entry[name] && !FORCE && APPLY) {
      console.log(`  - ${name}: already mirrored at ${entry[name].at}, skipping (use --force)`);
      continue;
    }
    try {
      const res = await fn(payload);
      if (res.skipped) {
        console.log(`  - ${name}: skipped (${res.reason})`);
        continue;
      }
      if (res.dryRun) {
        console.log(`  - ${name}: DRY-RUN would publish`);
        console.log(`      title:     ${res.preview.title}`);
        console.log(`      tags:      ${res.preview.tags.join(", ") || "(none)"}`);
        console.log(`      canonical: ${res.preview.canonical}`);
        continue;
      }
      console.log(`  - ${name}: published${res.url ? ` -> ${res.url}` : ""} id=${res.id}`);
      entry[name] = { at: new Date().toISOString(), id: res.id, url: res.url ?? null };
    } catch (err) {
      console.error(`  - ${name}: FAILED ${err.message}`);
    }
  }

  if (APPLY) {
    log[slug] = entry;
    await saveLog(log);
  } else {
    console.log("\nDry run - no network calls made, no log written. Re-run with --apply.");
  }
}

main().catch((err) => {
  console.error("[cross-post] failed:", err);
  process.exit(1);
});
