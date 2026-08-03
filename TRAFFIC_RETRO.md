# Traffic retro

Monthly summaries appended by `start-debugging-monthly-retro` on the 1st Monday of each month. See `content-strategy/monthly-retro-prompt.md` for the generation contract.

## 2026-04

**Shipped:**
- 81 posts published (files added under `site/src/content/blog/2026/04/`). Commit-prefix split for the same window: 29 `post:` (news), 25 `evergreen:`, 7 `agents:` — the remaining ~20 shipped via multi-slug "post: A, B" or phase/refactor commits without a single-post prefix.
- Maintenance runs: pillar x 1 (2026-04-26), freshness x 0, link-pass x 0, topic-refill x 0 — only the pillar pass actually fired this month; weekly freshness, internal-linking and topic-queue routines did not record any commits.
- Roadmap items checked off: cannot diff start-vs-end-of-month — `TRAFFIC_ROADMAP.md` is gitignored (.gitignore:27) so the file has no git history. Current state: 33 of 38 `### [x]` items checked across all phases. Roadmap diffing needs the file untracked → tracked, or a separate snapshot mechanism, before next retro.
- Top topic clusters (tags aggregated across the 81 new posts): `dotnet-11` (53), `dotnet` (39), `csharp` (35). Next tier: `performance` (17), `ai-agents` (13), `claude-code` (10) — confirms the .NET 11 preview window plus the Claude/MCP track are both live.

**Search signal:** (from GSC, `content-strategy/gsc-candidates.json` + `gsc-rising.json`, both refreshed 2026-05-02)
- Ranking wins (position < 10 AND impressions > 100): **none meet threshold** — top movers in the rising file are still very low volume. Best position-<10 entries: `aspire 13.2.4` (pos 5.11, imp 9), `.net 8 jsonnamingpolicy snakecaselower` (pos 8.29, imp 21), `cve-2026-40894` (pos 8.24, imp 29).
- Page-2 conversion targets (position 11-20 AND impressions > 50): **none meet threshold**. Top page-2 candidates by impressions only: `what comes after decillion` (pos 15.5, imp 24), `could not execute because the specified command or file was not found … dotnet-ef does not exist …` (pos 11.6, imp 5), `droidcam streamlabs` (pos 13, imp 5), `"flutter_build_type=debug" flutter ios` (pos 11.25, imp 4), `jsonnamingpolicy snakecaselower` (pos 11.25, imp 4). Site-wide impressions are still too low for the prompt's thresholds to bite — treat the threshold as informational this month.

**Manual fill (user):**
- Sessions / users:
- Top 10 landing pages:
- Newsletter subscriber count:
- Social referrals by source:
- Next month's 3 priorities:

## 2026-06

**Shipped:**
- 110 posts published (files added under `site/src/content/blog/2026/06/`). Commit-prefix split for the same window: 25 `post:` (news), 64 `evergreen:`, 23 `agents:` (= 112); the small overshoot vs. the 110 file count comes from multi-slug and re-slug commits. Volume settled down from May's 138 but stayed evergreen-heavy: EF Core 11 (seeding, JSON columns, keyset pagination, interceptors), ASP.NET Core 11 JWT/auth, .NET 11 preview-5 news, and a large Flutter/Riverpod migration + troubleshooting run.
- Maintenance runs: pillar x3 (2026-06-14, -21, -30), freshness x0, link-pass x4 (internal-linking 2026-06-07, -14, -21, -30 — fired every week), topic-refill x3 (2026-06-06, -20, -30). Also fired: agents-queue refill (06-13) and weekly link-rot reports (06-07: 80 broken, 06-14: 83, 06-21: 84, 06-30: 86). Internal-linking is now the most reliable weekly routine (4/4 weeks, up from 2 in May); pillar slipped to 3 (missed the first week); topic-queue held at 3. **freshness is still the only routine that has never recorded a commit** — three months running, worth checking whether it is wired up at all. Broken-link count keeps climbing (58→72 in May, now 80→86 in June) — the internal-linking pass is adding links faster than link-rot is being triaged; schedule a manual dead-link cleanup.
- Roadmap items checked off: still cannot diff start-vs-end-of-month — `TRAFFIC_ROADMAP.md` is gitignored (.gitignore:27) so the file has no git history. Current state: 33 of 40 `### [x]` items checked; the total grew from 38 to 40 (two new items added) while the checked count held at 33, so net-zero new completions recorded this month. Roadmap diffing still needs the file untracked → tracked, or a snapshot mechanism.
- Top topic clusters (tags aggregated across the 110 new posts): `dotnet` (46), `dotnet11` (44), `csharp` (43). Next tier: `aiagents` (20), `errors` (20), `flutter` (19), `aspnetcore` (19), `dart` (18), `comparison` (17), `efcore` (16). The .NET-11/EF-Core track and the AI-agents/Cursor/Claude track remain the two live pillars; `errors` (20) and `comparison` (17) confirm the troubleshooting and "X vs Y" formats keep pulling weight, and `flutter`+`dart` (37 combined) shows the Flutter track is now a real third cluster.

