import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import he from "he";

const DEFAULT_BASE = "https://startdebugging.net";

function parseArgs(argv) {
  const args = {
    base: DEFAULT_BASE,
    outContent: "src/content/blog",
    outPublic: "public",
    downloadMedia: true,
    status: "publish",
    limit: undefined,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--out-content") args.outContent = argv[++i];
    else if (a === "--out-public") args.outPublic = argv[++i];
    else if (a === "--status") args.status = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--no-download-media") args.downloadMedia = false;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "WordPress → Astro migration",
          "",
          "Usage:",
          "  node scripts/wp-migrate.mjs [options]",
          "",
          "Options:",
          "  --base <url>              WordPress base URL (default: https://startdebugging.net)",
          "  --status <status>         Post status to fetch (default: publish)",
          "  --out-content <dir>       Content output dir (default: src/content/blog)",
          "  --out-public <dir>        Public output dir (default: public)",
          "  --no-download-media       Do not download wp-content/uploads assets",
          "  --limit <n>               Only migrate first N posts (for testing)",
          "  --verbose                 Extra logs",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function ensureTrailingSlash(u) {
  return u.endsWith("/") ? u : `${u}/`;
}

function parseWpDate(s) {
  // WP dates are often returned without timezone. Treat as UTC if no offset is present.
  if (typeof s !== "string" || s.length === 0) return null;
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
  return new Date(`${s}Z`);
}

function isoDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function stripHtmlToText(html) {
  const dom = new JSDOM(`<body>${html ?? ""}</body>`);
  const txt = dom.window.document.body.textContent ?? "";
  return he.decode(txt).replace(/\s+/g, " ").trim();
}

function yamlString(s) {
  // Minimal YAML string escaping using double quotes.
  const v = String(s ?? "");
  const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function isWpUploadsUrl(base, urlString) {
  try {
    const baseUrl = new URL(base);
    const u = new URL(urlString, baseUrl);
    return u.origin === baseUrl.origin && u.pathname.startsWith("/wp-content/uploads/");
  } catch {
    return false;
  }
}

function toCanonicalLocalPath(base, urlString) {
  const baseUrl = new URL(base);
  const u = new URL(urlString, baseUrl);
  // Drop query/hash when converting to local static assets/paths.
  return u.pathname;
}

async function fetchJson(url, { headers = {}, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "StartDebuggingAstroMigrator/1.0",
          ...headers,
        },
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} for ${url} ${text ? `- ${text.slice(0, 200)}` : ""}`);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      const backoffMs = 400 * Math.pow(2, attempt);
      if (attempt < retries) await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

async function fetchAllPaged(baseApi, route, query = {}) {
  const perPage = 100;
  const out = [];
  for (let page = 1; ; page++) {
    const url = new URL(`${baseApi}${route}`);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const items = await fetchJson(url.toString());
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < perPage) break;
  }
  return out;
}

function buildTurndown() {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
  });

  // Prefer our own <pre> handling to preserve code and language.
  service.addRule("fencedCodeBlock", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (content, node) => {
      const pre = node;

      // Remove common WordPress plugin artifacts inside <pre>.
      const clone = pre.cloneNode(true);
      for (const el of clone.querySelectorAll("small, .code-language, .language-name")) el.remove();
      // Also drop any nodes that mention "Code language:".
      for (const el of clone.querySelectorAll("*")) {
        if ((el.textContent ?? "").toLowerCase().includes("code language:")) el.remove();
      }

      const code = clone.querySelector("code");
      const langFromClass = (cls) => {
        if (!cls) return null;
        const m = cls.match(/(?:language|lang)-([a-z0-9_+-]+)/i);
        return m ? m[1].toLowerCase() : null;
      };
      const language =
        langFromClass(code?.getAttribute("class") ?? "") ||
        langFromClass(clone.getAttribute("class") ?? "") ||
        clone.getAttribute("data-language")?.toLowerCase() ||
        "";

      const codeText = (code ? code.textContent : clone.textContent) ?? "";
      const cleaned = codeText.replace(/\s+$/g, "");

      const fenceLang = language ? language : "";
      return `\n\`\`\`${fenceLang}\n${cleaned}\n\`\`\`\n`;
    },
  });

  return service;
}

