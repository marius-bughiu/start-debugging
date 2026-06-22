---
title: "dotnetup: .NET Finally Gets a rustup-Style SDK Version Manager"
description: "Microsoft is building dotnetup, an official cross-platform tool to install, track, and switch between .NET SDKs and runtimes. Here is what it does and where it stands in June 2026."
pubDate: 2026-06-22
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
---

For years, managing .NET SDKs has meant juggling three separate things: the standalone installers from the download page, the `dotnet-install` scripts for CI, and the `dotnet-core-uninstall` tool to clean up the pile of old versions left behind. There has never been a single command that installs, tracks, and switches between SDKs the way `rustup` does for Rust or `nvm` does for Node. As of June 2026, that is changing. Microsoft is building `dotnetup`, and it is already wired into how the .NET SDK builds itself.

## What dotnetup actually is

`dotnetup` is an official, cross-platform version manager for .NET SDKs and runtimes. Its entire job is to install components into a user-scoped directory without requiring elevation, track what you have installed in a manifest, and switch the active version cleanly. No admin prompt, no MSI, no registry surgery.

The headline behaviors:

- Installs SDKs and runtimes per-user, so you never need `sudo` or an elevated terminal.
- Reads `global.json` to resolve and install the exact SDK a repository pins.
- Tracks installed components in a manifest for auditable updates and clean uninstalls.
- Supports multiple runtimes side by side for multi-targeting.
- Ships as an AOT-compiled, signed binary for fast startup and supply-chain safety.

The one command surface confirmed in the `dotnet/sdk` tracking issue is the install path, used here to pull a preview SDK in a build script:

```bash
dotnetup sdk install preview
```

The broader command set (listing installed versions, setting a default, uninstalling) is still being finalized in the open, so treat any longer example as illustrative rather than locked.

## Why global.json is the real win

The painful part of multi-repo .NET work today is the `global.json` mismatch. You clone a repo, run `dotnet build`, and get an error because it pins an SDK you do not have installed. Your only options are to hunt down the right installer or edit the file.

```json
{
  "sdk": {
    "version": "10.0.301",
    "rollForward": "latestPatch"
  }
}
```

With a version manager that understands this file, the resolution becomes a single step: point `dotnetup` at the repo and let it fetch the pinned SDK into your user profile. That is the same ergonomics Rust developers have had for years with `rust-toolchain.toml`.

## Where it stands right now

`dotnetup` is in internal preview. There is no one-line installer on the .NET website yet, and the practical way to try it today is to build it from source. A public preview is planned for the coming months. Notably, the `dotnet/sdk` `main` branch already uses `dotnetup` as part of its own build, which is a strong signal that this is the intended future of .NET installation rather than an experiment.

If you maintain CI pipelines or onboard developers onto repos with strict SDK pins, this is the tool to watch. Track progress in the [dotnet/sdk issue on using dotnetup in build scripts](https://github.com/dotnet/sdk/issues/52699) and the [awareness issue noting the main branch now builds with it](https://github.com/dotnet/sdk/issues/54601).
