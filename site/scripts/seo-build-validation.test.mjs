import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPageMetadata, readSitemap, validHreflang, validateSeoBuild } from "./lib/seo-build-validation.mjs";

const ORIGIN = "https://startdebugging.net";
const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const absolute = (pathname) => ORIGIN + pathname;
const links = (alternates) => alternates.map(([language, href]) => '<link href="' + escape(href) + '" hreflang="' + language + '" rel="alternate">').join("");
const document = ({ url, language = "en", alternates = [], head = "", body = "<h1>A <em>useful</em> heading</h1>", transform = (html) => html }) => transform(
  '<!doctype html><html lang="' + language + '"><head><title>A useful title</title><meta content="A &quot;useful&quot; description" name="description">'
  + '<link href="' + escape(url) + '" rel="canonical"><link rel="alternate" type="application/rss+xml" href="' + ORIGIN + '/rss.xml">'
  + links(alternates) + head + "</head><body>" + body + "</body></html>"
);
const urlset = (entries) => '<urlset xmlns="' + NS + '" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
  + entries.map(({ url, alternates = [] }) => "<url><loc>" + escape(url) + "</loc>"
    + alternates.map(([language, href]) => '<xhtml:link rel="alternate" hreflang="' + language + '" href="' + escape(href) + '"/>').join("")
    + "</url>").join("") + "</urlset>";

