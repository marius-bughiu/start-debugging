#!/usr/bin/env node
// Build a handful of pages instead of the whole site (~10k pages, ~10 min).
//
//   npm run build:page -- 2026/10/my-post            English post + every translation on disk
//   npm run build:page -- de/2026/10/my-post         one locale only
//   npm run build:page -- src/content/blog/2026/10/my-post.md   exactly this file
//   npm run build:page -- pillars/dotnet-11-tracker  a pillar page
//
// This is the real `astro build` (frontmatter schema, markdown rendering, the
// post template) with the blog collection narrowed to the given posts (see
// BUILD_ONLY in src/content/config.ts). It writes to a throwaway directory
// under node_modules/.cache/build-page/, so it never touches dist/ or the
// shared content cache in node_modules/.astro that `astro dev` reuses.
// prebuild (OG images, llms.txt) and postbuild (Pagefind, sitemap sanity) are
// skipped; CI runs the full build on push.
//
// Hard fail (exit 1):
//   - the build throws or logs an error (schema, markdown, template)
//   - a selected page is missing from the output, or its file name, `slug:`
//     or `lang:` would publish it somewhere other than its file path
//   - a link in a built page points at a post or pillar that does not exist,
//     is a draft, is not committed (another lane's work in progress), is
//     spelled with the wrong letter case or locale prefix, or at a same-page
//     #anchor with no matching id. A link that was already broken on main is
//     listed as a warning instead: the full build never checked links.
//
// Built pages match production except where they list other posts (related
// and prev/next posts, a pillar's post index) and, for one-locale and .md
// targets, the hreflang alternates and language switcher, which list only the
// locales that were built.
//
// Pass --verbose for Astro's own per-page log.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { entryFromFile } from "../src/lib/content-paths.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SITE_DIR, "..");
const CONTENT_DIR = path.join(SITE_DIR, "src", "content");
const BLOG_DIR = path.join(CONTENT_DIR, "blog");
const PILLAR_DIR = path.join(CONTENT_DIR, "pillars");
const RUNS_DIR = path.join(SITE_DIR, "node_modules", ".cache", "build-page");
const SITE_ORIGIN = "https://startdebugging.net";
const DAY_MS = 24 * 60 * 60 * 1000;

const TRANSLATED_LOCALES = ["es", "pt-br", "de", "ru", "ja"];
const LOCALE_GROUP = `(?:(${TRANSLATED_LOCALES.join("|")})/)?`;
const POST_SLUG_RE = new RegExp(`^${LOCALE_GROUP}(\\d{4}/\\d{2}/[^/]+)$`);
const PILLAR_SLUG_RE = new RegExp(`^${LOCALE_GROUP}pillars/([^/]+)$`);
// Site paths shaped like a post or a pillar under any first segment, so a
// wrong or mis-cased locale prefix is reported instead of skipped.
const POST_PATH_RE = /^\/(?:([^/]+)\/)?(\d{4})\/(\d{2})\/([^/]+)\/?$/;
const PILLAR_PATH_RE = /^\/(?:([^/]+)\/)?(pillars)\/([^/]+)\/?$/i;
const LOCALE_LIKE_RE = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;
const ASSET_RE = /\.[a-z0-9]+$/i;
// Path segments that Astro's slugger leaves unchanged.
const URL_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Pages that are not part of the selection still build, against a blog
// collection that holds only the selected posts. These two warn about every
// curated slug they cannot find, which is all of them here.
const EXPECTED_WARNINGS = [/^\[start-here\] section /, /^\[homepage featured\] missing slug/];

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const targets = args.filter((a) => !a.startsWith("--"));
if (targets.length === 0) {
  console.error(
    "[build-page] Usage: npm run build:page -- <post slug | locale/slug | pillars/slug | path to .md> ...",
  );
  process.exit(1);
}

// Where the command was typed (npm runs scripts from site/). Then work from
// site/: Astro writes its server build to <cwd>/.astro/ and deletes it after
// the build whenever the output directory is outside the cwd.
const CALLER_DIR = process.env.INIT_CWD ?? process.cwd();
process.chdir(SITE_DIR);

const isInside = (dir, file) => file.startsWith(dir + path.sep);
const repoPath = (file) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// existsSync ignores letter case on macOS; the deployed site does not.
const listings = new Map();
function existsExactly(file) {
  let dir = CONTENT_DIR;
  for (const part of path.relative(CONTENT_DIR, file).split(path.sep)) {
    if (!listings.has(dir)) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {}
      listings.set(dir, new Set(names));
    }
    if (!listings.get(dir).has(part)) return false;
    dir = path.join(dir, part);
  }
  return true;
}

