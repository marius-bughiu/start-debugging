---
title: "Der .NET-Modernisierungsagent läuft jetzt in der Copilot-CLI, nicht nur in Visual Studio"
description: "Der modernize-dotnet-Agent von GitHub Copilot wurde am 2026-07-09 als portables Plugin veröffentlicht. Er läuft jetzt in VS Code, in der Copilot-CLI und auf GitHub, mit einem Ablauf aus Bewerten, Planen und Ausführen, dessen Artefakte zur Prüfung in Ihr Repository eingecheckt werden."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
lang: "de"
translationOf: "2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin"
translatedBy: "claude"
translationDate: 2026-07-10
---

Den Großteil des letzten Jahres hatte das .NET-Modernisierungswerkzeug von GitHub Copilot nur eine Heimat: Visual Studio. Wenn Ihr Team in VS Code lebte, auf der Kommandozeile arbeitete oder alles über Pull Requests prüfte, lag die Erfahrung "Modernisiere meine Altanwendung" an einem Ort, an dem Sie nicht arbeiteten. Am 2026-07-09 hat Microsoft [den `modernize-dotnet`-Agenten als portables Plugin veröffentlicht](https://devblogs.microsoft.com/dotnet/modernize-dotnet-anywhere-with-ghcp/), das auf vier Oberflächen läuft: Visual Studio, VS Code, die GitHub-Copilot-CLI und GitHub selbst.

## Warum "überall" hier wirklich zählt

Modernisierung ist kein einzelner Befehl. Es ist Bewerten, Planen und dann eine lange Folge von Codetransformationen, die Sie begleiten. Dies in eine einzige IDE zu zwingen bedeutete, dass die Person, die die Aktualisierung vorantrieb, für eine oft mehrtägige Aufgabe den Kontext aus ihrer gewohnten Umgebung wechseln musste. Denselben Agenten in die CLI zu verlagern erlaubt es Terminal-orientierten Entwicklern, ihn neben ihrem Build- und Testzyklus auszuführen, und ihn auf GitHub bereitzustellen erlaubt es, dass die Aktualisierung als prüfbare, kollaborative Arbeitseinheit stattfindet statt als lokale Sitzung einer einzelnen Person.

Der Arbeitsablauf ist überall gleich, und das ist der Punkt. Der Agent folgt einem Modell aus Bewerten, Planen und Ausführen und schreibt drei Artefakte in Ihr Repository:

1. Eine **Bewertung**, die Umfang und Blocker vor jeder Codeänderung offenlegt.
2. Einen **Aktualisierungsplan**, der die Arbeit sequenziert.
3. **Aktualisierungsaufgaben**, die die eigentlichen Transformationen anwenden.

Da diese Artefakte in das Repository eingecheckt werden, prüft Ihr Team den Plan genauso wie einen PR, bevor die Ausführung eine einzige Codezeile berührt.

## Ausführen über die Copilot-CLI

Der CLI-Weg installiert den Agenten als Plugin und steuert ihn dann mit natürlicher Sprache. Die Befehle sind kurz:

```bash
# Add the plugin marketplace and install the agent
/plugin marketplace add dotnet/modernize-dotnet
/plugin install modernize-dotnet@modernize-dotnet-plugins

# Select the agent, then describe the job
/agent modernize-dotnet
upgrade my solution to a new version of .NET
```

Von dort aus erzeugt der Agent die Bewertung, schlägt den Plan vor und wendet die Aufgaben mit menschlicher Freigabe bei jedem Schritt an. Er übernimmt die undankbaren Teile einer Aktualisierung: das Anheben des Target Framework, das Aktualisieren der Abhängigkeiten und das Beheben der Compilerfehler, die eine Änderung von `TargetFramework` hinterlässt.

## Was er heute abdeckt

Zu den unterstützten Workloads gehören ASP.NET Core, Blazor, Azure Functions, WPF, Klassenbibliotheken und Konsolenanwendungen sowie Migrationen von .NET Framework zu modernem .NET. Web Forms ist noch nicht im Umfang enthalten. Wenn Sie die reine Visual-Studio-Version zuvor ausprobiert haben und sie sich nur schwer in einen Teamworkflow einfügen ließ, ist dies das Release, das das Auslieferungsmodell behebt, nicht die Funktionalität.

Der Agent wird offen unter [dotnet/modernize-dotnet](https://github.com/microsoft/github-copilot-appmod) entwickelt, und die Verteilung auf vier Oberflächen ist jetzt verfügbar. Die interessante Verschiebung ist nicht, dass Copilot .NET-Code aktualisieren kann, sondern dass die Aktualisierung jetzt ein Repository-Artefakt ist, das Sie prüfen, keine Blackbox innerhalb eines einzigen Editors.
