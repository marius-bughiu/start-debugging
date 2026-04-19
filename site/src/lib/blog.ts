import { getCollection, type CollectionEntry } from "astro:content";

export type BlogPost = CollectionEntry<"blog">;

export async function getPublishedBlogPosts(): Promise<BlogPost[]> {
  return (await getCollection("blog"))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

// Rough reading time in whole minutes at ~220 wpm. Code-heavy posts read
// slower but 220 is the most defensible default for mixed technical content.
const WORDS_PER_MINUTE = 220;

export function estimateReadingTimeMinutes(body: string | undefined): number {
  if (!body) return 1;
  // Strip fenced code blocks and inline code so token soup doesn't inflate
  // the count, but keep prose.
  const stripped = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  const words = stripped.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/**
 * Site-relative path where a post's generated OG image lives.
 * Matches the layout emitted by scripts/generate-og-images.mjs.
 */
export function ogImagePathForPost(post: BlogPost): string {
  const m = post.slug.match(/^(\d{4})\/(\d{2})\/([^/]+)$/);
  if (!m) return "/og/default.png";
  return `/og/${m[1]}/${m[2]}/${m[3]}.png`;
}
