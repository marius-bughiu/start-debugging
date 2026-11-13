---
title: "Fix: \"Package 'X' is incompatible with 'all' frameworks in project\" on dotnet add package"
description: "The message is a catch-all: dotnet add package prints it for any failed restore. Scroll up to the NU1101, NU1102, NU1202 or NU1301 line, and drop --source, which hides every other feed."
pubDate: 2026-11-13
template: error-page
tags:
  - "errors"
  - "nuget"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-cli"
---

The fix: ignore the word "incompatible" and read the `error: NU....` line printed just above it. `dotnet add package` (and `dotnet package add`) runs a trial restore, and when that restore fails for any reason it reports the package as incompatible with "all" frameworks. The most common cause from a private feed is `--source`: it makes that one feed the only source for the whole restore, so the package's own dependencies from nuget.org cannot be found. Drop `--source` and let `nuget.config` list both feeds, or fix the package source mapping that routes your package ID nowhere.

Everything below was reproduced on macOS with the .NET 10 SDK 10.0.302 (NuGet 7.6.0) and cross-checked on the .NET 9 SDK 9.0.321 (NuGet 6.14.3). Both SDKs print the same message for the same causes. The consumer project targets `net8.0`, and every run used an empty global packages folder (`NUGET_PACKAGES` pointed at a fresh directory) unless stated otherwise, because a warm cache hides most of these failures.

## The error in context

The searchable line is the last one, but the useful one is above it:

```text
// .NET SDK 10.0.302, dotnet add package Acme.Client --source <private feed> --version 2.2.3
info : Adding PackageReference for package 'Acme.Client' into project 'App.csproj'.
info : Restoring packages for App.csproj...
info : Installed Acme.Client 2.2.3 from ./feed to ~/.nuget/packages/acme.client/2.2.3 with content hash QEyY...
error: NU1101: Unable to find package Newtonsoft.Json. No packages exist with this id in source(s): acme
error: NU1101: Unable to find package Microsoft.AspNetCore.App.Ref. No packages exist with this id in source(s): acme
error: NU1101: Unable to find package Microsoft.NETCore.App.Host.osx-arm64. No packages exist with this id in source(s): acme
error: NU1101: Unable to find package Microsoft.NETCore.App.Ref. No packages exist with this id in source(s): acme
error: Package 'Acme.Client' is incompatible with 'all' frameworks in project 'App.csproj'.
```

Notice that NuGet actually installed `Acme.Client`. The package is perfectly compatible with `net8.0`. What failed was everything else the restore needed.

## Why dotnet add package calls a failed restore "incompatible"

