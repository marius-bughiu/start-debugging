#!/usr/bin/env node
/**
 * social-post.mjs
 *
 * Post a new blog entry to Bluesky and Mastodon. Reads API
 * credentials exclusively from env vars: any platform whose env vars are
 * missing is skipped silently. Dry-run by default; add --apply to actually
 * hit the network.
 *
 * Post copy is NOT the article title. It comes from per-platform task files
 * at `tasks/bluesky.json` and `tasks/mastodon.json` (each an
 * array of `{ slug, text }`). The article author (LLM or human) writes an
 * eye-catching summary into each file; this script consumes the first task
 * matching the current slug and removes it on successful post. If no task
 * exists for a slug, the platform is skipped silently - no fallback to
 * title.
 *
 * Usage:
 *   node scripts/social-post.mjs                              # latest post, dry-run
 *   node scripts/social-post.mjs --file=src/content/blog/...  # explicit post
 *   node scripts/social-post.mjs --apply                      # send for real
 *   node scripts/social-post.mjs --platforms=bluesky          # limit targets
 *
 * Env vars:
 *   BLUESKY_HANDLE, BLUESKY_APP_PASSWORD
 *   MASTODON_INSTANCE (e.g. https://mastodon.social), MASTODON_ACCESS_TOKEN
 *
 * Idempotency comes from the task file itself: a successful post splices its
 * task entry out of `tasks/<channel>.json`, so re-running for the same slug
 * is a no-op (the task is gone, nothing to post). No separate log is kept.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import matter from "gray-matter";
import { buildUtmUrl } from "./lib/utm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");
const CONTENT_ROOT = path.join(SITE_ROOT, "src", "content", "blog");
const TASKS_ROOT = path.join(REPO_ROOT, "tasks");
const SITE_URL = "https://startdebugging.net";

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (flag) => args.some((a) => a === flag);
const flagValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};

const APPLY = has("--apply");
const FILE_ARG = flagValue("file");
const PLATFORM_FILTER = (flagValue("platforms") ?? "bluesky,mastodon")
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
  // Fall back to the most recent blog file by git history.
  try {
    const raw = execSync(
      "git log --name-only --pretty=format: -- 'site/src/content/blog/**/*.md' | head -20",
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const seen = new Set();
    for (const line of raw.split("\n")) {
      const p = line.trim();
      if (!p) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      const full = path.resolve(REPO_ROOT, p);
      try {
        await fs.access(full);
        return full;
      } catch {
        // file was renamed or deleted - keep looking
      }
    }
  } catch {
    // git not available - fall through to filesystem walk
  }
  // Last resort: newest mtime under CONTENT_ROOT.
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

function tasksFileFor(platform) {
  return path.join(TASKS_ROOT, `${platform}.json`);
}

async function loadTasks(platform) {
  try {
    const raw = await fs.readFile(tasksFileFor(platform), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`tasks/${platform}.json must contain a JSON array`);
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function saveTasks(platform, arr) {
  await fs.mkdir(TASKS_ROOT, { recursive: true });
  await fs.writeFile(
    tasksFileFor(platform),
    JSON.stringify(arr, null, 2) + "\n",
    "utf8",
  );
}

function slugFromFile(file) {
  // site/src/content/blog/YYYY/MM/<slug>.md -> YYYY/MM/<slug>
  const rel = path.relative(CONTENT_ROOT, file).replace(/\\/g, "/");
  return rel.replace(/\.md$/, "");
}

function buildUrl(slug, source) {
  return buildUtmUrl(slug, { source, medium: "social", campaign: "auto" });
}

// Bluesky has a tight limit. Truncate the title so the final post still
// fits once the URL is appended. 300 (Bluesky) - 30 (URL + utm) - 2 = 268.
function composeText(title, url, { maxLen = 280 } = {}) {
  const suffix = `\n${url}`;
  const budget = maxLen - suffix.length;
  const titleTrimmed = title.length > budget ? title.slice(0, budget - 1).trimEnd() + "…" : title;
  return titleTrimmed + suffix;
}

// --- Platform: Bluesky (AT Protocol) --------------------------------------

async function postToBluesky({ summary, slug }) {
  const handle = process.env.BLUESKY_HANDLE;
  const appPassword = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !appPassword) {
    return { skipped: true, reason: "no BLUESKY_HANDLE / BLUESKY_APP_PASSWORD" };
  }

  const url = buildUrl(slug, "bluesky");
  const text = composeText(summary, url, { maxLen: 300 }); // Bluesky = 300 graphemes

  if (!APPLY) return { skipped: false, dryRun: true, text };

  // 1. Create session
  const sess = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!sess.ok) {
    const body = await sess.text().catch(() => "");
    throw new Error(`Bluesky auth ${sess.status}: ${body.slice(0, 300)}`);
  }
  const { accessJwt, did } = await sess.json();

  // 2. Build facets so the URL renders as a real link, not plain text.
  const byteStart = Buffer.byteLength(text.slice(0, text.indexOf(url)), "utf8");
  const byteEnd = byteStart + Buffer.byteLength(url, "utf8");
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    facets: [
      {
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
      },
    ],
  };

  const post = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });
  if (!post.ok) {
    const body = await post.text().catch(() => "");
    throw new Error(`Bluesky post ${post.status}: ${body.slice(0, 300)}`);
  }
  const data = await post.json();
  return { uri: data?.uri, text };
}

