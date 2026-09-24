---
title: "Migrate a Cursor Cloud Agent Workflow off GitHub to Cursor Origin (Early Beta, September 2026)"
description: "Move a repo, its Cursor cloud agents, automations, Bugbot, and CI from GitHub to Cursor Origin without a flag day: mirror first, rewire agents and CI while GitHub is still the source of truth, then cut over with Detach from GitHub or the reversible inbound_to_outbound mirror transition. Covers what breaks, the Origin CLI and API calls, a ref-parity check, and the rollback path."
pubDate: 2026-09-24
updatedDate: 2026-09-24
template: migration
tags:
  - "migration"
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "git"
  - "github"
---

**Short answer:** do it in two stages. First, **Sync from GitHub** at [cursor.com/codebase](https://cursor.com/codebase) (or `origin repo create-mirrored acme/checkout`), which gives you an Origin mirror while GitHub stays the source of truth. Point your cloud agents and automations at the mirror and move CI to Depot or Buildkite while nothing is at risk. Then cut over: either **Settings → General → Detach from GitHub** (one-way, Origin becomes a standalone repo and GitHub is frozen), or the Origin API's `inbound_to_outbound` mirror transition, which makes Origin the source of truth and keeps pushing to GitHub, and which can be reversed with `outbound_to_inbound`. Before either, verify ref parity, and accept that GitHub Issues, GitHub-only automation triggers, and `@cursor` PR comments do not come with you.

Everything here is against Origin's **early beta** as documented on 2026-09-24: Origin launched on 2026-08-17 for Pro, Teams, and Enterprise plans ([changelog](https://cursor.com/changelog/origin-code-hosting)), and the Origin CLI and Origin API are both marked subject to change. I do not have an Origin namespace to test against, so the Origin-side commands below come from the CLI reference and the OpenAPI spec, not from a live run. The git behaviour (dual push URLs, `origin/*` branch names, the ref-parity script) I ran locally on git 2.50.1 against two bare repositories.

## What "a cloud agent workflow" means here

The typical setup: a GitHub repo with the Cursor GitHub app, a few [Cursor Automations with GitHub triggers](/2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers/) (triage failing CI, fix review comments), `@cursor` comments on PRs, Bugbot on every PR, a script calling the Cloud Agents API, and GitHub Actions running the build. Origin can host most of that, but the pieces move at different speeds, and a few do not move at all.

The key concept is the **direction** of a mirror. When you sync a GitHub repo, Origin creates an *inbound* mirror: GitHub is the source of truth, a `git push` to `https://origin.cursor.com/acme/checkout.git` is passed through to GitHub, and Origin updates after GitHub accepts it ([Mirror a GitHub repository](https://cursor.com/docs/origin/mirror-github)). The Origin API's `RepositoryMirror.status` enum has exactly two values, `inbound` and `outbound`, and the transition jobs move a repo between them. The migration is the move from the first state to either "outbound" or "detached".

## Why move at all

- **Agents, PRs, and code in one place.** On an Origin-hosted repo, cloud agents open Origin pull requests and the agent panel lives next to the PR. On an inbound mirror, agents still open GitHub pull requests ([Origin integrations](https://cursor.com/docs/origin/integrations)).
- **Origin Apps get their full scopes only on native repos or a stable outbound mirror.** On an inbound mirror an installation token is limited to `repository:metadata:read` and `repository:contents:read`; every PR, check, review, and push call returns `403` ([Origin API: Mirrored repositories](https://cursor.com/docs/api/origin/llms-full.txt)). If you plan to build on the Origin API, the mirror is a dead end.
- **Depot CI and Buildkite only run on Origin-hosted repos**, not on mirrors ([repository settings](https://cursor.com/docs/origin/settings)).
- **CloneKit** (`origin repo clone-fast`, Enterprise only) cuts clone time for large repos in CI.

If all you want is Bugbot comments on GitHub PRs, Cursor's own docs say not to mirror at all. That is still true.

## What breaks

| Area | After cutover | Severity |
| --- | --- | --- |
| GitHub Actions | Workflows stop firing for pushes that land on Origin. Rebuild on Depot CI or Buildkite. | high |
| Automation triggers | Origin offers the core triggers (push to branch, PR opened/pushed, comment added). GitHub-only triggers have no Origin equivalent: CI completed, Workflow run completed, PR/issue label changed, issue comment, PR review comment, review submitted, review thread updated. | high |
| GitHub Issues | Not synced. They stay on GitHub. | high |
| `@cursor` on PRs/issues | GitHub and Bitbucket comment triggers only. Origin PRs use the in-product agent panel. | medium |
| Cloud Agents API | `repos[].url` and `prUrl` are documented as GitHub URLs. Check before repointing scripts. | medium |
| Bugbot | Supported on Origin, including both autofix modes. | low |
| Submodules | Partial: cloud agents do not pull submodule contents on clone (per the [launch forum thread](https://forum.cursor.com/t/origin-code-hosting/168670)). | medium |
| Namespace | The codebase name cannot be changed during the beta. | medium |
| Branch protection | GitHub rulesets do not migrate. Recreate them under **Rules and Protections**. | medium |

## Pre-flight checklist

- A paid plan with Origin enabled, and a team that is not on legacy Privacy Mode (Origin refuses to enable there).
- A claimed codebase name. Pick it carefully, since it is permanent during the beta and appears in every URL: `https://cursor.com/codebase/{owner}/{repo}`.
- GitHub **admin** on the source repo. The sync needs it, and so do the mirror transition endpoints (`repository:mirror:write`), which check your admin rights on the upstream.
- The Cursor GitHub app connected to the org that owns the repo.
- The Origin CLI: `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, then `origin auth login`. It installs to `~/.local/bin`, which is not on the default zsh `PATH`.
- An inventory of what currently depends on GitHub. This script lists it, using the GitHub CLI:

```bash
#!/usr/bin/env bash
# inventory.sh acme/checkout  (gh 2.x, jq 1.7)
set -euo pipefail
R=$1
echo "## workflows";      gh workflow list -R "$R" --all
echo "## secrets";        gh secret list -R "$R"
echo "## variables";      gh variable list -R "$R"
echo "## open issues";    gh issue list -R "$R" --state open --limit 1000 --json number --jq length
echo "## open PRs";       gh pr list -R "$R" --state open --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"'
echo "## rulesets";       gh api "repos/$R/rulesets" --jq '.[].name'
echo "## submodules";     gh api "repos/$R/contents/.gitmodules" --jq .path 2>/dev/null || echo none
echo "## origin/* branches (reserved on Origin mirrors)"
gh api "repos/$R/branches" --paginate --jq '.[].name | select(test("^origin(/|$)"))'
```

The last line matters. Origin does not sync GitHub branches named `origin` or `origin/...`, because that namespace is reserved for Origin-only work on mirrors. A GitHub branch called `origin/hotfix` silently never appears on Origin.

## Migration steps

1. Mirror the GitHub repository into Origin.
2. Repoint cloud agents, automations, and Bugbot at the mirror.
3. Move CI off GitHub Actions.
4. Freeze writes and verify ref parity.
5. Cut over with Detach or with the inbound-to-outbound transition.
6. Repoint every clone and remote.

### Step 1: mirror the repository

From the web UI: **cursor.com/codebase → Sync from GitHub**, pick the org and repo, confirm. From the CLI:

```bash
# Origin CLI (early beta, stable channel)
origin repo create-mirrored acme/checkout --namespace acme
origin repo view acme/checkout --json org,name,defaultBranch
```

History, branches, tags, and GitHub PRs sync. Issues and Actions workflows and secrets do not. **Verify:** open **Settings → General** on the Origin repo. Sync Status should show Origin as the mirror and GitHub as the source.

### Step 2: repoint agents and automations while GitHub is still the source

This step is safe because on an inbound mirror every agent push still lands on GitHub and every agent PR is still a GitHub PR. Attach cloud agents to the Origin repo from your codebase, and for each automation, change its repository to the Origin repo and re-select its triggers from the **Origin** trigger group.

Two early-beta traps here. First, the Origin trigger submenu could not be selected with the mouse until a fix on 2026-09-02; hard-reload the automations page if it still collapses ([forum report](https://forum.cursor.com/t/automation-cant-set-origin-triggers/169299)). Second, staff noted in that thread that automatic firing of the Origin pull-request trigger was still rolling out, while manual runs worked. So trigger each rewired automation once by hand, then push a throwaway PR and confirm it fires on its own.

Automations built on GitHub-only triggers need a redesign, not a repoint. The common one is "CI completed → triage failure". On Origin, CI status arrives as check runs, so the replacement is a **webhook trigger** that your CI calls on failure, or a **Pull request pushed** trigger whose prompt reads the checks itself with `origin pr checks --json`.

Bugbot needs nothing beyond confirming the autofix mode, since Origin supports both **Create New Branch** and **Commit to Existing Branch** ([Bugbot docs](https://cursor.com/docs/bugbot)). If you [run Bugbot locally before pushing](/2026/06/how-to-run-bugbot-review-locally-before-pushing-in-cursor/), that workflow is untouched.

For scripts that call the Cloud Agents API, note that the reference still describes `repos[].url` as a "GitHub repository URL" and `prUrl` as a GitHub PR URL ([API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)). Keep API-driven agents pointed at the GitHub URL until Cursor documents Origin URLs there, or until you have confirmed a test run against `https://origin.cursor.com/acme/checkout` works for your account.

**Verify:** start one cloud agent against the Origin repo and check that its branch appears on GitHub and that its PR is a GitHub PR.

### Step 3: move CI

Pushes that land on an Origin-hosted repo do not reach GitHub, so GitHub Actions never sees them. The two supported paths are the Depot and Buildkite Origin Apps, and both work only on Origin-hosted repos, which means you prepare them now and they start running at cutover.

Depot converts existing workflows ([Depot's announcement](https://depot.dev/blog/depot-in-cursor-origin)):

```bash
# Depot CLI, run in the repo root
depot login
depot ci migrate workflows          # reads .github/workflows/, writes .depot/workflows/
depot ci migrate secrets-and-vars   # one-time import of referenced secrets and variables
git add .depot/workflows && git commit -m "ci: add Depot CI workflows"
```

Review whatever the migrator flags as not translated cleanly, then commit the result to the default branch. Buildkite users connect Origin under **Settings → Repository Providers → Origin**, and Enterprise teams can swap the checkout for `origin repo clone-fast` ([CloneKit in CI](https://cursor.com/docs/origin/clonekit-ci)). Note that CloneKit tokens expire after at most 15 minutes and cannot be refreshed, so mint one right before the clone.

Also recreate branch protection under **Rules and Protections**, and `origin ruleset list` afterwards to confirm the rules exist. If an agent can merge to `main` before this is in place, it will.

**Verify:** after cutover (step 5), the first push to a PR branch should produce a check on the Origin PR's **Checks** tab. Until then, keep GitHub Actions enabled.

### Step 4: freeze writes and verify ref parity

Pause every automation, stop long-running cloud agents, and ask humans to stop pushing. Then compare refs on both sides. This is the script I ran against the local lab; it ignores Origin-only `refs/heads/origin/*` branches:

```bash
#!/usr/bin/env bash
# compare-refs.sh <github-url> <origin-url>
# git 2.50, bash 3.2+. Ignores Origin-only refs/heads/origin/* branches.
set -euo pipefail
gh_refs=$(git ls-remote --heads --tags "$1" | sort -k2)
og_refs=$(git ls-remote --heads --tags "$2" | grep -v $'\trefs/heads/origin/' | sort -k2 || true)
if diff <(echo "$gh_refs") <(echo "$og_refs"); then
  echo "OK: $(echo "$gh_refs" | wc -l | tr -d ' ') refs identical"
else
  echo "MISMATCH: do not cut over yet" >&2
  exit 1
fi
```

```bash
./compare-refs.sh https://github.com/acme/checkout.git https://origin.cursor.com/acme/checkout.git
```

If the mirror lags, force a sync of the specific ref and wait up to about two minutes for it:

```bash
origin api -X POST '/repos/acme/checkout:syncMirror' \
  -F wait=true -f ref=refs/heads/main
```

**Verify:** `OK: N refs identical`, with N matching the branch and tag count on GitHub.

### Step 5: cut over

You have two options, and they differ in reversibility.

**Option A, Detach from GitHub.** In **Settings → General → Danger Zone**, select **Detach from GitHub**. The sync stops in both directions, the mirror's deploy credential is deleted, and the Origin copy becomes a native repo. Your GitHub repo is untouched but frozen: nothing pushed to Origin will ever reach it again. The API equivalent is `DELETE /v1/origin/repos/{owner}/{repo}/mirror`, which the OpenAPI spec describes as "not reversible through this API".

**Option B, transition to an outbound mirror.** The Origin Migration API exposes `POST /v1/origin/repos/{owner}/{repo}/mirror:transition` with `transition: inbound_to_outbound`. It needs a user credential (the `repository:mirror:write` scope is not available to Origin Apps) and GitHub admin rights on the upstream:

```bash
# Origin API, early beta. Requires user credential + GitHub admin on the source repo.
origin api -X POST '/repos/acme/checkout/mirror:transition' \
  -f transition=inbound_to_outbound \
  --jq '.job | "\(.id) \(.status) \(.phase)"'

# poll until a terminal status: succeeded, failed_rolled_back, superseded
# (requires_attention needs a human or a forced cutover)
while :; do
  s=$(origin api '/repos/acme/checkout/mirror/transition-jobs:active' \
        --jq '(.activeJob // .lastJob) | "\(.status) \(.phase) \(.lastErrorCode // "")"')
  echo "$s"
  case "$s" in succeeded*|failed_rolled_back*|superseded*|requires_attention*) break;; esac
  sleep 15
done
```

The job goes through phases such as `draining-writes` (with a `drainUntil` deadline), `finalizing-mirror-push`, `snapshotting-refs`, and `verifying-integrity`. The documented failure codes include `InboundMirrorDrainTimeout`, which is exactly what you get if someone keeps pushing to GitHub during the drain, and `MirrorIntegrityMismatch`. That is why step 4 exists. The field names (`job` on the start response, `activeJob`/`lastJob` on the poll) come from the OpenAPI spec; check `origin api --help` for flag syntax in your CLI version.

One thing the spec warns about explicitly: `mirror.status` can read `outbound` while the repo is still read-only mid-transition, so do not branch on it. A `403` on push is the authoritative answer.

**Which option to pick:** use Option B when other people still read the GitHub repo (open-source consumers, a deploy pipeline you have not moved yet, auditors), because GitHub keeps receiving Origin's commits. Use Option A when GitHub is being decommissioned and you want the cleanest state.

**Verify:** push a commit to a branch on Origin. On an outbound mirror it should appear on GitHub; on a detached repo it should not. Either way, Depot or Buildkite should now report a check.

### Step 6: repoint every clone

```bash
git remote set-url origin https://origin.cursor.com/acme/checkout.git
git remote -v
origin auth status
```

`origin auth login` installs the git credential helper, so plain `git push` works afterwards. CI runners that use an Origin App token authenticate git with Basic auth, username `x-access-token` and the installation token as password; Git HTTPS rejects bearer tokens. Finally, re-enable the automations paused in step 4.

## Keeping both remotes during evaluation

If you want to trial Origin-hosted features on a separate repo before touching the real one, Cursor's docs suggest a dual push URL. I checked what that does locally with two bare repos standing in for GitHub and Origin:

```bash
# git 2.50.1
git remote set-url --add --push origin https://github.com/acme/checkout.git
git remote set-url --add --push origin https://origin.cursor.com/acme/checkout.git
```

Two behaviours worth knowing. Once any `pushurl` exists, git stops pushing to the fetch URL, so you must add both, not just the new one. And the pushes are sequential and not atomic: when I made the second remote reject the push with a pre-receive hook, the first remote advanced to the new commit, the second stayed behind, and `git push` exited `1` with `failed to push some refs`. A half-applied push is easy to miss in a script that only checks one remote. The ref-parity script above catches it.

## Rollback plan

- **Before step 5:** nothing to roll back. Delete the Origin mirror and repoint automations to GitHub.
- **After Option B:** start an `outbound_to_inbound` transition, which pushes Origin's state back and makes GitHub the source again. If that job gets stuck in `requires_attention`, `POST .../mirror:forceCutover` makes GitHub the source *as-is*: refs that exist only on Origin are snapshotted and abandoned, so push anything you need to GitHub first.
- **After Option A:** there is no API path back. Your GitHub repo is intact at the moment of detach, so rollback means pushing Origin's commits to GitHub by hand (`git push github --all && git push github --tags`) and re-mirroring from scratch.

## Gotchas

- **`origin/` is a legal branch name and a terrible one.** On mirrors, Origin reserves `origin/*` for Origin-only branches pushed with `origin push local`. Locally, `git branch origin/main HEAD` succeeds and then every `git rev-parse origin/main` prints `warning: refname 'origin/main' is ambiguous`, and `git switch origin/main` refuses with `a branch is expected, got remote branch 'origin/main'`. Pick names like `origin/wip-checkout` that do not shadow a real branch.
- **`origin push local` is not an escape hatch after cutover.** The `/local` endpoint exists only on inbound mirrors. On a native repo, push normally.
- **Agent identity changes.** On GitHub, automations running as a service account open PRs as `cursor`. On Origin, check the author on the first agent PR before any rule keyed on author names (CODEOWNERS-style reviewers, merge bots) goes live.
- **PR merge through the Origin API rejects mirrored repos.** If you wrote a merge bot against an inbound mirror, it will start working only after cutover.
- **Submodules.** If the inventory found `.gitmodules`, have the agent's environment setup run `git submodule update --init --recursive`, since cloud agents do not do it on clone. The [environment build config](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/) is the right place for it.

## Related

- [Cursor cloud agents vs GitHub Copilot coding agent for background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/) is the comparison to reread if leaving GitHub also means leaving Copilot's coding agent behind.
- [Build a Cursor Automation with the /automate skill and GitHub triggers](/2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers/) covers the automations you are rewiring in step 2.
- [Copilot code review vs Cursor Bugbot vs the Claude Code review action](/2026/09/copilot-code-review-vs-cursor-bugbot-vs-claude-code-review-action/) helps if your review bot choice depended on GitHub.
- [How to keep Cursor agent tool execution inside your own network](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/), because moving code to Origin does not change where agent commands run.

## Sources

- [Origin overview](https://cursor.com/docs/origin), [Clone, Push & Pull](https://cursor.com/docs/origin/git), [Mirror a GitHub repository](https://cursor.com/docs/origin/mirror-github), [Repository settings](https://cursor.com/docs/origin/settings), [Integrations](https://cursor.com/docs/origin/integrations)
- [Origin CLI command reference](https://cursor.com/docs/origin/cli/reference/commands) and [pull request commands](https://cursor.com/docs/origin/cli/reference/pull-requests)
- [Origin API reference](https://cursor.com/docs/api/origin/llms-full.txt), [OpenAPI spec](https://cursor.com/docs/api/origin/openapi.yaml), and [Origin Migration API](https://cursor.com/docs/api/origin/migrations)
- [CloneKit in CI](https://cursor.com/docs/origin/clonekit-ci)
- [Cursor Automations](https://cursor.com/docs/cloud-agent/automations), [Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints), [Bugbot](https://cursor.com/docs/bugbot)
- [Origin Code Hosting changelog, 2026-08-17](https://cursor.com/changelog/origin-code-hosting) and the [release discussion](https://forum.cursor.com/t/origin-code-hosting/168670)
- [Depot CI is now available in Origin](https://depot.dev/blog/depot-in-cursor-origin)
