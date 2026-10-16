---
title: "How to Monitor Agent-Authored PRs After Deploy with Cursor Rollouts and Datadog"
description: "Wire Cursor Rollouts (launched September 23, 2026) to your CI and to Datadog so every PR, including the ones a cloud agent wrote, gets a rollout plan before merge and per-environment checks at deploy, 20 minutes, 1 hour, 1 day and 3 days. Covers the DeploymentsService API, a GitHub Actions job, the Datadog MCP data source, and the gotchas that leave changes stuck in Pending."
pubDate: 2026-10-16
template: how-to
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
  - "cloud-agents"
  - "datadog"
  - "observability"
---

**Short answer:** on a Cursor Teams or Enterprise plan, open [Automations](https://cursor.com/automations/rollouts), go to the **Team** tab and select **Enable** on the Rollouts card. Pick the repos to watch, store a Cursor API key as the `CURSOR_API_KEY` CI secret, and make your deploy job call `CreateDeployment` before it ships and `AppendDeploymentEvent` once it knows the outcome. Then connect Datadog as a data source (it is an MCP connection) so Rollouts can read logs, metrics and traces. From that point every PR gets a rollout plan comment when it opens, and every deploy of its commit is checked at deploy time and again at 20 minutes, 1 hour, 1 day and 3 days. A regression opens an issue, pings the author, and offers **Fix issue**, which hands it to a cloud agent.

Rollouts shipped on September 23, 2026 alongside Security Reviewer ([changelog](https://cursor.com/changelog/rollouts-and-security-reviewer), [launch post](https://cursor.com/blog/rollouts-and-security-reviewer)). It has no client version to pin because it runs server-side, so everything below is against the behavior documented on the [Rollouts docs page](https://cursor.com/docs/rollouts) as of mid-October 2026.

## Why agent-written PRs need a post-deploy watcher more than yours do

Review tools stop at merge. Bugbot, Copilot code review and the Claude Code review action all read a diff and comment on it, which I compared in [Copilot code review vs Cursor Bugbot vs Claude Code's review action](/2026/09/copilot-code-review-vs-cursor-bugbot-vs-claude-code-review-action/). None of them knows what happened after the change hit production.

That gap matters more when a cloud agent wrote the code. A human author who ships a caching change usually opens the dashboard afterward because they remember the change and they know which endpoint it touched. An agent that finished a Jira ticket at 2 a.m. does not remember anything, and the human who approved its PR reviewed fifteen others that day. If you are already doing things like [assigning Jira tickets to Cursor cloud agents and getting PRs back](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/), the volume of merged code nobody is personally watching goes up fast.

Rollouts closes that loop. It reads the diff before merge, writes down what it expects the change to do and which signals should move, then checks those signals against the pre-deploy baseline every time that commit lands in an environment. Its verdict is per environment, so a change that is fine in staging and broken in `eu-west` production shows up as exactly that.

## What Rollouts does with each PR

The lifecycle has three stages, and it helps to know them before wiring anything:

1. **Rollout plan (PR open).** Rollouts reads the diff and the systems it touches and lists the risks, the expected effect, the signals it will check, and any instrumentation gaps. On GitHub, GitLab.com and Bitbucket Cloud the plan is a PR comment. On Cursor Origin it shows on the PR page.
2. **Deploy tracking (after merge).** Rollouts runs on deploy events for the change's commit. Each environment is tracked separately, with statuses Deploying, Monitoring, Verified, Deploy failed and Issues found. Checks run at deploy time, then at 20 minutes, 1 hour, 1 day and 3 days.
3. **Regressions.** When a signal goes wrong, Rollouts names the suspected change, opens an issue and notifies the author. This also covers the quieter failure mode where the new code runs but its intended effect is missing. The issue page has **Fix issue** (starts a cloud agent) and **Close** (asks for a reason: Fixed, Not a Real Issue, Expected, Duplicate or Other).

One line in the docs is worth repeating because it sets expectations: "Rollouts doesn't merge, revert, or roll back changes on its own." It detects and reports. The rollback decision stays with you or with whatever your CD system already does. The launch post mentions configurable responses such as pausing a progressive rollout or opening a revert PR that waits for approval, and feature flag integration is listed as coming soon.

## Step 1: enable Rollouts and choose what it watches

In Automations, **Team** tab, **From Cursor** section, select **Enable** on the Rollouts card. Only team admins can toggle it or set up deployment events. The setup has four steps: repository access, deployment events, telemetry, and notifications.

For **Repository access**, pick up to 200 repos. Each PR gets its own watch tied to its author. Supported hosts are Origin, GitHub, GitLab.com and Bitbucket Cloud. If you moved agent work off GitHub, as in [migrating a Cursor cloud agent workflow to Cursor Origin](/2026/09/migrate-a-cursor-cloud-agent-workflow-off-github-to-cursor-origin/), Rollouts works there too.

Under **Settings > Code access** there is a free-text field called **Which changes to monitor**. It is plain English, not a glob. The default skips docs-only, formatting, lint and typo changes with no behavior change, plus test-only changes. Clearing it monitors everything. Skipped PRs get a comment explaining why, and mentioning the Rollouts handle in that comment monitors the PR anyway.

If you want to start narrow, this field is where you do it. Something like the following is a reasonable first week on a busy repo:

```text
Skip docs-only, formatting, lint, typo and test-only changes with no behavior change.
Skip dependency bumps that only touch lockfiles.
Always monitor PRs opened by Cursor cloud agents or by automations, even if small.
```

Because this is interpreted by a model, check the skip comments on the first few dozen PRs to confirm it reads your rules the way you meant them.

## Step 2: report deployment events from CI

This is the part that actually needs code. Rollouts cannot check a deploy it never hears about, and it does not scrape your CD system. You report deploys through the `factory.v1.DeploymentsService` API, which speaks the Connect protocol over plain JSON.

Create an API key (a user key, a service account key, or a team Admin key with the `admin:*` scope) and store it as `CURSOR_API_KEY` in your CI secrets. For a deploy pipeline, a service account key is the sane choice: it does not break when someone leaves the team. If you would rather not write the calls by hand, the setup flow can have a setup agent open a PR that adds them, and you merge it to finish.

The flow has four calls. First, exchange the key for a short-lived token at the top of the deploy job:

```bash
# Cursor Rollouts deploy reporting, API as documented October 2026
TOKEN=$(curl -s -X POST https://api2.cursor.sh/auth/exchange_user_api_key \
  -H "Authorization: Bearer $CURSOR_API_KEY" -H "Content-Type: application/json" -d '{}' \
  | jq -r .accessToken)
```

Second, create your environments and services once. Run these by hand or as a bootstrap step; they only need to exist before the first report:

```bash
API=https://api.cursor.com/factory.v1.DeploymentsService
HDRS=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Connect-Protocol-Version: 1")

curl -s -X POST "$API/CreateEnvironment" "${HDRS[@]}" \
  -d '{"environmentId":"production","environment":{"displayName":"production"}}'

curl -s -X POST "$API/CreateService" "${HDRS[@]}" \
  -d '{"serviceId":"checkout-api","service":{"displayName":"checkout-api"}}'
```

Pick IDs that match how Datadog tags the same things. If your APM data uses `env:production` and `service:checkout-api`, name the Rollouts environment and service exactly that. Rollouts is going to look for signals for this service in this environment, and matching names remove a whole class of "inconclusive" results.

Third, create the deployment right before shipping. `deployVersion` is the commit SHA being shipped, and the response's `deployment.name` is what the last call needs:

```bash
DEPLOYMENT=$(curl -s -X POST "$API/CreateDeployment" "${HDRS[@]}" \
  -d '{"deployment":{"deploySourceUri":"https://github.com/acme/checkout","environment":"environments/production","service":"services/checkout-api","deployVersion":"'"$GIT_SHA"'"},"event":{"started":{},"actor":"'"$CI_JOB_URL"'"}}' \
  | jq -r .deployment.name)
```

Fourth, append the outcome once you know it. There are three event shapes:

```bash
# Succeeded
curl -s -X POST "$API/AppendDeploymentEvent" "${HDRS[@]}" \
  -d '{"name":"'"$DEPLOYMENT"'","event":{"completed":{"succeeded":{}},"actor":"'"$CI_JOB_URL"'"}}'

# Failed:    "event":{"completed":{"failed":{"message":"helm upgrade timed out"}},"actor":...}
# Cancelled: "event":{"aborted":{},"actor":...}
```

### The same thing as a GitHub Actions job

Here is how I wire it into an existing deploy job. The Cursor docs do not ship a workflow file, so this is my own composition of the documented calls. The important detail is that every reporting step uses `continue-on-error: true` and `|| true`. The docs say it plainly: a failed report must never fail the deploy.

```yaml
# .github/workflows/deploy.yml (GitHub Actions, ubuntu-24.04 runner ships curl and jq)
name: deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-24.04
    environment: production
    env:
      API: https://api.cursor.com/factory.v1.DeploymentsService
      GIT_SHA: ${{ github.sha }}
      CI_JOB_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    steps:
      - uses: actions/checkout@v4

      - name: Report deploy start to Cursor Rollouts
        id: rollouts_start
        continue-on-error: true
        env:
          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
        run: |
          TOKEN=$(curl -sf -X POST https://api2.cursor.sh/auth/exchange_user_api_key \
            -H "Authorization: Bearer $CURSOR_API_KEY" -H "Content-Type: application/json" -d '{}' \
            | jq -r .accessToken) || true
          echo "::add-mask::$TOKEN"
          echo "token=$TOKEN" >> "$GITHUB_OUTPUT"
          DEPLOYMENT=$(curl -sf -X POST "$API/CreateDeployment" \
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Connect-Protocol-Version: 1" \
            -d '{"deployment":{"deploySourceUri":"https://github.com/${{ github.repository }}","environment":"environments/production","service":"services/checkout-api","deployVersion":"'"$GIT_SHA"'"},"event":{"started":{},"actor":"'"$CI_JOB_URL"'"}}' \
            | jq -r .deployment.name) || true
          echo "deployment=$DEPLOYMENT" >> "$GITHUB_OUTPUT"

      - name: Deploy
        id: deploy
        run: ./scripts/deploy.sh production "$GIT_SHA"

      - name: Report deploy outcome to Cursor Rollouts
        if: always() && steps.rollouts_start.outputs.deployment != ''
        continue-on-error: true
        env:
          TOKEN: ${{ steps.rollouts_start.outputs.token }}
          DEPLOYMENT: ${{ steps.rollouts_start.outputs.deployment }}
          OUTCOME: ${{ steps.deploy.outcome }}
        run: |
          case "$OUTCOME" in
            success)   EVENT='{"completed":{"succeeded":{}}' ;;
            cancelled) EVENT='{"aborted":{}' ;;
            *)         EVENT='{"completed":{"failed":{"message":"deploy step '"$OUTCOME"'"}}' ;;
          esac
          curl -sf -X POST "$API/AppendDeploymentEvent" \
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Connect-Protocol-Version: 1" \
            -d '{"name":"'"$DEPLOYMENT"'","event":'"$EVENT"',"actor":"'"$CI_JOB_URL"'"}}' || true
```

Two notes on this job. The `if: always()` on the last step is what turns a failed or cancelled deploy into a `failed` or `aborted` event instead of silence. And if one job deploys several services, call `CreateDeployment` once per service; each deployment has exactly one `service` and one `environment`.

For a merged change that never got a recorded deployment (a manual hotfix, a deploy that happened before you wired this up), the Rollouts page has **Run checks**: choose the environment and services, start, and Rollouts treats that version as live there and checks it on the same schedule.

## Step 3: connect Datadog as the data source

Without telemetry, Rollouts has deploy events and nothing to compare them against. The docs are explicit: "Rollouts needs at least one connected tool. Without one, changes stay Pending and issues can't be detected." In Settings, **Data sources** are "the MCP connections used for verification and regression detection", so connecting Datadog means connecting the [Datadog MCP Server](https://docs.datadoghq.com/bits_ai/mcp_server/setup/).

Before you connect anything, sort out the Datadog side, because this is where setups quietly fail:

- **Org settings.** "MCP Access" must be enabled for the organization. Rollouts only needs to read, so leave "MCP Write Access" off unless something else needs it.
- **Role permissions.** The identity behind the connection needs `mcp_read` plus the normal read permission for each resource type (logs, APM, metrics, monitors). The Datadog Standard Role includes both MCP permissions by default; custom roles do not.
- **Site.** The endpoint depends on your Datadog site (US1, EU1, US5 and so on). Take it from the site selector on the setup page instead of guessing. The MCP Server is not available on the GovCloud sites.
- **Identity.** OAuth is the recommended path, but OAuth ties the connection to whoever clicked through. For a team-wide bot, a Service Access Token or a scoped API key plus application key from a Datadog service account is more durable. The Cursor [Automations docs](https://cursor.com/docs/cloud-agent/automations) make the same point from the other side: integrations that rely on personal OAuth credentials have to be reconfigured when an automation moves to a service account.

Toolsets decide what the connection can see. Without a `toolsets` parameter you get only `core`. The URL takes a comma-separated list, and `omit_tools` removes individual tools:

```json
{
  "mcpServers": {
    "datadog": {
      "type": "http",
      "url": "<YOUR_MCP_SERVER_ENDPOINT>?toolsets=core,apm,error-tracking",
      "headers": {
        "DD_API_KEY": "<service-account-api-key>",
        "DD_APPLICATION_KEY": "<scoped-application-key>"
      }
    }
  }
}
```

That is the generic remote-client shape from Datadog's docs (MCP over streamable HTTP). Cursor's Rollouts settings take the same endpoint and credentials through its own form, so treat the JSON as the checklist of values you need, not a file to commit. `apm` is a preview toolset, so it is not included in `toolsets=all` and has to be named. If you already manage team MCP servers centrally, the approach from [distributing team MCP config across Cursor cloud agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) keeps the Datadog endpoint consistent between Rollouts and the agents that fix its issues.

Do not confuse this with Datadog's [Cursor integration](https://docs.datadoghq.com/integrations/cursor/). That one goes the opposite direction: it pulls Cursor usage and spend into Datadog using a Cursor Admin API key. It has nothing to do with Rollouts reading your production telemetry.

## Step 4: notifications and the loop back to an agent

**Notifications** decide how authors hear about trouble. Personal Slack notifications start with **Issues found**; you can add Deployment succeeded, Deployment failed or Check clear. Delivery is by DM or to a public channel after inviting the app. Slack Connect channels are not supported, a team admin has to add Rollouts to Slack first, and Slack notifications are not available in Privacy Mode.

For agent-authored PRs, think about who "the author" is. The watch is tied to the PR author, so a cloud agent PR notifies whoever the agent opened it on behalf of. If that is a service account used by an automation, route that account's notifications to a team channel, or nobody gets paged.

When an issue opens, **Fix issue** starts a cloud agent with the finding, and **View fix** reopens it later. That gives you a full loop: an agent writes the change, Rollouts catches the regression with evidence from Datadog, and another agent drafts the fix PR, which Rollouts then watches like any other. Humans still approve the merges.

## Editing the rollout plan

The plan is the most underrated part. It is where Rollouts says which signals it will check, and where it flags instrumentation gaps such as "no metric shows whether the new retry path ever fires". That second list is worth reading on every agent PR, because it is the cheapest moment to ask the agent to add a counter or a span.

To revise a plan, mention the handle named in the Rollouts comment and say what to watch or ignore:

```text
@rollouts also watch p95 latency on POST /v2/checkout in eu-west-1,
and ignore the error-rate spike on /healthz during pod restarts.
```

Use the handle from your own Rollouts comment; I am showing the shape, not the exact name. Only users with write access to the repo can change plans, which is a deliberate guard against a drive-by comment telling the watcher to ignore errors.

## Gotchas that leave changes stuck or noisy

- **Everything sits in Pending.** No data source connected, or the Datadog connection lacks `mcp_read` or the resource permission. Check the org-level "MCP Access" setting first.
- **Deploys never appear.** `deployVersion` must be the commit SHA that maps back to the PR's merged commit. A squash merge creates a new SHA on `main`; report `github.sha` from the push to `main`, not the PR head SHA.
- **Inconclusive verdicts everywhere.** Usually a naming mismatch between Rollouts services and environments and the `service` and `env` tags in Datadog, or a toolset that cannot see the data (APM tools need `apm`).
- **The deploy broke because of reporting.** Some step is missing `continue-on-error` or `|| true`. Reporting is advisory.
- **One environment drowns the rest.** Each environment is tracked separately, so a noisy staging stack produces its own issues. Close them with **Expected** and a note; the reason is kept in the issue history.
- **Plan availability.** Teams and Enterprise only, up to 200 repos.

The Rollouts page groups merged PRs into Attention, Monitoring, Pending and Verified, with **Mine** and **Team** views. A change stays in Attention while it has an open issue or a failed deploy and becomes Verified once its issues are closed. If you are running the kind of always-on agent setup from [building a Cursor automation with GitHub triggers](/2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers/), the Team view filtered to Attention is the screen to keep open in the morning.

## Sources

- [Rollouts docs](https://cursor.com/docs/rollouts)
- [Rollouts and Security Review changelog, September 23, 2026](https://cursor.com/changelog/rollouts-and-security-reviewer)
- [Bots for the last mile: Rollouts, Security Review](https://cursor.com/blog/rollouts-and-security-reviewer)
- [Cursor Automations docs](https://cursor.com/docs/cloud-agent/automations)
- [Set up the Datadog MCP Server](https://docs.datadoghq.com/bits_ai/mcp_server/setup/)
- [Datadog Cursor integration](https://docs.datadoghq.com/integrations/cursor/)
