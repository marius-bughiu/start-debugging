import { getCollection, type CollectionEntry } from "astro:content";

export type BlogPost = CollectionEntry<"blog">;
export type Pillar = CollectionEntry<"pillars">;

export const LOCALES = ["en", "es", "pt-br", "de", "ru", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_HREFLANG: Record<Locale, string> = {
  en: "en",
  es: "es",
  "pt-br": "pt-BR",
  de: "de",
  ru: "ru",
  ja: "ja",
};

export const LOCALE_OG: Record<Locale, string> = {
  en: "en_US",
  es: "es_ES",
  "pt-br": "pt_BR",
  de: "de_DE",
  ru: "ru_RU",
  ja: "ja_JP",
};

const LOCALE_SET: ReadonlySet<Locale> = new Set(LOCALES);

export function isLocale(s: string | undefined): s is Locale {
  return !!s && LOCALE_SET.has(s as Locale);
}

export function langOf(entry: BlogPost | Pillar): Locale {
  return (entry.data.lang ?? DEFAULT_LOCALE) as Locale;
}

/**
 * Canonical base slug regardless of language. For an English entry this is
 * the full collection slug. For a translation it strips the leading
 * `{lang}/` segment so `translationOf` comparisons align.
 */
export function baseSlugOf(entry: BlogPost | Pillar): string {
  const lang = langOf(entry);
  if (lang === "en") return entry.slug;
  const prefix = `${lang}/`;
  return entry.slug.startsWith(prefix) ? entry.slug.slice(prefix.length) : entry.slug;
}

/** URL path for a post, honoring its language. */
export function urlPathForPost(post: BlogPost): string {
  const lang = langOf(post);
  const base = baseSlugOf(post);
  return lang === "en" ? `/${base}/` : `/${lang}/${base}/`;
}

/** URL path for a pillar, honoring its language. */
export function urlPathForPillar(pillar: Pillar): string {
  const lang = langOf(pillar);
  const base = baseSlugOf(pillar);
  return lang === "en" ? `/pillars/${base}/` : `/${lang}/pillars/${base}/`;
}

export async function getPublishedBlogPosts(
  lang: Locale = DEFAULT_LOCALE,
): Promise<BlogPost[]> {
  return (await getCollection("blog"))
    .filter((p) => !p.data.draft && langOf(p) === lang)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

// Rough reading time in whole minutes. English / Latin / Cyrillic posts use a
// ~220 wpm whitespace-split baseline. Japanese uses a character-based count
// (~500 chars/min) since Japanese has no inter-word whitespace.
const WORDS_PER_MINUTE = 220;
const JA_CHARS_PER_MINUTE = 500;

export function estimateReadingTimeMinutes(
  body: string | undefined,
  lang: Locale = DEFAULT_LOCALE,
): number {
  if (!body) return 1;
  const stripped = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  if (lang === "ja") {
    const chars = stripped.replace(/\s+/g, "").length;
    return Math.max(1, Math.ceil(chars / JA_CHARS_PER_MINUTE));
  }
  const words = stripped.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/**
 * Site-relative path where a post's generated OG image lives.
 * Matches the layout emitted by scripts/generate-og-images.mjs.
 */
export function ogImagePathForPost(post: BlogPost): string {
  const lang = langOf(post);
  const base = baseSlugOf(post);
  const m = base.match(/^(\d{4})\/(\d{2})\/([^/]+)$/);
  if (!m) return "/og/default.png";
  if (lang === "en") return `/og/${m[1]}/${m[2]}/${m[3]}.png`;
  return `/og/${lang}/${m[1]}/${m[2]}/${m[3]}.png`;
}

/**
 * Find the chronologically newer and older published post relative to `post`,
 * filtered to the same language. Returns `{ prev, next }`.
 */
export async function getAdjacentPosts(
  post: BlogPost,
): Promise<{ prev: BlogPost | undefined; next: BlogPost | undefined }> {
  const posts = await getPublishedBlogPosts(langOf(post));
  const idx = posts.findIndex((p) => p.slug === post.slug);
  if (idx === -1) return { prev: undefined, next: undefined };
  return {
    next: idx > 0 ? posts[idx - 1] : undefined,
    prev: idx < posts.length - 1 ? posts[idx + 1] : undefined,
  };
}

/**
 * Score posts by shared-tag count relative to `post`, filtered to the same
 * language. Falls back to recency so the list always fills.
 */
export async function getRelatedPosts(
  post: BlogPost,
  limit = 4,
): Promise<BlogPost[]> {
  const posts = await getPublishedBlogPosts(langOf(post));
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

/** Posts that share at least one tag with a pillar's indexTags, sorted newest-first. */
export async function getPillarPosts(
  indexTags: string[],
  lang: Locale = DEFAULT_LOCALE,
): Promise<BlogPost[]> {
  const wanted = new Set(indexTags.map((t) => t.toLowerCase()));
  const posts = await getPublishedBlogPosts(lang);
  return posts.filter((p) => {
    const tags = (p.data.tags ?? []).map((t) => t.toLowerCase());
    for (const t of tags) if (wanted.has(t)) return true;
    return false;
  });
}

export async function getPublishedPillars(
  lang: Locale = DEFAULT_LOCALE,
): Promise<Pillar[]> {
  return (await getCollection("pillars"))
    .filter((p) => !p.data.draft && langOf(p) === lang)
    .sort((a, b) => a.data.title.localeCompare(b.data.title));
}

/**
 * For a given post (any language), return a map of locale -> translation.
 * Includes the source post itself. Used to emit hreflang alternates.
 */
export async function getTranslations(
  post: BlogPost,
): Promise<Map<Locale, BlogPost>> {
  const base = baseSlugOf(post);
  const all = await getCollection("blog");
  const result = new Map<Locale, BlogPost>();
  for (const p of all) {
    if (p.data.draft) continue;
    if (baseSlugOf(p) === base) {
      result.set(langOf(p), p);
    }
  }
  return result;
}

/** Same as `getTranslations` but for pillars. */
export async function getPillarTranslations(
  pillar: Pillar,
): Promise<Map<Locale, Pillar>> {
  const base = baseSlugOf(pillar);
  const all = await getCollection("pillars");
  const result = new Map<Locale, Pillar>();
  for (const p of all) {
    if (p.data.draft) continue;
    if (baseSlugOf(p) === base) {
      result.set(langOf(p), p);
    }
  }
  return result;
}
