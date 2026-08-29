---
title: "Migrate a .NET solution to Central Package Management with Directory.Packages.props"
description: "Move every package version out of your csproj files into one Directory.Packages.props. Covers a generator script that reconciles conflicting versions with real semver ordering, the before/after dependency-graph diff that proves what moved, NU1008/NU1010/NU1013/NU1507, transitive pinning, GlobalPackageReference, VersionOverride, and why a nested Directory.Packages.props silently shadows the root one."
pubDate: 2026-08-28
template: migration
tags:
  - "migration"
  - "dotnet"
  - "nuget"
  - "csharp"
---

Central Package Management moves every `Version` attribute out of your `.csproj` files and into one `Directory.Packages.props` at the repository root. Turn it on with `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`, declare a `<PackageVersion Include="..." Version="..." />` for every package the solution uses, and delete the `Version` attribute from every `<PackageReference>`. The migration itself is mechanical and scriptable. The part that needs a human is reconciling the packages that are pinned to different versions in different projects, because consolidating them is a real behavioural change, not a formatting change. Everything below was verified against the .NET 10 SDK 10.0.302 with the bundled NuGet 7.6.0.

## What actually changes

Before, each project owns its versions:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
</ItemGroup>
```

After, the project declares only *what* it depends on, and the root file decides *which version*:

```xml
<!-- src/Domain/Domain.csproj -->
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" />
</ItemGroup>
```

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

`Directory.Packages.props` is discovered by walking *up* from each project's directory, the same way `Directory.Build.props` is. It does not have to sit next to the solution file, and nothing imports it explicitly. Note that only the version moves. `PrivateAssets`, `IncludeAssets`, and `ExcludeAssets` stay on the `PackageReference` in the project that needs them, because they are per-project decisions.

## Steps

1. Create `Directory.Packages.props` at the repository root with `ManagePackageVersionsCentrally` set to `true`.
2. Collect every `PackageReference` version across every project and emit one `PackageVersion` item per package id.
3. Resolve the packages that appear at more than one version. This is the only step that is not mechanical.
4. Delete the `Version` attribute from every `PackageReference` in every project.
5. Restore, and diff the resolved dependency graph against the one you captured before you started.

## Generating the file from what you already have

A file-based C# app is a good fit here: one file, no project, and `dotnet run` executes it directly. Capture the versions, report the conflicts, write the props file, then strip the attributes.

```csharp
// migrate-to-cpm.cs -- run with: dotnet run migrate-to-cpm.cs .
#:property ManagePackageVersionsCentrally=false
#:package NuGet.Versioning@6.*

using System.Xml.Linq;
using NuGet.Versioning;

var root = args.Length > 0 ? args[0] : ".";
var projects = Directory.GetFiles(root, "*.csproj", SearchOption.AllDirectories);
var versions = new Dictionary<string, SortedSet<NuGetVersion>>(StringComparer.OrdinalIgnoreCase);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        var id = (string?)reference.Attribute("Include") ?? (string?)reference.Attribute("Update");
        var version = (string?)reference.Attribute("Version") ?? (string?)reference.Element("Version");
        if (id is null || version is null) continue;
        if (!versions.TryGetValue(id, out var set))
            versions[id] = set = new SortedSet<NuGetVersion>();
        if (NuGetVersion.TryParse(version, out var parsed)) set.Add(parsed);
    }
}

foreach (var (id, set) in versions.Where(v => v.Value.Count > 1))
    Console.WriteLine($"conflict: {id} -> {string.Join(", ", set)}");

var props = new XElement("Project",
    new XElement("PropertyGroup",
        new XElement("ManagePackageVersionsCentrally", true),
        new XElement("CentralPackageTransitivePinningEnabled", true)),
    new XElement("ItemGroup",
        versions.OrderBy(v => v.Key, StringComparer.OrdinalIgnoreCase)
                .Select(v => new XElement("PackageVersion",
                    new XAttribute("Include", v.Key),
                    new XAttribute("Version", v.Value.Max()!)))));

File.WriteAllText(Path.Combine(root, "Directory.Packages.props"), props + Environment.NewLine);

foreach (var project in projects)
{
    var doc = XDocument.Load(project);
    var changed = false;
    foreach (var reference in doc.Descendants("PackageReference"))
    {
        if (reference.Attribute("Version") is { } attribute) { attribute.Remove(); changed = true; }
        if (reference.Element("Version") is { } element) { element.Remove(); changed = true; }
    }
    if (changed) doc.Save(project);
}

