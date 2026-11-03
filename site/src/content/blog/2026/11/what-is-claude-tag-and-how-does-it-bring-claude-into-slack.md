---
title: "What Is Claude Tag and How Does It Bring Claude Into Slack"
description: "Claude Tag is Anthropic's shared Slack agent: one org-owned identity per channel scope, with channel memory, admin-granted connectors, a GitHub App for draft PRs, and a monthly spend limit. Here is what it is, how setup and pairing work, how it differs from the old Claude in Slack and Claude Code in Slack apps, and the data-retention and billing details to check before you turn it on."
pubDate: 2026-11-03
tags:
  - "claude-code"
  - "ai-agents"
  - "anthropic"
  - "slack"
  - "agent-identity"
---

**Short answer:** Claude Tag is Anthropic's team agent for Slack, announced on June 23, 2026 and still in public beta as of November 2026. Instead of every person linking their own claude.ai account, an Owner pairs the Slack workspace once and Claude joins channels as a single org-owned teammate: anyone in a channel can `@Claude` a thread, the work runs in an ephemeral cloud sandbox, it remembers context per channel, it reaches tools only through connectors an admin grants to Claude's own identity, and channel work bills to an organization usage balance capped by a monthly spend limit. It is limited to Team and Enterprise plans on Anthropic's first-party service, it replaced the per-user Claude in Slack and Claude Code in Slack apps, and at launch it ran on Opus 4.8 (the current docs let admins pick an Opus or Sonnet model, for example Claude Opus 5.5).

Everything below comes from Anthropic's [launch post](https://www.anthropic.com/news/introducing-claude-tag) and the [Claude Tag docs](https://claude.com/docs/claude-tag) as published on 2026-11-03. Nothing here was run against a live Slack workspace, so treat UI labels as "what the docs say today" in a beta that explicitly warns features "may change before general availability."

## Why a shared agent is a different thing from a Slack bot

The earlier Claude in Slack app was effectively a personal assistant that happened to live in Slack. Each user connected their own claude.ai account, each request spawned a fresh session, nothing was remembered between requests, and any tool access came from that individual's connectors. If three people in `#payments-oncall` asked about the same incident, Claude saw three unrelated conversations.

