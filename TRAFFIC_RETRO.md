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
