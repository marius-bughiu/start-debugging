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

### 2026-11-08 drafted - how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11

**Original:** 2026-08-10 - How to call a stored procedure and map its results in EF Core 11

**Bluesky:** EF Core stored procedure with an OUTPUT parameter? Its Value is null until the reader is disposed. Read it after ToListAsync, never mid-loop. And an enumerator you never dispose also breaks every later query on that DbContext with 'already an open DataReader'.

**Mastodon:** Your stored procedure returns two result sets, and EF Core's FromSql hands back the first one and silently drops the second. No exception, no warning. The issue asking for multiple result sets has been open since 2017 and is still in the backlog, so EF Core 11 does not fix it. Drop to a DbCommand and NextResultAsync. Same escape hatch for a T-SQL RETURN value: ReturnValue needs CommandType.StoredProcedure, and EF always sends Text.

**Notes:** Longest eligible evergreen (3142 words, 8 internal links into the EF Core cluster: FromSql missing-column fix, compiled queries vs Dapper, LINQ translation fix, SQL logging, ExecuteUpdate/ExecuteDelete). pubDate 2026-08-10 is exactly 90 days back, so it just cleared the floor. No EF Core post has been resurfaced in the past 90 days, and it rotates off two serialization/container picks. Runners up: fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis (2973 words, 10 links) and how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle (2768 words, 12 links); the IIS one is the natural next pick to avoid back-to-back EF Core. gsc-candidates.json is an empty array, so no traction signal; depth decided. Fresh angle: the obvious copy is the post's three-API decision (FromSql vs SqlQuery<T> vs ExecuteSql) and the non-composable EXEC exception. Neither hook repeats it. Bluesky takes the output parameter timing trap plus the undisposed-enumerator 'open DataReader' failure. Mastodon takes the silent drop of extra result sets (dotnet/efcore#8127, still Backlog) and the RETURN value needing CommandType.StoredProcedure. Post refresh idea: the post was measured on EF Core 10 because .NET 11 was not installed; with .NET 11 GA this month, re-run the samples on EF Core 11 and drop the caveat paragraph. Cull: removed the 2026-10-18 Flutter network errors draft (21 days old).

### 2026-11-15 drafted - fix-http-error-500-30-aspnet-core-app-failed-to-start-on-iis

**Original:** 2026-08-05 - Fix: HTTP Error 500.30 - ASP.NET Core app failed to start after deploying to IIS

**Bluesky:** Retargeted to net11.0 after the GA and IIS now says HTTP 500.30? ASP.NET Core does not roll forward across major versions. Install the .NET 11 Hosting Bundle on each server, then net stop was /y and net start w3svc. Skip the restart and it still fails.

**Mastodon:** Chasing an ASP.NET Core 500.30 on IIS? Before touching web.config, check the Application event log: the 'IIS AspNetCore Module V2' entry often already holds the full startup stack trace. Only 0xe0434352? Turn on stdout logging. An empty stdout file means the process died before managed code, so check app pool bitness. And if you add the ANCM debugFile, create the logs folder first: unlike stdoutLogFile, the module will not, and you get silence.

**Notes:** Flagged as the natural next pick last week (2973 words, 10 internal links into the DI errors, options validation, connection string and migration cluster). pubDate 2026-08-05 is 102 days back. No IIS/deployment-error post has been resurfaced in the past 90 days, and it rotates off back-to-back EF Core. Longer eligible runners up were already resurfaced (stored procedure, Flutter vs RN vs MAUI) or are too close in topic; next picks: zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11 (2961 words, pubDate 2026-08-15, eligible from today) and how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11 (2778 words, 9 links). gsc-candidates.json has one hit (defaultjsontypeinforesolver), unrelated, so depth and timing decided. Fresh angle: .NET 11 GA this month means teams retargeting to net11.0 hit 500.30 on IIS servers that still only have the 10.0 Hosting Bundle, so Bluesky leads with that upgrade trap. Mastodon skips the post's four-fix ranking and the 500.3x table and takes the diagnostic order: event log first, empty stdout file means bitness, and the debugFile folder gotcha. Post refresh idea: the post says verified on .NET 11 Preview 6; with GA out, re-check and drop the preview SDK string.

### 2026-11-22 drafted - fix-msbuild-msb3027-could-not-copy-exceeded-retry-count

**Original:** 2026-05-11 - Fix: MSB3027 Could not copy X to Y. Exceeded retry count of 10. Failed

**Bluesky:** MSB3027 says the file is locked by 'System (4)'? taskkill can't help: that's a kernel-mode antivirus driver scanning the DLL you just built. Exclude bin/, obj/ and the NuGet cache. And treat repeated MSB3026 warnings as next week's MSB3027.

**Mastodon:** MSB3027 'Exceeded retry count of 10' is a ten-second budget: CopyRetryCount 10 times CopyRetryDelayMilliseconds 1000. Before raising it in Directory.Build.props, name the holder: handle64.exe on the destination DLL usually points at your own previous run, an IIS Express worker or dotnet watch. And if two projects copy the same shared DLL under /m, the cleaner fix is BuildInParallel=false or a PackageReference, not a bigger retry count.

**Notes:** Picked on search traction rather than depth: it is the only eligible evergreen matching gsc-candidates.json (queries 'error msb3027' and 'msb3027 could not copy', positions 19-19.5, so a nudge off page 2 is worth more than another deep-dive share). 2252 words, 5 internal links, pubDate 2026-05-11 is 195 days back, never resurfaced, and it rotates off back-to-back ASP.NET/EF Core picks. Last week's flagged runners up stay queued for later weeks: zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11 (2961 words, 7 links) and how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11. Fresh angle: the post leads with 'kill the locking process'; the hooks skip that and take the less obvious material. Bluesky: the 'System (4)' holder means a kernel-mode AV driver, plus MSB3026 as an early warning. Mastodon: the retry budget math and why the /m shared-DLL race wants BuildInParallel=false or a PackageReference instead of a bigger CopyRetryCount. Post refresh idea: it was written against SDK 11.0.100-preview.4; with .NET 11 GA out, re-run the repro on 11.0.100 and update the version line. Cull: removed the 2026-11-01 PublishContainer draft (21 days old).

---

## Approved

<!-- Move drafts here after you review. Remove entries after posting. -->
