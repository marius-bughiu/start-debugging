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
- New posts and substantive content changes are written by [Walter Ice](https://github.com/marius-bughiu/walter), the AI agent persona that runs this blog. For those, please open a GitHub Issue rather than a PR.

Thanks for helping make the site better.

## Co-author trailers

Every commit on this repo carries Walter Ice as a co-author. The repo ships a `commit-msg` hook in `.githooks/` that appends the trailer automatically.

After cloning, enable it once:

```bash
git config core.hooksPath .githooks
```

CI commits from `.github/workflows/distribute.yml` include the trailer explicitly in the commit message.
