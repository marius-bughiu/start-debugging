---
title: "Fix: dotnet test falls back to VSTest in a Linux CI pipeline even though the project uses Microsoft.Testing.Platform"
description: "dotnet test picks its runner from global.json found by walking up from the working directory. On Linux CI it falls back to VSTest when that file is missing, misnamed, has a mis-cased key, or the SDK is older than 10."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "ci-cd"
  - "dotnet-10"
---

If `dotnet test` runs your Microsoft.Testing.Platform (MTP) tests through VSTest on a Linux build agent but not on your machine, the CLI did not see your runner selection. `dotnet test` decides between VSTest and MTP before it builds anything, by looking for a `global.json` that starts at the **current working directory** and walks up, and by reading a `"test": { "runner": "Microsoft.Testing.Platform" }` section with exactly those lowercase property names. On Linux the file must be named `global.json` in lowercase, the job must run from inside the repository, and the SDK must be 10.0 or later. Fix whichever of those your pipeline breaks, then make CI fail loudly when it happens again.

Everything below was measured on macOS arm64 (including a case-sensitive APFS volume that behaves like a Linux file system) with the .NET 10 SDK 10.0.302, the .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) and the .NET 9 SDK 9.0.318, against MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) and xunit.v3 3.2.2 (MTP v1 with `xunit.runner.visualstudio` 3.1.5).

## The error in context

What "falls back to VSTest" looks like depends on which MTP version your test projects use. Projects on MTP 2.x (MSTest 4.x, MSTest.Sdk 4.x, `xunit.v3.mtp-v2`) refuse to run and fail the job:

```text
Microsoft.Testing.Platform.MSBuild.targets(355,5): error : Testing with VSTest target is no longer supported by Microsoft.Testing.Platform on .NET 10 SDK and later. If you use dotnet test, you should opt-in to the new dotnet test experience. For more information, see https://aka.ms/dotnet-test-mtp-error [/src/tests/SdkTests/SdkTests.csproj]
```

If your pipeline uses the MTP-only syntax for selecting what to test, the failure happens even earlier, because the VSTest-mode `dotnet test` hands the unknown switch to MSBuild:

```text
MSBUILD : error MSB1001: Unknown switch.
    Full command line: '/usr/share/dotnet/sdk/10.0.302/MSBuild ... --target:VSTest --nologo -nodereuse:false --solution src/Repo.slnx ...'
Switch: --solution
```

The dangerous variant is the one that stays green. A project on MTP v1 that still references a VSTest adapter (`xunit.v3` 3.x with `xunit.runner.visualstudio`, or MSTest 3.x with `Microsoft.NET.Test.Sdk`) runs happily under VSTest:

```text
Test run for /src/tests/XTests/bin/Debug/net10.0/XTests.dll (.NETCoreApp,Version=v10.0)
A total of 1 test files matched the specified pattern.
Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 6 ms - XTests.dll (net10.0)
```

In that mode `dotnet test -- --report-trx` also returns exit code 0 and writes no TRX file at all, because everything after `--` is treated as RunSettings arguments. In real MTP mode the same project rejects `--report-trx` with exit code 5 (the extension is not referenced), which is the honest answer. A pipeline that publishes "whatever TRX files exist" will happily publish nothing.

For comparison, this is what MTP mode prints. If you do not see `Running tests from` and `Test run summary`, you are not in MTP mode:

```text
Running tests from /src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64)
/src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64) passed (426ms)
Test run summary: Passed!
```

## Why dotnet test ignores your runner choice

Runner selection was added in the .NET 10 SDK and lives in one place: the `test` section of `global.json`. On the .NET 11 SDK (from Preview 6) the `DOTNET_TEST_RUNNER` environment variable can override it. If neither selects MTP, `dotnet test` stays in VSTest mode, invokes the `VSTest` MSBuild target, and lets your MTP project react however its version reacts. Nothing in the `.csproj` can change that decision, because it is made by the CLI before MSBuild evaluates any project.

The causes I could reproduce, in rough order of how often they show up in real pipelines:

1. **The job runs from a directory that is not inside the repo**, so the upward search never reaches `global.json`. Passing the solution path does not help; the search starts from the working directory, not from the project.
2. **The file is named `Global.json`** (or `GLOBAL.JSON`). Windows and default macOS file systems are case-insensitive, so it works locally. Linux is not.
3. **`global.json` is not in the place CI runs from**: it sits in `src/` while the job runs from the repo root, or a Docker build context copies the projects but not the file.
4. **A property name has the wrong case.** `"Test"` or `"Runner"` is silently ignored. The value is case-insensitive, the keys are not.
5. **The CI image has an SDK older than 10.0.** The .NET 9 SDK does not know the `test` section exists.
6. **`DOTNET_TEST_RUNNER=VSTest` is set** at pipeline or agent level on a .NET 11 SDK. It beats `global.json`.

