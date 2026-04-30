---
title: "Claude Code 2.1.122 Lets You Pick a Bedrock Service Tier From an Env Var"
description: "Claude Code v2.1.122 adds the ANTHROPIC_BEDROCK_SERVICE_TIER environment variable, sent as the X-Amzn-Bedrock-Service-Tier header. Set it to flex for a 50 percent discount on agent calls or priority for faster responses, without touching SDK code."
pubDate: 2026-04-30
tags:
  - "claude-code"
  - "ai-agents"
  - "aws-bedrock"
  - "dotnet"
---

The Claude Code v2.1.122 release on April 28, 2026 added a one-line knob that anyone running the agent on AWS Bedrock has been quietly waiting for: a new `ANTHROPIC_BEDROCK_SERVICE_TIER` environment variable that selects the Bedrock service tier on every request. Set it to `default`, `flex`, or `priority`, and the CLI forwards the value as the `X-Amzn-Bedrock-Service-Tier` header. No SDK code changes. No JSON config edits. One env var.

## Why this matters even before you read the rest

AWS introduced the Priority and Flex inference tiers for Bedrock in November 2025 as a way to trade latency for cost. Per the [Bedrock service-tiers page](https://aws.amazon.com/bedrock/service-tiers/), Flex is a 50 percent discount versus Standard pricing in exchange for "increased latency", and Priority is a 75 percent premium that jumps your requests to the front of the queue. For an agent like Claude Code that fires off long sequences of tool-use turns over the course of a session, the math is loud. A long evergreen task that ran on default could cost half as much on Flex if you can absorb the extra wall-clock time, and a debugging session where you are babysitting the terminal could feel snappier on Priority.

Until v2.1.122, the only way to pick a tier with Claude Code on Bedrock was to wrap the request layer yourself or proxy through something that could inject the header. The [feature request issue](https://github.com/anthropics/claude-code/issues/16329) that landed in this release closes that gap.

## The actual usage

```bash
# Cheap background agents that triage issues overnight
export ANTHROPIC_BEDROCK_SERVICE_TIER=flex
claude --from-pr https://github.acme.internal/acme/api/pull/482

# Interactive debug session, paying for speed
export ANTHROPIC_BEDROCK_SERVICE_TIER=priority
claude
```

The CLI ships the value verbatim as `X-Amzn-Bedrock-Service-Tier` on the InvokeModel request, which is the same plumbing CloudTrail and CloudWatch already record under `ServiceTier` and `ResolvedServiceTier`. So if your platform team has dashboards on Bedrock spend by tier, the Claude Code traffic now lands in the right bucket without any extra work.

## Watch out for ResolvedServiceTier

The header is a request, not a guarantee. AWS returns the tier it actually served you in `ResolvedServiceTier`, and Flex requests can be downgraded if the model's flex pool is saturated. The full list of which models support Priority and Flex is on the [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/), and it lags the latest model launches by weeks, so confirm the model ID you are running with Claude Code is on it before you bake `flex` into a CI job. If a tier is unsupported, AWS falls back to the default tier transparently and bills you accordingly.

The `ANTHROPIC_BEDROCK_SERVICE_TIER` line is buried mid-changelog, but it is the cheapest cost lever on Bedrock-hosted Claude Code right now. Full notes are in the [Claude Code v2.1.122 release page](https://github.com/anthropics/claude-code/releases).
