---
title: "How to install the Aspire CLI for a C# AppHost"
description: "Install and verify the Aspire CLI for a C# AppHost. See why dotnet workload install aspire belongs to the original .NET 8 preview."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
---

For an Aspire 13.x **C# AppHost**, install the .NET 10 SDK and the Aspire CLI. In a terminal, check that a 10.x SDK is listed, install the CLI as a .NET global tool, then verify that your shell can find it:

```sh
dotnet --list-sdks
dotnet tool install --global Aspire.Cli
aspire --version
```

If the final command cannot find `aspire`, reopen the terminal and check that the .NET global tools directory is on your `PATH`. For a Windows package manager, Homebrew or another installation method, see [the CLI installation guide](https://aspire.dev/get-started/install-cli/). Choose one installation method.

An AppHost that starts a Redis or database container also needs a running container runtime. Docker Desktop and Podman are options. The [Aspire prerequisites](https://aspire.dev/get-started/prerequisites/) explain the runtime configuration and distinguish the SDK needed by a C# AppHost from the target frameworks of the services it runs.

## Why older instructions install an Aspire workload

**Correction — November 2, 2026:** `dotnet workload install aspire` was the setup command for the [November 2023 .NET 8 preview](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). [Aspire 9 moved the templates into NuGet packages](https://aspire.dev/whats-new/aspire-9/) and removed the workload requirement. The following command and screenshots document that earlier setup:

```sh
dotnet workload install aspire
```

In the preview, Visual Studio Installer offered an optional **.NET Aspire SDK (Preview)** component under the web development workload. The second screenshot shows the Docker Desktop installer on Windows at the time.

[![Visual Studio Installer with ASP.NET and web development selected and .NET Aspire SDK (Preview) checked under Optional.](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

[![Docker Desktop installer with Use WSL 2 instead of Hyper-V and Add shortcut to desktop checked.](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Once `aspire --version` works, [create your first Aspire starter app](/2023/11/getting-started-with-net-aspire/). To see why an AppHost is involved, read [how Aspire connects services](/2023/11/what-is-net-aspire/).
