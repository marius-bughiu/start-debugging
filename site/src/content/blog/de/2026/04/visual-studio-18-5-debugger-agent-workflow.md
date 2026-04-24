---
title: "Der Debugger Agent in Visual Studio 18.5 macht Copilot zum lebendigen Bug-Jagd-Partner"
description: "Visual Studio 18.5 GA liefert einen geführten Debugger-Agent-Workflow in Copilot Chat, der eine Hypothese bildet, Breakpoints setzt, durch ein Repro mitfährt, gegen Runtime-State validiert und einen Fix vorschlägt."
pubDate: 2026-04-21
tags:
  - "visual-studio"
  - "debugging"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
lang: "de"
translationOf: "2026/04/visual-studio-18-5-debugger-agent-workflow"
translatedBy: "claude"
translationDate: 2026-04-24
---

Das Visual-Studio-Team hat am 15. April 2026 [einen neuen Debugger-Agent-Workflow](https://devblogs.microsoft.com/visualstudio/stop-hunting-bugs-meet-the-new-visual-studio-debugger-agent/) in Visual Studio 18.5 GA ausgeliefert. Wenn Sie das letzte Jahr damit verbracht haben, Copilot zu fragen "warum ist das hier null" und einen selbstsicheren Rateversuch zu bekommen, der dem tatsächlichen Call Stack widersprach, ist diese Release die Korrektur. Der Agent ist nicht länger ein Chatbot, der Ihre Quelldateien liest. Er steuert eine interaktive Debug-Session, setzt eigene Breakpoints und argumentiert gegen lebenden Runtime-State.

## Statische Analyse hat nicht gereicht

Frühere Iterationen von [Debug with Copilot](https://devblogs.microsoft.com/visualstudio/visual-studio-2026-debugging-with-copilot/) waren hilfreich für Exception-Assistance und "erkläre diesen Stack Frame"-Prompts, aber sie arbeiteten auf einem eingefrorenen Snapshot Ihres Codes. Wenn der eigentliche Fehler in einer Race zwischen zwei Async-Continuations lag oder in State, der nur nach dem fünfzehnten Klick existierte, konnte ein statischer Blick auf `MyService.cs` das einfach nicht sehen. VS 18.5 schließt diese Lücke, indem der Agent am tatsächlichen Repro teilnimmt.

## Der Vier-Phasen-Loop

Sobald Ihre Solution offen ist, schalten Sie Copilot Chat in den Debugger-Modus und übergeben ihm eine Bug-Beschreibung. Der Workflow geht dann in Reihenfolge durch vier Phasen:

1. **Hypothese und Vorbereitung.** Der Agent analysiert die Beschreibung plus den Code und schlägt eine Root-Cause-Theorie vor. Dann setzt er "Intelligent Breakpoints" auf die verdächtigen Pfade und bietet an, das Projekt für Sie zu starten. Wenn Ihr Startup ungewöhnlich ist, können Sie manuell starten und ihn sich attachen lassen.
2. **Aktive Reproduktion.** Der Agent bleibt in der Leitung, während Sie sich durch das Repro klicken. Er beobachtet Runtime-State bei jedem Breakpoint-Treffer, nicht durch erneutes Lesen der Datei.
3. **Echtzeit-Validierung.** Bei jedem Stopp evaluiert er Locals und den Call Stack, um seine Hypothese zu bestätigen oder zu eliminieren. Falsche Rateversuche werden auf Basis der Evidenz verworfen, nicht verteidigt.
4. **Der finale Fix.** Wenn der Agent zuversichtlich ist, die Ursache gefunden zu haben, schlägt er eine Codeänderung vor. Wenn Sie zustimmen, wendet er die Edit an und fährt die Session erneut, um zu verifizieren, dass der Bug weg ist.

Die unterstützten Szenarien im 18.5-GA-Drop sind "exceptions, logic inconsistencies, and state corruption." Performance-Regressionen und reine Concurrency-Bugs stehen noch nicht auf der Liste.

## Wie eine Session aussieht

Ein minimaler Walkthrough für einen klassischen Null-Ref sieht so aus:

```text
You: The app throws NullReferenceException when saving a new invoice
     with no line items. Repro: open /invoices/new, click Save.

Agent: Hypothesis - Invoice.Total() dereferences LineItems before the
       collection is initialised for empty invoices.
       Setting breakpoints at InvoiceService.cs:42 and Invoice.cs:18.
       Launching IIS Express on https://localhost:7080 ...
```

Sie laufen durch das Repro. Der Breakpoint bei `Invoice.cs:18` trifft, der Agent liest `this.LineItems` vom Stack Frame, sieht `null` statt einer leeren Liste und bestätigt die Hypothese, ohne Sie um einen Step bitten zu müssen. Dann bietet er:

```csharp
public decimal Total() =>
    (LineItems ?? []).Sum(li => li.Quantity * li.UnitPrice);
```

Zustimmen, und er fährt das Szenario erneut, um zu bestätigen, dass die Exception weg ist.

## Warum es zählt

Die interessante Verschiebung hier ist, dass der Agent in Runtime-Wahrheit verankert ist. Sie können ihn immer noch überstimmen, seine Breakpoints ignorieren und manuell debuggen, was der richtige Default für alles Sicherheitskritische oder unvertrauten Code ist. Aber für den Long Tail von "Ich habe ein Repro und einen Stack Trace und muss State bisektieren" wird der Loop vom Bug-Report zum verifizierten Fix drastisch kürzer. Erwarten Sie, dass mehr Ihrer Debugging-Zeit damit verbracht wird, die Evidenz des Agents zu prüfen, statt selbst Breakpoints zu setzen.

Das Feature ist heute in VS 18.5 GA. Wenn Sie noch auf 17.x oder einem früheren 18.x-Preview sind, haben Sie den alten Chat-Stil Debug with Copilot. Der geführte Workflow erfordert 18.5.
