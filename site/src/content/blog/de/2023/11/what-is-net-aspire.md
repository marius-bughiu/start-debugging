---
title: "Was ist .NET Aspire? AppHost, Diensterkennung und Dashboard"
description: "Wie ein Aspire-AppHost eine API mit einem Frontend verbindet, was ServiceDefaults konfiguriert und was das Dashboard zeigt."
pubDate: 2023-11-14
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "de"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Eine API und ein Frontend können beide laufen, während das Frontend den falschen Port aufruft. Mit Aspire beschreibt man diese Dienste und ihre Abhängigkeiten in einem **AppHost**. Beim lokalen Start startet Aspire die Ressourcen und übergibt Verbindungsinformationen an die Dienste, die auf sie verweisen.

## Wie das Frontend die API findet

Angenommen, ein C#-AppHost verweist auf zwei Projekte namens `Api` und `Web`. Das Beispiel registriert beide als Ressourcen und legt fest, dass der Webdienst die API benötigt:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var api = builder.AddProject<Projects.Api>("api");
builder.AddProject<Projects.Web>("web").WithReference(api);
builder.Build().Run();
```

`WithReference(api)` übergibt dem Webprojekt Endpunktinformationen für die Ressource `api`. Ein für Diensterkennung konfigurierter Client kann den logischen Namen verwenden. Den HTTP-Aufruf führt weiterhin das Frontend aus, und die API verarbeitet ihn. Bei einer Datenbank kann dieses Muster eine Verbindungszeichenfolge bereitstellen.

## Was die übrigen Teile leisten

Das **ServiceDefaults**-Projekt der Startervorlage bündelt Konfiguration für Diensterkennung, Integritätsprüfungen und Telemetrie. Die teilnehmenden Dienste rufen diese Erweiterungen auf. Das **Dashboard** zeigt Ressourcenzustand und Endpunkte. Anhand der von den Diensten ausgegebenen Protokolle und verteilten Traces lässt sich etwa sehen, ob eine langsame Seite Zeit im Frontend oder beim Warten auf die API verbringt.

**Korrektur — 2. November 2026:** Die [Ankündigung der ursprünglichen .NET-8-Vorschau](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/) verwendete ältere Hosting-APIs. Das Beispiel oben beschreibt das C#-AppHost-Modell von Aspire 13.x. Ein Projektverweis allein konfiguriert nicht automatisch jeden Client.

[Installiere die Aspire CLI](/de/2023/11/how-to-install-net-aspire/) und [erstelle und starte die Beispielanwendung](/de/2023/11/getting-started-with-net-aspire/), um ihre Dienstendpunkte im Dashboard zu sehen.
