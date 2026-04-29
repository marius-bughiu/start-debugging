---
title: "So erkennen Sie, wann eine Datei in .NET fertig geschrieben ist"
description: "FileSystemWatcher feuert Changed, bevor der Schreiber fertig ist. Drei zuverlassige Muster fur .NET 11, um zu wissen, wann eine Datei vollstandig geschrieben ist: Offnen mit FileShare.None, Debounce per Grossenstabilisierung und der Rename-Trick auf der Producerseite, der das Problem komplett vermeidet."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "filesystem"
  - "io"
  - "csharp"
lang: "de"
translationOf: "2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet"
translatedBy: "claude"
translationDate: 2026-04-29
---

`FileSystemWatcher` sagt Ihnen nicht, wann eine Datei "fertig" ist. Er sagt Ihnen, dass das Betriebssystem eine Anderung beobachtet hat. Unter Windows feuert jeder `WriteFile`-Aufruf ein `Changed`-Ereignis, und `Created` feuert in dem Moment, in dem die Datei erscheint, oft bevor ein einziges Byte geschrieben wurde. Die zuverlassigen Muster sind: (1) versuchen, die Datei mit `FileShare.None` zu offnen und `IOException` 0x20 / 0x21 als "wird noch geschrieben" zu behandeln, mit Backoff erneut versuchen; (2) `FileInfo.Length` und `LastWriteTimeUtc` pollen, bis beide uber zwei aufeinanderfolgende Stichproben hinweg stabil sind; oder (3) mit dem Producer kooperieren, sodass er nach `name.tmp` schreibt und dann `File.Move` auf den endgultigen Namen ausfuhrt, was auf demselben Volume atomar ist. Muster 3 ist das einzige, das ohne Race Conditions korrekt ist. Muster 1 und 2 sind, wie Sie uberleben, wenn Sie den Producer nicht kontrollieren.

Dieser Beitrag zielt auf .NET 11 (Preview 4) und Windows / Linux / macOS. Die unten beschriebene `FileSystemWatcher`-Semantik hat sich seit .NET Core 3.1 auf keiner Plattform geandert, und der kooperative Rename-Trick ist auf POSIX und NTFS identisch.

## Warum der naheliegende Ansatz falsch ist

Der naive Code sieht so aus und lauft an viel zu vielen Stellen in Produktion:

```csharp
// .NET 11 -- BROKEN, do not ship
var watcher = new FileSystemWatcher(@"C:\inbox", "*.csv");
watcher.Created += (_, e) =>
{
    var rows = File.ReadAllLines(e.FullPath); // throws IOException
    Process(rows);
};
watcher.EnableRaisingEvents = true;
```

`Created` feuert, wenn das Betriebssystem meldet, dass der Verzeichniseintrag existiert. Der schreibende Prozess hat moglicherweise nicht einmal ein Byte geflusht. Unter Windows kann die Datei mit `FileShare.Read` offen sein (sodass Ihre Lesung eine Teildatei liefert) oder mit `FileShare.None` (sodass Ihre Lesung `IOException: The process cannot access the file because it is being used by another process` wirft, HRESULT `0x80070020`, win32 error 32). Unter Linux erhalten Sie fast immer eine Teillesung, da es standardmassig kein verbindliches Locking gibt; Sie verarbeiten still und leise eine halbe CSV.

`Changed` ist schlimmer. Je nachdem, wie der Producer schreibt, konnen Sie ein Ereignis pro `WriteFile`-Aufruf erhalten, was bedeutet, dass eine 1 MB grosse Datei, die in 4-KB-Blocken geschrieben wird, 256 Ereignisse feuert. Keines davon sagt Ihnen, dass der Schreiber fertig ist. Es gibt keine `WriteFileLastTimeIPromise`-Benachrichtigung, weil der Kernel die Absicht des Schreibers nicht kennt.

