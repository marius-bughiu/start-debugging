import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractExternalLinks, indexLinks, selectRecheckUrls, checkUrl, auditUrls } from "./link-rot.mjs";

test("AST extraction preserves balanced URLs/references and excludes code and metadata", () => {
  const input = [
    "---", 'description: "[metadata](https://ignore.test/meta)"', "---", "",
    "[Apple](https://developer.apple.com/api/method(_:handler:))",
    "[Escaped](https://example.test/a\\(b\\))", "[reference][API] and [API][] and [API]", "",
    '[api]: https://example.test/docs_(v2) "API title"', "",
    "`[inline](https://ignore.test/inline)`", "```md", "[sample](https://ignore.test/fence)", "```",
    "    [indented](https://ignore.test/indented)", "",
    '<a href="https://example.test/html?a=1&amp;b=2">HTML</a>',
    "https://example.test/autolink", "![image](https://ignore.test/image.png)",
  ].join("\n");
  const links = extractExternalLinks(input, "one.md");
  assert.deepEqual(links.map((link) => link.url), [
    "https://developer.apple.com/api/method(_:handler:)", "https://example.test/a(b)",
    "https://example.test/docs_(v2)", "https://example.test/docs_(v2)", "https://example.test/docs_(v2)",
    "https://example.test/html?a=1&b=2", "https://example.test/autolink",
  ]);
  assert.equal(links[0].line, 5);
  assert.equal(links[2].definitionLine, 9);
});

test("dedupe HTTP requests without losing repeated source occurrences or anchors", () => {
  const links = [...extractExternalLinks("[a](https://example.test/page#a) [b](https://example.test/page#b)", "one.md"),
    ...extractExternalLinks("[c](https://example.test/page#a)", "two.md")];
  const index = indexLinks(links);
  assert.equal(index.size, 1);
  const item = index.get("https://example.test/page");
  assert.deepEqual(item.sources, ["one.md", "two.md"]);
  assert.equal(item.occurrences.length, 3);
  assert(item.occurrences[1].url.endsWith("#b"));
});

test("HTML code examples, scripts and comments do not become article links", () => {
  const links = extractExternalLinks([
    '<pre><code><a href="https://ignore.test/code">example</a></code></pre>',
    '<script>const example = \'<a href="https://ignore.test/script">x</a>\';</script>',
    '<!-- <a href="https://ignore.test/comment">x</a> -->',
    'Inline <code><a href="https://ignore.test/inline-html">example</a></code> text.',
    '<a href="https://example.test/real">Real link</a>',
  ].join("\n\n"), "one.md");
  assert.deepEqual(links.map((link) => link.url), ["https://example.test/real"]);
});

test("legacy rechecks use real AST URLs and account for disappeared flags", () => {
  const index = indexLinks(extractExternalLinks("[a](https://example.test/api(v2))", "one.md"));
  const selection = selectRecheckUrls(index, [
    { url: "https://example.test/api(v2", sources: ["one.md"] },
    { url: "https://example.test/absent", sources: ["one.md"] },
  ]);
  assert.deepEqual(selection.urls, ["https://example.test/api(v2)"]);
  assert.equal(selection.recovered.length, 1);
  assert.equal(selection.absent[0].reason, "not-in-current-content");
});

for (const headStatus of [400, 403, 404, 405, 410, 429, 500, 503]) {
  test(`HEAD ${headStatus} cannot create a dead-link finding when GET succeeds`, async () => {
    const methods = [], signals = [];
    let cancelled = 0;
    const result = await checkUrl("https://example.test/", { fetchImpl: async (url, options) => {
      methods.push(options.method); signals.push(options.signal);
      return { status: options.method === "HEAD" ? headStatus : 200, url, headers: new Headers(),
        body: { cancel: async () => { cancelled++; } } };
    } });
    assert.deepEqual(methods, ["HEAD", "GET"]);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(cancelled, 2);
    assert.equal(result.classification, "healthy");
    assert.equal(result.ok, true);
  });
}

test("verified missing, blocked, rate-limited and transient statuses remain distinct", async () => {
  for (const [status, classification] of [[404, "confirmed-missing"], [410, "confirmed-missing"], [403, "blocked"], [429, "rate-limited"], [503, "transient-server-error"], [400, "unverified-client-error"]]) {
    const result = await checkUrl("https://example.test/", { fetchImpl: async () => new Response(null, { status }) });
    assert.equal(result.classification, classification);
    assert.equal(result.attempts.at(-1).method, "GET");
  }
});

