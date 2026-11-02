import { canonicalTag } from "./tags.mjs";

const normalizedTags = (tags) => new Set(tags.map((tag) => canonicalTag(tag.toLowerCase())));

/** Match a pillar's subject and, when supplied, its technology scope. */
export function selectPillarPosts(posts, indexTags, indexRequireAnyTags = []) {
  const topics = normalizedTags(indexTags);
  const required = normalizedTags(indexRequireAnyTags);
  return posts.filter((post) => {
    const tags = normalizedTags(post.data.tags ?? []);
    return [...topics].some((tag) => tags.has(tag)) &&
      (!required.size || [...required].some((tag) => tags.has(tag)));
  });
}
