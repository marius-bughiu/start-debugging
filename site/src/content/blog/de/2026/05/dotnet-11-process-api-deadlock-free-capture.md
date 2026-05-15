---
title: ".NET 11 bringt deadlockfreie Erfassung von Prozessausgaben"
description: ".NET 11 Preview 4 liefert neue System.Diagnostics.Process-APIs, die stdout und stderr parallel leeren, plus Einzeiler-Helfer für Start-und-Erfassen sowie KillOnParentExit."
pubDate: 2026-05-15
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "de"
translationOf: "2026/05/dotnet-11-process-api-deadlock-free-capture"
translatedBy: "claude"
translationDate: 2026-05-15
---

Adam Sitnik hat eine Reihe von Verbesserungen an `System.Diagnostics.Process` [angekündigt](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), die in .NET 11 Preview 4 gelandet sind. Die zentrale Nachricht: Die Deadlock-Falle, in die jeder .NET-Entwickler mindestens einmal tappt, ist endlich auf BCL-Ebene gelöst, und der Boilerplate-Code rund um "Prozess starten, Ausgabe erfassen, warten" reduziert sich auf einen einzigen Aufruf.

## Warum das alte Muster blockiert

Die klassische Form sieht sicher aus und ist es nicht:

```csharp
var psi = new ProcessStartInfo("git", "log")
{
    RedirectStandardOutput = true,
    RedirectStandardError = true,
};
using var p = Process.Start(psi)!;
string stdout = p.StandardOutput.ReadToEnd();
string stderr = p.StandardError.ReadToEnd();
p.WaitForExit();
```

Wenn der Kindprozess mehr in `stderr` schreibt, als der Pipe-Puffer fasst, bevor der Elternprozess `stderr.ReadToEnd()` aufruft, blockiert das Kind auf der vollen Pipe und der Elternprozess blockiert beim Warten auf das Schließen von `stdout`. Beide warten endlos. Der dokumentierte Workaround war die ereignisbasierte API mit `OutputDataReceived`, manuellen `StringBuilder`-Instanzen und einem `ManualResetEvent` pro Stream. Das funktioniert, aber niemand schreibt es beim ersten Versuch korrekt.

## Die neuen Einzeiler

.NET 11 ergänzt `Process.RunAndCaptureText` und `Process.RunAndCaptureTextAsync`, die beide Pipes intern multiplexen:

```csharp
ProcessTextOutput result = await Process.RunAndCaptureTextAsync(
    "git",
    ["log", "--oneline", "-n", "20"]);

if (result.ExitStatus.ExitCode != 0)
    throw new InvalidOperationException(result.StandardError);

Console.WriteLine(result.StandardOutput);
```

`ProcessTextOutput` enthält den erfassten stdout, stderr, die Prozess-ID und einen `ProcessExitStatus`, der sowohl den Exit-Code als auch unter Unix das beendende Signal meldet. Daneben gibt es `Process.ReadAllText` für Aufrufer, die bereits einen laufenden `Process` haben, sowie `ReadAllLines/Async` für das Streaming von `IEnumerable<ProcessOutputLine>` mit einem `StandardError`-Flag pro Zeile und `ReadAllBytes/Async` für binäre Werkzeuge. Laut Blog allokiert das synchrone `RunAndCaptureText` unter Windows rund 4.5-mal weniger Speicher als die entsprechende ereignisbasierte Schleife.

## Lebensdauer und Abkopplung

Auch zwei alte Fallstricke bekommen erstklassigen Support. `ProcessStartInfo.KillOnParentExit` koppelt das Kind unter Windows, Linux und Android an die Lebensdauer des Elternprozesses, sodass ein abstürzendes CLI-Tool keine verwaisten Worker mehr hinterlässt. `ProcessStartInfo.StartDetached` ist das Gegenteil: Das Kind überlebt den Elternprozess und das Terminal, das es gestartet hat. Und `Process.StartAndForget` gibt nur die PID zurück und gibt das Handle des Elternprozesses sofort frei, was man für Fire-and-Forget-Starts braucht:

```csharp
int pid = Process.StartAndForget("notepad.exe");
```

## Handle-Verkabelung

Für tiefergehende Szenarien akzeptieren `ProcessStartInfo.StandardInputHandle`, `StandardOutputHandle` und `StandardErrorHandle` jedes `SafeFileHandle`, einschließlich Pipes aus dem neuen `SafeFileHandle.CreateAnonymousPipe` und der Verwerfungs-Senke von `File.OpenNullHandle`. Mit `ProcessStartInfo.InheritedHandles` legen Sie auf einer Whitelist genau fest, welche Handles die Fork-Grenze überqueren. Das schließt eine echte Quelle von Dateisperren-Leaks unter Windows.

Probieren Sie es in [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) aus und löschen Sie Ihre `OutputDataReceived`-Handler.
