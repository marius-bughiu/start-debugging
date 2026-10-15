---
title: "dotnetup public preview: one command installs the SDK your global.json pins"
description: "dotnetup went to public preview on October 15, 2026. Run dotnetup sdk install in a repo and it reads global.json, maps rollForward to an update channel, and can even write newer patch versions back to the file."
pubDate: 2026-10-15
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
  - "global-json"
---

On October 15, 2026 Microsoft [announced the public preview of dotnetup](https://devblogs.microsoft.com/dotnet/introducing-dotnetup/), the rustup-style toolchain manager for .NET SDKs and runtimes. When I [first wrote about it in June](/2026/06/dotnetup-official-dotnet-sdk-version-manager/), you had to build it from source and only `dotnetup sdk install preview` was confirmed. Now there is a one-line installer, a full [command reference on Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnetup/), and an answer to the question I cared about most: what it does with `global.json`.

## Getting it on the machine

The bootstrap script downloads the latest `preview` build, checks its SHA-512 checksum, and puts it in `~/.dotnetup`. No `sudo`.

```bash
# macOS / Linux (x64 and Arm64, glibc and musl)
curl -fsSL https://aka.ms/dotnetup/get-dotnetup.sh | bash

# then, non-interactively
dotnetup install latest
dotnetup env set shell
```

On Windows the PowerShell equivalent is `irm https://aka.ms/dotnetup/get-dotnetup.ps1 | iex`. Be careful with the Windows defaults. `dotnetup init` suggests the `everywhere` mode, which changes the system `PATH` and sets `DOTNET_ROOT`. The managed install then takes precedence over the SDKs Visual Studio installed, so a project that needs a machine-wide SDK that dotnetup does not also have will stop building. Pick `shell` or `none` unless you plan to migrate everything.

`none` is the most interesting mode for trying it out. It leaves `PATH` and `DOTNET_ROOT` alone and forwards commands instead:

```bash
dotnetup env set none --dotnetup-on-path true
dotnetup dotnet -- --info
dotnetup dotnet build
```

## global.json becomes a tracked requirement

Inside a repository, run `dotnetup sdk install` with no channel. It walks up from the current directory, uses the nearest `global.json`, and falls back to `latest` if none exists. A malformed file fails the command. It does not silently fall back to a parent directory.

```json
{
  "sdk": {
    "version": "10.0.103",
    "rollForward": "latestPatch"
  }
}
```

The key detail is that dotnetup does not just install `10.0.103`. It turns `rollForward` into a channel that `dotnetup update` will keep refreshing:

| `rollForward` | Tracked channel |
| --- | --- |
| omitted or `latestPatch` | `10.0.1xx` |
| `latestFeature` | `10.0` |
| `latestMinor` | `10` |
| `latestMajor` | `latest` |
| `disable`, `patch`, `feature`, `minor`, `major` | exact `10.0.103`, never updated |

`allowPrerelease` does not affect the channel. `dotnetup list` shows the `global.json` path as the source of each requirement, so you can tell which repo is keeping an old SDK alive. When nothing references an SDK anymore, the next update removes it.

## Writing patches back to global.json

This one is new to me and quite handy for repos that pin exact patch versions for reproducible builds:

```bash
dotnetup sdk install --update-global-json
# later, across every tracked repo
dotnetup sdk update --update-global-json
```

It installs the newest SDK in the derived channel and rewrites only `sdk.version`, keeping formatting, other properties, and the file's text encoding. That replaces a Dependabot-style PR or a hand edit every Patch Tuesday.

## Preview rough edges

- If `global.json` has `sdk.paths`, dotnetup installs to the first entry. In this preview it treats `$host$` as a literal path and does not skip empty entries, so omit `sdk.paths` or pass `--install-path`.
- `dotnetup sdk uninstall 10.0.1xx --source globaljson` removes every matching `global.json` requirement in the install root, not just the one for the current repo.
- First-class GitHub Actions and Azure DevOps integration is still on the roadmap, although the commands already run non-interactively in CI.

If you juggle several repos pinned to different .NET 10 feature bands, `dotnetup sdk install` per repo plus a weekly `dotnetup update` is already a better story than the `dotnet-install` scripts. Feedback goes to the [dotnetup discussions in dotnet/sdk](https://github.com/dotnet/sdk/discussions/categories/dotnetup).
