import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditDiscoveryGraph, inspectDiscoveryPage, internalPath, pagePathForFile } from "./lib/discovery-graph.mjs";

const ORIGIN = "https://startdebugging.net";
const A = "/2026/01/alpha/";
const B = "/2026/01/beta/";
const P = "/pillars/topic/";
const doc = (url, body = "", head = "", lang = "en") => `<!doctype html><html lang="${lang}"><head><title>${url}</title><link rel="canonical" href="${ORIGIN}${url}">${head}</head><body>${body}</body></html>`;
const article = (body) => `<article class="prose">${body}</article>`;

async function fixture(t, pages, options = {}) {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-graph-test-"));
  t.after(() => fs.rm(distDir, { recursive: true, force: true }));
  for (const [url, html] of Object.entries(pages)) {
    const file = path.join(distDir, url.endsWith("/") ? url.slice(1) + "index.html" : url.slice(1));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html);
  }
  return auditDiscoveryGraph({ distDir, ...options });
}

test("href resolution respects browser bases, origin, escaping, credentials and safe path segments", () => {
  const base = ORIGIN + "/2026/01/alpha/";
  assert.equal(internalPath("../beta/?ref=one#part", base, ORIGIN), B);
  assert.equal(internalPath("//startdebugging.net/2026/01/%62eta/", base, ORIGIN), B);
  assert.equal(internalPath("https://elsewhere.test/a/", base, ORIGIN), null);
  assert.equal(internalPath("javascript:alert(1)", base, ORIGIN), null);
  assert.equal(internalPath("https://name:secret@startdebugging.net/a/", base, ORIGIN), null);
  assert.equal(internalPath("/not%2Fan%2Factual%2Fsegment/", base, ORIGIN), null);
  assert.equal(internalPath("/bad%00path/", base, ORIGIN), null);
  assert.equal(pagePathForFile("index.html"), "/");
  assert.equal(pagePathForFile(path.join("日本", "index.html")), "/%E6%97%A5%E6%9C%AC/");
  assert.equal(pagePathForFile("not-index.html"), "/not-index.html");
});

test("HTML parser distinguishes prose from modules and ignores escaped, template and hidden links", () => {
  const html = doc(A, article(`
    <p><a HREF='../beta/?x=1&amp;y=2#part'>Read &amp; learn</a></p>
    <nav class="article-toc"><a href="${B}">Contents</a></nav>
    <div class="byline"><a href="${B}">Author</a></div>
    <div class="publication-credit"><p><a href="/about/#editorial-process">Editorial process</a></p></div>
    <aside><a href="${B}">Sidebar</a></aside>
    <p><a href="/tag/async/">async</a></p>
    <pre>&lt;a href="/fake/"&gt;example&lt;/a&gt;</pre>
    <template><a href="/fake-template/">Template</a></template>
    <span hidden><a href="/hidden/">Hidden</a></span>
    <span style="display: none !important"><a href="/style-hidden/">Hidden</a></span>
    <span inert><a href="/inert/">Inert</a></span>
    <a href="${B}" download>Download</a>
    <a href="#same-page">Same page</a>
  `) + `<aside class="related-articles"><a href="${B}">Related</a></aside>
    <section class="pillar-index"><a href="${B}">Index</a></section>
    <nav class="topic-guides"><a href="${P}">Guide</a></nav>
    <nav class="prev-next"><a href="${B}">Next</a></nav>
    <header><a href="/de/" hreflang="de">Deutsch</a></header>`);
  const page = inspectDiscoveryPage(html, { pagePath: A });
  assert.equal(page.indexable, true);
  assert.deepEqual(page.links.map(({ category }) => category), ["contextual", "toc", "utility", "utility", "sidebar", "taxonomy", "related", "pillar-list", "topic-guide", "adjacent", "language"]);
  assert.equal(page.links[0].target, B);
  assert.equal(page.links[0].text, "Read & learn");
  assert.deepEqual(page.skipped, { hidden: 3, externalOrInvalid: 0, downloads: 1 });
});