// A relative path typed from the repo root or from site/ both resolve.
function resolveFile(arg) {
  for (const base of [CALLER_DIR, SITE_DIR, REPO_ROOT]) {
    const file = path.resolve(base, arg);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function resolveTarget(arg) {
  if (arg.endsWith(".md")) {
    const file = resolveFile(arg);
    if (!file) throw new Error(`no such file: ${arg}`);
    if (!isInside(BLOG_DIR, file) && !isInside(PILLAR_DIR, file)) {
      throw new Error(`not a post or pillar under src/content/: ${arg}`);
    }
    if (!existsExactly(file)) throw new Error(`no such file (check the letter case): ${arg}`);
    return [file];
  }

  const slug = arg
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^(site\/)?src\/content\/(blog\/)?/, "");

  const pillar = slug.match(PILLAR_SLUG_RE);
  if (pillar) {
    const file = path.join(PILLAR_DIR, ...(pillar[1] ? [pillar[1]] : []), `${pillar[2]}.md`);
    if (!existsExactly(file)) throw new Error(`no such pillar: ${path.relative(SITE_DIR, file)}`);
    return [file];
  }

  const post = slug.match(POST_SLUG_RE);
  if (!post) throw new Error(`not a post slug (YYYY/MM/slug), pillar slug or .md path: ${arg}`);
  if (post[1]) {
    const file = path.join(BLOG_DIR, post[1], `${post[2]}.md`);
    if (!existsExactly(file)) throw new Error(`no such post: ${path.relative(SITE_DIR, file)}`);
    return [file];
  }
  const english = path.join(BLOG_DIR, `${post[2]}.md`);
  if (!existsExactly(english)) throw new Error(`no such post: ${path.relative(SITE_DIR, english)}`);
  const translations = TRANSLATED_LOCALES.map((l) => path.join(BLOG_DIR, l, `${post[2]}.md`)).filter(
    existsExactly,
  );
  return [english, ...translations];
}

let files;
try {
  files = [...new Set(targets.flatMap(resolveTarget))];
} catch (err) {
  console.error(`[build-page] ${err.message}`);
  process.exit(1);
}
const selectedFiles = new Set(files);
const selected = files.map((file) => ({ file, ...entryFromFile(file, BLOG_DIR, PILLAR_DIR) }));

// The site's own tooling (sitemap lastmod, OG images, IndexNow) takes a
// post's file path as its URL. Astro runs each segment through its slugger,
// honours a frontmatter `slug:`, and drops a post whose `lang` does not
// match its directory. Anything that makes the two disagree is a problem.
function fileNameProblem(file, entry) {
  const segments = path
    .relative(isInside(BLOG_DIR, file) ? BLOG_DIR : PILLAR_DIR, file)
    .replace(/\.md$/, "")
    .split(path.sep);
  const dirLocale = TRANSLATED_LOCALES.includes(segments[0]) ? segments[0] : "en";
  if (!segments.every((s) => URL_SEGMENT_RE.test(s))) {
    return "rename the file: only lowercase letters, digits, - and _ (not first) keep the URL equal to the path";
  }
  if (entry.data.slug !== undefined) return "remove the frontmatter `slug:`, which moves the page off its file path";
  if (entry.lang !== dirLocale) {
    return `lang is "${entry.lang}" but the file is under ${dirLocale === "en" ? "the English tree" : `${dirLocale}/`}`;
  }
  return null;
}

const nameProblems = selected.flatMap((s) => {
  const problem = s.draft ? null : fileNameProblem(s.file, s);
  return problem ? [`${path.relative(SITE_DIR, s.file)}: ${problem}`] : [];
});
if (nameProblems.length > 0) {
  console.error(`[build-page] ${nameProblems.length} problem(s):`);
  for (const p of nameProblems) console.error(`  ${p}`);
  process.exit(1);
}

// Literal file paths, escaped so a glob metacharacter in a name stays literal.
const escapeGlob = (p) => p.replace(/[*?[\]{}()!+@\\]/g, "\\$&");
const blogPatterns = files
  .filter((f) => isInside(BLOG_DIR, f))
  .map((f) => escapeGlob(path.relative(BLOG_DIR, f).split(path.sep).join("/")));

// Runs older than a day are leftovers; each run gets its own directory so two
// lanes can build at the same time.
fs.mkdirSync(RUNS_DIR, { recursive: true });
for (const name of fs.readdirSync(RUNS_DIR)) {
  const dir = path.join(RUNS_DIR, name);
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  if (!stat || Date.now() - stat.mtimeMs < DAY_MS) continue;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {} // another run is pruning it too
}
const runDir = path.join(RUNS_DIR, `${Date.now()}-${process.pid}`);
const outDir = path.join(runDir, "dist");
const emptyPublicDir = path.join(runDir, "public");
fs.mkdirSync(emptyPublicDir, { recursive: true });
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  process.once(signal, () => {
    fs.rmSync(runDir, { recursive: true, force: true });
    process.exit(code);
  });
}

