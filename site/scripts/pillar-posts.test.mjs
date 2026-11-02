import test from "node:test";
import assert from "node:assert/strict";
import { selectPillarPosts } from "../src/lib/pillar-posts.mjs";

const post = (slug, tags) => ({ slug, data: { tags } });
test("a scoped async guide keeps .NET concurrency and excludes another language's async API", () => {
  const posts = [post("csharp", ["async", "csharp"]), post("dart", ["async", "dart"]), post("ef", ["concurrency", "ef-core"])];
  assert.deepEqual(selectPillarPosts(posts, ["async", "concurrency"], ["csharp", "ef-core"]).map((p) => p.slug), ["csharp", "ef"]);
});
test("technology scope cannot admit an unrelated subject", () => {
  assert.deepEqual(selectPillarPosts([post("json", ["json", "csharp"])], ["async"], ["csharp"]), []);
});
test("matching either required technology is sufficient and cross-stack posts remain eligible", () => {
  const posts = [post("mixed", ["async", "csharp", "flutter"]), post("runtime", ["threading", "dotnet"])];
  assert.deepEqual(selectPillarPosts(posts, ["async", "threading"], ["csharp", "dotnet"]), posts);
});
test("unscoped pillars retain existing any-topic matching, input order and object identity", () => {
  const posts = [post("second", ["async"]), post("first", ["concurrency"]), post("untagged", undefined)];
  const selected = selectPillarPosts(posts, ["async", "concurrency"]);
  assert.deepEqual(selected, posts.slice(0, 2));
  assert.equal(selected[0], posts[0]);
  assert.equal(posts.length, 3);
});
test("reviewed aliases and tag casing match in both topic and required scope", () => {
  const posts = [post("ef", ["Concurrency", "efcore"])];
  assert.deepEqual(selectPillarPosts(posts, ["CONCURRENCY"], ["ef-core"]), posts);
});
