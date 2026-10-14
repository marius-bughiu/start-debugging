---
title: "FileSystemWatcher vs. Polling zur Erkennung von Dateiänderungen auf einer Netzwerkfreigabe in .NET"
description: "Auf einer SMB- oder NFS-Freigabe ist Polling die maßgebliche Quelle und FileSystemWatcher bestenfalls ein Hinweis. FileSystemWatcher verpasst Remote-Änderungen unter Linux und macOS, läuft über seinen 64-KB-Netzwerkpuffer über und stoppt endgültig, wenn die Verbindung abbricht. Verwenden Sie einen periodischen Snapshot-Vergleich und lassen Sie den Watcher nur einen früheren Scan auslösen. Geprüft mit .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "csharp"
  - "filesystem"
  - "io"
lang: "de"
translationOf: "2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-14
---

Wenn der überwachte Ordner auf einer Netzwerkfreigabe liegt, gewinnt Polling. Erstellen Sie periodisch einen Snapshot des Verzeichnisses und vergleichen Sie ihn mit dem vorherigen: Das ist der einzige Mechanismus, der jede Änderung auf jedem Betriebssystem sieht, Verbindungsabbrüche übersteht und sich nachvollziehbar begründen lässt. `FileSystemWatcher` ist auf Windows-Clients, die mit SMB sprechen, weiterhin nützlich, aber nur als Hinweis, der den nächsten Scan früher auslöst. Lassen Sie ihn nie den einzigen Weg sein, auf dem Sie erfahren, dass eine Datei angekommen ist.

