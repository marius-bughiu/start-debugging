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

### 2026-08-02 drafted - how-to-share-validation-logic-between-server-and-blazor-webassembly

**Original:** 2026-04-29 - How to share validation logic between server and Blazor WebAssembly

**X:** Blazor WASM validation that passes in dotnet run and does nothing in Release. The trimmer removed the rules it could not prove were used. Mark the shared contracts project IsTrimmable so the warning lands where you can fix it.

**Bluesky:** ValidationProblemDetails comes back keyed by email. FieldIdentifier is case-sensitive and wants Email. That mismatch is why server 400s show up as a generic alert instead of inline under the field. EditContext predates ProblemDetails.

**Mastodon:** The rule you cannot share: username already taken. It needs a database call, so it cannot live in the shared contracts project alongside the DTO. FluentValidation 12 has a clean answer. Put the interface in Contracts with no implementation, take it as a nullable constructor parameter, and wrap the async rules in RuleSet("Server"). The client registers nothing, so the parameter is null and the ruleset is empty. The server opts in with IncludeRuleSets.

**Notes:** Longest eligible evergreen (2489 words, 4 internal links) and the only one that spans two runtimes, so it stays useful to both Blazor and API readers. GSC candidates were three single-impression queries with no overlap, so this was picked on depth again. Fresh angle: the original push led with the Shared-project layout, which is the least surprising part. These three lead with the failure modes instead. X takes the trim gotcha, where Release silently ships validation that does nothing. Bluesky takes the camelCase vs FieldIdentifier mismatch, which is the specific reason inline errors do not render. Mastodon takes the RuleSet("Server") plus nullable-interface trick for rules that can only run server-side.

### 2026-08-09 drafted - fix-second-operation-was-started-on-this-context-instance

**Original:** 2026-05-07 - Fix: A second operation was started on this context instance before a previous operation completed

**X:** Task.WhenAll over two queries on one DbContext is not a perf win you lost to a bug. Even when it works, the connection serialises commands anyway. Awaiting them one after the other costs nothing and the ConcurrencyDetector goes quiet.

**Bluesky:** The subtle one is AddAsync with no await. Someone wrote _ = to silence the compiler warning and silenced the bug report with it. The change tracker is mid-mutation when SaveChangesAsync arrives, and the detector says so.

**Mastodon:** Three fixes, in order. 1. Await sequentially. You almost never need two EF Core queries in flight at once inside one request handler. 2. IDbContextFactory for real concurrency: background services, batch jobs, fan-out. Each gets its own context, connection and change tracker. 3. CreateAsyncScope per iteration when the loop body needs other scoped services too, the right shape for Parallel.ForEachAsync. Never new up a DbContext to dodge the lifetime.

**Notes:** Most internally linked eligible evergreen (10 outbound links to other posts, 1970 words) and a perennial error people hit on every new EF Core version, so it earns the slot on link equity rather than raw length. It also breaks the run of two how-to picks with a fix- post. GSC had one relevant rising query, the reflection-based serialization AOT error, but that maps to a July post that is not yet 90 days old, so depth and link count decided it again. Fresh angle: the original X copy was the textbook summary, two awaits raced one DbContext, use IDbContextFactory. These lead elsewhere. X argues the parallelism was never buying anything, since the connection serialises commands regardless, which reframes fix 1 as the default rather than a compromise. Bluesky takes the missing-await repro where `_ =` silenced the warning and the bug together. Mastodon carries the ranked three fixes with the factory vs CreateAsyncScope distinction, which is the part people get wrong after they stop sharing the context.

### 2026-08-16 drafted - fix-the-type-or-namespace-name-could-not-be-found-after-project-reference

**Original:** 2026-05-11 - Fix: The type or namespace name 'X' could not be found (after adding a project reference)

**X:** CS0246 but Solution Explorer shows the project referenced. Check the ProjectReference metadata. ReferenceOutputAssembly="false" and PrivateAssets="all" both keep the assembly out of the compiler reference list. The IDE still draws it.

**Bluesky:** dotnet clean does not cure this one. It removes outputs and keeps obj/project.assets.json, so the stale reference list survives the reset. dotnet build --no-incremental is what you actually want after editing a csproj mid-build.

**Mastodon:** CS0246 after a project reference is an MSBuild problem wearing a Roslyn error. Three commands tell you which layer is broken. dotnet build -v:n prints the resolved reference list, and if your library is not in it the compiler never saw it. dotnet build -bl writes a binlog, open it and search ResolveAssemblyReferences to see which paths were handed over and which were skipped. dotnet msbuild -t:ResolveReferences runs resolution alone, no compiler noise.

**Notes:** Longest eligible evergreen (2707 words) and joint-top on internal links among the long ones (5 outbound), covering an error that every SDK bump regenerates, so it stays useful indefinitely. GSC candidates had a single Flutter in-app-purchase query with no overlap, so this was picked on depth and link equity. It also moves the run off EF Core, which took two of the last three slots. Fresh angle: the original X copy led with NU1201 and the TargetFramework mismatch, which is fix one and the obvious cause. All three of these skip it. X takes fix five, the ProjectReference metadata that keeps the assembly out of the reference list while Solution Explorer keeps showing the project, which is the slowest cause to spot. Bluesky takes the dotnet clean trap, since clean keeps the assets file and people assume it is a full reset. Mastodon takes the diagnostic section, reframing the whole error as MSBuild rather than Roslyn and handing over the three commands that prove it.

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
