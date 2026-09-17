---
title: "Process.Run vs Process.Start in .NET 11: was sollten Sie verwenden?"
description: "Verwenden Sie Process.Run, wenn Sie ein Tool starten und nur wissen wollen, wie es beendet wurde: ein Aufruf, ein Timeout, der den Kindprozess beendet, und ein ProcessExitStatus mit dem Signal. Bleiben Sie bei Process.Start, wenn Sie das Process-Objekt brauchen: Schreiben nach stdin, Lesen der Ausgabe während sie eintrifft, UseShellExecute oder das Beenden eines ganzen Prozessbaums."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "de"
translationOf: "2026/09/process-run-vs-process-start-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

**Verwenden Sie `Process.Run` (oder `Process.RunAsync`), wann immer Sie einen Prozess starten, ihn zu Ende laufen lassen und nur wissen müssen, wie er beendet wurde.** Es ist ein einziger Aufruf, er kann kein `Process`-Handle verlieren, sein Timeout oder `CancellationToken` beendet den Kindprozess tatsächlich, und er gibt einen `ProcessExitStatus` zurück, der Ihnen sagt, ob der Kindprozess normal endete, durch ein Signal beendet wurde oder von Ihnen beendet wurde. **Bleiben Sie bei `Process.Start`, wenn Sie das laufende `Process`-Objekt brauchen**: Schreiben nach stdin, zeilenweises Lesen der Ausgabe während der Prozess läuft, `UseShellExecute` zum Öffnen einer URL oder eines Dokuments, das `Exited`-Ereignis oder `Kill(entireProcessTree: true)` für Tools, die eigene Worker starten. Die Performance entscheidet es nicht: Beide lagen auf .NET 11 RC 1 bei etwa 740 Mikrosekunden pro Prozessstart. Alles Folgende wurde gegen .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, Laufzeit `11.0.0-rc.1.26425.128`, C# 15) auf macOS 26.6 mit einem Apple M4 geprüft.

## Die beiden APIs im Vergleich

| Verhalten (.NET 11 RC 1)                  | `Process.Run` / `RunAsync`                          | `Process.Start` + `WaitForExit`                  |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Verfügbar ab                              | .NET 11+                                            | jede .NET-Version                                |
| Rückgabe                                  | `ProcessExitStatus`                                 | `Process` (muss disposed werden)                 |
| Standard für stdin/stdout/stderr          | vom Elternprozess geerbt (oder null mit `silent: true`) | vom Elternprozess geerbt                     |
| `RedirectStandardOutput = true`           | `InvalidOperationException`                         | ja                                               |
| Nach stdin schreiben während der Laufzeit | nein                                                | ja                                               |
| `UseShellExecute = true`                  | `InvalidOperationException`                         | ja                                               |
| Timeout                                   | beendet den Kindprozess, `Canceled = true`          | `WaitForExit(TimeSpan)` gibt `false` zurück, Kindprozess läuft weiter |
| Abbruch (async)                           | beendet den Kindprozess, keine Exception            | `WaitForExitAsync(ct)` wirft, Kindprozess läuft weiter |
| Beendendes Signal                         | `ProcessExitStatus.Signal`                          | aus `ExitCode` raten (137, 143)                  |
| Enkelprozesse bei Timeout beenden         | nein, nur der direkte Kindprozess                   | `Kill(entireProcessTree: true)`                  |
| Prozess-ID                                | wird nicht zurückgegeben                            | `Process.Id`                                     |
| `/usr/bin/true` starten, synchron         | 737.0 us, 16.56 KB                                  | 739.4 us, 16.84 KB                               |

Die ersten fünf Zeilen entscheiden die meisten Fälle. Wenn Ihr Aufrufer `StandardInput`, `BeginOutputReadLine` oder `UseShellExecute` anfasst, kommt `Process.Run` überhaupt nicht in Frage. Wenn er nichts davon tut, ist `Process.Run` kürzer und hat sicherere Standardwerte.

## Was Process.Run tatsächlich tut

`Process.Run` kam in .NET 11 Preview 4 zusammen mit `RunAndCaptureText` und `StartAndForget` als Teil der [Überarbeitung der Process API](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), über die ich geschrieben habe, als [die Deadlock-freie Ausgabeerfassung erschien](/de/2026/05/dotnet-11-process-api-deadlock-free-capture/). Die Oberfläche in RC 1 sieht so aus:

