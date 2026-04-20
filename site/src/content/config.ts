import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.date(),
    updatedDate: z.date().optional(),
    draft: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
  }),
});

const pillars = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    // Tags this pillar indexes. The pillar page auto-collects every blog
    // post that shares at least one tag in this list.
    indexTags: z.array(z.string()),
    pubDate: z.date(),
    updatedDate: z.date().optional(),
    draft: z.boolean().optional(),
    // Optional hero tagline shown under the H1.
    tagline: z.string().optional(),
  }),
});

export const collections = { blog, pillars };