Ein drittes Problem: viele Kopier-Tools (Explorer, `robocopy`, rsync) schreiben zuerst in einen versteckten temporaren Namen und benennen dann um. Sie sehen `Created` fur die Tempdatei, dann `Renamed` fur die endgultige Datei. Das `Renamed`-Ereignis ist das, auf das Sie in diesen Fallen reagieren wollen, aber die Standardwerte von `FileSystemWatcher.NotifyFilter` schliessen `LastWrite` in .NET 11 aus und auf einigen Plattformen `FileName`, also mussen Sie das explizit aktivieren.

## Muster 1: Mit FileShare.None offnen und Backoff anwenden

Wenn Sie den Producer nicht kontrollieren, ist Ihr einziger Beobachtungskanal "kann ich die Datei exklusiv offnen". Der Producer halt einen offenen Handle, wahrend er schreibt; sobald er den Handle schliesst, ist ein exklusives Offnen erfolgreich. Das funktioniert unter Windows, Linux und macOS (Linux bietet beratende Locks via `flock`, aber die Open-ohne-Lock-Semantik fur einen regularen `FileStream` ist ausreichend, weil wir nur lesen, um zu bestatigen, dass der Schreiber weg ist).

```csharp
// .NET 11, C# 14
using System.IO;

static async Task<FileStream?> WaitForFileAsync(
    string path,
    TimeSpan timeout,
    CancellationToken ct)
{
    var deadline = DateTime.UtcNow + timeout;
    var delay = TimeSpan.FromMilliseconds(50);

    while (DateTime.UtcNow < deadline)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.None);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            await Task.Delay(delay, ct);
            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 1000));
        }
        catch (UnauthorizedAccessException)
        {
            // ACL problem, not a sharing problem -- do not retry
            throw;
        }
    }
    return null;
}

static bool IsSharingViolation(IOException ex)
{
    // ERROR_SHARING_VIOLATION = 0x20, ERROR_LOCK_VIOLATION = 0x21
    var hr = ex.HResult & 0xFFFF;
    return hr is 0x20 or 0x21;
}
```

Drei subtile Punkte:

- **Fangen Sie `IOException`, nicht `Exception`**. `UnauthorizedAccessException` (ACLs) und `FileNotFoundException` (der Producer hat abgebrochen und die Datei geloscht) sind andere Bugs und sollten nicht erneut versucht werden.
- **Inspizieren Sie `HResult`**. In .NET Core und neuer ist `IOException.HResult` der Standard-win32-Fehler, in `0x8007xxxx` unter Windows verpackt, und dieselben numerischen Codes werden auf POSIX-Systemen uber die Ubersetzungsschicht der Laufzeit bereitgestellt. Sharing-Verletzung ist `0x20`; Lock-Verletzung ist `0x21`. Matchen Sie nicht gegen den Nachrichtentext -- der ist lokalisiert.
- **Exponentielles Backoff mit Obergrenze**. Wenn der Producer hangt (Netzwerk-Upload, langsamer USB-Stick), verbraucht Polling alle 50ms CPU ohne Nutzen. Eine Begrenzung auf 1 Sekunde halt den Worker ruhig, ohne die Latenz fur schnelle Schreibvorgange zu beeintrachtigen.

Dieses Muster scheitert in einem speziellen Fall: ein Producer, der mit `FileShare.Read | FileShare.Write` offnet (manche fehlerhaften Uploader tun das). Ihr exklusives Offnen wird mitten im Schreiben Erfolg haben und Sie lesen Mull. Wenn Sie das vermuten, kombinieren Sie Muster 1 mit Muster 2.

## Muster 2: Debounce auf Grossenstabilisierung

Wenn Sie sich nicht auf Datei-Locks verlassen konnen (manche Linux-Producer, manche SMB-Shares, manche Kamera-Dumps), pollen Sie Grosse und `LastWriteTimeUtc`. Die Faustregel: wenn die Grosse uber zwei aufeinanderfolgende Polls in einem sinnvollen Intervall unverandert bleibt, ist der Schreiber wahrscheinlich fertig.

