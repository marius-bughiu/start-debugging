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

/**
 * Find the chronologically newer and older published post relative to `post`,
 * using the same ordering as getPublishedBlogPosts() (pubDate desc).
 *
 * Returns `{ prev, next }` where:
 *   - `prev` is the older post (the "Previous" arrow in chronological reading order)
 *   - `next` is the newer post
 * Either may be `undefined` at the ends of the list.
 */
export async function getAdjacentPosts(
  post: BlogPost,
): Promise<{ prev: BlogPost | undefined; next: BlogPost | undefined }> {
  const posts = await getPublishedBlogPosts();
  const idx = posts.findIndex((p) => p.slug === post.slug);
  if (idx === -1) return { prev: undefined, next: undefined };
  // Array is sorted newest-first. Newer = idx-1, older = idx+1.
  return {
    next: idx > 0 ? posts[idx - 1] : undefined,
    prev: idx < posts.length - 1 ? posts[idx + 1] : undefined,
  };
}

/**
 * Score posts by shared-tag count relative to `post`, then by recency as a
 * tiebreaker, and return the top `limit` matches. Never includes the source
 * post itself. Posts with zero tag overlap are still included at the tail so
 * the "Related" section always fills — for a new post with a brand-new tag,
 * falling back to recent posts is better than showing nothing.
 */
export async function getRelatedPosts(
  post: BlogPost,
  limit = 4,
): Promise<BlogPost[]> {
  const posts = await getPublishedBlogPosts();
  const sourceTags = new Set(post.data.tags ?? []);

  const scored = posts
    .filter((p) => p.slug !== post.slug)
    .map((p) => {
      const tags = p.data.tags ?? [];
      let overlap = 0;
      for (const t of tags) if (sourceTags.has(t)) overlap++;
      return { post: p, overlap };
    });

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return b.post.data.pubDate.valueOf() - a.post.data.pubDate.valueOf();
  });

  return scored.slice(0, limit).map((s) => s.post);
}