Alles Folgende gilt für `System.IO.FileSystemWatcher` und `Microsoft.Extensions.FileProviders.Physical`, wie sie mit .NET 10 ausgeliefert werden (ich habe den Code mit .NET 10.0.10, SDK 10.0.302, C# 14 ausgeführt) und in den .NET-11-Release-Candidates. Der relevante Quellcode hat sich seit .NET Core 3.1 nicht nennenswert geändert, daher gilt der Rat auch für .NET 8 und 9.

## Der Vergleich im Überblick

| | `FileSystemWatcher` auf einer Freigabe | Polling eines Snapshots |
| --- | --- | --- |
| Windows-Client, SMB-2/3-Freigabe | Funktioniert, über `ReadDirectoryChangesW`, das an den Server weitergeleitet wird | Funktioniert |
| Linux-Client, CIFS- oder NFS-Mount | Sieht nur Änderungen der lokalen Maschine | Funktioniert |
| macOS-Client, SMB- oder NFS-Mount | Sieht in der Praxis nur lokale Änderungen | Funktioniert |
| Latenz | Unter einer Sekunde, wenn es funktioniert | Ihr Poll-Intervall plus Metadaten-Caching des Clients (bis zu 10 s bei Windows-SMB, bis zu 60 s bei NFS) |
| Änderungsschub | Puffer auf Netzwerkpfaden auf 64 KB begrenzt, ein Überlauf verwirft alle Details | Unbeeinflusst, der nächste Vergleich sieht den Endzustand |
| Verbindungsabbruch | `Error`-Ereignis, dann springt `EnableRaisingEvents` auf `false` und bleibt aus | Der Scan schlägt fehl, Sie wiederholen ihn im nächsten Takt |
| Änderungen, während Sie offline waren | Verloren | Beim ersten erfolgreichen Scan sichtbar |
| Kosten, wenn sich nichts ändert | Nahezu null | Eine Verzeichnisauflistung pro Intervall |
| Kann sagen, *was* sich geändert hat | Ja, pro Ereignis | Ja, durch Vergleich der Snapshots |

Jede Zeile in der Spalte "Watcher" hat ein Sternchen, keine Zeile in der Spalte "Polling". Diese Asymmetrie ist das ganze Argument.

## Warum FileSystemWatcher auf einer Netzwerkfreigabe fragil ist

`FileSystemWatcher` ist ein dünner Wrapper um das, was das Betriebssystem bereitstellt: `ReadDirectoryChangesW` unter Windows, `inotify` unter Linux, FSEvents unter macOS. Jeder dieser Mechanismen wurde für ein lokales Dateisystem entworfen, in dem der Kernel jeden Schreibvorgang sieht, weil jeder Schreibvorgang durch ihn läuft. Eine Netzwerkfreigabe bricht diese Annahme.

**Unter Linux und macOS sind Remote-Schreibvorgänge unsichtbar.** `inotify` feuert, wenn der lokale Kernel eine Operation auf der Datei ausführt. Wenn eine andere Maschine auf denselben NFS-Export oder dieselbe SMB-Freigabe schreibt, verarbeitet Ihr Kernel diesen Schreibvorgang nie, also wird kein Ereignis erzeugt. Sie erhalten Ereignisse für die Schreibvorgänge Ihres eigenen Prozesses und nichts für die anderer. Der Linux-Kernel-Entwickler J. Bruce Fields hat es in [einer LWN-Diskussion](https://lwn.net/Articles/757833/) klar formuliert: Clientseitige Benachrichtigungen bräuchten ein "very chatty" Protokoll, um Änderungen anderer Clients zu erfahren, und NFS hat keines. Dasselbe gilt für CIFS-Mounts. Läuft Ihr Consumer in einem Linux-Container und der Producer ist eine Windows-Maschine, die Dateien auf einer Freigabe ablegt, wird ein `FileSystemWatcher` für immer stumm dasitzen.

**Unter Windows schlägt die 64-KB-Grenze zu.** Ein Windows-Client gegen einen SMB-2- oder SMB-3-Server erhält tatsächlich echte Remote-Benachrichtigungen: Der Redirector sendet eine `CHANGE_NOTIFY`-Anfrage an den Server, und der Server antwortet, wenn sich etwas ändert. Aber die [Dokumentation von `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) besagt, dass der Aufruf "fails with ERROR_INVALID_PARAMETER when the buffer length is greater than 64 KB and the application is monitoring a directory over the network". Die [Dokumentation zu `FileSystemWatcher`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) wiederholt die Grenze. Der Standardwert von `InternalBufferSize` beträgt 8 KB, jeder `FILE_NOTIFY_INFORMATION`-Eintrag besteht aus 12 Bytes plus dem UTF-16-Dateinamen, sodass bei Namen mit 40 Zeichen etwa 90 Ereignisse in 8 KB und etwa 700 in 64 KB passen. Ein Batch-Job, der in einer Sekunde 2.000 Dateien ablegt, lässt beide überlaufen.

Läuft der Puffer über, verwirft das Betriebssystem den gesamten Stapel. `ReadDirectoryChangesW` liefert Erfolg mit null Bytes zurück, und die Laufzeit macht daraus ein `Error`-Ereignis mit einer `InternalBufferOverflowException` ("Too many changes at once in directory"). Sie wissen, dass Sie etwas verpasst haben, aber nicht was.

**Unter Windows deaktiviert ein Verbindungsabbruch den Watcher.** Das ist der Fall, der den Vorfall um 3 Uhr nachts verursacht. Hier der relevante Teil von `ReadDirectoryChangesCallback` in [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs):

```csharp
// dotnet/runtime main, System.IO.FileSystem.Watcher (unchanged since .NET Core 3.x)
if (errorCode != 0)
{
    const int ERROR_OPERATION_ABORTED = 995;
    if (errorCode != ERROR_OPERATION_ABORTED)
    {
        EnableRaisingEvents = false;
        OnError(new ErrorEventArgs(new Win32Exception((int)errorCode)));
    }
    return;
}
```

Wenn der Dateiserver neu startet, das VPN kurz aussetzt oder die SMB-Sitzung abläuft, endet das ausstehende Lesen mit einem Fehler wie `ERROR_NETNAME_DELETED` (64, "The specified network name is no longer available"). Der Watcher löst einmal `Error` aus, setzt `EnableRaisingEvents = false` und kommt von selbst nie zurück. Hat niemand `Error` abonniert, läuft der Prozess weiter, sieht gesund aus und verarbeitet nichts. Beachten Sie auch, dass ein anfänglicher Fehler, etwa ein Puffer über 64 KB auf einem UNC-Pfad, sich genauso zeigt: als `Error`-Ereignis, nicht als Ausnahme aus dem Setter von `EnableRaisingEvents = true`.

## Das minimale Beispiel für den stillen Ausfall

Dies ist der Code, der in den meisten Fragen vom Typ "mein Watcher funktioniert nicht mehr" auftaucht:

```csharp
// .NET 10, C# 14 -- the naive version. Do not ship this against a share.
using var watcher = new FileSystemWatcher(@"\\fileserver\drop", "*.csv");
watcher.Created += (_, e) => Process(e.FullPath);
watcher.EnableRaisingEvents = true;

Console.ReadLine();

static void Process(string path) => Console.WriteLine($"Got {path}");
```

Führen Sie ihn unter Windows aus, legen Sie eine Datei auf der Freigabe ab, und es funktioniert. Starten Sie den Dateiserver neu oder ziehen Sie eine Minute lang das Netzwerkkabel, und er hört für immer auf zu drucken, ohne Ausnahme und ohne Logzeile. Führen Sie denselben Code in einem Linux-Container aus, in dem `/mnt/drop` per CIFS eingehängt ist, und er druckt nie etwas, es sei denn, die Datei wird innerhalb desselben Containers erstellt.

## Polling richtig umgesetzt

Polling hat einen schlechten Ruf, weil es oft schlecht implementiert wird: Man listet das Verzeichnis auf, öffnet jede Datei und vergleicht die Inhalte. Ein gutes Polling ist eine einzige Verzeichnisauflistung, die Name, Größe und Zeitpunkt der letzten Änderung für jeden Eintrag erfasst und mit der vorherigen Auflistung vergleicht.

Der günstigste Weg dafür in .NET ist `FileSystemEnumerable<T>` aus `System.IO.Enumeration`. Damit projizieren Sie jeden `FileSystemEntry` direkt in das benötigte Tupel, ohne pro Datei ein `FileInfo` zu allozieren. Unter Windows stammen `Length` und `LastWriteTimeUtc` aus den Daten der Verzeichnisenumeration selbst (`FindFirstFileEx` und Verwandte), sodass die gesamte Auflistung über SMB aus einer Handvoll `QUERY_DIRECTORY`-Austausche besteht statt aus einem Roundtrip pro Datei. Unter Linux und macOS liefert `readdir` nur Namen, also kostet jeder Eintrag ein zusätzliches `stat`, das ein CIFS- oder NFS-Client meist aus seinem Attribut-Cache bedient.

Um ein Gefühl für die CPU-Untergrenze eines Scans zu bekommen, habe ich die Methode `TakeSnapshot` aus der vollständigen Implementierung unten gegen lokale APFS-Verzeichnisse auf einem Apple M4 gemessen (macOS 26.6, .NET 10.0.10, Release-Build, Mittelwert aus 20 Läufen nach 3 Aufwärmläufen):

| Dateien im Verzeichnis | Zeit pro Scan | Allokiert pro Scan |
| --- | --- | --- |
| 1.000 | 1,8 ms | 0,29 MB |
| 10.000 | 20,5 ms | 2,83 MB |
| 50.000 | 93,1 ms | 13,39 MB |

Über ein Netzwerk wachsen diese Zahlen mit Latenz und Größe der Auflistung, aber die Form bleibt gleich: eine Auflistung pro Intervall. Einen Ablageordner mit einigen tausend Dateien alle 5 bis 30 Sekunden zu pollen, ist eine Last, die niemand bemerkt. 500.000 Dateien jede Sekunde zu pollen, schon, und die Antwort darauf ist, den Ordner zu partitionieren (ein Unterordner pro Tag oder pro Producer), nicht auf einen Watcher umzusteigen.

## Der Hybrid: Polling als Wahrheit, Watcher als Hinweis

Das Design, das in der Produktion standhält, kombiniert beides:

1. Halten Sie einen Snapshot (`path -> (length, lastWriteUtc)`) im Speicher.
2. Scannen Sie in festem Intervall neu und vergleichen Sie mit dem Snapshot. Dies ist der einzige Codepfad, der `Created`, `Changed` und `Deleted` ausgibt.
3. Wenn ein `FileSystemWatcher` gestartet werden kann, lassen Sie jedes seiner Ereignisse die Scan-Schleife früher aufwecken. Auf einem Windows-Client, der mit SMB spricht, erhalten Sie so im Normalfall eine Latenz unter einer Sekunde.
4. Bei jedem `Error` des Watchers (Überlauf oder Verbindungsabbruch) verwerfen Sie den Watcher, erzwingen einen neuen Scan und versuchen, ihn im nächsten Durchlauf neu zu erstellen.
5. Schlägt der Scan selbst fehl, weil die Freigabe nicht erreichbar ist, behalten Sie den alten Snapshot und versuchen es im nächsten Takt erneut. Ein Ausfall ist nicht dasselbe wie "alle Dateien wurden gelöscht".

Hier die vollständige Implementierung. Sie läuft unverändert unter .NET 10 und .NET 11:

```csharp
// .NET 10 / .NET 11, C# 14
using System.IO.Enumeration;

public enum ShareChangeKind { Created, Changed, Deleted }

public readonly record struct ShareChange(ShareChangeKind Kind, string Path);

public readonly record struct FileStamp(long Length, DateTime LastWriteUtc);

public sealed class ShareWatcher : IAsyncDisposable
{
    private readonly string _root;
    private readonly TimeSpan _reconcileInterval;
    private readonly Action<ShareChange> _onChange;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly CancellationTokenSource _cts = new();
    private Dictionary<string, FileStamp> _snapshot = new(StringComparer.OrdinalIgnoreCase); // SMB is case-insensitive
    private volatile FileSystemWatcher? _watcher; // swapped from the Error callback
    private Task? _loop;

    public ShareWatcher(string root, TimeSpan reconcileInterval, Action<ShareChange> onChange)
    {
        _root = root;
        _reconcileInterval = reconcileInterval;
        _onChange = onChange;
    }

    public void Start()
    {
        // Baseline: whatever exists now is not a change.
        _snapshot = TakeSnapshot(_root) ?? _snapshot;
        TryStartWatcher();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            // Wake on the reconcile timer OR early when the watcher hints at a change.
            try { await _wake.WaitAsync(_reconcileInterval, ct); }
            catch (OperationCanceledException) { return; }

            // Small settle delay so a burst of hints becomes one scan.
            try { await Task.Delay(250, ct); }
            catch (OperationCanceledException) { return; }

            Reconcile();

            if (_watcher is null) TryStartWatcher();
        }
    }

    private void Reconcile()
    {
        var current = TakeSnapshot(_root);
        if (current is null)
        {
            // Share unreachable. Keep the old snapshot: an outage is not "every file was deleted".
            return;
        }

        foreach (var (path, stamp) in current)
        {
            if (!_snapshot.TryGetValue(path, out var old))
                _onChange(new(ShareChangeKind.Created, path));
            else if (old != stamp)
                _onChange(new(ShareChangeKind.Changed, path));
        }

        foreach (var path in _snapshot.Keys)
        {
            if (!current.ContainsKey(path))
                _onChange(new(ShareChangeKind.Deleted, path));
        }

        _snapshot = current;
    }

    private static Dictionary<string, FileStamp>? TakeSnapshot(string root)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        try
        {
            // Length and LastWriteTimeUtc come from the directory listing itself on Windows,
            // so this is one QUERY_DIRECTORY exchange per batch, not one round trip per file.
            // The constructor opens the directory, so it must sit inside the try.
            var entries = new FileSystemEnumerable<KeyValuePair<string, FileStamp>>(
                root,
                (ref FileSystemEntry e) => new(
                    e.ToFullPath(),
                    new FileStamp(e.Length, e.LastWriteTimeUtc.UtcDateTime)),
                options)
            {
                ShouldIncludePredicate = (ref FileSystemEntry e) => !e.IsDirectory,
            };

            var result = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);
            foreach (var (path, stamp) in entries) result[path] = stamp;
            return result;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void TryStartWatcher()
    {
        try
        {
            var w = new FileSystemWatcher(_root)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                IncludeSubdirectories = false,
                InternalBufferSize = 64 * 1024, // hard ceiling for network paths
            };
            w.Created += (_, _) => Hint();
            w.Changed += (_, _) => Hint();
            w.Deleted += (_, _) => Hint();
            w.Renamed += (_, _) => Hint();
            w.Error += (_, e) => OnWatcherError(w, e.GetException());
            w.EnableRaisingEvents = true;
            _watcher = w;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            // Share offline or path gone. Polling keeps running; we retry on the next pass.
            _watcher = null;
        }
    }

    private void OnWatcherError(FileSystemWatcher w, Exception ex)
    {
        // Overflow or a dropped connection: either way, events were lost.
        // Throw the watcher away, force a full rescan, and rebuild on the next pass.
        if (ReferenceEquals(_watcher, w)) _watcher = null;
        w.Dispose();
        Hint();
    }

    private void Hint()
    {
        try { _wake.Release(); }
        catch (SemaphoreFullException) { /* a scan is already pending */ }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null) await _loop;
        _watcher?.Dispose();
        _cts.Dispose();
        _wake.Dispose();
    }
}
```

Verwendung aus einem Worker oder einer Konsolen-App:

```csharp
// .NET 10 / .NET 11, C# 14
await using var watcher = new ShareWatcher(
    @"\\fileserver\drop",
    reconcileInterval: TimeSpan.FromSeconds(15),
    onChange: c => Console.WriteLine($"{c.Kind}: {c.Path}"));

