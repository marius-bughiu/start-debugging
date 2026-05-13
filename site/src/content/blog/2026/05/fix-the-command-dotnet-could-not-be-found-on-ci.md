---
title: "Fix: The command 'dotnet' could not be found on CI"
description: "Your CI runner cannot resolve dotnet because the SDK is not installed for that step, or it is installed but not on PATH. Use actions/setup-dotnet, pin a global.json, and export DOTNET_ROOT and ~/.dotnet/tools."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "ci"
  - "github-actions"
  - "azure-pipelines"
---

The fix: a CI step is running `dotnet` in a shell where the SDK is either not installed, not on `PATH`, or pinned to a version your `global.json` forbids. On GitHub Actions, add a `actions/setup-dotnet@v4` step before any `dotnet` invocation, commit a `global.json` matching the SDK you ask for, and on Linux containers export `DOTNET_ROOT` and `$HOME/.dotnet/tools`. The error is almost never a bug in the runner image.

```text
/bin/bash: line 1: dotnet: command not found
##[error]Process completed with exit code 127.
```

or on Windows runners:

```text
dotnet : The term 'dotnet' is not recognized as the name of a cmdlet, function, script file, or operable program.
At line:1 char:1
+ dotnet build
+ ~~~~~~
    + CategoryInfo          : ObjectNotFound: (dotnet:String) [], CommandNotFoundException
```

or, on Ubuntu after `dotnet-install.sh`:

```text
Command 'dotnet' not found, but can be installed with:
sudo apt install dotnet-host
```

This guide is written against .NET 11 (SDK 11.0.100), `actions/setup-dotnet@v4.0.1`, Azure DevOps `UseDotNet@2` task version 2.213.x, and `dotnet-install.sh` as published on `https://dot.net/v1/dotnet-install.sh` in May 2026. The underlying reasons have not changed since .NET Core 3.1; only the action versions have.

## Why CI shells lose `dotnet`

There are four root causes. They are easy to confuse because they all surface the same `command not found` line, so it is worth knowing which one you are looking at before you patch the YAML.

1. **The runner image has no SDK at all.** Container images such as `ubuntu:24.04`, `alpine:3.20`, or `mcr.microsoft.com/devcontainers/base:ubuntu` do not ship the .NET SDK. GitHub-hosted runners (`ubuntu-latest`, `windows-latest`) do, but the version cached is whatever the runner image happened to bake, not the version your repo needs.
2. **The SDK is installed, but it is not on `PATH` for this step.** Each step in GitHub Actions runs in a fresh shell. Adding a line to `~/.bashrc` from a previous step does not carry over. Setting `PATH` with `export` inside a `run:` block does not leak into the next `run:` block.
3. **The SDK is on `PATH`, but `global.json` pins a version that is not installed.** When `dotnet` starts, it reads the nearest `global.json` up the directory tree and resolves an SDK that matches the `version` and `rollForward` rules. If nothing matches, you get `error NETSDK1045` or a host failure that surfaces, depending on the host, as a "command not found"-shaped failure in the wrapper script.
4. **The SDK was installed by `dotnet-install.sh` to `$HOME/.dotnet`, but `DOTNET_ROOT` and `PATH` were never set.** This is the most common failure on self-hosted Linux runners and inside Docker containers. The script installs cleanly, then no follow-up step exports the variables.

## A minimal CI repro

Save this as `.github/workflows/build.yml` and push it to a repo with a `.csproj`:

```yaml
# .github/workflows/build.yml -- .NET 11, GitHub Actions May 2026
name: build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    container: ubuntu:24.04   # no SDK is preinstalled here
    steps:
      - uses: actions/checkout@v4
      - run: dotnet --info     # fails: dotnet: command not found
```

The `container:` key swaps the runner OS for a bare Ubuntu image. The default `ubuntu-latest` runner does have the SDK, so removing `container:` makes this snippet work. Most teams hit this when they move a job into a container for reproducibility and forget to also bring `setup-dotnet` along.

## Fix 1: install the SDK in the same job, then use it

The canonical fix on GitHub Actions is `actions/setup-dotnet`. Drop it in front of any step that calls `dotnet`. It downloads the SDK to a per-runner cache, prepends it to `PATH` for every subsequent step, and exports `DOTNET_ROOT` for tools that need the SDK install directory directly.

```yaml
# .github/workflows/build.yml -- setup-dotnet@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "11.0.x"
      - run: dotnet --info
      - run: dotnet build -c Release
```

Two details that bite:

