---
title: "dotnet watch in .NET 11 Preview 3: Aspire-Hosts, Crash Recovery und sauberes Ctrl+C"
description: "dotnet watch bekommt in .NET 11 Preview 3 Aspire-App-Host-Integration, automatisches Relaunch nach Crashes und gefixtes Ctrl+C-Handling für Windows-Desktop-Apps."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "aspire"
  - "dotnet-watch"
lang: "de"
translationOf: "2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery"
translatedBy: "claude"
translationDate: 2026-04-24
---

`dotnet watch` war immer das stille Arbeitspferd des .NET-Inner-Loops. Es lädt Ihre App neu, wenn Dateien sich ändern, wendet Hot Reload an, wo es kann, und hält sich aus dem Weg, wenn es nicht kann. .NET 11 Preview 3 (ausgeliefert am 14. April 2026) treibt das Tool bei drei spezifischen Schmerzpunkten voran: verteilte Apps laufen lassen, Crashes überleben und mit Ctrl+C auf Windows-Desktop-Targets umgehen.

## Aspire-App-Hosts werden jetzt sauber beobachtet

Bis Preview 3 war es ungelenk, einen Aspire-App-Host unter `dotnet watch` laufen zu lassen. Aspire orchestriert mehrere Child-Projekte, und der Watcher verstand dieses Modell nicht, also führten Dateiänderungen entweder zum Rebuild nur des Hosts oder zwangen die ganze Topologie, von Grund auf neu zu starten.

Preview 3 verdrahtet `dotnet watch` direkt in das Aspire-App-Modell:

```bash
cd src/MyApp.AppHost
dotnet watch
```

Editieren Sie eine Datei in `MyApp.ApiService`, und der Watcher wendet die Änderung jetzt nur auf diesen Service an und hält den Rest der Aspire-Topologie am Leben. Das Dashboard bleibt oben, abhängige Container laufen weiter, und Sie verlieren Sekunden Boot-Time pro Änderung statt Sekunden pro Projekt.

Für Microservice-lastige Solutions ist das der Unterschied zwischen `dotnet watch` als Nice-to-have und als Standardart zu arbeiten.

## Automatisches Relaunch nach einem Crash

Die zweite Schlagzeile ist Crash Recovery. Früher, wenn Ihre beobachtete App eine unbehandelte Exception warf und starb, parkte `dotnet watch` auf der Crash-Nachricht und wartete auf manuellen Restart. Wenn Ihr nächster Tastendruck einen Fix speicherte, passierte nichts, bis Sie Ctrl+R drückten.

In Preview 3 dreht sich dieses Verhalten um. Nehmen Sie einen Endpoint, der in die Luft geht:

```csharp
app.MapGet("/", () =>
{
    throw new InvalidOperationException("boom");
});
```

Lassen Sie die App einmal crashen, speichern Sie einen Fix, und `dotnet watch` startet beim nächsten relevanten File Change automatisch neu. Sie verlieren den Feedback-Loop nicht nur, weil die App entschieden hat, non-zero zu beenden. Dasselbe Verhalten deckt Crashes beim Startup ab, die den Watcher früher stecken ließen, bevor Hot Reload überhaupt anheften konnte.

Das komponiert gut mit dem watch-weiten "Rude Edit"-Handling, das bereits existiert: Hot Reload versucht es zuerst, fällt auf einen Restart zurück bei nicht unterstützten Edits und fällt jetzt auch nach einem Crash auf einen Restart zurück. Drei Pfade, ein konsistentes Outcome: Die App kommt zurück.

## Ctrl+C bei Windows-Desktop-Apps

Der dritte Fix ist klein, aber war chronisch: Ctrl+C in `dotnet watch` für WPF- und Windows-Forms-Apps. Früher konnte es den Desktop-Prozess verwaist lassen, vom Watcher getrennt oder in einem modalen Fenster hängend. Preview 3 verdrahtet die Signal-Handhabung neu, sodass Ctrl+C sowohl den Watcher als auch den Desktop-Prozess der Reihe nach abbaut, ohne dass Zombie-`dotnet.exe`-Einträge sich im Task Manager stapeln.

Wenn Sie eine WPF-Shell unter `dotnet watch` laufen lassen:

```bash
dotnet watch run --project src/DesktopShell
```

Drücken Sie einmal Ctrl+C, und sowohl die Shell als auch der Watcher beenden sauber. Das klingt grundlegend, und das ist es, aber das frühere Verhalten war der Hauptgrund, warum viele Teams `dotnet watch` auf Desktop-Projekten komplett gemieden haben.

## Warum diese drei zusammen zählen

Jede Änderung für sich ist moderat. Kombiniert verschieben sie `dotnet watch` von einem pro-Projekt-Helfer zu einem sessionweiten Harness, der eine Aspire-Topologie den ganzen Tag hosten, den gelegentlichen Crash absorbieren und hinter sich aufräumen kann, wenn Sie fertig sind. Der Inner Loop wurde spürbar weniger fragil.

Release Notes sind im [.NET Blog](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/), und der SDK-Abschnitt lebt unter [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk).
