import { defineCollection, z } from "astro:content";

const LOCALES = ["en", "es", "pt-br", "de", "ru", "ja"] as const;

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.date(),
    updatedDate: z.date().optional(),
    draft: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    lang: z.enum(LOCALES).default("en"),
    translationOf: z.string().optional(),
    translatedBy: z.enum(["claude", "human"]).optional(),
    translationDate: z.date().optional(),
  }),
});

const pillars = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    indexTags: z.array(z.string()),
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