## Minimal repro

Two test projects, one solution, and a `global.json` at the repository root:

```json
// global.json - .NET 10 SDK 10.0.302
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

```xml
<!-- tests/SdkTests/SdkTests.csproj - MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

From the repo root, `dotnet test` runs both projects in MTP mode. Now reproduce the CI behaviour:

```bash
# .NET 10 SDK 10.0.302
cd /tmp/elsewhere
dotnet test /src/repo/Repo.slnx        # VSTest mode: "Testing with VSTest target is no longer supported"

cd /src/repo
mv global.json Global.json
dotnet test                             # macOS/Windows: MTP mode. Linux: VSTest mode
```

I ran the second half on a case-sensitive APFS disk image (`hdiutil create -fs "Case-sensitive APFS"`) to get Linux semantics without a container: `global.json` passed, `Global.json` failed with the VSTest error, and the same `Global.json` on the normal case-insensitive volume passed. That is the classic "works on my machine" split.

## Fix, in detail

### 1. Prove which mode the agent is in

Add a diagnostic step before the test step. The first lines of `dotnet test --help` tell you which command the CLI picked:

```bash
# .NET 10 SDK 10.0.302 - put this right before the test step
pwd
ls -la global.json || echo "no global.json in $(pwd)"
dotnet --version
dotnet test --help | sed -n 2p
```

In MTP mode the second line reads `.NET Test Command for Microsoft.Testing.Platform (opted-in via 'global.json' file)`. In VSTest mode it reads `.NET Test Command for VSTest. To use Microsoft.Testing.Platform, opt-in to the Microsoft.Testing.Platform-based command via global.json.` One small quirk: on the .NET 11 RC 1 SDK the MTP text still says "via 'global.json' file" even when the environment variable did the opting in.

### 2. Rename the file to lowercase in git

On a case-insensitive file system a plain rename to the same name with different case is not picked up reliably. Let git do it:

```bash
# any git version
git mv Global.json global.json.tmp
git mv global.json.tmp global.json
git commit -m "Rename global.json to lowercase for Linux agents"
```

The same applies to `Directory.Build.props` and friends, but those are resolved by MSBuild and a wrong case there produces different symptoms.

### 3. Run the test step from inside the repository

The search walks up from the working directory, so the job only needs to be somewhere at or below the folder that holds `global.json`. In GitHub Actions the default working directory is the checkout, so the usual culprit is an explicit `working-directory` or a `cd` into an artifacts folder:

```yaml
# GitHub Actions, actions/setup-dotnet@v6, .NET 10 SDK
- uses: actions/setup-dotnet@v6
  with:
    global-json-file: global.json
- name: Test
  run: dotnet test --solution Repo.slnx
  # no working-directory pointing at a folder outside the repo
```

`global-json-file` keeps the SDK that `setup-dotnet` installs in sync with the file, which also covers cause 5. It reads the SDK version from `sdk.version`, so pair it with the pin shown in step 5. Without a pin, `setup-dotnet` documents that the latest SDK already installed on the runner wins. If your `global.json` lives in `src/`, either move it to the root (recommended, since `dotnet build` and IDEs resolve it the same way) or run the step with `working-directory: src`.

For Docker builds, copy `global.json` into the same directory you run `dotnet test` from, and check `.dockerignore`:

```dockerfile
# mcr.microsoft.com/dotnet/sdk:10.0
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS test
WORKDIR /src
COPY global.json ./
COPY Repo.slnx ./
COPY tests/ tests/
RUN dotnet test --solution Repo.slnx
```

### 4. Spell the section exactly

These were all tested on SDK 10.0.302:

| `global.json` content | Result |
|---|---|
| `"test": { "runner": "Microsoft.Testing.Platform" }` | MTP |
| `"test": { "runner": "microsoft.testing.platform" }` | MTP (value is case-insensitive) |
| `"Test": { "runner": ... }` or `"test": { "Runner": ... }` | VSTest, silently |
| `"sdk": { "version": "10.0.302", "test": { ... } }` (nested) | VSTest, silently |
| `"test": { "runner": "MTP" }` | CLI crash: `Test runner 'MTP' is not supported.` |
| `// comments` in the file | MTP (comments are allowed) |
| a trailing comma | CLI crash: `JsonException ... trailing comma` |

The loud failures are easy. The two silent ones are the reason to keep the exact casing from the docs and to keep `test` at the top level, next to `sdk`, not inside it.

### 5. Use an SDK that understands runner selection

