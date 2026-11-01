import assert from "node:assert/strict";
import test from "node:test";
import { rankRelatedPosts, createRelatedPostRanker, relatedTopicTags, RELATED_POST_SLUG } from "../src/lib/related-posts.mjs";

const post = (name, title, tags, extra = {}) => ({
  slug: `2026/01/${name}`,
  data: { title, tags, pubDate: new Date("2026-01-01"), ...extra },
});
const slugs = (posts) => posts.map((p) => p.slug);

test("Dapper and SQL subjects outrank newer generic C# performance posts", () => {
  const source = post("dapper-parameters", "How Dapper nvarchar parameters affect SQL Server indexes", ["csharp", "dotnet", "dapper", "sql-server", "performance"]);
  const dapper = post("dapper-read-path", "EF Core compiled queries vs Dapper", ["ef-core", "dapper", "performance"]);
  const sql = post("sql-indexes", "Reading SQL Server execution plans", ["sql-server"]);
  const generic = post("span-loop", "A faster loop with Span<T>", ["csharp", "dotnet", "performance"], { pubDate: new Date("2026-10-01") });
  assert.deepEqual(slugs(rankRelatedPosts(source, [source, generic, sql, dapper])), [sql.slug, dapper.slug]);
});

test("title subjects rescue a C#-only null-reference article without matching generic fixes", () => {
  const source = post("nullreferenceexception", "C# What is a NullReferenceException and how to fix it?", ["csharp"]);
  const useful = post("throw-if-null", "C# throw if null: ArgumentNullException.ThrowIfNull", ["csharp"]);
  const unrelated = post("project-reference", "Fix C# project reference errors", ["csharp"], { pubDate: new Date("2026-10-01") });
  const latest = post("shuffle-array", "C# How to shuffle an array", ["csharp"], { pubDate: new Date("2026-11-01") });
  assert.deepEqual(slugs(rankRelatedPosts(source, [latest, unrelated, useful])), [useful.slug]);
});

test("broad tags, versions and generic headline words alone do not fill the list", () => {
  const source = post("first", "How to fix your app in .NET 11", ["dotnet", "dotnet-11", "csharp", "errors", "performance"]);
  const weak = post("second", "How to fix your project in .NET 11", ["dotnet", "dotnet-11", "csharp", "errors", "performance"]);
  assert.deepEqual(rankRelatedPosts(source, [weak]), []);
});

test("a shared vendor alone does not relate unrelated Google products", () => {
  const source = post("8bit-google-maps", "8-bit Google Maps for NES", ["google"]);
  const unrelated = post("google-ai", "Google releases an AI coding assistant", ["google"]);
  const maps = post("google-maps-offline", "Offline Google Maps", ["google"]);
  assert.deepEqual(slugs(rankRelatedPosts(source, [unrelated, maps])), [maps.slug]);
});

test("prefer a compatible major version without excluding evergreen or older guidance", () => {
  const source = post("source-query", "EF Core query splitting", ["efcore", "dotnet-11"]);
  const compatible = post("compatible-query", "EF Core query splitting", ["ef-core", "dotnet-11"], { pubDate: new Date("2026-01-01") });
  const evergreen = post("evergreen-query", "EF Core query splitting", ["ef-core"], { pubDate: new Date("2026-02-01") });
  const otherVersion = post("previous-query", "EF Core query splitting", ["ef-core", "dotnet-10"], { pubDate: new Date("2026-11-01") });
  assert.deepEqual(slugs(rankRelatedPosts(source, [otherVersion, evergreen, compatible])), [compatible.slug, evergreen.slug, otherVersion.slug]);
});

