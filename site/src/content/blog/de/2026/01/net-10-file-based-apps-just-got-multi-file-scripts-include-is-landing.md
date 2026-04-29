---
title: "Datei-basierte Apps in .NET 10 bekommen Multi-File-Skripte: `#:include` kommt"
description: ".NET 10 ergänzt #:include für datei-basierte Apps, sodass dotnet run-Skripte mehrere .cs-Dateien umfassen können, ohne ein komplettes Projekt anzulegen."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing"
translatedBy: "claude"
translationDate: 2026-04-30
---
Die "datei-basierten Apps" in .NET 10 werden Schritt für Schritt praktischer. Ein neuer SDK-Pull-Request ergänzt Unterstützung für `#:include`, wodurch `dotnet run foo.cs` nicht mehr "eine Datei oder gar nichts" bedeuten muss.

Das wird im SDK als "File-based apps: add support for `#:include`" verfolgt und soll den offensichtlichen Skripting-Anwendungsfall lösen: Code in ein Hauptskript plus Helfer aufteilen, ohne ein vollständiges Projekt zu erstellen.

## Warum mehrere Dateien für `dotnet run file.cs` wichtig sind

Der Schmerz ist einfach. Wenn Ihr Skript über eine einzelne Datei hinauswächst, bleiben Ihnen zwei Optionen:

-   Helfer in dieselbe Datei kopieren (wird schnell unleserlich), oder
-   Aufgeben und ein vollständiges Projekt anlegen (zerstört den "schnellen Skript"-Workflow).

Das gewünschte Verhalten ist im SDK-Issue beschrieben: `dotnet run file.cs` sollte Code aus einer benachbarten `util.cs` nutzen können, ohne zusätzliches Drumherum.

## Was `#:include` ändert

Mit `#:include` kann die Hauptdatei andere `.cs`-Dateien hereinziehen, sodass der Compiler beim Ausführen eine einzige Compilation Unit sieht. Es ist die fehlende Brücke zwischen "Skript-Gefühl" und "echter Code-Organisation".

Das ist kein C#-Sprachfeature; es ist eine Fähigkeit des .NET SDK für datei-basierte Apps. Das ist wichtig, weil sie sich in den .NET-10-Previews schnell weiterentwickeln kann, ohne auf eine Sprachversion warten zu müssen.

## Ein winziges Multi-File-Skript, das Sie wirklich ausführen können

Verzeichnis:

```bash
app\
  file.cs
  util.cs
```

`file.cs`:

```cs
#:include "util.cs"

Console.WriteLine(Util.GetMessage());
```

`util.cs`:

```cs
static class Util
{
    public static string GetMessage() => ".NET 10 file-based apps can include files now.";
}
```

Führen Sie es mit einem .NET-10-Preview-SDK aus:

```bash
dotnet run app/file.cs
```

## Zwei Praxisdetails, die Sie im Auge behalten sollten

### Caching kann Änderungen verbergen

Datei-basierte Apps verlassen sich auf Caching, damit Inner-Loop-Läufe schnell bleiben. Wenn Sie veraltete Ausgaben vermuten, starten Sie erneut mit `--no-cache`, um einen Rebuild zu erzwingen.

### Nicht-`.cs`-Elemente können den "Fast Path" erschweren

Wenn Sie datei-basierte Apps mit Web-SDK-Teilen verwenden (zum Beispiel `.razor` oder `.cshtml`), gibt es ein offenes Issue zur Cache-Invalidierung, wenn sich Nicht-`.cs`-Default-Items ändern. Behalten Sie das im Kopf, bevor Sie datei-basierte Apps als Ersatz für ein echtes App-Projekt behandeln.

Wenn Sie das genaue Rollout verfolgen wollen, starten Sie hier:

-   PR: [https://github.com/dotnet/sdk/pull/52347](https://github.com/dotnet/sdk/pull/52347)
-   Issue zum Multi-File-Szenario: [https://github.com/dotnet/sdk/issues/48174](https://github.com/dotnet/sdk/issues/48174)
