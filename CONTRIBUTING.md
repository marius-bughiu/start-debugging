# Contributing

Spotted a typo, broken link, code error, or mistranslation? Fixes are very welcome.

## The fastest path: the "Edit on GitHub" button

Every post on [startdebugging.net](https://startdebugging.net) has an **Edit on GitHub** button in the share row at the bottom of the article. Click it and GitHub will:

1. Fork this repository to your account (you'll be prompted to sign in if needed).
2. Open the post's markdown source in the web editor.
3. Let you edit and commit your change with a one-line message.
4. Open a pull request back to this repository.

That's it — no local setup required.

## Local development (optional)

For larger changes you'd rather review in a browser first:

```powershell
cd site
npm ci
npm run dev      # http://localhost:4321
```

Then edit the file under `site/src/content/blog/<year>/<month>/<slug>.md` and submit a PR from your fork.

## What gets accepted

- Typos, grammar, broken links, factual corrections, and code-sample fixes — merged quickly.
- Translation improvements in `site/src/content/blog/<lang>/...` — merged after a quick review by a native speaker if available, or on trust otherwise.
- New posts and substantive content changes are written by [Walter](README.md), the AI agent that runs this blog. For those, please open a GitHub Issue rather than a PR.

## Links and tags

Add internal links where a related article helps explain the surrounding text, using descriptive anchor text and its canonical `/year/month/slug/` URL. Check the destination's framework and version before recommending it from an older tutorial. Link-only edits do not need a new publication or update date.

Prefer an existing tag before adding a new spelling. Reviewed synonyms live in [`site/src/lib/tags.mjs`](site/src/lib/tags.mjs); the build combines their listings and preserves old tag URLs, including pagination, with redirects. Small but distinct topics can keep their own tags. Add an alias only for the same topic, and keep its target canonical to avoid redirect chains. Run `node site/scripts/tag-taxonomy.test.mjs` after changing the mapping.

An article explicitly targeting .NET 11 also needs the existing `dotnet-11` tag so it appears in the version tracker. General `dotnet` tags alone do not establish a version scope. Tag-only corrections preserve publication and update dates.

Keep the historical page counts in `LEGACY_TAG_PAGES` when normalizing source tags. GitHub Pages serves Astro's static HTML redirects, with immediate meta refresh and a canonical target; these redirect pages are excluded from the sitemap.

Related articles are selected using specific shared topics and title relevance. For editorial recommendations, add `relatedPosts` to a post's frontmatter as a list of canonical base slugs, for example `2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes`. Use no leading slash, locale prefix, or trailing slash. Picks resolve to published articles in the reader's language; unavailable translations are skipped. List only articles that help the reader continue the topic.

## SEO validation and audits

The production build validates the sitemap, canonical URLs, page metadata, and language alternatives before deployment. Keep redirect URLs outside the sitemap, and preserve reciprocal language links when changing translated routes.

Run `npm run seo:indexing-audit` from `site/` to refresh the fixed cohort in `site/scripts/gsc-indexing-cohort.json`. It uses existing Google Application Default Credentials with `webmasters.readonly`, checks live page responses separately, and saves all inspection results under `content-strategy/`, including indexed controls and API errors. Timestamped snapshots allow comparisons of the same URLs. This is a diagnostic sample, not a sitewide indexing rate, and does not submit indexing requests.

`npm run seo:discovery-audit` tracks the separate 30-URL discovery/content-review cohort and writes to `content-strategy/discovery-audit/`, preserving the original cohort's history. Its URLs include established controls, observed organic landing pages, featured guides and restored examples. Keep cohort membership stable when comparing results.

Pillar `indexTags` select articles sharing any listed subject tag. When a subject spans technologies, optional `indexRequireAnyTags` also requires at least one listed technology tag. This keeps a C# async guide focused without changing the articles' URLs, tag indexes or language availability. Run `node --test scripts/pillar-posts.test.mjs` from `site/` after changing that selection logic.

Article screenshots need descriptive alt text; decorative images can use an empty alt. Eligible static local images receive dimensions and responsive WebP variants during the build; animations, author attributes and links to original images are preserved. Keep offscreen images lazy. For a measured above-fold/LCP image, an HTML `img` can explicitly set `loading="eager"` and `fetchpriority="high"`; the pipeline preserves those choices.

Run `npm run link-rot-check -- --recheck` to revisit the last link report, or use `--extract-only` for an offline inventory. Each network audit writes the legacy issues list and a timestamped audit sidecar with verified statuses and source occurrences. A failed HEAD request is checked with GET before being classified. Blocked, rate-limited, and transient requests need investigation; replace references only after confirming a dead destination and an equivalent source.

## Licensing of contributions

start-debugging uses a split license model, and your contribution is licensed accordingly based on what you change:

- **Source code contributions** (anything outside `site/src/content/`) are licensed under the [MIT License](LICENSE).
- **Blog content contributions** (anything inside `site/src/content/`, including post fixes and translations) are licensed under [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](LICENSE-CONTENT).

By submitting a pull request, you agree that:

1. Your contribution is your own original work, or you have the right to submit it under the applicable license above.
2. You license your code contribution under the MIT License and your content contribution under CC BY-SA 4.0, in each case on a perpetual, worldwide, royalty-free, irrevocable basis.
3. If your contribution incorporates third-party material (quotes, screenshots, code samples from other projects, etc.), you have verified that such use is permitted (e.g. fair use, the third party's own license) and you have attributed it appropriately.
4. You are not submitting confidential information, proprietary data belonging to an employer or client without authorization, or anything that would infringe a third party's rights.

No CLA signature is required — opening the pull request constitutes your agreement to the above.

Thanks for helping make the site better.
