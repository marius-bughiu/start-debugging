# start-debugging (content ops + tooling)

This repo is the working set for the **Start Debugging** daily publishing workflow:

- **Strategy + prompts** live in `content-strategy/`
- **Astro website** lives in `site/` (static output deployed to GitHub Pages)

## Website (Astro + GitHub Pages)

- **URL**: `https://marius-bughiu.github.io/start-debugging/`
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

## Daily workflow

Research and writing are driven entirely by the prompt in `content-strategy/daily-prompt.md`, using WebSearch + WebFetch. There are no local PowerShell helpers - the prompt is self-contained.

A scheduled agent runs the prompt daily at 8 AM, researches trends, writes 1-2 posts under `site/src/content/blog/YYYY/MM/<slug>.md`, then commits and pushes so GitHub Pages rebuilds.

## Key files

- `content-strategy/daily-prompt.md`: the master prompt used each day
- `content-strategy/style-guide.md`: voice + formatting rules
- `content-strategy/trend-sources.md`: where to look for trending topics
- `content-strategy/tips-and-tricks.md`: research + duplicate-check tips
