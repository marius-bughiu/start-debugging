import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "parse5";
import { readSitemap } from "./seo-build-validation.mjs";

export const DEFAULT_LOCALES = ["en", "de", "es", "ja", "pt-br", "ru"];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const splitTokens = (value = "") => value.toLowerCase().trim().split(/\s+/).filter(Boolean);
const attrsOf = (node) => Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
const textOf = (node) => node.nodeName === "#text" ? node.value : ["script", "style", "template"].includes(node.tagName) ? "" : (node.childNodes ?? []).map(textOf).join("");

function normalizedPathname(value) {
  return value.split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (/[\\/\0]/.test(decoded) || decoded === "." || decoded === "..") throw new Error("Unsafe URL path segment");
    return encodeURIComponent(decoded);
  }).join("/");
}

/** Resolve browser href semantics, retaining only same-origin HTTP(S) documents. */
export function internalPath(href, base, origin) {
  try {
    const url = new URL(href, base);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return normalizedPathname(url.pathname);
  } catch { return null; }
}

export function localeForPath(value, locales = DEFAULT_LOCALES) {
  const first = value.split("/")[1];
  return locales.includes(first) && first !== "en" ? first : "en";
}

export function kindForPath(value, locales = DEFAULT_LOCALES) {
  const locale = localeForPath(value, locales);
  const local = locale === "en" ? value : value.slice(locale.length + 1);
  if (local === "/") return "home";
  if (/^\/\d{4}\/\d{2}\/[^/]+\/$/.test(local)) return "article";
  if (/^\/pillars\/[^/]+\/$/.test(local)) return "pillar";
  if (local === "/pillars/") return "pillar-directory";
  if (/^\/tags?\//.test(local)) return "taxonomy";
  if (/^\/(?:page\/|archive\/)/.test(local)) return "listing";
  return "other";
}

function categoryFor(ancestors, target, locales) {
  const hasClass = (name) => ancestors.some(({ classes }) => classes.has(name));
  const hasTag = (name) => ancestors.some(({ tag }) => tag === name);
  if (hasClass("header-lang-menu") || hasClass("lang-switcher") || ancestors.some(({ attrs }) => attrs.hreflang)) return "language";
  if (hasClass("related-articles")) return "related";
  if (hasClass("prev-next")) return "adjacent";
  if (hasClass("topic-guides")) return "topic-guide";
  if (hasClass("pillar-index")) return "pillar-list";
  if (hasClass("article-toc")) return "toc";
  if (hasTag("header") || hasTag("footer") || hasTag("nav")) return "navigation";
  if (hasClass("byline") || hasClass("publication-credit") || hasClass("share-row") || hasClass("inline-subscribe") || hasClass("post-edit-link") || hasTag("pre") || hasTag("code")) return "utility";
  if (hasTag("aside")) return "sidebar";
  if (kindForPath(target, locales) === "taxonomy") return "taxonomy";
  if (hasClass("post-card")) return "listing";
  if (hasClass("prose")) return "contextual";
  return "listing";
}

/** HTML parsing avoids treating escaped examples, scripts or templates as links. */
export function inspectDiscoveryPage(html, { pagePath, origin = "https://startdebugging.net", locales = DEFAULT_LOCALES }) {
  origin = new URL(origin).origin;
  const documentUrl = origin + pagePath;
  const root = parse(html);
  const metadata = { canonicals: [], robots: [], refresh: [], language: "", title: "", bases: [] };
  const anchors = [];
  let skippedHiddenAnchors = 0;
  const visit = (node, ancestors = [], hidden = false, inHead = false) => {
    if (["template", "script", "style"].includes(node.tagName)) return;
    const attrs = attrsOf(node);
    const classes = new Set(splitTokens(attrs.class));
    const lineage = [...ancestors, { tag: node.tagName, attrs, classes }];
    inHead ||= node.tagName === "head";
    hidden ||= Object.hasOwn(attrs, "hidden") || Object.hasOwn(attrs, "inert") || /(?:^|;)\s*display\s*:\s*none\s*(?:!important)?\s*(?:;|$)/i.test(attrs.style ?? "");
    if (node.tagName === "html") metadata.language = attrs.lang ?? "";
    if (inHead) {
      if (node.tagName === "title") metadata.title = textOf(node).replace(/\s+/g, " ").trim();
      if (node.tagName === "base" && Object.hasOwn(attrs, "href")) metadata.bases.push(attrs.href);
      if (node.tagName === "link" && splitTokens(attrs.rel).includes("canonical")) metadata.canonicals.push(attrs.href ?? "");
      if (node.tagName === "meta") {
        if (/^(?:robots|googlebot(?:-news)?|bingbot)$/i.test(attrs.name ?? "")) metadata.robots.push(attrs.content ?? "");
        if (attrs["http-equiv"]?.toLowerCase() === "refresh") metadata.refresh.push(attrs.content ?? "");
      }
    }
    if (node.tagName === "a" && Object.hasOwn(attrs, "href")) {
      if (hidden) skippedHiddenAnchors++;
      else anchors.push({ attrs, lineage, text: textOf(node).replace(/\s+/g, " ").trim().slice(0, 160) });
    }
    for (const child of node.childNodes ?? []) visit(child, lineage, hidden, inHead);
  };
  visit(root);
  let base = documentUrl;
  // The first base element wins, including a cross-origin base.
  if (metadata.bases.length) { try { base = new URL(metadata.bases[0], documentUrl).href; } catch { /* browser ignores an invalid base */ } }
  const canonicals = metadata.canonicals.map((href) => {
    try {
      const parsed = new URL(href, base);
      return parsed.search || parsed.hash ? null : internalPath(href, base, origin);
    } catch { return null; }
  });
  const noindex = metadata.robots.some((value) => /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/i.test(value));
  const nofollow = metadata.robots.some((value) => /(?:^|[\s,:])(?:nofollow|none)(?:$|[\s,])/i.test(value));
  let redirect = null;
  for (const value of metadata.refresh) {
    const match = /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.*?)\s*$/i.exec(value);
    if (match) { redirect = internalPath(match[1].replace(/^(['"])(.*)\1$/, "$2"), base, origin); break; }
  }
  const links = [];
  let externalOrInvalidAnchors = 0;
  let downloadAnchors = 0;
  for (const anchor of anchors) {
    if (Object.hasOwn(anchor.attrs, "download")) { downloadAnchors++; continue; }
    const target = internalPath(anchor.attrs.href, base, origin);
    if (target === null) { externalOrInvalidAnchors++; continue; }
    if (target === pagePath) continue;
    links.push({ target, category: categoryFor(anchor.lineage, target, locales), text: anchor.text, nofollow: splitTokens(anchor.attrs.rel).includes("nofollow") });
  }
  return {
    path: pagePath, locale: localeForPath(pagePath, locales), kind: kindForPath(pagePath, locales),
    title: metadata.title, language: metadata.language, canonicalPaths: canonicals,
    indexable: !noindex && !metadata.refresh.length && canonicals.length === 1 && canonicals[0] === pagePath,
    noindex, nofollow, refresh: metadata.refresh, redirect, links,
    skipped: { hidden: skippedHiddenAnchors, externalOrInvalid: externalOrInvalidAnchors, downloads: downloadAnchors },
  };
}

async function htmlFiles(directory) {
  const found = [];
  const walk = async (relative = "") => {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name.endsWith(".html")) found.push(next);
    }
  };
  await walk();
  return found;
}

export function pagePathForFile(file) {
  const parts = file.split(path.sep);
  const directoryIndex = parts.at(-1) === "index.html";
  if (directoryIndex) parts.pop();
  return "/" + parts.map(encodeURIComponent).join("/") + (directoryIndex && parts.length ? "/" : "");
}

function breadthFirst(root, pages, edges, sameLocale = false) {
  const distance = new Map();
  const predecessor = new Map();
  if (!pages.has(root)) return { distance, predecessor };
  const locale = pages.get(root).locale;
  const queue = [root];
  distance.set(root, 0);
  for (let i = 0; i < queue.length; i++) {
    const source = queue[i];
    for (const target of [...(edges.get(source)?.keys() ?? [])].sort(compare)) {
      if (distance.has(target) || (sameLocale && pages.get(target).locale !== locale)) continue;
      distance.set(target, distance.get(source) + 1);
      predecessor.set(target, source);
      queue.push(target);
    }
  }
  return { distance, predecessor };
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value === undefined ? "unreachable" : String(value), (counts.get(value === undefined ? "unreachable" : String(value)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => a === "unreachable" ? 1 : b === "unreachable" ? -1 : Number(a) - Number(b)));
}

function shortestPath(target, search) {
  if (!search.distance.has(target)) return null;
  const result = [target];
  while (search.predecessor.has(result[0])) result.unshift(search.predecessor.get(result[0]));
  return result;
}

async function sitemapPaths(distDir, origin) {
  const urls = new Set();
  const seen = new Set();
  const read = async (file) => {
    if (seen.has(file)) throw new Error("Repeated sitemap: " + file);
    seen.add(file);
    const sitemap = readSitemap(await fs.readFile(file, "utf8"));
    for (const entry of sitemap.entries) {
      const pathname = internalPath(entry.url, origin + "/", origin);
      if (pathname === null) throw new Error("Invalid/off-origin sitemap URL: " + entry.url);
      if (sitemap.kind === "sitemapindex") await read(path.join(distDir, ...pathname.split("/").filter(Boolean).map(decodeURIComponent)));
      else urls.add(pathname);
    }
  };
  try { await fs.access(path.join(distDir, "sitemap-index.xml")); }
  catch { return null; }
  await read(path.join(distDir, "sitemap-index.xml"));
  return urls;
}

/** Offline, deterministic graph of built HTML. No Google indexing claims. */
export async function auditDiscoveryGraph({ distDir, origin = "https://startdebugging.net", locales = DEFAULT_LOCALES, priorityPaths = [], provenance = null, includeEdges = false }) {
  origin = new URL(origin).origin;
  const files = await htmlFiles(distDir);
  const pages = new Map();
  const fileAliases = new Map();
  const fingerprint = createHash("sha256");
  for (const file of files) {
    const html = await fs.readFile(path.join(distDir, file), "utf8");
    const pagePath = pagePathForFile(file);
    if (pages.has(pagePath)) throw new Error("Multiple HTML files resolve to " + pagePath);
    const page = inspectDiscoveryPage(html, { pagePath, origin, locales });
    pages.set(pagePath, page);
    const actualFilePath = "/" + file.split(path.sep).map(encodeURIComponent).join("/");
    fileAliases.set(actualFilePath, pagePath);
    if (pagePath.endsWith("/")) fileAliases.set(pagePath.slice(0, -1) || "/", pagePath);
    fingerprint.update(file.split(path.sep).join("/") + "\0" + createHash("sha256").update(html).digest("hex") + "\n");
  }
  const resolveTarget = (start) => {
    let target = start;
    const redirects = [];
    const visited = new Set();
    while (true) {
      target = fileAliases.get(target) ?? target;
      if (visited.has(target)) return { error: "redirect-cycle", target, redirects };
      visited.add(target);
      const page = pages.get(target);
      if (!page) return { error: "not-an-html-page", target, redirects };
      if (!page.refresh.length) return { target, redirects };
      if (!page.redirect) return { error: "unresolved-redirect", target, redirects };
      redirects.push(target);
      target = page.redirect;
    }
  };
  const edges = new Map();
  const incoming = new Map([...pages.keys()].map((url) => [url, new Map()]));
  const unresolved = new Map();
  let anchorOccurrences = 0;
  let redirectOccurrences = 0;
  let nofollowOccurrences = 0;
  for (const page of pages.values()) {
    if (page.refresh.length) continue;
    const outgoing = new Map();
    edges.set(page.path, outgoing);
    for (const link of page.links) {
      const resolved = resolveTarget(link.target);
      if (resolved.error) {
        const key = page.path + "\0" + link.target + "\0" + resolved.error;
        if (!unresolved.has(key)) unresolved.set(key, { source: page.path, target: link.target, reason: resolved.error, occurrences: 0 });
        unresolved.get(key).occurrences++;
        continue;
      }
      if (resolved.target === page.path) continue;
      anchorOccurrences++;
      if (resolved.redirects.length) redirectOccurrences++;
      if (link.nofollow) nofollowOccurrences++;
      let edge = outgoing.get(resolved.target);
      if (!edge) {
        edge = { source: page.path, target: resolved.target, categories: new Set(), followedCategories: new Set(), occurrences: 0, nofollowOccurrences: 0, redirectPaths: new Set(), texts: new Set() };
        outgoing.set(resolved.target, edge);
        incoming.get(resolved.target).set(page.path, edge);
      }
      edge.categories.add(link.category);
      if (!link.nofollow && !page.nofollow) edge.followedCategories.add(link.category);
      edge.occurrences++;
      if (link.nofollow) edge.nofollowOccurrences++;
      resolved.redirects.forEach((value) => edge.redirectPaths.add(value));
      if (edge.texts.size < 3) edge.texts.add(link.text);
    }
  }
  const searches = new Map(locales.map((locale) => [locale, breadthFirst(locale === "en" ? "/" : `/${locale}/`, pages, edges, true)]));
  const globalSearch = breadthFirst("/", pages, edges);
  const nonHtmlTargets = new Map();
  for (const entry of unresolved.values()) {
    if (entry.reason !== "not-an-html-page" || nonHtmlTargets.has(entry.target)) continue;
    const file = path.join(distDir, ...entry.target.split("/").filter(Boolean).map(decodeURIComponent));
    let exists = false;
    try { exists = (await fs.lstat(file)).isFile(); } catch { /* absent destination */ }
    nonHtmlTargets.set(entry.target, exists);
  }
  const nonHtmlLinks = new Map();
  for (const [key, entry] of unresolved) {
    if (!nonHtmlTargets.get(entry.target)) continue;
    if (!nonHtmlLinks.has(entry.target)) nonHtmlLinks.set(entry.target, { path: entry.target, sourcePages: 0, anchorOccurrences: 0 });
    nonHtmlLinks.get(entry.target).sourcePages++;
    nonHtmlLinks.get(entry.target).anchorOccurrences += entry.occurrences;
    unresolved.delete(key);
  }
  const sitemap = await sitemapPaths(distDir, origin);
  const priorities = new Set(priorityPaths.map((value) => internalPath(value, origin + "/", origin)).filter(Boolean));
  const results = [];
  for (const page of pages.values()) {
    if (!page.indexable) continue;
    const sources = [...incoming.get(page.path).entries()].sort(([a], [b]) => compare(a, b));
    const sameLocale = sources.filter(([source]) => pages.get(source).locale === page.locale);
    const byCategory = new Map();
    for (const [source, edge] of sameLocale) for (const category of edge.categories) {
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(source);
    }
    const contextual = sameLocale.filter(([source, edge]) => pages.get(source).indexable && ["article", "pillar"].includes(pages.get(source).kind) && edge.followedCategories.has("contextual")).map(([source]) => source);
    const contextualArticles = contextual.filter((source) => pages.get(source).kind === "article");
    const contextualPillars = contextual.filter((source) => pages.get(source).kind === "pillar");
    const search = searches.get(page.locale);
    const depth = search?.distance.get(page.path) ?? null;
    results.push({
      path: page.path, locale: page.locale, kind: page.kind, title: page.title,
      language: page.language, inSitemap: sitemap?.has(page.path) ?? null,
      depth, globalDepth: globalSearch.distance.get(page.path) ?? null,
      shortestPath: search ? shortestPath(page.path, search) : null,
      incoming: {
        sameLocaleSources: sameLocale.length, crossLocaleSources: sources.length - sameLocale.length,
        contextualSources: contextual.length, contextualArticleSources: contextualArticles.length,
        contextualPillarSources: contextualPillars.length,
        byCategory: Object.fromEntries([...byCategory].sort(([a], [b]) => compare(a, b)).map(([category, values]) => [category, values.length])),
      },
      contextualSources: contextual,
      sourceExamples: Object.fromEntries([...byCategory].sort(([a], [b]) => compare(a, b)).map(([category, values]) => [category, values.slice(0, 8)])),
      priority: priorities.has(page.path),
    });
  }
  results.sort((a, b) => compare(a.path, b.path));
  const content = results.filter((page) => ["article", "pillar"].includes(page.kind));
  const weak = content.filter((page) => page.depth === null || page.depth > 3 || page.incoming.contextualSources === 0);
  weak.sort((a, b) => Number(b.priority) - Number(a.priority) || Number(b.depth === null) - Number(a.depth === null) || Number(b.incoming.contextualSources === 0) - Number(a.incoming.contextualSources === 0) || (b.depth ?? Infinity) - (a.depth ?? Infinity) || a.incoming.sameLocaleSources - b.incoming.sameLocaleSources || compare(a.path, b.path));
  const byLocale = {};
  for (const locale of locales) {
    const local = results.filter((page) => page.locale === locale);
    if (!local.length) continue;
    const articles = local.filter((page) => page.kind === "article");
    byLocale[locale] = {
      homepage: locale === "en" ? "/" : `/${locale}/`, homepageExists: pages.has(locale === "en" ? "/" : `/${locale}/`),
      canonicalPages: local.length, articles: articles.length, pillars: local.filter((page) => page.kind === "pillar").length,
      disconnected: local.filter((page) => page.depth === null).length,
      disconnectedArticles: articles.filter((page) => page.depth === null).length,
      articlesWithoutContextualInbound: articles.filter((page) => page.incoming.contextualSources === 0).length,
      articleDepth: histogram(articles.map((page) => page.depth ?? undefined)),
      allPageDepth: histogram(local.map((page) => page.depth ?? undefined)),
    };
  }
  const serializeEdge = (edge) => ({ ...edge, categories: [...edge.categories].sort(compare), followedCategories: [...edge.followedCategories].sort(compare), redirectPaths: [...edge.redirectPaths].sort(compare), texts: [...edge.texts].sort(compare) });
  return {
    schemaVersion: 1, origin, provenance,
    htmlManifestSha256: fingerprint.digest("hex"),
    methodology: {
      scope: "Offline static HTML anchors; canonical self-referencing indexable pages are reported. All non-redirect HTML documents can act as traversal bridges, including noindex pages.",
      depth: "Minimum anchor clicks from each locale homepage without crossing locales. Same-origin query strings/fragments and known directory/index.html variants resolve to the built document. Meta refresh chains cost no additional click. Global depth allows language switches.",
      contextual: "Distinct same-locale, indexable article/pillar sources linking inside prose, excluding navigation, related rails, topic-guide modules, taxonomy, tables of contents, bylines, sidebars and code. At least one followed contextual anchor is required.",
      limits: ["Static HTML availability is not a Googlebot crawl or indexing result.", "Zero contextual inbound links is an editorial prioritization signal, not proof of an orphan page.", "No JavaScript execution or stylesheet visibility calculation; hidden/inert/inline display:none ancestors, templates, scripts and download anchors are excluded.", "Depth includes ordinary anchor links with rel=nofollow; their occurrence count is reported separately. Sitemap and hreflang link elements are not navigation edges.", "Incoming byCategory counts include all same-locale HTML sources, while contextualSources requires indexable article/pillar prose. Categories can overlap when one source links from several modules. Shortest paths are deterministic examples among ties.", "Existing linked non-HTML files are reported separately. Unresolved same-origin destinations require investigation; static output cannot establish their HTTP behavior."],
    },
    summary: {
      htmlFiles: pages.size, canonicalPages: results.length, sitemapPages: sitemap?.size ?? null,
      articles: results.filter((page) => page.kind === "article").length,
      pillars: results.filter((page) => page.kind === "pillar").length,
      redirectPages: [...pages.values()].filter((page) => page.refresh.length).length,
      otherExcludedPages: [...pages.values()].filter((page) => !page.indexable && !page.refresh.length).length,
      uniqueEdges: [...edges.values()].reduce((sum, values) => sum + values.size, 0), anchorOccurrences,
      redirectOccurrences, nofollowOccurrences,
      nonHtmlLinkedFiles: nonHtmlLinks.size,
      unresolvedLinkOccurrences: [...unresolved.values()].reduce((sum, entry) => sum + entry.occurrences, 0),
      disconnectedCanonicalPages: results.filter((page) => page.depth === null).length,
      globallyDisconnectedCanonicalPages: results.filter((page) => page.globalDepth === null).length,
      canonicalPagesMissingFromSitemap: sitemap ? results.filter((page) => !page.inSitemap).length : null,
      sitemapPagesMissingCanonicalHtml: sitemap ? [...sitemap].filter((value) => !pages.get(value)?.indexable).length : null,
      byLocale,
    },
    disconnected: results.filter((page) => page.depth === null).map(({ path: value, locale, kind, globalDepth }) => ({ path: value, locale, kind, globalDepth })),
    missingPriorityPaths: [...priorities].filter((value) => !results.some((page) => page.path === value)).sort(compare),
    weakContent: weak.map(({ path: value, locale, kind, depth, incoming: counts, priority }) => ({ path: value, locale, kind, depth, incoming: counts, priority })),
    nonHtmlLinks: [...nonHtmlLinks.values()].sort((a, b) => compare(a.path, b.path)),
    unresolvedLinks: [...unresolved.values()].sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target) || compare(a.reason, b.reason)),
    pages: results,
    ...(includeEdges ? { edges: [...edges.values()].flatMap((values) => [...values.values()]).sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target)).map(serializeEdge) } : {}),
  };
}