test("GET 503 supersedes HEAD 404 and successful redirects are not broken", async () => {
  const transient = await checkUrl("https://example.test/", { fetchImpl: async (_, { method }) => new Response(null, { status: method === "HEAD" ? 404 : 503 }) });
  assert.equal(transient.classification, "transient-server-error");
  const redirect = await checkUrl("https://example.test/old", { fetchImpl: async () => ({
    status: 200, url: "https://example.test/new", redirected: true, headers: new Headers(), body: null,
  }) });
  assert.equal(redirect.classification, "redirect");
  assert.equal(redirect.ok, true);
  assert.equal(redirect.attempts.length, 1);
});

test("HEAD timeouts get a fresh GET deadline and network failures stay unconfirmed", async () => {
  const methods = [];
  const result = await checkUrl("https://example.test/", { timeoutMs: 5, fetchImpl: async (_, { method, signal }) => {
    methods.push(method);
    if (method === "GET") return new Response(null, { status: 200 });
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.equal(result.attempts[0].error, "timeout");
  assert.equal(result.classification, "healthy");
  const failed = await checkUrl("https://example.test/", { fetchImpl: async () => { throw new Error("DNS unavailable"); } });
  assert.equal(failed.classification, "network-error");
});

test("audit respects total and per-host concurrency while preserving order", async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://${i % 2 ? "one" : "two"}.test/${i}`);
  let active = 0, peak = 0;
  const hosts = new Map();
  const results = await auditUrls(urls, { concurrency: 3, perHost: 1, check: async (url) => {
    const host = new URL(url).host;
    active++; peak = Math.max(peak, active);
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
    assert.equal(hosts.get(host), 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; hosts.set(host, hosts.get(host) - 1);
    return { url };
  } });
  assert(peak <= 3 && peak > 1);
  assert.deepEqual(results.map((result) => result.url), urls);
});

test("CLI custom one-row rechecks cannot erase the canonical full report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "link-rot-recheck-"));
  try {
    const site = path.join(root, "site");
    const scripts = path.join(site, "scripts");
    const reports = path.join(root, "content-strategy");
    const currentSite = fileURLToPath(new URL("../../", import.meta.url));
    await fs.mkdir(path.join(scripts, "lib"), { recursive: true });
    await fs.mkdir(path.join(site, "src/content/blog"), { recursive: true });
    await fs.mkdir(reports);
    await fs.symlink(path.join(currentSite, "node_modules"), path.join(site, "node_modules"), "dir");
    await fs.copyFile(new URL("../link-rot-check.mjs", import.meta.url), path.join(scripts, "link-rot-check.mjs"));
    await fs.copyFile(new URL("./link-rot.mjs", import.meta.url), path.join(scripts, "lib/link-rot.mjs"));
    const source = "site/src/content/blog/one.md";
    const url = "https://example.test/one";
    await fs.writeFile(path.join(root, source), `[One](${url})\n`);
    const oneIssue = { url, status: 404, ok: false, sources: [source] };
    const canonical = path.join(reports, "link-rot-report.json");
    const original = JSON.stringify([oneIssue, { ...oneIssue, url: "https://example.test/two" }]);
    await fs.writeFile(canonical, original);
    const customReport = path.join(root, "one-issue.json");
    await fs.writeFile(customReport, JSON.stringify([oneIssue]));
    // Exercise the actual CLI and report writes without an internet dependency.
    const preload = path.join(root, "fetch-fixture.mjs");
    await fs.writeFile(preload, 'globalThis.fetch = async (_, { method }) => new Response(null, { status: method === "HEAD" ? 404 : 200 });\n');
    const run = (args) => promisify(execFile)(process.execPath, ["--import", preload, path.join(scripts, "link-rot-check.mjs"), ...args], { cwd: site, timeout: 10_000 });
    await run(["--recheck", customReport]);
    assert.equal(await fs.readFile(canonical, "utf8"), original);
    const generated = await fs.readdir(reports);
    const issueFiles = generated.filter((file) => /^link-rot-report-\d.*\.json$/.test(file) && !file.includes(".audit-"));
    assert.equal(issueFiles.length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(reports, issueFiles[0]), "utf8")), []);
    const auditFile = generated.find((file) => file.includes(".audit-"));
    const audit = JSON.parse(await fs.readFile(path.join(reports, auditFile), "utf8"));
    assert.equal(audit.previousFlagCount, 1);
    assert.deepEqual(audit.selectedUrls, [url]);
    assert.deepEqual(audit.results[0].attempts.map((attempt) => attempt.method), ["HEAD", "GET"]);
    // Default rechecks are partial too. Explicit --output remains an intentional override.
    await run(["--recheck"]);
    assert.equal(await fs.readFile(canonical, "utf8"), original);
    await run(["--recheck", customReport, "--output", canonical]);
    assert.deepEqual(JSON.parse(await fs.readFile(canonical, "utf8")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