```csharp
// .NET 11, C# 14
static async Task<bool> WaitForStableSizeAsync(
    string path,
    TimeSpan pollInterval,
    int requiredStableSamples,
    CancellationToken ct)
{
    var fi = new FileInfo(path);
    long lastSize = -1;
    DateTime lastWrite = default;
    int stable = 0;

    while (stable < requiredStableSamples)
    {
        await Task.Delay(pollInterval, ct);
        fi.Refresh(); // FileInfo caches; Refresh forces a fresh stat call
        if (!fi.Exists) return false;

        if (fi.Length == lastSize && fi.LastWriteTimeUtc == lastWrite)
        {
            stable++;
        }
        else
        {
            stable = 0;
            lastSize = fi.Length;
            lastWrite = fi.LastWriteTimeUtc;
        }
    }
    return true;
}
```

Wahlen Sie `pollInterval` basierend darauf, was Sie uber den Schreiber wissen:

- Lokale schnelle Festplatte, kleine Datei: 100ms, 2 Stichproben.
- Netzwerk-Upload uber 100-Mb-Verbindung: 1s, 3 Stichproben.
- USB / SD-Karte / SMB: 2s, 3 Stichproben (Dateisystem-Caching kann momentane Fertigstellung verschleiern).

Die Falle ist `FileInfo.Refresh()`. Ohne den Aufruf gibt `FileInfo.Length` den Wert zuruck, der beim Konstruieren des `FileInfo` gecacht wurde, und Ihre Schleife dreht sich endlos. Es gibt keine Compiler-Warnung dafur; das ist ein haufiger stiller Bug.

Kombinieren Sie in Produktion mit Muster 1: pollen Sie auf stabile Grosse, dann versuchen Sie ein exklusives Offnen als finale Bestatigung. Die Kombination behandelt sowohl wohlerzogene als auch unartige Producer.

## Muster 3: Der Producer kooperiert -- schreiben, dann umbenennen

Wenn Sie den Schreiber kontrollieren, mussen Sie nichts erkennen. Schreiben Sie nach `final.csv.tmp`, fsync, schliessen und auf `final.csv` umbenennen. Der `FileSystemWatcher` des Konsumenten beobachtet `Renamed` (oder `Created` der finalen Erweiterung) und reagiert. Auf demselben NTFS- oder ext4-Volume ist `File.Move` atomar: entweder das Ziel existiert mit der vollstandigen Nutzlast, oder es existiert gar nicht.

```csharp
// .NET 11, C# 14 -- producer side
static async Task WriteAtomicallyAsync(
    string finalPath,
    Func<Stream, Task> writeBody,
    CancellationToken ct)
{
    var tmpPath = finalPath + ".tmp";

    await using (var fs = new FileStream(
        tmpPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.None,
        bufferSize: 81920,
        useAsync: true))
    {
        await writeBody(fs, ct);
        await fs.FlushAsync(ct);
        // FlushAsync flushes the .NET buffer; FlushToDisk forces fsync.
        // For most use cases FlushAsync + closing the handle is enough,
        // because Windows Cached Manager and the Linux page cache will
        // serialize the rename after the writes. If you must survive a
        // crash mid-write, also call:
        //   fs.Flush(flushToDisk: true);
    }

    // File.Move with overwrite=true uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
    // on Windows and rename(2) on POSIX. Both are atomic on the same volume.
    File.Move(tmpPath, finalPath, overwrite: true);
}
```

Zwei nicht offensichtliche Regeln:

- **Gleiches Volume**. Atomares Umbenennen funktioniert nur innerhalb eines Dateisystems. Den Tempfile nach `C:\temp\x.tmp` schreiben und nach `D:\inbox\x.csv` umbenennen ist hinter den Kulissen ein Copy-and-Delete, und der Konsument kann ihn definitiv mitten in der Kopie erwischen. Legen Sie die `.tmp`-Datei immer im Zielverzeichnis ab.
- **Gleiche Erweiterungsfamilie**. Wenn Ihr Watcher-Filter `*.csv` ist und der Producer `x.csv.tmp` erstellt, feuert der Watcher nicht fur die Tempdatei, was Sie wollen. Wenn der Watcher-Filter `*` ist, erhalten Sie ein `Created`-Ereignis fur die Tempdatei; ignorieren Sie alles, was in Ihrem Handler auf `.tmp` endet.

