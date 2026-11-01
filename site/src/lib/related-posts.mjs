import { canonicalTags } from "./tags.mjs";

/** Broad platforms and article formats are useful context, not subjects. */
const BROAD_TAGS = new Set([
  "dotnet", "csharp", "dart", "flutter", "javascript", "typescript", "python",
  "java", "programming", "development", "software-development", "performance",
  "errors", "error", "how-to", "comparison", "migration", "tutorial", "tutorials",
  "ai", "ai-agents", "llm", "async", "tooling", "open-source", "informational",
  "google", "microsoft", "apple", "amazon", "meta",
]);
const VERSION_TAG = /^(dotnet|csharp|ef-core|aspnetcore|maui|flutter|dart)-(\d+)(?:[-.]\d+)*$/;
const STOP_WORDS = new Set((
  "a an and are as at be been before between by can could does for from has have how " +
  "if in into is it its more new no not of on or out over that the their then these " +
  "this through to use used using was what when where which why will with without " +
  "your you fix fixes fixed finally now actually really get gets got add adds added " +
  "support supports supported default instead after first same one two three part " +
  "read reads write writes let lets work works run runs make makes stop stops " +
  "app apps application project code version release preview stable net core " +
  "csharp dotnet dart flutter javascript typescript python java programming " +
  "google microsoft apple amazon meta performance error errors exception exceptions reference references guide tutorial howto"
).split(/\s+/));

/** Canonical, locale-independent article IDs accepted in relatedPosts. */
export const RELATED_POST_SLUG = /^\d{4}\/(?:0[1-9]|1[0-2])\/[a-z0-9][a-z0-9_-]*$/;

/** @typedef {{slug: string, data: {title?: string, tags?: string[], lang?: string, draft?: boolean, pubDate?: Date | string, relatedPosts?: string[]}}} RelatedPost */

/** @param {RelatedPost} post */
const language = (post) => post.data.lang ?? "en";
/** @param {RelatedPost} post */
const baseSlug = (post) => language(post) !== "en" && post.slug.startsWith(`${language(post)}/`)
  ? post.slug.slice(language(post).length + 1) : post.slug;
/** @param {string} tag */
const isSubjectTag = (tag) => !BROAD_TAGS.has(tag) && !VERSION_TAG.test(tag);

/**
 * Shared canonical tags for a topic hint, with subjects before broad platforms
 * or versions. Passing the same post twice also gives its own ordered tags.
 * @param {RelatedPost} source
 * @param {RelatedPost} candidate
 * @returns {string[]}
 */
export function relatedTopicTags(source, candidate) {
  const wanted = new Set(canonicalTags(source.data.tags ?? []));
  return canonicalTags(candidate.data.tags ?? []).filter((tag) => wanted.has(tag))
    .sort((a, b) => Number(isSubjectTag(b)) - Number(isSubjectTag(a)));
}

/** @param {RelatedPost} post @returns {Set<string>} */
function subjectTerms(post) {
  const text = `${post.data.title ?? ""} ${baseSlug(post).split("/").at(-1)}`;
  // Keep API identifiers intact and also expose their words (NullReferenceException).
  const words = `${text} ${text.replace(/([a-z])([A-Z])/g, "$1 $2")}`
    .toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !STOP_WORDS.has(word))
    .map((word) => {
      // Query/queries and split/splitting should describe the same subject.
      if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
      if (word.length > 5 && word.endsWith("ing") && word !== "string") {
        return word.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
      }
      return word.length > 4 && /[^s]s$/.test(word) ? word.slice(0, -1) : word;
    }));
}

/** @param {RelatedPost} post */
function versions(post) {
  const result = new Map();
  for (const tag of canonicalTags(post.data.tags ?? [])) {
    const match = tag.match(VERSION_TAG);
    if (match) {
      if (!result.has(match[1])) result.set(match[1], new Set());
      result.get(match[1]).add(match[2]);
    }
  }
  return result;
}

/**
 * Curated same-language articles first; then related subjects, not just shared
 * platforms. Rare subject tags carry most weight. Meaningful title/slug terms
 * rescue sparsely tagged older posts. Versions are a small preference and
 * publication date breaks ties only. No minimum number of results is filled.
 *
 * @template {RelatedPost} T
 * @param {T} source
 * @param {T[]} posts
 * @param {number} [limit]
 * @returns {T[]}
 */
export function rankRelatedPosts(source, posts, limit = 4) {
  return createRelatedPostRanker(posts)(source, limit);
}

/**
 * Prepare immutable subject data once for a build's content snapshot. The
 * returned selector remains independent of calls made for other source posts.
 * @template {RelatedPost} T
 * @param {T[]} posts
 * @returns {(source: T, limit?: number) => T[]}
 */
export function createRelatedPostRanker(posts) {
  const locales = new Set(posts.filter((post) => !post.data.draft).map(language));
  const indexes = new Map();
  for (const locale of locales) {
    const entries = new Map();
    const tagCounts = new Map();
    const termCounts = new Map();
    for (const post of posts) {
      const id = baseSlug(post);
      if (post.data.draft || language(post) !== locale || entries.has(id)) continue;
      const tags = canonicalTags(post.data.tags ?? []);
      const terms = subjectTerms(post);
      entries.set(id, { post, tags, terms, versions: versions(post) });
      for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      for (const term of terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
    indexes.set(locale, { entries, tagCounts, termCounts });
  }
  return (source, limit = 4) => {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const index = indexes.get(language(source));
    if (!index) return [];
    const { entries, tagCounts, termCounts } = index;
    const sourceId = baseSlug(source);
    const selected = new Map();
    for (const slug of source.data.relatedPosts ?? []) {
      if (slug !== sourceId && RELATED_POST_SLUG.test(slug) && entries.has(slug)) {
        selected.set(slug, entries.get(slug).post);
      }
      if (selected.size === limit) return [...selected.values()];
    }
    const sourceTags = new Set(canonicalTags(source.data.tags ?? []));
    const sourceTerms = subjectTerms(source);
    const sourceVersions = versions(source);
    const population = Math.max(entries.size, 50);
    const scored = [];
    for (const [id, candidate] of entries) {
      if (id === sourceId || selected.has(id)) continue;
      const shared = candidate.tags.filter((tag) => sourceTags.has(tag));
      const subjects = shared.filter(isSubjectTag);
      const matchingTerms = [...sourceTerms].filter((term) => candidate.terms.has(term));
      // A lone common word is not enough; a rare API or error name can be.
      const distinctive = matchingTerms.filter((term) => (termCounts.get(term) ?? 0) / population <= 0.05);
      if (!subjects.length && !(shared.length && (distinctive.length || matchingTerms.length >= 2))) continue;
      let score = subjects.reduce((sum, tag) => sum + 8 + Math.log2(1 + population / (tagCounts.get(tag) ?? 1)), 0);
      score += Math.min(matchingTerms.length, 4) * 2;
      for (const [family, majors] of sourceVersions) {
        const other = candidate.versions.get(family);
        if (other) score += [...majors].some((major) => other.has(major)) ? 1 : -1;
      }
      scored.push({ id, post: candidate.post, score });
    }
    scored.sort((a, b) => b.score - a.score ||
      new Date(b.post.data.pubDate ?? 0).valueOf() - new Date(a.post.data.pubDate ?? 0).valueOf() ||
      a.post.slug.localeCompare(b.post.slug));
    for (const { id, post } of scored) {
      selected.set(id, post);
      if (selected.size === limit) break;
    }
    return [...selected.values()];
  };
}
