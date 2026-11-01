---
title: "Migrate a .NET test project from FluentAssertions 8 to AwesomeAssertions 9"
description: "A tested migration from FluentAssertions 8.11 to AwesomeAssertions 9.6 on .NET 10: the two-hop path through AwesomeAssertions 8.2, the License.Accepted compile error, the namespace rename, companion packages, and the silent DLL clash that can put the Xceed-licensed assembly back in your test run."
pubDate: 2026-11-01
updatedDate: 2026-11-01
template: migration
tags:
  - "migration"
  - "dotnet"
  - "testing"
  - "csharp"
  - "awesomeassertions"
  - "fluentassertions"
---

Moving a test project from FluentAssertions 8 to AwesomeAssertions is a package swap plus one namespace rename. AwesomeAssertions 8.x is a drop-in replacement that still uses the `FluentAssertions` namespace and even ships an assembly called `FluentAssertions.dll`, so the first hop is "change the `PackageReference`, delete `License.Accepted = true`, rebuild". AwesomeAssertions 9.0 renamed everything to `AwesomeAssertions` and made no functional changes, so the second hop is a find-and-replace of `FluentAssertions` with `AwesomeAssertions` in your `using` directives. For a typical test project that is under an hour of work, almost all of it CI time. The one trap that matters is not in your code: any companion package that still depends on the `FluentAssertions` NuGet package can silently put the Xceed-licensed assembly back into your build output.

Everything below was run on the .NET 10 SDK 10.0.302 with xUnit 2.9.3, FluentAssertions 8.11.0, AwesomeAssertions 8.2.0 and AwesomeAssertions 9.6.0 (August 2026). I built one small test project against FluentAssertions 8.11, then migrated it hop by hop. The compiler errors and console output quoted here are from that project.

## Why teams leave FluentAssertions 8

