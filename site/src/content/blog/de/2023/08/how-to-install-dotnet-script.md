---
title: "Wie Sie dotnet script installieren"
description: "dotnet script ermöglicht es, C#-Skripte (.CSX) aus der .NET-CLI auszuführen. Einzige Voraussetzung: .NET 6 oder neuer auf dem Rechner. Mit folgendem Befehl installieren Sie dotnet-script global: Anschließend führen Sie eine Skriptdatei einfach mit dotnet script <file_path> aus, wie im Beispiel unten: Wie..."
pubDate: 2023-08-29
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
  - "dotnet"
lang: "de"
translationOf: "2023/08/how-to-install-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
`dotnet script` ermöglicht es, C#-Skripte (`.CSX`) aus der .NET-CLI auszuführen. Einzige Voraussetzung: .NET 6 oder neuer auf dem Rechner.

Mit dem folgenden Befehl installieren Sie dotnet-script global:

```bash
dotnet tool install -g dotnet-script
```

Anschließend führen Sie eine Skriptdatei einfach mit `dotnet script <file_path>` aus, wie im Beispiel unten:

```bash
dotnet script startdebugging.csx
```

## Wie Sie ein neues dotnet script initialisieren

Wenn Sie gerade erst starten und eine neue dotnet-script-Datei anlegen möchten, können Sie mit dem `init`-Befehl ein Skriptprojekt erzeugen.

```bash
dotnet script init startdebugging.csx
```

Das erstellt Ihre Skriptdatei zusammen mit der Launch-Konfiguration, die zum Debuggen des Skripts in VS Code nötig ist. Der Dateiname ist optional, ohne Angabe wird er auf `main.csx` gesetzt.

```plaintext
. 
├── .vscode 
│   └── launch.json 
├── startdebugging.csx 
└── omnisharp.json
```

## Implizite Usings

dotnet script bringt von Haus aus einige Namespaces mit, ähnlich der Implicit-Usings-Funktion in .NET-SDK-Projekten. Unten finden Sie die vollständige Liste der in dotnet-script implizit verfügbaren Namespaces.

```cs
System
System.IO
System.Collections.Generic
System.Console
System.Diagnostics
System.Dynamic
System.Linq
System.Linq.Expressions
System.Text
System.Threading.Tasks
```
