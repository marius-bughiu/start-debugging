---
title: "Die Aspire CLI für einen C#-AppHost installieren"
description: "Die Aspire CLI für einen C#-AppHost installieren und prüfen. Warum dotnet workload install aspire zur ursprünglichen .NET-8-Vorschau gehört."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "de"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Installiere für einen **C#-AppHost** mit Aspire 13.x das .NET 10 SDK und die Aspire CLI. Prüfe im Terminal, ob ein 10.x-SDK aufgelistet ist, installiere die CLI als globales .NET-Tool und kontrolliere, ob die Shell sie findet:

```sh
dotnet --list-sdks
dotnet tool install --global Aspire.Cli
aspire --version
```

Findet der letzte Befehl `aspire` nicht, öffne das Terminal erneut und prüfe, ob das Verzeichnis der globalen .NET-Tools in `PATH` liegt. Für Windows-Paketmanager, Homebrew und weitere Methoden gibt es die [CLI-Installationsanleitung](https://aspire.dev/get-started/install-cli/). Wähle eine Installationsmethode.

Startet der AppHost einen Redis- oder Datenbankcontainer, muss auch eine Containerlaufzeit laufen. Docker Desktop und Podman sind mögliche Optionen. Die [Aspire-Voraussetzungen](https://aspire.dev/get-started/prerequisites/) erklären deren Konfiguration und unterscheiden das für den C#-AppHost benötigte SDK von den Zielframeworks der gestarteten Dienste.

## Warum ältere Anleitungen eine Aspire-Workload installieren

**Korrektur — 2. November 2026:** `dotnet workload install aspire` gehörte zur [.NET-8-Vorschau vom November 2023](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). Mit [Aspire 9 zogen die Vorlagen in NuGet-Pakete um](https://aspire.dev/whats-new/aspire-9/), und die Workload wurde nicht mehr benötigt. Der folgende Befehl und die Screenshots dokumentieren diese frühere Einrichtung:

```sh
dotnet workload install aspire
```

Der Visual Studio Installer bot damals unter der Webentwicklungsworkload die optionale Komponente **.NET Aspire SDK (Preview)** an. Das zweite Bild zeigt das damalige Docker-Desktop-Installationsprogramm für Windows.

[![Visual Studio Installer mit ausgewählter ASP.NET-Webentwicklungsworkload und aktiviertem .NET Aspire SDK (Preview) unter Optional.](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

[![Docker Desktop-Installer mit aktivierten Optionen für WSL 2 statt Hyper-V und eine Desktopverknüpfung.](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Wenn `aspire --version` funktioniert, [erstelle deine erste Aspire-Starteranwendung](/de/2023/11/getting-started-with-net-aspire/). [Wie Aspire Dienste verbindet](/de/2023/11/what-is-net-aspire/), erklärt die Rolle des AppHost.