watcher.Start();
await Task.Delay(Timeout.Infinite);
```

Ich habe dies auf einem lokalen Verzeichnis mit einem Abgleichsintervall von 3 Sekunden getestet: Eine erstellte Datei, ein Anhängen und ein Löschen wurden jeweils etwa 265 ms nach der Operation gemeldet (der Watcher-Hinweis plus die 250 ms Beruhigungsverzögerung). Während das Verzeichnis 4 Sekunden lang weggeschoben war, um einen Ausfall zu simulieren, wurde nichts gemeldet, und die Datei, die nach der Rückkehr erstellt wurde, wurde im nächsten Durchlauf gemeldet. Nichts wurde fälschlich als gelöscht gemeldet.

Einige Designentscheidungen, die erwähnenswert sind:

- **`SemaphoreSlim(0, 1)` als Aufwecksignal** fasst beliebig viele Hinweise zu einem einzigen ausstehenden Scan zusammen. Das Abfangen der `SemaphoreFullException` ist die Zusammenfassung, kein Fehlerpfad.
- **Die Beruhigungsverzögerung von 250 ms** macht aus einem Schub von Hinweisen (ein Batch mit 2.000 Dateien) einen Scan statt 2.000.
- **`_onChange` läuft in der Scan-Schleife**, jeweils ein Aufruf zur Zeit. Ist die Verarbeitung langsam, schieben Sie die Änderung in einen `Channel<ShareChange>` und lassen einen separaten Consumer sie behandeln, damit ein langsamer Handler den nächsten Scan nicht verzögert.
- **Versteckte und Systemdateien werden übersprungen**, wodurch `Thumbs.db`, `desktop.ini` und die `.DS_Store`-Dateien wegfallen, die macOS-Clients hinterlassen.

## Fallstricke, die Polling nicht für Sie löst

**Metadaten-Caches des Clients fügen Latenz hinzu, die Sie nicht konfiguriert haben.** Der Windows-SMB-Client cacht Verzeichnisauflistungen und Dateimetadaten. Laut dem [Leitfaden zur Leistungsoptimierung von Dateiservern](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/) betragen `DirectoryCacheLifetime` und `FileInfoCacheLifetime` standardmäßig 10 Sekunden und `FileNotFoundCacheLifetime` 5 Sekunden (alle unter `HKLM\System\CurrentControlSet\Services\LanmanWorkstation\Parameters`), wobei Verzeichnis-Leases unter SMB 3 das Bild weiter verändern. Unter Linux cacht `mount.cifs` Attribute standardmäßig 1 Sekunde lang (`actimeo`), und ein NFS-Client cacht Verzeichnisattribute standardmäßig 30 bis 60 Sekunden (`acdirmin`/`acdirmax`, siehe [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html)). Ihre effektive Latenz ist Ihr Poll-Intervall plus die Cache-Lebensdauer. Wenn Sie schneller sein müssen, passen Sie die Mount-Optionen an, nicht das Poll-Intervall.

**"Neue Datei" bedeutet nicht "fertige Datei".** Beide Mechanismen melden, dass eine Datei erschienen ist, nicht dass der Schreiber damit fertig ist. Eine 2 GB große Datei, die über das Netzwerk kopiert wird, erscheint in der Auflistung in dem Moment, in dem das Kopieren beginnt. Die Optionen habe ich ausführlich in [how to detect when a file finishes being written to](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) behandelt: Am robustesten ist es, wenn der Producer unter einem temporären Namen schreibt und am Ende umbenennt. Mit dem obigen Hybrid können Sie eine Datei auch einfach erst dann als bereit behandeln, wenn ihr Stempel über zwei Scans hinweg unverändert geblieben ist.

**Kopien, die Zeitstempel erhalten, wirken unverändert.** `robocopy` mit dem Standard `/COPY:DAT`, `cp -p` und `rsync -t` erhalten alle die Zeit der letzten Änderung der Quelle. Wird eine Datei durch eine gleich große ersetzt, ändert sich der Stempel `(Length, LastWriteUtc)` nicht. Wenn das eine Rolle spielt, fügen Sie unter Windows die Erstellungszeit oder bei kleinen Dateien einen Inhalts-Hash hinzu, oder bitten Sie den Producer, für jede Version einen neuen Namen zu verwenden.

**Zeitabweichung zwischen Client und Server.** Die gelesene Zeit der letzten Änderung ist der Zeitstempel des Servers. Vergleichen Sie Stempel nur mit anderen Stempeln derselben Freigabe, nie mit `DateTime.UtcNow` auf Ihrer Maschine. Logik wie "in den letzten 5 Minuten geändert" bricht unbemerkt, wenn die Uhr des Dateiservers falsch geht.

**Groß- und Kleinschreibung.** Das Snapshot-Dictionary verwendet `StringComparer.OrdinalIgnoreCase`, weil SMB-Freigaben nicht zwischen Groß- und Kleinschreibung unterscheiden. Bei einem NFS-Export mit einem Dateisystem, das sie unterscheidet, wechseln Sie zu `StringComparer.Ordinal`, sonst fallen zwei Dateien, die sich nur in der Schreibweise unterscheiden, zu einem Eintrag zusammen.

**Container-Bind-Mounts in Docker Desktop.** Dieselbe Regel gilt für einen Host-Ordner, der unter Windows oder macOS per Bind-Mount in einen Linux-Container eingebunden ist: Änderungsbenachrichtigungen vom Host sind unzuverlässig, daher ist Polling auch dort der einzig sichere Standard.

## Konfiguration auf einer Freigabe neu laden: DOTNET_USE_POLLING_FILE_WATCHER

Wenn die "Dateiänderung", um die es Ihnen geht, `appsettings.json` mit `reloadOnChange: true` ist, oder ein anderer Consumer von `PhysicalFileProvider`, brauchen Sie den obigen Code nicht. `PhysicalFileProvider` liest die Umgebungsvariable `DOTNET_USE_POLLING_FILE_WATCHER` in seinem Konstruktor:

```bash
# .NET 8, 9, 10, 11: switches PhysicalFileProvider to polling
export DOTNET_USE_POLLING_FILE_WATCHER=1
```

Mit `1` oder `true` setzt er sowohl `UsePollingFileWatcher` als auch `UseActivePolling`, erzeugt überhaupt keinen `FileSystemWatcher` und prüft per Timer die `LastWriteTimeUtc` jeder überwachten Datei. Das Intervall ist `PhysicalFilesWatcher.DefaultPollingInterval`, fest auf 4 Sekunden einprogrammiert. Sie können sich auch im Code pro Provider dafür entscheiden:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

var provider = new PhysicalFileProvider(@"\\fileserver\config")
{
    UsePollingFileWatcher = true,
    UseActivePolling = true,
};

builder.Configuration.AddJsonFile(provider, "appsettings.shared.json",
    optional: false, reloadOnChange: true);
```