- **License.** FluentAssertions 8.0.0 shipped on 14 January 2025 under the Xceed Community License: free for non-commercial and open-source use, a paid per-developer subscription for commercial use. Versions 7.x and earlier stay on Apache 2.0, and 7.2.2 still got a patch in March 2026, but the 8.x features (xUnit v3 and TUnit support, `Satisfy`, `AssertionEngineInitializer`, `BeNaN`) are not there.
- **The console notice.** Unless you set `License.Accepted = true`, every FluentAssertions 8 test run prints a nine-line Xceed license warning. Teams that set the flag to silence it then have a line in their test code asserting a license they may not hold.
- **Same API, Apache 2.0.** [AwesomeAssertions](https://github.com/AwesomeAssertions/AwesomeAssertions) was forked the day 8.0.0 shipped. Its 8.0.0 release notes describe it as "a drop-in replacement for FluentAssertion 8.0.0" under the original license. By November 2026 it has 27 million NuGet downloads and an active release cadence (9.6.0 shipped on 20 August 2026).

If you are on FluentAssertions 7.x and happy there, there is no urgency. This guide is for projects already on 8.x, or teams that want the 8.x feature set without the commercial license.

## What changes between FluentAssertions 8.11 and AwesomeAssertions 9.6

| Area | FluentAssertions 8.11.0 | AwesomeAssertions 9.6.0 | Severity |
| --- | --- | --- | --- |
| Package id | `FluentAssertions` | `AwesomeAssertions` | high (every project) |
| Namespaces | `FluentAssertions.*` | `AwesomeAssertions.*` (since 9.0) | high (every file) |
| Assembly name | `FluentAssertions.dll` | `AwesomeAssertions.dll` (8.x still ships `FluentAssertions.dll`) | medium |
| `License.Accepted` | exists | removed, `CS0103` | low (one line) |
| Assertion API | v8 API | same v8 API, plus additions | none |
| Companion packages | `FluentAssertions.Json`, `.Web`, `.Analyzers` | `AwesomeAssertions.Json`, `.Web`, `.Analyzers` | medium |
| Target frameworks | net47, net6.0, netstandard2.0/2.1 | net47, net6.0, net8.0, netstandard2.0/2.1 | low |

The assertion API itself is not on the list for a reason. `Should()`, `BeEquivalentTo`, `AssertionScope`, `AssertionChain`, `AssertionConfiguration.Current`, `[CustomAssertion]` and `[assembly: AssertionEngineInitializer]` all exist with the same shape. If you already did the painful 7-to-8 upgrade (the `Execute.Assertion` to `AssertionChain` rewrite), you do not redo it.

## Pre-flight checklist

- Find every project that references the package: `grep -rl "FluentAssertions" --include=*.csproj --include=Directory.Packages.props --include=Directory.Build.props .`
- List companion packages too. Anything with `FluentAssertions` in its id (`FluentAssertions.Json`, `FluentAssertions.Web`, `FluentAssertions.Analyzers`, `WireMock.Net.FluentAssertions`, vendor-specific extensions) needs a replacement or must be removed.
- Run `dotnet list package --include-transitive | grep -i fluentassertions` on each test project. A transitive `FluentAssertions` you did not add yourself is the gotcha described below.
- Check the frameworks you target. AwesomeAssertions 9.6 still ships net47 and netstandard2.0 builds, so .NET Framework test projects are fine.
- Start from a green suite and a clean branch. You want "every test still passes" to be the only verification signal.

## Migration steps

1. **Swap the package for AwesomeAssertions 8.2.0.** This is the drop-in hop: same namespaces, same assembly name. Remove `FluentAssertions` and add `AwesomeAssertions` at 8.2.0 (the last 8.x). With central package management, change the `PackageVersion` entry in `Directory.Packages.props` instead.

   ```bash
   # .NET 10 SDK 10.0.302
   dotnet remove package FluentAssertions
   dotnet add package AwesomeAssertions --version 8.2.0
   ```

   Verify: `dotnet build`. Expect exactly one kind of error if you accepted the license in code, covered in the next step.

2. **Delete `License.Accepted = true`.** AwesomeAssertions has no `License` type, so the build fails with:

   ```text
   TestSetup.cs(12,9): error CS0103: The name 'License' does not exist in the current context
   ```

   Delete the line. Nothing replaces it, and AwesomeAssertions prints no notice. Verify: `dotnet test` passes with the same test count as before. In my project that was `Passed: 4` on both FluentAssertions 8.11 and AwesomeAssertions 8.2, with no code change other than this one line.

3. **Replace companion packages.** `FluentAssertions.Json` becomes `AwesomeAssertions.Json`, `FluentAssertions.Web` becomes `AwesomeAssertions.Web`, `FluentAssertions.Analyzers` becomes `AwesomeAssertions.Analyzers`. Do this before the 9.x hop: the current `AwesomeAssertions.Json` 9.0.0 and `AwesomeAssertions.Web` 3.0.0 both depend on `AwesomeAssertions` 9.0.0, so they go in together with step 4. Verify: `dotnet list package --include-transitive | grep -i fluentassertions` prints nothing.

4. **Upgrade to AwesomeAssertions 9.6.0 and rename the namespaces.** Bump the package, then replace `FluentAssertions` with `AwesomeAssertions` in every `.cs` file and in any `<Using Include="FluentAssertions" />` items in your project files.

   ```bash
   # .NET 10 SDK 10.0.302, AwesomeAssertions 9.6.0
   dotnet add package AwesomeAssertions --version 9.6.0
   grep -rl --include='*.cs' 'FluentAssertions' . | xargs perl -pi -e 's/\bFluentAssertions\b/AwesomeAssertions/g'
   ```

   Before the rename, the build fails with a wall of `CS0246` errors (32 in my four-file project), one for the namespace and one for every type it could no longer resolve:

   ```text
   OrderTests.cs(1,7): error CS0246: The type or namespace name 'FluentAssertions' could not be found
   OrderAssertions.cs(14,22): error CS0246: The type or namespace name 'AssertionChain' could not be found
   TestSetup.cs(4,12): error CS0246: The type or namespace name 'AssertionEngineInitializer' could not be found
   ```

   I use `perl` rather than `sed -i` because the macOS and GNU flags differ, and `\b` keeps `FluentAssertionsExtensions`-style identifiers you wrote yourself from being half-renamed. Verify: `dotnet test` passes, and `bin/Debug/<tfm>/` contains `AwesomeAssertions.dll` and no `FluentAssertions.dll`.

5. **Clean up the leftovers.** Search for the string `FluentAssertions` outside `.cs` files: `.editorconfig` rules for the old analyzer, `[assembly: InternalsVisibleTo]`, documentation, `Directory.Build.props` global usings, and CI scripts that filter by assembly name. Verify: `grep -rn FluentAssertions . --exclude-dir=bin --exclude-dir=obj` returns nothing you did not intend to keep.

You can collapse steps 1 to 4 into one commit and go straight from FluentAssertions 8.11 to AwesomeAssertions 9.6. I split them because the 8.2 hop isolates "did the package swap change behaviour?" from "did the rename miss a file?", and on a large solution that makes a red build much easier to read.

## A complete test project, before and after

The setup file is where both differences live. This is the FluentAssertions 8.11 version:

```csharp
// .NET 10, C# 14, FluentAssertions 8.11.0
using FluentAssertions;
using FluentAssertions.Extensibility;

[assembly: AssertionEngineInitializer(typeof(Shop.Tests.TestSetup), nameof(Shop.Tests.TestSetup.Initialize))]

namespace Shop.Tests;

public static class TestSetup
{
    public static void Initialize()
    {
        License.Accepted = true;
        AssertionConfiguration.Current.Equivalency.Modify(options => options
            .Using<DateTime>(ctx => ctx.Subject.Should().BeCloseTo(ctx.Expectation, TimeSpan.FromSeconds(1)))
            .WhenTypeIs<DateTime>());
    }
}
```

And the AwesomeAssertions 9.6 version. Two `using` lines changed and one line is gone; the global equivalency configuration is untouched:

```csharp
// .NET 10, C# 14, AwesomeAssertions 9.6.0
using AwesomeAssertions;
using AwesomeAssertions.Extensibility;

[assembly: AssertionEngineInitializer(typeof(Shop.Tests.TestSetup), nameof(Shop.Tests.TestSetup.Initialize))]

namespace Shop.Tests;

public static class TestSetup
{
    public static void Initialize()
    {
        AssertionConfiguration.Current.Equivalency.Modify(options => options
            .Using<DateTime>(ctx => ctx.Subject.Should().BeCloseTo(ctx.Expectation, TimeSpan.FromSeconds(1)))
            .WhenTypeIs<DateTime>());
    }
}
```

Custom assertion classes built on the v8 extensibility API port the same way. This one compiled and passed unchanged apart from its three `using` lines:

```csharp
// .NET 10, C# 14, AwesomeAssertions 9.6.0 (was FluentAssertions 8.11.0)
using AwesomeAssertions;
using AwesomeAssertions.Execution;
using AwesomeAssertions.Primitives;

namespace Shop.Tests;

public static class OrderAssertionExtensions
{
    public static OrderAssertions Should(this Order instance) => new(instance, AssertionChain.GetOrCreate());
}

public class OrderAssertions : ObjectAssertions<Order, OrderAssertions>
{
    private readonly AssertionChain chain;

    public OrderAssertions(Order instance, AssertionChain chain) : base(instance, chain) => this.chain = chain;

    protected override string Identifier => "order";

    [CustomAssertion]
    public AndConstraint<OrderAssertions> HaveTotal(decimal expected, string because = "", params object[] becauseArgs)
    {
        chain
            .BecauseOf(because, becauseArgs)
            .ForCondition(Subject.Total == expected)
            .FailWith("Expected {context:order} to have total {0}{reason}, but found {1}.", expected, Subject.Total);

        return new AndConstraint<OrderAssertions>(this);
    }
}
```

The tests that use it (`BeEquivalentTo` with `Excluding`, `ThrowAsync<T>().WithMessage`, an `AssertionScope` with `5.Seconds()` from the `Extensions` namespace) needed nothing but the `using` change. A side note on that class: deriving from `ReferenceTypeAssertions<Order, OrderAssertions>` instead of `ObjectAssertions` hides `BeEquivalentTo` behind your custom `Should()` with `CS1061`. That is true on both libraries and not a migration issue, but it is a common surprise when people first write a typed `Should()` extension.

## Migrating a large solution one file at a time

AwesomeAssertions 9.x and FluentAssertions 8.x can be referenced from the same test project because their namespaces and assembly names no longer collide. I added `FluentAssertions` 8.11.0 back next to `AwesomeAssertions` 9.6.0 and kept one file on `using FluentAssertions;`: the suite built and ran 5 of 5 tests. The rule is one library per file. A file that imports both namespaces fails on every `Should()` call:

```text
Mixed.cs(9,55): error CS0121: The call is ambiguous between the following methods or properties: 'AwesomeAssertions.AssertionExtensions.Should(int)' and 'FluentAssertions.AssertionExtensions.Should(int)'
```

The AwesomeAssertions [upgrade guide](https://github.com/AwesomeAssertions/AwesomeAssertions/blob/main/docs/_pages/upgradingtov9.md) suggests a different staging approach: move all your `using FluentAssertions;` directives into `<Using Include="FluentAssertions" />` items in the project file first, so the final rename touches one file per project. It also points out why you cannot alias your way out of the rename: a `global using` alias cannot map one namespace onto another. Keep in mind that while FluentAssertions 8 is still referenced, its license terms and its console notice still apply to that project.

## Verification

- `dotnet build` with zero errors and no new warnings.
- `dotnet test` reports the same total and passed counts as on FluentAssertions 8.
- Break one assertion on purpose and read the failure message. It should still name the subject (`Expected order to have total 30M, but found 25M.`), which confirms `[CustomAssertion]` caller identification survived.
- `dotnet list package --include-transitive` shows no `FluentAssertions` package.
- The build output contains `AwesomeAssertions.dll` and no `FluentAssertions.dll`.
- A detailed-verbosity test run (`dotnet test --logger "console;verbosity=detailed"`) contains no "Xceed License Agreement" text.

## Rollback plan

The migration is fully reversible. Revert the commit, or flip the `PackageReference` back to `FluentAssertions` 8.11.0, run the rename in reverse (`AwesomeAssertions` to `FluentAssertions`) and restore `License.Accepted = true` if you hold a license. There is no data, schema or serialized state involved, so nothing outlives the revert.

## Gotchas a find-and-replace walks into

**A transitive FluentAssertions silently replaces AwesomeAssertions 8.x.** This is the one worth reading twice. AwesomeAssertions 8.x ships its code as `lib/net6.0/FluentAssertions.dll`, the same file name as the real FluentAssertions package. If any other package pulls in `FluentAssertions` transitively, MSBuild's conflict resolution picks one of the two DLLs by assembly version and emits no warning at all. I reproduced this by adding `FluentAssertions.Json` 8.0.0 (which depends on `FluentAssertions` 8.0.0) to the AwesomeAssertions 8.2 project. The higher assembly version won, so `bin/` held the AwesomeAssertions copy (8.2.0.0 beats 8.0.0.0). Then I added a direct `FluentAssertions` 8.11.0 reference, standing in for any other package that resolves a newer FluentAssertions. The build still printed no warning, the `FluentAssertions.dll` in `bin/` was now byte-identical to the Xceed package's copy, and the test run printed the Xceed license notice again. Your project file says AwesomeAssertions; your tests run on FluentAssertions. Two fixes: move on to AwesomeAssertions 9.x, whose `AwesomeAssertions.dll` cannot collide, and treat `dotnet list package --include-transitive | grep -i fluentassertions` as a CI check.

**Companion packages pin the wrong core.** `FluentAssertions.Web` 3.0.0 depends on `FluentAssertions` in the range `[6.5.1, 8.0.0)`, and `FluentAssertions.Json` 8.0.0 on `FluentAssertions` 8.0.0. Leaving either one in place after the swap drags the old package back, which is the gotcha above. Their replacements, `AwesomeAssertions.Web` 3.0.0 and `AwesomeAssertions.Json` 9.0.0, depend on `AwesomeAssertions` 9.0.0. For third-party extensions, look for an `.AwesomeAssertions` variant on NuGet first: WireMock.Net, CSharpFunctionalExtensions and bUnit extensions all have one.

**Your own types named after the library.** A blanket `s/FluentAssertions/AwesomeAssertions/` also renames your `FluentAssertionsExtensions` helper class or a `MyCompany.Testing.FluentAssertions` namespace. The `\b` word boundary in the `perl` command protects compound identifiers, but not a namespace segment that is exactly `FluentAssertions`. Grep for `namespace .*FluentAssertions` before running the rename.

**`License.Accepted` hidden in a shared helper.** If the flag lives in a shared test-utilities project or a `[ModuleInitializer]`, the `CS0103` shows up there, not in the project you just migrated. Migrate shared test libraries first, or at the same time as their consumers, because a shared project on FluentAssertions 8 forces every consumer to reference it too.

**The next major is not a rename.** The unreleased section of the AwesomeAssertions [release notes](https://github.com/AwesomeAssertions/AwesomeAssertions/blob/main/docs/_pages/releases.md) already lists real breaking changes for the version after 9.6: the .NET 6 build is removed and .NET Framework moves to 4.7.2, `ThrowAsync` returns an `ExceptionAssertionsTask<TException>` instead of `Task<ExceptionAssertions<TException>>`, several `MethodInfoSelector` and `PropertyInfoSelector` properties become methods, and `[Pure]` annotations may raise `CA1806`. Pin `9.6.0` explicitly while migrating, and treat the next major as its own upgrade.

## Related

- If you are also leaving Moq, the same one-file-at-a-time approach works for [migrating a test project from Moq to NSubstitute](/2026/11/migrate-a-dotnet-test-project-from-moq-to-nsubstitute/).
- AwesomeAssertions supports xUnit v3, so this is a good moment to [move the project from xUnit v2 to xUnit v3](/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).
- Choosing a test framework in the first place: [xUnit v3 vs NUnit vs MSTest in 2026](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- Swapping the runner as well: [migrate from VSTest to Microsoft.Testing.Platform in .NET 11](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).
- Not to be confused with FluentValidation, which kept its Apache 2.0 license: [Minimal API validation vs FluentValidation in ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/).

## Sources

- AwesomeAssertions: [GitHub repository](https://github.com/AwesomeAssertions/AwesomeAssertions), [release notes](https://github.com/AwesomeAssertions/AwesomeAssertions/blob/main/docs/_pages/releases.md), [upgrading to version 9.0](https://github.com/AwesomeAssertions/AwesomeAssertions/blob/main/docs/_pages/upgradingtov9.md), [documentation site](https://awesomeassertions.org/).
- NuGet: [AwesomeAssertions](https://www.nuget.org/packages/AwesomeAssertions), [AwesomeAssertions.Json](https://www.nuget.org/packages/AwesomeAssertions.Json), [AwesomeAssertions.Web](https://www.nuget.org/packages/AwesomeAssertions.Web), [AwesomeAssertions.Analyzers](https://www.nuget.org/packages/AwesomeAssertions.Analyzers), [FluentAssertions](https://www.nuget.org/packages/FluentAssertions).
- Xceed, [Fluent Assertions licensing](https://xceed.com/products/unit-testing/fluent-assertions/).
- DevClass, [Another open source project shifts to restrictive license: Fluent Assertions](https://www.devclass.com/development/2025/01/16/another-open-source-project-shifts-to-restrictive-license-fluent-assertions-following-xceed-partnership/).
- Microsoft Learn, [the `using` directive](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/using-directive).