test("curation resolves canonical base slugs in the same locale and validates destinations", () => {
  const source = post("source", "Source", ["source-topic"], { lang: "es", relatedPosts: [
    "2026/01/curated", "2026/01/curated", "2026/01/absent", "2026/01/draft", "2026/01/source",
    "/2026/01/automatic/", "es/2026/01/automatic", "2026/01/english-only",
  ] });
  source.slug = `es/${source.slug}`;
  const curated = post("curated", "Editorially related despite different tags", ["different-topic"], { lang: "es" });
  curated.slug = `es/${curated.slug}`;
  const draft = post("draft", "Draft", ["source-topic"], { lang: "es", draft: true });
  draft.slug = `es/${draft.slug}`;
  const automatic = post("automatic", "Automatic", ["source-topic"], { lang: "es" });
  automatic.slug = `es/${automatic.slug}`;
  const englishOnly = post("english-only", "English", ["source-topic"]);
  const englishCurated = post("curated", "English translation", ["different-topic"]);
  assert.deepEqual(slugs(rankRelatedPosts(source, [source, englishCurated, englishOnly, draft, automatic, curated, curated])), [curated.slug, automatic.slug]);
});

test("curated order wins, limits apply, and automatic matches cannot duplicate curated picks", () => {
  const source = post("source", "Source", ["ef-core"], { relatedPosts: ["2026/01/second", "2026/01/first"] });
  const first = post("first", "First", ["ef-core"]);
  const second = post("second", "Second", ["ef-core"]);
  const third = post("third", "Third", ["ef-core"]);
  assert.deepEqual(slugs(rankRelatedPosts(source, [first, second, third, first], 2)), [second.slug, first.slug]);
  assert.deepEqual(slugs(rankRelatedPosts(source, [first, second, third], 1)), [second.slug]);
  assert.deepEqual(rankRelatedPosts(source, [first], 0), []);
  assert.deepEqual(rankRelatedPosts(source, [first], -1), []);
});

test("publication date only breaks otherwise equal relevance", () => {
  const source = post("source", "Source", ["dapper"]);
  const older = post("alpha", "Alpha", ["dapper"], { pubDate: new Date("2026-01-01") });
  const newer = post("beta", "Beta", ["dapper"], { pubDate: new Date("2026-02-01") });
  assert.deepEqual(slugs(rankRelatedPosts(source, [older, newer])), [newer.slug, older.slug]);
});

test("topic hints canonicalize aliases, dedupe tags and put subjects before broad tags", () => {
  const source = post("source", "Source", ["dotnet", "efcore", "performance", "ef-core"]);
  const other = post("other", "Other", ["performance", "dotnet", "ef-core", "efcore"]);
  assert.deepEqual(relatedTopicTags(source, other), ["ef-core", "performance", "dotnet"]);
});

test("editorial IDs accept base article slugs, not locale URLs or malformed dates", () => {
  assert(RELATED_POST_SLUG.test("2026/11/a-valid-article"));
  assert(RELATED_POST_SLUG.test("2026/01/flutter-3-x-routing-tp_router-tries-to-delete-your-route-table-and-its-a-compelling-idea"));
  for (const slug of ["/2026/11/article/", "es/2026/11/article", "2026/13/article", "2026/00/article", "2026/11/article?x=1", "2026/11/article#section", "https://example.com/2026/11/article", "2026/11/../article"]) {
    assert(!RELATED_POST_SLUG.test(slug), slug);
  }
});

test("query splitting matches split queries ahead of other EF Core query topics", () => {
  const source = post("split-queries", "EF Core prunes joins in split queries", ["ef-core", "sql-server", "performance"]);
  const close = post("query-splitting", "EF Core query splitting avoids cartesian explosions", ["ef-core", "sql-server", "performance"]);
  const loose = post("query-parameters", "EF Core query parameters", ["ef-core", "sql-server", "performance"], { pubDate: new Date("2026-11-01") });
  const rank = createRelatedPostRanker([source, loose, close]);
  assert.equal(rank(source)[0], close);
  assert.deepEqual(rank(source), rankRelatedPosts(source, [source, loose, close]));
  rank(close);
  assert.equal(rank(source)[0], close, "other calls must not alter later rankings");
});
