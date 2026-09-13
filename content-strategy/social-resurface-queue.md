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

### 2026-08-30 drafted - flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026

**Original:** 2026-05-27 - Flutter vs React Native vs .NET MAUI: which should you pick for a new mobile project in 2026?

**Bluesky:** MAUI cold start on Android went from 720 ms on Mono to 480 ms with CoreCLR by default in .NET 11. Most Flutter vs RN vs MAUI comparisons still quote the Mono number. I rebenchmarked all three on a Pixel 8 and an iPhone 15.

**Mastodon:** Three things force the mobile framework decision before preference gets a vote. 1. Your team's incumbent language. TypeScript picks React Native, C# picks MAUI, and only a team with no incumbent stack freely picks Dart. 2. Web on the roadmap, even if not in v1. RN with react-native-web is the only production ready path in 2026, Flutter Web is preview for large apps, and MAUI means writing a second app. 3. Platform features decide the plugin friction.

**Notes:** Longest eligible evergreen at 3020 words and joint-top on internal links with 9 outbound, anchoring the cross-platform mobile comparison cluster, so the link equity keeps working. gsc-rising.json is an empty array again and gsc-candidates.json has no query touching a framework bake-off, the closest being a Flutter background_fetch minSdkVersion cluster that maps elsewhere, so depth and link count decided it. It also breaks a four-pick run of .NET only topics: Blazor validation, EF Core concurrency, an MSBuild reference failure, and the C# type decision matrix. Fresh angle: the obvious copy for this post is the three line recommendation, Flutter for pixel identical UI, RN for TypeScript teams, MAUI for .NET shops, which every comparison post already says. Neither of these repeats it. Bluesky takes the one number that dates a comparison, the MAUI cold start figure that changed when CoreCLR became the default in .NET 11, since most write ups still quote the Mono era 720 ms. Mastodon carries the gotcha section, the three constraints that decide before anyone argues preference, with the web roadmap trap as the expensive one.

### 2026-09-06 drafted - migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026

**Original:** 2026-05-28 - Migrate from .NET Framework 4.8 to .NET 11 in 2026

**Bluesky:** Order matters on the BinaryFormatter step. Blobs serialised with it can only be read on the old runtime, so the conversion tool has to run on .NET Framework 4.8 before you decommission it. Migrate first and those payloads are stranded.

**Mastodon:** Four .NET 11 behaviour changes that compile fine and fail in production. 1. HttpClient enforces SNI strictly, so an internal cert with no matching SAN throws AuthenticationException. 2. DateTime.Parse rejects ambiguous input that 4.8 accepted, so pass InvariantCulture and an explicit format. 3. appsettings.json binding is case sensitive, maxretries does not bind to MaxRetries. 4. A transitive System.Data.SqlClient pin builds, then fails on TLS 1.3.

**Notes:** Longest eligible evergreen at 3019 words and joint-top on internal links with 9 outbound, anchoring the .NET migration cluster, so the link equity keeps working. Both GSC files hold only site: queries this week (gsc-candidates.json is two tag-listing rows, gsc-rising.json is five site: rows), so there was no topical traction signal and depth plus link count decided it. It also moves the run off the last three picks, an MSBuild reference failure, the C# type decision matrix, and the mobile framework bake-off. Fresh angle: the obvious copy for a migration playbook is the breakage table, System.Web is gone and WebForms has no path, which every porting post already says. Neither of these repeats it. Bluesky takes the one step whose ordering is a one way door, since BinaryFormatter blobs are only readable on the runtime you are about to delete and nobody sequences that until it is too late. Mastodon carries the post-cutover gotchas, the four behaviour differences that build clean and surface in production.

### 2026-09-13 drafted - dart-records-vs-freezed-classes

**Original:** 2026-05-27 - Dart records vs Freezed classes: which should you pick in 2026?

**Bluesky:** typedef User = ({int id, String email}); does not create a type in Dart. It aliases a shape, so a Customer typedef with the same fields is the same type and the compiler lets you pass one for the other. That is where a record should become a Freezed class.

**Mastodon:** Dart records vs Freezed is not a performance call. On a Pixel 8 with Dart 3.12 AOT, a five field record allocates in 18 ns and a Freezed 3.x class in 24 ns, with == at 11 vs 14 ns. The number you feel is build_runner: 4.1 s cold for 50 Freezed classes, 15 to 25 s at 200. So decide on shape. If the field names belong in your crash logs, or the type needs copyWith, JSON, or a sealed union, write a Freezed class. Otherwise, a record.

**Notes:** Second longest eligible evergreen at 2619 words with 6 internal links, into the Flutter state management cluster (GetX to Riverpod, isolates, DevTools jank). The longest, maui-vs-avalonia-vs-uno-in-2026 (2637 words), was passed over because it is a second cross platform framework bake-off two weeks after the Flutter vs RN vs MAUI pick. This one also breaks the .NET run left by the 09-06 migration pick. gsc-rising.json is empty and gsc-candidates.json has only single impression queries, none on Dart, so depth decided it. Fresh angle: the obvious copy is the post's own summary, record for local shapes and Freezed for domain models. Neither hook repeats it. Bluesky takes the structural typing trap, where a typedef looks like a named type but gives no nominal safety. Mastodon uses the benchmark table to take performance off the table and names build_runner time as the real cost, then gives the crash log heuristic as the deciding test.

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
