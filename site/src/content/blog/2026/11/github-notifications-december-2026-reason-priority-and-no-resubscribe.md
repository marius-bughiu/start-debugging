---
title: "GitHub notifications change on December 1, 2026: no more silent resubscribes, and reasons are ranked"
description: "Starting December 1, 2026, GitHub.com stops resubscribing you to threads after routine activity, fixes team-mention notifications, and picks the notification reason by priority instead of recency. Here is what breaks for filters and scripts."
pubDate: 2026-11-26
tags:
  - "github"
  - "developer-tools"
  - "automation"
---

GitHub posted [More predictable notifications on GitHub.com](https://github.blog/changelog/2026-11-24-more-predictable-notifications-on-github-com) on November 24, 2026. The rollout starts December 1, 2026 and migrates accounts over about a week, so two people on the same team can see different behavior for a few days. GitHub Enterprise Server is not affected, and your settings, watched repositories and custom thread subscriptions are left alone.

Most of the change is a quality-of-life fix. One part, the notification reason, can quietly break mail rules and scripts.

## Unsubscribe now means unsubscribe

Today, if you unsubscribe from a busy pull request and then leave a comment, submit a review, close it, or touch it through the merge queue, GitHub puts you right back on the thread. After the migration those actions leave you unsubscribed. Only three things still resubscribe you: being mentioned, being assigned, or getting a review request.

Two related fixes:

- Removing an `@mention` no longer stops notifications if you are still on the thread for another reason, such as having commented or being assigned.
- [github.com/notifications/subscriptions](https://github.com/notifications/subscriptions) will list only threads you subscribed to manually. Threads you follow because you authored, commented, were assigned, mentioned or asked to review are managed from the inbox, which is also where bulk unsubscribe lives.

## Team mentions follow team membership

Before, a team mention kept notifying you after the mention was edited out or after you left the team, while someone joining the team later got nothing. Now removing the mention or leaving the team stops future notifications from that mention, and joining the team turns them on for threads where the team was already mentioned. GitHub says plainly that you "may receive fewer notifications."

## The reason is chosen by priority, not recency

This is the part to check if you automate triage. The reason shown in the inbox and in the email footer used to reflect the most recent activity. It now follows a fixed priority order:

`mention` > `team_mention` > `assign` > `review_requested` > `comment` > `manual` > `author` > `state_change` > `subscribed`

For issues, `assign` ranks highest. So an issue where you are assigned and mentioned now shows as "assign", and a filter that routes "mention" mail to a high-priority folder will miss it. Email headers will carry all applicable reasons (for example both "mention" and "subscribed"), so header-based rules should match on any listed reason rather than on an exact single value. Security advisory comments that `@mention` a team now report "team mention" instead of "commented".

The changelog only names the inbox and email footer, not the REST API. If you have scripts that read the `reason` field from the [notifications API](https://docs.github.com/rest/activity/notifications), it is worth snapshotting what you get today so you can compare after your account migrates:

```bash
# Count unread notifications by reason (GitHub CLI 2.x + jq)
gh api notifications --paginate \
  --jq '.[] | .reason' | sort | uniq -c | sort -rn

# List threads currently flagged as mentions
gh api notifications --paginate \
  --jq '.[] | select(.reason == "mention" or .reason == "team_mention")
        | "\(.repository.full_name)  \(.subject.type)  \(.subject.title)"'
```

If a rule depends on `reason == "mention"` for issues, add `assign` to the match, or key off the issue assignee directly instead of the notification reason.

## What to do before December 1

Nothing is required, but three checks save surprises: review mail rules that match on a single reason, stop relying on the Subscriptions page as a full list of what you follow, and tell your team that unsubscribing from a noisy pull request will finally stick. Feedback goes to the [community discussion](https://github.com/orgs/community/discussions/213452). For another recent GitHub workflow change, see [gh event listen for pull request reviews and CI](/2026/11/gh-event-listen-wait-for-pull-request-reviews-and-ci-without-polling/).
