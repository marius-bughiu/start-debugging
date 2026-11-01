import assert from "node:assert/strict";
import test from "node:test";
import { TAG_ALIASES, canonicalTag, canonicalTags, tagPages, isTagAliasPath } from "../src/lib/tags.mjs";

test("aliases have one canonical destination and leave distinct topics alone", () => {
  for (const [alias, target] of Object.entries(TAG_ALIASES)) {
    assert.notEqual(alias, target);
    assert.equal(canonicalTag(target), target, `${alias} creates a redirect chain`);
  }
  for (const tag of ["container", "containers", "source-gen", "source-generators", "aspnet", "aspnetcore", "dotnet-8", "dotnet-11"]) {
    assert.equal(canonicalTag(tag), tag);
  }
  assert.deepEqual(canonicalTags(["efcore", "ef-core", "dotnet", "efcore"]), ["ef-core", "dotnet"]);
});

test("merging aliases preserves post membership, order and old pagination", () => {
  const posts = Array.from({ length: 13 }, (_, i) => ({
    slug: `2026/01/post-${i}`,
    data: { tags: i < 11 ? ["efcore", "ef-core"] : ["ef-core"] },
  }));
  const pages = tagPages(posts, 10);
  assert.equal(new Set(pages.map((page) => page.slug)).size, pages.length);
  const canonical = pages.filter((page) => !page.redirect);
  assert.deepEqual(canonical.flatMap((page) => page.posts.map((post) => post.slug)), posts.map((post) => post.slug));
  assert.deepEqual(canonical.map((page) => page.totalCount), [13, 13]);
  assert.deepEqual(pages.filter((page) => page.redirect).map(({ slug, redirect }) => [slug, redirect]), [
    ["efcore", "ef-core"], ["efcore/2", "ef-core/2"],
  ]);
  for (const page of pages.filter((page) => page.redirect)) {
    assert(canonical.some((target) => target.slug === page.redirect), `Missing target for ${page.slug}`);
  }
});

test("legacy URLs survive source-tag migrations and reduced page counts", () => {
  const pages = tagPages([
    { slug: "one", data: { tags: ["ef-core"], tagAliases: ["efcore"] } },
    { slug: "two", data: { tags: ["maui"] } },
  ]);
  assert(pages.some((page) => page.slug === "efcore" && page.redirect === "ef-core"));
  assert(pages.some((page) => page.slug === "dotnet-maui" && page.redirect === "maui"));
  assert(pages.some((page) => page.slug === "dotnet-maui/2" && page.redirect === "maui"));
  assert(pages.some((page) => page.slug === "efcore/2" && page.redirect === "ef-core"));
  assert(!tagPages([{ slug: "one", data: { tags: ["agent-skills"] } }], 10, "ja").some((page) => page.slug === "agentskills"));
  assert.deepEqual(tagPages([]), []);
  assert.throws(() => tagPages([], 0));
});

test("sitemap excludes alias roots and pagination in every supported language", () => {
  for (const prefix of ["", "es/", "pt-br/", "de/", "ru/", "ja/"]) {
    assert(isTagAliasPath(`/${prefix}tag/efcore/`));
    assert(isTagAliasPath(`/${prefix}tag/efcore/2/`));
    assert(!isTagAliasPath(`/${prefix}tag/ef-core/`));
    assert(!isTagAliasPath(`/${prefix}tag/ef-core/2/`));
  }
  assert(!isTagAliasPath("/2026/10/efcore/"));
});