async function fixture(t, pages, { entries = pages, extras = {}, sitemap } = {}) {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-build-fixture-"));
  t.after(() => fs.rm(distDir, { recursive: true, force: true }));
  const write = async (relative, contents) => {
    const file = path.join(distDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  await write("sitemap-index.xml", '<sitemapindex xmlns="' + NS + '"><sitemap><loc>' + ORIGIN + "/sitemap-0.xml</loc></sitemap></sitemapindex>");
  await write("sitemap-0.xml", sitemap ?? urlset(entries.map(({ url, sitemapAlternates }) => ({ url, alternates: sitemapAlternates ?? [] }))));
  for (const page of pages) await write(new URL(page.url).pathname.replace(/^\//, "") + "index.html", document(page));
  for (const [relative, contents] of Object.entries(extras)) await write(relative, contents);
  return { distDir, result: await validateSeoBuild({ distDir }) };
}
const codes = (result) => result.errors.map(({ code }) => code);
const article = absolute("/article/");
const german = absolute("/de/article/");

test("untranslated pages and standard RSS alternates pass; redirects outside the sitemap are ignored", async (t) => {
  const { result } = await fixture(t, [{ url: article }], {
    extras: { "old-alias/index.html": '<meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=/article/">' },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sitemapPages, 1);
  assert.equal(result.checkedPages, 1);
  assert.equal(result.htmlAlternateLinks, 0);
});

test("partial translation sets pass with self/reciprocal links and HTML/XML region variants", async (t) => {
  const alternates = [["en", article], ["de", german], ["x-default", article]];
  const sitemapAlternates = [["en-US", article], ["de-DE", german]];
  const { result } = await fixture(t, [
    { url: article, alternates, sitemapAlternates },
    { url: german, language: "de", alternates, sitemapAlternates },
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.htmlAlternateLinks, 6);
  assert.equal(result.sitemapAlternateLinks, 4);
});

test("HTML parsing handles reordered attributes, unquoted values, entities and comments", () => {
  const metadata = readPageMetadata('<html lang=en><head><!-- <link rel=canonical href="wrong"> -->'
    + '<LINK HREF="https://startdebugging.net/a/" REL=CANONICAL><TITLE>A &amp; B</TITLE>'
    + '<META CONTENT="&quot;Foo&quot; isn&apos;t valid" NAME=DESCRIPTION></head><body>'
    + '<h1><span>A &amp; B</span></h1><pre>&lt;meta name=robots content=noindex&gt;</pre></body></html>');
  assert.deepEqual(metadata.canonicals, [absolute("/a/")]);
  assert.deepEqual(metadata.titles, ["A & B"]);
  assert.deepEqual(metadata.descriptions, ['"Foo" isn\'t valid']);
  assert.deepEqual(metadata.headings, ["A & B"]);
  assert.deepEqual(metadata.robots, []);
});

for (const [label, transform, code] of [
  ["missing canonical", (html) => html.replace(/<link href="[^"]+" rel="canonical">/, ""), "canonical-count"],
  ["duplicate canonical", (html) => html.replace("</head>", '<link rel=canonical href="' + article + '"></head>'), "canonical-count"],
  ["non-self canonical", (html) => html.replace('href="' + article + '" rel="canonical"', 'href="' + german + '" rel="canonical"'), "canonical-self"],
  ["external canonical", (html) => html.replace('href="' + article + '" rel="canonical"', 'href="https://example.com/article/" rel="canonical"'), "canonical-url"],
  ["relative canonical", (html) => html.replace('href="' + article + '" rel="canonical"', 'href="/article/" rel="canonical"'), "canonical-url"],
  ["empty canonical", (html) => html.replace('href="' + article + '" rel="canonical"', 'href="" rel="canonical"'), "canonical-url"],
  ["empty title", (html) => html.replace("<title>A useful title</title>", "<title>&nbsp; </title>"), "title"],
  ["missing title", (html) => html.replace("<title>A useful title</title>", ""), "title"],
  ["empty heading", (html) => html.replace(/<h1>.*<\/h1>/, "<h1><span> &nbsp; </span></h1>"), "h1"],
  ["missing heading", (html) => html.replace(/<h1>.*<\/h1>/, ""), "h1"],
  ["empty description", (html) => html.replace('content="A &quot;useful&quot; description"', 'content=" &nbsp; "'), "description"],
  ["missing description", (html) => html.replace(/<meta content="[^"]+" name="description">/, ""), "description"],
  ["robots noindex after an index directive", (html) => html.replace("</head>", '<meta name=robots content=index><meta content="noindex,follow" name=ROBOTS></head>'), "noindex"],
  ["Googlebot none", (html) => html.replace("</head>", '<meta content=none name=googlebot></head>'), "noindex"],
  ["redirect", (html) => html.replace("</head>", '<meta content="0;url=/elsewhere/" http-equiv=refresh></head>'), "redirect"],
]) {
  test(label + " fails the build validation", async (t) => {
    const { result } = await fixture(t, [{ url: article, transform }]);
    assert.ok(codes(result).includes(code), JSON.stringify(result.errors));
  });
}

test("missing generated HTML is fatal", async (t) => {
  const { result } = await fixture(t, [], { entries: [{ url: article }] });
  assert.ok(codes(result).includes("page-read"));
});

test("hreflang validates ISO language, region and script codes without accepting arbitrary BCP47", () => {
  for (const language of ["en", "EN-us", "pt-BR", "zh-Hant", "zh-Hans-CN", "x-default"]) assert.equal(validHreflang(language), true, language);
  for (const language of ["", "en_US", "zz", "en-UK", "en-USA", "en-001", "english", "x-other", "pt-BR-extra", "en-Abcd"]) assert.equal(validHreflang(language), false, language);
});

test("invalid, duplicate and external language links are fatal", async (t) => {
  const { result } = await fixture(t, [{
    url: article, alternates: [["en", article], ["EN", article], ["en_US", article], ["de", "https://example.com/de/article/"]],
  }]);
  for (const code of ["hreflang-code", "hreflang-duplicate", "hreflang-url"]) assert.ok(codes(result).includes(code), code);
});

test("missing language destination fails, even when not listed in the sitemap", async (t) => {
  const { result } = await fixture(t, [{ url: article, alternates: [["en", article], ["de", german]] }]);
  assert.ok(result.errors.some(({ code, url }) => code === "page-read" && url === german));
});

test("alternate sets require a real-language self reference; x-default alone is insufficient", async (t) => {
  const { result } = await fixture(t, [{ url: article, alternates: [["x-default", article]] }]);
  assert.ok(codes(result).includes("hreflang-self"));
});

test("a destination must return the complete same HTML alternate set", async (t) => {
  const { result } = await fixture(t, [
    { url: article, alternates: [["en", article], ["de", german]] },
    { url: german, language: "de", alternates: [["de", german]] },
  ]);
  assert.ok(result.errors.some(({ code, message }) => code === "hreflang-return" && message.startsWith("html:")));
});

test("sitemap alternate reciprocity is checked independently of valid HTML links", async (t) => {
  const alternates = [["en", article], ["de", german]];
  const { result } = await fixture(t, [
    { url: article, alternates, sitemapAlternates: alternates },
    { url: german, language: "de", alternates },
  ]);
  assert.ok(result.errors.some(({ code, message }) => code === "hreflang-return" && message.startsWith("sitemap:")));
});

test("language links cannot point to a different-language page", async (t) => {
  const alternates = [["en", article], ["de", german]];
  const { result } = await fixture(t, [{ url: article, alternates }, { url: german, language: "es", alternates }]);
  assert.ok(codes(result).includes("hreflang-language"));
});

test("language destinations outside the sitemap still need indexable self-canonical content", async (t) => {
  const alternates = [["en", article], ["de", german]];
  const { result } = await fixture(t, [
    { url: article, alternates },
    { url: german, language: "de", alternates, head: '<meta name=robots content=noindex>' },
  ], { entries: [{ url: article }] });
  assert.ok(result.errors.some(({ code, url }) => code === "noindex" && url === german));
});

test("sitemap parsing respects namespaces and decodes XML entities", () => {
  const parsed = readSitemap('<s:urlset xmlns:s="' + NS + '"><s:url><s:loc>https://startdebugging.net/a&amp;b/</s:loc></s:url></s:urlset>');
  assert.equal(parsed.entries[0].url, absolute("/a&b/"));
  assert.throws(() => readSitemap('<urlset xmlns="' + NS + '"><url></urlset>'));
});

test("duplicate sitemap URLs fail", async (t) => {
  const { result } = await fixture(t, [{ url: article }], { entries: [{ url: article }, { url: article }] });
  assert.ok(codes(result).includes("sitemap-duplicate"));
});

test("missing child sitemap is fatal", async (t) => {
  const { distDir } = await fixture(t, [{ url: article }]);
  await fs.unlink(path.join(distDir, "sitemap-0.xml"));
  const result = await validateSeoBuild({ distDir });
  assert.ok(codes(result).includes("sitemap-read"));
});

test("cross-origin sitemap URLs and encoded path traversal fail without reading outside dist", async (t) => {
  const { result } = await fixture(t, [], {
    entries: [{ url: "https://example.com/article/" }, { url: absolute("/bad%2f..%2fpath/") }],
  });
  assert.ok(codes(result).includes("sitemap-url"));
  assert.ok(result.errors.some(({ code, message }) => code === "page-read" && message.includes("unsafe")));
});