Claude Tag inverts that model. The [migration guide](https://claude.com/docs/claude-tag/admins/migrate-from-earlier) summarises the shift in four lines:

| | Claude in Slack / Claude Code in Slack (legacy) | Claude Tag |
| --- | --- | --- |
| Identity | Each user's own claude.ai account | One agent identity with org-level service credentials |
| Session | Spawned per request | One persistent session per thread, shared with the channel |
| Memory | None | Per-channel memory |
| Setup | Every user sets it up | An Owner sets it up once |

That last row is the important one for a team lead. Claude stops being "my assistant that I invited into a channel" and becomes a teammate whose permissions are decided by an admin, whose memory belongs to the channel, and whose actions show up in GitHub as the Claude GitHub App rather than as whoever typed the mention. Anthropic frames the product as making AI "multiplayer", and claims in the launch post that 65% of its own product team's code is created by an internal version of Claude Tag. That is a vendor number with no methodology attached, so read it as intent rather than a benchmark.

## What a request actually looks like

From a member's point of view the interface is small. You add Claude to a channel, mention it, and the work happens in a thread:

```text
# Slack, channel message box (not inside a thread). Claude Tag public beta, Nov 2026
/invite @Claude

@Claude summarize what this channel decided this week about the retry policy

@Claude the checkout test in CI has been flaky since Monday, find the cause and open a draft PR
```

A few behaviours from the [getting-started page](https://www.claude.com/docs/claude-tag/users/getting-started) are worth knowing up front:

- An `@Claude` mention guarantees a response in a channel. Once Claude is in a thread, it reads every reply in that thread, so follow-ups do not need another mention.
- Tasks run in the cloud, so closing Slack does not stop them. To cancel, select **Stop** on the working indicator in the thread.
- Every reply carries a footer naming the model that handled it, plus a **Configure** link.
- Control commands start with `!`: `!help`, `!mute`, `!unmute`, `!restart`, and `!fast` (fast mode, Opus models only, enabled by an Owner).
- You can switch models for one thread in plain language, for example `@Claude switch to Claude Opus 5.5 for the rest of this thread.`
- Attachments are capped at roughly 3.75 MB for images, 5 MB for PDFs, 100 MB for other files, and five files per message.

DMs behave differently, and this trips people up. A one-to-one DM runs on the member's own claude.ai account with their own connectors and bills to their own seat. Channel and group-DM work runs as Claude's org identity and bills to the organization. Same `@Claude` handle, two different identities.

## Setting it up as an Owner

Setup lives at `claude.ai/admin-settings/claude-tag` and requires the Owner role. The [setup overview](https://www.claude.com/docs/claude-tag/admins/setup-overview) walks through a four-step wizard behind a **Start setup** button:

1. **Pair your Slack workspace.** Install the Claude app from the Slack Marketplace (**Add to Slack**), invite it to a channel, and send `@Claude connect` with no other text. Claude replies with a pairing code you paste into **Paste the pairing code**, then click **Pair workspace**. Only a Slack workspace admin can run `@Claude connect`, and codes expire after 15 minutes. On Enterprise Grid you get codes prefixed `workspace_` and `enterprise_`; paste the `enterprise_` one.
2. **Connect GitHub.** Shown only if the Claude GitHub App is not installed yet. Only an owner of the GitHub organization can install it. You can skip this and come back.
3. **Buy usage credits.** Shown for Team and self-serve Enterprise orgs paying by card without credits.
4. **Launch Claude Tag.** Pick a monthly spend limit, choose which public channels Claude joins, decide whether to leave **Let members know they can now tag Claude** on (it DMs every member), then click **Launch Claude Tag**.

There is one prerequisite that fails silently if you miss it: routines must be enabled under **Admin settings > Capabilities > Remote sessions > Routines**. The docs are blunt that without it Claude "does no work." Claude Tag runs on the same remote-session infrastructure as Claude Code's cloud sessions, which is also why, as covered in the post on [running Claude Code cloud sessions on your own hosts](/2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts/), Claude Tag sessions cannot be routed to a self-hosted environment yet.

To verify, mention Claude with a low-stakes request like the summary prompt above. The setup is considered working when a thread reply appears with the model footer and the **Configure** link.

## How Claude reaches your tools without holding your keys

This is the part that makes Claude Tag more than a chat window. Tool access is configured under **Claude's access** on the Claude Tag admin page, which has four tabs: **Bundles**, **Connectors**, **Skills and plugins**, and **Channels**.

The [connections guide](https://claude.com/docs/claude-tag/admins/add-connections) recommends creating a dedicated account for Claude in each service, for example a `claude@yourcompany.example.com` user in Jira or Sentry, because "connectors belong to the agent identity, not to any person." When someone leaves the company, nothing that Claude Tag depends on breaks.

Connectors come in two shapes. Named services (Google Drive, Notion, Confluence, GitHub, GitLab, BigQuery, Snowflake, Sentry, Datadog, PagerDuty, Linear, Jira, Salesforce, and others) are picked from **Add a connector**. Anything else goes through **Custom connector**, which accepts these credential types:

```text
# Claude Tag custom connector credential types (docs, Nov 2026)
Bearer
Basic
Body parameter
AWS SigV4
GCP access token (with Service Account Key)
GCP IAP (with Service Account Key)
OAuth 2.0 JWT bearer
OAuth 2.0 client credentials
MCP Connector          # remote MCP server, admin signs in once
```

The credential is not handed to the model. An "Agent Proxy" injects it at the network boundary, and the docs state that "the model and the sandbox are not given the key." This is the same pattern described in [keeping API keys out of a coding agent's context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/), productised: the sandbox makes a request to an allowed host, the proxy adds the header, and a prompt-injected agent has no secret to exfiltrate.

Each connector has an **Allowed websites** list and a **Restrict by path or method** control. The default for a domain is **Read-only**, which means `GET`, `HEAD`, and `OPTIONS`. If you want Claude to create Jira issues or post to an internal API, you have to widen that deliberately. Wildcards are accepted only as the leftmost label (`*.internal.example.com`), and `*` on its own allows every host, which the docs explicitly discourage.

**Bundles** are how you avoid configuring the same thing twenty times. A bundle is "a named set of connectors, repositories, domain entries, plugins, and instructions" that you attach to the workspace or to specific channels under **Where it applies**. A typical split is one bundle for engineering channels (GitHub repos, Sentry, the internal package registry) and another for go-to-market channels (HubSpot, Gong, Drive), so the sales channel's Claude cannot touch production repos.

## Coding work: draft PRs from a channel

For developers, the headline use case in the docs is "a bug reported in the channel comes back as a draft pull request." That requires the Claude GitHub App and an explicit list of granted repositories. Work runs in an ephemeral sandbox that is discarded when idle, GitHub calls go through a separate proxy limited to those repositories, and commits and PRs are authored by the Claude GitHub App, not by the person who asked.

That authorship detail matters for branch protection and audit. Your required-reviewer rules apply normally, but "who wrote this" in GitHub is the app, and the human trail lives in the Slack thread. If you already gate agent PRs with an automated reviewer, as in [running Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/), Claude Tag's draft PRs flow into the same pipeline.

The **Skills and plugins** tab lets you attach plugins the same way Claude Code does. One example from the docs: the **Security Guidance** plugin is off by default and, when on, advises rather than blocks: it "doesn't block a commit or a push."

## Channels are scopes, and memory belongs to them

Every channel is a scope. Settings cascade from **Slack** (org-wide) to workspace to channel, and "a workspace or channel inherits what's set above it." The setup guide describes this as "creating separate Claude identities for different uses": memory, bundles, and routines stay inside the channels an admin defines.

[Channel memory](https://claude.com/docs/claude-tag/users/memory) is organised by channel, not by person. Anyone in the channel can read and change it:

```text
# Slack thread in #payments-oncall. Claude Tag public beta, Nov 2026
@Claude remember for this channel: staging deploys freeze at 16:00 UTC on Fridays
@Claude what do you remember about this channel?
```

Notes saved in public channels become workspace notes that are readable everywhere in the workspace, including (read-only) private channels. Group DMs keep separate memory. Claude can look back at past sessions but "can't full-text search across them," so durable facts belong in explicit memory, not in the hope that Claude rereads last month's threads. Owners can inspect and edit the underlying files via **View memory files**.

The access controls that matter most for a first rollout:

- **Respond in all channels**: turn it off, then enable **Enable Claude Tag in this channel** only where you want it. This is the safest way to pilot.
- **Channels Claude can search**: **All public channels** (default) or **Only channels Claude is in**. The default lets Claude pull context from public channels it has not joined.
- **How should Claude work in channels with guests**: **Restrict** (default), **Channel only**, **Full access**, or **Inherit**. Only Owners can pick **Full access**. Slack Connect channels are capped at channel-only.
- **Restrict to your organization** (Team) or **Restrict to roles with Claude Tag access** (Enterprise): off by default, so out of the box any member can hand Claude work.
- **Blocked channel patterns** and **Auto-join channels** accept `*` and `?` wildcards, up to 50 patterns, which is how you keep Claude out of `#legal-*` or auto-join every `#team-*`.

## What it costs and how the cap behaves

Channel work draws from the organization's usage balance and is capped by a monthly spend limit set at `claude.ai/admin-settings/usage/claude-tag`. The launch step offers **$500**, **$1,000**, **$2,500** (preselected), **$5,000**, **Unlimited**, or **Custom** up to $1,000,000, and the limit resets at the start of each month. On Team plans the limit is required before anything runs; on invoiced Enterprise it is recommended. Adding Claude to Slack does not add a per-seat charge on Team plans, and eligible orgs got an introductory launch credit.

Claude posts warnings in-thread at 75% and 90% of the limit. At 100%, "Claude stops and tells the requester in the thread that it couldn't finish." There are also per-channel limits and a **Default spend limit**, but per the [restrictions page](https://claude.com/docs/claude-tag/admins/restrict-access), there is no per-user cap on channel work. If one enthusiastic engineer kicks off a dozen long refactors, they spend the channel's budget, not their own. Anthropic does not publish a per-task cost estimate, so watch the **Engaged**, **Proactive**, and **Scheduled** breakdown at `claude.ai/analytics/claude-tag` for the first few weeks before raising the cap.

## Who cannot use it, and the retention caveat

Claude Tag is not available on Free, Pro, Max, or Ultra plans, or through third-party cloud deployments such as Amazon Bedrock. It is also blocked for organizations with Zero Data Retention, customer-managed encryption keys, or the HIPAA configuration for local-mode Claude Code and Cowork, because "Claude Tag stores channel memory and session transcripts, which ZDR doesn't permit."

The [data lifecycle page](https://claude.com/docs/claude-tag/concepts/data-lifecycle) has the detail compliance teams will ask about:

- "During the beta there is no automatic retention period for Claude Tag data." Transcripts and memory are kept until you delete them.
- Your organization's custom data retention setting does not apply to Claude Tag transcripts or memory.
- Claude Tag data is not included in data exports, and the Compliance API does not list or delete Claude Tag sessions.
- Deletion is explicit: **Remove this scope** wipes a channel's sessions, memory, routines, and artifacts; **Disconnect** on a workspace, or uninstalling the app, deletes all of that workspace's data. Those admin actions are audit-logged; deletions on the Slack side are not.

If your retention policy says chat transcripts expire after 90 days, Claude Tag does not enforce that for you during the beta. Plan a manual process or wait for GA.

## Where it sits next to Claude Code, Cowork, and Copilot

Anthropic's own split is simple: "team work in shared channels is Claude Tag; personal work on your own files is Cowork or Claude Code." Claude Code is still the tool when you want an agent in your terminal against your checkout, and Cowork is the desktop agent for personal files (the [Cowork terminal MCP post](/2026/04/cowork-terminal-mcp-host-terminal-access-for-claude-cowork/) covers one way to extend it). Claude Tag is for the request that starts in a conversation between several people and should end with an artifact everyone can see.

GitHub shipped a similar idea for Copilot, covered in [running shared agentic work with GitHub Copilot in Slack](/2026/09/run-shared-agentic-work-with-github-copilot-in-slack/). The difference is in the identity model: Claude Tag's org-owned agent with its own service accounts, credential proxy, and per-channel memory is a heavier, more admin-driven setup, which is the point if you want a security team to be able to answer "what can the Slack bot touch?" with a list instead of a shrug.

The launch post says Anthropic wants teams to be able to tag Claude "in the many other places they work," but as of November 2026 the docs describe Slack only. If you are on Team or Enterprise, the low-risk way in is a single pilot channel: **Respond in all channels** off, a narrow bundle with read-only connectors, **Only channels Claude is in** for search, and a spend limit you would not mind losing.

## Sources

- [Introducing Claude Tag](https://www.anthropic.com/news/introducing-claude-tag), Anthropic, June 23, 2026
- [Claude Tag overview](https://claude.com/docs/claude-tag)
- [Getting started (users)](https://www.claude.com/docs/claude-tag/users/getting-started)
- [Setup overview (admins)](https://www.claude.com/docs/claude-tag/admins/setup-overview)
- [Add connections](https://claude.com/docs/claude-tag/admins/add-connections)
- [Restrict access](https://claude.com/docs/claude-tag/admins/restrict-access)
- [Set a spend limit](https://claude.com/docs/claude-tag/admins/set-spend-limit)
- [Memory](https://claude.com/docs/claude-tag/users/memory)
- [Models](https://claude.com/docs/claude-tag/users/models)
- [Migrate from earlier versions](https://claude.com/docs/claude-tag/admins/migrate-from-earlier)
- [Data lifecycle](https://claude.com/docs/claude-tag/concepts/data-lifecycle)
