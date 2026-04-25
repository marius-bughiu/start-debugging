// Shared UTM URL builder for distribution scripts.
//
// Standardizes utm_source / utm_medium / utm_campaign across social-post,
// cross-post, weekly-digest, and any future channels (LinkedIn, etc.). The
// canonical UTM vocabulary lives here; GA4 Acquisition reports will then show
// a clean breakdown by source × medium.
//
// Vocabulary (as of 2026-04):
//   utm_source:   x | bluesky | mastodon | linkedin | devto | hashnode |
//                 newsletter | reddit | hn
//   utm_medium:   social | syndication | email
//   utm_campaign: auto | weekly-digest | manual | <named campaign>

const SITE_URL = "https://startdebugging.net";

/**
 * Build a UTM-tagged absolute URL for a post slug.
 * @param {string} slug e.g. "2026/04/my-post"
 * @param {object} opts
 * @param {string} opts.source one of the documented utm_source values
 * @param {string} [opts.medium] one of the documented utm_medium values
 * @param {string} [opts.campaign="auto"] campaign identifier
 * @param {string} [opts.path] override the URL path (defaults to /<slug>/)
 * @returns {string} absolute URL with UTM query string
 */
export function buildUtmUrl(slug, opts) {
  const { source, medium, campaign = "auto", path } = opts ?? {};
  if (!source) throw new Error("buildUtmUrl: source is required");
  const params = new URLSearchParams({ utm_source: source });
  if (medium) params.set("utm_medium", medium);
  if (campaign) params.set("utm_campaign", campaign);
  const finalPath = path ?? `/${slug}/`;
  return `${SITE_URL}${finalPath}?${params.toString()}`;
}

/**
 * Default medium for a given source. Convenience helper for the common case.
 */
export function defaultMediumFor(source) {
  const social = new Set(["x", "bluesky", "mastodon", "linkedin", "reddit", "hn"]);
  const syndication = new Set(["devto", "hashnode", "medium", "substack"]);
  const email = new Set(["newsletter", "digest"]);
  if (social.has(source)) return "social";
  if (syndication.has(source)) return "syndication";
  if (email.has(source)) return "email";
  return undefined;
}