function collectMediaUrlsFromDocument(base, doc) {
  const urls = new Set();

  const consider = (raw) => {
    if (!raw) return;
    const parts = String(raw)
      .split(",")
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean);
    for (const p of parts) {
      const cleaned = p.replace(/^url\((.+)\)$/i, "$1").replace(/^['"]|['"]$/g, "");
      if (isWpUploadsUrl(base, cleaned)) urls.add(new URL(cleaned, base).toString());
    }
  };

  for (const img of doc.querySelectorAll("img")) {
    consider(img.getAttribute("src"));
    consider(img.getAttribute("srcset"));
  }
  for (const source of doc.querySelectorAll("source")) {
    consider(source.getAttribute("src"));
    consider(source.getAttribute("srcset"));
  }
  // Some WP blocks wrap images in links.
  for (const a of doc.querySelectorAll("a")) {
    consider(a.getAttribute("href"));
  }

  return urls;
}

function rewriteLinksAndMedia({ base, doc, idToPermalinkPath }) {
  const baseUrl = new URL(base);

  const rewriteAttrUrl = (el, attr) => {
    const raw = el.getAttribute(attr);
    if (!raw) return;
    let u;
    try {
      u = new URL(raw, baseUrl);
    } catch {
      return;
    }

    // Map `?p=123` to canonical `/<year>/<month>/<slug>/` if we can.
    if (u.origin === baseUrl.origin && u.pathname === "/" && u.searchParams.has("p")) {
      const id = Number(u.searchParams.get("p"));
      const mapped = idToPermalinkPath.get(id);
      if (mapped) {
        el.setAttribute(attr, mapped);
        return;
      }
    }

    // Rewrite media to local root path.
    if (u.origin === baseUrl.origin && u.pathname.startsWith("/wp-content/uploads/")) {
      el.setAttribute(attr, u.pathname);
      return;
    }

    // Rewrite internal post links to root-relative path.
    if (u.origin === baseUrl.origin) {
      el.setAttribute(attr, `${u.pathname}${u.search}${u.hash}`);
    }
  };

  for (const el of doc.querySelectorAll("[href]")) rewriteAttrUrl(el, "href");
  for (const el of doc.querySelectorAll("[src]")) rewriteAttrUrl(el, "src");

  // Rewrite srcset to local root paths when it points at wp-content/uploads.
  for (const el of doc.querySelectorAll("[srcset]")) {
    const raw = el.getAttribute("srcset");
    if (!raw) continue;
    const rewritten = raw
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return "";
        const [urlPart, sizePart] = trimmed.split(/\s+/, 2);
        if (!urlPart) return trimmed;
        if (!isWpUploadsUrl(base, urlPart)) return trimmed;
        const p = toCanonicalLocalPath(base, urlPart);
        return sizePart ? `${p} ${sizePart}` : p;
      })
      .filter(Boolean)
      .join(", ");
    el.setAttribute("srcset", rewritten);
  }
}

