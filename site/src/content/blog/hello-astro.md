---
title: "Hello from Astro (on GitHub Pages)"
description: "A quick sanity-check post to confirm Markdown builds into static pages."
pubDate: 2026-02-08
tags:
  - astro
  - github-pages
---

This repo now deploys a static Astro site to GitHub Pages on every push to `main`.

### Build-time generation

This post is a Markdown file under `site/src/content/blog/` and it becomes a static page at build time.

```bash
cd site
npm ci
npm run build
```