test("first base href applies to anchors; canonical aliases, noindex and refresh pages are excluded", () => {
  const base = inspectDiscoveryPage(doc(A, '<a href="beta/">B</a>', '<base href="/2026/01/"><base href="https://elsewhere.test/">'), { pagePath: A });
  assert.equal(base.links[0].target, B);
  const cross = inspectDiscoveryPage(doc(A, '<a href="relative/">External</a><a href="https://startdebugging.net/">Home</a>', '<base href="https://elsewhere.test/">'), { pagePath: A });
  assert.equal(cross.links.length, 1);
  assert.equal(cross.links[0].target, "/");
  assert.equal(inspectDiscoveryPage(doc(A, "", '<meta content="index, noindex" name="robots">'), { pagePath: A }).indexable, false);
  assert.equal(inspectDiscoveryPage(doc(A).replace(ORIGIN + A, ORIGIN + B), { pagePath: A }).indexable, false);
  assert.equal(inspectDiscoveryPage(doc(A).replace(ORIGIN + A, ORIGIN + A + "?x=1"), { pagePath: A }).indexable, false);
  const redirect = inspectDiscoveryPage(doc("/old/", "", `<meta http-equiv="refresh" content="0; URL='${B}'">`), { pagePath: "/old/" });
  assert.equal(redirect.redirect, B);
  assert.equal(redirect.indexable, false);
});

test("same-locale BFS uses actual anchors and redirect chains, not canonical or hreflang hints", async (t) => {
  const result = await fixture(t, {
    "/": doc("/", '<a href="/archive">Archive</a><a href="/old/">Redirect</a><a href="/de/">Deutsch</a>', `<link rel="alternate" hreflang="en" href="${ORIGIN}${B}">`),
    "/archive/": doc("/archive/", `<a href="${A}index.html#part">A</a>`),
    [A]: doc(A, article(`<a href="${B}">B</a><a href="/orphan/">Other</a>`)),
    [B]: doc(B),
    "/old/": doc("/old/", "", '<meta http-equiv="refresh" content="0;url=/older/">'),
    "/older/": doc("/older/", "", `<meta http-equiv="refresh" content="0;url=${A}">`),
    "/de/": doc("/de/", "", "", "de"),
    "/de/2026/01/isolated/": doc("/de/2026/01/isolated/", "", "", "de"),
    "/orphan/": doc("/orphan/"),
    "/never-linked/": doc("/never-linked/"),
  }, { includeEdges: true });
  const a = result.pages.find(({ path }) => path === A);
  const b = result.pages.find(({ path }) => path === B);
  assert.equal(a.depth, 1);
  assert.deepEqual(a.shortestPath, ["/", A]);
  assert.equal(b.depth, 2);
  assert.deepEqual(b.contextualSources, [A]);
  assert.equal(result.summary.redirectPages, 2);
  assert.equal(result.summary.redirectOccurrences, 1);
  assert.equal(result.summary.disconnectedCanonicalPages, 2);
  assert.deepEqual(result.disconnected.map(({ path }) => path), ["/de/2026/01/isolated/", "/never-linked/"]);
  assert.deepEqual(result.edges.find(({ source, target }) => source === "/" && target === A).redirectPaths, ["/old/", "/older/"]);
});

test("language switch reachability does not masquerade as same-locale discovery or editorial support", async (t) => {
  const deA = "/de/2026/01/alpha/";
  const result = await fixture(t, {
    "/": doc("/", `<a href="${A}">A</a><a href="/de/">Deutsch</a>`),
    [A]: doc(A, article(`<a href="${deA}" hreflang="de">Deutsch</a>`)),
    "/de/": doc("/de/", "", "", "de"),
    [deA]: doc(deA, "", "", "de"),
  });
  const page = result.pages.find(({ path }) => path === deA);
  assert.equal(page.depth, null);
  assert.equal(page.globalDepth, 2);
  assert.equal(page.incoming.crossLocaleSources, 1);
  assert.equal(page.incoming.contextualSources, 0);
  assert.equal(result.summary.disconnectedCanonicalPages, 1);
  assert.equal(result.summary.globallyDisconnectedCanonicalPages, 0);
});