**Search signal:** (from GSC — `gsc-candidates.json`, `gsc-rising.json`, `gsc-low-ctr-pages.json`, all refreshed 2026-07-04)
- Ranking wins (position < 10 AND impressions > 100): **no query-level entry meets the imp>100 bar**, but this is the first month with meaningful *page-level* organic volume. `gsc-low-ctr-pages.json` shows the standout: **`/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/` at position 4.71 with 6,196 impressions and 0 clicks** — a page-1 result drowning in impressions with zero CTR, i.e. a title/meta-description rewrite is the single highest-leverage action available right now. Other genuine page-1 pages with real volume: `/nest-subagents-in-the-cursor-sdk-reviewer.../` (pos 4.19, imp 396), `/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent.../` (pos 4.03, imp 375), `/expose-functions-to-cursor-sdk-agent-with-local-customtools/` (pos 3.88, imp 262), `/claude-code-vs-cursor-vs-copilot-agent-mode.../` (pos 6.4, imp 123). The Cursor-SDK cluster is clearly the site's organic breakout.
- Page-2 conversion targets (position 11-20 AND impressions > 50): **none meet threshold**. `gsc-candidates.json` has a single entry this month (`".cursor/permissions.json" "allow_instructions" "block_instructions"`, pos 11, imp 1) and `gsc-rising.json` is all sub-35-impression `permissions.json`/`autorun` schema queries (best: `"permissions.json" autorun allow_instructions block_instructions schema`, pos 9.38, imp 34, +7). No page-2 query clears imp>50, so there is nothing on page 2 to push over the line this month — the leverage is entirely in fixing CTR on the page-1 Cursor-SDK pages above, not in page-2 promotion.

**Manual fill (user):**
- Sessions / users:
- Top 10 landing pages:
- Newsletter subscriber count:
- Social referrals by source:
- Next month's 3 priorities:

## 2026-05

**Shipped:**
- 138 posts published (files added under `site/src/content/blog/2026/05/`). Commit-prefix split for the same window: 27 `post:` (news), 78 `evergreen:`, 29 `agents:` (= 134); the remaining ~4 shipped via multi-slug "post: A, B" commits. The month was evergreen-heavy — a large `migrate-from-X-to-Y` series (AutoMapper→source-gen, MediatR→plain DI, Newtonsoft→STJ, Xamarin.Forms→MAUI, .NET Framework 4.8→11, .NET 8→11) drove the high evergreen count.
- Maintenance runs: pillar x5 (2026-05-03, -10, -17, -24, -31 — weekly routine fired every week), freshness x0, link-pass x2 (internal-linking pass + backfill, both 2026-05-24), topic-refill x1 (2026-05-30). Also fired: agents-queue refill (05-24) and link-rot reports (05-24: 58 broken, 05-31: 72 broken — broken-link count is rising, worth a manual triage). Big improvement over April, where only the pillar pass ran: internal-linking and topic-queue routines both produced commits this month; freshness is still the only weekly routine with zero recorded runs.
- Roadmap items checked off: still cannot diff start-vs-end-of-month — `TRAFFIC_ROADMAP.md` is gitignored (.gitignore:27) so the file has no git history. Current state: 33 of 38 `### [x]` items checked (unchanged headline count from April). Roadmap diffing still needs the file untracked → tracked, or a separate snapshot mechanism.
- Top topic clusters (tags aggregated across the 138 new posts): `dotnet` (64), `dotnet11` (61), `csharp` (58). Next tier: `aiagents` (41), `errors` (36), `claudecode` (25), `comparison` (22), `flutter` (18), `mcp` (16). The .NET 11 preview track and the AI-agents/Claude/MCP track are both strongly live; `errors` (36) and `comparison` (22) show the news/troubleshooting and "X vs Y" formats are pulling weight.

