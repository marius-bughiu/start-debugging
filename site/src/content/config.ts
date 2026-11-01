import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { canonicalTag, canonicalTags } from "../lib/tags.mjs";
import { RELATED_POST_SLUG } from "../lib/related-posts.mjs";

const LOCALES = ["en", "es", "pt-br", "de", "ru", "ja"] as const;

// `npm run build:page` (scripts/build-page.mjs) sets BUILD_ONLY to the posts it
// builds, as glob patterns relative to src/content/blog. The blog collection
// then loads just those files instead of every post in every locale. The
// loader and `_legacy` flags mirror what Astro generates for
// `type: "content"`, so entries keep `slug` and `render()`.
const buildOnly: string[] | undefined = process.env.BUILD_ONLY
  ? JSON.parse(process.env.BUILD_ONLY).blog
  : undefined;

const blogSource = buildOnly
  ? {
      _legacy: true,
      loader: glob({ base: "./src/content/blog", pattern: buildOnly, _legacy: true }),
    }
  : { type: "content" as const };

const blog = defineCollection({
  ...blogSource,
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.date(),
    updatedDate: z.date().optional(),
    draft: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    // Optional editorial choices, resolved to published posts in this language.
    relatedPosts: z.array(z.string().regex(RELATED_POST_SLUG,
      "Use a canonical base slug: YYYY/MM/article-name, without a locale or slashes at either end."
    )).optional(),
    lang: z.enum(LOCALES).default("en"),
    translationOf: z.string().optional(),
    translatedBy: z.enum(["claude", "human"]).optional(),
    translationDate: z.date().optional(),
    // Drives schema.org JSON-LD selection: error-page → FAQPage,
    // how-to/migration → HowTo, vs → unchanged BlogPosting. New posts set
    // this from the matching `content-strategy/templates/*.md`.
    template: z
      .enum(["error-page", "how-to", "migration", "vs"])
      .optional(),
    // Per-post comments override. Default cutoff is `pubDate >= 2024-01-01`.
    // Set `comments: false` to suppress the widget on a post that would
    // otherwise show it; set `comments: true` to opt an older post in.
    comments: z.boolean().optional(),
  }).transform((data) => ({
    ...data,
    // Keep the old spellings for backward-compatible static redirect pages.
    tagAliases: [...new Set((data.tags ?? []).filter((tag) => canonicalTag(tag) !== tag))],
    tags: data.tags ? canonicalTags(data.tags) : undefined,
  })),
});

const pillars = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    indexTags: z.array(z.string()).transform(canonicalTags),
    pubDate: z.date(),
    updatedDate: z.date().optional(),
    draft: z.boolean().optional(),
    tagline: z.string().optional(),
    lang: z.enum(LOCALES).default("en"),
    translationOf: z.string().optional(),
  }),
});

const pages = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    lang: z.enum(LOCALES).default("en"),
  }),
});

export const collections = { blog, pillars, pages };

