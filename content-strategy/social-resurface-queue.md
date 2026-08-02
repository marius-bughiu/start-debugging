# Evergreen resurface queue

Human-approval queue for re-sharing older evergreen posts to X, Bluesky, and Mastodon. The `start-debugging-evergreen-resurface` scheduled task drafts entries here weekly (Sunday 20:00). You approve, copy to the appropriate channel, and remove from this file.

## Why this exists

Evergreen posts keep earning search impressions for months or years, but the initial social push is one-shot. A selective re-share of high-performing older evergreen posts (90+ days since publish, 90+ days since last resurface) captures continued value without looking spammy.

## Rules

- Never re-share a post less than 90 days old.
- Never re-share the same slug within 90 days of a prior resurface (check Drafts and Approved sections).
- Target: 1 resurface per week, not 3. A quiet cadence builds trust.
- Write FRESH hooks - do not reuse the original social copy. A year later, you have learned something new about the topic, so lead with that angle.
- X ≤ 240 chars, Bluesky ≤ 260 chars, Mastodon ≤ 460 chars (before URL append).
- Same style rules as articles: no em dashes, simple quotes.

## Queue entry format

```
### <YYYY-MM-DD drafted> - <slug>

**Original:** <pubDate> - <post title>

**X:** <hook>
**Bluesky:** <hook>
**Mastodon:** <hook>

**Notes:** <why this one, what fresh angle>
```

Move approved entries under `## Approved`, remove after posting.

---

## Drafts

<!-- The scheduled task appends new entries here. Stale drafts (>14 days) are culled on the next run. -->

### 2026-07-26 drafted - how-to-use-records-with-ef-core-11-correctly

**Original:** 2026-04-21 - How to use records with EF Core 11 correctly

**X:** The C# docs say records are not appropriate as EF Core entity types. That is a blunt summary, not a ban. The rule that holds on EF Core 11: class with init setters for anything with identity, record for anything defined by its data.

**Bluesky:** post with { Title = "New" } then Update() throws: another instance with the same key value is already being tracked. Identity resolution is doing its job. You handed it two CLR references to one row. Keep records out of the tracked-entity seat.

**Mastodon:** Records and EF Core 11 fight for one reason: records are value-equal, the change tracker is reference-identity. Three seats, three answers. Complex types: positional record, ideal fit. Projections and DTOs: positional record, always safe. Tracked entities: skip positional, use a record class or plain class with init-only props and a binding ctor. The with expression on a tracked entity clones the primary key and blows up on SaveChanges.

**Notes:** Longest eligible evergreen (2701 words, 6 internal links) and the only one covering a decision people re-litigate on every new EF Core release. GSC data had nothing relevant, so this was picked on depth. Fresh angle: the original push led with the how-to framing, so these lead with the conflict instead. X reframes the "records aren't appropriate for entities" doc warning as a seat-assignment rule rather than a prohibition. Bluesky opens on the concrete InvalidOperationException from a `with` expression, which is the error people actually search for. Mastodon uses the three-seats structure as the payoff.

### 2026-08-02 drafted - how-to-share-validation-logic-between-server-and-blazor-webassembly

**Original:** 2026-04-29 - How to share validation logic between server and Blazor WebAssembly

**X:** Blazor WASM validation that passes in dotnet run and does nothing in Release. The trimmer removed the rules it could not prove were used. Mark the shared contracts project IsTrimmable so the warning lands where you can fix it.

**Bluesky:** ValidationProblemDetails comes back keyed by email. FieldIdentifier is case-sensitive and wants Email. That mismatch is why server 400s show up as a generic alert instead of inline under the field. EditContext predates ProblemDetails.

**Mastodon:** The rule you cannot share: username already taken. It needs a database call, so it cannot live in the shared contracts project alongside the DTO. FluentValidation 12 has a clean answer. Put the interface in Contracts with no implementation, take it as a nullable constructor parameter, and wrap the async rules in RuleSet("Server"). The client registers nothing, so the parameter is null and the ruleset is empty. The server opts in with IncludeRuleSets.

**Notes:** Longest eligible evergreen (2489 words, 4 internal links) and the only one that spans two runtimes, so it stays useful to both Blazor and API readers. GSC candidates were three single-impression queries with no overlap, so this was picked on depth again. Fresh angle: the original push led with the Shared-project layout, which is the least surprising part. These three lead with the failure modes instead. X takes the trim gotcha, where Release silently ships validation that does nothing. Bluesky takes the camelCase vs FieldIdentifier mismatch, which is the specific reason inline errors do not render. Mastodon takes the RuleSet("Server") plus nullable-interface trick for rules that can only run server-side.

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
