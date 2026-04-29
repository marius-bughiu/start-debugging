---
title: "NuGet-„Become-Owner“-Anfragenspam: Was tun (und was abriegeln) in .NET 9/.NET 10"
description: "Verteidigen Sie Ihre .NET-Pakete gegen Spam an Eigentümeranfragen auf NuGet. Lock-Dateien, Package Source Mapping und Central Package Management Praktiken für .NET 9 und .NET 10."
pubDate: 2026-01-23
tags:
  - "dotnet"
lang: "de"
translationOf: "2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Eine Diskussion aus den letzten 48 Stunden warnt vor verdächtigen "Become-Owner"-Anfragen auf NuGet.org, die angeblich in großem Umfang an Paket-Maintainer verschickt werden: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/).

Auch wenn sich die Details bis morgen ändern, ist die defensive Checkliste stabil. Das Ziel ist einfach: Die Wahrscheinlichkeit reduzieren, dass eine unerwartete Eigentümeränderung zu einer kompromittierten Abhängigkeit in Ihren .NET-9/.NET-10-Apps wird.

## Behandeln Sie Eigentümeranfragen als Sicherheitsereignis, nicht als Benachrichtigung

Wenn Sie Pakete pflegen:

-   **Akzeptieren Sie keine** unerwarteten Eigentümer-Einladungen, auch wenn der Absender "seriös" wirkt.
-   **Verifizieren Sie out of band**: Wenn Sie die Person oder Organisation kennen, kontaktieren Sie sie über einen bekannten Kanal (nicht über die Einladungsnachricht).
-   **Melden Sie** verdächtige Aktivitäten dem NuGet.org-Support mit Zeitstempeln und Paket-IDs.

Wenn Sie Pakete konsumieren, gehen Sie davon aus, dass Fehler passieren, und machen Sie Ihren Build robust gegen Upstream-Überraschungen.

## Sperren Sie den Abhängigkeitsgraphen, damit „Überraschungs-Updates“ nicht von selbst landen

Wenn Sie keine Lock-Dateien nutzen, sollten Sie das tun. Lock-Dateien machen Restores deterministisch, und das wollen Sie, wenn ein Abhängigkeitsökosystem unruhig ist.

Aktivieren Sie Lock-Dateien in Ihrem Repo (funktioniert mit `dotnet restore`):

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- Optional: make CI fail if the lock file would change -->
    <RestoreLockedMode Condition="'$(CI)' == 'true'">true</RestoreLockedMode>
  </PropertyGroup>
</Project>
```

Erzeugen Sie dann einmal pro Projekt (lokal) die initiale `packages.lock.json`, committen Sie sie und lassen Sie die CI darüber wachen.

## Reduzieren Sie Quellen-Wildwuchs mit Package Source Mapping

Eine häufige Stolperfalle ist, einfach „irgendeine konfigurierte NuGet-Quelle“ ins Spiel kommen zu lassen. Package Source Mapping zwingt jedes Paket-ID-Muster, aus einem bestimmten Feed zu kommen.

Minimales `nuget.config`-Beispiel:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="ContosoInternal" value="https://pkgs.dev.azure.com/contoso/_packaging/contoso/nuget/v3/index.json" />
  </packageSources>

  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="Microsoft.*" />
      <package pattern="System.*" />
      <package pattern="Newtonsoft.Json" />
    </packageSource>
    <packageSource key="ContosoInternal">
      <package pattern="Contoso.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

So kann ein Angreifer nicht „gewinnen“, indem er ein Paket gleichen Namens in einen anderen Feed schiebt, von dessen Existenz Sie nichts mehr wussten.

## Machen Sie Upgrades bewusst

Für .NET-9- und .NET-10-Codebasen ist die beste Tagesausrichtung langweilig:

-   Versionen pinnen (oder Central Package Management nutzen) und Upgrades über PRs einspielen.
-   Abhängigkeits-Diffs wie Code-Diffs reviewen.
-   Floating-Versionen in Produktions-Apps vermeiden, außer Sie haben einen guten Grund und gutes Monitoring.

Der ursprüngliche Diskussions-Thread ist hier: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/). Wenn Sie Pakete pflegen, lohnt es sich, heute Ihre NuGet-Konto-Benachrichtigungen zu prüfen und etwaige jüngste Eigentümeränderungen zu auditieren.
