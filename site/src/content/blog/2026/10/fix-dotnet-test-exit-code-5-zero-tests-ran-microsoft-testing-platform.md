---
title: "Fix: dotnet test exits with code 5 and \"Zero tests ran\" on Microsoft.Testing.Platform"
description: "Exit code 5 means MTP rejected a command-line option, not that tests are missing. Run the test exe directly to see the real error, then add the extension package or route the option per project."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "dotnet-10"
---

If `dotnet test` prints `Zero tests ran` followed by `Exit code: 5`, your tests were never discovered because the test app refused one of the arguments you passed. On Microsoft.Testing.Platform (MTP), exit code 5 means "invalid command-line arguments", and `dotnet test` throws the explanation away. Run the built test executable with the same arguments (`./bin/Debug/net10.0/MyTests --logger trx`) to see the real message. Then either reference the extension package that provides the option, replace the VSTest-era flag with its MTP equivalent, or route the option only to the projects that understand it with `TestingPlatformCommandLineArguments`.

Everything below was measured on the .NET 10 SDK 10.0.302 and .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) on macOS arm64, with MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1), MSTest.Sdk 4.3.3 (MTP 2.3.3) and xunit.v3.mtp-v2 4.0.1, using a `global.json` that switches `dotnet test` to MTP mode.

## The error in context

This is the entire output of `dotnet test --project MsTests --logger trx` on SDK 10.0.302 against an MSTest project with two perfectly good tests:

```text
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0) Zero tests ran
Exit code: 5

Test run summary: Zero tests ran
  error: 1

  total: 0
  failed: 0
  succeeded: 0
  skipped: 0
  duration: 82ms
Test run completed with non-success exit code: 5 (see: https://aka.ms/testingplatform/exitcodes)
```

Note what is missing: the target framework is printed as `(net10.0)` instead of `(net10.0|arm64)` and there is no `Running tests from ...` line. The test host never reached test discovery. Adding `--output Detailed`, `-v detailed` or `--diagnostic` does not bring the reason back, and the `.diag` file written by `--diagnostic` only records the raw command line.

On the .NET 11 RC 1 SDK the summary line changes to `Test run summary: Failed!` and a new `Handshake failures:` section lists the module, but the reason is still not printed.

In a solution with several test projects it is easier to misread, because one project fails and the other passes:

```text
XTests/bin/Debug/net10.0/XTests.dll (net10.0) Zero tests ran
Exit code: 5
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0|arm64) passed (848ms)
Test run summary: Failed!
  error: 1
  total: 2
```

## Why MTP returns exit code 5 and says zero tests ran

