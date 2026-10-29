---
title: "Fix: Azure DevOps NuGet restore fails with \"Unable to find version 'x.y.z' of package\" from an internal feed"
description: "The version exists, but the pipeline cannot see it. Check the build identity's feed role, the feed view in the URL, which nuget.config the task uses, package source mapping, and the 30-minute HTTP cache."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "nuget"
  - "azure-devops"
  - "dotnet"
  - "dotnet-10"
  - "ci-cd"
---

The fix: when an Azure Artifacts feed has the package but the pipeline restore says it cannot find the version, the build is almost never asking the feed you think it is asking, or it is asking with an identity that cannot see that version. Check these in order: does the pipeline's build identity have the **Feed and Upstream Reader (Collaborator)** role on the feed? (Plain **Feed Reader** cannot pull a version from an upstream source like NuGet.org that has not been saved to the feed yet.) Does the feed URL point at a view such as `@Release` that the version was never promoted to? Is the restore task using your repo's `nuget.config`, or a generated one? Does `packageSourceMapping` route the package ID to a different source? Last, is a self-hosted agent serving a stale version list from NuGet's 30-minute HTTP cache?

Everything below was verified with the .NET 10 SDK (10.0.302, NuGet 7.6.0) and the current Azure DevOps Services tasks (`NuGetAuthenticate@1`, `DotNetCoreCLI@2`, `NuGetCommand@2`) as of October 2026. The same causes apply to .NET 8, 9, and the .NET 11 previews, because the error comes from NuGet's resolver and the feed's permission model, not from the SDK version.

The error comes in two shapes depending on which client runs the restore. `nuget.exe restore` on a `packages.config` project prints the older message:

```text
// nuget.exe 6.x/7.x, packages.config restore
Unable to find version '1.5.0' of package 'Contoso.Core'.
  https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json: Package 'Contoso.Core.1.5.0' is not found on source 'https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json'.
```

`dotnet restore`, `msbuild -t:restore`, and `nuget.exe` on PackageReference projects print `NU1102` instead, and that version is far more useful because it tells you what each source actually returned:

```text
// dotnet restore, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Read that second line carefully. "Found 1 version(s)" means authentication worked and the package ID was found. The feed simply did not return `1.5.0` to this caller. That narrows the problem to "which versions does this identity, through this URL, get to see", which is exactly what the causes below control.

## Why the version exists in the browser but not in the pipeline

When you open the feed in the Azure DevOps web UI, you are looking at it as yourself (often a Feed Owner), through the default `@Local` view, with every upstream source enabled. The pipeline sees the feed as a different principal, possibly through a different URL, using a `nuget.config` you may not have written. Each of these can hide a version:

1. **Upstream versions need a role that can save them.** Azure Artifacts serves a package from an upstream (NuGet.org, another feed) by saving a copy into your feed on first request. Per the [feed permissions table](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions), "Save packages from upstream sources" requires **Feed and Upstream Reader (Collaborator)** or higher. A build identity that only has **Feed Reader** can restore versions that are already saved, but not new ones. Your laptop restored `1.5.0` fine last week because you are a Collaborator and your restore saved it; the next version that nobody has restored yet fails in CI.
2. **The wrong build identity.** A pipeline runs as either `Project Collection Build Service (<org>)` or `<Project> Build Service (<org>)`. Which one depends on the "Limit job authorization scope to current project" setting. Granting the role to the other one does nothing.
3. **A view URL.** `.../_packaging/contoso-internal@Release/nuget/v3/index.json` only exposes versions promoted to `@Release`. A freshly published `1.5.0` lives in `@Local` until someone promotes it.
4. **The task ignored your `nuget.config`.** `DotNetCoreCLI@2` and `NuGetCommand@2` with `feedsToUse: 'select'` generate a temporary config containing only the feed you picked in `vstsFeed` (plus NuGet.org if `includeNuGetOrg` is true).
5. **Package source mapping** sends `Contoso.*` to one source, and the version you need is on another. NuGet then reports that versions from the other source "were not considered".
6. **Stale HTTP cache.** On a self-hosted agent, NuGet reuses the cached version list for a package for up to 30 minutes, so a version published five minutes ago is invisible to the next run.
7. **Upstream delay or a blocked external version.** NuGet.org packages can take 3 to 6 hours to appear through an upstream, and a package ID you also publish internally may have external versions blocked.

## Minimal repro: the same NU1102 from a local folder feed

You do not need Azure DevOps to see what NuGet does when a source returns fewer versions than you asked for. This repro simulates causes 1 and 3 locally with a source that only "shows" `1.4.0` to the caller.

```bash
# .NET SDK 10.0.302, macOS/Linux shell
mkdir -p feed lib app
cd lib && dotnet new classlib -n Contoso.Core -o . -f net10.0
dotnet pack -c Release -p:Version=1.4.0 -o ../feed
cd ../app && dotnet new console -f net10.0
dotnet add package Contoso.Core --version 1.5.0 --no-restore
```

```xml
<!-- app/nuget.config, NuGet 7.6 -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="contoso-internal" value="../feed" />
  </packageSources>
