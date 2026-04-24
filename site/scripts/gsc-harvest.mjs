#!/usr/bin/env node
// GSC page-2 query harvester.
//
// Queries the last 7 days of Search Analytics data, filters to queries ranking
// in positions 11-20 (page 2 of search results), and writes candidates to
// content-strategy/gsc-candidates.json.
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

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT = path.join(ROOT, "content-strategy", "gsc-candidates.json");

const siteUrl = "sc-domain:startdebugging.net";

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

const now = new Date();
const end = now.toISOString().slice(0, 10);
const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

console.log(`[gsc-harvest] Querying ${siteUrl} from ${start} to ${end}`);

const res = await webmasters.searchanalytics.query({
  siteUrl,
  requestBody: {
    startDate: start,
    endDate: end,
    dimensions: ["query"],
    rowLimit: 1000,
  },
});

const rows = res.data.rows || [];
const page2 = rows
  .filter((r) => r.position >= 11 && r.position <= 20)
  .map((r) => ({
    query: r.keys[0],
    position: Number(r.position.toFixed(2)),
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: Number(r.ctr.toFixed(4)),
  }))
  .sort((a, b) => b.impressions - a.impressions);

await fs.writeFile(OUTPUT, JSON.stringify(page2, null, 2) + "\n");
console.log(
  `[gsc-harvest] Wrote ${page2.length} page-2 candidates to ${path.relative(ROOT, OUTPUT)}`,
);
