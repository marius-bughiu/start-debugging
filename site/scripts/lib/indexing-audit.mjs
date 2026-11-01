import { JSDOM } from "jsdom";

export function validateCohort(cohort) {
  if (cohort.origin !== "https://startdebugging.net" || cohort.siteUrl !== "sc-domain:startdebugging.net") {
    throw new Error("Unexpected Search Console property or origin");
  }
  if (!Array.isArray(cohort.urls) || !cohort.urls.length) throw new Error("The cohort must contain URLs");
  const seen = new Set();
  return cohort.urls.map((entry) => {
    const url = new URL(entry.path, cohort.origin);
    if (!entry.path.startsWith("/") || entry.path.startsWith("//") || url.origin !== cohort.origin ||
        url.search || url.hash || !url.pathname.endsWith("/") || seen.has(url.href)) {
      throw new Error(`Invalid or duplicate cohort path: ${entry.path}`);
    }
    seen.add(url.href);
    return { ...entry, url: url.href };
  });
}

// URL Inspection's verdict is language-independent. Coverage text is useful
// evidence, but must not turn an API error into a claim that a page is absent.
export function indexState(result) {
  if (!result || result.error) return "unknown";
  if (result.verdict === "PASS") return "indexed";
  if (["NEUTRAL", "FAIL"].includes(result.verdict)) return "not-indexed";
  return "unknown";
}

export function compareInspection(previous, current) {
  const before = indexState(previous);
  const after = indexState(current);
  return { before, after, change: before === "unknown" || after === "unknown" ? "unavailable" :
    before === after ? "unchanged" : after === "indexed" ? "gained-indexing" : "lost-indexing" };
}

export function summarizeAudit(results) {
  return {
    total: results.length,
    indexed: results.filter((row) => row.comparison.after === "indexed").length,
    notIndexed: results.filter((row) => row.comparison.after === "not-indexed").length,
    unknown: results.filter((row) => row.comparison.after === "unknown").length,
    gained: results.filter((row) => row.comparison.change === "gained-indexing").length,
    lost: results.filter((row) => row.comparison.change === "lost-indexing").length,
    liveErrors: results.filter((row) => row.live?.error || !row.live?.status).length,
    liveIssues: results.filter((row) => row.live?.error || row.live?.status !== 200 ||
      row.live?.finalUrl !== row.url || !row.live?.selfCanonical || row.live?.noindex).length,
  };
}

export function inspectLiveHtml(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const canonicals = [...doc.querySelectorAll('link[rel~="canonical"]')]
    .map((node) => node.getAttribute("href")?.trim() ? node.href : "");
  const robots = [...doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]')]
    .map((node) => node.content);
  const result = {
    canonicals,
    selfCanonical: canonicals.length === 1 && canonicals[0] === url,
    robotsMeta: robots,
    noindex: robots.some((value) => /(?:^|[\s,])(?:noindex|none)(?:$|[\s,])/i.test(value)),
    title: doc.title,
    h1Count: doc.querySelectorAll("h1").length,
    language: doc.documentElement.lang,
    hreflang: [...doc.querySelectorAll('link[rel~="alternate"][hreflang]')]
      .map((node) => ({ language: node.hreflang, url: node.href })),
  };
  dom.window.close();
  return result;
}
