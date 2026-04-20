#!/usr/bin/env node
/**
 * weekly-digest.mjs
 *
 * Build a short weekly digest from the last N days of blog posts and (with
 * --apply) send it via Buttondown as a draft or scheduled email.
 *
 * The digest is deliberately boring: 5 posts max, title + one sentence each
 * (drawn from the post's description front-matter, not a generated summary),
 * one link per post with UTM tags. If there are fewer than --min-posts new
 * posts in the window, the script aborts without sending - slow weeks don't
 * get a filler email.
 *
 * Usage:
 *   node scripts/weekly-digest.mjs                      # dry-run, print markdown
 *   node scripts/weekly-digest.mjs --apply              # create Buttondown draft
 *   node scripts/weekly-digest.mjs --apply --send       # create AND send
 *   node scripts/weekly-digest.mjs --days=14 --limit=8  # tune window/size
 *   node scripts/weekly-digest.mjs --min-posts=2        # skip-week threshold
 *
 * Env vars:
 *   BUTTONDOWN_API_KEY   required for --apply
 *
 * Flags:
 *   --apply      actually hit the Buttondown API (default: dry-run)
 *   --send       send immediately; omit to leave as a draft for review
 *   --days=N     lookback window (default 7)
 *   --limit=N    max posts in digest (default 5)
 *   --min-posts  abort if fewer than this many posts found (default 3)
 *   --verbose    extra logging
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");
const CONTENT_ROOT = path.join(SITE_ROOT, "src", "content", "blog");
const LOG_PATH = path.join(REPO_ROOT, "content-strategy", "weekly-digest-log.json");
const SITE_URL = "https://startdebugging.net";

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (flag) => args.some((a) => a === flag);
const flagValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};

const APPLY = has("--apply");
const SEND = has("--send");
const VERBOSE = has("--verbose");
const DAYS = Number(flagValue("days") ?? 7);
const LIMIT = Number(flagValue("limit") ?? 5);
const MIN_POSTS = Number(flagValue("min-posts") ?? 3);

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
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "weekly-digest",
  });
  return `${SITE_URL}/${slug}/?${qs.toString()}`;
}

function weekId(d = new Date()) {
  // ISO week key YYYY-Www so we can key logs + Buttondown subjects.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// Escape characters that break markdown link rendering.
function mdEscape(s) {
  return String(s).replace(/[\[\]]/g, (c) => `\\${c}`);
}

async function collectRecent() {
  const files = await walk(CONTENT_ROOT);
  const now = Date.now();
  const cutoff = now - DAYS * 86_400_000;
  const rows = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const { data } = matter(raw);
    if (data.draft) continue;
    if (!data.pubDate) continue;
    const t = new Date(data.pubDate).valueOf();
    if (t < cutoff || t > now) continue;
    rows.push({
      slug: slugFromFile(file),
      title: data.title,
      description: data.description ?? "",
      pubDate: data.pubDate,
      tags: data.tags ?? [],
    });
  }
  rows.sort((a, b) => new Date(b.pubDate).valueOf() - new Date(a.pubDate).valueOf());
  return rows;
}

function renderMarkdown(posts, { subject, intro }) {
  const lines = [];
  lines.push(`# ${subject}`);
  lines.push("");
  lines.push(intro);
  lines.push("");
  for (const p of posts) {
    lines.push(`### [${mdEscape(p.title)}](${utmUrl(p.slug)})`);
    if (p.description) lines.push(p.description);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    `If a friend forwarded this to you, you can [subscribe on the site](${SITE_URL}/subscribe/?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-digest).`,
  );
  lines.push("");
  lines.push(
    `Prefer RSS? Grab the [feed](${SITE_URL}/rss.xml). You can [unsubscribe](#) any time from the email footer.`,
  );
  return lines.join("\n") + "\n";
}

function renderPlainText(posts, { subject, intro }) {
  const lines = [];
  lines.push(subject);
  lines.push("=".repeat(subject.length));
  lines.push("");
  lines.push(intro);
  lines.push("");
  for (const p of posts) {
    lines.push(`* ${p.title}`);
    lines.push(`  ${utmUrl(p.slug)}`);
    if (p.description) lines.push(`  ${p.description}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    `Subscribe on the site: ${SITE_URL}/subscribe/?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-digest`,
  );
  return lines.join("\n") + "\n";
}

// --- Buttondown ----------------------------------------------------------

async function buttondownCreate({ subject, body, plaintext, send }) {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) throw new Error("BUTTONDOWN_API_KEY is not set");

  const res = await fetch("https://api.buttondown.com/v1/emails", {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject,
      body,
      // Buttondown renders `body` as markdown by default; plaintext is
      // optional but improves deliverability/accessibility.
      email_type: "public",
      status: send ? "about_to_send" : "draft",
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Buttondown ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json();
}

// --- Main ----------------------------------------------------------------

async function main() {
  const wk = weekId();
  const posts = (await collectRecent()).slice(0, LIMIT);

  console.log(`[weekly-digest] week=${wk} window=${DAYS}d candidates=${posts.length} limit=${LIMIT}`);

  if (posts.length < MIN_POSTS) {
    console.log(
      `[weekly-digest] only ${posts.length} posts in the last ${DAYS} days (< min-posts=${MIN_POSTS}). ` +
        "Skipping this week - no filler sends.",
    );
    return;
  }

  const log = await loadLog();
  if (log[wk] && APPLY) {
    console.log(`[weekly-digest] already sent/drafted for ${wk} at ${log[wk].at}. Use --force (not implemented) to override.`);
    return;
  }

  const subject = `Start Debugging weekly - ${wk}`;
  const intro =
    "The best new posts on Start Debugging this week. Pick the one that solves something you're stuck on; skip the rest.";

  const body = renderMarkdown(posts, { subject, intro });
  const plaintext = renderPlainText(posts, { subject, intro });

  if (VERBOSE || !APPLY) {
    console.log("\n--- Digest preview ---\n");
    console.log(body);
  }

  if (!APPLY) {
    console.log("\nDry run - nothing sent. Re-run with --apply (draft) or --apply --send (deliver).");
    return;
  }

  const res = await buttondownCreate({ subject, body, plaintext, send: SEND });
  console.log(
    `[weekly-digest] Buttondown ${SEND ? "queued for send" : "saved as draft"}: id=${res.id} subject="${res.subject}"`,
  );
  log[wk] = {
    at: new Date().toISOString(),
    id: res.id,
    sent: !!SEND,
    slugs: posts.map((p) => p.slug),
  };
  await saveLog(log);
}

main().catch((err) => {
  console.error("[weekly-digest] failed:", err);
  process.exit(1);
});
