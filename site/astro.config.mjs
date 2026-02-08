import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://startdebugging.net",
  base: "/",
  output: "static",
  trailingSlash: "always",
});

