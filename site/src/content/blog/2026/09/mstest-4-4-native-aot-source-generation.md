---
title: "MSTest 4.4 Graduates the Reflection Source Generator, and Native AOT Projects Get It Automatically"
description: "MSTest 4.4 moves MSTest.SourceGeneration out of experimental and aligns it with the MSTest version. Native AOT test projects pick it up with no opt-in, ReflectionFree mode can now skip runtime discovery for plain [TestMethod] and [DataRow], and five AOTSG diagnostics tell you which test shapes will not survive."
pubDate: 2026-09-04
tags:
  - "mstest"
  - "native-aot"
  - "testing"
  - "source-generators"
  - "dotnet"
---

Microsoft published ["Test what you ship: MSTest and Native AOT"](https://devblogs.microsoft.com/dotnet/mstest-source-generation/) on September 3, 2026, and the argument in the title is the whole point. If you publish your app with `PublishAot`, your CI has been validating a different binary than the one your users run: the test host loads on CoreCLR with full reflection, so a member that the trimmer would have removed is still there when the assertion runs. The failure shows up in production instead.

MSTest 4.3 shipped a fix for that in the experimental, independently versioned `MSTest.SourceGeneration` package. MSTest 4.4 graduates it: the package drops the experimental label and moves to the MSTest version line, and `MSTest.Sdk` keeps `MSTest.SourceGeneration`, `MSTest.TestFramework`, and `MSTest.TestAdapter` aligned through `MSTestVersion`.

## Native AOT projects get the generator with no opt-in

A test project that sets `PublishAot` now pulls in the generator automatically:

```xml
<Project Sdk="MSTest.Sdk/4.4.0">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

The test code itself does not change. Ordinary `[TestClass]` and `[TestMethod]` members stay as they are, and the generator emits the registry, attribute data, and invocation delegates at compile time, before the trimmer runs.

For a non-AOT project on `MSTest.Sdk`, the generator is opt-in:

```xml
<EnableMSTestSourceGeneration>true</EnableMSTestSourceGeneration>
```

That also works in reusable test libraries and under Central Package Management, where the SDK generates the matching `PackageVersion` items. It does not work on .NET Standard: the required `MSTest.TestAdapter` runtime hooks do not exist there, and the SDK fails the build with an explicit error rather than producing a broken registry.

## Compile-time discovery changes one rule

Because discovery happens at compile time, `[TestClass]` has to be declared on the class itself. Inheriting it from a base class used to work under reflection and now silently produces nothing. The [MSTEST0069](https://learn.microsoft.com/en-us/dotnet/core/testing/mstest-analyzers/mstest0069) analyzer flags exactly that case, which is the difference between a build warning and a CI run that reports zero tests and exits green.

## What ReflectionFree actually covers in 4.4

`MSTestSourceGenMode` has defaulted to `ReflectionFree` for trimmed and Native AOT projects since MSTest 4.3.2. On a runtime that still has reflection, it falls back for anything the generator did not cover.

4.4 widens the covered set. Reflection-free generation now materializes complete inherited attribute metadata, including `AttributeUsage` and `AllowMultiple`, and on [Microsoft.Testing.Platform](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) it can skip runtime discovery and validation entirely for plain synchronous `[TestMethod]` and `[DataRow]` methods. Async tests, custom test method attributes, `DynamicData`, custom `ITestDataSource` implementations, and ambiguous shapes still take the fallback path. VSTest keeps its existing path either way.

Five diagnostics tell you what reflection-free mode cannot generate: `AOTSG0001` static test class, `AOTSG0002` open generic test class (including one nested in a generic type), `AOTSG0003` a class generated code cannot reach such as a file-local or private-nested class, `AOTSG0004` generic test method, and `AOTSG0005` a test method with a `ref`, `in`, or `out` parameter.

If something breaks and you need to bisect, there is an escape hatch that keeps discovery but restores reflective execution:

```xml
<PropertyGroup>
  <MSTestSourceGenMode>Rooting</MSTestSourceGenMode>
</PropertyGroup>
```

One caveat worth reading before you rewrite a pipeline: the 4.4 behavior is currently in preview builds only, until MSTest 4.4.0 ships. The [MSTest SDK configuration docs](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-sdk) carry the full property list.
