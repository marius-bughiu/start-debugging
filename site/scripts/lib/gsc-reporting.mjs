// Search Console dates are inclusive calendar days in Pacific time.
export const GSC_TIME_ZONE = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;

export function searchConsoleDay(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: GSC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function buildSearchWindows(today) {
  const midnight = new Date(`${today}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(midnight.valueOf()) || midnight.toISOString().slice(0, 10) !== today) {
    throw new RangeError("Expected a valid YYYY-MM-DD reporting date");
  }
  const day = (offset) => new Date(midnight.valueOf() + offset * DAY_MS).toISOString().slice(0, 10);
  const range = (endOffset, days) => ({
    startDate: day(endOffset - days + 1),
    endDate: day(endOffset),
    days,
  });
  // Leave three days for reporting latency; API requests also require final data.
  return {
    current7: range(-3, 7),
    prior7: range(-10, 7),
    current28: range(-3, 28),
    prior28: range(-31, 28),
  };
}

export function isSiteOperatorQuery(query) {
  return /(?:^|[\s("'+\-])site:/i.test(query);
}

export function propertyTotalsRequest({ startDate, endDate }) {
  // No query/page dimensions or filters: preserve anonymized query traffic
  // and property-level counting instead of summing incomplete query rows.
  return {
    startDate,
    endDate,
    type: "web",
    dataState: "final",
    aggregationType: "byProperty",
    rowLimit: 1,
  };
}
