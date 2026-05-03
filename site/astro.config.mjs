import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import path from "node:path";
import url from "node:url";
import { rehypeInjectAd } from "./src/lib/rehype-inject-ad.mjs";
import { buildLastmodMap } from "./src/lib/content-paths.mjs";

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

const LASTMOD_BY_PATH = buildLastmodMap(CONTENT_DIR);

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
    rehypePlugins: [rehypeLazyImages, rehypeInjectAd],
  },
  ...(process.env.VITE_CACHE_DIR
    ? { vite: { cacheDir: process.env.VITE_CACHE_DIR } }
    : {}),
});
