---
title: "dotnet workload clean"
description: "Mit `dotnet workload clean` entfernen Sie übriggebliebene .NET-Workload-Packs nach einem SDK- oder Visual Studio-Update: Wann Sie es verwenden, was es entfernt und worauf zu achten ist."
pubDate: 2023-09-04
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/09/dotnet-workload-clean"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hinweis: Dieses Kommando ist erst ab .NET 8 verfügbar.

Es räumt Workload-Packs auf, die nach einem Update des .NET SDK oder von Visual Studio zurückbleiben können. Das ist nützlich, wenn Sie Probleme beim Verwalten Ihrer Workloads haben.

`dotnet workload clean` entfernt verwaiste Packs, die durch das Deinstallieren von .NET-SDKs entstanden sind. Workloads, die von Visual Studio installiert wurden, lässt das Kommando in Ruhe, gibt Ihnen aber eine Liste mit Workloads aus, die Sie manuell aufräumen sollten.

Die dotnet-Workloads finden sich unter: `{DOTNET ROOT}/metadata/workloads/installedpacks/v1/{pack-id}/{pack-version}/`. Eine Datei `{sdk-band}` unter dem Installationsdatensatz-Ordner dient als Referenzzähler: Existiert keine sdk-band-Datei mehr im Workload-Ordner, wissen wir, dass das Workload-Paket nicht mehr verwendet wird und gefahrlos von der Platte gelöscht werden kann.

## dotnet workload clean --all

In der Standardkonfiguration entfernt das Kommando nur verwaiste Workloads. Mit dem Argument `--all` weisen wir es an, alle Packs auf dem Rechner zu bereinigen, mit Ausnahme derer, die von Visual Studio installiert wurden. Außerdem werden alle Workload-Installationsdatensätze entfernt.
