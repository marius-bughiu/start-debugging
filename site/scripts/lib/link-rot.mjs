import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { parseFragment } from "parse5";

const parser = unified().use(remarkParse).use(remarkGfm);
const USER_AGENT = "Mozilla/5.0 (compatible; StartDebuggingLinkCheck/2.0; +https://startdebugging.net/)";

/** Strip fragments only: the server never receives them. Preserve paths/queries. */
export function requestUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
function visit(node, callback) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}
const identifier = (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
const label = (node) => node.value ?? node.alt ?? (node.children ?? []).map(label).join("");

/**
 * Rendered external links: references, GFM autolinks and HTML anchors included;
 * code, image sources and frontmatter excluded. Blank YAML to retain positions.
 */
export function extractExternalLinks(markdown, source) {
  const input = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, (header) => header.replace(/[^\r\n]/g, " "));
  const tree = parser.parse(input);
  const definitions = new Map();
  visit(tree, (node) => {
    if (node.type === "definition" && !definitions.has(identifier(node.identifier))) definitions.set(identifier(node.identifier), node);
  });
  const links = [];
  const hiddenHtmlTags = [];
  function add(url, text, node, kind, definition) {
    const network = requestUrl(url);
    if (!network) return;
    links.push({ url, requestUrl: network, text, source, kind,
      line: node.position?.start.line ?? null, column: node.position?.start.column ?? null,
      ...(definition ? { definitionLine: definition.position?.start.line ?? null } : {}),
    });
  }
  visit(tree, (node) => {
    // remark splits inline HTML into separate opening/closing nodes. Keep their
    // code context so an anchor inside <code> is excluded just like fenced code.
    if (node.type === "html") {
      const boundary = node.value.match(/^<(\/?)(pre|code|script|style|template)(?:\s[^>]*)?>$/i);
      if (boundary) {
        const tag = boundary[2].toLowerCase();
        if (!boundary[1]) hiddenHtmlTags.push(tag);
        else {
          const start = hiddenHtmlTags.lastIndexOf(tag);
          if (start >= 0) hiddenHtmlTags.splice(start);
        }
        return;
      }
    }
    if (hiddenHtmlTags.length) return;
    if (node.type === "link") add(node.url, label(node), node, "markdown");
    if (node.type === "linkReference") {
      const definition = definitions.get(identifier(node.identifier));
      if (definition) add(definition.url, label(node), node, "reference", definition);
    }
    if (node.type === "html") {
      const walk = (element) => {
        if (["pre", "code", "script", "style", "template"].includes(element.tagName)) return;
        if (element.tagName === "a") {
          const href = element.attrs?.find((attr) => attr.name === "href")?.value;
          if (href) add(href, (element.childNodes ?? []).map((child) => child.value ?? "").join(""), node, "html");
        }
        for (const child of element.childNodes ?? []) walk(child);
      };
      walk(parseFragment(node.value));
    }
  });
  return links;
}

/** One request per URL, with every original occurrence retained. */
export function indexLinks(occurrences) {
  const index = new Map();
  for (const occurrence of occurrences) {
    const key = occurrence.requestUrl ?? requestUrl(occurrence.url);
    if (!key) continue;
    if (!index.has(key)) index.set(key, { url: key, sources: [], occurrences: [] });
    const item = index.get(key);
    if (!item.sources.includes(occurrence.source)) item.sources.push(occurrence.source);
    item.occurrences.push(occurrence);
  }
  return index;
}

/** Recover old regex-truncated URLs only when current source matches uniquely. */
export function selectRecheckUrls(index, previous) {
  const urls = new Set(), recovered = [], absent = [];
  for (const issue of previous) {
    const key = requestUrl(issue.url);
    if (key && index.has(key)) { urls.add(key); continue; }
    const matches = [...index.values()].filter((item) => item.occurrences.some((occurrence) =>
      occurrence.url.startsWith(issue.url) && (issue.sources ?? []).includes(occurrence.source)));
    if (matches.length === 1) {
      urls.add(matches[0].url);
      recovered.push({ legacyUrl: issue.url, url: matches[0].url });
    } else absent.push({ url: issue.url, reason: matches.length ? "ambiguous-extraction" : "not-in-current-content" });
  }
  return { urls: [...urls].sort(), recovered, absent };
}

async function request(url, method, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, redirect: "follow", signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
    });
    const result = { method, status: response.status, finalUrl: response.url || url,
      redirected: response.redirected || (response.url && response.url !== url) || false,
      ...(response.headers.get("retry-after") ? { retryAfter: response.headers.get("retry-after") } : {}),
    };
    // Status checks never need to download the complete response body.
    await response.body?.cancel().catch(() => {});
    return result;
  } catch (error) {
    return { method, status: null, error: controller.signal.aborted ? "timeout" : String(error.cause?.code ?? error.code ?? error.message) };
  } finally { clearTimeout(timer); }
}

/** Every failed HEAD, including 404 and network errors, gets an independent GET. */
export async function checkUrl(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  const attempts = [await request(url, "HEAD", { fetchImpl, timeoutMs })];
  if (!(attempts[0].status >= 200 && attempts[0].status < 300)) attempts.push(await request(url, "GET", { fetchImpl, timeoutMs }));
  const result = attempts.at(-1);
  const ok = result.status >= 200 && result.status < 300;
  let classification;
  if (ok) classification = result.redirected ? "redirect" : "healthy";
  else if (result.method === "GET" && [404, 410].includes(result.status)) classification = "confirmed-missing";
  else if (result.status === 429) classification = "rate-limited";
  else if ([401, 403, 406, 418, 451].includes(result.status)) classification = "blocked";
  else if (result.status >= 500) classification = "transient-server-error";
  else if (result.status >= 300 && result.status < 400) classification = "unresolved-redirect";
  else if (result.error === "timeout") classification = "timeout";
  else if (result.error) classification = "network-error";
  else classification = "unverified-client-error";
  return { url, status: result.status, ok, classification,
    ...(result.error ? { error: result.error } : {}), ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
    checkedAt: new Date().toISOString(), elapsedMs: Date.now() - started, attempts,
  };
}

/** Bound total concurrency and per-host load; preserve input order. */
export async function auditUrls(urls, { concurrency = 6, perHost = 2, check = checkUrl, onResult = () => {} } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(perHost) || perHost < 1) throw new Error("Invalid concurrency");
  const hosts = new Map(), results = new Array(urls.length);
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const index = cursor++, url = urls[index], host = new URL(url).hostname;
      if (!hosts.has(host)) hosts.set(host, { active: 0, waiting: [] });
      const gate = hosts.get(host);
      if (gate.active >= perHost) await new Promise((resolve) => gate.waiting.push(resolve));
      else gate.active++;
      try { results[index] = await check(url); onResult(results[index], index); }
      finally { const next = gate.waiting.shift(); if (next) next(); else gate.active--; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}