- **`dotnet-version` accepts a wildcard**, but you should still commit a `global.json` so local builds and CI agree. Without it, a developer with SDK 11.0.5 installed locally and CI on 11.0.7 can produce different `obj/project.assets.json` and surprise each other.
- **`global-json-file:` overrides `dotnet-version`** in `setup-dotnet@v4`. If you pass both, the JSON wins. This is a feature, not a bug, but I have seen people add `dotnet-version: "8.0.x"` to a workflow with `global.json` set to 11 and wonder why .NET 11 still installs.

On Azure DevOps, the equivalent is `UseDotNet@2`:

```yaml
# azure-pipelines.yml -- Azure DevOps, UseDotNet@2
steps:
  - task: UseDotNet@2
    inputs:
      packageType: sdk
      version: "11.0.x"
  - script: dotnet build -c Release
```

On GitLab CI or Buildkite, the cleanest approach is a base image with the SDK baked in (`mcr.microsoft.com/dotnet/sdk:11.0`). Avoid running `dotnet-install.sh` in the job itself unless you have to: it works, but every job pays the download cost.

## Fix 2: commit a `global.json` that matches CI

When CI runs `dotnet build` it uses the SDK that wins the `global.json` resolution, not the latest installed SDK. A common failure mode looks like this:

```text
A compatible .NET SDK was not found.
Requested SDK version: 11.0.200
global.json file: /home/runner/work/myrepo/myrepo/global.json
Installed SDKs:
  8.0.412 [/usr/share/dotnet/sdk]
  11.0.100 [/usr/share/dotnet/sdk]
```

The runner has 11.0.100; `global.json` asks for 11.0.200. The wrapper script then exits non-zero, and depending on the host, you may see "command not found" propagated from a Bash `if` test that swallowed the real error.

Keep `global.json` honest:

```json
{
  "sdk": {
    "version": "11.0.100",
    "rollForward": "latestFeature"
  }
}
```

`rollForward: latestFeature` lets a developer with 11.0.103 work without bumping the file every patch release. `latestMajor` is too permissive for CI; `disable` is too strict for local. Match the `version` to what `actions/setup-dotnet`'s `dotnet-version` is going to install.

## Fix 3: when you must use `dotnet-install.sh`

Inside a stripped-down container, or on a self-hosted runner where you cannot use `setup-dotnet`, install with the official script and then export the variables explicitly in every subsequent step.

```yaml
# self-hosted runner or restrictive container -- .NET 11
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Install .NET 11 SDK
        run: |
          curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
          chmod +x dotnet-install.sh
          ./dotnet-install.sh --channel 11.0 --install-dir "$HOME/.dotnet"
          echo "$HOME/.dotnet" >> "$GITHUB_PATH"
          echo "$HOME/.dotnet/tools" >> "$GITHUB_PATH"
          echo "DOTNET_ROOT=$HOME/.dotnet" >> "$GITHUB_ENV"
      - run: dotnet --info
      - run: dotnet tool restore && dotnet build -c Release
```

The two `echo` lines write to special files that GitHub Actions reads between steps: `GITHUB_PATH` prepends an entry to `PATH` for every following step in the job, and `GITHUB_ENV` exports an environment variable the same way. `export PATH=...` inside the same `run:` block would not work for the next step, which is the trap people fall into when they translate a shell script literally.

`DOTNET_ROOT` matters even if `PATH` is set. The host (`dotnet` binary) uses `DOTNET_ROOT` to find the `shared/Microsoft.NETCore.App` and `sdk/` folders. If you only fix `PATH`, you can end up with `dotnet --info` working but `dotnet build` failing with a host error about a missing runtime. Per Microsoft Learn, `DOTNET_ROOT` is read by the host on Linux and macOS and on Windows when the install is non-default.

Add the `tools` directory too. Without `$HOME/.dotnet/tools` on `PATH`, any `dotnet tool install --global` call succeeds but the tool is unreachable, producing the related error: `dotnet-ef: command not found`.

## Fix 4: pre-built SDK image, no install step

For Docker-based CI, the lowest-friction path is to start from an image that already has the SDK:

```yaml
# .gitlab-ci.yml -- pinned SDK image, no install step
build:
  image: mcr.microsoft.com/dotnet/sdk:11.0
  script:
    - dotnet --info
    - dotnet build -c Release
```

Mirror this for Buildkite, CircleCI, Jenkins agents in Docker, and any platform whose CI primitive is "a container plus a script". You trade flexibility (one image, one SDK) for a guarantee that `dotnet` is on `PATH` from the first command.

## Common variants and lookalikes

Searches that land on this page are sometimes after a slightly different error. Worth disambiguating up front so you do not chase the wrong fix.

