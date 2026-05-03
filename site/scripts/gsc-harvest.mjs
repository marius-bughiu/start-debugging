#!/usr/bin/env node
// GSC harvester. Produces four artefacts under content-strategy/:
//
//   gsc-candidates.json       page-2 queries (positions 11-20), last 7 days
//   gsc-rising.json           queries with the largest week-over-week
//                             impression delta, current position <= 30
//   gsc-low-ctr-pages.json    pages with high impressions but CTR < 2%,
//                             last 28 days
//   gsc-not-indexed.json      most-recent N URLs whose URL Inspection coverage
//                             is anything other than "Submitted and indexed".
//                             Throttled at 200ms/call; default N=50 via
//                             GSC_INSPECT_LIMIT (set to 0 to skip the section
//                             entirely if you want to conserve daily quota).
//
// Authenticates via Google Application Default Credentials (ADC). Set up once
// with:
//   gcloud auth application-default login --scopes=openid,\
//     https://www.googleapis.com/auth/userinfo.email,\
//     https://www.googleapis.com/auth/cloud-platform,\
//     https://www.googleapis.com/auth/webmasters.readonly
//
// This runs as the signed-in user, so the GSC property owner (not a service
// account) must be the one who logs in.
//
// Exits 0 with a log message if ADC is missing or googleapis isn't installed,
// so the scheduled task can skip cleanly without failing.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { buildLastmodMap } from "../src/lib/content-paths.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SITE_DIR = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(SITE_DIR, "src", "content");
const CANDIDATES_OUT = path.join(ROOT, "content-strategy", "gsc-candidates.json");
const RISING_OUT = path.join(ROOT, "content-strategy", "gsc-rising.json");
const LOW_CTR_OUT = path.join(ROOT, "content-strategy", "gsc-low-ctr-pages.json");
const NOT_INDEXED_OUT = path.join(ROOT, "content-strategy", "gsc-not-indexed.json");

const siteUrl = "sc-domain:startdebugging.net";
const inspectOrigin = "https://startdebugging.net";

let google;
try {
  ({ google } = await import("googleapis"));
} catch {
  console.log(
    "[gsc-harvest] googleapis not installed. Run `npm install googleapis` in site/ to enable. Skipping.",
  );
  process.exit(0);
}

let auth;
try {
  auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  // Force credential resolution now so missing ADC fails fast with a clear log.
  await auth.getClient();
} catch (err) {
  console.log(
    `[gsc-harvest] Application Default Credentials not available: ${err.message}. Run \`gcloud auth application-default login --scopes=...\` (see script header). Skipping.`,
  );
  process.exit(0);
}

const webmasters = google.webmasters({ version: "v3", auth });

const isoDay = (d) => d.toISOString().slice(0, 10);
const dayMs = 24 * 60 * 60 * 1000;
const now = new Date();

const last7End = isoDay(now);
const last7Start = isoDay(new Date(now.getTime() - 7 * dayMs));
const prior7End = isoDay(new Date(now.getTime() - 7 * dayMs - dayMs));
const prior7Start = isoDay(new Date(now.getTime() - 14 * dayMs - dayMs));
const last28End = last7End;
const last28Start = isoDay(new Date(now.getTime() - 28 * dayMs));

// 1. Page-2 queries (positions 11-20), last 7 days. Format unchanged so
//    monthly-retro-prompt.md can keep reading it.
console.log(`[gsc-harvest] Querying ${siteUrl} for page-2 candidates ${last7Start} to ${last7End}`);
const candidatesRes = await webmasters.searchanalytics.query({
  siteUrl,
  requestBody: {
    startDate: last7Start,
    endDate: last7End,
    dimensions: ["query"],
    rowLimit: 1000,
  },
});
const candidatesRows = candidatesRes.data.rows || [];
const page2 = candidatesRows
  .filter((r) => r.position >= 11 && r.position <= 20)
  .map((r) => ({
    query: r.keys[0],
    position: Number(r.position.toFixed(2)),
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: Number(r.ctr.toFixed(4)),
  }))
  .sort((a, b) => b.impressions - a.impressions);
await fs.writeFile(CANDIDATES_OUT, JSON.stringify(page2, null, 2) + "\n");
console.log(
  `[gsc-harvest] Wrote ${page2.length} page-2 candidates to ${path.relative(ROOT, CANDIDATES_OUT)}`,
);

