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

### 2026-10-04 drafted - ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp

**Original:** 2026-05-21 - IEnumerable vs IAsyncEnumerable vs IQueryable in C#: which one should the method return?

**Bluesky:** Counting 1M rows in .NET 11 with EF Core 11: ToList then loop 1,380 ms, AsAsyncEnumerable 1,210 ms, CountAsync plus SumAsync 38 ms. Streaming beats buffering by about 12 percent. Letting SQL Server do the math beats both by 30x.

**Mastodon:** Returning IQueryable<T> from a service looks flexible. It means every caller now writes your SQL. A .Where with a local C# method throws at materialization in EF Core 11, a renamed column becomes a codebase-wide search, and if the DbContext was disposed when the method returned, the caller's ToList throws ObjectDisposedException. Keep IQueryable in the repository, return IReadOnlyList<T> or IAsyncEnumerable<T>, and make materialization the boundary.

**Notes:** Longest remaining eligible evergreen with 7 internal links (2513 words) into the EF Core cluster (IAsyncEnumerable with EF Core 11, N+1 detection, compiled queries, bulk insert benchmark, file streaming). stringbuilder-vs-string-interpolation-in-dotnet-11 is 10 words longer but has fewer links, and another allocation benchmark two weeks after List vs Span would read as repetition. This one also moves off last week's UI framework pick into data access. gsc-candidates.json and gsc-rising.json carry only site: queries plus one single impression row (c# using declaration), so no traction signal; depth and link count decided. Fresh angle: the obvious copy is the post's summary rule (IQueryable when the provider translates, IAsyncEnumerable when the producer awaits, IEnumerable otherwise). Neither hook repeats it. Bluesky leads with the million row benchmark to show that streaming vs buffering is the small win and pushing the aggregate to SQL is the big one. Mastodon takes the leaked IQueryable repository trap, including the disposed DbContext failure at the caller. Hooks avoid the post's claims that the compiler stays silent on a missing [EnumeratorCancellation] (CS8425 warns) and that IAsyncEnumerable LINQ needs System.Linq.Async (built into the BCL since .NET 10); worth a post refresh.

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

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