**Search signal:** (from GSC, `content-strategy/gsc-candidates.json` + `gsc-rising.json`, both refreshed 2026-05-30)
- Ranking wins (position < 10 AND impressions > 100): **none meet threshold**. Both GSC export files are very sparse this month (2 entries each). Strongest organic signal: `"mapster.sourcegenerator" nuget` — pos **4.44**, impressions **52** (up from 15 prior, delta **+37**) — a genuine rising page-1 query that sits just under the imp>100 bar; the AutoMapper→source-gen migration evergreen likely fed this. Track it next month to see if it clears the threshold.
- Page-2 conversion targets (position 11-20 AND impressions > 50): **none meet threshold**. Only two page-2 entries exist in the candidates file, both at 1 impression (`addkiotahandlers c` pos 12, and a Windows Phone `backbackgroundimage` query pos 11). Site-wide impressions remain too low for the prompt's thresholds to bite — treat thresholds as informational again this month, and check whether the GSC export is actually pulling the full query set (only 2 rows is suspiciously thin vs. April).

**Manual fill (user):**
- Sessions / users:
- Top 10 landing pages:
- Newsletter subscriber count:
- Social referrals by source:
- Next month's 3 priorities:

## 2026-07

**Shipped:**
- 142 posts published (files added under `site/src/content/blog/2026/07/`). Commit-prefix split for the same window: 32 `post:` (news), 81 `evergreen:`, 29 `agents:` — 142 exactly, the first month where prefix commits and file count reconcile with zero drift (no multi-slug or re-slug commits). Volume rebounded hard from June's 110 to a new high above May's 138. Shape: a heavy `fix-*` troubleshooting run (EF Core 11, ASP.NET Core 11 minimal APIs, Flutter/Riverpod 3, Dart), the ASP.NET Core 11 / .NET 11 preview-6 news track (CSRF, async validation, union types, MAUI CoreCLR, SignalR), and a sustained agents track (MCP transports, Microsoft Agent Framework, Cursor cloud agents, Claude Code releases).
- Maintenance runs: pillar x4 (2026-07-05, -12, -19, -26 — fired every week), freshness x0, link-pass x2 (internal-linking 2026-07-19, -26), topic-refill x3 (topic-queue refill 2026-07-11, -18, -25). Also fired: gsc harvest x4 (07-04, -11, -18, -25), agents-queue refill x2 (07-11, -25), evergreen resurface draft (07-26), and weekly link-rot reports (07-05: 91 broken, 07-12: 90, 07-19: 100, 07-26: 99).
- **freshness mystery solved:** three retros in a row have flagged "freshness has never recorded a commit". Cause found — `site/scripts/freshness-pass.mjs` was deleted on **2026-04-27** (commit "Delete freshness-pass.mjs"), but `site/package.json:17-18` still declares the `freshness-pass` and `freshness-pass:apply` npm scripts pointing at the missing file. The routine cannot fire; it is not late, it is gone. Action: either restore the script or drop the two dead package.json entries and stop tracking freshness in this retro.
- **Regression vs June:** pillar improved (3 → 4, full coverage) but internal-linking dropped from 4/4 weeks to 2 (missed 07-05 and 07-12). Broken links climbed again — June ended at 86, July ran 90-100 and closed at 99. Fourth consecutive month of net growth (58 → 72 → 86 → 99). The internal-linking pass keeps adding links faster than link-rot gets triaged; a manual dead-link cleanup is now overdue rather than merely advisable.
- Roadmap items checked off: still cannot diff start-vs-end-of-month — `TRAFFIC_ROADMAP.md` is gitignored (.gitignore:27) so the file has no git history. Current state: **33 of 40** `### [x]` items checked — identical to June (33/40). Second consecutive month of net-zero recorded completions. Roadmap diffing still needs the file untracked → tracked, or a snapshot mechanism.
- Top topic clusters (tags aggregated across the 142 new posts): `dotnet` (61), `dotnet-11` (57), `csharp` (51). Next tier: `ai-agents` (48), `errors` (31), `flutter` (25), `dart` (24), `claude-code` (24), `aspnetcore` (23), `mcp` (21), `comparison` (17), `migration` (15), `llm` (15). `ai-agents` jumped from 33 (June) to 48 and is now within striking distance of the `csharp` core; `errors` (31) confirms the troubleshooting format was the month's workhorse.

