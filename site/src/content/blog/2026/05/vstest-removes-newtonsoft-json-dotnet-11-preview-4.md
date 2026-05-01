---
title: "VSTest drops Newtonsoft.Json in .NET 11 Preview 4 and what breaks if you relied on it transitively"
description: ".NET 11 Preview 4 and Visual Studio 18.8 ship a VSTest that no longer flows Newtonsoft.Json into your test projects. Builds that quietly used the transitive copy will break with a single PackageReference fix."
pubDate: 2026-05-01
tags:
  - "dotnet-11"
  - "vstest"
  - "newtonsoft-json"
  - "system-text-json"
  - "testing"
---

The .NET team [announced on April 29](https://devblogs.microsoft.com/dotnet/vs-test-is-removing-its-newtonsoft-json-dependency/) that VSTest, the engine behind `dotnet test` and Visual Studio's Test Explorer, is finally cutting its dependency on `Newtonsoft.Json`. The change lands in .NET 11 Preview 4 (planned May 12, 2026) and Visual Studio 18.8 Insiders 1 (planned June 9, 2026). On .NET, VSTest switches its internal serializer to `System.Text.Json`. On .NET Framework, where `System.Text.Json` is too heavy a payload, it uses a small library called JSONite. The work is tracked in [microsoft/vstest#15540](https://github.com/microsoft/vstest/pull/15540) and the SDK breaking change in [dotnet/docs#53174](https://github.com/dotnet/docs/issues/53174).

## Most projects do not need to do anything

If your test project already declares `Newtonsoft.Json` with a normal `PackageReference`, nothing changes. The package keeps working, and any code that uses `JObject`, `JToken`, or the `JsonConvert` static keeps compiling. The single public type VSTest used to expose, `Newtonsoft.Json.Linq.JToken`, lived on one spot of the VSTest communication protocol, and the team's own assessment is that essentially no real-world consumers depend on that surface.

## Where it actually breaks

The interesting failure mode is the project that never asked for `Newtonsoft.Json` and got it anyway, because VSTest dragged the assembly along. Once Preview 4 cuts the transitive flow, that copy disappears at runtime and you see a `FileNotFoundException` for `Newtonsoft.Json` during the test run. The fix is one line in the `.csproj`:

```xml
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
</ItemGroup>
```

The second flavour is projects that explicitly excluded the runtime asset of a transitive `Newtonsoft.Json`, usually to keep deployment payloads small:

```xml
<PackageReference Include="Newtonsoft.Json" Version="13.0.3">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

That used to work because VSTest itself shipped the runtime DLL. After Preview 4 it stops working for the same reason: nobody is bringing the binary along anymore. Drop the `ExcludeAssets` element or move the package to a project that does ship its runtime.

## Why bother

Carrying `Newtonsoft.Json` inside the test platform was an old compatibility wart. It pinned a 13.x major into every test session, surfaced occasional binding-redirect drama on .NET Framework, and forced teams that intentionally banned `Newtonsoft.Json` from their app to still tolerate it under tests. Using `System.Text.Json` on .NET shrinks the test host's footprint and lines test execution up with the rest of the modern SDK ([related: System.Text.Json in .NET 11 Preview 3](/2026/04/system-text-json-11-pascalcase-per-member-naming/)). For .NET Framework, JSONite keeps the same protocol on a tiny dedicated parser instead of a shared library that has bitten teams before.

If you want to know early whether you are in the broken bucket, point your CI at the preview package [Microsoft.TestPlatform 1.0.0-alpha-stj-26213-07](https://www.nuget.org/packages/Microsoft.TestPlatform/1.0.0-alpha-stj-26213-07) and run your existing test suite. A green build now means a green build on May 12.
