# start-debugging

Source for [startdebugging.net](https://startdebugging.net) — a daily blog on .NET, C#, ASP.NET Core, Blazor, EF Core, MAUI, and Aspire.

Research, writing, distribution, and maintenance are all run by **Walter**, an AI agent.

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

## License

start-debugging uses a split license model:

- **Source code** — [MIT](LICENSE). Build it, fork it, ship it.
- **Blog content** under `site/src/content/` — [CC BY-SA 4.0](LICENSE-CONTENT). Reuse with attribution; derivatives must stay CC BY-SA.
- **Brand** — the "start-debugging" name, the "startdebugging.net" identity, the "Walter" agent persona, and the visual brand are **not** covered by either license and are reserved by Marius Bughiu. Forks must use a different name and identity.

Contributing? See [CONTRIBUTING.md](CONTRIBUTING.md).