Das ist dasselbe Muster, das Git fur Ref-Updates verwendet, dasselbe, das SQLite fur sein Journal verwendet, und dasselbe, das atomare Konfigurations-Reloader (nginx, HAProxy) verwenden. Es gibt einen Grund. Wenn Sie den Producer andern konnen, tun Sie das und horen Sie auf zu lesen.

## Korrekte Anbindung an FileSystemWatcher

Der Handler sollte gunstig sein und in eine Queue ausgliedern. `FileSystemWatcher` erhebt Ereignisse auf einem Thread-Pool-Thread mit einem kleinen internen Buffer (Standard 8 KB unter Windows). Wenn Sie im Handler blockieren, lauft der Buffer uber und Sie erhalten `Error`-Ereignisse mit `InternalBufferOverflowException`, wobei Ereignisse stillschweigend verworfen werden.

```csharp
// .NET 11, C# 14
using System.IO;
using System.Threading.Channels;

var channel = Channel.CreateUnbounded<string>(
    new UnboundedChannelOptions { SingleReader = true });

var watcher = new FileSystemWatcher(@"C:\inbox")
{
    Filter = "*.csv",
    NotifyFilter = NotifyFilters.FileName
                 | NotifyFilters.LastWrite
                 | NotifyFilters.Size,
    InternalBufferSize = 64 * 1024, // 64 KB, max is 64 KB on most platforms
};

watcher.Created += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.Renamed += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.EnableRaisingEvents = true;

// Dedicated consumer
_ = Task.Run(async () =>
{
    await foreach (var path in channel.Reader.ReadAllAsync())
    {
        if (path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
        if (!await WaitForStableSizeAsync(path, TimeSpan.FromMilliseconds(250), 2, default))
            continue;
        await using var fs = await WaitForFileAsync(path, TimeSpan.FromSeconds(30), default);
        if (fs is null) continue;
        await ProcessAsync(fs);
    }
});
```

Drei Dinge in dem Code, die viele uberraschen:

