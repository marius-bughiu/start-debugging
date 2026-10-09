---
title: "Semantic Kernel 1.81 verhindert, dass FileIOPlugin Dateien außerhalb von AllowedFolders preisgibt"
description: "Semantic Kernel .NET 1.81.0 schließt ein FileIOPlugin-Orakel: WriteAsync verriet dem Modell, dass eine Datei außerhalb von AllowedFolders existierte, schreibgeschützt war und wo sie lag. Vorher und nachher gemessen."
pubDate: 2026-10-09
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "de"
translationOf: "2026/10/semantic-kernel-1-81-fileioplugin-no-longer-leaks-paths-outside-allowedfolders"
translatedBy: "claude"
translationDate: 2026-10-09
---

Semantic Kernel .NET [1.81.0](https://github.com/microsoft/semantic-kernel/releases/tag/dotnet-1.81.0) erschien am 2026-10-06, und `Microsoft.SemanticKernel.Plugins.Core` 1.81.0-preview landete am selben Tag auf NuGet. Die Release Notes nennen [PR #14525](https://github.com/microsoft/semantic-kernel/pull/14525) "Update file handling for FileIOPlugin", was die Sache untertreibt. Bis 1.80.1 prüfte `FileIOPlugin.WriteAsync`, ob eine Datei schreibgeschützt war, *bevor* es `AllowedFolders` prüfte, und die ausgelöste Exception enthielt den vollständigen kanonischen Pfad. Wer dieses Plugin einem Modell zur Verfügung stellt, liefert damit ein Orakel für die Existenz von Dateien auf der gesamten Festplatte.

Das ist die zweite Härtungsrunde für Datei- und Netzwerkzugriffe in Folge, nachdem [1.80.0 OpenAPI-Plugins das Folgen von Weiterleitungen abgewöhnt hat](/de/2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects/).

## Was das Modell unter 1.80.1 erfahren konnte

Ich habe dieselbe dateibasierte Probe gegen beide Versionen mit SDK 10.0.302 ausgeführt. Sie legt eine schreibgeschützte `secrets.txt` außerhalb des erlaubten Ordners an, daneben eine fehlende `nope.txt` und eine schreibgeschützte `locked.txt` innerhalb des erlaubten Ordners, und ruft dann für jede `WriteAsync` auf:

```csharp
#:package Microsoft.SemanticKernel.Plugins.Core@1.80.1-preview
#:property PublishAot=false
#:property NoWarn=SKEXP0050
using Microsoft.SemanticKernel.Plugins.Core;

// allowed, readOnlyOutside, missingOutside, readOnlyInside: temp paths set up earlier
var plugin = new FileIOPlugin { AllowedFolders = [allowed], DisableFileOverwrite = false };

foreach (var f in new[] { readOnlyOutside, missingOutside, readOnlyInside })
{
    try { await plugin.WriteAsync(f, "y"); }
    catch (Exception e) { Console.WriteLine($"{Path.GetFileName(f)}: {e.GetType().Name}: {e.Message}"); }
}
```

Ausgabe unter 1.80.1-preview (Temp-Pfad gekürzt):

```text
secrets.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/outside/secrets.txt
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/allowed/locked.txt
```

Die ersten beiden Zeilen sind das Problem. Eine Datei außerhalb der Sandbox erhält eine andere Exception als eine fehlende, die Existenz ist also beobachtbar. Dasselbe passiert mit einem Standard-`new FileIOPlugin()`, dessen `AllowedFolders` leer ist, also genau der Konfiguration, die als "keine Ordner erlaubt" dokumentiert ist.

Diese Meldung erreicht tatsächlich das Modell. Beim automatischen Function Calling fängt `FunctionCallsProcessor` die Exception ab und gibt `Error: Exception while invoking function. {e.Message}` als Tool-Ergebnis zurück. Ein per Prompt Injection manipulierter Agent kann Pfade in der Art von `~/.ssh/id_rsa` oder `/etc/shadow` abtasten und die Antwort zurücklesen.

## Was sich mit 1.81.0 ändert

`TryGetAllowedFilePath` gibt jetzt sofort `false` zurück, wenn keine Ordner konfiguriert sind, umschließt die Kanonisierung des Pfads mit einem Catch für `IOException`, `UnauthorizedAccessException`, `InvalidOperationException` und `SecurityException` (sodass Symlink-Schleifen und Berechtigungsfehler zu einer schlichten Ablehnung werden) und führt die Schreibschutzprüfung erst aus, nachdem der Pfad einem erlaubten Ordner zugeordnet wurde. Außerdem enthält die Schreibschutz-Exception keinen Pfad mehr. Dieselbe Probe unter 1.81.0-preview:

```text
secrets.txt: InvalidOperationException: Writing to the provided location is not allowed.
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only.
```

Außerhalb der Sandbox sind jetzt alle Fälle ununterscheidbar. Innerhalb erhalten Sie weiterhin einen nützlichen Fehler, nur ohne Pfad. [PR #14476](https://github.com/microsoft/semantic-kernel/pull/14476), ebenfalls in 1.81.0, überträgt dieselbe Angleichung der Validierung auf `DocumentPlugin` und `CloudDrivePlugin`.

## Was zu tun ist

Aktualisieren Sie `Microsoft.SemanticKernel.Plugins.Core` auf `1.81.0-preview`, wenn irgendein Agent `FileIOPlugin` aufrufen kann. Die öffentliche API ist unverändert, es ist also nur ein Versionssprung. Wenn Sie eigene Datei-Tools kapseln, übernehmen Sie das Muster: zuerst die Sandbox prüfen, jede Ablehnung mit derselben Meldung beantworten und niemals einen aufgelösten Pfad in eine Exception schreiben, die ein Tool-Ergebnis zurück zum Modell tragen könnte.
