---
title: "December 2026 on GitHub: six Copilot models and ARM32 Actions jobs go away"
description: "GitHub deprecates six Copilot models, including Claude Fable 5 and Claude Haiku 4.5, on December 14, 2026, and hosted Actions runners stop executing ARM32 jobs by December 8. What each change touches and how a .NET repo can check itself."
pubDate: 2026-11-16
tags:
  - "github-copilot"
  - "github-actions"
  - "ci"
  - "dotnet"
---

GitHub posted two retirement notices on November 12 and 13, 2026, and both take effect within a week of the [`pull_request_target` default change on December 2](/2026/11/github-actions-blocks-pull-request-target-by-default-december-2/). Neither one breaks anything today. Both can quietly break a workflow or a team default next month if nobody checks.

## Six Copilot models leave on December 14

The [November 13 changelog entry](https://github.blog/changelog/2026-11-13-upcoming-deprecation-of-selected-github-copilot-models-in-december) deprecates these models on **December 14, 2026**. The removal covers Copilot Chat, inline edits, ask and agent modes, and code completions:

| Deprecated model | Suggested replacement |
|---|---|
| Claude Fable 5 | Claude Fable 5.2 |
| Claude Haiku 4.5 | Claude Haiku 5.5 |
| Gemini 3.8 Flash | Gemini 4 Hydrogen |
| Gemini 4 Argon | Gemini 4 Carbon |
| Grok 4.6 | Grok 4.7 |
| Kimi K3 | To be announced |

There is one exception. Claude Haiku 4.5 stays available to individual Copilot subscribers on annual plans.

On Copilot Business and Enterprise, the replacements are enabled automatically **unless** an administrator turned off the global default or explicitly disabled that model. If your organization locks model policies down, someone has to enable Claude Fable 5.2, Claude Haiku 5.5 and the rest under the model policies in Copilot settings before December 14. Otherwise developers lose the model and get nothing in the picker to replace it. Kimi K3 has no named successor yet, so teams that standardized on it need a fallback of their own.

The deprecated models disappear from the selector without any action on your side. Pinned references in scripts, prompt files, agent configs or CI steps don't disappear, though. GitHub publishes only display names, not model IDs, so search loosely:

```bash
# Run from the repo root. Patterns are loose on purpose: GitHub lists
# display names only, and IDs vary between Copilot surfaces.
grep -rniE "fable[- ]?5([^.0-9]|$)|haiku[- ]?4\.?5|gemini[- ]?3\.8[- ]?flash|gemini[- ]?4[- ]?argon|grok[- ]?4\.6|kimi[- ]?k3" \
  .github/ .vscode/ *.md 2>/dev/null
```

Every hit is a place that will either fail or fall back to a default you never chose.

## Hosted runners stop running ARM32 jobs by December 8

The [November 12 entry](https://github.blog/changelog/2026-11-12-actions-for-arm32-linux-windows-retirement) is short: GitHub-hosted runners end support for ARM32 job execution on Linux and Windows by **December 8, 2026**, including native AArch32 user-space execution. It follows the [Node 20 removal from September](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/). Actions now run on Node 24, which does not officially support ARM32, and that post already said self-hosted runners on unsupported architectures are no longer supported.

The notice doesn't list affected runner labels, and it doesn't say what happens to `arm32v7` containers. Treat any job that *executes* 32-bit ARM code on a hosted runner as at risk.

For .NET this is mostly a non-issue as long as you build for `linux-arm` instead of building *on* it. The SDK cross-targets the RID from an x64 or arm64 runner without running any ARM32 code:

```yaml
jobs:
  publish-arm32:
    runs-on: ubuntu-latest   # x64, no ARM32 execution needed
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: "10.0.x"
      - run: dotnet publish src/Device.Agent -c Release -r linux-arm --self-contained
```

What does need attention is running tests for that RID on a hosted runner, whether natively or through an `arm32v7` container. Move those to a self-hosted ARMv7 device you control, or accept arm64 test coverage plus a smoke test on real hardware. Native AOT for `linux-arm` still needs a matching cross toolchain, so check how your pipeline gets one before December 8.

Three dates now line up: December 2 for `pull_request_target`, December 8 for ARM32 runners and December 14 for Copilot models. One grep over `.github/` this week covers all three.
