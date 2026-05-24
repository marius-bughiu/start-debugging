---
title: "Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing"
description: "One repo, three NuGet packages, independent versions. Per-package MinVer tag prefixes, a tag-driven GitHub Actions release that publishes via OIDC trusted publishing (no API key), pinning a cross-package dependency to a real version, and the default-branch gotcha that silently swallows your first tag."
pubDate: 2026-05-24
tags:
  - "dotnet"
  - "nuget"
  - "msbuild"
  - "github-actions"
  - "ci-cd"
---
You have one repository that ships several NuGet packages, and you want to release them **independently** — bump and publish one without dragging the others to the same version. You also don't want to hand-edit version numbers, store a NuGet API key as a secret, or publish a broken package. This is exactly the setup behind [super-activities](https://github.com/marius-bughiu/super-activities) (three packages: `M.Super.Activities`, `M.Super.Extensions`, `M.Super.AppInsights.Activities`), and getting it right took solving four distinct problems. The full [`release.yml`](https://github.com/marius-bughiu/super-activities/blob/main/.github/workflows/release.yml) and [`ci.yml`](https://github.com/marius-bughiu/super-activities/blob/main/.github/workflows/ci.yml) are public; here's the whole thing, including the gotcha that silently ate the first release.

## Versioning: MinVer, one tag prefix per package