An MTP test project is a normal console executable. `dotnet test` in MTP mode builds each test project, launches the executable, forwards every argument it does not consume itself, and talks to the process over a named pipe. The test app validates its command line before doing anything else. If any option is unknown, or a known option gets an invalid value, it exits with code 5 and never discovers a single test. The [MTP exit code table](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting#exit-codes) defines 5 as "the command-line arguments passed to the test app were invalid".

`dotnet test` then reports the module the same way it reports any module that produced no results: `Zero tests ran`. The text is technically true and completely misleading, because it sends you looking for missing `[TestMethod]` attributes or a broken filter.

Options become unknown for four reasons, in the order I see them in real pipelines:

1. **A VSTest flag survived the migration.** `--logger trx`, `--collect "XPlat Code Coverage"`, `--blame-hang-timeout 5m` and `--blame-crash` belong to VSTest. MTP has no `--logger` or `--collect` at all.
2. **The extension package is missing.** MTP core ships no reporters, no coverage, no dumps and no retry. `--report-trx` only exists when `Microsoft.Testing.Extensions.TrxReport` is referenced, `--coverage` needs `Microsoft.Testing.Extensions.CodeCoverage`, and so on.
3. **Mixed frameworks in one solution.** MSTest.Sdk enables TRX and code coverage by default. A plain xUnit v3 project does not. The same `dotnet test --solution` command line is valid for one project and invalid for the other.
4. **A bad value for a valid option.** `--settings` pointing at a file that does not exist on the agent, or `--timeout 30` without a unit suffix.

Exit code 8 is a different failure that produces the same `Zero tests ran` text. There, the arguments were fine and the test app ran discovery, but nothing matched. You can tell them apart by the `Exit code:` line and by whether `Running tests from ...` appears.

## Minimal repro

The `global.json` opts `dotnet test` into MTP mode (required on the .NET 10 SDK and later; without it you are still on the VSTest bridge):

```json
// .NET 10 SDK 10.0.302
{
  "sdk": { "version": "10.0.302" },
  "test": { "runner": "Microsoft.Testing.Platform" }
}
```

An MSTest project using the MSTest SDK:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MsTests/Tests.cs, .NET 10, MSTest 4.4.1
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MsTests;

[TestClass]
public class CalculatorTests
{
    [TestMethod]
    public void Adds() => Assert.AreEqual(4, 2 + 2);

    [TestMethod, TestCategory("Slow")]
    public void Multiplies() => Assert.AreEqual(6, 2 * 3);
}
```

And an xUnit v3 project next to it:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  </ItemGroup>
</Project>
```

Here is what each command returned on SDK 10.0.302:

| Command | Exit code | What the summary said |
| --- | --- | --- |
| `dotnet test --project MsTests` | 0 | Passed, 2 tests |
| `dotnet test --project MsTests --logger trx` | 5 | Zero tests ran |
| `dotnet test --project MsTests --collect "XPlat Code Coverage"` | 5 | Zero tests ran |
| `dotnet test --project MsTests --blame-hang-timeout 5m` | 5 | Zero tests ran |
| `dotnet test --project MsTests --report-trx` | 0 | Passed, TRX written |
| `dotnet test --solution All.sln --report-trx` | 5 | MSTest passed, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --coverage` | 5 | MSTest passed, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --settings x.runsettings` (file missing) | 5 | both "Zero tests ran" |
| `dotnet test --project MsTests --filter "TestCategory=DoesNotExist"` | 8 | Zero tests ran (a real one) |
| `dotnet test --project MsTests --minimum-expected-tests 5` | 9 | Minimum expected tests policy violation |

## Fix, in detail

### 1. Get the real error message out of the test app

Run the built executable yourself with the exact arguments CI passes. On Windows it is `MsTests.exe`, on Linux and macOS it has no extension:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
./MsTests/bin/Debug/net10.0/MsTests --logger trx
```

```text
Unknown option '--logger'
Option '--logger' uses VSTest syntax, which is not supported by Microsoft.Testing.Platform.
Use '--report-trx' instead.
Run '--help' to see the options registered by this test application. If the option belongs to an extension, ensure its package is referenced and the extension is registered.
Command line: --logger trx
```

`dotnet run --project MsTests --no-build -- --logger trx` prints the same thing and also returns 5. The "uses VSTest syntax ... Use '--report-trx' instead" hint is new in MTP 2.4. MTP 2.3.3 (MSTest.Sdk 4.3.3) prints only `Unknown option '--logger'` followed by the help text, which is still enough.

Next, ask the app which options it actually has. `--help` lists platform options and, separately, "Extension options" contributed by referenced packages. `--info` prints the platform version and every registered extension with its own version:

```bash
# .NET 10 SDK 10.0.302
./XTests/bin/Debug/net10.0/XTests --help
./XTests/bin/Debug/net10.0/XTests --info
```

If the option you are passing is not in that list, it will fail with exit code 5. That single check resolves most of these tickets.

### 2. Replace VSTest flags with their MTP equivalents

| VSTest argument | MTP argument | Package that provides it |
| --- | --- | --- |
| `--logger trx` | `--report-trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--logger trx;LogFileName=x.trx` | `--report-trx --report-trx-filename x.trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--collect "Code Coverage"` | `--coverage` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--collect "XPlat Code Coverage"` | `--coverage --coverage-output-format cobertura` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--blame-hang-timeout 5m` | `--hangdump --hangdump-timeout 5m` | `Microsoft.Testing.Extensions.HangDump` |
| `--blame-crash` | `--crashdump` | `Microsoft.Testing.Extensions.CrashDump` |
| `--results-directory` | `--results-directory` | built in |

At the time of writing the current versions are 2.4.1 for TrxReport, HangDump and CrashDump, and 18.11.2 for CodeCoverage. The [MTP CLI options reference](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options) has the full mapping. `--filter` keeps its VSTest expression syntax for MSTest and NUnit, so it usually does not need to change.

### 3. Reference the extension in every project that receives the option

In the repro, the solution-wide `--report-trx` failed only because the xUnit project lacked the reporter. Adding it fixed the run:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<ItemGroup>
  <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.1" />
</ItemGroup>
```

```text
MsTests.dll (net10.0|arm64) passed (837ms)
XTests.dll (net10.0|arm64) passed (922ms)
Test run summary: Passed!
  total: 4
```

If every test project should produce TRX and coverage, put the references in a `Directory.Build.props` conditioned on `IsTestProject` so new projects pick them up automatically. MSTest.Sdk projects already carry them, so add the condition `'$(UsingMSTestSdk)' != 'true'` if you want to avoid duplicate references.

### 4. Route options per project with TestingPlatformCommandLineArguments

Sometimes you do not want the extension everywhere. Coverage from an integration test project is often noise, and dumps are only useful for the project that hangs. Instead of passing the option on the `dotnet test` command line, put it into the project that understands it:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <TestingPlatformCommandLineArguments>$(TestingPlatformCommandLineArguments) --coverage --coverage-output-format cobertura</TestingPlatformCommandLineArguments>
  </PropertyGroup>
</Project>
```

With that in place, a plain `dotnet test --solution All.sln` returned exit code 0, the xUnit project ran without coverage, and the MSTest project wrote a `.cobertura.xml` into `TestResults`. Microsoft documents the same approach for [solutions with mixed test frameworks or extensions](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions). Keep `$(TestingPlatformCommandLineArguments)` at the start so values from `Directory.Build.props` are not overwritten.

### 5. Validate values, not just names

If the option is listed in `--help` and you still get exit code 5, the value is wrong. In the repro, `--settings x.runsettings` with a missing file failed both projects with exit code 5. Paths are resolved from the working directory of the test process, which on CI is not always the repo root. Time values need units in MTP: `--timeout 30m` works, a bare number does not.

## Exit code 8: when zero tests really ran

If the exit code is 8, the arguments were accepted and the filter or the project simply produced no tests. MTP treats that as a failure by default, unlike VSTest, which returned 0. You have three levers:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1

# Accept an empty run for this invocation (returns 0)
dotnet test --project MsTests --filter "TestCategory=Nightly" --ignore-exit-code 8

# Or demand a floor: fewer than 50 tests returns exit code 9
dotnet test --solution All.sln --minimum-expected-tests 50
```

`--ignore-exit-code` also reads from the `TESTINGPLATFORM_EXITCODE_IGNORE` environment variable, which is handy when the same filter runs across many pipelines. Use it sparingly: a filter that silently matches nothing is exactly the bug exit code 8 was designed to catch.

The SDK version matters for multi-project runs. On SDK 10.0.302, a solution run where one project matched the filter and the other matched nothing returned 8 for the whole run. On the .NET 11 RC 1 SDK the identical command returned 0 with `Test run summary: Passed!`, while still printing `Exit code: 8` next to the empty module. That is the new [whole-run zero-tests verdict](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp) in the .NET 11 SDK. If your CI goes red on .NET 10 and green on .NET 11 with the same filter, this is why. Exit code 5 did not change: both SDKs fail the whole run when any module rejects its arguments.

## Gotchas and lookalikes

- **`error: 1` in the summary is the module, not a test.** It counts modules that exited abnormally. `failed: 0` stays at zero because no test executed.
- **`dotnet test -- --some-option` does not help.** In MTP mode the arguments are forwarded either way, so the double dash does not hide them from the test app.
- **An MTP filter matching nothing returns 8, not 5.** If you see `Running tests from ...` before `Zero tests ran`, your arguments were fine. Check the filter syntax for the framework instead.
- **`--zero-tests-policy strict` did not change my all-skipped run.** The docs say strict treats skipped tests as not run. On MTP 2.4.1, a project whose only test had `[Ignore]` still returned 0 under strict, so do not rely on it as your only guard. `--minimum-expected-tests` is explicit and reliable.
- **"No test projects were found" is a different problem.** That one comes from project evaluation (typically `--no-restore` in a container stage without the `obj` folder), not from the test app. The MTP troubleshooting page covers it.
- **Test Explorer can show its own version of this.** If the CLI is green and Visual Studio hangs on xUnit v3, that is a runner mismatch, not an argument problem.

## Related

- The step-by-step [migration from VSTest to Microsoft.Testing.Platform](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) covers the rest of the CI changes, including `.runsettings` to `testconfig.json`.
- If Visual Studio hangs while the CLI passes, see [Test Explorer hanging on xUnit v3 while dotnet test passes](/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).
- Picking a framework for a new solution, with MTP support compared: [xUnit v3 vs NUnit vs MSTest in 2026](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- Moving an older xUnit project onto MTP first: [migrate a test project from xUnit v2 to xUnit v3](/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).
- Getting failures annotated directly in pull requests: [Microsoft.Testing.Platform 2.3 GitHub Actions annotations](/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).

## Sources

- [Microsoft.Testing.Platform troubleshooting: exit codes and unrecognized extension options](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting)
- [Microsoft.Testing.Platform CLI options reference](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options)
- [Testing with dotnet test: solutions with mixed test frameworks or extensions](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions)
- [dotnet test in MTP mode, including whole-run minimums](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [microsoft/testfx repository (MSTest and Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
