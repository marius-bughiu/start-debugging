---
title: "Blazor-Rendermodi in .NET 11: Server, WebAssembly und Auto"
description: "Blazor Web App oder eigenständiges WebAssembly anhand von Hosting, Offline-Betrieb und Diensten wählen, mit korrigiertem Auto-Verhalten."
pubDate: 2026-05-26
updatedDate: 2026-11-02
tags:
  - "dotnet-11"
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "de"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

**Korrektur — 2. November 2026:** Die frühere Fassung enthielt unbelegte Benchmarks und falsche Aussagen zu Auto-Rendering, Vorlagen, Offline-Fähigkeit und Rendergrenzen. Diese Aussagen wurden korrigiert. Hier werden keine Leistungsmessungen für .NET 11 präsentiert.

Für eine neue servergehostete Blazor-Anwendung ist **Blazor Web App** ein sinnvoller Ausgangspunkt. Sie unterstützt statisches Rendering sowie optionale Server-, WebAssembly- oder Auto-Interaktivität. Soll die Anwendung vollständig als statische Dateien bereitgestellt werden, kommt **eigenständiges Blazor WebAssembly** infrage. „Blazor United“ war ein früher Name für den kombinierten Ansatz, keine dritte installierbare Runtime.

Zum Korrekturdatum führt Microsoft [.NET 11 RC3 als Go-live-Vorabversion](https://dotnet.microsoft.com/en-us/download/dotnet/11.0). .NET 10 ist die aktuelle LTS-Version; .NET 11 gehört zur STS-Linie. Entscheiden Sie über den Supportzeitraum getrennt von der Rendering-Architektur.

## Wo soll die Komponente laufen?

| Auswahl | Geeignet für | Zu berücksichtigende Kosten |
| --- | --- | --- |
| Statisches SSR | Inhalte und requestbasierte Formulare mit servergerendertem HTML | Keine interaktive C#-Ereignisbehandlung |
| Interactive Server | Serverdienste und kleine initiale Downloads | Verbindungslatenz, Circuits und Serverressourcen |
| Interactive WebAssembly | Interaktive UI im Browser | Runtime-Download, Browser-APIs und Backend-API |
| Interactive Auto | Beide Ausführungsumgebungen sind sinnvoll | Zwei Ausführungspfade entwickeln und prüfen |
| Eigenständiges WebAssembly | Statisches Hosting oder bewusst entworfene Offline-PWA | Cache-Strategie und separat abgesicherte APIs |

Auto wählt die interaktive Runtime beim Erstellen einer Komponenteninstanz. Zunächst kann Server zum Einsatz kommen, bei späteren Besuchen nach dem Caching WebAssembly. **Eine bereits laufende Komponente wechselt nicht von Server zu WebAssembly.** Ein Serverneustart wird durch Auto daher nicht automatisch unproblematisch. Siehe die [Renderregeln](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0).

## Aktuelle Vorlagen verwenden

Diese Befehle wurden mit SDK 8.0.427 und 10.0.302 geprüft. Prüfen Sie unter .NET 11 mit `dotnet new blazor --help` die Optionen des installierten Builds; unter .NET 11 wurden die Befehle für diese Korrektur nicht ausgeführt.

```bash
dotnet new blazor -o ServerDemo --interactivity Server --no-restore
dotnet new blazor -o AutoDemo --interactivity Auto --no-restore
dotnet new blazorwasm -o OfflineDemo --pwa --no-restore
```

Die Server-Option verwendet Blazor Web App ohne erforderliches WebAssembly-Clientprojekt. Ein Verbot von WebAssembly-Downloads erfordert nicht die alte Vorlage `blazorserver`, die in beiden getesteten SDKs fehlte. Auto erzeugt ein `.Client`-Projekt; im Browser ausgeführte Komponenten müssen darin enthalten sein. Die [Tooling-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/blazor/tooling?view=aspnetcore-11.0) erläutert die Vorlagen.

Diese Seite ließ sich in der generierten Server-Anwendung mit beiden SDKs kompilieren:

```razor
@page "/counter-check"
@rendermode InteractiveServer

<button @onclick="() => count++">@count</button>

@code {
    private int count;
}
```

Statisches SSR ist der Standard, wenn kein interaktiver Modus gesetzt oder geerbt wird. Es gibt keinen eingebauten Direktivenwert `@rendermode StaticServer`. Das Entfernen einer Direktive reicht nur, wenn das Elternelement keine Interaktivität vorgibt.

## Grenzen und Dienste beachten

Ein statisches Elternelement kann interaktive Inseln enthalten, auch Geschwister mit unterschiedlichen Modi. Ein interaktives Kind kann nicht auf einen inkompatiblen interaktiven Modus wechseln. Parameter an einer statisch-interaktiven Grenze müssen serialisierbar sein; beliebige Renderfragmente lassen sich nicht darüberreichen.

Serverkomponenten können Serverdienste aufrufen, benötigen aber weiterhin Autorisierung und passende Dienstlebenszyklen. Browserkomponenten dürfen keine Datenbankzugangsdaten oder andere Geheimnisse enthalten. Fehlende DI-Registrierungen fallen häufig erst zur Laufzeit auf. Auto benötigt geeignete Dienstimplementierungen in beiden Umgebungen. Interaktive Komponenten werden standardmäßig vorgerendert; browserabhängige APIs erfordern deshalb auch bei WebAssembly eine passende Lifecycle-Behandlung.

## Offline-Betrieb, Skalierung und Hybrid getrennt betrachten

Eine WebAssembly-Komponente in einer Blazor Web App macht die Anwendung nicht automatisch offlinefähig. Eine eigenständige PWA benötigt Service Worker, gecachte Ressourcen, lokale Daten und Synchronisierung. Ungecachte Navigation und entfernte API-Aufrufe können weiterhin scheitern.

Serverinteraktivität benötigt eine funktionierende SignalR-Verbindung. Die Kapazität hängt von Zustand und Last pro Circuit ab; es gibt keine universelle Grenze von 5.000 Benutzern. WebAssembly verlagert UI-Arbeit in den Browser, macht Backend-APIs aber nicht unbegrenzt skalierbar. Messen Sie Startzeit, Übertragung, Interaktionslatenz und Serverspeicher selbst. Für die früheren festen Zahlen fehlten reproduzierbare Belege.

[Blazor Hybrid](https://learn.microsoft.com/en-us/aspnet/core/blazor/hybrid/?view=aspnetcore-10.0) führt Razor-Komponenten in der nativen .NET-Runtime einer Desktop-/Mobilanwendung aus. Eine eigenständige WebAssembly-Anwendung ist nicht erforderlich. Das gemeinsame Nutzen einer Razor-Klassenbibliothek ist eine separate Entwurfsentscheidung.

Wählen Sie bei bestehenden Anwendungen die kleinste Architekturänderung, die ein gemessenes Problem löst. Der [Framework-Migrationsleitfaden](/de/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) behandelt zusätzlich den Ersatz von `System.Web`.

**Prüfgrenzen:** Vorlagenerzeugung, Server-Builds und Zählerkomponente wurden unter .NET 8 und 10 geprüft. Kein .NET-11-Build, Browserbenchmark, Offline-Browsertest oder Auto-Lifecycle-Experiment wurde durchgeführt.

## Weitere Primärquellen

- [Blazor hosting models](https://learn.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor PWA](https://learn.microsoft.com/en-us/aspnet/core/blazor/progressive-web-app?tabs=visual-studio)
