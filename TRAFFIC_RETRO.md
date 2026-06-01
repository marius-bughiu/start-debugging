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
