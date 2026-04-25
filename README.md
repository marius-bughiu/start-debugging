# start-debugging

Source for [startdebugging.net](https://startdebugging.net) — a daily blog covering .NET, C#, ASP.NET Core, Blazor, EF Core, MAUI, Aspire, and the broader Microsoft developer toolchain.

## Stack

- **Site**: [Astro 5](https://astro.build/) under [`site/`](site/), static output, [Pagefind](https://pagefind.app/) for client-side search
- **Hosting**: GitHub Pages with a custom domain (see [`site/public/CNAME`](site/public/CNAME))
- **Deploy**: [`deploy-pages.yml`](.github/workflows/deploy-pages.yml) on every push to `main`

## Local dev

```powershell
cd site
npm ci
npm run dev      # http://localhost:4321
npm run build    # static build to site/dist
```

## Site tooling (under [`site/scripts/`](site/scripts/))

Run via `npm run <name>` from `site/` — scripts defined in [`site/package.json`](site/package.json).

- `og:generate`, `llms:generate` — per-post Open Graph cards (Satori + Resvg) and `llms.txt` / `llms-full.txt`, both wired into the `prebuild` hook
- `link-pass`, `link-rot-check` — internal-link suggestions and external-link 404 audit
- `freshness-pass` — surfaces stale posts due for a refresh
- `cwv-audit` — Core Web Vitals via Google PageSpeed Insights
- `gsc-harvest` — Google Search Console keyword data
- `social-post`, `cross-post`, `weekly-digest` — distribution (see below)

## Distribution

When a new blog post lands on `main`, [`distribute.yml`](.github/workflows/distribute.yml) fans out to **X**, **Bluesky**, and **Mastodon** in parallel. Per-channel post copy lives in [`tasks/<channel>.json`](tasks/); a successful post splices its task entry out, so the absence of an entry is the idempotency signal — re-runs are safe.

Cross-posting to **dev.to** and **Hashnode** is wired up in [`cross-post.mjs`](site/scripts/cross-post.mjs) but disabled in CI (matrix entries commented out in `distribute.yml`). The **weekly digest** to Buttondown is wired in [`weekly-digest.mjs`](site/scripts/weekly-digest.mjs); the cron is parked and runs on `workflow_dispatch` only.

Credentials for every platform are documented in [`site/.env.example`](site/.env.example) and supplied to CI via GitHub Actions secrets.

## License

[MIT](LICENSE).