// No pattern list matches nothing; a pillar-only run still needs a blog
// collection that loads zero posts rather than all of them.
process.env.BUILD_ONLY = JSON.stringify({
  blog: blogPatterns.length > 0 ? blogPatterns : ["__build-page-selects-no-posts__.md"],
});
process.env.VITE_CACHE_DIR = path.join(runDir, "vite");
// CI builds with the public Giscus settings from deploy-pages.yml; without
// them every page leaves out its comments section.
try {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "deploy-pages.yml"), "utf8");
  for (const [, name, value] of workflow.matchAll(/^\s+(PUBLIC_[A-Z0-9_]+):\s*(.+?)\s*$/gm)) {
    process.env[name] ??= value.replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {}

if (blogPatterns.length === 0) EXPECTED_WARNINGS.push(/^The collection "blog" does not exist or is empty/);
const warn = console.warn;
console.warn = (...parts) => {
  if (typeof parts[0] === "string" && EXPECTED_WARNINGS.some((re) => re.test(parts[0]))) return;
  warn(...parts);
};
// Some errors Astro only logs: a post whose markdown fails to render is
// stored without a body and the build carries on. Its logger writes
// error-level lines to stderr.
let errorsLogged = 0;
const stderrWrite = process.stderr.write;
process.stderr.write = function (chunk, ...rest) {
  if (String(chunk).includes("[ERROR]")) errorsLogged++;
  return stderrWrite.call(this, chunk, ...rest);
};

console.log(`[build-page] Building ${selected.length} page(s):`);
for (const s of selected) console.log(`  ${path.relative(SITE_DIR, s.file)}`);

const started = Date.now();
let failure;
try {
  const { build } = await import("astro");
  await build({
    root: SITE_DIR,
    outDir,
    cacheDir: path.join(runDir, "cache"),
    publicDir: emptyPublicDir,
    logLevel: verbose ? "info" : "warn",
  });
} catch (err) {
  failure = err;
} finally {
  console.warn = warn;
  process.stderr.write = stderrWrite;
  fs.rmSync(path.join(runDir, "cache"), { recursive: true, force: true });
  fs.rmSync(path.join(runDir, "vite"), { recursive: true, force: true });
}
if (failure) {
  console.error(`[build-page] Build failed: ${failure.stack ?? failure.message ?? failure}`);
  process.exit(1);
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);

function git(...gitArgs) {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...gitArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// What CI deploys: posts and pillars committed on HEAD or origin/main. Other
// lanes' unpushed posts sit in the same working tree, and a link to one would
// 404 until that lane pushes, or for good. null when git is not available.
const BASE_REF = git("rev-parse", "--verify", "--quiet", "origin/main^{commit}") ? "origin/main" : "HEAD";
let committed = null;
for (const ref of new Set(["HEAD", BASE_REF])) {
  const out = git("ls-tree", "-r", "-z", "--name-only", "--full-name", ref, "--", repoPath(BLOG_DIR), repoPath(PILLAR_DIR));
  if (out === null) continue;
  committed ??= new Set();
  for (const p of out.split("\0")) if (p) committed.add(p);
}

// The committed version of a page's source tells a link this change adds from
// one that was already broken.
const committedText = new Map();
function wasAlreadyThere(file, href) {
  if (!committedText.has(file)) committedText.set(file, git("show", `${BASE_REF}:${repoPath(file)}`));
  const text = committedText.get(file);
  return text !== null && (text.includes(href) || text.includes(safeDecode(href)));
}

// The site path a link points at, or null for other sites and non-http links.
function sitePath(href, pageUrl) {
  try {
    const target = new URL(href, SITE_ORIGIN + pageUrl);
    return target.origin === SITE_ORIGIN ? safeDecode(target.pathname) : null;
  } catch {
    return null;
  }
}

// Why a link to `target` (a site path) would 404: null when it resolves,
// undefined when it is not a post or pillar path (tags, archive, assets).
function linkProblem(target) {
  const post = target.match(POST_PATH_RE);
  const pillar = post ? null : target.match(PILLAR_PATH_RE);
  if (!post && !pillar) return undefined;
  const locale = post ? post[1] : pillar[1];
  if ((locale && !LOCALE_LIKE_RE.test(locale)) || ASSET_RE.test(post ? post[4] : pillar[3])) return undefined;
  if (locale && !TRANSLATED_LOCALES.includes(locale)) {
    return `unknown locale prefix "${locale}/" (English has none; the others are ${TRANSLATED_LOCALES.join(", ")})`;
  }
  if (pillar && pillar[2] !== "pillars") return "the path is /pillars/, in lowercase";
  const file = post
    ? path.join(BLOG_DIR, ...(locale ? [locale] : []), post[2], post[3], `${post[4]}.md`)
    : path.join(PILLAR_DIR, ...(locale ? [locale] : []), `${pillar[3]}.md`);
  const shown = path.relative(SITE_DIR, file);
  const known = selectedFiles.has(file) || (committed ? committed.has(repoPath(file)) : existsExactly(file));
  if (!known) {
    if (existsExactly(file)) return `${shown} is not committed: build and push it together with this page`;
    if (fs.existsSync(file)) return `wrong letter case: no ${shown}`;
    return `no source file ${shown}`;
  }
  const entry = entryFromFile(file, BLOG_DIR, PILLAR_DIR);
  if (!entry) return `no source file ${shown}`;
  if (entry.draft) return `draft ${shown}`;
  const nameProblem = fileNameProblem(file, entry);
  return nameProblem ? `${shown} is not published at its path (${nameProblem})` : null;
}

// ids, <a name> and <a href> values of real tags. Script, style and comment
// bodies are dropped first, and text never matches: a code sample's
// `<div id="x">` is printed with its `<` escaped.
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (match, dec, hex, name) => {
    try {
      return name ? NAMED_ENTITIES[name.toLowerCase()] : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
    } catch {
      return match;
    }
  });
function scanHtml(html) {
  const ids = new Set();
  const hrefs = [];
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  for (const [, tag, attrText] of markup.matchAll(TAG_RE)) {
    const attrs = {};
    for (const [, name, dq, sq, bare] of attrText.matchAll(ATTR_RE)) {
      attrs[name.toLowerCase()] = decodeEntities(dq ?? sq ?? bare ?? "");
    }
    if (attrs.id) ids.add(safeDecode(attrs.id));
    if (tag.toLowerCase() === "a") {
      if (attrs.name) ids.add(safeDecode(attrs.name));
      if (attrs.href) hrefs.push(attrs.href);
    }
  }
  return { ids, hrefs };
}

const problems = [];
const alreadyBroken = [];
if (errorsLogged > 0) problems.push(`Astro logged ${errorsLogged} error(s) above; a page may be missing its content`);

let linksChecked = 0;
const built = [];
for (const s of selected) {
  if (s.draft) {
    console.log(`[build-page] skipped (draft: true): ${s.urlPath}`);
    continue;
  }
  const htmlPath = path.join(outDir, s.urlPath.replace(/^\//, ""), "index.html");
  if (!fs.existsSync(htmlPath)) {
    problems.push(`${s.urlPath}: page was not emitted (${path.relative(SITE_DIR, s.file)})`);
    continue;
  }
  built.push({ ...s, htmlPath });

  // Link targets are checked against the source files, not the output: only
  // the selected posts were built.
  const { ids, hrefs } = scanHtml(fs.readFileSync(htmlPath, "utf8"));
  for (const href of hrefs) {
    let problem;
    if (href.startsWith("#")) {
      const id = safeDecode(href.slice(1));
      if (!id) continue;
      linksChecked++;
      // Browsers also scroll to <a name> and treat #top as the top of the page.
      if (ids.has(id) || id.toLowerCase() === "top") continue;
      problem = "has no matching id on the page";
    } else {
      const target = sitePath(href, s.urlPath);
      const result = target === null ? undefined : linkProblem(target);
      if (result === undefined) continue;
      linksChecked++;
      if (result === null) continue;
      problem = `-> ${result}`;
    }
    (wasAlreadyThere(s.file, href) ? alreadyBroken : problems).push(`${s.urlPath}: ${href} ${problem}`);
  }
}

for (const b of built) console.log(`  ok ${b.urlPath} -> ${b.htmlPath}`);
console.log(`[build-page] ${linksChecked} post/pillar/anchor link(s) checked in ${seconds}s build`);

if (alreadyBroken.length > 0) {
  console.log(`[build-page] ${alreadyBroken.length} link problem(s) already on ${BASE_REF}, so not failing this run:`);
  for (const p of alreadyBroken) console.log(`  ${p}`);
}
if (problems.length > 0) {
  console.error(`[build-page] ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`[build-page] OK. Output kept in ${outDir}`);
process.exit(0);
