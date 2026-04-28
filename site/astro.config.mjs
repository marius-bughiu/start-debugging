import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import matter from "gray-matter";

/** Rehype plugin: adds loading="lazy" to all <img> elements */
function rehypeLazyImages() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === "element" && node.tagName === "img") {
        node.properties = node.properties || {};
        node.properties.loading = "lazy";
      }
      if (node.children) node.children.forEach(visit);
    };
    visit(tree);
  };
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(__dirname, "src", "content");

function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdown(full));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

// Build URL-path → lastmod ISO string map by reading frontmatter directly.
// Covers blog posts and pillar pages in every locale; tag/archive pages stay
// without lastmod (no canonical "last changed" date).
function buildLastmodMap() {
  const map = new Map();

  const addEntry = ({ slug, data, kind }) => {
    if (data.draft) return;
    const lang = data.lang ?? "en";
    const iso = toIso(data.updatedDate ?? data.translationDate ?? data.pubDate);
    if (!iso) return;
    const prefix = `${lang}/`;
    const base = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
    let urlPath;
    if (kind === "blog") {
      urlPath = lang === "en" ? `/${base}/` : `/${lang}/${base}/`;
    } else {
      urlPath = lang === "en" ? `/pillars/${base}/` : `/${lang}/pillars/${base}/`;
    }
    map.set(urlPath, iso);
  };

  const blogDir = path.join(CONTENT_DIR, "blog");
  for (const file of walkMarkdown(blogDir)) {
    const slug = path
      .relative(blogDir, file)
      .replace(/\\/g, "/")
      .replace(/\.md$/, "");
    const { data } = matter(fs.readFileSync(file, "utf8"));
    addEntry({ slug, data, kind: "blog" });
  }

  const pillarDir = path.join(CONTENT_DIR, "pillars");
  for (const file of walkMarkdown(pillarDir)) {
    const slug = path
      .relative(pillarDir, file)
      .replace(/\\/g, "/")
      .replace(/\.md$/, "");
    const { data } = matter(fs.readFileSync(file, "utf8"));
    addEntry({ slug, data, kind: "pillar" });
  }

  return map;
}

const LASTMOD_BY_PATH = buildLastmodMap();

export default defineConfig({
  site: "https://startdebugging.net",
  base: "/",
  output: "static",
  trailingSlash: "always",
  // Locale keys mirror the URL segment used for each non-English locale.
  // English stays at the root (prefixDefaultLocale: false).
  i18n: {
    defaultLocale: "en",
    locales: ["en", "es", "pt-br", "de", "ru", "ja"],
    routing: {
      prefixDefaultLocale: false,
      redirectToDefaultLocale: false,
    },
  },
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: "en",
        locales: {
          en: "en-US",
          es: "es-ES",
          "pt-br": "pt-BR",
          de: "de-DE",
          ru: "ru-RU",
          ja: "ja-JP",
        },
      },
      serialize(item) {
        try {
          const pathname = new URL(item.url).pathname;
          const iso = LASTMOD_BY_PATH.get(pathname);
          if (iso) item.lastmod = iso;
        } catch {
          // Fall through; entry stays unchanged.
        }
        return item;
      },
    }),
  ],
  markdown: {
    rehypePlugins: [rehypeLazyImages],
  },
  ...(process.env.VITE_CACHE_DIR
    ? { vite: { cacheDir: process.env.VITE_CACHE_DIR } }
    : {}),
});
