#!/usr/bin/env node
/**
 * Read-only external-link audit. Default: check the whole blog; never edit posts.
 *   npm run link-rot-check -- --extract-only
 *   npm run link-rot-check -- --recheck --limit 50
 *   npm run link-rot-check -- --url https://example.com/page --timeout-ms 10000
 *   npm run link-rot-check -- --recheck /path/to/previous-issues.json
 *
 * Legacy issues retain url/status/ok/error/sources. Timestamped audit sidecars
 * record all outcomes, source positions and options. Only a GET 404/410 means
 * confirmed-missing; blocked and transient failures are never removal advice.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extractExternalLinks, indexLinks, selectRecheckUrls, requestUrl, checkUrl, auditUrls } from "./lib/link-rot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BLOG_DIR = path.join(ROOT, "site/src/content/blog");
const DEFAULT_OUTPUT = path.join(ROOT, "content-strategy/link-rot-report.json");
const options = { extractOnly: false, recheck: null, urls: [], limit: null, timeoutMs: 10_000, concurrency: 6, perHost: 2, output: null };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const [flag, inline] = args[i].split(/=(.*)/s);
  const value = () => {
    const result = inline ?? args[++i];
    if (!result || result.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return result;
  };
  if (flag === "--extract-only") options.extractOnly = true;
  else if (flag === "--recheck") options.recheck = inline ?? (args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : DEFAULT_OUTPUT);
  else if (flag === "--url") options.urls.push(value());
  else if (flag === "--output") options.output = path.resolve(value());
  else if (["--limit", "--timeout-ms", "--concurrency", "--per-host"].includes(flag)) {
    const key = { "--limit": "limit", "--timeout-ms": "timeoutMs", "--concurrency": "concurrency", "--per-host": "perHost" }[flag];
    const n = Number(value());
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
    options[key] = n;
  } else if (flag === "--help") {
    console.log("Usage: link-rot-check.mjs [--extract-only] [--recheck [issues.json]] [--url URL] [--limit N] [--timeout-ms N] [--concurrency N] [--per-host N] [--output issues.json]");
    process.exit(0);
  } else throw new Error(`Unknown argument: ${flag}`);
}
async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
  }
  return files.sort();
}

const startedAt = new Date().toISOString(), stamp = startedAt.replace(/[:.]/g, "-");
const files = await walk(BLOG_DIR), occurrences = [];
const sourceHash = createHash("sha256");
for (const file of files) {
  const source = path.relative(ROOT, file).replaceAll("\\", "/");
  const markdown = await fs.readFile(file, "utf8");
  sourceHash.update(source).update("\0").update(markdown).update("\0");
  occurrences.push(...extractExternalLinks(markdown, source));
}
const index = indexLinks(occurrences);
let selection = { urls: [...index.keys()].sort(), recovered: [], absent: [] }, previousCount = null;
if (options.recheck) {
  const report = JSON.parse(await fs.readFile(path.resolve(options.recheck), "utf8"));
  const rows = Array.isArray(report) ? report : report.results;
  if (!Array.isArray(rows)) throw new Error("Recheck input must be an issues array or an audit with results");
  previousCount = rows.length;
  selection = selectRecheckUrls(index, rows);
}
if (options.urls.length) {
  selection.urls = [...new Set(options.urls.map((url) => {
    const key = requestUrl(url);
    if (!key || !index.has(key)) throw new Error(`URL is not a current article link: ${url}`);
    return key;
  }))].sort();
}
const selectedBeforeLimit = selection.urls.length;
if (options.limit) selection.urls = selection.urls.slice(0, options.limit);
console.log(`[link-rot] ${files.length} files, ${occurrences.length} occurrences, ${index.size} unique request URLs; ${selection.urls.length} selected`);
if (previousCount !== null) console.log(`[link-rot] Rechecking ${previousCount} previous flags; ${selection.recovered.length} regex-truncated URLs recovered; ${selection.absent.length} no longer found`);

// Rechecks cover only a previous report's scope, even when every row is checked.
// Keep the canonical full-audit report unless the caller explicitly selects it.
const partial = !!options.recheck || !!options.urls.length || selection.urls.length < selectedBeforeLimit;
const output = options.output ?? (partial ? path.join(ROOT, `content-strategy/link-rot-report-${stamp}.json`) : DEFAULT_OUTPUT);
const auditOutput = path.join(path.dirname(output), `${path.basename(output, ".json")}.audit-${stamp}.json`);
let completed = 0;
const checked = options.extractOnly ? [] : await auditUrls(selection.urls, {
  concurrency: options.concurrency, perHost: options.perHost,
  check: (url) => checkUrl(url, { timeoutMs: options.timeoutMs }),
  onResult: () => { if (++completed % 20 === 0) console.log(`[link-rot] Checked ${completed}/${selection.urls.length}`); },
});
const results = checked.map((result) => ({ ...result, sources: index.get(result.url).sources, occurrences: index.get(result.url).occurrences }));
const summary = {};
for (const result of results) summary[result.classification] = (summary[result.classification] ?? 0) + 1;
const audit = {
  schemaVersion: 2, startedAt, generatedAt: new Date().toISOString(),
  policy: "HEAD success accepted; every HEAD failure rechecked with GET; GET 404/410 means confirmed-missing at checkedAt, not proof of permanent removal. Fragments are not checked.",
  options: { ...options, recheck: options.recheck ? path.resolve(options.recheck) : null },
  filesScanned: files.length, extractedOccurrences: occurrences.length, uniqueRequestUrls: index.size,
  sourceDigest: { algorithm: "sha256", value: sourceHash.digest("hex"), input: "Sorted repo-relative filenames and UTF-8 source bodies, each terminated by NUL" },
  previousFlagCount: previousCount, selectedBeforeLimit, selectedUrls: selection.urls,
  recoveredLegacyUrls: selection.recovered, absentLegacyUrls: selection.absent,
  summary, results,
  ...(options.extractOnly ? { extractedLinks: selection.urls.map((url) => index.get(url)) } : {}),
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(auditOutput, JSON.stringify(audit, null, 2) + "\n");
if (!options.extractOnly) {
  const issues = results.filter((result) => !result.ok);
  await fs.writeFile(output, JSON.stringify(issues, null, 2) + "\n");
  console.log(`[link-rot] ${issues.length} unresolved issues (not all dead); ${JSON.stringify(summary)}`);
  console.log(`[link-rot] Issues: ${path.relative(ROOT, output)}`);
}
console.log(`[link-rot] Audit: ${path.relative(ROOT, auditOutput)}`);
