#!/usr/bin/env node
// Read-only URL Inspection + live-response checks for a fixed cohort. Keeps
// all results (including indexed controls and API errors) for fair comparison.
// Uses existing Application Default Credentials with webmasters.readonly.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { validateCohort, compareInspection, summarizeAudit, inspectLiveHtml } from "./lib/indexing-audit.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run seo:indexing-audit -- [--cohort=/path/cohort.json] [--output-dir=/path/reports]\nRead-only Google URL Inspection and live HTML checks; writes timestamped JSON snapshots.");
  process.exit(0);
}
if (args.some((arg) => !/^--(?:cohort|output-dir)=.+/.test(arg))) throw new Error("Unknown option; use --help");
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const cohortPath = path.resolve(option("cohort", path.join(scriptDir, "gsc-indexing-cohort.json")));
const outputDir = path.resolve(option("output-dir", path.join(root, "content-strategy")));
const latestPath = path.join(outputDir, "gsc-indexing-audit-latest.json");
const cohort = JSON.parse(await fs.readFile(cohortPath, "utf8"));
const entries = validateCohort(cohort);
let previous;
try { previous = JSON.parse(await fs.readFile(latestPath, "utf8")); } catch {}
if (!previous) {
  try { previous = JSON.parse(await fs.readFile(path.join(root, "content-strategy/traffic-baseline-2026-10-31.json"), "utf8")).representativeInspection; } catch {}
}
const previousByUrl = new Map((previous?.results ?? []).map((row) => [row.url, row]));
const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/webmasters.readonly"] });
let client;
try { await auth.getClient(); client = google.searchconsole({ version: "v1", auth }); }
catch { console.error("[indexing-audit] Read-only Google credentials unavailable; live checks will still run."); }

const results = [];
for (const entry of entries) {
  let live;
  try {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    const xRobotsTag = response.headers.get("x-robots-tag");
    live = { status: response.status, finalUrl: response.url, xRobotsTag,
      ...inspectLiveHtml(await response.text(), entry.url) };
    live.noindex ||= /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/i.test(xRobotsTag ?? "");
  } catch (error) { live = { error: error.name }; }
  let indexStatus;
  if (client) {
    try {
      const response = await client.urlInspection.index.inspect({ requestBody: {
        inspectionUrl: entry.url, siteUrl: cohort.siteUrl, languageCode: "en-US",
      } }, { timeout: 20000 });
      indexStatus = response.data.inspectionResult?.indexStatusResult ?? {};
    } catch (error) { indexStatus = { error: `Inspection failed (${error.code ?? error.name})` }; }
  } else { indexStatus = { error: "Read-only Google credentials unavailable" }; }
  const prior = previousByUrl.get(entry.url);
  const comparison = compareInspection(prior?.indexStatus, indexStatus);
  results.push({ ...entry, live, indexStatus, comparison });
  console.log(`[indexing-audit] ${comparison.after}: ${entry.path} (${indexStatus.coverageState ?? indexStatus.error ?? "unknown"})`);
}
const report = {
  fetchedAt: new Date().toISOString(), property: cohort.siteUrl, selection: cohort.selection,
  previousFetchedAt: previous?.fetchedAt ?? null,
  summary: summarizeAudit(results),
  caveats: ["This fixed, purposive cohort is not a sitewide indexing rate.",
    "URL Inspection reports Google's stored index state, not a live Googlebot crawl.",
    "The live HTTP checks are a separate observation and cannot establish why a URL was not indexed.",
    "A reported sitemap or referring URL is not a complete crawl/discovery history.",
    "No indexing request, sitemap submission, publishing change or Search Console setting was made."], results,
};
await fs.mkdir(outputDir, { recursive: true });
const snapshot = `gsc-indexing-audit-${report.fetchedAt.replace(/[:.]/g, "-")}.json`;
await fs.writeFile(path.join(outputDir, snapshot), JSON.stringify(report, null, 2) + "\n");
await fs.writeFile(latestPath, JSON.stringify(report, null, 2) + "\n");
console.log(`[indexing-audit] ${JSON.stringify(report.summary)}; saved ${latestPath}`);
if (report.summary.unknown || report.summary.liveIssues) process.exitCode = 1;