Console.WriteLine($"wrote {versions.Count} PackageVersion entries from {projects.Length} projects");
```

Two details in that script are load-bearing.

The first is `NuGetVersion` rather than plain strings. Sorting versions as text is wrong, and it is wrong in the direction that silently downgrades you:

```text
string  max: 13.0.3
semver  max: 13.0.10
```

The second is the `#:property ManagePackageVersionsCentrally=false` directive on line 1. Without it, the script breaks itself the instant it succeeds. A file-based app's `#:package` directive lowers to a `PackageReference` *with* a `Version`, and the `Directory.Packages.props` the script just wrote sits in the same directory tree, so the next run fails before `Main` is reached:

```text
migrate-to-cpm.cs.csproj : error NU1008: The following PackageReference items cannot define a value for
Version: NuGet.Versioning. Projects using Central Package Management must define a Version value on a
PackageVersion item.
```

That is worth remembering beyond this script: turning on CPM at the repository root applies to every file-based `.cs` app in the repository too, and `#:package` is not compatible with it. Opt each one out with `#:property`, or keep your scripts outside the tree.

## The conflicts are the migration

Run the script against a solution where three projects disagree and you get the actual work item list:

```text
conflict: Serilog -> 4.1.0, 4.2.0
conflict: Newtonsoft.Json -> 13.0.1, 13.0.3
wrote 3 PackageVersion entries from 3 projects
```

Taking the highest version, which is what the script does, is the right *default* and the wrong *policy*. It is right because a solution that ships two versions of the same library is usually an accident rather than a decision, and because the lower pin is often the stale one nobody revisited. It is wrong as a policy because "highest wins" is exactly how you unknowingly cross a major version boundary in one project while you were only trying to reorganise your build files. Read the list, and for anything that jumps a major version, migrate that project deliberately instead of letting the script do it.

## Prove what moved

CPM is not a no-op, and the way to know what it actually did is to diff the resolved graph. Capture it before you start, from each project's restore output:

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(k) for t in d['targets'].values() for k in sorted(t)]" src/Domain/obj/project.assets.json
```

Before and after, for the three-project solution above:

```text
            BEFORE                       AFTER
Api       Newtonsoft.Json/13.0.3      Newtonsoft.Json/13.0.3
          Polly/8.5.0                 Polly/8.5.0
          Serilog/4.2.0               Serilog/4.2.0
Domain    Newtonsoft.Json/13.0.1  ->  Newtonsoft.Json/13.0.3
Workers   Serilog/4.1.0           ->  Serilog/4.2.0
          Polly/8.5.0                 Polly/8.5.0