The [`dotnet package add` docs](https://learn.microsoft.com/dotnet/core/tools/dotnet-package-add) describe the flow: the command runs a "compatibility check" first, and only writes the `<PackageReference>` if that check passes. The check is a full restore preview of the project with the new reference added. The command does not distinguish between "the restore failed because the package has no asset for your TFM" and "the restore failed because something could not be downloaded". Any restore error ends in the same summary line, and the project file is left untouched.

So the message has at least five different root causes, all of which produced the identical last line in these repros:

| Error above the summary | Real cause |
| --- | --- |
| `NU1101` for the package's dependencies or `Microsoft.NETCore.App.Ref` | `--source` restricted the restore to one feed |
| `NU1101 ... PackageSourceMapping is enabled, the following source(s) were not considered` | Source mapping does not route the package ID to the feed that has it |
| `NU1102: Unable to find package X with version (>= ...)` | The version does not exist on any configured source |
| `NU1202: Package X is not compatible with net8.0` | Genuinely incompatible: the package has no asset for your target framework |
| `NU1301: Unable to load the service index` | A source is unreachable or rejects your credentials |

Only one row of five is what the message claims.

## Minimal repro with a local folder feed

The setup mirrors the common Stack Overflow report: an internal package that depends on a public package, published to a private feed, added from a script with `--source`.

```xml
<!-- .NET SDK 10.0.302: pkgsrc/Acme.Client.csproj, packed into ./feed -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <PackageId>Acme.Client</PackageId>
    <Version>2.2.3</Version>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
```

```xml
<!-- .NET SDK 10.0.302: app/nuget.config, both feeds configured -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="acme" value="/path/to/feed" />
  </packageSources>
</configuration>
```

```bash
# .NET SDK 10.0.302, empty global packages folder
cd pkgsrc && dotnet pack -c Release -o ../feed && cd ../app
export NUGET_PACKAGES=$PWD/../gp-empty

dotnet add package Acme.Client --source /path/to/feed --version 2.2.3   # fails: incompatible with 'all'
dotnet add package Acme.Client --version 2.2.3                          # works
```

The same `--source` command succeeds once the global packages folder already holds `Newtonsoft.Json` and the targeting packs. That is why the original asker saw it work after installing the package once through Visual Studio: Visual Studio restored with every configured source and filled the cache, and from then on the restricted restore never needed to download anything.

## Fix 1: stop passing --source

`-s|--source` on `dotnet add package` is documented as "the URI of the NuGet package source to use during the restore operation". In practice it replaces the sources from `nuget.config` for that restore instead of adding to them. Your private feed rarely hosts `Newtonsoft.Json`, and it never hosts `Microsoft.NETCore.App.Ref`, which the SDK downloads when you target a framework older than the SDK itself (here, `net8.0` under SDK 10).

Put the private feed in the `nuget.config` next to the solution and call the command without `--source`:

```bash
# .NET SDK 10.0.302
dotnet nuget add source https://pkgs.example.com/v3/index.json --name acme --configfile nuget.config
dotnet add package Acme.Client --version 2.2.3
```

You cannot work around it by passing two sources. Both SDKs reject a repeated option:

```text
// .NET SDK 10.0.302
$ dotnet package add Acme.Client@2.2.3 --source ./feed --source https://api.nuget.org/v3/index.json
Option '--source' expects a single argument but 2 were provided.
```

If a script really must control the source list, split the two steps. `--no-restore` skips the compatibility check and just writes the reference, and `dotnet restore` does accept `-s` more than once:

```bash
# .NET SDK 10.0.302: write the reference, then restore against both feeds
dotnet add package Acme.Client --version 2.2.3 --no-restore
dotnet restore -s https://pkgs.example.com/v3/index.json -s https://api.nuget.org/v3/index.json
```

That pair restored cleanly against an empty cache in the repro.

### Pass a URL or path, not a source name

The original question passed a source *name* from `nuget.config` (`--source "ics-powershell"`). In these repros, neither SDK 10.0.302 nor SDK 9.0.321 resolved a name passed to `dotnet add package --source` or `dotnet restore --source`. Both treated it as a relative folder path:

```text
// .NET SDK 10.0.302, dotnet add package Newtonsoft.Json --source nuget.org
error: NU1301: The local source '/.../app/nuget.org' doesn't exist.
error: Unable to find a resolved package for 'Newtonsoft.Json'. This is a tooling error. Please file an issue at https://github.com/NuGet/Home.
```

Here the summary line is different ("Unable to find a resolved package"), but the cause is the same family: a restore that could not reach anything. Use the feed's full `index.json` URL or folder path when you pass `--source`.

## Fix 2: map the package ID in packageSourceMapping

With [package source mapping](https://learn.microsoft.com/nuget/consume-packages/package-source-mapping) enabled, every package ID must match a pattern on the source it should come from. A mapping that sends `*` to nuget.org and only `Contoso.*` to the private feed silently excludes `Acme.Client` from the feed that has it:

```xml
<!-- .NET SDK 10.0.302: nuget.config that reproduces the error -->
<packageSourceMapping>
  <packageSource key="nuget.org">
    <package pattern="*" />
  </packageSource>
  <packageSource key="acme">
    <package pattern="Contoso.*" />
  </packageSource>
</packageSourceMapping>
```

```text
// .NET SDK 10.0.302
error: NU1101: Unable to find package Acme.Client. No packages exist with this id in source(s): nuget.org. PackageSourceMapping is enabled, the following source(s) were not considered: acme.
error: Package 'Acme.Client' is incompatible with 'all' frameworks in project 'App.csproj'.
```

Add a pattern for your prefix on the private source (`<package pattern="Acme.*" />`) and the same command restores. The longest matching pattern wins, so `Acme.*` on `acme` beats `*` on nuget.org. If you are on [Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/), this is the cause to check first: CPM and source mapping usually arrive together, and the first internal package added after the switch is the one that trips it.

This failure is also masked by a warm cache. With `Acme.Client` already in the global packages folder from an earlier restore, the mismatched mapping above restored without a single error, so a teammate with a fresh machine or a clean CI agent hits the error that works for you.

## Fix 3: the version or the framework really is wrong

Two of the causes are not configuration problems, and the line above the summary says so plainly.

`NU1102` means the ID exists but the version you asked for does not:

```text
// .NET SDK 10.0.302, dotnet add package Acme.Client --version 9.9.9
error: NU1102: Unable to find package Acme.Client with version (>= 9.9.9)
error:   - Found 2 version(s) in acme [ Nearest version: 3.0.0 ]
error:   - Found 0 version(s) in nuget.org
error: Package 'Acme.Client' is incompatible with 'all' frameworks in project 'App.csproj'.
```

On Azure Artifacts, "the version is in the feed but NU1102 says otherwise" is a permissions or feed-view problem, covered in detail in [the Azure DevOps "Unable to find version" fix](/2026/10/fix-azure-devops-nuget-restore-unable-to-find-version-of-package-from-an-internal-feed/).

`NU1202` is the only case where the summary is literally true. Packing `Acme.Client` 3.0.0 for `net10.0` and adding it to the `net8.0` app gives:

```text
// .NET SDK 10.0.302
error: NU1202: Package Acme.Client 3.0.0 is not compatible with net8.0 (.NETCoreApp,Version=v8.0). Package Acme.Client 3.0.0 supports: net10.0 (.NETCoreApp,Version=v10.0)
error: Package 'Acme.Client' is incompatible with 'all' frameworks in project 'App.csproj'.
```

Either pick an older package version that still ships a `net8.0` (or `netstandard2.0`) asset, or retarget the project. With .NET 8 and 9 having [reached end of support on November 10, 2026](/2026/11/dotnet-8-and-dotnet-9-reach-end-of-support-on-november-10-2026/), more internal packages are dropping `net8.0`, so expect to see this one more often.

## Fix 4: the feed is unreachable or rejects you

An unreachable or unauthenticated source fails the restore with `NU1301`. In the repro, adding an unreachable feed produced:

```text
// .NET SDK 10.0.302, --source https://localhost:9/v3/index.json
error: NU1301: Unable to load the service index for source https://localhost:9/v3/index.json.
error:   Connection refused (localhost:9)
warn : NU1900: Error occurred while getting package vulnerability data: Unable to load the service index for source https://localhost:9/v3/index.json.
error: Unable to find a resolved package for 'Acme.Client'. This is a tooling error. Please file an issue at https://github.com/NuGet/Home.
```

For an authenticated feed such as Azure Artifacts, run the command with `--interactive` so the credential provider can prompt, or make sure the credential provider is installed and signed in before a script runs. A script that works from Visual Studio but not from a console usually differs exactly here: Visual Studio supplies the feed credentials itself.

## Getting the full restore log

The `dotnet add package` command has no verbosity switch. `-v` is `--version`, which is why `-v detailed` fails with `error: 'detailed' is not a valid version string.` instead of making the output louder. When the `NU` line above the summary is not enough, reproduce the restore on its own:

```bash
# .NET SDK 10.0.302
dotnet add package Acme.Client --version 2.2.3 --no-restore
dotnet restore -v detailed
```

`dotnet restore` honors `-v`, prints every source it queries and every HTTP status, and leaves the reference in the project so you can iterate. Revert the project file if the restore cannot be fixed. To see which package pulled in a failing transitive dependency, `dotnet nuget why App.csproj Newtonsoft.Json` prints the dependency path once a restore has succeeded somewhere.

## Lookalikes that land here

- **`Unable to find a resolved package for 'X'. This is a tooling error.`** Same family, printed when the restore failed before any graph was built, usually `NU1301` (bad source name, unreachable feed).
- **`NU1608` / `NU1107` version conflicts.** A different restore failure with its own fix path, walked through in the [Pomelo and EF Core 10 conflict post](/2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10/).
- **Package signature failures (`NU3034`, `NU3018`).** If `trustedSigners` is configured and a certificate rotated, the add fails on the signature check, not on compatibility. See [the NuGet author-signing certificate rotation post](/2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034/).

## Related

- [Migrate a .NET solution to Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/), where `dotnet add package` writes the `PackageVersion` into `Directory.Packages.props` and the reference without a version.
- [Fix Azure DevOps NuGet restore "Unable to find version"](/2026/10/fix-azure-devops-nuget-restore-unable-to-find-version-of-package-from-an-internal-feed/) for feed roles, views and the HTTP cache.
- [Fix NU1608 and NU1107 version conflicts with Pomelo and EF Core 10](/2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10/).
- [Fix NU3034 after Microsoft's NuGet signing certificate rotation](/2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034/).

## Sources

- [`dotnet package add` command reference](https://learn.microsoft.com/dotnet/core/tools/dotnet-package-add) (compatibility check, `--source`, `--no-restore`).
- [Package source mapping](https://learn.microsoft.com/nuget/consume-packages/package-source-mapping) on Microsoft Learn.
- NuGet error references: [NU1101](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1101), [NU1102](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1102), [NU1202](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1202), [NU1301](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1301).
- Stack Overflow: [Package is incompatible with 'all' frameworks in project when package does not already exist in the global packages folder](https://stackoverflow.com/questions/79816613).
