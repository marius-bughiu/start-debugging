---
title: "How to Request a Copilot Code Review From the REST API and Set Its Effort Level"
description: "Request a GitHub Copilot code review from a script with the REST requested_reviewers endpoint, the GraphQL requestReviewsByLogin mutation, or gh pr edit, then control whether it runs at Lite or Balanced effort. Covers the bot login, the effort precedence chain, why the per-request effort field announced on October 2, 2026 is not in the published schemas yet, and how to read the effort that actually ran."
pubDate: 2026-10-14
template: how-to
tags:
  - "github-copilot"
  - "ai-agents"
  - "code-review"
  - "github-api"
  - "automation"
---

**Short answer:** POST `{"reviewers":["copilot-pull-request-reviewer[bot]"]}` to `/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` with a token that belongs to a user who has Copilot code review, and Copilot starts a review exactly as if that user had clicked it in the **Reviewers** menu. The GraphQL equivalent is `requestReviewsByLogin` with `botLogins: ["copilot-pull-request-reviewer[bot]"]`, which is what `gh pr edit --add-reviewer "@copilot"` sends. GitHub's [October 2, 2026 changelog](https://github.blog/changelog/2026-10-02-copilot-code-review-api-support-and-new-default-effort-level/) says these requests can optionally carry a per-request effort level, but as of October 14, 2026 neither the published REST description (`github/rest-api-description` at commit `77ed1eae`, October 13) nor live GraphQL introspection exposes that field. Until it lands, the effort an API-triggered review uses is decided by the precedence chain: an effort already used on that PR, then **the token owner's personal effort setting**, then the repository, then the organization, then the built-in Balanced default. Set the personal level of the account whose token your script uses, and verify the result by reading the `**Review effort:**` line Copilot writes into its review body.

Everything below was checked against the REST API version `2026-03-10`, the github.com GraphQL schema as of October 14, 2026, and GitHub CLI 2.102.0.

## Why you would trigger a review from a script at all

Automatic review through a branch ruleset (the `copilot_code_review` rule) covers the common case: every PR gets reviewed once when it opens, and optionally on every push. It is also blunt. It cannot say "review only PRs that touch `src/payments/`", "review at Balanced only when the PR carries a `security` label", or "re-review after the release-branch rebase but not after every fixup commit". Those decisions live in your own scripts, bots and internal tools, which is exactly the audience the October 2 changelog names.

Cost is the other reason to be deliberate. GitHub's [code review concepts page](https://docs.github.com/en/copilot/concepts/agents/code-review) estimates a Lite review at roughly $0.05 to $1 of AI credits and a Balanced review at $0.25 to $5, both rising with PR size and the amount of custom instructions in the repository. Since [the default flipped to Balanced on September 28](/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/), a script that fires reviews without thinking about effort is spending at the higher rate by default.

## Request the review with REST