On SDK 9.0.318 with the exact same `global.json`, `dotnet test` ignored the `test` section entirely and ran an `xunit.v3` 3.2.2 project through VSTest (`VSTest version 17.14.1`). An MSTest.Sdk 4.4.1 project on `net9.0` also stayed green, but through the old MSBuild bridge (`Run tests: '...' [net9.0|arm64]`), because the bridge is still supported on SDK 9 and earlier. In both cases you lose MTP-mode behaviour without any warning.

This bites pipelines that use `mcr.microsoft.com/dotnet/sdk:9.0` images, or `setup-dotnet` with `dotnet-version: 9.0.x` for a project that targets `net8.0` or `net9.0`. You do not need to retarget the projects; you only need the 10.0 SDK to run them. Pin it in the same file:

```json
// global.json - SDK pin plus runner selection, .NET 10 SDK
{
  "sdk": {
    "version": "10.0.302",
    "rollForward": "latestFeature"
  },
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

With a pinned `sdk.version`, an agent without a matching SDK fails at startup with a "compatible .NET SDK was not found" error instead of quietly using an older one.

### 6. Check for DOTNET_TEST_RUNNER on .NET 11 agents

On the .NET 11 RC 1 SDK I confirmed the documented precedence: `DOTNET_TEST_RUNNER=VSTest` overrides a correct `global.json` and produces the same "Testing with VSTest target is no longer supported" error, while an empty or unrecognized value (`DOTNET_TEST_RUNNER=MTP`) is ignored and `global.json` wins. The variable also works in the other direction, which makes it a handy temporary fix when you cannot change the repo:

```bash
# .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) and later; ignored by the .NET 10 SDK
export DOTNET_TEST_RUNNER=Microsoft.Testing.Platform
dotnet test --solution Repo.slnx
```

On SDK 10.0.302 the variable has no effect in either direction, so do not rely on it until the agent is on .NET 11.

### 7. Make a fallback fail the build

Two cheap guards turn the silent variant into a red build:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
dotnet test --solution Repo.slnx --minimum-expected-tests 1
```

`--solution` (or `--project`) only exists in MTP mode, so in VSTest mode the command dies with `MSB1001: Unknown switch` instead of running tests the wrong way. `--minimum-expected-tests` is an MTP option that fails the run with exit code 9 if fewer tests than expected executed. Never pass MTP options after `--` in CI: that is exactly the syntax VSTest mode swallows without complaint.

If you are still migrating, also drop `TestingPlatformDotnetTestSupport` from your projects once the `global.json` switch is in place. It only matters in VSTest mode, and leaving it behind lets an MTP v1 project keep "working" through the bridge when the runner selection is lost.

## Gotchas and lookalikes

- **The `.csproj` cannot opt in for you.** `TestingPlatformDotnetTestSupport`, `EnableMSTestRunner` and `UseMicrosoftTestingPlatformRunner` decide how a project behaves under each mode. They do not pick the mode.
- **A mixed solution is a different error.** Once MTP mode is on, a project that only supports VSTest fails the run. That is the opposite problem, covered in the [VSTest to Microsoft.Testing.Platform migration guide](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).
- **`Zero tests ran` with exit code 5 means you are in MTP mode.** An option was rejected by the test app, see [dotnet test exit code 5 on Microsoft.Testing.Platform](/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- **Azure DevOps `VSTest@2` and `VSTest@3` tasks always use vstest.console.** No `global.json` changes that. Use a script step that calls `dotnet test` from the repository root instead.
- **IDEs make their own choice.** Test Explorer reading the project differently from the CLI is its own class of bug, for example [Test Explorer hanging on xUnit v3 while dotnet test passes](/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

## Related

- The full [migration from VSTest to Microsoft.Testing.Platform in .NET 11](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), including `--logger` to `--report-trx` and `.runsettings` to `testconfig.json`.
- When MTP mode is active but a project refuses its arguments: [fix dotnet test exit code 5 and "Zero tests ran"](/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- Getting MTP failures annotated on the pull request diff once CI runs in the right mode: [Microsoft.Testing.Platform 2.3 GitHub Actions annotations](/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).
- Moving an `xunit.v3` 3.x project off MTP v1 and the VSTest adapter: [migrate a test project from xUnit v2 to xUnit v3](/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

## Sources

- [dotnet test command: choose a test runner](https://learn.microsoft.com/dotnet/core/tools/dotnet-test#choose-a-test-runner)
- [Testing with dotnet test: VSTest mode and MTP mode](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test)
- [global.json overview, including how the file is located](https://learn.microsoft.com/dotnet/core/tools/global-json)
- [dotnet test with Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [actions/setup-dotnet: global-json-file input](https://github.com/actions/setup-dotnet)
- [microsoft/testfx repository (MSTest and Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
