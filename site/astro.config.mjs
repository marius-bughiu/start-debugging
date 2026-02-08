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
});
