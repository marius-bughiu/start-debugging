---
title: "Azure MCP Server wird mit Visual Studio 2022 17.14.30 mitgeliefert, keine Extension nötig"
description: "Visual Studio 2022 17.14.30 bündelt den Azure MCP Server in den Azure-Entwicklungs-Workload. Copilot Chat kann über 230 Azure-Tools in 45 Services erreichen, ohne etwas zu installieren."
pubDate: 2026-04-22
tags:
  - "visual-studio"
  - "azure"
  - "mcp"
  - "github-copilot"
lang: "de"
translationOf: "2026/04/azure-mcp-server-visual-studio-2022-17-14-30"
translatedBy: "claude"
translationDate: 2026-04-24
---

Der [Visual Studio Blogpost](https://devblogs.microsoft.com/visualstudio/azure-mcp-tools-now-ship-built-into-visual-studio-2022-no-extension-required/) vom 15. April 2026 hat eine leise, aber bedeutende Änderung vergraben: Ab Visual Studio 2022 Version 17.14.30 ist der Azure MCP Server Teil des Azure-Entwicklungs-Workloads. Keine Marketplace-Extension, keine manuelle `mcp.json`, kein Onboarding pro Maschine. Wenn Sie den Workload installiert haben und sich sowohl bei GitHub als auch bei Azure anmelden, kann Copilot Chat bereits über 230 Azure-Tools in 45 Services sehen.

## Warum einbacken

Bis 17.14.30 bedeutete es, den Azure MCP Server vor Copilot Chat in VS 2022 zu bekommen, eine separate Installation, eine pro-User-JSON-Config und einen Reauth-Tanz jedes Mal, wenn der per npx gestartete Server sein Token verlor. Den Server mit dem Workload zu bündeln, entfernt den Installationsschritt und bindet die Auth an den bestehenden Azure-Account-Picker der IDE, sodass derselbe Login, der den Cloud Explorer antreibt, die MCP-Tools antreibt.

Das bringt VS 2022 außerdem auf Parität mit VS 2026, das seit November 2025 Azure-MCP-Integration ausliefert.

## Anschalten

Der Server kommt mit dem Workload, ist aber standardmäßig deaktiviert. Um ihn zu aktivieren:

1. Aktualisieren Sie Visual Studio 2022 auf 17.14.30 oder höher (Help, Check for Updates).
2. Öffnen Sie den Visual Studio Installer und bestätigen Sie, dass der Azure-Entwicklungs-Workload installiert ist.
3. Melden Sie sich bei Ihrem GitHub-Account an, damit Copilot aktiv ist, dann melden Sie sich bei Ihrem Azure-Account über den Account-Picker in der Titelleiste an.
4. Öffnen Sie Copilot Chat, klicken Sie auf das Schraubenschlüssel-Icon mit der Beschriftung "Select tools," und schalten Sie "Azure MCP Server" ein.

Danach startet der Server on demand, sobald Copilot das erste Mal ein Azure-Tool auswählt. Sie können das aus einem Chat-Prompt heraus verifizieren:

```text
> #azmcp list resource groups in subscription Production
```

Copilot wird über den gebündelten Server routen und die Live-Liste zurückgeben, beschränkt auf den Account, mit dem Sie sich angemeldet haben. Derselbe Schraubenschlüssel-Dialog zeigt einzelne Tools, sodass Sie laute abschalten können (zum Beispiel die Kosten-Tools), ohne den ganzen Server zu deaktivieren.

## Was Sie tatsächlich bekommen

Der gebündelte Server exponiert dieselbe Tool-Oberfläche, die unter [aka.ms/azmcp/docs](https://aka.ms/azmcp/docs) dokumentiert ist, gruppiert in vier Eimer:

- **Learn**: Fragen zur Service-Gestalt stellen ("welche Tier von Azure SQL unterstützt Private Link mit einer Serverless-Replica"), ohne die IDE zu verlassen.
- **Design and develop**: Config-Snippets und SDK-Aufrufe bekommen, die in den Ressourcen Ihrer Subscription verankert sind, nicht in generischen Samples.
- **Deploy**: Ressourcengruppen, Bicep-Deployments und Container Apps aus dem Chat heraus provisionieren.
- **Troubleshoot**: Application-Insights-Abfragen, App-Service-Log-Streams und AKS-Pod-Status in die Unterhaltung ziehen.

Ein Chat wie "der Staging-App-Service liefert 502, zieh die letzte Stunde Fehler und sag mir, was sich geändert hat" läuft jetzt Ende-zu-Ende ohne Copy-Paste zwischen Portal-Tabs.

## Wann der Standalone-Server immer noch Sinn ergibt

Der gebündelte Build folgt der VS-Servicing-Kadenz, die hinter den Upstream-Releases von `Azure.Mcp.Server` hinterherhinkt. Wenn Sie ein Tool brauchen, das letzte Woche gelandet ist, registrieren Sie den Standalone-Server neben dem gebündelten in `mcp.json`, und Copilot mergt die Tool-Listen. Für alle anderen ist es jetzt der richtige Schritt, diese Config-Datei zu löschen.
