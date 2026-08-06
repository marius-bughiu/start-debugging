---
title: "Copilot Automations Now Trigger on Issue and PR Comments"
description: "GitHub's August 3, 2026 changelog adds a comment trigger to Copilot cloud agent automations, replacing the issue_comment workflow plus PAT plus REST dispatch that teams have been hand-rolling since June."
pubDate: 2026-08-06
tags:
  - "github-copilot"
  - "ai-agents"
  - "automation"
  - "ci-cd"
---

On August 3, 2026 GitHub shipped [Trigger Copilot automations with comments](https://github.blog/changelog/2026-08-03-trigger-copilot-automations-with-comments/). Copilot cloud agent automations can now fire when an issue comment or a pull request comment is created, matched against comment text you specify. It is a one-line changelog entry that deletes a surprising amount of YAML.

## The old trigger set was event-shaped, not conversation-shaped

Automations landed on June 2, 2026 with four triggers: on a schedule (hourly, daily, or weekly), when an issue is created, when a pull request is opened, and when a pull request is synchronized. Every one of those fires the moment something enters a state. None of them cover the pattern teams actually reach for, which is a human reading the thread first and then saying "go".

So you wrote the glue yourself. The shape was always the same: an `issue_comment` workflow, a string guard, a token, and a `POST` to the [Agent Tasks REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/).

```yaml
name: copilot-on-comment
on:
  issue_comment:
    types: [created]

jobs:
  dispatch:
    if: startsWith(github.event.comment.body, '/copilot fix')
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch an agent task
        env:
          GH_USER_TOKEN: ${{ secrets.COPILOT_USER_TOKEN }}
        run: |
          curl -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            -H "Authorization: Bearer $GH_USER_TOKEN" \
            https://api.github.com/agents/repos/${{ github.repository }}/tasks \
            -d '{
              "prompt": "Investigate the stack trace in issue #${{ github.event.issue.number }} and open a fix PR.",
              "base_ref": "main",
              "create_pull_request": true
            }'
```

Every line there is a maintenance surface. `secrets.COPILOT_USER_TOKEN` has to be a user-to-server token because the built-in `GITHUB_TOKEN` will not dispatch agent tasks, and it expires on somebody's calendar. The guard is a raw prefix match, so `/copilot fixup` triggers it too. `X-GitHub-Api-Version: 2026-03-10` pins a public preview whose response shape can move. And because the trigger phrase lives in a file, changing it is a pull request.

## What the configuration looks like instead

Open the **Agents** tab in the repository, pick **Automations** in the sidebar, and click **Create new**. An automation is a name, a prompt, one or more triggers, an optional model, and a set of tools. With the new trigger you say which comment text should start it, and that is the whole integration. No token, no workflow file, no API version header.

The tools list is where the real thinking goes. It is the permission boundary for the run, not a convenience setting: it decides what the agent can touch once a comment wakes it up. The **Suggest tools** button will propose a set from your prompt, but treat that as a starting point and cut it down to what the task actually needs.

## Constraints to check before you plan around it

Automations require a **private or internal** repository. They are not available in public repos, so an open source project cannot use this to triage drive-by issues. You need write access to create one, the plan has to be Copilot Pro, Pro+, Max, Business, or Enterprise, and on Business and Enterprise an administrator has to enable the cloud agent policy first. **Run now** lets you test an automation before a real comment fires it.

One consequence is worth sitting with. Before this, dispatching an agent needed a token that a maintainer deliberately provisioned. Now anyone who can comment on an issue in the repo can spend agent time. Private and internal visibility bounds the blast radius, but keep the trigger phrase specific and keep the tool list narrow.