async function downloadMediaAsset({ url, outPublicDir, base }) {
  const localPath = toCanonicalLocalPath(base, url);
  const fullPath = path.join(outPublicDir, localPath.replace(/^\//, ""));

  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  // Skip if exists already.
  try {
    await fs.access(fullPath);
    return { fullPath, skipped: true };
  } catch {
    // continue
  }

  const resp = await fetch(url, { headers: { "User-Agent": "StartDebuggingAstroMigrator/1.0" } });
  if (!resp.ok) throw new Error(`Failed media download ${resp.status} ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(fullPath, buf);
  return { fullPath, skipped: false };
}

function buildFrontmatter({ title, description, pubDate, updatedDate, draft, tags }) {
  const lines = ["---"];
  lines.push(`title: ${yamlString(title)}`);
  if (description) lines.push(`description: ${yamlString(description)}`);
  lines.push(`pubDate: ${isoDateOnly(pubDate)}`);
  if (updatedDate) lines.push(`updatedDate: ${isoDateOnly(updatedDate)}`);
  if (draft) lines.push("draft: true");
  if (tags?.length) {
    lines.push("tags:");
    for (const t of tags) lines.push(`  - ${yamlString(t)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = ensureTrailingSlash(args.base).replace(/\/+$/, "");
  const baseApi = `${base}/wp-json/wp/v2`;

  const outContentDir = path.resolve(process.cwd(), args.outContent);
  const outPublicDir = path.resolve(process.cwd(), args.outPublic);

  console.log(`Base: ${base}`);
  console.log(`Output content: ${outContentDir}`);
  console.log(`Output public:  ${outPublicDir}`);
  console.log(`Status: ${args.status}`);
  console.log(`Download media: ${args.downloadMedia ? "yes" : "no"}`);

  const [posts, categories, tags] = await Promise.all([
    fetchAllPaged(baseApi, "/posts", { status: args.status }),
    fetchAllPaged(baseApi, "/categories"),
    fetchAllPaged(baseApi, "/tags"),
  ]);

  const catById = new Map(categories.map((c) => [c.id, c.slug]));
  const tagById = new Map(tags.map((t) => [t.id, t.slug]));

  const postList = args.limit ? posts.slice(0, args.limit) : posts;

  // Map WP numeric IDs -> canonical permalink path `/<YYYY>/<MM>/<slug>/` to help rewrite `?p=...` links.
  const idToPermalinkPath = new Map();
  for (const p of postList) {
    const d = parseWpDate(p.date_gmt ?? p.date);
    if (!d) continue;
    const y = String(d.getUTCFullYear());
    const m = pad2(d.getUTCMonth() + 1);
    idToPermalinkPath.set(p.id, `/${y}/${m}/${p.slug}/`);
  }

  const turndown = buildTurndown();

  let written = 0;
  let mediaDiscovered = 0;
  let mediaDownloaded = 0;
  let mediaSkipped = 0;
  const mediaUrls = new Set();

  for (const p of postList) {
    const pub = parseWpDate(p.date_gmt ?? p.date);
    const mod = parseWpDate(p.modified_gmt ?? p.modified);
    if (!pub) continue;

    const year = String(pub.getUTCFullYear());
    const month = pad2(pub.getUTCMonth() + 1);
    const slug = p.slug;

    const title = stripHtmlToText(p.title?.rendered ?? "");
    const descFromExcerpt = stripHtmlToText(p.excerpt?.rendered ?? "");

    const dom = new JSDOM(`<body>${p.content?.rendered ?? ""}</body>`);
    const doc = dom.window.document;

    // Rewrite internal links and uploads references before conversion.
    rewriteLinksAndMedia({ base, doc, idToPermalinkPath });

    // Collect media URLs for optional downloading.
    for (const u of collectMediaUrlsFromDocument(base, doc)) mediaUrls.add(u);

    let mdBody = turndown.turndown(doc.body).trim();
    // Some WP themes/plugins wrap links in <code>, which Turndown turns into
    // backticked Markdown links like: `[https://x](https://x)`.
    mdBody = mdBody.replace(/`(\[[^\]]+\]\([^)]+\))`/g, "$1");

    const description =
      descFromExcerpt ||
      (() => {
        const t = stripHtmlToText(p.content?.rendered ?? "");
        return t.length > 200 ? `${t.slice(0, 200).trim()}…` : t;
      })();

    const updatedDate =
      mod && mod.getTime() - pub.getTime() > 24 * 60 * 60 * 1000 ? mod : undefined;

    const tagSet = new Set();
    for (const id of Array.isArray(p.categories) ? p.categories : []) {
      const s = catById.get(id);
      if (s) tagSet.add(s);
    }
    for (const id of Array.isArray(p.tags) ? p.tags : []) {
      const s = tagById.get(id);
      if (s) tagSet.add(s);
    }
    const tagList = Array.from(tagSet).sort();

    const frontmatter = buildFrontmatter({
      title,
      description,
      pubDate: pub,
      updatedDate,
      draft: p.status !== "publish",
      tags: tagList.length ? tagList : undefined,
    });

    const filePath = path.join(outContentDir, year, month, `${slug}.md`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${frontmatter}${mdBody}\n`, "utf8");
    written++;

    if (args.verbose) console.log(`Wrote ${path.relative(process.cwd(), filePath)}`);
  }

  mediaDiscovered = mediaUrls.size;
  if (args.downloadMedia) {
    const urls = Array.from(mediaUrls);
    console.log(`Media discovered: ${urls.length}`);

    // Simple concurrency limiter.
    const concurrency = 6;
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (idx < urls.length) {
        const i = idx++;
        const url = urls[i];
        try {
          const res = await downloadMediaAsset({ url, outPublicDir, base });
          if (res.skipped) mediaSkipped++;
          else mediaDownloaded++;
        } catch (e) {
          console.warn(`WARN: ${e.message}`);
        }
      }
    });
    await Promise.all(workers);
  }

  console.log("");
  console.log(`Posts fetched:     ${posts.length}`);
  console.log(`Posts migrated:    ${written}`);
  console.log(`Media discovered:  ${mediaDiscovered}`);
  console.log(`Media downloaded:  ${mediaDownloaded}`);
  console.log(`Media skipped:     ${mediaSkipped}`);
}

main().catch((e) => {
  console.error(`ERROR: ${e.stack || e.message || e}`);
  process.exit(1);
});

