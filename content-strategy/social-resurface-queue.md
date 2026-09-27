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

### 2026-09-13 drafted - dart-records-vs-freezed-classes

**Original:** 2026-05-27 - Dart records vs Freezed classes: which should you pick in 2026?

**Bluesky:** typedef User = ({int id, String email}); does not create a type in Dart. It aliases a shape, so a Customer typedef with the same fields is the same type and the compiler lets you pass one for the other. That is where a record should become a Freezed class.

**Mastodon:** Dart records vs Freezed is not a performance call. On a Pixel 8 with Dart 3.12 AOT, a five field record allocates in 18 ns and a Freezed 3.x class in 24 ns, with == at 11 vs 14 ns. The number you feel is build_runner: 4.1 s cold for 50 Freezed classes, 15 to 25 s at 200. So decide on shape. If the field names belong in your crash logs, or the type needs copyWith, JSON, or a sealed union, write a Freezed class. Otherwise, a record.

**Notes:** Second longest eligible evergreen at 2619 words with 6 internal links, into the Flutter state management cluster (GetX to Riverpod, isolates, DevTools jank). The longest, maui-vs-avalonia-vs-uno-in-2026 (2637 words), was passed over because it is a second cross platform framework bake-off two weeks after the Flutter vs RN vs MAUI pick. This one also breaks the .NET run left by the 09-06 migration pick. gsc-rising.json is empty and gsc-candidates.json has only single impression queries, none on Dart, so depth decided it. Fresh angle: the obvious copy is the post's own summary, record for local shapes and Freezed for domain models. Neither hook repeats it. Bluesky takes the structural typing trap, where a typedef looks like a named type but gives no nominal safety. Mastodon uses the benchmark table to take performance off the table and names build_runner time as the real cost, then gives the crash log heuristic as the deciding test.

### 2026-09-20 drafted - list-vs-span-vs-readonlyspan-in-csharp

**Original:** 2026-05-25 - List<T> vs Span<T> vs ReadOnlySpan<T> in C#: when to reach for which

**Bluesky:** CollectionsMarshal.AsSpan(list) hands you a Span over the list's own backing array, no copy. Add one element past capacity and the list swaps in a new array, so your span now views the orphaned old one. Take the view, use it, drop it before any mutation.

**Mastodon:** List vs Span is not settled by the benchmark. Summing 10,000 ints on .NET 11: List foreach 6.1 us, span foreach 2.4 us, zero allocation either way. Outside a hot loop that is 4 microseconds. Lifetime decides instead. A ref struct cannot be a field, cannot be captured in a lambda, and cannot survive an await. If the buffer outlives the stack frame you are on List or Memory, whatever the numbers say.

**Notes:** Second longest eligible evergreen at 2686 words with 7 internal links, anchoring the span and memory cluster (implicit Span conversions in C# 14, ReadOnlyMemory conversion, SearchValues, large CSV parsing, params ReadOnlySpan), so the outbound links keep working. The longest, maui-vs-avalonia-vs-uno-in-2026 at 2717 words, was passed over for the second week running: it is still a cross platform UI bake-off three weeks after the Flutter vs RN vs MAUI pick, and the overlap reads as repetition to the same followers. Both GSC files carry only site: queries again this week (gsc-candidates.json is eight site: rows, gsc-rising.json the same set), so there was no topical traction signal and depth plus link count decided. It also moves the run off the last three picks, a mobile framework bake-off, a .NET Framework migration, and Dart records vs Freezed, and the last C# language pick was record-vs-class-vs-struct four weeks ago. Fresh angle: the obvious copy is the post's own three line summary, own and grow means List, view and mutate means Span, view and read means ReadOnlySpan, which every span explainer already says. Neither hook repeats it. Bluesky takes the one lifetime trap that survives review, a CollectionsMarshal.AsSpan view left pointing at the array a resize orphaned. Mastodon uses the benchmark to take performance off the table, 6.1 us vs 2.4 us on 10,000 ints, then names the ref struct constraints that decide regardless of speed.

### 2026-09-27 drafted - maui-vs-avalonia-vs-uno-in-2026

**Original:** 2026-05-27 - MAUI vs Avalonia vs Uno Platform: which should you pick in 2026?

**Bluesky:** Porting a desktop app to .NET cross platform? The XAML dialect you already own decides more than the renderer. WPF XAML is closest to Avalonia, WinUI 3 XAML pastes into Uno nearly untouched, and MAUI XAML pastes nowhere. That choice compounds for years.

**Mastodon:** MAUI vs Avalonia vs Uno in 2026 is mostly settled by two targets you may not ship yet. Linux in the matrix? MAUI is out, and Microsoft has no roadmap for it. Browser in production today? Avalonia's WebAssembly target is still preview, which leaves Uno. Only once both are off the table does native controls vs Skia matter. Cold start on a Pixel 8 hello world: Avalonia 410 ms, MAUI 11 480 ms on CoreCLR, Uno 520 ms.

**Notes:** Longest remaining eligible evergreen at 2717 words with 9 internal links into the MAUI cluster (CoreCLR default, Xamarin.Forms migration, Store packaging, desktop-only MAUI). Passed over the last two weeks for overlap with the 08-30 Flutter vs RN vs MAUI pick, but that gap is now four weeks, and the last three picks (.NET Framework migration, Dart records vs Freezed, List vs Span) left the UI framework space alone. gsc-candidates.json holds only site: queries again, so no traction signal; depth and link count decided. Fresh angle: the obvious copy is the post's three-way summary (Avalonia for desktop, Uno for browser, MAUI for mobile). Neither hook repeats it. Bluesky leads with the XAML dialect lock-in, the decision people underweight when porting. Mastodon frames the pick as elimination by Linux and browser targets, then uses the cold start numbers to show performance is not the tiebreaker it looks like.

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