Es gelten dieselben Einschränkungen: Er vergleicht nur die Zeit der letzten Änderung, daher ist eine Kopie mit erhaltenem Zeitstempel für ihn unsichtbar, und das SMB-Metadaten-Caching kann zusätzlich zum 4-Sekunden-Intervall bis zu 10 Sekunden aufschlagen. Der [Vergleichsbeitrag zu `IOptionsMonitor`](/de/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) behandelt, was nachgelagert passiert, sobald das Neuladen ausgelöst wird.

## Die Empfehlung noch einmal zusammengefasst

Verwenden Sie einen Polling-Snapshot-Vergleich als einzige maßgebliche Quelle für jeden Ordner auf einer SMB-Freigabe, einem NFS-Export oder einem Bind-Mount. Wählen Sie das Intervall nach Ihrem Latenzbudget und addieren Sie dann die Cache-Lebensdauer der Client-Metadaten. Wenn Sie unter Windows laufen und niedrige Latenz wollen, fügen Sie einen `FileSystemWatcher` hinzu, der nur den Poller früher aufweckt, begrenzen Sie dessen `InternalBufferSize` auf 64 KB und behandeln Sie jedes `Error`-Ereignis als "neu scannen und neu aufbauen". Der einzige Fall, in dem ein nackter `FileSystemWatcher` akzeptabel ist, ist eine lokale Festplatte, und selbst dort sollten Sie `Error` abonnieren.