- **`InternalBufferSize`**. Der Standard von 8 KB ist fur jede reale Last zu klein. Erhohen Sie ihn auf das Plattform-Maximum (64 KB unter Windows; das Linux-inotify-Backend zieht aus `/proc/sys/fs/inotify/max_queued_events`). Der Preis ist Prozessspeicher, den Sie nie bemerken werden.
- **`NotifyFilter`**. Der Standard in .NET 11 ist `LastWrite | FileName | DirectoryName`, aber unter macOS ignoriert das kqueue-Backend einige Flags; aktivieren Sie `Size` explizit, sodass reine Grossenanderungen (ein Schreiber, der `WriteFile` ohne Metadatenanderung verwendet) Ereignisse auslosen.
- **Ein `Channel<T>` entkoppelt den Watcher vom Konsumenten**. Wenn der Konsument 5 Sekunden braucht, um eine Datei zu verarbeiten, und in diesem Fenster 100 Ereignisse eintreffen, puffert der Channel sie, wahrend der Watcher sofort zuruckkehrt. Siehe [warum Channels fur diese Art von Producer-/Consumer-Trennung BlockingCollection schlagen](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Wenn die Datei auf einer Netzwerkfreigabe liegt

SMB und NFS bringen ihr eigenes Timing mit. `FileSystemWatcher` auf einem UNC-Pfad unter Windows verwendet `ReadDirectoryChangesW` gegen den Share, aber die Ereignisse werden vom SMB-Redirector zusammengefasst. Sie sehen moglicherweise nur ein `Changed`-Ereignis pro Minute, selbst fur eine kontinuierlich geschriebene 1-GB-Datei. Muster 1 und 2 funktionieren weiterhin, aber Sie sollten `pollInterval` in der Grossenordnung von 5-10 Sekunden setzen; das Pollen einer remote `FileInfo.Length` alle 100ms erzeugt einen Metadaten-Round-Trip pro Poll und sattigt die Verbindung.

NFS ist schlimmer: `inotify` feuert nicht fur Anderungen, die auf anderen Clients gemacht werden, nur fur Anderungen am lokalen Mount durch lokale Prozesse. Wenn Ihr Konsument auf Host A ist und der Producer auf Host B per NFS schreibt, sieht `FileSystemWatcher` nichts. Die Losung ist nur Polling -- `Directory.EnumerateFiles` auf einem Timer, mit Mustern 1 und 2 fur jeden neuen Eintrag. Es gibt keinen Kernel-Benachrichtigungspfad, der Sie hier rettet.

## Haufige Sonderfalle

- **Der Producer kurzt und uberschreibt am Ort**. `FileSystemWatcher` feuert ein einziges `Changed`-Ereignis, wenn der neue Inhalt landet. Die Stable-Size-Prufung von Muster 2 behandelt das korrekt, weil sich die Grosse erst nach Abschluss der Neuschreibung stabilisiert. Muster 1 kann wahrend des Truncate-Fensters kurz Erfolg haben, wenn die Datei leer ist; kombinieren Sie es mit einer Mindestgrossenprufung, wenn Ihre Domane eine hat.
- **Antivirus sperrt die Datei nach der Erstellung**. Defender (Windows) und die meisten Enterprise-AV-Produkte offnen die Datei zum Scannen, sobald sie erscheint, und halten `FileShare.Read` fur zehn bis hunderte Millisekunden. Die Retry-Schleife von Muster 1 absorbiert das transparent; setzen Sie das Timeout einfach nicht auf 100ms.
- **Die Datei wird von einem Prozess erstellt, der abstirzt**. Sie sehen `Created`, moglicherweise `Changed`, dann nichts mehr. Die Stable-Size-Prufung von Muster 2 liefert nach dem Polling-Fenster true zuruck, weil keine weiteren Schreibvorgange stattfinden. Sie verarbeiten dann eine unvollstandige Datei. Lassen Sie den Producer kooperieren (Muster 3) oder verwenden Sie eine Sentineldatei (`final.csv.done`), die der Producer am Ende beruhrt.
- **Mehrere Dateien werden im Gleichschritt geschrieben** (z.B. `data.csv` plus `data.idx`). Beobachten Sie das Erscheinen der sekundaren Datei, nicht der primaren. Der Producer ist verantwortlich, den Index nach den Daten zu schreiben, sodass das Erscheinen des Index impliziert, dass die Daten vollstandig sind.

## Verwandte Lekture

- [Streaming einer Datei aus ASP.NET Core ohne Buffering](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) deckt die Leseseite ab, sobald Sie bestatigt haben, dass die Datei vollstandig ist.
- [Grosse CSVs ohne OOM lesen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) ist die naturliche Folge, wenn Ihre Inbox-Dateien gross sind.
- [Lang laufende Tasks ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) gilt fur die obigen Warteschleifen, wenn Sie wollen, dass sie das Shutdown respektieren.
- [Channels statt BlockingCollection](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) ist der richtige Transport zwischen dem Watcher und dem Worker.

## Quellen

- [`FileSystemWatcher`-Referenz, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) -- der Plattformhinweise-Abschnitt ist am nutzlichsten.
- [`File.Move(string, string, bool)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.move) -- dokumentiert den atomaren Rename-Overload, der in .NET Core 3.0 hinzugefugt wurde.
- [Win32 `MoveFileEx` Dokumentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa) -- die zugrunde liegende Primitive, die `File.Move(overwrite: true)` verwendet.
- [`ReadDirectoryChangesW`-API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) -- erklart die Buffer-Overflow-Bedingungen, die zu `InternalBufferOverflowException` fuhren.
