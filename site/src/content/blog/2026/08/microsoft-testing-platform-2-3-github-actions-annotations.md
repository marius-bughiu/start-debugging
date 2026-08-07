---
title: "Microsoft.Testing.Platform 2.3: --report-gh Puts Test Failures on the PR Diff"
description: "The .NET blog's August 6, 2026 post on MTP reporting surfaces a batch of extensions that went stable in Microsoft.Testing.Platform 2.3.0: GitHub Actions annotations, crash-resilient TRX streaming, and Azure DevOps flaky history."
pubDate: 2026-08-07
tags:
  - "dotnet"
  - "testing"
  - "ci-cd"
  - "github-actions"
  - "msbuild"
---

On August 6, 2026 the .NET blog published [Test reporting in Microsoft.Testing.Platform: from red build to root cause](https://devblogs.microsoft.com/dotnet/microsoft-testing-platform-reporting/). The news is not the article itself, it is how much of the reporting story landed quietly in Microsoft.Testing.Platform 2.3.0 (July 7, 2026, latest patch 2.3.3 on July 28, 2026) and is still off by default in most repos.

## A red job should not mean scrolling the log

Out of the box, a failing MTP run on a GitHub runner gives you a non-zero exit code and a wall of console text. The new `Microsoft.Testing.Extensions.GitHubActionsReport` package plus the `--report-gh` switch changes what the runner does with that data: per-assembly log groups, `::error` annotations that land in the pull request **Files changed** gutter when the source location resolves, a Markdown job summary appended to `GITHUB_STEP_SUMMARY`, and `::notice` slow-test entries.

The extension is inert unless the `GITHUB_ACTIONS` environment variable is `true`, so a local `dotnet test` is unaffected. Each sub-feature is on by default once `--report-gh` is set and can be switched off individually:

```yaml
- name: Test
  run: dotnet test -- --report-gh --report-gh-slow-test-threshold 30s --report-trx
```

The threshold accepts a bare number of seconds or a suffixed value such as `90s`, `2m`, or `1.5h`. The default is `60s`.

## Wiring it repo-wide instead of per-invocation

Two ways to avoid pasting flags into every workflow step. Pull the whole Microsoft extension set into every test project from `Directory.Build.props`:

```xml
<PropertyGroup>
  <TestingExtensionsProfile>AllMicrosoft</TestingExtensionsProfile>
</PropertyGroup>
```

Then set the options declaratively in `testconfig.json` next to the test project:

```json
{
  "commandLineOptions": {
    "report-trx": true,
    "report-html": true,
    "report-azdo": true,
    "report-azdo-flaky-history": 14
  }
}
```

With `Microsoft.Testing.Platform.MSBuild` in the graph (it comes transitively with the MSTest, NUnit, and xUnit runners), the report providers auto-register on package install. Manual `builder.AddGitHubActionsProvider()` calls are only needed if you set `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>`.

## TRX that survives a dead test host

The change I would ship first is not a flag at all. As of MTP 2.3.0, TRX results stream to disk as the run progresses, so a test host that crashes mid-suite still leaves a TRX containing everything collected before the crash. Previously that scenario produced an empty results directory and a CI failure with nothing to read, the same dead end that makes people [reach for a binlog MCP server to triage builds](/2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures/).

The default TRX name also became deterministic in 2.3.0: `{asm}_{tfm}_{arch}.trx` instead of `<UserName>_<MachineName>_<timestamp>.trx`. That alone fixes a class of brittle artifact-upload globs.

## Separating regressions from flakes on Azure DevOps

On the Azure DevOps side, `--report-azdo-flaky-history 14` queries test result history for the past N days (1 to 90) and annotates failures with flakiness context. Pair it with `--report-azdo-demote-known-flaky` and a failure that clears the flakiness threshold (25% by default) drops from error to warning, so a genuine regression is the only red thing on the page.

HTML, JUnit XML, and CTRF JSON reports also arrived in 2.3.0 via `--report-html`, `--report-junit`, and `--report-ctrf`. All three are marked experimental, so pin your MTP version before wiring them into a required check. Full option tables are in the [MTP test reports docs](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-test-reports).
