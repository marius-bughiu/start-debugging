import test from "node:test";
import assert from "node:assert/strict";
import { validateCohort, indexState, compareInspection, summarizeAudit, inspectLiveHtml } from "./indexing-audit.mjs";

const cohort = { origin: "https://startdebugging.net", siteUrl: "sc-domain:startdebugging.net", urls: [{ path: "/" }] };
test("fixed inspection cohorts reject duplicate, external and noncanonical targets", () => {
  assert.equal(validateCohort(cohort)[0].url, "https://startdebugging.net/");
  for (const path of ["https://example.com/", "//example.com/", "/post", "/post/?x=1", "/post/#section"]) {
    assert.throws(() => validateCohort({ ...cohort, urls: [{ path }] }));
  }
  assert.throws(() => validateCohort({ ...cohort, urls: [{ path: "/" }, { path: "/" }] }));
});
test("inspection errors remain unknown and do not create false indexing losses", () => {
  assert.equal(indexState({ verdict: "PASS", coverageState: "Indexed without a sitemap" }), "indexed");
  assert.equal(indexState({ verdict: "NEUTRAL" }), "not-indexed");
  assert.equal(indexState({ verdict: "FAIL", error: "quota" }), "unknown");
  assert.equal(compareInspection({ verdict: "PASS" }, { error: "quota" }).change, "unavailable");
  assert.equal(compareInspection({ verdict: "NEUTRAL" }, { verdict: "PASS" }).change, "gained-indexing");
});
test("live checks distinguish canonical and robot directives regardless of attribute order", () => {
  const url = "https://startdebugging.net/example/";
  const html = '<html lang="en"><title>A page</title><link href="/example/" rel="canonical"><meta content="none" name="googlebot"><h1>A page</h1><link hreflang="de" href="/de/example/" rel="alternate"></html>';
  const result = inspectLiveHtml(html, url);
  assert(result.selfCanonical);
  assert(result.noindex);
  assert.deepEqual(result.hreflang, [{ language: "de", url: "https://startdebugging.net/de/example/" }]);
  assert.equal(inspectLiveHtml(html.replace('rel="canonical"', 'rel="other"'), url).selfCanonical, false);
  for (const href of ["", "   "]) {
    assert.equal(inspectLiveHtml(`<link rel="canonical" href="${href}">`, url).selfCanonical, false);
  }
});

test("live failures are counted separately from Google's stored indexing verdict", () => {
  const comparison = compareInspection({ verdict: "PASS" }, { verdict: "PASS" });
  const summary = summarizeAudit([{ url: "https://startdebugging.net/", live: { error: "timeout" }, comparison }]);
  assert.equal(summary.indexed, 1);
  assert.equal(summary.lost, 0);
  assert.equal(summary.liveErrors, 1);
  assert.equal(summary.liveIssues, 1);
  assert.equal(summarizeAudit([{ url: "https://startdebugging.net/", comparison, live: {
    status: 200, finalUrl: "https://startdebugging.net/", selfCanonical: true, noindex: false,
  } }]).liveIssues, 0);
});
