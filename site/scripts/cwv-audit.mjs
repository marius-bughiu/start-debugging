#!/usr/bin/env node
/**
 * cwv-audit.mjs — Core Web Vitals audit via the PageSpeed Insights API.
 *
 * TRAFFIC_ROADMAP.md task 5.3. Run before/after the AdSense deferral to
 * measure the actual impact on LCP/INP/CLS, and re-run weekly to catch
 * regressions.
 *
 * Usage:
 *   node scripts/cwv-audit.mjs                  # mobile, table summary, append history
 *   node scripts/cwv-audit.mjs --mode=desktop   # desktop instead of mobile
 *   node scripts/cwv-audit.mjs --mode=both      # run both; results tagged
 *   node scripts/cwv-audit.mjs --baseline       # mark this run as the baseline
 *   node scripts/cwv-audit.mjs --label=pre-defer
 *   node scripts/cwv-audit.mjs --diff           # diff vs latest baseline
 *   node scripts/cwv-audit.mjs --urls=path.json # custom URL list
 *
 * Env:
 *   PAGESPEED_API_KEY  required. Get one at:
 *     https://console.cloud.google.com/apis/credentials
 *
 * Outputs:
 *   content-strategy/cwv-history.jsonl  — append-only, one JSON line per run
 *   content-strategy/cwv-latest.md       — overwritten on each run, markdown
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");
const SITE_URL = "https://startdebugging.net";
const HISTORY_PATH = path.join(REPO_ROOT, "content-strategy", "cwv-history.jsonl");
const LATEST_PATH = path.join(REPO_ROOT, "content-strategy", "cwv-latest.md");

// CWV "Good" thresholds (Google, as of 2026-04).
const THRESHOLDS = {
  lcp: 2500, // ms
  cls: 0.1,
  inp: 200, // ms
};

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const flagValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};

const MODE = flagValue("mode") || "mobile";
if (!["mobile", "desktop", "both"].includes(MODE)) {
  console.error(`unknown --mode=${MODE}; use mobile | desktop | both`);
  process.exit(2);
}
const URLS_PATH = flagValue("urls") || path.join(SITE_ROOT, "scripts", "cwv-urls.json");
const BASELINE = flag("baseline");
const DIFF = flag("diff");
const LABEL = flagValue("label") || (BASELINE ? "baseline" : "");
const QUIET = flag("quiet");

// --- Helpers --------------------------------------------------------------

async function loadUrls() {
  const raw = await fs.readFile(URLS_PATH, "utf8");
  const json = JSON.parse(raw);
  if (!Array.isArray(json.urls)) throw new Error(`${URLS_PATH}: missing "urls" array`);
  return json.urls.map((u) => ({
    label: u.label ?? u.path,
    path: u.path,
    adsense: !!u.adsense,
    fullUrl: SITE_URL + u.path,
  }));
}

async function callPsi(targetUrl, strategy, apiKey) {
  const params = new URLSearchParams({
    url: targetUrl,
    strategy,
    category: "PERFORMANCE",
    key: apiKey,
  });
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`;
  const res = await fetch(endpoint);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PSI ${res.status} for ${targetUrl}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// Extract the metrics we care about. PSI returns lab data via Lighthouse and
// (when CrUX has enough samples) field data via loadingExperience. Lab is
// always available; field is the gold standard but missing for low-traffic
// URLs. Pull both and prefer field when present.
function extractMetrics(report) {
  const audits = report?.lighthouseResult?.audits ?? {};
  const lab = {
    lcp: audits["largest-contentful-paint"]?.numericValue ?? null,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
    inp: audits["interaction-to-next-paint"]?.numericValue
        ?? audits["experimental-interaction-to-next-paint"]?.numericValue
        ?? null,
    tbt: audits["total-blocking-time"]?.numericValue ?? null,
    speedIndex: audits["speed-index"]?.numericValue ?? null,
  };
  const score = report?.lighthouseResult?.categories?.performance?.score ?? null;

  // Field data (CrUX). May be entirely absent for low-traffic URLs.
  const ldex = report?.loadingExperience?.metrics ?? {};
  const field = {
    lcp: ldex.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
    cls: ldex.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
      ? ldex.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
      : null,
    inp: ldex.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
  };
  const fieldOverall = report?.loadingExperience?.overall_category ?? null;

  return { lab, field, score, fieldOverall };
}

// Pass = no measured metric exceeds its "Good" threshold. Null metrics are
// "unmeasured", not "failing": INP in particular is a field-only metric and
// will be null for low-traffic URLs without enough CrUX samples. We can't
// punish a page for missing field data we don't yet have.
function passesGood(m) {
  if (m.lcp == null && m.cls == null && m.inp == null) return false;
  if (m.lcp != null && m.lcp > THRESHOLDS.lcp) return false;
  if (m.cls != null && m.cls > THRESHOLDS.cls) return false;
  if (m.inp != null && m.inp > THRESHOLDS.inp) return false;
  return true;
}

// Returns which metrics failed for the status column / failing-URL list.
function failingMetrics(m) {
  const out = [];
  if (m.lcp != null && m.lcp > THRESHOLDS.lcp) out.push("LCP");
  if (m.cls != null && m.cls > THRESHOLDS.cls) out.push("CLS");
  if (m.inp != null && m.inp > THRESHOLDS.inp) out.push("INP");
  return out;
}

function fmtMs(n) {
  if (n == null) return "—";
  if (n < 1000) return Math.round(n) + "ms";
  return (n / 1000).toFixed(2) + "s";
}
function fmtCls(n) {
  return n == null ? "—" : n.toFixed(3);
}
function fmtScore(s) {
  return s == null ? "—" : Math.round(s * 100).toString();
}

function statusBadge(passes, failed) {
  if (passes) return "✓ Good";
  return failed && failed.length ? `✗ ${failed.join("+")}` : "✗ Fail";
}

function deltaStr(curr, prev, unit) {
  if (curr == null || prev == null) return "";
  const d = curr - prev;
  if (Math.abs(d) < 0.0001) return " (same)";
  const sign = d > 0 ? "+" : "";
  if (unit === "ms") return ` (${sign}${Math.round(d)}ms)`;
  if (unit === "cls") return ` (${sign}${d.toFixed(3)})`;
  return ` (${sign}${d.toFixed(2)})`;
}

// --- History --------------------------------------------------------------

async function appendHistory(entry) {
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.appendFile(HISTORY_PATH, JSON.stringify(entry) + "\n", "utf8");
}

async function loadLatestBaseline() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.baseline) return e;
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    return null;
  }
  return null;
}

// --- Reporting ------------------------------------------------------------

function renderTable(rows) {
  const header = ["URL", "LCP", "CLS", "INP", "Score", "Status"];
  const widths = header.map((h) => h.length);
  const cells = rows.map((r) => {
    const c = [r.label, fmtMs(r.lcp), fmtCls(r.cls), fmtMs(r.inp), fmtScore(r.score), statusBadge(r.passes, r.failed)];
    c.forEach((v, i) => {
      if (v.length > widths[i]) widths[i] = v.length;
    });
    return c;
  });
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const lines = [
    header.map((h, i) => h.padEnd(widths[i])).join("  "),
    sep,
    ...cells.map((c) => c.map((v, i) => v.padEnd(widths[i])).join("  ")),
  ];
  return lines.join("\n");
}

function renderMarkdown(run, baseline) {
  const lines = [];
  lines.push(`# CWV audit — ${run.timestamp.slice(0, 16).replace("T", " ")}`);
  lines.push("");
  lines.push(`Mode: \`${run.mode}\` · Pages: ${run.results.length} · Pass rate: **${run.passRate}%**${run.label ? ` · Label: \`${run.label}\`` : ""}`);
  lines.push("");
  if (baseline) {
    lines.push(`Baseline for comparison: \`${baseline.timestamp.slice(0, 16).replace("T", " ")}\`${baseline.label ? ` (${baseline.label})` : ""}`);
    lines.push("");
  }
  lines.push("## Results (mobile lab data)");
  lines.push("");
  lines.push("| URL | LCP | CLS | INP | Score | Status |");
  lines.push("| --- | --: | --: | --: | --: | :--: |");

  const baselineByPath = baseline ? new Map(baseline.results.map((r) => [r.path, r])) : null;
  for (const r of run.results) {
    const b = baselineByPath?.get(r.path) ?? null;
    const lcp = fmtMs(r.lcp) + (b ? deltaStr(r.lcp, b.lcp, "ms") : "");
    const cls = fmtCls(r.cls) + (b ? deltaStr(r.cls, b.cls, "cls") : "");
    const inp = fmtMs(r.inp) + (b ? deltaStr(r.inp, b.inp, "ms") : "");
    const score = fmtScore(r.score) + (b ? deltaStr(r.score, b.score, "score") : "");
    lines.push(`| ${r.label} | ${lcp} | ${cls} | ${inp} | ${score} | ${statusBadge(r.passes, r.failed)} |`);
  }
  lines.push("");
  lines.push(`Thresholds: LCP ≤ ${THRESHOLDS.lcp}ms, CLS ≤ ${THRESHOLDS.cls}, INP ≤ ${THRESHOLDS.inp}ms.`);
  lines.push("");
  lines.push("**Note on INP:** Interaction-to-Next-Paint is a field-only metric. Lab data (what we pull here) shows `—` until CrUX has enough real-user samples for a URL — typically requires steady traffic and a 28-day window. For a static blog, expect INP to populate slowly. Pages with null INP are scored on LCP + CLS only; a `✓ Good` status means \"passes on what we can measure.\"");
  lines.push("");
  if (run.failingUrls.length) {
    lines.push("## Failing URLs");
    lines.push("");
    for (const f of run.failingUrls) {
      const reasons = [];
      if (f.lcp != null && f.lcp > THRESHOLDS.lcp) reasons.push(`LCP ${fmtMs(f.lcp)}`);
      if (f.cls != null && f.cls > THRESHOLDS.cls) reasons.push(`CLS ${fmtCls(f.cls)}`);
      if (f.inp != null && f.inp > THRESHOLDS.inp) reasons.push(`INP ${fmtMs(f.inp)}`);
      lines.push(`- **${f.label}** (\`${f.path}\`) — ${reasons.join(", ") || "incomplete data"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// --- Main -----------------------------------------------------------------

async function runOne(strategy, urls, apiKey) {
  const results = [];
  for (const u of urls) {
    if (!QUIET) process.stderr.write(`  [${strategy}] ${u.path} ... `);
    try {
      const report = await callPsi(u.fullUrl, strategy, apiKey);
      const m = extractMetrics(report);
      const lcp = m.field.lcp ?? m.lab.lcp;
      const cls = m.field.cls ?? m.lab.cls;
      const inp = m.field.inp ?? m.lab.inp;
      const passes = passesGood({ lcp, cls, inp });
      const failed = failingMetrics({ lcp, cls, inp });
      results.push({
        path: u.path,
        label: u.label,
        adsense: u.adsense,
        lcp, cls, inp,
        tbt: m.lab.tbt,
        speedIndex: m.lab.speedIndex,
        score: m.score,
        fieldOverall: m.fieldOverall,
        source: m.field.lcp != null ? "field" : "lab",
        passes,
        failed,
      });
      if (!QUIET) process.stderr.write(`${passes ? "ok" : `fail ${failed.join("+") || "?"}`} (LCP ${fmtMs(lcp)})\n`);
    } catch (err) {
      results.push({
        path: u.path,
        label: u.label,
        adsense: u.adsense,
        lcp: null, cls: null, inp: null,
        tbt: null, speedIndex: null, score: null,
        fieldOverall: null,
        source: null,
        passes: false,
        error: err.message,
      });
      if (!QUIET) process.stderr.write(`error: ${err.message.slice(0, 60)}\n`);
    }
  }
  return results;
}

async function main() {
  if (DIFF) {
    const last = await loadLatestBaseline();
    if (!last) {
      console.error("No baseline run found in cwv-history.jsonl. Run with --baseline first.");
      process.exit(1);
    }
    console.log(`Latest baseline: ${last.timestamp} (${last.label || "no label"})`);
    console.log(`Pages: ${last.results.length}, pass rate: ${last.passRate}%`);
    return;
  }

  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing PAGESPEED_API_KEY env var.\n" +
        "Get one at https://console.cloud.google.com/apis/credentials\n" +
        "Then add to site/.env:  PAGESPEED_API_KEY=AIza...",
    );
    process.exit(2);
  }

  const urls = await loadUrls();
  const baseline = await loadLatestBaseline();
  const timestamp = new Date().toISOString();
  const strategies = MODE === "both" ? ["mobile", "desktop"] : [MODE];

  const allResults = [];
  for (const strategy of strategies) {
    if (!QUIET) console.error(`[cwv-audit] strategy=${strategy} pages=${urls.length}`);
    const results = await runOne(strategy, urls, apiKey);
    const passing = results.filter((r) => r.passes).length;
    const passRate = Math.round((passing / results.length) * 100);
    const failingUrls = results.filter((r) => !r.passes);
    const run = {
      timestamp,
      mode: strategy,
      label: LABEL,
      baseline: BASELINE,
      passRate,
      passing,
      total: results.length,
      results,
      failingUrls: failingUrls.map((f) => ({ label: f.label, path: f.path, lcp: f.lcp, cls: f.cls, inp: f.inp })),
    };
    allResults.push(run);

    await appendHistory(run);

    // Print compact table to stdout (markdown report goes to LATEST_PATH).
    if (!QUIET) {
      console.log("");
      console.log(renderTable(results));
      console.log("");
      console.log(`${passing}/${results.length} pass on ${strategy} (${passRate}%).`);
    }
  }

  // Markdown report uses the last strategy run for now (or mobile if both).
  const reportRun = allResults.find((r) => r.mode === "mobile") ?? allResults[0];
  await fs.writeFile(LATEST_PATH, renderMarkdown(reportRun, baseline), "utf8");
  if (!QUIET) {
    console.log("");
    console.log(`Wrote ${path.relative(REPO_ROOT, HISTORY_PATH)} (appended) and ${path.relative(REPO_ROOT, LATEST_PATH)}`);
  }
}

main().catch((err) => {
  console.error("[cwv-audit] failed:", err);
  process.exit(1);
});