## Weiterführende Lektüre

- [How to detect when a file finishes being written to in .NET](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) behandelt die Hälfte des Problems "erschienen, aber nicht fertig".
- [How to tail a log file in C# while another process is writing to it](/de/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) nutzt dieselbe Polling-zuerst-Argumentation für eine einzelne wachsende Datei.
- [Why FileInfo.Length returns a stale size on Windows](/de/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) erklärt, warum Metadaten aus der Verzeichnisauflistung der echten Datei hinterherhinken können.
- [Thread.Sleep vs Task.Delay vs SpinWait](/de/2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp/) erklärt, warum die Poll-Schleife wartet, statt zu schlafen.
- [Channels instead of BlockingCollection](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) zum Übergeben von Änderungen aus der Scan-Schleife an einen langsamen Consumer.

## Quellen

- [`FileSystemWatcher`-Klasse, Hinweise zu Puffergröße und Netzwerkpfaden](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) (Microsoft Learn)
- [`ReadDirectoryChangesW`-Funktion](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) (Microsoft Learn)
- [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs) und [`FileSystemWatcher.Linux.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Linux.cs) (dotnet/runtime)
- [`PhysicalFileProvider.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFileProvider.cs) und [`PhysicalFilesWatcher.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFilesWatcher.cs) (dotnet/runtime)
- [`FileSystemEnumerable<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/system.io.enumeration.filesystemenumerable-1) (Microsoft Learn)
- [Leistungsoptimierung für Dateiserver, SMB-Client-Cache-Einstellungen](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/) (Microsoft Learn)
- Manpages [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html) und [`mount.cifs(8)`](https://man7.org/linux/man-pages/man8/mount.cifs.8.html)
- [J. Bruce Fields zur NFS-Änderungsbenachrichtigung (LWN-Kommentar)](https://lwn.net/Articles/757833/)
