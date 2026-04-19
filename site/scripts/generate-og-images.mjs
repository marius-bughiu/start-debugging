// Generates 1200x630 Open Graph images per blog post + a default + a logo PNG.
// Runs as a `prebuild` step so `astro build` picks up the PNGs from public/og/.
// Caches by source-file mtime so repeat builds are cheap.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import matter from "gray-matter";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BLOG_DIR = path.join(ROOT, "src", "content", "blog");
const OUT_DIR = path.join(ROOT, "public", "og");
const FONT_DIR = path.join(ROOT, "fonts");
const FAVICON_PATH = path.join(ROOT, "public", "favicon.svg");
const LOGO_PNG_PATH = path.join(ROOT, "public", "logo-512.png");

const BRAND = "Start Debugging";
const WIDTH = 1200;
const HEIGHT = 630;

function el(type, props, children) {
  return { type, props: { ...(props || {}), children: children ?? null } };
}

function clampTitle(title) {
  // Satori wraps automatically, but we cap absurdly long titles so the
  // bottom row still has room.
  const MAX = 140;
  return title.length > MAX ? title.slice(0, MAX - 1) + "..." : title;
}

function ogTemplate({ title, tags, date, brand }) {
  const tagLine = (tags || []).slice(0, 4).join("  ·  ");

  return el(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background:
          "linear-gradient(135deg, #0b1020 0%, #0b1020 55%, #122049 100%)",
        color: "rgba(255, 255, 255, 0.95)",
        fontFamily: "Inter",
      },
    },
    [
      // Brand row
      el(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            fontSize: "30px",
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "#8bd3ff",
          },
        },
        brand,
      ),
      // Title
      el(
        "div",
        {
          style: {
            display: "flex",
            fontSize: "58px",
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            maxWidth: "1040px",
          },
        },
        clampTitle(title),
      ),
      // Footer row: tags + date
      el(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "24px",
            color: "rgba(255, 255, 255, 0.72)",
          },
        },
        [
          el(
            "div",
            { style: { display: "flex", color: "#97ffc1" } },
            tagLine || "startdebugging.net",
          ),
          el("div", { style: { display: "flex" } }, date || ""),
        ],
      ),
    ],
  );
}

async function walkPosts() {
  const entries = [];
  const years = await fs.readdir(BLOG_DIR).catch(() => []);
  for (const year of years) {
    const yearPath = path.join(BLOG_DIR, year);
    const yStat = await fs.stat(yearPath).catch(() => null);
    if (!yStat?.isDirectory()) continue;
    const months = await fs.readdir(yearPath);
    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      const mStat = await fs.stat(monthPath).catch(() => null);
      if (!mStat?.isDirectory()) continue;
      const files = await fs.readdir(monthPath);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        entries.push({
          year,
          month,
          slug: f.replace(/\.md$/, ""),
          filePath: path.join(monthPath, f),
        });
      }
    }
  }
  return entries;
}

async function renderPng(fonts, tmpl) {
  const svg = await satori(tmpl, {
    width: WIDTH,
    height: HEIGHT,
    fonts,
  });
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
  })
    .render()
    .asPng();
  return png;
}

async function renderLogo(svgData) {
  const png = new Resvg(svgData, {
    fitTo: { mode: "width", value: 512 },
  })
    .render()
    .asPng();
  return png;
}

function formatDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

async function main() {
  const [regular, bold] = await Promise.all([
    fs.readFile(path.join(FONT_DIR, "Inter-Regular.otf")),
    fs.readFile(path.join(FONT_DIR, "Inter-Bold.otf")),
  ]);
  const fonts = [
    { name: "Inter", data: regular, weight: 400, style: "normal" },
    { name: "Inter", data: bold, weight: 700, style: "normal" },
  ];

  // 1. Logo PNG (derived from favicon.svg). Generate once, then cache.
  const logoExists = await fs
    .stat(LOGO_PNG_PATH)
    .then(() => true)
    .catch(() => false);
  if (!logoExists) {
    const svgSrc = await fs.readFile(FAVICON_PATH);
    const png = await renderLogo(svgSrc);
    await fs.writeFile(LOGO_PNG_PATH, png);
    console.log("og: wrote logo-512.png");
  }

  // 2. Default site-wide OG
  const defaultOut = path.join(OUT_DIR, "default.png");
  const defaultExists = await fs
    .stat(defaultOut)
    .then(() => true)
    .catch(() => false);
  if (!defaultExists) {
    const png = await renderPng(
      fonts,
      ogTemplate({
        title: "Programming notes on .NET, C#, EF Core, MAUI, Blazor and Flutter.",
        tags: [".NET", "C#", "Flutter"],
        date: "startdebugging.net",
        brand: BRAND,
      }),
    );
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(defaultOut, png);
    console.log("og: wrote default.png");
  }

  // 3. Per-post OGs (cached by mtime).
  const posts = await walkPosts();
  let generated = 0;
  let skipped = 0;
  for (const p of posts) {
    const outDir = path.join(OUT_DIR, p.year, p.month);
    const outFile = path.join(outDir, `${p.slug}.png`);
    const [srcStat, outStat] = await Promise.all([
      fs.stat(p.filePath).catch(() => null),
      fs.stat(outFile).catch(() => null),
    ]);
    if (!srcStat) continue;
    if (outStat && outStat.mtimeMs >= srcStat.mtimeMs) {
      skipped++;
      continue;
    }
    const raw = await fs.readFile(p.filePath, "utf8");
    const { data: fm } = matter(raw);
    if (fm.draft) {
      skipped++;
      continue;
    }
    const title = fm.title || p.slug;
    const date = formatDate(fm.pubDate);
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    try {
      const png = await renderPng(
        fonts,
        ogTemplate({ title, tags, date, brand: BRAND }),
      );
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(outFile, png);
      generated++;
      if (generated % 25 === 0) {
        console.log(`og: generated ${generated} so far...`);
      }
    } catch (err) {
      console.error(`og: failed for ${p.year}/${p.month}/${p.slug}:`, err.message);
    }
  }

  console.log(
    `og: done. generated=${generated} skipped=${skipped} total=${posts.length}`,
  );
}

main().catch((err) => {
  console.error("og: fatal", err);
  process.exit(1);
});
