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
  integrations: [sitemap()],
  markdown: {
    rehypePlugins: [rehypeLazyImages],
  },
  // Allow overriding Vite's cache directory via env for sandboxed build
  // environments where node_modules/.vite is not writable. Defaults to Vite's
  // own behaviour (inside node_modules) when unset.
  ...(process.env.VITE_CACHE_DIR
    ? { vite: { cacheDir: process.env.VITE_CACHE_DIR } }
    : {}),
});
