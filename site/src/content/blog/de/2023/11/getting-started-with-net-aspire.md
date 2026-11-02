---
title: "Die erste Aspire-Starteranwendung erstellen und ausführen"
description: "Eine C#-Aspire-Anwendung mit API und Blazor-Frontend erstellen, ihr Dashboard öffnen und mit dem Projekt und den Bildern der .NET-8-Vorschau vergleichen."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "de"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Richte zunächst [Aspire CLI und die C#-Voraussetzungen](/de/2023/11/how-to-install-net-aspire/) ein. Für eine **neue** Projektmappe liefert die Vorlage `aspire-starter` einen API-Dienst, ein Blazor-Frontend und einen AppHost, der beide verbindet. Für eine vorhandene Lösung gibt es die [Aspire-13.4-Anleitung zum Ergänzen eines AppHost](/de/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## Starter erstellen und Dashboard öffnen

Führe diese Befehle im Verzeichnis aus, in dem die neue Projektmappe entstehen soll:

```sh
aspire new aspire-starter -n HelloAspire -o HelloAspire
cd HelloAspire
aspire run
```

Beantworte eventuelle Vorlagenabfragen. Der erste Befehl erzeugt die Projektmappe unter `HelloAspire`, der letzte startet ihren AppHost. Öffne die Dashboard-URL aus dem Terminal und dann in der Ressourcenliste den Endpunkt des Web-Frontends. Rufe die Wetterseite auf, um eine Anfrage vom Frontend zur API zu senden. Im Dashboard kannst du die Dienstprotokolle und den Trace dieser Anfrage untersuchen. Mit `Ctrl+C` im Terminal beendest du die Anwendung.

Im Starter stellt `ApiService` die Daten bereit, `Web` ruft sie ab und `ServiceDefaults` enthält gemeinsame Konfiguration. Der AppHost registriert die Projekte und verbindet das Frontend mit seinen Abhängigkeiten. Der [aktuelle C#-Schnellstart](https://aspire.dev/get-started/first-app/?lang=csharp) zeigt die Vorlagenstruktur. [Der Aspire-Überblick](/de/2023/11/what-is-net-aspire/) erklärt, wie ein Ressourcenverweis funktioniert.

## Archiv: die .NET-8-Vorschau vom November 2023

**Korrektur — 2. November 2026:** Die obigen Schritte verwenden die Aspire CLI 13.x. Die Screenshots, der optionale Redis-Schalter und die API `AddRedisContainer` unten stammen aus der [Vorschau von 2023](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). Ihr AppHost zielte auf `net8.0` und verwendete [Aspire.Hosting 8.0.0-preview.1.23557.2](https://www.nuget.org/packages/Aspire.Hosting/8.0.0-preview.1.23557.2).

In Visual Studio 2022 Preview wurde damals **.NET Aspire Starter Application** ausgewählt und **Use Redis for caching** aktiviert. Der entsprechende CLI-Befehl lautete:

```sh
dotnet new aspire-starter --use-redis-cache --output Foo
```

[![Visual Studio-Dialog zum Erstellen eines neuen Projekts mit einer gefilterten Liste von .NET Aspire-Projektvorlagen.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

[![Dialog mit zusätzlichen Informationen für die Vorlage .NET Aspire Starter Application mit der optionalen Option Use Redis for caching (Docker erforderlich).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

Der AppHost verwies auf `ApiService` und `Web`. Beide nutzten `ServiceDefaults`, wie das ursprüngliche Abhängigkeitsdiagramm zeigt:

[![Ein Projektabhängigkeitsdiagramm für eine .NET Aspire Starter Application mit AppHost an der Spitze, abhängig von ApiService und Web, beide abhängig von ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

Der Vorschau-AppHost registrierte Redis als `cache` und die API als `apiservice`. Das Web-Frontend verwies auf beide. So sah die damalige API aus:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var cache = builder.AddRedisContainer("cache");
var api = builder.AddProject<Projects.Foo_ApiService>("apiservice");
builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(api);
builder.Build().Run();
```

Das ursprüngliche Dashboard zeigte Projekte und Container zusammen. Im Trace einer Wetteranfrage waren die einzelnen Dienstaufrufe sichtbar:

[![Das .NET Aspire-Dashboard, das die Vorlage .NET Aspire Starter Application ausführt.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

[![Ein Anfrage-Trace im .NET Aspire-Dashboard, der die Anfrage in Phasen zeigt, während sie die verschiedenen Anwendungskomponenten durchläuft.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)
