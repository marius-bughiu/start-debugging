---
title: "dotnet workload clean"
description: "Note: this command is only available starting with .NET 8. This command cleans up workload packs that might be left over after an .NET SDK or Visual Studio update. It can be useful when encountering issues while managing workloads. dotnet workload clean will clean up orphaned packs resulted from uninstalling .NET SDKs. The command will…"
pubDate: 2023-09-04
tags:
  - "net"
  - "net-8"
---
Note: this command is only available starting with .NET 8.

This command cleans up workload packs that might be left over after an .NET SDK or Visual Studio update. It can be useful when encountering issues while managing workloads.

`dotnet workload clean` will clean up orphaned packs resulted from uninstalling .NET SDKs. The command will not touch workloads installed by Visual Studio, but it will provide you with a list of workloads that you should clean-up by hand.

dotnet workloads can be found at: `{DOTNET ROOT}/metadata/workloads/installedpacks/v1/{pack-id}/{pack-version}/`. An `{sdk-band}` file under the installation record folder will keep a reference count – so that when there’s no sdk-band file under a worload folder, then we know that the workload package is not in use and can be safely deleted from the disk,

## dotnet workload clean –all

While in it’s default configuration the command removed only orphaned workloads, by passing the `--all` argument, we are instructing it to clean up every pack on the machine – except for those installed by Visual Studio. It will also remove all workload instalation records.
