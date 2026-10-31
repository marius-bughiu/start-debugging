import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSearchWindows,
  isSiteOperatorQuery,
  propertyTotalsRequest,
  searchConsoleDay,
} from "./gsc-reporting.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

test("reporting windows contain exactly 7/28 inclusive days with adjacent baselines", () => {
  for (const today of ["2026-10-31", "2026-01-02", "2024-03-02", "2026-11-04"]) {
    const windows = buildSearchWindows(today);
    for (const days of [7, 28]) {
      const current = windows[`current${days}`];
      const prior = windows[`prior${days}`];
      for (const period of [current, prior]) {
        assert.equal((Date.parse(period.endDate) - Date.parse(period.startDate)) / DAY_MS + 1, days);
      }
      assert.equal(Date.parse(current.startDate) - Date.parse(prior.endDate), DAY_MS);
      assert.equal(Date.parse(today) - Date.parse(current.endDate), 3 * DAY_MS);
    }
  }
  assert.deepEqual(buildSearchWindows("2026-10-31").current28, {
    startDate: "2026-10-01", endDate: "2026-10-28", days: 28,
  });
  assert.deepEqual(buildSearchWindows("2026-10-31").prior28, {
    startDate: "2026-09-03", endDate: "2026-09-30", days: 28,
  });
});

test("reporting day uses Pacific date rather than host/UTC date, including DST", () => {
  assert.equal(searchConsoleDay(new Date("2026-10-31T02:00:00Z")), "2026-10-30");
  assert.equal(searchConsoleDay(new Date("2026-11-02T07:30:00Z")), "2026-11-01");
  assert.equal(searchConsoleDay(new Date("2026-11-02T08:00:00Z")), "2026-11-02");
});

test("invalid calendar dates fail instead of rolling into another month", () => {
  for (const day of ["2026-02-30", "2026-2-1", "invalid"]) {
    assert.throws(() => buildSearchWindows(day), RangeError);
  }
});

test("site operators are excluded without excluding ordinary words or URLs", () => {
  for (const query of ["site:startdebugging.net", "ef core SITE:startdebugging.net", "-site:example.com", '(site:example.com)', '"site:example.com"', "csharp\nsite:example.com"]) {
    assert.equal(isSiteOperatorQuery(query), true, query);
  }
  for (const query of ["website: asp.net", "campsite: booking", "how to build a site", "https://example.com/site:example", ""]) {
    assert.equal(isSiteOperatorQuery(query), false, query);
  }
});

test("property totals requests are unfiltered and preserve anonymized traffic", () => {
  assert.deepEqual(propertyTotalsRequest(buildSearchWindows("2026-10-31").current28), {
    startDate: "2026-10-01",
    endDate: "2026-10-28",
    type: "web",
    dataState: "final",
    aggregationType: "byProperty",
    rowLimit: 1,
  });
});