</configuration>
```

```text
// dotnet restore output, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

That is byte-for-byte the shape you get from Azure Artifacts when the build identity cannot save `1.5.0` from an upstream, or when the URL points at a view that only has `1.4.0`. The restore is not broken. It is faithfully reporting what the source gave it.

## Fix 1: give the right build identity the Collaborator role

This is the cause behind most "it works on my machine" reports, because developers are usually Collaborators or higher and the build identity on older feeds is often just a Reader.

1. Find out which identity the pipeline runs as. In **Project settings > Pipelines > Settings**, check **Limit job authorization scope to current project for non-release pipelines**. If it is on, the identity is `<Project> Build Service (<org>)`. If it is off, it is `Project Collection Build Service (<org>)`. Release pipelines have their own toggle on the same page.
2. Open **Artifacts**, pick the feed, select the gear icon for **Feed settings**, then **Permissions**.
3. Add that identity (search for "Build Service") with the role **Feed and Upstream Reader (Collaborator)**. If the pipeline also pushes packages, give both build identities **Feed Publisher (Contributor)**, as the docs recommend.
4. If the feed lives in a different project than the pipeline and you use the project-scoped identity, that other project also has to grant the identity at least **Edit project-level information**, per the note at the bottom of [Manage permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions#pipelines-permissions).

On Azure DevOps Services, new feeds already grant both build identities the Collaborator role. Feeds created before that default, feeds created on Azure DevOps Server 2022 (where only the collection identity gets it), and feeds whose permissions someone "tightened" are the ones that break.

Then make sure the pipeline authenticates at all. With the .NET CLI, `NuGetAuthenticate@1` is the supported way, and on Ubuntu 24.04 and later hosted images it is required, because `nuget.exe` is no longer supported there:

```yaml
# Azure Pipelines YAML, .NET SDK 10.0.302, NuGetAuthenticate@1
steps:
- task: UseDotNet@2
  inputs:
    packageType: sdk
    version: '10.0.x'

- task: NuGetAuthenticate@1

- script: dotnet restore MySolution.sln --configfile nuget.config
  displayName: Restore
```

`NuGetAuthenticate@1` installs the Azure Artifacts credential provider and hands it the job's access token for every Azure Artifacts feed in the same organization. For a feed in another organization, create a PAT with **Packaging > Read**, wrap it in a NuGet service connection, and pass it via `nuGetServiceConnections`, as shown in [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore).

## Fix 2: point at the view that actually contains the version

Look at the feed URL in your `nuget.config`. Anything after an `@` in the feed segment is a view:

```xml
<!-- nuget.config, NuGet 7.6: the @Release view only sees promoted versions -->
<add key="contoso-internal"
     value="https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal@Release/nuget/v3/index.json" />
```

Every feed starts with `@Local`, `@Prerelease`, and `@Release`. `@Local` contains everything published to the feed plus everything saved from upstreams. `@Prerelease` and `@Release` only contain what a Feed Publisher explicitly promoted. Either promote the version (open the package, choose **Promote**, pick the view), or have the producing pipeline promote it as its last step. If the consuming build should see unpromoted versions, drop the `@Release` suffix so it uses the feed's default view.

The same applies when the version you need comes through a feed-to-feed upstream. The upstream definition names a view of the other feed, so a version that is not promoted there is invisible through your feed too.

## Fix 3: stop the task from replacing your nuget.config

This YAML looks harmless but throws away your repo's `nuget.config`:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2: generates a temporary nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: select
    vstsFeed: 'contoso-internal'
    includeNuGetOrg: false
```

With `feedsToUse: select`, the task writes a temporary config with only `vstsFeed` (and NuGet.org if `includeNuGetOrg: true`). If your `nuget.config` lists two feeds, or uses a project-scoped feed URL with the project segment, or contains `packageSourceMapping`, none of that applies to this restore. Tell the task to use your file instead:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2 with the repo's nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: config
    nugetConfigPath: 'nuget.config'
```

Or skip the restore task entirely and run `dotnet restore --configfile nuget.config` after `NuGetAuthenticate@1`, as in Fix 1. That has the advantage that what CI runs is exactly what a developer runs locally.

While you are in that file, follow Microsoft's own advice for upstream feeds: start `<packageSources>` with `<clear />` and list exactly one Azure Artifacts feed with upstreams enabled. NuGet queries all sources in parallel and takes the first answer, so two sources make restores nondeterministic. A single feed with upstreams searches in a fixed order: packages published to the feed, then packages saved from upstreams, then each upstream in the order configured.

## Fix 4: check package source mapping

If the repo uses [package source mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping), the error tells you directly:

```text
// dotnet restore output, .NET SDK 10.0.302, with packageSourceMapping
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
error NU1102:   - Versions from contoso-release were not considered
```

"Were not considered" means the version may well be on `contoso-release`, but no mapping pattern routes `Contoso.Core` there. Each package ID resolves against only the sources whose patterns match it, with the most specific pattern winning. Fix the mapping:

```xml
<!-- nuget.config, NuGet 7.6 -->
<packageSourceMapping>
  <packageSource key="contoso-internal">
    <package pattern="Contoso.*" />
    <package pattern="*" />
  </packageSource>
</packageSourceMapping>
```

With a single upstream-enabled feed, the simplest correct mapping is `*` to that feed. Mapping only makes sense when you genuinely keep two sources, and then every internal prefix has to be listed.

## Fix 5: bypass the HTTP cache on self-hosted agents

Hosted agents start with an empty cache, so this one only bites self-hosted agents and developer machines. NuGet's [HTTP cache](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders#http-cache) stores the list of versions each source returned, and entries younger than 30 minutes are reused. Publish `1.5.0`, trigger the consuming build three minutes later on the same agent, and restore still sees the cached list that ends at `1.4.0`.

```bash
# .NET SDK 10.0.302
dotnet restore --no-http-cache
# or, for packages.config projects with nuget.exe
nuget restore MySolution.sln -NoHttpCache
# or clear it once
dotnet nuget locals http-cache --clear
```

`--no-http-cache` is cheap enough to leave on in CI for the step that restores just-published internal packages. Do not reach for `dotnet nuget locals all --clear` on a shared agent; wiping `global-packages` forces every other pipeline on that machine to redownload everything.

## Fix 6: wait out upstream latency, or allow external versions

Two feed-side behaviours produce the same "nearest version" symptom for packages that originate on NuGet.org:

- **Propagation delay.** The [upstream sources docs](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) state there is typically a 3 to 6 hour delay between a push to NuGet.org and the version being available through an upstream. Between Azure Artifacts feeds it is usually a few minutes. If a dependency released this morning fails and last week's version restores, wait, or pin the previous version for a few hours.
- **External versions blocked.** If you publish a package ID internally that also exists publicly, Azure Artifacts can block saving new public versions of that ID to protect against dependency confusion. A Feed Owner can allow them per package with **Allow externally-sourced versions** on the package page, or with the `versionsFromExternalUpstreams: AllowExternalVersions` REST call described in [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior). Allow up to 3 hours for that change to propagate.

Also check **Feed settings > Upstream sources** for a failed sync status. A broken upstream stops metadata refresh for every package of that protocol, so new versions stop appearing even from healthy upstreams.

## Gotchas that look like this error but are not

**`NU1101: Unable to find package Contoso.Core. No packages exist with this id in source(s)`.** That is a different situation: the ID was not found at all. Usually the source is wrong, the feed is project-scoped and the URL is missing the project segment (`https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/nuget/v3/index.json`), or package source mapping excludes every source for that ID.

**`NU1301: Unable to load the service index for source` or a `401 Unauthorized`.** Authentication failed before version resolution started. Add `NuGetAuthenticate@1`, and check that nothing in the repo's `nuget.config` hard-codes `<packageSourceCredentials>` with an expired PAT, since those override the credential provider.

**`403 Forbidden ... lacks permission to complete this action`.** The identity reached the feed but has no role on it at all. The fix is the same as Fix 1, plus checking the job authorization scope.

**A version that restores in one pipeline and not another.** Different pipelines can run as different identities: classic release pipelines have their own scope toggle, and YAML pipelines triggered from a different project run as that project's build service.

**Central package management versions.** With `Directory.Packages.props`, the version in the error comes from the central file, not the `.csproj`, so "fixing" the project file does nothing. If you are mid-migration, the walkthrough on [moving a solution to central package management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) covers where each version is resolved from.

**A package that disappears after upgrading the SDK.** If a transitive package vanished rather than failed to resolve, it may have been removed by [NuGet package pruning in .NET 10](/2026/05/nuget-package-pruning-default-net-10/), which is expected behaviour and not a feed problem.

**Publishing side issues.** If the version is genuinely missing from the feed, the producer's push failed or was rejected. Versioning with MinVer and the trusted publishing setup in [releasing multiple NuGet packages independently](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) makes it easy to see which version each tag produced. For NuGet.org-side security controls that also block pushes, see [what to lock down on your NuGet account](/2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10/).

## A checklist that finds the cause in five minutes

1. Read the full `NU1102` output. "Found N version(s)" means auth works and the problem is visibility. "Were not considered" means package source mapping.
2. Copy the feed URL from the restore log, not from your local `nuget.config`. If the task generated a temporary config, the log shows its path; switch to `feedsToUse: config`.
3. Look for `@` in that URL. If there is a view, check whether the version is promoted to it.
4. Look for the version on the feed's package page. If it is missing there but exists on NuGet.org or an upstream feed, it has never been saved: give the build identity the Collaborator role, or restore it once as a Collaborator to save it.
5. Confirm which build identity runs the job via the job authorization scope setting, and check that exact identity on the feed's Permissions page.
6. On a self-hosted agent, rerun with `--no-http-cache`.
7. For a package released on NuGet.org today, check the upstream status and the package's external-versions setting, then wait.

Nine times out of ten the answer is step 4 or 5. The feed is not lying and NuGet is not broken; the pipeline is just a different reader than you are.

## Sources

- [Manage permissions - Azure Artifacts](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions) (feed roles, build identity names, cross-project note)
- [What are upstream sources?](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) (search order, single-feed advice, 3 to 6 hour delay)
- [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) (Allow external versions)
- [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) (`NuGetAuthenticate@1`, Ubuntu 24.04 note, cross-organization feeds)
- [Feed views](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/views)
- [NuGet Error NU1102](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1102)
- [Package Source Mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping)
- [Managing the global packages, cache, and temp folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) (30-minute HTTP cache)
- [NuGet.Client Strings.resx](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.PackageManagement/Strings.resx) (`UnknownPackageSpecificVersion` and `PackageNotFoundOnSource` messages)