```csharp
// .NET 11 RC 1, System.Diagnostics.Process
public static ProcessExitStatus Run(ProcessStartInfo startInfo, TimeSpan? timeout = default);
public static ProcessExitStatus Run(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, TimeSpan? timeout = default);

public static Task<ProcessExitStatus> RunAsync(ProcessStartInfo startInfo,
    CancellationToken cancellationToken = default);
public static Task<ProcessExitStatus> RunAsync(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, CancellationToken cancellationToken = default);
```

Zwei Details weichen vom Blogbeitrag zu Preview 4 ab. Preview 7 änderte `arguments` von `IList<string>?` zu `IEnumerable<string>?` ([dotnet/runtime#130630](https://github.com/dotnet/runtime/pull/130630)), und die `fileName`-Überladungen erhielten ein `silent`-Flag, das stdin, stdout und stderr auf das Null-Gerät umleitet.

Die Implementierung in [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) ist kurz genug, um sie genau zusammenzufassen. Sie erzeugt nie ein `Process`-Objekt. Sie ruft `SafeProcessHandle.Start(startInfo)` auf, dann entweder `WaitForExit()` oder `WaitForExitOrKillOnTimeout(timeout)`, und gibt das Handle vor der Rückkehr frei. `RunAsync` macht dasselbe mit `WaitForExitOrKillOnCancellationAsync`. Deshalb kann es kein Handle verlieren, und deshalb lehnt es auch alles ab, was ein `Process` zur Steuerung braucht: Die `RedirectStandard*`-Flags ergeben nur Sinn, wenn jemand `Process.StandardOutput` hält und leert.

`ProcessExitStatus` hat drei Eigenschaften: `ExitCode`, `Canceled` und ein nullbares `PosixSignal? Signal`. Derselbe Typ kommt auch von den [neuen `Process.WaitForExitStatus`-Methoden in RC 1](/de/2026/09/dotnet-11-rc-1-process-signal-exit-status/) zurück.

## Dieselbe Aufgabe auf beide Arten

Hier der Alltagsfall: `dotnet build` ausführen, die Ausgabe zur Konsole durchlassen, bei einem Fehler fehlschlagen und nach fünf Minuten aufgeben.

```csharp
// .NET 11 RC 1, C# 15 -- before: Process.Start
using System.Diagnostics;

using Process build = Process.Start("dotnet", ["build", "-c", "Release"]);

if (!build.WaitForExit(TimeSpan.FromMinutes(5)))
{
    build.Kill(entireProcessTree: true);
    build.WaitForExit();
    throw new TimeoutException("dotnet build took longer than 5 minutes");
}

if (build.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {build.ExitCode}");
```

```csharp
// .NET 11 RC 1, C# 15 -- after: Process.Run
using System.Diagnostics;

ProcessExitStatus status = Process.Run(
    "dotnet", ["build", "-c", "Release"],
    timeout: TimeSpan.FromMinutes(5));

if (status.Canceled)
    throw new TimeoutException("dotnet build took longer than 5 minutes");

if (status.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {status.ExitCode}");
```

Die `Process.Start`-Version ist korrekt, aber nur, weil sie zwei Dinge berücksichtigt, die regelmäßig vergessen werden: `WaitForExit(TimeSpan)` beendet bei einem Timeout nichts, und der `Process` muss disposed werden. Bei der `Process.Run`-Version lässt sich beides nicht falsch machen. Beachten Sie aber, dass ich `entireProcessTree: true` in der ersten Version absichtlich behalten habe. Mehr dazu bei den Fallstricken.

## Timeouts und Abbruch verhalten sich unterschiedlich

Das ist der Unterschied, der alle trifft, die per Suchen und Ersetzen migrieren. Ich habe beide gegen `sleep 10` mit einem Budget von 500 ms auf .NET 11 RC 1 laufen lassen:

```csharp
// .NET 11 RC 1, C# 15, macOS 26.6
using System.Diagnostics;

using var cts = new CancellationTokenSource(500);
ProcessExitStatus s = await Process.RunAsync("sleep", ["10"], cancellationToken: cts.Token);
Console.WriteLine($"ExitCode={s.ExitCode} Canceled={s.Canceled} Signal={s.Signal}");
// ExitCode=137 Canceled=True Signal=SIGKILL   (returned after 505 ms, no exception)

using var cts2 = new CancellationTokenSource(500);
using Process p = Process.Start("sleep", ["10"]);
try { await p.WaitForExitAsync(cts2.Token); }
catch (TaskCanceledException) { Console.WriteLine($"HasExited={p.HasExited}"); }
// HasExited=False   (the child is still running)
```

Drei Erkenntnisse aus dieser Ausgabe:

1. **`RunAsync` wirft beim Abbruch nicht.** Es beendet den Kindprozess mit `SIGKILL` (oder `TerminateProcess` unter Windows), wartet auf dessen Ende und gibt einen Status mit `Canceled = true` zurück. Code, der es in `catch (OperationCanceledException)` einschließt, betritt den catch-Block nie. Prüfen Sie stattdessen `status.Canceled`.
2. **`Process.WaitForExitAsync(ct)` bricht nur das Warten ab.** Es wirft `TaskCanceledException` und lässt den Prozess am Leben. Wenn Sie ihn beenden wollten, rufen Sie `Kill()` selbst auf.
3. **`Signal` beendet das Raten anhand des Exit-Codes.** Unter Unix meldet ein durch `SIGKILL` beendeter Prozess den Exit-Code 137 und ein durch `SIGTERM` beendeter 143, und ein Prozess kann auch einfach `exit 137` ausführen. `ProcessExitStatus.Signal` sagt Ihnen, was davon passiert ist. Innerhalb eines `Process.Run`-Aufrufs sagt `Canceled` Ihnen, ob das Beenden von Ihnen kam.

Das synchrone `Run` nimmt ein `TimeSpan? timeout` und kein Token; `RunAsync` nimmt ein Token und kein Timeout. Für ein asynchrones Timeout verwenden Sie `new CancellationTokenSource(TimeSpan)` wie oben. Wenn der Abbruch aus einer ASP.NET Core-Anfrage oder einem Hosted Service kommt, gelten die Muster aus [wie Sie einen lang laufenden Task ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) unverändert.

## Wann Process.Run die richtige Wahl ist

- **Build-Skripte und CLI-Wrapper**, die `git`, `dotnet`, `npm` oder `docker` ausführen und die Ausgabe direkt zur Konsole durchlassen. Mit dem Standard `silent: false` erbt der Kindprozess die Handles des Elternprozesses, sodass Farben und Fortschrittsbalken weiter funktionieren.
- **Health Checks und Probes**, bei denen nur der Exit-Code zählt. `Process.Run("pg_isready", ["-h", host], silent: true, timeout: TimeSpan.FromSeconds(3))` ist die gesamte Implementierung.
- **Tools, die Ihren Dienst nie blockieren dürfen.** Die Pfade für Timeout und Abbruch beenden den Kindprozess für Sie, sodass sich ein hängendes `ffprobe` nicht hinter einer Anfrage aufstauen kann.
- **Ausgabe in eine Datei statt zur Konsole schreiben.** `ProcessStartInfo.StandardOutputHandle` akzeptiert jedes `SafeFileHandle`, und `Run(ProcessStartInfo)` unterstützt es:

```csharp
// .NET 11 RC 1, C# 15
using System.Diagnostics;
using Microsoft.Win32.SafeHandles;

using SafeFileHandle log = File.OpenHandle("build.log", FileMode.Create, FileAccess.Write);

ProcessExitStatus status = Process.Run(new ProcessStartInfo("dotnet", ["build"])
{
    StandardOutputHandle = log,
    StandardErrorHandle = log,
    WorkingDirectory = "/src/app",
});
```

Wenn Sie die Ausgabe im Speicher statt in einer Datei brauchen, lassen Sie beide APIs weg und rufen Sie `Process.RunAndCaptureText` auf, das stdout und stderr parallel leert, sodass der klassische Redirect-Deadlock nicht auftreten kann.

## Wann Sie bei Process.Start bleiben sollten

- **Interaktives stdin.** Ein Passwort an `ssh-keygen` übergeben, SQL in `psql` pipen oder mit einer REPL kommunizieren erfordert `RedirectStandardInput` und `Process.StandardInput`. `Run` wirft bei jedem `RedirectStandard*`-Flag.
- **Ausgabe streamen, während der Prozess läuft.** Eine Fortschrittsanzeige, die `ffmpeg`-Zeilen beim Erscheinen darstellt, braucht den `Process`. In .NET 11 können Sie zumindest auf die Event-Handler verzichten und `process.ReadAllLinesAsync(ct)` verwenden, das `ProcessOutputLine`-Werte aus beiden Streams ohne Deadlock liefert.
- **Shell-Ausführung.** `Process.Start(new ProcessStartInfo("https://startdebugging.net") { UseShellExecute = true })` ist weiterhin der Weg, eine URL oder ein Dokument mit der Standard-App zu öffnen. `Run`, `RunAsync` und `StartAndForget` werfen alle, weil die Shell-Ausführung unter Windows möglicherweise gar keinen neuen Prozess erzeugt.
- **Prozessbäume.** Wenn der Kindprozess Worker startet (MSBuild-Knoten, `npm`, das `node` ausführt, ein Shell-Skript), räumt nur `Process.Kill(entireProcessTree: true)` sie auf. Siehe den nächsten Abschnitt.
- **Sie brauchen den `Process` selbst**: `Id` für die Protokollierung, das `Exited`-Ereignis, `PriorityClass` oder die nur unter Windows verfügbaren `userName`/`password`-Überladungen.
- **Sie zielen auf etwas vor .NET 11.** `Process.Run` existiert in .NET 10 nicht. Eine Bibliothek mit mehreren Zielframeworks braucht `#if NET11_0_OR_GREATER`.

## Der Benchmark

Die Performance ist kein Grund, sich für eines der beiden zu entscheiden, und ich habe sie gemessen, damit Sie nicht rätseln müssen. Umgebung: .NET 11 RC 1 (`11.0.0-rc.1.26425.128`), BenchmarkDotNet 0.15.8 mit der In-Process-Emit-Toolchain (0.15.8 erkennt `net11.0` für Out-of-Process-Läufe noch nicht), 3 Warmup- und 15 Messiterationen, macOS 26.6.2, Apple M4 mit 10 Kernen. Jeder Benchmark startet `/usr/bin/true` und wartet darauf.

```csharp
// .NET 11 RC 1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
[InProcess, WarmupCount(3), IterationCount(15)]
public class SpawnBenchmarks
{
    private const string Exe = "/usr/bin/true";

    [Benchmark(Baseline = true)]
    public int Start_WaitForExit()
    {
        using Process p = Process.Start(Exe);
        p.WaitForExit();
        return p.ExitCode;
    }

    [Benchmark]
    public int Run() => Process.Run(Exe).ExitCode;

    [Benchmark]
    public async Task<int> Start_WaitForExitAsync()
    {
        using Process p = Process.Start(Exe);
        await p.WaitForExitAsync();
        return p.ExitCode;
    }

    [Benchmark]
    public async Task<int> RunAsync() => (await Process.RunAsync(Exe)).ExitCode;
}
```

| Method                   | Mean     | StdDev   | Allocated |
| ------------------------ | -------: | -------: | --------: |
| `Start_WaitForExit`      | 739.4 us | 6.26 us  | 16.84 KB  |
| `Run`                    | 737.0 us | 2.76 us  | 16.56 KB  |
| `Start_WaitForExitAsync` | 768.5 us | 13.89 us | 17.89 KB  |
| `RunAsync`               | 762.6 us | 2.56 us  | 17.47 KB  |

Der Unterschied liegt im Rauschen. Fast die gesamten Kosten entstehen dadurch, dass das Betriebssystem den Prozess erzeugt, und beide APIs teilen denselben `SafeProcessHandle`-Startpfad. Der Verzicht auf das `Process`-Objekt spart etwa 300 Bytes. Die großen Verbesserungen in .NET 11 (laut den Messungen des .NET-Teams 98-mal schnellerer Prozessstart auf Apple Silicon) gelten für beide APIs gleichermaßen, weil sie unterhalb dieser Schicht liegen.

## Fallstricke, die die Entscheidung für Sie treffen

**Ein Timeout beendet nur den direkten Kindprozess.** Ich habe `Process.Run("sh", ["-c", "sleep 31; true"], timeout: TimeSpan.FromMilliseconds(500))` ausgeführt. `Run` gab `Canceled=True Signal=SIGKILL` zurück, und `pgrep -f "sleep 31"` fand den `sleep`-Prozess danach immer noch, neu zugeordnet und laufend. Derselbe Test mit `Process.Start` und `Kill(entireProcessTree: true)` hinterließ nichts. `dotnet build`, `npm run`, `docker compose` und die meisten Shell-Skripte starten Kindprozesse. Wenn ein Timeout die Maschine also sauber hinterlassen muss, ist `Process.Start` mit dem Beenden des ganzen Baums weiterhin das richtige Werkzeug. `ProcessStartInfo.KillOnParentExit` (nur Windows, Linux und Android) ist kein Ersatz: Es greift, wenn Ihr Prozess endet, nicht wenn ein Timeout abläuft.

**Es gibt keine Überladung mit String-Argumenten.** `Process.Run("git", "status")` kompiliert nicht, weil `string` kein `IEnumerable<string>` ist. Übergeben Sie `["status"]` oder erstellen Sie ein `ProcessStartInfo("git", "status")` und verwenden Sie die Überladung `Run(ProcessStartInfo)`.

**`silent: true` setzt auch stdin auf null.** Ein Kindprozess, der eine Eingabe anfordert, etwa `git` beim Abfragen von Anmeldedaten, liest sofort Dateiende, statt zu hängen. In einem Dienst ist das meist gewünscht, in einem Entwicklerskript überraschend.

**`Run(ProcessStartInfo)` lehnt Ihre bestehende Start-Info ab.** Wenn Sie eine `ProcessStartInfo` migrieren, die noch `RedirectStandardOutput = true` hat, erhalten Sie `InvalidOperationException: The RedirectStandardInput, RedirectStandardOutput, and RedirectStandardError properties cannot be used by SafeProcessHandle.Start or Process.StartAndForget`. Die Meldung erwähnt weder `Run` noch `RunAsync`, aber es ist dieselbe Prüfung. Ersetzen Sie das Flag durch `StandardOutputHandle` oder wechseln Sie zu `RunAndCaptureText`.

**Fehler beim Starten sind identisch.** Eine fehlende ausführbare Datei wirft bei beiden APIs dieselbe `Win32Exception` ("No such file or directory"), sodass bestehende Fehlerbehandlung weiter funktioniert.

**Keines von beiden wird auf iOS oder tvOS unterstützt.** Beide tragen `[UnsupportedOSPlatform("ios")]` und `[UnsupportedOSPlatform("tvos")]`, Mac Catalyst wird unterstützt. Der Plattform-Analyzer markiert Aufrufe in einem MAUI-Projekt in beiden Fällen.

## Die Entscheidung

Für neuen .NET 11-Code, der einen Prozess bis zum Ende ausführt, sollten Sie standardmäßig `Process.Run` oder `Process.RunAsync` verwenden. Sie beseitigen die drei häufigsten Fehler in Prozesscode (der nicht disposte `Process`, das Timeout, das nichts beendet, der Exit-Code, der ein Signal verbirgt) ohne messbare Kosten. Wechseln Sie zu `Process.RunAndCaptureText`, sobald Sie die Ausgabe als String brauchen. Greifen Sie nur dann zu `Process.Start`, wenn der Prozess während der Laufzeit gesteuert, über die Shell geöffnet oder als ganzer Baum abgebaut werden muss. Der letzte Fall ist wichtiger, als er aussieht, denn viele Tools, die Sie in `Process.Run` verpacken würden, starten stillschweigend Kindprozesse, die dessen Timeout nicht erreicht. Wenn Sie noch älteren Code pflegen, der auf `WaitForExit` blockiert, sind die [grundlegenden Muster zum Warten auf das Prozessende](/de/2023/08/c-how-to-wait-for-a-process-to-end/) der übliche Ausgangspunkt für `Process.Start`-Code, und es lohnt sich, sie mit diesen Standardwerten im Hinterkopf neu zu betrachten.

### Verwandte Artikel

- [.NET 11 bringt Deadlock-freie Erfassung der Prozessausgabe](/de/2026/05/dotnet-11-process-api-deadlock-free-capture/)
- [Mit .NET 11 RC 1 senden Sie SIGTERM an einen Kindprozess ohne P/Invoke](/de/2026/09/dotnet-11-rc-1-process-signal-exit-status/)
- [C#: wie Sie auf das Ende eines Prozesses warten](/de/2023/08/c-how-to-wait-for-a-process-to-end/)
- [Wie Sie einen lang laufenden Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [.Result und .Wait() vs GetAwaiter().GetResult() vs await in C#](/de/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

### Quellen

- [Process API improvements in .NET 11](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), .NET Blog
- [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) und [`SafeProcessHandle.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/Microsoft/Win32/SafeHandles/SafeProcessHandle.cs) am Tag `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [Implement Process.Run, RunAsync, RunAndCaptureText, RunAndCaptureTextAsync](https://github.com/dotnet/runtime/pull/127210), dotnet/runtime PR
- [.NET 11 Preview 7 libraries release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/libraries.md) (die Änderung der Argumente zu `IEnumerable<string>`), dotnet/core
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), MS Learn
- [`Process.Start`-Methode](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.start), MS Learn
