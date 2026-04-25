# start-debugging

The Astro static site behind [startdebugging.net](https://startdebugging.net) - a daily blog covering .NET, C#, Flutter, and developer tooling. The public surface lives under `site/`; build scripts and CI workflows handle GitHub Pages deploys, OG image generation, link-rot checks, Core Web Vitals audits, and per-channel social distribution.

## Website (Astro + GitHub Pages)

- **URL**: <https://marius-bughiu.github.io/start-debugging/>
- **Build/deploy**: on every push to `main` via [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
- **Repo setting** (one-time): GitHub → Settings → Pages → Build and deployment → Source: GitHub Actions

### Local dev

```powershell
cd site
npm ci
npm run dev
```

### Build (static)

```powershell
cd site
npm ci
npm run build
```

## Distribution

Per-channel post copy lives in `tasks/<channel>.json`. When a new blog post lands on `main`, [`.github/workflows/distribute.yml`](.github/workflows/distribute.yml) fans out parallel jobs that publish to X, Bluesky, and Mastodon, then commit the consumed task entries back. Cross-posting to dev.to and Hashnode is wired up in [`site/scripts/cross-post.mjs`](site/scripts/cross-post.mjs) but currently disabled. Distribution credentials are documented in [`site/.env.example`](site/.env.example).

## License

[MIT](LICENSE).
