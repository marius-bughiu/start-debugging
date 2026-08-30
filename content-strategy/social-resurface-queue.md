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

### 2026-08-16 drafted - fix-the-type-or-namespace-name-could-not-be-found-after-project-reference

**Original:** 2026-05-11 - Fix: The type or namespace name 'X' could not be found (after adding a project reference)

**Bluesky:** dotnet clean does not cure this one. It removes outputs and keeps obj/project.assets.json, so the stale reference list survives the reset. dotnet build --no-incremental is what you actually want after editing a csproj mid-build.

**Mastodon:** CS0246 after a project reference is an MSBuild problem wearing a Roslyn error. Three commands tell you which layer is broken. dotnet build -v:n prints the resolved reference list, and if your library is not in it the compiler never saw it. dotnet build -bl writes a binlog, open it and search ResolveAssemblyReferences to see which paths were handed over and which were skipped. dotnet msbuild -t:ResolveReferences runs resolution alone, no compiler noise.

**Notes:** Longest eligible evergreen (2707 words) and joint-top on internal links among the long ones (5 outbound), covering an error that every SDK bump regenerates, so it stays useful indefinitely. GSC candidates had a single Flutter in-app-purchase query with no overlap, so this was picked on depth and link equity. It also moves the run off EF Core, which took two of the last three slots. Fresh angle: the original social copy led with NU1201 and the TargetFramework mismatch, which is fix one and the obvious cause. Both of these skip it. Bluesky takes the dotnet clean trap, since clean keeps the assets file and people assume it is a full reset. Mastodon takes the diagnostic section, reframing the whole error as MSBuild rather than Roslyn and handing over the three commands that prove it.

### 2026-08-23 drafted - record-vs-class-vs-struct-in-csharp-a-decision-matrix

**Original:** 2026-05-20 - record vs class vs struct in C#: a decision matrix

**Bluesky:** customer = customer with { Email = next } emits no UPDATE. The with expression builds a new instance the EF Core change tracker has never seen, and it still holds the old reference. Records make good DTOs and bad tracked entities.

**Mastodon:** Three questions, stop at the first yes. 1. Does the type have identity, or own changing state over time? class. 2. Is it immutable, value-equal, and 16 bytes or less? readonly record struct. 3. Still immutable data with value equality? record. Two traps it does not cover. A record holding a List<int> compares unequal, because value equality falls back to reference equality there. And default(Money) is a valid instance, since a struct is never null.

**Notes:** Highest word count among eligible evergreens (2728 words, 6 internal links) once the 2026-08-16 pick is excluded, and it anchors a five-post C# fundamentals cluster, so the outbound links keep working. Both GSC files (gsc-candidates.json, gsc-rising.json) are empty arrays this week, so there was no traction signal to weigh and depth decided it. It also moves the run off framework-specific errors: the last three slots were Blazor validation, EF Core concurrency, and an MSBuild reference failure. Fresh angle: the original social copy was the three-line summary of the recommendation, default to class, record for value-equal data, readonly record struct for hot loops. Neither of these repeats it. Bluesky takes the EF Core trap where a with expression silently produces no UPDATE, which is the most expensive mistake in the post. Mastodon carries the three-question matrix plus the two gotchas that pick for you, the List<int> equality fallback and default(struct) being a valid value.

### 2026-08-30 drafted - flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026

**Original:** 2026-05-27 - Flutter vs React Native vs .NET MAUI: which should you pick for a new mobile project in 2026?

**Bluesky:** MAUI cold start on Android went from 720 ms on Mono to 480 ms with CoreCLR by default in .NET 11. Most Flutter vs RN vs MAUI comparisons still quote the Mono number. I rebenchmarked all three on a Pixel 8 and an iPhone 15.

**Mastodon:** Three things force the mobile framework decision before preference gets a vote. 1. Your team's incumbent language. TypeScript picks React Native, C# picks MAUI, and only a team with no incumbent stack freely picks Dart. 2. Web on the roadmap, even if not in v1. RN with react-native-web is the only production ready path in 2026, Flutter Web is preview for large apps, and MAUI means writing a second app. 3. Platform features decide the plugin friction.

**Notes:** Longest eligible evergreen at 3020 words and joint-top on internal links with 9 outbound, anchoring the cross-platform mobile comparison cluster, so the link equity keeps working. gsc-rising.json is an empty array again and gsc-candidates.json has no query touching a framework bake-off, the closest being a Flutter background_fetch minSdkVersion cluster that maps elsewhere, so depth and link count decided it. It also breaks a four-pick run of .NET only topics: Blazor validation, EF Core concurrency, an MSBuild reference failure, and the C# type decision matrix. Fresh angle: the obvious copy for this post is the three line recommendation, Flutter for pixel identical UI, RN for TypeScript teams, MAUI for .NET shops, which every comparison post already says. Neither of these repeats it. Bluesky takes the one number that dates a comparison, the MAUI cold start figure that changed when CoreCLR became the default in .NET 11, since most write ups still quote the Mono era 720 ms. Mastodon carries the gotcha section, the three constraints that decide before anyone argues preference, with the web roadmap trap as the expensive one.

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
