---
title: ".NET Aspire installieren (dotnet workload install aspire)"
description: "Installieren Sie .NET Aspire über `dotnet workload install aspire`. Schritt-für-Schritt-Einrichtung von .NET 8, dem Aspire-Workload und Docker unter Windows, macOS und Linux."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "de"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Aspire ist ein umfassendes, cloudorientiertes Framework für die Erstellung skalierbarer, beobachtbarer und produktionsreifer verteilter Anwendungen. In diesem Artikel sehen wir uns die Voraussetzungen für den Einstieg in .NET Aspire an. Wenn Sie einen Überblick über .NET Aspire und seinen Mehrwert wünschen, lesen Sie unseren Artikel [What is .NET Aspire](/de/2023/11/what-is-net-aspire/).

Es gibt drei Hauptdinge, die Sie für die Entwicklung von Anwendungen mit .NET Aspire benötigen:

-   [.NET 8](#install-net-8)
-   den [.NET Aspire-Workload](#install-the-net-aspire-workload)
-   und [Docker Desktop](#install-docker-desktop)

Wenn Sie planen, Visual Studio für die Entwicklung Ihrer Anwendung zu verwenden, beachten Sie, dass Sie Visual Studio 2022 Preview, Version 17.9 oder höher benötigen.

## Install .NET 8

Wenn Sie Visual Studio verwenden und bereits auf die neueste Version aktualisiert haben, ist .NET 8 bereits installiert. Falls Sie nicht auf der neuesten Version sind, stellen Sie sicher, dass Sie Visual Studio Version 17.9 oder höher verwenden, dann sind Sie auf der sicheren Seite.

Wenn Sie Visual Studio nicht verwenden, können Sie das .NET 8 SDK hier herunterladen und installieren: [https://dotnet.microsoft.com/en-us/download/dotnet/8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)

## Install the .NET Aspire workload

Der .NET Aspire-Workload kann auf zwei Arten installiert werden:

-   über die Kommandozeile mit der dotnet-CLI
-   oder über den Visual Studio Installer (für Visual Studio beachten Sie, dass Sie VS 17.9 oder höher benötigen)

### Using .NET CLI

Der Befehl zur Installation von .NET Aspire über die Kommandozeile ist recht einfach. Stellen Sie nur sicher, dass das .NET 8 SDK installiert ist, und Sie können den Workload-Installationsbefehl ausführen:

```bash
dotnet workload install aspire
```

### Using the Visual Studio Installer

Wählen Sie im Visual Studio Installer den Workload **ASP.NET and web development** aus und aktivieren Sie im rechten Bereich unter **Optional** das Kontrollkästchen **.NET Aspire SDK (Preview)**. Klicken Sie dann auf **Modify**, um den Installationsvorgang zu starten.

[![](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

## Install Docker Desktop

Sie können die neueste Version von Docker Desktop hier herunterladen: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)

Durchlaufen Sie den Installer mit den Standardoptionen, und nach einem Neustart sollten Sie startklar sein.

[![](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Beachten Sie, dass Docker Desktop nur für den persönlichen Gebrauch durch einzelne Entwickler, im Bildungsbereich und in der Open-Source-Community kostenlos ist. Jede andere Art der Nutzung unterliegt einer Lizenzgebühr. Prüfen Sie im Zweifelsfall die [Preisseite](https://www.docker.com/pricing/).

Mit allem installiert sind Sie nun bereit, mit .NET Aspire loszulegen!