[MinVer](https://github.com/adamralph/minver) derives the version from git tags — no version number lives in source. The trick for a monorepo with *independent* versions is giving each project its own **tag prefix**. MinVer then only considers tags matching that prefix:

```xml
<!-- in Super.Activities.csproj -->
<MinVerTagPrefix>M.Super.Activities-v</MinVerTagPrefix>
```

```xml
<!-- in Super.Extensions.csproj -->
<MinVerTagPrefix>M.Super.Extensions-v</MinVerTagPrefix>
```

Add MinVer once for every packable project (a build-only dependency, no runtime footprint), in `Directory.Build.targets`:

```xml
<ItemGroup Condition="'$(IsPackable)' != 'false'">
  <PackageReference Include="MinVer" Version="5.0.0" PrivateAssets="all" />
</ItemGroup>
```

*Source: [`Directory.Build.targets`](https://github.com/marius-bughiu/super-activities/blob/main/Directory.Build.targets)*

And floor the version so pre-tag and CI builds don't look like they regressed to `0.x`:

```xml
<!-- Directory.Build.props -->
<MinVerMinimumMajorMinor>1.0</MinVerMinimumMajorMinor>
```

*Source: [`Directory.Build.props`](https://github.com/marius-bughiu/super-activities/blob/main/Directory.Build.props)*

Now the release contract is just a tag. Push `M.Super.Extensions-v1.1.0` and MinVer stamps **that** package `1.1.0`; on a tagged commit the version is exactly the tag, and commits after it auto-increment to the next patch as `-alpha.0.<height>`.

## The release workflow: resolve, build, pack one

A single `release.yml` triggers on the three tag patterns and figures out which package the tag refers to. Since the `PackageId` carries an `M.` prefix but the folder/assembly doesn't, the mapping is a little string surgery:

```yaml
on:
  push:
    tags:
      - 'M.Super.Activities-v*'
      - 'M.Super.Extensions-v*'
      - 'M.Super.AppInsights.Activities-v*'
```

```bash
tag="${GITHUB_REF_NAME}"      # e.g. M.Super.AppInsights.Activities-v1.2.0
pkg="${tag%-v*}"              # -> M.Super.AppInsights.Activities
ver="${tag##*-v}"            # -> 1.2.0
name="${pkg#M.}"             # -> Super.AppInsights.Activities (folder/assembly)
proj="src/${name}/${name}.csproj"
```

From there the job builds and tests the whole solution (you don't publish a package if the repo's tests are red), then packs **only** the tagged project. A nice cheap guard: after packing, assert the produced file matches the tag, which catches a tag placed on the wrong commit.

```bash
expected="${pkg}.${ver}.nupkg"
test -f "nuget/$expected" || { echo "::error::version != tag"; exit 1; }
```

## Trusted publishing: no API key

The publish step uses **NuGet trusted publishing** — OIDC instead of a long-lived `NUGET_API_KEY` secret. GitHub mints a short-lived token, `NuGet/login` exchanges it for a temporary API key, and you push. The job needs `id-token: write` and an environment that matches the trusted-publisher policy you configure on nuget.org:

```yaml
publish:
  if: github.event_name == 'push'
  needs: [ build ]
  environment: nuget-publish
  permissions:
    id-token: write   # required for OIDC trusted publishing
    contents: read
  steps:
    - uses: NuGet/login@v1
      id: nuget-login
      with:
        user: your-nuget-username
    - run: dotnet nuget push "nuget/*.nupkg"
        --api-key "${{ steps.nuget-login.outputs.NUGET_API_KEY }}"
        --source https://api.nuget.org/v3/index.json --skip-duplicate
```

*Source: [`.github/workflows/release.yml`](https://github.com/marius-bughiu/super-activities/blob/main/.github/workflows/release.yml)*

There's no secret to rotate or leak. The one-time setup is a GitHub environment named `nuget-publish` and a trusted-publisher policy per package ID on nuget.org (owner, repo, workflow file, environment). A `workflow_dispatch` path that builds and uploads the `.nupkg` as an artifact *without* publishing makes a perfect dry run, since the publish job is gated on `github.event_name == 'push'`.

## The cross-package dependency trap

`M.Super.AppInsights.Activities` depends on `M.Super.Extensions` via a `ProjectReference`. Left alone, when you pack AppInsights, the emitted dependency floats to whatever MinVer computes for Extensions *at that commit* — which, if Extensions has commits since its last tag, is an unpublished prerelease like `1.1.1-alpha.0.3`. Consumers then can't restore.

The fix: at pack time, pin the dependency to the **last published** Extensions version. The release job finds Extensions' latest tag and passes it through:

```bash
ext_tag="$(git tag --list 'M.Super.Extensions-v*' --sort=-v:refname | head -n1)"
ext_ver="${ext_tag#M.Super.Extensions-v}"
# -> dotnet pack ... -p:SuperExtensionsPackageVersion=$ext_ver
```

And `Super.Extensions.csproj` honors that override (only when set — local/dev builds still use MinVer):

```xml
<PropertyGroup Condition="'$(SuperExtensionsPackageVersion)' != ''">
  <MinVerVersionOverride>$(SuperExtensionsPackageVersion)</MinVerVersionOverride>
</PropertyGroup>
```

*Source: [`src/Super.Extensions/Super.Extensions.csproj`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/Super.Extensions.csproj)*

If no Extensions tag exists yet, the job fails fast with "release Extensions first" rather than emitting a dangling dependency. The rule that falls out: **release the dependency before the dependent.**

## The gotcha that ate the first release

Everything above was correct, the tags were pushed, and… nothing happened. No workflow runs. `gh run list` was empty. `gh workflow list` showed no workflows at all — yet the tag's tree definitely contained `release.yml`.

The cause is a GitHub Actions rule that's easy to forget: **a `push`/tag-triggered workflow won't run until that workflow file has existed on the repository's default branch at least once.** In the usual flow you commit the workflow to `main` first (registering it) and *then* tag, so you never notice. If your very first tags point at a commit that was never on `main`, GitHub has nothing registered to trigger, and the tag push is silently ignored.

The recovery:

1. Get the workflow onto the default branch (`git push origin main`, or merge a PR).
2. GitHub now registers the workflow.
3. Re-fire the tag events — GitHub won't replay the missed ones, so delete and re-push the tags:

```bash
git push origin :M.Super.Extensions-v1.0.1            # delete remote
git push origin M.Super.Extensions-v1.0.1             # re-create -> triggers the run
```

After that the three releases ran, published over OIDC, and created their GitHub releases. (When pushing sibling tags together, the dependent's job still sees the dependency's tag because checkout with `fetch-depth: 0` fetches all tags — so the pinning lookup works.)

## The payoff

The end state is exactly the "boring" you want: to ship any package, push one tag — `git tag M.Super.Extensions-v1.2.0 && git push origin M.Super.Extensions-v1.2.0`. MinVer derives the version, CI gates it, OIDC publishes it with no stored secret, the cross-package dependency points at a real published version, and a GitHub release appears. Independent versioning across a monorepo, with the sharp edges filed down.

---

*Part of a series drawn from [super-activities](https://github.com/marius-bughiu/super-activities):*

- *[Building a UiPath Activity Package for Modern Studio with ViewModels](/2026/05/build-a-uipath-activity-package-for-modern-studio-with-viewmodels/)*
- *[Add Project Settings to a UiPath Package: Design-Time and Runtime](/2026/05/add-project-settings-to-a-uipath-package-design-time-and-runtime/)*
- *[Writing a UiPath Workflow Analyzer Rule with Entry-Point Detection](/2026/05/write-a-uipath-workflow-analyzer-rule-with-entry-point-detection/)*
- *[Run Code Before & After Every UiPath Activity](/2026/05/run-code-before-and-after-every-uipath-activity-with-a-tracking-participant/)*