- **`dotnet-ef: command not found`**. The global tool was installed but `$HOME/.dotnet/tools` is not on `PATH`. Add it as shown above, or use a `dotnet-tools.json` local manifest and call `dotnet tool restore && dotnet ef`.
- **`Could not execute because the specified command or file was not found`**. `dotnet` is on `PATH`, but the subcommand (`dotnet foo`) is not a built-in and is not installed as a tool. Different error, different root cause.
- **`error NETSDK1045: The current .NET SDK does not support targeting .NET 11.0`**. The SDK is on `PATH`, but it is too old for the project's `TargetFramework`. Bump `setup-dotnet`'s `dotnet-version` (or `global.json`), do not install a second SDK alongside the first hoping multi-target resolution will sort it out.
- **`/usr/bin/env: 'dotnet': No such file or directory`**. Same root cause as "command not found", different shell. The fix is identical.
- **`A fatal error occurred. The required library libhostfxr.so could not be found`**. `dotnet` is on `PATH`, but `DOTNET_ROOT` points at an empty directory, or the SDK was partially installed. Re-run `dotnet-install.sh` and confirm `DOTNET_ROOT` matches the actual install dir.

## Things that look like fixes but are not

- **Running `apt install dotnet-host`** in CI. This installs only the host, not the SDK, and pulls a Microsoft-signed `.deb` that may lag the SDK channel by weeks. Use `setup-dotnet` or `dotnet-install.sh` instead.
- **Adding `dotnet` to `PATH` in `~/.bashrc`** in a `run:` step. CI steps run non-interactive shells; `~/.bashrc` is not sourced. Use `GITHUB_PATH` (GitHub Actions), `task.prependpath` (Azure DevOps), or a per-step `PATH=...` prefix.
- **`sudo` on a hosted runner**. Hosted runners already run as a user with passwordless `sudo`, but the SDK installs into `/usr/share/dotnet` and the wrapper at `/usr/bin/dotnet` is already there. If you find yourself `sudo`-ing to make it work, you are most likely missing `setup-dotnet`, not missing privileges.
- **Pinning `actions/setup-dotnet` to an older major** because "v4 broke us". v4 changed cache directories and parsed `global.json` more strictly. The breakage is almost always a `global.json` that points at an unavailable SDK. Fix the JSON; do not pin to v3 forever.

## Verifying the fix on CI

Before you go further, run two diagnostic steps. They are cheap and they save you from chasing phantoms in `dotnet build` output.

```yaml
- run: which dotnet || command -v dotnet || true
- run: dotnet --info
```

`which dotnet` (or `where dotnet` on Windows) confirms which binary the shell resolves. `dotnet --info` prints the runtime, SDK list, and the resolved `global.json`. If `--info` succeeds but `build` fails with "command not found", the failure is inside a wrapper script that swallows errors, not in `dotnet` itself. That is the moment to read the wrapper, not the moment to reinstall.

When the `--info` output shows the SDK you asked for, points `Base Path:` at the directory you expected, and lists `global.json file: <your path>`, you are done. Anything else is a real misconfiguration worth fixing.

## Related

- For the broader picture of running tooling in parallel CI lanes, see [how to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), which uses the same `GITHUB_PATH` trick to swap SDKs per matrix job.
- If your build fails after the SDK is found, look at [why a published app fails to load assemblies](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) for the trim and runtime-pack story.
- For build-time copy failures specifically, [the MSB3027 retry-count fix](/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) covers the antivirus and file-lock cases.
- For an EF Core tool that resolves but fails to attach to the host, see [fixing dotnet ef migrations add when DbContext cannot be created](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).
- For container-based integration testing where you want a real database in the same job, [integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) walks through a working pipeline.

## Sources

- [`actions/setup-dotnet` README](https://github.com/actions/setup-dotnet), `v4.0.x` documentation for `dotnet-version`, `global-json-file`, and `cache`.
- [Install .NET on Linux without using a package manager](https://learn.microsoft.com/en-us/dotnet/core/install/linux-scripted-manual), Microsoft Learn, covers `dotnet-install.sh`, `DOTNET_ROOT`, and `PATH`.
- [Environment variables used by .NET SDK and CLI](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables), Microsoft Learn, on `DOTNET_ROOT`.
- [`global.json` overview](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json), Microsoft Learn, for `rollForward` rules.
- [Workflow commands for GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-system-path), GitHub Docs, on `GITHUB_PATH` and `GITHUB_ENV`.
- [`dotnet/core` issue 5267](https://github.com/dotnet/core/issues/5267), the long-running upstream thread for "command 'dotnet' not found, but can be installed with".
