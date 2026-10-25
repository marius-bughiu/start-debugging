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

### 2026-10-11 drafted - migrate-a-minimal-api-from-manual-validation-to-built-in-validation-in-aspnetcore-11

**Original:** 2026-07-09 - Migrate a minimal API from manual validation checks to built-in validation in ASP.NET Core 11

**Bluesky:** Moving minimal API if-checks to AddValidation() in ASP.NET Core 11? The rule that hits the database cannot become an attribute, and IValidatableObject cannot await. Keep that one in the handler, after the generator has guaranteed the shape. Delete the rest.

**Mastodon:** Swapping hand-rolled if-checks for built-in minimal API validation in ASP.NET Core 11 changes more than the code. Nested records now validate recursively, so you can get 400s on Billing.PostalCode that your old checks never looked at. Query and route params get validated too. And every 400 becomes an RFC 9457 ProblemDetails body. Snapshot your current 400s first, migrate one endpoint at a time, and keep DisableValidation() as the per-route escape hatch.

**Notes:** Longest remaining eligible evergreen (2655 words, 9 internal links into the minimal API validation cluster: request body validation, validation vs FluentValidation, IProblemDetailsService error shaping, MapGroup, Native AOT). pubDate 2026-07-09 is 94 days back, so it just cleared the 90 day floor. Every longer evergreen was resurfaced within the past 90 days per queue history. stringbuilder-vs-string-interpolation and task-run-vs-task-factory-startnew were the runners up but shorter with fewer links. It also moves off three straight C#/data/UI picks into ASP.NET Core. gsc-candidates.json is still mostly site: queries plus a couple of off-topic rows (regex balancing groups, number names), so no traction signal; depth and link count decided. Fresh angle: the obvious copy is the post's own mechanical recipe (attributes, IValidatableObject, custom ValidationAttribute). Bluesky leads with the async rule that does not port, the step most migrations get wrong. Mastodon frames the migration as a behavior change (recursive nested validation, query/route params, ProblemDetails contract) with the snapshot-first and DisableValidation() rollback advice. Hooks avoid the post's headline gotcha that a non-public request record makes the generator silently skip validation, and its claim that the default is 'file-internal' accessibility (a top-level record defaults to internal, not file); worth verifying against the .NET 11 generator before any post refresh.

### 2026-10-18 drafted - how-to-handle-network-errors-gracefully-in-a-flutter-app

**Original:** 2026-06-01 - How to Handle Network Errors Gracefully in a Flutter App

**Bluesky:** Flutter's http package never times out on its own and never throws on a 500. So a stalled request spins forever, and an error payload gets parsed as data. Add .timeout(), check statusCode, then map each failure to a state the user can act on.

**Mastodon:** connectivity_plus reporting wifi does not mean your Flutter app is online. Behind a captive portal that has not been accepted yet, the request still fails with a SocketException or a timeout, and if the portal answers with a 200 HTML page, jsonDecode throws a FormatException instead. Use the connectivity stream for an offline banner, treat the exception handler as the source of truth, and only show Retry where retrying can actually succeed.

**Notes:** 2552 words with 10 internal links into the Flutter cluster (dispose controllers, FormatException JSON, Dart isolates, GetX to Riverpod, RenderFlex overflow). The only longer eligible evergreen, how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11 (2658 words, 10 links), was passed over because last week's pick was also a minimal API post; it is the natural next pick. Flutter was last resurfaced on 09-13 (Dart records vs Freezed), so this rotates back to mobile after four .NET picks. gsc-candidates.json is an empty array, so no traction signal; depth and link count decided. Fresh angle: the obvious copy is the post's sealed NetworkResult plus exhaustive switch pattern. Neither hook repeats it. Bluesky leads with the two silent defaults of the http package (no timeout, no throw on non-2xx). Mastodon takes the captive portal trap, where connectivity_plus says online and the failure shows up as a socket error or a FormatException. Post refresh idea: since http 1.x, IOClient surfaces socket failures as ClientException (an internal subtype that also implements SocketException), so the on-clause ordering paragraph is worth re-checking against the current package.

### 2026-10-25 drafted - how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json

**Original:** 2026-07-27 - How to serialize a polymorphic type hierarchy with JsonDerivedType in System.Text.Json

**Bluesky:** TypedResults.Ok(card) infers Ok<CardPayment>, so System.Text.Json writes no $type discriminator and the client cannot tell which subtype it got. Cast to the base type and $type is back. In .NET the declared type picks the contract, not the runtime type.

**Mastodon:** Polymorphic JSON stored in a PostgreSQL jsonb column comes back with the error 'must specify a type discriminator', even though $type is right there? jsonb does not keep key order (shorter keys sort first), so an Id property lands ahead of $type, and System.Text.Json needs the discriminator first. AllowOutOfOrderMetadataProperties (.NET 9+) fixes the read but buffers the whole object before binding. Fine for small events, not for multi-megabyte documents.

**Notes:** Longest eligible evergreen (2840 words, 11 internal links into the System.Text.Json cluster: custom JsonConverter, JsonException conversion fix, Newtonsoft migration, Native AOT minimal APIs, typed results unions, OpenAPI transformers). pubDate 2026-07-27 is exactly 90 days back, so it just cleared the floor. Runner up how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer (2816 words, 8 links, same pubDate) is the natural next pick; how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11 was skipped again to avoid two minimal API picks in three weeks. Serialization has not been resurfaced in the past 90 days, and it rotates off last week's Flutter pick. gsc-candidates.json holds only site: queries, so no traction signal; depth and link count decided. Fresh angle: the obvious copy is the post's five step recipe and the exceptions table. Neither hook repeats it. Bluesky takes the TypedResults.Ok inference trap that drops the discriminator in minimal APIs. Mastodon takes the jsonb key reordering cause of the misleading 'must specify a type discriminator' error, plus the buffering cost of the .NET 9 opt-in. The Mastodon detail that jsonb sorts shorter keys first goes slightly beyond the post (which only says jsonb normalizes key order); it matches PostgreSQL's documented storage behavior, but worth a glance before posting.

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
