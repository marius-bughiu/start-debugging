---
title: "Azure Functions vs WebJobs: welches wählen"
description: "Vergleichen Sie Azure Functions und WebJobs: zentrale Unterschiede bei Skalierung, Preisen, Triggern und wann sich welches anbietet."
pubDate: 2020-11-18
updatedDate: 2021-02-19
tags:
  - "azure"
  - "azure-functions"
lang: "de"
translationOf: "2020/11/azure-functions-vs-webjobs-which-to-choose"
translatedBy: "claude"
translationDate: 2026-05-01
---
Beide sind Code-First-Technologien für Entwickler ([im Gegensatz zu Design-First-Workflow-Diensten](/de/2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate/)). Sie ermöglichen die Orchestrierung und Integration verschiedener Geschäftsanwendungen in einem einzigen Workflow und bieten mehr Kontrolle über die Performance Ihres Workflows sowie die Möglichkeit, eigenen Code als Teil des Geschäftsprozesses zu schreiben.

## Azure WebJobs

WebJobs sind Teil des Azure App Service und können verwendet werden, um ein Programm oder Skript automatisch auszuführen. Es gibt zwei Arten von WebJobs:

-   **Continuous.** Werden in einer Endlosschleife ausgeführt. Beispielsweise könnten Sie einen kontinuierlichen WebJob nutzen, um einen freigegebenen Ordner auf neue Fotos zu prüfen.
-   **Triggered.** Können manuell oder zeitgesteuert ausgeführt werden.

Für die Aktionen Ihres WebJobs können Sie Code in verschiedenen Sprachen schreiben. Sie können den WebJob beispielsweise per Shell Script (Windows, PowerShell, Bash) skripten. Alternativ können Sie ein Programm in PHP, Python, Node.js, JavaScript oder .NET sowie in jeder vom Framework unterstützten Sprache schreiben.

## Azure Functions

Eine Azure Function ähnelt einem WebJob in vielerlei Hinsicht; der Hauptunterschied besteht darin, dass Sie sich überhaupt nicht um die Infrastruktur kümmern müssen.

Sie eignet sich ideal, um kleine Codestücke in der Cloud auszuführen. Azure skaliert Ihre Function automatisch je nach Bedarf, und mit dem Consumption Plan zahlen Sie nur für die Laufzeit Ihres Codes.

Sie können auf eine Reihe verschiedener Trigger reagieren, zum Beispiel:

-   **HTTPTrigger**. Wird als Antwort auf eine über das HTTP-Protokoll gesendete Anfrage ausgeführt.
-   **TimerTrigger**. Ermöglicht die Ausführung nach einem Zeitplan.
-   **BlobTrigger**. Wenn ein neuer Blob zu einem Azure-Storage-Konto hinzugefügt wird.
-   **CosmosDBTrigger**. Als Antwort auf neue oder aktualisierte Dokumente in einer NoSQL-Datenbank.

## Unterschiede

| Feature | Azure WebJobs | Azure Functions |
| --- | --- | --- |
| Automatische Skalierung | Nein | Ja |
| Entwicklung und Tests im Browser | Nein | Ja |
| Pay-per-Use-Preise | Nein | Ja |
| Integration mit Logic Apps | Nein | Ja |
| Paketmanager | NuGet, wenn Sie das WebJobs SDK verwenden | NuGet und NPM |
| Kann Teil einer App-Service-Anwendung sein | Ja | Nein |
| Bietet enge Kontrolle über `JobHost` | Ja | Nein |

## Fazit

Azure Functions sind in der Regel flexibler und leichter zu verwalten. WebJobs sind jedoch die bessere Lösung, wenn:

-   Sie möchten, dass der Code Teil einer bestehenden App-Service-Anwendung ist und als Teil davon verwaltet wird, beispielsweise in derselben Azure-DevOps-Umgebung.
-   Sie enge Kontrolle über das Objekt benötigen, das auf die auslösenden Events lauscht.
