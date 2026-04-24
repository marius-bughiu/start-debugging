---
title: ".NET 10 on Ubuntu 26.04: resolute Container Tags and Native AOT in the Archive"
description: "Ubuntu 26.04 Resolute Raccoon ships with .NET 10 in the archive, introduces -resolute container tags to replace -noble, and packages Native AOT tooling via dotnet-sdk-aot-10.0."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-10"
  - "ubuntu"
  - "containers"
  - "native-aot"
  - "linux"
---

Ubuntu 26.04 "Resolute Raccoon" hit general availability on April 23, 2026, and the Microsoft .NET team shipped the companion blog post the same day. The headline is that .NET 10 is in the distro archive from day one, the container tag naming has rotated, and Native AOT finally gets a proper apt package. If you run .NET on Linux, this is the release that changes how your `FROM` lines look for the next two years.

## Resolute replaces noble in container tags

Starting with .NET 10, the default container tags reference Ubuntu images instead of Debian. With 26.04 out, Microsoft added a new Ubuntu 26.04 based flavor under the `resolute` tag. The migration is mechanical:

```dockerfile
# Before
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble

# After
FROM mcr.microsoft.com/dotnet/aspnet:10.0-resolute
```

The `noble` images still exist and keep receiving 24.04 base updates, so there is no forced cutover. The `chiseled` variants move forward in lockstep: `10.0-resolute-chiseled` is published alongside the full image. If you were already on chiseled noble images for distroless style deployments, the upgrade is a tag swap and a rebuild.

## Installing .NET 10 from the archive

No Microsoft package feed is needed on 26.04. The Ubuntu archive carries the SDK directly:

```bash
sudo apt update
sudo apt install dotnet-sdk-10.0
```

.NET 10 is LTS, so the archive version gets security servicing through Ubuntu until the distro's end of life. That matters for hardened environments that block third-party apt sources.

## Native AOT as a first-class apt package

This is the quiet but important change. Until 26.04, building Native AOT on Ubuntu meant installing `clang`, `zlib1g-dev`, and the right toolchain bits yourself. The 26.04 archive now ships `dotnet-sdk-aot-10.0`, which pulls in the linker pieces the SDK's `PublishAot` target expects.

```bash
sudo apt install -y dotnet-sdk-aot-10.0 clang
dotnet publish -c Release -r linux-x64
```

Microsoft quotes a 1.4 MB binary for a hello-world app with a 3 ms cold start, and a 13 MB self-contained binary for a minimal web service. The size and startup numbers are familiar for anyone who has used AOT since .NET 8, but having them fall out of a single `apt install` on a stock LTS is new.

## .NET 8 and 9 via dotnet-backports

If you are not ready to rebuild on 10 yet, the `dotnet-backports` PPA is the supported path for older still-in-support versions on 26.04:

```bash
sudo apt install -y software-properties-common
sudo add-apt-repository ppa:dotnet/backports
sudo apt install dotnet-sdk-9.0
```

Microsoft calls this best-effort support, so treat it as a bridge rather than a long-term plan. The fact that Ubuntu 26.04 had .NET 10 ready on launch day came from running `dotnet/runtime` CI against Ubuntu 26.04 since late 2025. If you want to follow the mechanics, the [official .NET blog post](https://devblogs.microsoft.com/dotnet/whats-new-for-dotnet-in-ubuntu-2604/) has the full story.
