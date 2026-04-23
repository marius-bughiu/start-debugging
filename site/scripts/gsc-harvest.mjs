#!/usr/bin/env node
// GSC page-2 query harvester.
//
// Reads GSC_CREDENTIALS_JSON (path to a service account key file) and
// GSC_SITE_URL (the verified property in Search Console, e.g. "sc-domain:startdebugging.net"
// or "https://startdebugging.net/"). Queries the last 7 days of Search Analytics
// data, filters to queries ranking in positions 11-20 (page 2 of search results),
// and writes candidates to content-strategy/gsc-candidates.json.
//
// Exits 0 with a log message if credentials, env vars, or the googleapis package
// are missing, so the scheduled task can skip cleanly without failing.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT = path.join(ROOT, "content-strategy", "gsc-candidates.json");

const credsPath = process.env.GSC_CREDENTIALS_JSON;
const siteUrl = process.env.GSC_SITE_URL;

if (!credsPath || !siteUrl) {
  console.log(
    "[gsc-harvest] GSC_CREDENTIALS_JSON or GSC_SITE_URL not set. Skipping.",
  );
  process.exit(0);
}

let google;
try {
  ({ google } = await import("googleapis"));
} catch {
  console.log(
    "[gsc-harvest] googleapis not installed. Run `npm install googleapis` in site/ to enable. Skipping.",
  );
  process.exit(0);
}

let creds;
try {
  creds = JSON.parse(await fs.readFile(credsPath, "utf8"));
} catch (err) {
  console.log(
    `[gsc-harvest] Could not read credentials at ${credsPath}: ${err.message}. Skipping.`,
  );
  process.exit(0);
}

const auth = new google.auth.JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
});

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