// 2. Rising queries: week-over-week impression delta, current position <= 30.
console.log(
  `[gsc-harvest] Querying prior-week baseline ${prior7Start} to ${prior7End}`,
);
const priorRes = await webmasters.searchanalytics.query({
  siteUrl,
  requestBody: {
    startDate: prior7Start,
    endDate: prior7End,
    dimensions: ["query"],
    rowLimit: 1000,
  },
});
const priorByQuery = new Map();
for (const r of priorRes.data.rows || []) {
  priorByQuery.set(r.keys[0], r.impressions);
}
const rising = candidatesRows
  .filter((r) => r.position <= 30)
  .map((r) => {
    const priorImpressions = priorByQuery.get(r.keys[0]) || 0;
    return {
      query: r.keys[0],
      currentPosition: Number(r.position.toFixed(2)),
      currentImpressions: r.impressions,
      priorImpressions,
      delta: r.impressions - priorImpressions,
      ctr: Number(r.ctr.toFixed(4)),
    };
  })
  .filter((r) => r.delta >= 5)
  .sort((a, b) => b.delta - a.delta)
  .slice(0, 30);
await fs.writeFile(RISING_OUT, JSON.stringify(rising, null, 2) + "\n");
console.log(
  `[gsc-harvest] Wrote ${rising.length} rising queries to ${path.relative(ROOT, RISING_OUT)}`,
);

// 3. Low-CTR pages: page-level dimension over 28 days, impressions >= 50,
//    CTR < 2%. Page-level CTR is too noisy at 7 days.
console.log(
  `[gsc-harvest] Querying low-CTR pages ${last28Start} to ${last28End}`,
);
const pagesRes = await webmasters.searchanalytics.query({
  siteUrl,
  requestBody: {
    startDate: last28Start,
    endDate: last28End,
    dimensions: ["page"],
    rowLimit: 1000,
  },
});
const lowCtr = (pagesRes.data.rows || [])
  .filter((r) => r.impressions >= 50 && r.ctr < 0.02)
  .map((r) => ({
    page: r.keys[0],
    position: Number(r.position.toFixed(2)),
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: Number(r.ctr.toFixed(4)),
  }))
  .sort((a, b) => b.impressions - a.impressions)
  .slice(0, 30);
await fs.writeFile(LOW_CTR_OUT, JSON.stringify(lowCtr, null, 2) + "\n");
console.log(
  `[gsc-harvest] Wrote ${lowCtr.length} low-CTR pages to ${path.relative(ROOT, LOW_CTR_OUT)}`,
);

// 4. Not-indexed URLs via URL Inspection API. Surfaces actionable per-URL
//    coverage state — what GSC's UI calls "Why pages aren't indexed". Quota
//    is 2,000 inspections/day per project; default cap of 50 keeps us in a
//    rounding error of that ceiling and runs end-to-end in ~10s.
const limit = Number.parseInt(process.env.GSC_INSPECT_LIMIT ?? "50", 10);
if (Number.isFinite(limit) && limit > 0) {
  const sc = google.searchconsole({ version: "v1", auth });

  const lastmod = buildLastmodMap(CONTENT_DIR);
  const ranked = [...lastmod.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, limit)
    .map(([urlPath]) => `${inspectOrigin}${urlPath}`);

  console.log(
    `[gsc-harvest] Inspecting ${ranked.length} most-recent URL(s) (limit=${limit})`,
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inspected = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const u = ranked[i];
    try {
      const res = await sc.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: u,
          siteUrl,
          languageCode: "en-US",
        },
      });
      const idx = res.data.inspectionResult?.indexStatusResult ?? {};
      inspected.push({
        url: u,
        verdict: idx.verdict ?? null,
        coverageState: idx.coverageState ?? null,
        indexingState: idx.indexingState ?? null,
        robotsTxtState: idx.robotsTxtState ?? null,
        pageFetchState: idx.pageFetchState ?? null,
        googleCanonical: idx.googleCanonical ?? null,
        userCanonical: idx.userCanonical ?? null,
        lastCrawlTime: idx.lastCrawlTime ?? null,
        sitemap: idx.sitemap ?? [],
        referringUrls: (idx.referringUrls ?? []).slice(0, 5),
        inspectionResultLink: res.data.inspectionResult?.inspectionResultLink ?? null,
      });
    } catch (err) {
      inspected.push({ url: u, error: err.message });
    }
    if (i < ranked.length - 1) await sleep(200);
  }

  const notIndexed = inspected.filter(
    (r) => r.error || r.coverageState !== "Submitted and indexed",
  );

  await fs.writeFile(
    NOT_INDEXED_OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalChecked: inspected.length,
        notIndexedCount: notIndexed.length,
        results: notIndexed,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `[gsc-harvest] Wrote ${notIndexed.length}/${inspected.length} not-indexed URLs to ${path.relative(ROOT, NOT_INDEXED_OUT)}`,
  );
} else {
  console.log("[gsc-harvest] GSC_INSPECT_LIMIT=0 — skipping URL Inspection section.");
}