test("contextual counts deduplicate sources, separate pillar lists/related, and honor contextual nofollow", async (t) => {
  const C = "/2026/01/gamma/";
  const result = await fixture(t, {
    "/": doc("/", `<a href="${A}">A</a><a href="${B}">B</a><a href="${P}">P</a><a href="${C}">C</a>`),
    [A]: doc(A, article(`<a href="${B}">First</a><a href="${B}#more">Again</a>`) + `<aside class="related-articles"><a href="${B}">Related too</a></aside>`),
    [B]: doc(B),
    [C]: doc(C, article(`<a href="${B}" rel="nofollow">No endorsement</a>`) + `<aside class="related-articles"><a href="${B}">Followed rail</a></aside>`),
    [P]: doc(P, article(`<p><a href="${B}">Editorial</a></p>`) + `<section class="pillar-index"><a href="${B}">List</a></section>`),
  }, { priorityPaths: [B, "/missing/"] });
  const b = result.pages.find(({ path }) => path === B);
  assert.deepEqual(b.contextualSources, [A, P]);
  assert.equal(b.incoming.contextualSources, 2);
  assert.equal(b.incoming.contextualArticleSources, 1);
  assert.equal(b.incoming.contextualPillarSources, 1);
  assert.equal(b.incoming.byCategory.related, 2);
  assert.equal(b.incoming.byCategory["pillar-list"], 1);
  assert.equal(b.incoming.sameLocaleSources, 4);
  assert.deepEqual(result.missingPriorityPaths, ["/missing/"]);
});

test("noindex bridge remains a clickable route, while redirect cycles are reported separately", async (t) => {
  const result = await fixture(t, {
    "/": doc("/", '<a href="/bridge/">Bridge</a><a href="/cycle-a/">Cycle</a><a href="/download.zip">ZIP</a>'),
    "/bridge/": doc("/bridge/", `<a href="${A}">A</a>`, '<meta name="robots" content="noindex">'),
    [A]: doc(A),
    "/cycle-a/": doc("/cycle-a/", "", '<meta http-equiv="refresh" content="0;url=/cycle-b/">'),
    "/cycle-b/": doc("/cycle-b/", "", '<meta http-equiv="refresh" content="0;url=/cycle-a/">'),
  });
  assert.equal(result.pages.find(({ path }) => path === A).depth, 2);
  assert.deepEqual(result.pages.find(({ path }) => path === A).shortestPath, ["/", "/bridge/", A]);
  assert.equal(result.summary.otherExcludedPages, 1);
  assert.equal(result.unresolvedLinks.find(({ target }) => target === "/cycle-a/").reason, "redirect-cycle");
  assert.equal(result.unresolvedLinks.find(({ target }) => target === "/download.zip").reason, "not-an-html-page");
});

test("output is deterministic for the same built pages and provenance", async (t) => {
  const pages = { [A]: doc(A, article(`<a href="${B}">B</a>`)), "/": doc("/", `<a href="${A}">A</a>`), [B]: doc(B) };
  const options = { includeEdges: true, provenance: { commit: "fixture" } };
  assert.deepEqual(await fixture(t, pages, options), await fixture(t, Object.fromEntries(Object.entries(pages).reverse()), options));
});

test("sitemap membership is separate from anchor reachability, and existing linked assets are not missing pages", async (t) => {
  const namespace = "http://www.sitemaps.org/schemas/sitemap/0.9";
  const result = await fixture(t, {
    "/": doc("/", `<a href="${A}">A</a><a href="/rss.xml">RSS</a>`),
    [A]: doc(A),
    [B]: doc(B),
    "/rss.xml": '<rss version="2.0"/>',
    "/sitemap-index.xml": `<sitemapindex xmlns="${namespace}"><sitemap><loc>${ORIGIN}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    "/sitemap-0.xml": `<urlset xmlns="${namespace}"><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}${B}</loc></url><url><loc>${ORIGIN}/missing/</loc></url></urlset>`,
  });
  assert.equal(result.pages.find(({ path }) => path === B).inSitemap, true);
  assert.equal(result.pages.find(({ path }) => path === B).depth, null);
  assert.equal(result.pages.find(({ path }) => path === A).inSitemap, false);
  assert.equal(result.summary.canonicalPagesMissingFromSitemap, 1);
  assert.equal(result.summary.sitemapPagesMissingCanonicalHtml, 1);
  assert.equal(result.unresolvedLinks.length, 0);
  assert.deepEqual(result.nonHtmlLinks, [{ path: "/rss.xml", sourcePages: 1, anchorOccurrences: 1 }]);
});
