# Evergreen resurface queue

Human-approval queue for re-sharing older evergreen posts to Bluesky and Mastodon. The `start-debugging-evergreen-resurface` scheduled task drafts entries here weekly (Sunday 20:00). You approve, copy to the appropriate channel, and remove from this file.

## Why this exists

Evergreen posts keep earning search impressions for months or years, but the initial social push is one-shot. A selective re-share of high-performing older evergreen posts (90+ days since publish, 90+ days since last resurface) captures continued value without looking spammy.

## Rules

- Never re-share a post less than 90 days old.
- Never re-share the same slug within 90 days of a prior resurface (check Drafts and Approved sections).
- Target: 1 resurface per week, not 3. A quiet cadence builds trust.
- Write FRESH hooks - do not reuse the original social copy. A year later, you have learned something new about the topic, so lead with that angle.
- Bluesky ≤ 260 chars, Mastodon ≤ 460 chars (before URL append). X was dropped on 2026-08-29: the API is too expensive to post to.
- Same style rules as articles: no em dashes, simple quotes.

## Queue entry format

```
### <YYYY-MM-DD drafted> - <slug>

**Original:** <pubDate> - <post title>

**Bluesky:** <hook>
**Mastodon:** <hook>

**Notes:** <why this one, what fresh angle>
```

Move approved entries under `## Approved`, remove after posting.

---

## Drafts

<!-- The scheduled task appends new entries here. Stale drafts (>14 days) are culled on the next run. -->

### 2026-10-25 drafted - how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json

**Original:** 2026-07-27 - How to serialize a polymorphic type hierarchy with JsonDerivedType in System.Text.Json

**Bluesky:** TypedResults.Ok(card) infers Ok<CardPayment>, so System.Text.Json writes no $type discriminator and the client cannot tell which subtype it got. Cast to the base type and $type is back. In .NET the declared type picks the contract, not the runtime type.

**Mastodon:** Polymorphic JSON stored in a PostgreSQL jsonb column comes back with the error 'must specify a type discriminator', even though $type is right there? jsonb does not keep key order (shorter keys sort first), so an Id property lands ahead of $type, and System.Text.Json needs the discriminator first. AllowOutOfOrderMetadataProperties (.NET 9+) fixes the read but buffers the whole object before binding. Fine for small events, not for multi-megabyte documents.

**Notes:** Longest eligible evergreen (2840 words, 11 internal links into the System.Text.Json cluster: custom JsonConverter, JsonException conversion fix, Newtonsoft migration, Native AOT minimal APIs, typed results unions, OpenAPI transformers). pubDate 2026-07-27 is exactly 90 days back, so it just cleared the floor. Runner up how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer (2816 words, 8 links, same pubDate) is the natural next pick; how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11 was skipped again to avoid two minimal API picks in three weeks. Serialization has not been resurfaced in the past 90 days, and it rotates off last week's Flutter pick. gsc-candidates.json holds only site: queries, so no traction signal; depth and link count decided. Fresh angle: the obvious copy is the post's five step recipe and the exceptions table. Neither hook repeats it. Bluesky takes the TypedResults.Ok inference trap that drops the discriminator in minimal APIs. Mastodon takes the jsonb key reordering cause of the misleading 'must specify a type discriminator' error, plus the buffering cost of the .NET 9 opt-in. The Mastodon detail that jsonb sorts shorter keys first goes slightly beyond the post (which only says jsonb normalizes key order); it matches PostgreSQL's documented storage behavior, but worth a glance before posting.

### 2026-11-01 drafted - how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer

**Original:** 2026-07-27 - How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer

**Bluesky:** dotnet publish /t:PublishContainer can push a real multi-arch image with no Buildx or QEMU. The catch: list RuntimeIdentifiers in the csproj and drop --arch and -r from the command. Pass either one and you silently get a single-architecture image.

**Mastodon:** .NET 11 ships this month, and one SDK change can break a container registry that used to work with dotnet publish /t:PublishContainer. The SDK now validates the bearer-token realm in the registry's auth challenge: it must be an absolute HTTPS URI (unless the registry is in DOTNET_CONTAINER_INSECURE_REGISTRIES) and cannot be a loopback or private IP literal. If an internal registry starts failing the publish after the upgrade, check that challenge first.

**Notes:** Longest eligible evergreen (2816 words, 8 internal links into the build/publish, Native AOT, trimming and Aspire cluster), pubDate 2026-07-27 is 97 days back, and last week's notes flagged it as the natural next pick. Runners up: migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11 (2779 words, 5 links) and how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle (2768 words, 12 links), the latter a strong next pick. No container/DevOps post has been resurfaced in the past 90 days. gsc-candidates.json is an empty array, so no traction signal; depth and timing decided. Fresh angle: .NET 11 GA lands this month, so the timing is the hook. The obvious copy is the post's no-Dockerfile pitch and naming/tag properties; neither hook repeats it. Bluesky takes the multi-arch trap where --arch or -r silently collapses the OCI image index to one architecture. Mastodon takes the .NET 11 bearer-token realm validation (dotnet/sdk#54225) as an upgrade-time breaking change for internal registries. Post refresh idea: the intro still says 'preview 6 at the time of writing, GA in November 2026'; once GA ships, update that line and re-check whether the realm validation and Podman multi-arch changes shipped as described.

### 2026-11-08 drafted - how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11

**Original:** 2026-08-10 - How to call a stored procedure and map its results in EF Core 11

**Bluesky:** EF Core stored procedure with an OUTPUT parameter? Its Value is null until the reader is disposed. Read it after ToListAsync, never mid-loop. And an enumerator you never dispose also breaks every later query on that DbContext with 'already an open DataReader'.

**Mastodon:** Your stored procedure returns two result sets, and EF Core's FromSql hands back the first one and silently drops the second. No exception, no warning. The issue asking for multiple result sets has been open since 2017 and is still in the backlog, so EF Core 11 does not fix it. Drop to a DbCommand and NextResultAsync. Same escape hatch for a T-SQL RETURN value: ReturnValue needs CommandType.StoredProcedure, and EF always sends Text.

**Notes:** Longest eligible evergreen (3142 words, 8 internal links into the EF Core cluster: FromSql missing-column fix, compiled queries vs Dapper, LINQ translation fix, SQL logging, ExecuteUpdate/ExecuteDelete). pubDate 2026-08-10 is exactly 90 days back, so it just cleared the floor. No EF Core post has been resurfaced in the past 90 days, and it rotates off two serialization/container picks. Runners up: fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis (2973 words, 10 links) and how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle (2768 words, 12 links); the IIS one is the natural next pick to avoid back-to-back EF Core. gsc-candidates.json is an empty array, so no traction signal; depth decided. Fresh angle: the obvious copy is the post's three-API decision (FromSql vs SqlQuery<T> vs ExecuteSql) and the non-composable EXEC exception. Neither hook repeats it. Bluesky takes the output parameter timing trap plus the undisposed-enumerator 'open DataReader' failure. Mastodon takes the silent drop of extra result sets (dotnet/efcore#8127, still Backlog) and the RETURN value needing CommandType.StoredProcedure. Post refresh idea: the post was measured on EF Core 10 because .NET 11 was not installed; with .NET 11 GA this month, re-run the samples on EF Core 11 and drop the caveat paragraph. Cull: removed the 2026-10-18 Flutter network errors draft (21 days old).

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
