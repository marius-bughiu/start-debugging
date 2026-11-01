import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "parse5";
import { SaxesParser } from "saxes";

const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const LANGUAGES = new Set(("aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu").split(" "));
const REGIONS = new Set(("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" "));
const scriptNames = new Intl.DisplayNames(["en"], { type: "script", fallback: "code" });
const tokens = (value = "") => value.toLowerCase().trim().split(/\s+/);
const meaningful = (value) => value.replace(/[\s\u200b]+/g, "").length > 0;

/** Hreflang uses ISO 639-1, an optional script and ISO 3166-1 alpha-2 region. */
export function validHreflang(value) {
  if (value.toLowerCase() === "x-default") return true;
  const match = /^([a-z]{2})(?:-([a-z]{4}))?(?:-([a-z]{2}))?$/i.exec(value);
  if (!match || !LANGUAGES.has(match[1].toLowerCase())) return false;
  if (match[2]) {
    const script = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
    if (scriptNames.of(script) === script) return false;
  }
  return !match[3] || REGIONS.has(match[3].toUpperCase());
}

function textContent(node) {
  if (node.nodeName === "#text") return node.value;
  if (["script", "style", "template"].includes(node.tagName)) return "";
  return (node.childNodes ?? []).map(textContent).join("");
}

/** Read actual HTML elements, independently of attribute order, quoting or case. */
export function readPageMetadata(html) {
  const result = { language: "", canonicals: [], titles: [], headings: [], descriptions: [], robots: [], redirects: [], alternates: [] };
  const visit = (node, inHead = false) => {
    const attrs = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
    inHead ||= node.tagName === "head";
    if (node.tagName === "html") result.language = attrs.lang ?? "";
    if (node.tagName === "h1") result.headings.push(textContent(node));
    if (inHead) {
      if (node.tagName === "title") result.titles.push(textContent(node));
      if (node.tagName === "link") {
        const rel = tokens(attrs.rel);
        if (rel.includes("canonical")) result.canonicals.push(attrs.href ?? "");
        // Standard RSS alternates do not have hreflang and are not page translations.
        if (rel.includes("alternate") && Object.hasOwn(attrs, "hreflang")) {
          result.alternates.push({ language: attrs.hreflang, href: attrs.href ?? "" });
        }
      }
      if (node.tagName === "meta") {
        if (attrs.name?.toLowerCase() === "description") result.descriptions.push(attrs.content ?? "");
        if (/^(?:robots|googlebot(?:-news)?|bingbot)$/i.test(attrs.name ?? "")) result.robots.push(attrs.content ?? "");
        if (attrs["http-equiv"]?.toLowerCase() === "refresh") result.redirects.push(attrs.content ?? "");
      }
    }
    for (const child of node.childNodes ?? []) visit(child, inHead);
  };
  visit(parse(html));
  return result;
}

/** Namespace-aware XML parsing decodes escaped URLs and rejects malformed XML. */
export function readSitemap(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let kind;
  let entry;
  let locText;
  const entries = [];
  parser.on("opentag", (tag) => {
    stack.push(tag);
    if (stack.length === 1) {
      if (tag.uri !== SITEMAP_NS || !["urlset", "sitemapindex"].includes(tag.local)) throw new Error("Expected a sitemap urlset or sitemapindex");
      kind = tag.local;
    } else if (stack.length === 2 && tag.uri === SITEMAP_NS && tag.local === (kind === "urlset" ? "url" : "sitemap")) {
      entry = { locations: [], alternates: [] };
    } else if (stack.length === 3 && entry) {
      if (tag.uri === SITEMAP_NS && tag.local === "loc") locText = "";
      if (tag.uri === XHTML_NS && tag.local === "link") {
        const attrs = Object.fromEntries(Object.values(tag.attributes).map(({ local, value }) => [local, value]));
        if (tokens(attrs.rel).includes("alternate")) entry.alternates.push({ language: attrs.hreflang ?? "", href: attrs.href ?? "" });
      }
    }
  });
  const appendText = (text) => { if (locText !== undefined) locText += text; };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("closetag", (tag) => {
    if (stack.length === 3 && tag.uri === SITEMAP_NS && tag.local === "loc" && locText !== undefined) {
      entry.locations.push(locText.trim());
      locText = undefined;
    }
    if (stack.length === 2 && entry) {
      if (entry.locations.length !== 1 || !entry.locations[0]) throw new Error("Each sitemap entry must have exactly one nonempty loc");
      entries.push({ url: entry.locations[0], alternates: entry.alternates });
      entry = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  if (!kind) throw new Error("Empty sitemap document");
  return { kind, entries };
}

function absoluteSiteUrl(value, origin) {
  if (!/^https?:\/\//i.test(value)) throw new Error("expected an absolute HTTP(S) URL");
  const parsed = new URL(value);
  if (parsed.origin !== origin) throw new Error("expected origin " + origin);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("credentials, query strings and fragments are not indexable page URLs");
  return parsed.href;
}

function outputPath(distDir, value, html = false) {
  const segments = new URL(value).pathname.split("/").map(decodeURIComponent);
  if (segments.some((segment) => /[\\/\0]/.test(segment) || segment === "." || segment === "..")) throw new Error("unsafe generated-file path");
  let relative = segments.join("/").replace(/^\//, "");
  if (html && !relative.endsWith(".html")) relative = relative.replace(/\/$/, "") + "/index.html";
  return path.join(distDir, relative);
}

async function mapLimit(values, concurrency, callback) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) await callback(values[cursor++]);
  }));
}

function sameLanguage(declared, actual) {
  // HTML "en" and sitemap "en-US" both describe English. Explicit regions or
  // scripts must agree when both sides specify one.
  try {
    const left = new Intl.Locale(declared);
    const right = new Intl.Locale(actual);
    return left.language === right.language && (!left.region || !right.region || left.region === right.region)
      && (!left.script || !right.script || left.script === right.script);
  } catch { return false; }
}

/** No network requests or writes; bounded reads keep full production builds cheap. */
export async function validateSeoBuild({ distDir, origin = "https://startdebugging.net", sitemapFile = "sitemap-index.xml", concurrency = 24 }) {
  origin = new URL(origin).origin;
  const errors = [];
  const fail = (code, url, message) => errors.push({ code, url, message });
  const sitemapPages = new Map();
  const readIndexes = new Set();
  const readIndex = async (file, source) => {
    if (readIndexes.has(file)) { fail("sitemap-cycle", source, "sitemap is referenced more than once"); return; }
    readIndexes.add(file);
    let sitemap;
    try { sitemap = readSitemap(await fs.readFile(file, "utf8")); }
    catch (error) { fail("sitemap-read", source, error.message); return; }
    for (const entry of sitemap.entries) {
      let entryUrl;
      try { entryUrl = absoluteSiteUrl(entry.url, origin); }
      catch (error) { fail("sitemap-url", entry.url, error.message); continue; }
      if (sitemap.kind === "sitemapindex") {
        try { await readIndex(outputPath(distDir, entryUrl), entryUrl); }
        catch (error) { fail("sitemap-read", entryUrl, error.message); }
      } else if (sitemapPages.has(entryUrl)) {
        fail("sitemap-duplicate", entryUrl, "URL appears more than once in the sitemap");
      } else sitemapPages.set(entryUrl, entry.alternates);
    }
  };
  await readIndex(path.join(distDir, sitemapFile), sitemapFile);
  if (!sitemapPages.size) fail("sitemap-empty", sitemapFile, "no indexable page URLs found");

  const pages = new Map();
  const normalizedSets = { html: new Map(), sitemap: new Map() };
  const normalizeAlternates = (url, alternates, source) => {
    const result = new Map();
    for (const alternate of alternates) {
      const language = alternate.language.toLowerCase();
      if (!validHreflang(alternate.language)) fail("hreflang-code", url, source + ": invalid language code " + JSON.stringify(alternate.language));
      if (result.has(language)) fail("hreflang-duplicate", url, source + ": duplicate " + language + " alternate");
      try { result.set(language, absoluteSiteUrl(alternate.href, origin)); }
      catch (error) { fail("hreflang-url", url, source + ": " + language + " " + JSON.stringify(alternate.href) + ": " + error.message); }
    }
    normalizedSets[source].set(url, result);
    return result;
  };
  const checkMetadata = (url, page) => {
    if (page.canonicals.length !== 1) fail("canonical-count", url, "expected one canonical link, found " + page.canonicals.length);
    for (const canonical of page.canonicals) {
      try {
        if (absoluteSiteUrl(canonical, origin) !== url) fail("canonical-self", url, "canonical points to " + canonical);
      } catch (error) { fail("canonical-url", url, JSON.stringify(canonical) + ": " + error.message); }
    }
    if (page.titles.length !== 1 || !page.titles.every(meaningful)) fail("title", url, "expected one nonempty title");
    if (!page.headings.length || !page.headings.some(meaningful)) fail("h1", url, "missing or empty h1");
    if (page.descriptions.length !== 1 || !page.descriptions.every(meaningful)) fail("description", url, "expected one nonempty meta description");
    if (page.robots.some((robots) => /\b(?:noindex|none)\b/i.test(robots))) fail("noindex", url, "an indexable page declares noindex");
    if (page.redirects.length) fail("redirect", url, "an indexable page contains a meta refresh redirect");
  };

  // Include language destinations outside the sitemap: check their content and
  // return links as well as existence. No fixed number of locales is required.
  let pending = [...sitemapPages.keys()];
  for (const [url, alternates] of sitemapPages) {
    for (const target of normalizeAlternates(url, alternates, "sitemap").values()) pending.push(target);
  }
  while (pending.length) {
    const batch = [...new Set(pending)].filter((url) => !pages.has(url));
    pending = [];
    await mapLimit(batch, concurrency, async (url) => {
      pages.set(url, null);
      let page;
      try { page = readPageMetadata(await fs.readFile(outputPath(distDir, url, true), "utf8")); }
      catch (error) { fail("page-read", url, error.message); return; }
      pages.set(url, page);
      checkMetadata(url, page);
      pending.push(...normalizeAlternates(url, page.alternates, "html").values());
    });
  }

  for (const [source, sets] of Object.entries(normalizedSets)) {
    for (const [url, alternates] of sets) {
      if (!alternates.size) continue; // Intentionally untranslated pages are valid.
      if (![...alternates].some(([language, target]) => language !== "x-default" && target === url)) {
        fail("hreflang-self", url, source + ": alternate set has no language-specific self reference");
      }
      for (const [language, target] of alternates) {
        const page = pages.get(target);
        if (!page) continue; // page-read already identifies the missing destination.
        if (language !== "x-default" && !sameLanguage(language, page.language)) fail("hreflang-language", url, source + ": " + language + " points to a page with html lang=" + JSON.stringify(page.language) + " (" + target + ")");
        const targetSet = sets.get(target);
        if (!targetSet || targetSet.size !== alternates.size || [...alternates].some(([code, href]) => targetSet.get(code) !== href)) {
          fail("hreflang-return", url, source + ": " + target + " does not return the same alternate set");
        }
      }
    }
  }
  errors.sort((a, b) => a.url.localeCompare(b.url) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  return {
    sitemapPages: sitemapPages.size,
    checkedPages: pages.size,
    htmlAlternateLinks: [...normalizedSets.html.values()].reduce((sum, entries) => sum + entries.size, 0),
    sitemapAlternateLinks: [...normalizedSets.sitemap.values()].reduce((sum, entries) => sum + entries.size, 0),
    errors,
  };
}
