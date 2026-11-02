---
title: "C# Wie warten Sie, bis ein Prozess endet?"
description: "Mit WaitForExit oder WaitForExitAsync auf einen Kindprozess in C# warten: ausführbares Beispiel für Exitcodes, Zeitlimits, Abbruch und Bereinigung unter .NET 8 und 10."
pubDate: 2023-08-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit `process.WaitForExit()` blockieren Sie den aktuellen Thread, bis ein gestarteter Prozess endet. In asynchronem Code verwenden Sie stattdessen `await process.WaitForExitAsync()`; dabei wird der aufrufende Thread nicht blockiert. Lesen Sie `ExitCode` erst nach dem Ende des Prozesses aus.

> Aktualisiert am 2. November 2026: Das ursprüngliche Beispiel mit `cmd.exe /C timeout 5` war von Windows und dessen Befehlsumgebung abhängig. Die folgende Fassung startet einen eigenen Kindprozess und überprüft beide Wartemethoden, Zeitlimits und Abbruch unter .NET 8 und .NET 10.

## Das vollständige Beispiel ausführen

[Das ausführbare process-wait-Projekt herunterladen](/examples/process-wait.zip). Entpacken Sie es und führen Sie im Projektordner mit dem .NET-10-SDK diese Befehle aus. Der .NET-8-Befehl benötigt außerdem die .NET-8-Runtime:

```sh
dotnet run -c Release -f net10.0
dotnet run -c Release -f net8.0
```

Derselbe Quellcode läuft mit beiden Zielframeworks. Er startet Kopien des eigenen Programms und benötigt weder eine Shell noch ein externes Programm. Die ersten beiden Kindprozesse geben absichtlich den Exitcode `7` zurück. Der Elternprozess prüft diesen Wert und beendet sich mit `0`, wenn alle Prüfungen erfolgreich sind. Ein dritter Kindprozess wartet auf Eingabe. Dadurch hängen die Prüfungen für Zeitlimit und Abbruch nicht davon ab, wie schnell ein kurzlebiger Befehl endet.

Die vollständige Datei `Program.cs`:

```cs
using System.Diagnostics;
using System.Reflection;

if (args is ["--child"])
{
    await Task.Delay(100);
    return 7;
}

if (args is ["--child-until-input"])
{
    await Console.In.ReadLineAsync();
    return 0;
}

using (var process = StartChild("--child"))
{
    process.WaitForExit();
    Require(process.ExitCode == 7, "Synchronous child exit code.");
    Console.WriteLine($"sync exit: {process.ExitCode}");
}

using (var process = StartChild("--child"))
{
    await process.WaitForExitAsync();
    Require(process.ExitCode == 7, "Asynchronous child exit code.");
    Console.WriteLine($"async exit: {process.ExitCode}");
}

using (var process = StartChild("--child-until-input"))
{
    try
    {
        bool exited = process.WaitForExit(50);
        Require(!exited, "A timed-out wait must leave the child running.");
        Console.WriteLine($"timed wait exited: {exited}");

        using var cancellation = new CancellationTokenSource(50);
        bool canceled = false;
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            canceled = true;
        }

        Require(canceled && !process.HasExited, "Canceling the wait must not kill the child.");
        Console.WriteLine("canceled wait; child still running");

        process.StandardInput.Close();
        await process.WaitForExitAsync();
        Require(process.ExitCode == 0, "The released child must exit normally.");
        Console.WriteLine($"released child exit: {process.ExitCode}");
    }
    finally
    {
        if (!process.HasExited)
        {
            try { process.Kill(); }
            catch (InvalidOperationException) when (process.HasExited) { }
            await process.WaitForExitAsync();
        }
    }
}

return 0;

static Process StartChild(string mode)
{
    var start = new ProcessStartInfo
    {
        FileName = Environment.ProcessPath ?? throw new InvalidOperationException("No process path."),
        UseShellExecute = false,
        RedirectStandardInput = mode == "--child-until-input"
    };

    if (string.Equals(Path.GetFileNameWithoutExtension(start.FileName), "dotnet", StringComparison.OrdinalIgnoreCase))
        start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);

    start.ArgumentList.Add(mode);
    return Process.Start(start) ?? throw new InvalidOperationException("Child did not start.");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
```

Erwartete Ausgabe:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

## Zeitlimits, Abbruch und Bereinigung

`WaitForExit(50)` gibt `false` zurück, wenn der Kindprozess innerhalb der angegebenen Millisekunden nicht beendet wurde. `WaitForExitAsync(token)` löst beim Abbruch des Wartens eine `OperationCanceledException` aus. Beides beendet den Kindprozess nicht. Im Beispiel kann er regulär enden, sobald seine Eingabe geschlossen wird. Der `finally`-Block beendet bei einem Fehler ausschließlich den von diesem Beispiel gestarteten Kindprozess, falls dies zur Bereinigung nötig ist.

Legen Sie für ein echtes Tool ausdrücklich fest, ob Sie weiter warten, über dessen Protokoll ein geordnetes Ende anfordern oder den Prozess gegebenenfalls zwangsweise beenden. `Kill()` fordert eine erzwungene Beendigung an; warten Sie anschließend trotzdem auf das Ende des Prozesses. Das Freigeben eines `Process` mit `Dispose` gibt die Ressourcen der Komponente frei, beendet aber nicht das laufende Programm.

Der [Leitfaden zur using-Deklaration in C#](/de/2020/05/c-using-var-using-declaration/) erklärt, wie `using` die Ressourcen beim Verlassen eines Gültigkeitsbereichs freigibt.

Wenn Sie Standardausgabe oder Standardfehlerausgabe umleiten, beginnen Sie vor dem Warten mit dem Lesen dieser Streams. Eine volle Pipe kann sonst dazu führen, dass der Kindprozess auf den Elternprozess wartet und dieser auf den Kindprozess. Der [Leitfaden zur Erfassung von Prozessausgaben](/de/2026/05/dotnet-11-process-api-deadlock-free-capture/) behandelt dieses andere Problem und die neueren .NET-11-APIs. Das Beispiel hier verwendet bereits unter .NET 8 verfügbare APIs.

Lokal auf macOS arm64 mit den tatsächlichen Runtimes .NET 8.0.33 und .NET 10.0.10 geprüft, sowohl über den erzeugten Apphost als auch mit `dotnet ProcessWait.dll`. Damit wird keine Ausführung unter Windows oder Linux behauptet; der Download enthält das genaue Prüfprotokoll.

API-Referenzen: [WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit), [WaitForExitAsync](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexitasync) und [Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill).
