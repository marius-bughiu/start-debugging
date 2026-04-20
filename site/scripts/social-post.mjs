#!/usr/bin/env node
/**
 * social-post.mjs
 *
 * Post a new blog entry to X (Twitter), Bluesky, and Mastodon. Reads API
 * credentials exclusively from env vars: any platform whose env vars are
 * missing is skipped silently. Dry-run by default; add --apply to actually
 * hit the network.
 *
 * Usage:
 *   node scripts/social-post.mjs                              # latest post, dry-run
 *   node scripts/social-post.mjs --file=src/content/blog/...  # explicit post
 *   node scripts/social-post.mjs --apply                      # send for real
 *   node scripts/social-post.mjs --platforms=x,bluesky        # limit targets
 *
 * Env vars:
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *     OAuth 1.0a user-context credentials generated in X's developer portal.
 *     The four-key flow is required for posting; app-only Bearer tokens
 *     cannot call POST /2/tweets.
 *   BLUESKY_HANDLE, BLUESKY_APP_PASSWORD
 *   MASTODON_INSTANCE (e.g. https://mastodon.social), MASTODON_ACCESS_TOKEN
 *
 * The script is idempotent-ish: it records "what I posted when" to
 * `content-strategy/social-post-log.json` so that re-running for the same
 * slug + platform is a no-op (unless --force is passed).
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");
const CONTENT_ROOT = path.join(SITE_ROOT, "src", "content", "blog");
// Per-platform log paths keep parallel GitHub Actions jobs from racing on
// a single shared file. Set SOCIAL_POST_LOG_PATH to redirect; default is
// the shared file for local / single-process use.
const LOG_PATH = process.env.SOCIAL_POST_LOG_PATH
  ? path.resolve(process.env.SOCIAL_POST_LOG_PATH)
  : path.join(REPO_ROOT, "content-strategy", "social-post-log.json");
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
const PLATFORM_FILTER = (flagValue("platforms") ?? "x,bluesky,mastodon")
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

async function loadLog() {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveLog(log) {
  await fs.writeFile(LOG_PATH, JSON.stringify(log, null, 2) + "\n", "utf8");
}

function slugFromFile(file) {
  // site/src/content/blog/YYYY/MM/<slug>.md -> YYYY/MM/<slug>
  const rel = path.relative(CONTENT_ROOT, file).replace(/\\/g, "/");
  return rel.replace(/\.md$/, "");
}

function buildUrl(slug, source) {
  const qs = new URLSearchParams({
    utm_source: source,
    utm_medium: "social",
    utm_campaign: "auto",
  });
  return `${SITE_URL}/${slug}/?${qs.toString()}`;
}

// X/Bluesky have tight limits. Truncate the title so the final post still
// fits once the URL is appended. 280 (X) - 30 (URL + utm) - 2 (spaces) = 248.
function composeText(title, url, { maxLen = 280 } = {}) {
  const suffix = `\n${url}`;
  const budget = maxLen - suffix.length;
  const titleTrimmed = title.length > budget ? title.slice(0, budget - 1).trimEnd() + "…" : title;
  return titleTrimmed + suffix;
}

// --- OAuth 1.0a signing (for X / Twitter v2 write endpoints) --------------
//
// Implemented inline so we don't pull in an extra dependency. Per RFC 5849
// section 3.4.1.3.1, a JSON request body is NOT part of the signature base
// string - only the HTTP method, normalized URL, query params, and oauth_*
// params are. That matches what X's v2 API expects for POST /2/tweets with
// an application/json body.

function percentEncodeStrict(str) {
  // RFC 3986 percent-encoding. encodeURIComponent is close but leaves
  // !*'() unencoded, which breaks the signature base string.
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncodeStrict(k)}=${percentEncodeStrict(oauthParams[k])}`)
    .join("&");
  const baseString = [
    method.toUpperCase(),
    percentEncodeStrict(url),
    percentEncodeStrict(paramString),
  ].join("&");
  const signingKey =
    percentEncodeStrict(consumerSecret) + "&" + percentEncodeStrict(tokenSecret);
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
  const signed = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(signed)
      .sort()
      .map((k) => `${percentEncodeStrict(k)}="${percentEncodeStrict(signed[k])}"`)
      .join(", ")
  );
}

// --- Platform: X (Twitter v2, OAuth 1.0a user context) -------------------

async function postToX({ title, slug }) {
  const consumerKey = process.env.X_API_KEY;
  const consumerSecret = process.env.X_API_SECRET;
  const token = process.env.X_ACCESS_TOKEN;
  const tokenSecret = process.env.X_ACCESS_SECRET;
  const missing = [];
  if (!consumerKey) missing.push("X_API_KEY");
  if (!consumerSecret) missing.push("X_API_SECRET");
  if (!token) missing.push("X_ACCESS_TOKEN");
  if (!tokenSecret) missing.push("X_ACCESS_SECRET");
  if (missing.length) return { skipped: true, reason: `no ${missing.join(" / ")}` };

  const url = buildUrl(slug, "x");
  const text = composeText(title, url, { maxLen: 280 });

  if (!APPLY) return { skipped: false, dryRun: true, text };

  const endpoint = "https://api.x.com/2/tweets";
  const authHeader = oauth1Header({
    method: "POST",
    url: endpoint,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`X API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return { id: data?.data?.id, text };
}

// --- Platform: Bluesky (AT Protocol) --------------------------------------

async function postToBluesky({ title, slug }) {
  const handle = process.env.BLUESKY_HANDLE;
  const appPassword = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !appPassword) {
    return { skipped: true, reason: "no BLUESKY_HANDLE / BLUESKY_APP_PASSWORD" };
  }

  const url = buildUrl(slug, "bluesky");
  const text = composeText(title, url, { maxLen: 300 }); // Bluesky = 300 graphemes

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

async function postToMastodon({ title, slug }) {
  const instance = process.env.MASTODON_INSTANCE;
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!instance || !token) {
    return { skipped: true, reason: "no MASTODON_INSTANCE / MASTODON_ACCESS_TOKEN" };
  }

  const url = buildUrl(slug, "mastodon");
  // Mastodon default = 500 chars; longer titles are fine here.
  const text = composeText(title, url, { maxLen: 500 });

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
  const log = await loadLog();
  const entry = log[slug] ?? {};
  const originalKeys = new Set(Object.keys(entry));
  let anyFailed = false;

  console.log(`[social-post] slug=${slug}`);
  console.log(`[social-post] title=${data.title}`);
  console.log(`[social-post] mode=${APPLY ? "APPLY" : "dry-run"}`);

  const platforms = [
    ["x", postToX],
    ["bluesky", postToBluesky],
    ["mastodon", postToMastodon],
  ].filter(([name]) => PLATFORM_FILTER.includes(name));

  for (const [name, fn] of platforms) {
    if (entry[name] && !FORCE && APPLY) {
      console.log(`  - ${name}: already posted at ${entry[name].at}, skipping (use --force)`);
      continue;
    }
    try {
      const res = await fn({ title: data.title, slug });
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
      entry[name] = { at: new Date().toISOString(), id: res.id ?? res.uri ?? null };
    } catch (err) {
      console.error(`  - ${name}: FAILED ${err.message}`);
      anyFailed = true;
    }
  }

  if (APPLY) {
    // Only persist if a platform actually succeeded. Writing an unchanged
    // (or empty) entry back would dirty the log and cause the distribute
    // workflow's aggregator job to commit a no-op.
    const hasNew = Object.keys(entry).some((k) => !originalKeys.has(k));
    if (hasNew) {
      log[slug] = entry;
      await saveLog(log);
    } else {
      console.log("\nNo successful posts this run - log not updated.");
    }
  } else {
    console.log("\nDry run - no network calls made, no log written. Re-run with --apply.");
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