// --- Platform: Mastodon ---------------------------------------------------

async function postToMastodon({ summary, slug }) {
  const instance = process.env.MASTODON_INSTANCE;
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!instance || !token) {
    return { skipped: true, reason: "no MASTODON_INSTANCE / MASTODON_ACCESS_TOKEN" };
  }

  const url = buildUrl(slug, "mastodon");
  // Mastodon default = 500 chars; longer summaries are fine here.
  const text = composeText(summary, url, { maxLen: 500 });

  if (!APPLY) return { skipped: false, dryRun: true, text };

  const base = instance.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `startdebugging-${slug}`,
    },
    body: JSON.stringify({ status: text, visibility: "public" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mastodon ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return { id: data?.id, url: data?.url, text };
}

// --- Main -----------------------------------------------------------------

async function main() {
  const file = await resolvePostFile();
  const raw = await fs.readFile(file, "utf8");
  const { data } = matter(raw);
  if (data.draft) {
    console.log(`[social-post] ${file} is a draft - refusing to post.`);
    return;
  }
  if (!data.title) throw new Error(`Missing title in ${file}`);

  const slug = slugFromFile(file);
  let anyFailed = false;

  console.log(`[social-post] slug=${slug}`);
  console.log(`[social-post] title=${data.title}`);
  console.log(`[social-post] mode=${APPLY ? "APPLY" : "dry-run"}`);

  const platforms = [
    ["bluesky", postToBluesky],
    ["mastodon", postToMastodon],
  ].filter(([name]) => PLATFORM_FILTER.includes(name));

  for (const [name, fn] of platforms) {
    const tasks = await loadTasks(name);
    const taskIndex = tasks.findIndex((t) => t && t.slug === slug);

    // Strict: no task = no post. Absence of a task entry is also the
    // idempotency signal - successful posts splice their task out below,
    // so re-running for the same slug naturally skips.
    if (taskIndex === -1) {
      console.log(`  - ${name}: skipped (no task in tasks/${name}.json for slug ${slug})`);
      continue;
    }

    const summary = tasks[taskIndex].text;
    if (typeof summary !== "string" || !summary.trim()) {
      console.log(`  - ${name}: skipped (task entry has no text)`);
      continue;
    }

    try {
      const res = await fn({ summary, slug });
      if (res.skipped) {
        console.log(`  - ${name}: skipped (${res.reason})`);
        continue;
      }
      if (res.dryRun) {
        console.log(`  - ${name}: DRY-RUN would send:`);
        console.log(res.text.split("\n").map((l) => "      " + l).join("\n"));
        continue;
      }
      console.log(`  - ${name}: posted${res.id ? ` id=${res.id}` : res.uri ? ` uri=${res.uri}` : ""}`);

      if (APPLY) {
        tasks.splice(taskIndex, 1);
        await saveTasks(name, tasks);
      }
    } catch (err) {
      console.error(`  - ${name}: FAILED ${err.message}`);
      anyFailed = true;
    }
  }

  if (!APPLY) {
    console.log("\nDry run - no network calls made. Re-run with --apply.");
  }

  // Mark the process (and therefore the GitHub Actions step) as failed if
  // any platform errored. `fail-fast: false` on the matrix still lets the
  // sibling channels complete; we just want the failing one to go red.
  if (anyFailed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[social-post] failed:", err);
  process.exit(1);
});