```

Two projects moved. That is the change to test and to put in the pull request description. If your diff is empty, the migration was genuinely mechanical and you can merge it with much less ceremony.

## The four errors you will hit

**NU1008** — a `PackageReference` still carries a `Version`. This is the expected state halfway through the migration and it is an error, not a warning, so a partially migrated repository does not build.

```text
error NU1008: The following PackageReference items cannot define a value for Version: Serilog.
```

**NU1010** — a `PackageReference` has no matching `PackageVersion`. Usually a package that only appears in a project the script did not scan, such as one outside the root you passed it.

```text
error NU1010: The following PackageReference items do not define a corresponding PackageVersion item:
Humanizer.Core.
```

**NU1013** — a `VersionOverride` was used while `CentralPackageVersionOverrideEnabled` is `false`. See the escape hatches below.

**NU1507** — a warning, and the one people ignore:

```text
warning NU1507: There are 2 package sources defined in your configuration. When using central package
management, please map your package sources with package source mapping
(https://aka.ms/nuget-package-source-mapping) or specify a single package source.
The following sources are defined: nuget.org, contoso
```

With one source, nothing changes. With a private feed alongside nuget.org, a centrally declared version is now resolvable from either, which widens the window for a dependency-confusion substitution. Fix it with package source mapping rather than suppressing the warning.

## Transitive pinning

This is the feature that makes CPM worth the migration on its own. Turn it on with `<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>` and any `PackageVersion` you declare also applies to packages that arrive transitively.

Take a project that references `Newtonsoft.Json.Bson` and nothing else. Its dependency on `Newtonsoft.Json >= 12.0.1` resolves to exactly that, even though `Directory.Packages.props` declares 13.0.3, because a `PackageVersion` with no matching `PackageReference` does nothing by default:

```text
warning NU1903: Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability
```

Flip transitive pinning on and the same restore is clean:

```text
Top-level Package           Requested   Resolved
> Newtonsoft.Json.Bson      1.0.2       1.0.2

Transitive Package      Resolved
> Newtonsoft.Json       13.0.3
```

The package is lifted to 13.0.3 and stays classified as transitive, so it does not become part of your project's public dependency surface or leak into the nuspec of a package you produce. That is the whole point: you get to fix a vulnerable transitive dependency across every project at once without adding a direct reference you will have to remember to delete later.

## GlobalPackageReference

Build-time-only packages that belong in every project, such as source-link providers, analyzers, and versioning tools, get their own item type. Declare it once in `Directory.Packages.props` and touch no `.csproj` at all:

```xml
<ItemGroup>
  <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
</ItemGroup>
```

Note that a `GlobalPackageReference` carries its `Version` inline, unlike a `PackageReference`. It applies everywhere as a top-level reference with development-only asset behaviour, so it will show up in `dotnet package list` for every project. Only use it for packages that genuinely belong in all of them; a package that is global "for now" is very hard to remove later.

## Escape hatches

One project needs a different version, and you have a real reason. `VersionOverride` wins over the central value:

```xml
<PackageReference Include="Newtonsoft.Json" VersionOverride="13.0.1" />
```

If your goal in adopting CPM was to make version drift impossible, close that door with `<CentralPackageVersionOverrideEnabled>false</CentralPackageVersionOverrideEnabled>`, which turns any use of it into NU1013.

A whole project can opt out with `<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>` in its `.csproj`, after which it manages its own versions inline again. Be aware that this also opts the project out of transitive pinning, so a vulnerable transitive dependency that the rest of the solution has lifted comes straight back in that one project.

## Nested Directory.Packages.props shadows, it does not merge

The discovery walk stops at the first file it finds. A `Directory.Packages.props` in a subdirectory therefore replaces the root one completely rather than adding to it, and every project underneath it immediately fails with NU1010 for packages the root file declared. If you need per-area versions, import the parent explicitly and layer on top with `Update`:

```xml
<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Packages.props', '$(MSBuildThisFileDirectory)../'))" />
  <ItemGroup>
    <PackageVersion Update="Newtonsoft.Json" Version="13.0.2" />
  </ItemGroup>
</Project>
```

`Update` rather than `Include`, because the item already exists. Getting this wrong gives you two `PackageVersion` items for one package, which is ambiguous.

## The CLI already knows

You do not need to hand-edit the props file after the migration. The .NET 10 SDK's package commands are CPM-aware and write to the right file on their own.

`dotnet package add Humanizer.Core --project src/Lib1/Lib1.csproj` adds a versionless `PackageReference` to the project *and* inserts a `PackageVersion` into `Directory.Packages.props` in alphabetical order:

```text
info : PackageReference for package 'Humanizer.Core' version '3.0.10' added to file
'/repo/Directory.Packages.props'.
```

`dotnet package update Serilog --project src/App/App.csproj` edits only the central version and leaves the project file alone. `dotnet package list --outdated` still reports correctly, including `GlobalPackageReference` items. `dotnet nuget why <project> <package>` remains the fastest way to find out which reference dragged in a transitive package you are about to pin.

## Related

- CPM pairs naturally with the transitive-dependency cleanup in [NuGet Package Pruning is on by default in .NET 10](/2026/05/nuget-package-pruning-default-net-10/), which removes framework-provided packages from the graph before pinning has to think about them.
- The `#:package` and `#:property` directives used by the migration script are covered in full in [how to run a file-based C# app with `dotnet run app.cs`](/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/).
- Consolidating versions across projects is a good thing to do *before* [migrating from .NET 8 to .NET 11](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), so the framework bump is the only variable in the diff.
- If a project stops compiling after you strip its versions, the cause is usually the reference itself rather than CPM; see [the type or namespace name could not be found after adding a project reference](/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/).
- For a repository that ships several packages of its own, [independently releasing multiple NuGet packages with MinVer and trusted publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) covers the other half of the versioning story.

## Sources

- [Central Package Management](https://learn.microsoft.com/en-us/nuget/consume-packages/central-package-management) in the NuGet documentation, for `PackageVersion`, `GlobalPackageReference`, `VersionOverride`, and transitive pinning.
- [NuGet error and warning reference](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/) for NU1008, NU1010, NU1013, and NU1507.
- [Package source mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping), the recommended answer to NU1507.
- [Customize your build with Directory.Build.props](https://learn.microsoft.com/en-us/visualstudio/msbuild/customize-by-directory) for the directory walk that also governs `Directory.Packages.props`.
