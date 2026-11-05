---
title: "GitHub Actions blocks pull_request_target by default on December 2: what public .NET repos must check"
description: "Starting December 2, 2026, GitHub Actions blocks pull_request_target events in all public repositories unless an Actions event policy allows them. Brownouts hit on November 9 and 16. Here is how to find affected workflows and either migrate to pull_request or opt back in."
pubDate: 2026-11-05
tags:
  - "github-actions"
  - "ci"
  - "security"
  - "dotnet"
---

On November 2, 2026 GitHub [announced](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2) that starting **December 2, 2026**, GitHub Actions will block `pull_request_target` events by default in every public repository, unless an applicable Actions event policy explicitly allows them. Private and internal repositories are not affected. The change applies to GitHub Free, Team, and Enterprise Cloud, not GitHub Enterprise Server.

If you maintain an open-source .NET library, check now. The first enforcement test comes before December.

## The brownout schedule

GitHub is rolling this out with two brownouts, each from 16:00 to 18:00 UTC:

- **November 9, 2026**
- **November 16, 2026**

During a brownout, blocked workflows create failed runs with an error annotation and do not execute. Between brownouts the default rule goes back to evaluate mode, where workflows still run but with warnings. Permanent enforcement starts on December 2.

That makes Monday, November 9 the first day your auto-labeler, "first-time contributor" greeter, or fork benchmark bot can fail.

## Why GitHub is doing this

`pull_request_target` runs in the context of the base branch, with repository secrets and a `GITHUB_TOKEN` that can have write scopes, even for PRs from forks. That makes sense for labeling or commenting. It becomes a "pwn request" the moment the workflow checks out and runs the fork's code:

```yaml
# The classic mistake: secrets plus untrusted code
on: pull_request_target
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: dotnet test   # runs MSBuild targets from the fork, with secrets in reach
```

For a .NET repo the risk is concrete. `dotnet build` evaluates `Directory.Build.props`, `.targets` files, and source generators from the checked-out tree, so a malicious PR can run arbitrary code with no change to any `.cs` file. We covered the same trap for AI review bots in [how to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/).

## Migrate to pull_request where you can

GitHub's [secure usage guide](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target) asks you a simple question: can you use `pull_request` instead? If the job does not need secrets, the fix is a one-line change:

```yaml
on: pull_request
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: "10.0.x"
      - run: dotnet test --configuration Release
```

Fork PRs then run without secrets and with a read-only token, which is what a build-and-test job should get anyway.

Two more details from the docs. `pull_request_target` runs only get read-only access to the default-branch cache scope, so save NuGet caches from a trusted trigger such as `push`. And `actions/checkout` now has an `allow-unsafe-pr-checkout: true` input for checking out fork head refs. Use it only if that code is never executed.

## Opting back in

If a workflow really needs `pull_request_target` (for example, a labeler that writes to the PR), no YAML key turns it back on. You allow it through an Actions event policy:

- **Repository or organization**: Settings, then under Actions click **Policies**.
- **Enterprise**: the **Policies** tab, then **Actions**, then **Policies**.

Use workflow file targeting to allow only the specific workflows that need it, not the whole event. The **Policy insights** page under the same Actions policies section lists runs that were blocked, or would have been, so you can find affected workflows before the November 9 brownout. Policies can also be managed through the [Actions policies REST API](https://docs.github.com/en/rest/actions/policies).

The fastest audit is a repository search for `pull_request_target` in `.github/workflows/`. For each hit, either switch it to `pull_request` or allow-list that one file before Monday.