**Search signal:** (from GSC — `gsc-candidates.json`, `gsc-rising.json`, `gsc-low-ctr-pages.json`, all refreshed by the `chore: gsc harvest 2026-08-01` run)
- Ranking wins (position < 10 AND impressions > 100): **no query-level entry meets the bar** — `gsc-candidates.json` has only three rows this month, all at 1 impression (`kebab-case` pos 20, `mib bytes meaning` pos 18, `wpf select folder dialog` pos 14), and `gsc-rising.json` is **empty (`[]`)**. Query-level export is effectively dry; the signal is all page-level. Genuine page-1 pages with volume: **`/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/` (pos 5.06, 2,412 impressions, 0 clicks)**, `/2026/06/nest-subagents-in-the-cursor-sdk-reviewer-delegates-to-test-writer/` (pos **2.67**, 195 imp, 0 clicks), `/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/` (pos 6.07, 131 imp, 0 clicks), `/2026/06/expose-functions-to-cursor-sdk-agent-with-local-customtools/` (pos **2.31**, 81 imp, 0 clicks), `/archive/` (pos 8.62, 85 imp).
- **The CTR problem is now the whole story.** Every one of those pages sits on page 1 — two of them in positions 2-3 — with **zero clicks**. June's retro called the title/meta rewrite on the `gate-cursor-sdk-tool-calls` page "the single highest-leverage action available"; a month later that page is still position ~5 with 0 clicks, so the rewrite did not happen. Positions are holding or improving (5.06 vs 4.71 is noise; `expose-functions` moved 3.88 → 2.31, `nest-subagents` 4.19 → 2.67) while clicks stay at zero across the board. Either the titles/descriptions are not earning the click, or click data is not being attributed — worth confirming in the GSC UI before spending more effort on rankings. **Rankings are not the bottleneck; the SERP snippet is.**
- Page-2 conversion targets (position 11-20 AND impressions > 50): **none meet threshold** at query level (the three candidate rows are all 1 impression). At *page* level there are real page-2/page-3 targets with volume, which is where next month's evergreen effort should point: `/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/` (pos 21.45, **365 imp**), `/2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows/` (pos 15.27, 83 imp), `/ru/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/` (pos 21.76, 51 imp). Note the 2023 Flutter post at 365 impressions — the old back-catalogue still pulls more impressions than most of this month's new work; a refresh pass over the 2023 Flutter/WPF/dotnet-ef pages (several at 70-100 imp, positions 26-42) is likely higher-yield than more net-new posts.
- Localised pages are registering: `/ja/` (pos 39.33, 51 imp) and the `/ru/` HttpClient fix (pos 21.76, 51 imp) both appear in the low-CTR export — the translation track is being indexed and served.

**Manual fill (user):**
- Sessions / users:
- Top 10 landing pages:
- Newsletter subscriber count:
- Social referrals by source:
- Next month's 3 priorities:
