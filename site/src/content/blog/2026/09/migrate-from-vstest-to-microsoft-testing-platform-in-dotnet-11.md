---
title: "Migrate from VSTest to Microsoft.Testing.Platform on the .NET 11 SDK"
description: "A step-by-step migration from VSTest to Microsoft.Testing.Platform 2.3.3: the OutputType Exe opt-in, the global.json runner switch, loggers becoming reporters, .runsettings becoming testconfig.json, and the exit codes that turn a green CI job red."
pubDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "vstest"
  - "microsoft-testing-platform"
  - "testing"
  - "dotnet-11"
  - "dotnet"
  - "ci-cd"
---

Moving a solution from VSTest to Microsoft.Testing.Platform (MTP) is a half-day job for the project files and a full day for CI. The project-side work is three lines per test project: `<OutputType>Exe</OutputType>`, one opt-in property for your test framework, and a `global.json` that sets `"runner": "Microsoft.Testing.Platform"`. What actually costs the time is everything downstream: every `--logger`, `--collect`, and `--blame` flag in your pipeline maps to a different option that only exists if you also add a NuGet package, your `.runsettings` file loses most of its meaning, and a test project that runs zero tests now fails the build with exit code 8 instead of passing. This guide is written against the .NET 11 SDK (Preview 7, August 2026), Microsoft.Testing.Platform 2.3.3, MSTest 4.3.3, NUnit3TestAdapter 6.3.0, and xunit.v3 4.0.0.

## Why the swap is worth doing now

- **It is the direction of travel.** MSTest has shipped its own MTP runner since 3.2.0, NUnit since NUnit3TestAdapter 5.0.0, and xUnit v3 was built on MTP from the start. VSTest is in maintenance: the most visible change it got this year was [dropping its Newtonsoft.Json dependency](/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/).
- **Test modules run in parallel by default.** VSTest serializes assemblies unless you fight it. MTP runs up to `Environment.ProcessorCount` test modules concurrently, capped with `--max-parallel-test-modules`.
- **No external runner.** The test project is an executable. `./MyApp.Tests` runs the suite with no `vstest.console.exe`, no `dotnet test`, and no adapter discovery pass. That matters for container images and for reproducing a CI failure locally.
- **Run-level policies you had to script before.** `--timeout`, `--maximum-failed-tests`, `--minimum-expected-tests`, and `--ignore-exit-code` are first-class, and the last three exist specifically because CI needs them.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| Project shape | Test projects must set `<OutputType>Exe</OutputType>` | high |
| Solution consistency | With MTP enabled in `global.json`, **every** test project must use MTP. A mixed solution is an error, not a warning | high |
| `--logger` | Renamed to "reporters". `--logger trx` becomes `--report-trx` and requires `Microsoft.Testing.Extensions.TrxReport` | high |
| `--collect "Code Coverage"` | Becomes `--coverage`, requires `Microsoft.Testing.Extensions.CodeCoverage`, and `IncludeTestAssembly` now defaults to `false` | high |
| `--blame-crash` / `--blame-hang` | Become `--crashdump` / `--hangdump` from separate packages. `--blame-crash-collect-always` has no equivalent | medium |
| Zero tests executed | VSTest returns 0. MTP returns exit code 8 | high |
| `.runsettings` | Supported only through the MSTest and NUnit VSTest bridges. The platform itself reads `testconfig.json` | medium |
| `dotnet test MyTests.csproj` | Positional project paths are gone. Use `--project`, `--solution`, or `--test-modules` | medium |
| xUnit filters | `--filter` is not implemented. Use `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, `--filter-query` | high (xUnit only) |
| `RunConfiguration.TargetPlatform=x86` | Becomes `--arch x86` | low |
| Console encoding | MTP always sets UTF-8. VSTest's default isolation mode did not | low |

The two rows that decide your timeline are the solution-consistency one and the `--logger` one. The rest the tooling tells you about.

## Pre-flight checklist

- **.NET 10 SDK or later.** Runner selection landed in the .NET 10 SDK. On .NET 9 and earlier you are stuck with the `TestingPlatformDotnetTestSupport` bridge and a mandatory `--` separator.
- **MTP 1.7 or later** in every test project. The `dotnet test` MTP integration is only supported from 1.7 onward; 2.3.3 is the current stable release.
- **Inventory the pipeline first.** Grep your CI for `dotnet test`, `vstest.console`, `--logger`, `--collect`, `--blame`, `--settings`, and `--filter`. That grep is your actual work list.
- **Find every `.runsettings`.** `find . -name "*.runsettings"` and read each one. Anything under `DataCollectionRunSettings` becomes a CLI option or disappears.
- **Know your frameworks.** A solution with both MSTest and xUnit projects needs per-project argument routing (see step 6). Find out now, not when CI fails with exit code 5.
- **Migrate one project end to end first**, through a real CI run, before touching the rest.

## Migration steps

1. **Pin the SDK and select the runner in `global.json`.**

   Runner selection is a repo-level decision, not a per-project one.

   ```json
   // global.json - .NET 11 SDK
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     },
     "test": {
       "runner": "Microsoft.Testing.Platform"
     }
   }
   ```

   `VSTest` is the other valid value and remains the default when the `test` section is absent. On the .NET 11 SDK you can also override this per shell with the `DOTNET_TEST_RUNNER` environment variable, which is the fastest way to A/B a CI job without editing a tracked file.

   Verify: `dotnet test --help` now lists `--project`, `--solution`, and `--test-modules`. If it still lists `--logger` and `--collect`, the runner switch did not take effect.

2. **Make every test project an executable.**

   This is the universal opt-in, regardless of framework. Put it in `Directory.Build.props` next to your test projects rather than repeating it.

   ```xml
   <!-- tests/Directory.Build.props - .NET 11 SDK, MTP 2.3.3 -->
   <Project>
     <PropertyGroup>
       <OutputType>Exe</OutputType>
     </PropertyGroup>
   </Project>
   ```

   You do not write a `Main`. `Microsoft.Testing.Platform.MSBuild`, which every MTP-capable framework brings in transitively, generates a `TestingPlatformEntryPoint` for you.

   Verify: `dotnet build` produces a `MyApp.Tests` executable (or `.exe`) in the output folder, and running it directly executes the suite.

3. **Turn on the runner for your test framework.**

   Each framework has its own property, and the minimum versions differ.

   ```xml
   <!-- tests/Directory.Build.props - pick the one that matches your framework -->
   <PropertyGroup>
     <!-- MSTest 3.2.0+, current 4.3.3 -->
     <EnableMSTestRunner>true</EnableMSTestRunner>

     <!-- NUnit3TestAdapter 5.0.0+, current 6.3.0 -->
     <EnableNUnitRunner>true</EnableNUnitRunner>

     <!-- xunit.v3 1.0.1+, current 4.0.0 -->
     <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
   </PropertyGroup>
   ```

   MSTest projects can skip the property entirely by switching the project SDK to `MSTest.Sdk`, where MTP is on by default. xUnit v3 4.0.0 resolves to the MTP v2 package variant; the 3.x line defaulted to MTP v1, which 4.0.0 dropped. If you are still on xUnit v2, there is no first-party MTP path, so do the [v2 to v3 migration](/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/) first.

   Verify: run the test executable with `--help`. You should see the platform options (`--filter-uid`, `--timeout`, `--list-tests`) plus whatever your framework registers.

4. **Delete the .NET 9 era bridge properties.**

   A lot of blog posts and even parts of the MS Learn MSTest page still show these. On the .NET 10 or .NET 11 SDK with `global.json` runner selection, they are obsolete and should be removed:

   ```xml
   <!-- delete these from every test project and Directory.Build.props -->
   <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   <TestingPlatformShowTestsFailure>true</TestingPlatformShowTestsFailure>
   ```

   The `--` separator they required also becomes optional, though it is still worth keeping in CI for a reason covered in step 6.

   Verify: `dotnet test` still runs and the console output shows the MTP terminal reporter rather than the VSTest one.

5. **Re-add the loggers and collectors as extension packages.**

   MTP core ships none of these. If your pipeline passes an option whose package is missing, the run fails with **exit code 5** because the option is unrecognized.

   ```xml
   <!-- tests/Directory.Build.props - MTP 2.3.3 extensions -->
   <ItemGroup>
     <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.10.0" />
     <PackageReference Include="Microsoft.Testing.Extensions.HangDump" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CrashDump" Version="2.3.3" />
   </ItemGroup>
   ```

   The code coverage extension versions independently of the platform: it tracks the Visual Studio test platform numbering, so the current release is 18.10.0 while the rest sit at 2.3.3. The documented compatibility table pairs the 18.1.x line with MTP 2.0.x, 18.0.x with 1.8.x, and 17.14.x with 1.6.2, and the guidance is to keep both on their latest. If you are on Central Package Management, these belong in `Directory.Packages.props`, which is one more argument for [moving the solution to Directory.Packages.props](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) before you start.

   Verify: `dotnet test --help` lists `--report-trx`, `--coverage`, `--hangdump`, and `--crashdump`.

6. **Translate the CI command line.**

   This is the bulk of the work. The mapping:

   ```bash
   # before - VSTest, .NET 9 SDK
   dotnet test MyApp.sln \
     --logger "trx;LogFileName=results.trx" \
     --collect "Code Coverage" \
     --blame-hang-timeout 5m \
     --results-directory ./artifacts/tests \
     --filter "TestCategory=Integration"
   ```

   ```bash
   # after - MTP 2.3.3, .NET 11 SDK
   dotnet test --solution MyApp.sln \
     --results-directory ./artifacts/tests \
     -- --report-trx --report-trx-filename results.trx \
        --coverage --coverage-output-format cobertura \
        --hangdump --hangdump-timeout 5m \
        --filter "TestCategory=Integration"
   ```

   Three things to notice. The positional `MyApp.sln` became `--solution`, because `dotnet test` in MTP mode no longer accepts a bare path. The `--` is technically optional on the .NET 10 SDK and later, but `dotnet test` forwards unrecognized tokens to the test application, and a recognized SDK option sitting between an unrecognized option name and its value changes how the leftover tokens bind. Put test application arguments after `--` and the ambiguity disappears. Finally, `--results-directory` is understood by both the SDK and the platform, so it can sit on either side.

   For a solution that mixes frameworks or extension sets, route arguments per project instead of globally:

   ```xml
   <!-- only the projects that reference HangDump get the option -->
   <PropertyGroup Condition="'$(MSBuildProjectName)' == 'MyApp.Integration.Tests'">
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --hangdump --hangdump-timeout 5m
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Verify: the run produces `results.trx` and a Cobertura file under `./artifacts/tests`, and the exit code is 0.

7. **Replace `.runsettings` with `testconfig.json`.**

   MSTest and NUnit keep honoring `--settings config.runsettings` through their VSTest bridges, so you can defer this. xUnit v3 does not, and the platform itself never reads runsettings. The replacement:

   ```json
   // testconfig.json at the repo root - MTP 2.3.3
   {
     "platformOptions": {
       "resultDirectory": "./artifacts/tests",
       "exitProcessOnUnhandledException": false
     },
     "environmentVariables": {
       "DOTNET_ENVIRONMENT": "Testing"
     },
     "mstest": {
       "parallelism": { "enabled": true, "workers": 4, "scope": "method" },
       "timeout": { "test": 30000 }
     }
   }
   ```

   The mapping is not one-to-one. `RunConfiguration/ResultsDirectory` becomes `platformOptions.resultDirectory`. `RunConfiguration/MaxCpuCount` has no equivalent, because process-level parallelism is now `--max-parallel-test-modules`. `LoggerRunSettings/Loggers` and everything under `DataCollectionRunSettings` become CLI options from step 5. `TestRunParameters` becomes `--test-parameter key=value`. Starting with MTP 2.3.0 you can also put CLI options themselves in `testconfig.json`, extension options included, which is how you keep `--coverage-output-format cobertura` out of every pipeline file; the `environmentVariables` section is also 2.3.0 or later.

   Point every project at one shared file from `Directory.Build.props`:

   ```xml
   <PropertyGroup>
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --config-file $(MSBuildThisFileDirectory)testconfig.json
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Verify: delete the `.runsettings` reference from CI and confirm results still land in the configured directory.

8. **Swap the CI task itself.**

   On Azure DevOps, replace the `VSTest@2` task with `DotNetCoreCLI@2`. It is a `dotnet test` invocation like any other, so the step 6 rules apply verbatim:

   ```yml
   # azure-pipelines.yml - .NET 11 SDK, MTP 2.3.3
   - task: DotNetCoreCLI@2
     inputs:
       command: 'test'
       arguments: '--solution MyApp.sln -- --report-trx --results-directory $(Agent.TempDirectory)'
   ```

   On GitHub Actions, `Microsoft.Testing.Extensions.GitHubActionsReport` plus `--report-gh` puts failures directly in the pull request diff, which is [the reporting story that went stable in MTP 2.3](/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/). Note the near-miss: the third-party `GitHubActionsTestLogger` package uses `--report-github`, one character apart from the first-party option.

   Verify: a deliberately failing test produces a red job with the failure visible in the run summary, not just in the raw log.

## Verify the migration

Run this list against one project before rolling the change across the solution:

- `dotnet build` emits an executable per test project, and running it directly (`./MyApp.Tests`) reports the same test count as `dotnet test`.
- `dotnet test --help` lists every option your pipeline passes. If one is missing, its package is missing.
- The test count matches the pre-migration VSTest count. A drop usually means a filter expression stopped matching, not that tests vanished.
- The TRX file and coverage report exist at the paths your downstream steps read.
- Visual Studio Test Explorer still discovers and runs tests. MTP support requires Visual Studio 17.14 or later; VS Code needs C# Dev Kit.
- `echo $?` after a passing run is 0, and after a deliberately failing run is 2.

## Rollback

This migration is reversible in one commit for as long as you keep `Microsoft.NET.Test.Sdk` and your framework's VSTest adapter package referenced. Delete the `test` section from `global.json` and the runner falls back to VSTest; `OutputType=Exe` and the opt-in properties are inert under VSTest. That is exactly why you should not delete `xunit.runner.visualstudio` or `Microsoft.NET.Test.Sdk` in the same pull request. Do the cleanup pass a week later, once CI and every developer's IDE have run on MTP.

## Gotchas worth knowing before you start

**Exit code 8 turns a green job red.** A project that runs zero tests exits with 8 under MTP and 0 under VSTest. This bites solutions with a placeholder test project or a filter that matches nothing. Either fix the filter or opt out explicitly:

```xml
<PropertyGroup>
  <TestingPlatformCommandLineArguments>
    $(TestingPlatformCommandLineArguments) --ignore-exit-code 8
  </TestingPlatformCommandLineArguments>
</PropertyGroup>
```

`--ignore-exit-code` takes a semicolon-separated list (`--ignore-exit-code 2;8`), and `TESTINGPLATFORM_EXITCODE_IGNORE` does the same from the environment. Separately, MTP 2.3.0 changed the all-skipped case: a run where every test was skipped now succeeds by default, and `--zero-tests-policy strict` restores the pre-2.3.0 failure.

**A mixed solution is an error, not a warning.** Once `global.json` selects MTP, `dotnet test` expects every test project in the graph to be an MTP project. One straggler on VSTest fails the whole run. Migrate the leaf projects first and flip `global.json` last.

**Exit code 5 means a missing package, not a typo.** If half your projects reference `Microsoft.Testing.Extensions.HangDump` and half do not, `--hangdump` is valid for some and unrecognized for others, and the run dies with 5. Use the per-project `TestingPlatformCommandLineArguments` conditions from step 6.

**xUnit ignores `--filter`.** MSTest and NUnit keep the VSTest expression syntax (`FullyQualifiedName~UnitTest1|TestCategory=CategoryA`) under MTP. xUnit v3 does not implement it at all: you need `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, or `--filter-query`, plus their negated variants. A CI filter that silently matches nothing then trips exit code 8, which is how this shows up in practice. The same class of silent-filter problem is worth understanding if you are also weighing [xUnit v3 against NUnit and MSTest](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).

