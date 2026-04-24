import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

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
    }),
  ],
  markdown: {
    rehypePlugins: [rehypeLazyImages],
  },
  ...(process.env.VITE_CACHE_DIR
    ? { vite: { cacheDir: process.env.VITE_CACHE_DIR } }
    : {}),
});
