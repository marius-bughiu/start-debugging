#!/usr/bin/env node
/**
 * linkedin-mirror.mjs
 *
 * Mirror a published post to LinkedIn as a UGC / Post share. LinkedIn's
 * article (Publish) API is gated to Marketing Developer Platform partners,
 * so by default this script creates a "share" post (text + canonical link
 * preview), which is what actually reaches feeds anyway.
 *
 * Dry-run by default. `--apply` calls the API. No-op if env vars missing.
 *
 * Usage:
 *   node scripts/linkedin-mirror.mjs                      # latest, dry-run
 *   node scripts/linkedin-mirror.mjs --file=<path>
 *   node scripts/linkedin-mirror.mjs --apply
 *
 * Env vars:
 *   LINKEDIN_ACCESS_TOKEN   OAuth2 access token with `w_member_social` scope
 *   LINKEDIN_AUTHOR_URN     e.g. `urn:li:person:abc123` (get via /v2/me)
 *
 * Re-running for the same slug is a no-op unless --force is passed;
 * we record the post URN in `content-strategy/linkedin-mirror-log.json`.
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
const LOG_PATH = path.join(REPO_ROOT, "content-strategy", "linkedin-mirror-log.json");
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
const FILE_ARG = flagValue("file");

// --- Helpers --------------------------------------------------------------

async function walk(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && full.endsWith(".md")) out.push(full);
  }
  return out;
}

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

function utmUrl(slug) {
  const qs = new URLSearchParams({
    utm_source: "linkedin",
    utm_medium: "social",
    utm_campaign: "auto",
  });
  return `${SITE_URL}/${slug}/?${qs.toString()}`;
}

// Compose commentary text: title + 1-sentence description + link. LinkedIn
// cuts previews after ~210 chars, so be ruthless.
function composeCommentary(title, description, url) {
  const parts = [title];
  if (description) parts.push(description);
  parts.push("");
  parts.push("Full post (canonical):");
  parts.push(url);
  return parts.join("\n");
}

// --- LinkedIn API --------------------------------------------------------

async function postToLinkedIn({ title, description, slug }) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const authorUrn = process.env.LINKEDIN_AUTHOR_URN;
  if (!token || !authorUrn) {
    return { skipped: true, reason: "no LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_URN" };
  }

  const url = utmUrl(slug);
  const commentary = composeCommentary(title, description, url);

  const payload = {
    author: authorUrn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: commentary },
        shareMediaCategory: "ARTICLE",
        media: [
          {
            status: "READY",
            originalUrl: url,
            title: { text: title },
            description: description ? { text: description.slice(0, 250) } : undefined,
          },
        ],
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };

  if (!APPLY) return { skipped: false, dryRun: true, preview: { commentary, url } };

  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LinkedIn ${res.status}: ${txt.slice(0, 400)}`);
  }
  // LinkedIn returns the new post URN in a header; body is not guaranteed JSON.
  const urn = res.headers.get("x-restli-id") ?? null;
  return { urn };
}

// --- Main ----------------------------------------------------------------

async function main() {
  const file = await resolvePostFile();
  const raw = await fs.readFile(file, "utf8");
  const { data } = matter(raw);
  if (data.draft) {
    console.log(`[linkedin-mirror] ${file} is a draft - refusing to mirror.`);
    return;
  }
  if (!data.title) throw new Error(`Missing title in ${file}`);

  const slug = slugFromFile(file);
  const log = await loadLog();
  const entry = log[slug] ?? {};

  console.log(`[linkedin-mirror] slug=${slug}`);
  console.log(`[linkedin-mirror] title=${data.title}`);
  console.log(`[linkedin-mirror] mode=${APPLY ? "APPLY" : "dry-run"}`);

  if (entry.urn && !FORCE && APPLY) {
    console.log(`  - already mirrored at ${entry.at} (urn=${entry.urn}); skipping (use --force)`);
    return;
  }

  try {
    const res = await postToLinkedIn({ title: data.title, description: data.description, slug });
    if (res.skipped) {
      console.log(`  - skipped (${res.reason})`);
      return;
    }
    if (res.dryRun) {
      console.log(`  - DRY-RUN would post:`);
      console.log(res.preview.commentary.split("\n").map((l) => "      " + l).join("\n"));
      return;
    }
    console.log(`  - posted urn=${res.urn}`);
    log[slug] = { at: new Date().toISOString(), urn: res.urn };
    await saveLog(log);
  } catch (err) {
    console.error(`  - FAILED ${err.message}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[linkedin-mirror] failed:", err);
  process.exit(1);
});