**Coverage numbers move.** `IncludeTestAssembly` defaults to `false` in `Microsoft.Testing.Extensions.CodeCoverage` and defaulted to `true` in VSTest. Your total coverage percentage will change on the migration commit for reasons unrelated to your code. Tell whoever watches the coverage gate before you push.

**The generated entry point produces two odd compiler errors.** `Microsoft.Testing.Platform.MSBuild` emits `TestingPlatformEntryPoint` and `SelfRegisteredExtensions` into `$(RootNamespace)`, which defaults to the project name. A project named `Contoso.Serialization.Tests` that also references a `Contoso.Serialization` package can produce `CS0118: 'Serialization' is a namespace but is used like a type`; set `<RootNamespace>Contoso.SerializationTests</RootNamespace>` or clear it with `<RootNamespace />`. Separately, a non-test project that references a test project hits `CS8892` because the generated entry point collides with its `Main`; set `<IsTestingPlatformApplication>false</IsTestingPlatformApplication>` on the referencing project, or `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` on the test project.

**Test Explorer weirdness has its own switch.** If discovery misbehaves in an IDE, `<DisableTestingPlatformServerCapability>true</DisableTestingPlatformServerCapability>` turns off MTP's server mode so the IDE falls back to the VSTest adapter. That is a workaround, not a fix, and it is a different problem from [Test Explorer hanging while `dotnet test` passes](/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

The .NET 11 SDK makes the timing good: run-level `--timeout` and `--maximum-failed-tests`, `--no-dependencies`, `--use-current-runtime`, `!`-prefixed exclusion patterns for `--test-modules`, `Microsoft.Build.Traversal` support, and a live in-flight test display in interactive terminals. None of it exists on the VSTest path.

## Related

- [Migrate a test project from xUnit v2 to xUnit v3](/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)
- [Microsoft.Testing.Platform 2.3 and GitHub Actions annotations](/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [xUnit v3 vs NUnit vs MSTest in 2026](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [VSTest drops Newtonsoft.Json in .NET 11 Preview 4](/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)
- [Migrate a .NET solution to Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Sources

- [Migration guide from VSTest to Microsoft.Testing.Platform (MTP)](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) on MS Learn
- [dotnet test command with Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp), the MTP-mode CLI reference
- [Microsoft.Testing.Platform CLI options reference](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-cli-options), including the extension-options-by-scenario table
- [Microsoft.Testing.Platform troubleshooting](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-troubleshooting) for the full exit code table
- [Microsoft.Testing.Platform config options](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-config) for `testconfig.json` and the runsettings mapping
- [Microsoft.Testing.Platform code coverage](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-code-coverage) for the extension options and version compatibility table
- [Enhance your CLI testing workflow with the new dotnet test](https://devblogs.microsoft.com/dotnet/dotnet-test-with-mtp/) on the .NET Blog
- [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk) for the Preview 7 test improvements
- [Microsoft Testing Platform support in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