The endpoint is the ordinary [request reviewers](https://docs.github.com/en/rest/pulls/review-requests#request-reviewers-for-a-pull-request) call. Copilot is addressed by its bot login, including the `[bot]` suffix:

```bash
# REST API version 2026-03-10, GitHub CLI 2.102.0
gh api --method POST \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  "repos/OWNER/REPO/pulls/123/requested_reviewers" \
  -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
```

The same call with `curl`, for environments without `gh`:

```bash
# REST API version 2026-03-10
curl -sS -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  "https://api.github.com/repos/OWNER/REPO/pulls/123/requested_reviewers" \
  -d '{"reviewers":["copilot-pull-request-reviewer[bot]"]}'
```

A `201` means the request was accepted, not that a review exists. The review is produced asynchronously. On a sample public PR I checked (`microsoft/vscode#336683`), the `review_requested` timeline event and the submitted review were ten minutes apart, and the timeline lists the requested reviewer as `Copilot` while the review itself is authored by `copilot-pull-request-reviewer[bot]` with `user.type: "Bot"`. Filter on the latter when you look for the result.

Two things decide whether the request actually starts a review:

1. **The token's owner needs Copilot code review.** The request is attributed to whoever owns the token, and that user is the "requestor" for billing and for the effort lookup below. A fine-grained token needs **Pull requests: write** on the repository.
2. **Organizations can restrict who may trigger reviews.** With "Only allow Copilot code review to be triggered by authorized users" turned on, the concepts page says "API review requests from those people do not start a review", for users without a license from that organization. The call still returns success, so a silent no-op here looks identical to a slow review.

## Request it with GraphQL or the GitHub CLI

GraphQL has a login-based mutation with a dedicated `botLogins` field, so you do not need to look up the bot's node ID first:

```bash
# GitHub GraphQL schema as of 2026-10-14, GitHub CLI 2.102.0
PR_ID=$(gh api graphql -F owner=OWNER -F repo=REPO -F number=123 -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
  }' --jq '.data.repository.pullRequest.id')

gh api graphql -F pr="$PR_ID" -f query='
  mutation($pr: ID!) {
    requestReviewsByLogin(input: {
      pullRequestId: $pr,
      botLogins: ["copilot-pull-request-reviewer[bot]"],
      union: true
    }) { pullRequest { number } }
  }'
```

Set `union: true`. Its default is `false`, which replaces the existing set of requested reviewers instead of adding to it, so a script that only wanted to add Copilot would quietly un-request your human reviewers.

The CLI wraps that same mutation. In `cli/cli` v2.102.0, `pr edit` routes reviewer changes through `RequestReviewsByLogin` and maps `@copilot` to the `copilot-pull-request-reviewer` login:

```bash
# GitHub CLI 2.102.0 (not supported on GitHub Enterprise Server)
gh pr edit 123 --repo OWNER/REPO --add-reviewer "@copilot"

# Or at creation time
gh pr create --reviewer "@copilot" --title "..." --body "..."
```

None of the three surfaces (REST body, GraphQL input, `gh` flags) had an effort parameter when I checked. Live introspection of `RequestReviewsInput`, `RequestReviewsByLoginInput` and `RerequestReviewsInput` returns only the pull request ID, the user/bot/team lists and `union`.

## How Copilot picks the effort level for an API request

This is the part that matters for cost, and it is documented precisely. Per the [concepts page](https://docs.github.com/en/copilot/concepts/agents/code-review), Copilot "checks the following options in order and uses the first one that applies":

1. An effort level chosen when the review is requested.
2. An effort level previously used on the same pull request.
3. The requestor's effort level (for a new PR, the author; when a draft is marked ready, whoever marked it).
4. The repository's effort level.
5. The organization's effort level, or the repository owner's personal level on a user-owned repository.
6. GitHub's built-in default, Balanced.

Step 1 is the per-request field the changelog promises. Until it is published, an API request skips straight to step 2, and for most scripts the effective control is step 3: **the personal setting of the account that owns the token**. That setting lives under your profile picture, **Copilot settings > Code review > Review effort level**, and according to the [configuration docs](https://docs.github.com/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review) it "applies to Copilot reviews you request, including automatic ones". There is no REST endpoint for it, so it is a one-time click on the bot account.

That gives you a workable pattern today: run cheap, high-volume review requests from a machine user whose personal level is **Lite**, and run expensive ones from a different machine user set to **Balanced**. Your script chooses the token, and the token chooses the effort.

```bash
# REST API version 2026-03-10
# LITE_TOKEN belongs to a machine user whose personal review effort is Lite.
# BALANCED_TOKEN belongs to one whose personal review effort is Balanced.
request_copilot_review() {
  local repo="$1" pr="$2" token="$3"
  GH_TOKEN="$token" gh api --method POST \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "repos/$repo/pulls/$pr/requested_reviewers" \
    -f 'reviewers[]=copilot-pull-request-reviewer[bot]' --silent
}

if gh pr view "$PR" --repo "$REPO" --json files --jq '.files[].path' | grep -q '^src/payments/'; then
  request_copilot_review "$REPO" "$PR" "$BALANCED_TOKEN"
else
  request_copilot_review "$REPO" "$PR" "$LITE_TOKEN"
fi
```

Both machine users need a Copilot seat with code review, so this costs licenses. If that is not acceptable, the next-best lever is step 4: set the repository level to the one you want for scripted reviews and keep your own personal level on **Default**, which falls through to it.

Step 2 is the trap. Once a PR has been reviewed at some level, re-requests on that PR reuse it until something with higher precedence overrides it. Switching tokens mid-PR does not help, because step 2 sits above step 3. In practice the first review a PR receives fixes its effort for the rest of its life, unless someone picks a different level in the web UI's **Reviewers** menu.

## Read back which effort actually ran

Nothing in the request response tells you the effort, and the REST review object has no field for it either: its keys are `id`, `node_id`, `user`, `body`, `state`, `html_url`, `pull_request_url`, `author_association`, `_links`, `submitted_at` and `commit_id`. The information is in the body. Copilot's overview review starts with a hidden `<!-- ccr-overview-v2 -->` marker and includes a line such as `**Review effort:** Balanced`.

So a script can wait for the review and assert the level it expected:

```bash
# REST API version 2026-03-10, GitHub CLI 2.102.0, jq 1.7
wait_for_copilot_review() {
  local repo="$1" pr="$2" since="$3" deadline=$((SECONDS + 1800))
  while (( SECONDS < deadline )); do
    review=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate --jq \
      "[.[] | select(.user.login == \"copilot-pull-request-reviewer[bot]\")
            | select(.submitted_at > \"$since\")] | last // empty")
    if [[ -n "$review" ]]; then
      jq -r '.state' <<<"$review"
      jq -r '.body' <<<"$review" | grep -o 'Review effort:\*\* [A-Za-z]*' || echo "effort: unknown"
      return 0
    fi
    sleep 60
  done
  echo "no Copilot review after 30 minutes" >&2
  return 1
}

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
request_copilot_review "$REPO" "$PR" "$LITE_TOKEN"
wait_for_copilot_review "$REPO" "$PR" "$since"
```

Treat the body format as a convenience, not a contract: it is rendered Markdown, not an API field, and GitHub has already versioned it once (`v2` in the marker). If the grep stops matching, the review still happened, you just lost the cheap assertion.

The 30-minute ceiling is deliberate. Reviews run on GitHub Actions under the hood, so a queue of other Actions work in your organization delays them, and a request blocked by the "authorized users" policy never produces a review at all. A timeout is the only way to tell those apart from a slow review in a script.

## Re-request after new commits

Copilot reviews a PR once unless the ruleset has **Review new pushes** on. To get a fresh review after you push, use the re-request endpoint rather than the plain request one:

```bash
# REST API version 2026-03-10
gh api --method POST \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  "repos/OWNER/REPO/pulls/123/requested_reviewers/rerequest" \
  -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
```

The GraphQL counterpart is `rerequestReviews`, which takes node IDs (`botIds`) rather than logins. Remember step 2 of the precedence chain: the re-review inherits the effort of the earlier review on the same PR.

Re-reviews are not free. If your script re-requests on every push and the ruleset also has `review_on_push` enabled, you pay twice per push. Pick one owner for "when does Copilot look again".

## Running it from GitHub Actions

The obvious move, using `${{ secrets.GITHUB_TOKEN }}` in a workflow, makes `github-actions[bot]` the requestor. That account has no Copilot seat and no personal effort setting, so I would not build on it: at best the effort falls through to the repository level, at worst the request does nothing. Use a token owned by a licensed machine user, stored as a secret:

```yaml
# .github/workflows/copilot-review-on-label.yml
# GitHub Actions, REST API version 2026-03-10
on:
  pull_request:
    types: [labeled]

jobs:
  request-review:
    if: github.event.label.name == 'needs-deep-review'
    runs-on: ubuntu-latest
    steps:
      - name: Request a Copilot review as the Balanced machine user
        env:
          GH_TOKEN: ${{ secrets.COPILOT_BALANCED_TOKEN }}
        run: |
          gh api --method POST \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            "repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/requested_reviewers" \
            -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
```

Because of step 2, this label only buys a Balanced review if it is the PR's first Copilot review. If the ruleset already reviewed the PR at Lite when it opened, the labelled request reuses Lite. Either turn off the automatic ruleset review for repositories where labels drive effort, or set the repository level to Lite and accept that the label only changes *whether* a deep review happens on PRs that were not reviewed yet.

## Gotchas worth knowing before you wire this up

- **Do not guess the effort field name.** Third-party write-ups have floated names like `effort_level`. Undocumented body fields are not part of any contract: they may be ignored or rejected, and you cannot tell from the `201` which happened. Read the effort from the review body instead.
- **Watch the schema for the real field.** A cheap daily check against the published description tells you when the per-request field ships:

  ```bash
  # Prints any request-body property on the review-request endpoints that is not reviewers/team_reviewers
  curl -sL https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json \
    | jq -r '.paths | to_entries[] | select(.key | test("requested_reviewers"))
             | .value.post.requestBody.content["application/json"].schema.properties | keys[]' \
    | grep -v -E '^(reviewers|team_reviewers)$' || echo "no effort field yet"
  ```

- **GitHub Enterprise Server is out.** `gh` documents `@copilot` as not supported on GHES, and Copilot code review itself is a github.com feature.
- **Max is not selectable yet.** The configuration docs list a third level, Max, with a "Coming soon" label. Only Lite and Balanced exist at repository and organization level today.
- **The review is a `COMMENTED` review by default.** It does not satisfy required approvals unless you opt into the [preview that lets Copilot approve pull requests](/2026/09/copilot-code-review-can-now-approve-pull-requests/), which is scoped by file globs and dismissed on new commits.
- **Enterprise settings are not in the precedence list.** The changelog lists an enterprise location (**AI controls > Agents > Copilot code review**), but the documented resolution order stops at organization. If you manage effort centrally, verify on a test PR rather than assuming the enterprise value wins.

## Related

- [Copilot code review defaults to Balanced effort on September 28](/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/) explains the cost change that makes scripted effort control worth the trouble.
- [Copilot code review can now approve pull requests](/2026/09/copilot-code-review-can-now-approve-pull-requests/) covers the ruleset JSON and an audit query for Copilot approvals.
- [Copilot code review vs Cursor Bugbot vs the Claude Code review action](/2026/09/copilot-code-review-vs-cursor-bugbot-vs-claude-code-review-action/) compares the reviewers if you are still choosing one.
- [Copilot automations now trigger on issue and PR comments](/2026/08/copilot-automations-now-trigger-on-issue-and-pr-comments/) is the no-code alternative for comment-driven triggers.
- [How to define a GitHub Copilot CLI dynamic workflow and run it from CI](/2026/10/how-to-define-a-github-copilot-cli-dynamic-workflow-and-run-it-from-ci/) if you want the agent to do more than review once it is in your pipeline.

## Sources

- [Copilot code review: API support and new default effort level](https://github.blog/changelog/2026-10-02-copilot-code-review-api-support-and-new-default-effort-level/) (GitHub changelog, October 2, 2026)
- [About GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review), for the effort precedence order and consumption estimates
- [Configuring Copilot code review](https://docs.github.com/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review), for the personal, repository and organization effort settings
- [Using GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
- [REST API endpoints for review requests](https://docs.github.com/en/rest/pulls/review-requests), API version 2026-03-10
- [github/rest-api-description](https://github.com/github/rest-api-description), `api.github.com.json` at commit `77ed1eae` (October 13, 2026)
- [GitHub GraphQL `requestReviewsByLogin` mutation](https://docs.github.com/en/graphql/reference/mutations#requestreviewsbylogin)
- [cli/cli v2.102.0](https://github.com/cli/cli/releases/tag/v2.102.0), `api/queries_pr.go` and `api/queries_repo.go`
