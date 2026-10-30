---
title: "FileSystemInfo.LastWriteTime-Setter vs. File.SetLastWriteTime in .NET"
description: "Beide enden im selben Betriebssystemaufruf, der geschriebene Zeitstempel ist also identisch. Die Unterschiede liegen drumherum: welcher Cache invalidiert wird, ob Verzeichnisse unter Windows funktionieren, wie ein Nicht-UTC-DateTime umgerechnet wird und ob sich ein offenes Handle als Ziel angeben lässt. Verwenden Sie File.SetLastWriteTimeUtc, bei geöffneter Datei per Handle. Geprüft mit .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "filesystem"
  - "io"
lang: "de"
translationOf: "2026/10/filesysteminfo-lastwritetime-setter-vs-file-setlastwritetime-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-30
---

Verwenden Sie `File.SetLastWriteTimeUtc` (oder `Directory.SetLastWriteTimeUtc` für Ordner) und nutzen Sie die Überladung mit `SafeFileHandle`, wenn Sie den Zeitstempel einer Datei setzen, in die Sie noch schreiben. Verwenden Sie den Setter `FileInfo.LastWriteTimeUtc` nur dann, wenn Sie dieses `FileInfo` bereits besitzen und seine Eigenschaften danach erneut lesen, denn der Setter ist die einzige API, die auch den Cache dieser Instanz aktualisiert. Beide Wege rufen exakt dasselbe interne `FileSystem.SetLastWriteTime` auf, die Bits, die auf die Platte gelangen, sind also identisch. Unterschiedlich ist alles rund um diesen Aufruf. In beiden Fällen gilt: Übergeben Sie ein `DateTime` mit `Kind = Utc` an das `...Utc`-Member, niemals eine lokale oder unspezifizierte Zeit an das Nicht-UTC-Member.

Alles unten wurde mit .NET 10.0.10 (SDK 10.0.302, C# 14) auf macOS 27 mit APFS ausgeführt, auf einer Maschine, deren lokale Zeitzone `Europe/Bucharest` ist (UTC+2 am Testtag). Das Windows-Verhalten ist aus dem Branch `release/10.0` von dotnet/runtime zitiert. Der beteiligte Code hat sich seit .NET 7, als die Handle-Überladungen hinzukamen, kaum verändert, die gleichen Regeln gelten also für .NET 8, 9 und die Vorschauversionen von .NET 11.

## Der Vergleich auf einen Blick

| | `fileInfo.LastWriteTimeUtc = t` | `File.SetLastWriteTimeUtc(path, t)` |
| --- | --- | --- |
| OS-Aufruf (Windows) | `SetFileInformationByHandle(FileBasicInfo)` | identisch |
| OS-Aufruf (Unix) | `utimensat(..., AT_SYMLINK_NOFOLLOW)` | identisch |
| Invalidiert den Cache von | nur dieser `FileInfo`-Instanz | nichts (kein Cache beteiligt) |
| Andere `FileInfo`-Objekte für denselben Pfad | veraltet bis `Refresh()` | veraltet bis `Refresh()` |
| Verzeichnis als Ziel unter Windows | nur über `DirectoryInfo` | schlägt fehl, `Directory.SetLastWriteTimeUtc` verwenden |
| Akzeptiert ein offenes `SafeFileHandle` | nein | ja, seit .NET 7 |
| `DateTime.MinValue` mit lokalem Setter, UTC+-Zone | wird stillschweigend begrenzt | wirft `ArgumentOutOfRangeException` |
| Fehlende Datei | `FileNotFoundException` | `FileNotFoundException` |
| Kosten pro Aufruf (10.000 Aufrufe, APFS, M4) | 10,4 us | 10,7 us (per Handle: 8,6 us) |

## Was die beiden APIs tatsächlich tun

Ohne die öffentliche Oberfläche treffen sich beide an einer Stelle. Hier die Seite von `FileSystemInfo`, aus `FileSystemInfo.cs` und `FileSystemInfo.Windows.cs`:

```csharp
// dotnet/runtime release/10.0, System.Private.CoreLib
public DateTime LastWriteTime
{
    get => LastWriteTimeUtc.ToLocalTime();
    set => LastWriteTimeUtc = value.ToUniversalTime();
}

public DateTime LastWriteTimeUtc
{
    get => LastWriteTimeCore.UtcDateTime;
    set => LastWriteTimeCore = File.GetUtcDateTimeOffset(value);
}

internal DateTimeOffset LastWriteTimeCore   // Windows
{
    set
    {
        FileSystem.SetLastWriteTime(FullPath, value, (this is DirectoryInfo));
        _dataInitialized = -1;   // invalidate this instance's cache
    }
}
```

Und die Seite von `File`:

```csharp
// dotnet/runtime release/10.0, File.cs
public static void SetLastWriteTime(string path, DateTime lastWriteTime)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), lastWriteTime, false);

public static void SetLastWriteTimeUtc(string path, DateTime lastWriteTimeUtc)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), GetUtcDateTimeOffset(lastWriteTimeUtc), false);
```

Das abschließende `false` ist das Flag `asDirectory`, und es ist unter Windows relevant (mehr dazu weiter unten). Unter Unix geht der `FileInfo`-Setter über seine eigene `FileStatus`-Struct, während `File` ein kurzlebiges `default(FileStatus)` verwendet, aber beide rufen dasselbe `SetAccessOrWriteTimeCore` auf. Diese Methode liest die Datei zuerst erneut per Stat, um die aktuelle Zugriffszeit unverändert zurückzuschreiben, ruft dann `utimensat` mit `AT_SYMLINK_NOFOLLOW` auf und invalidiert anschließend den Statuscache. Unter Windows öffnen beide den Pfad mit `FILE_WRITE_ATTRIBUTES` und rufen `SetFileInformationByHandle` mit einem `FILE_BASIC_INFO` auf, in dem jedes Feld außer `LastWriteTime` null ist, was Windows als "unverändert lassen" interpretiert.

Es gibt also kein Verhalten der Art "der `FileInfo`-Setter ist lazy" oder "er ändert nur das Objekt im Speicher", was eine verbreitete Annahme ist. Der Setter schreibt sofort auf die Platte, genau wie die statische Methode.

## Cache-Invalidierung: der Unterschied, auf den Sie tatsächlich stoßen

`FileSystemInfo` legt alles, was es liest, in einem Cache ab. Der erste Eigenschaftszugriff ruft Stat für die Datei auf, spätere Zugriffe liefern den Snapshot, bis jemand `Refresh()` aufruft. Der Setter invalidiert den Cache der Instanz, auf der Sie ihn aufgerufen haben, und sonst nichts. Dieser Test macht alle drei Fälle sichtbar:

```csharp
// .NET 10.0.10, C# 14 - run with: dotnet run probe.cs
var path = Path.Combine(Path.GetTempPath(), "a.txt");
File.WriteAllText(path, "hello");
var target = new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc);

var fi1 = new FileInfo(path);
var fi2 = new FileInfo(path);
_ = fi1.LastWriteTimeUtc; _ = fi2.LastWriteTimeUtc; // populate both caches

fi1.LastWriteTimeUtc = target;
Console.WriteLine(fi1.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2026-10-30T12:04:26.3262150Z (stale)
fi2.Refresh();
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z

var fi3 = new FileInfo(path); _ = fi3.Length;          // snapshot now
File.SetLastWriteTimeUtc(path, target.AddYears(1));
Console.WriteLine(fi3.LastWriteTimeUtc.ToString("O")); // 2020-01-02... (stale)
Console.WriteLine(File.GetLastWriteTimeUtc(path).ToString("O")); // 2021-01-02...
```

Das ist der eine echte Grund, den Setter zu bevorzugen. Wenn eine Methode ein `FileInfo` erhält, dessen Zeitstempel setzt und der Aufrufer danach `fileInfo.LastWriteTime` protokolliert oder mit einer anderen Datei vergleicht, hält der Setter dieses Objekt korrekt. Wer an derselben Stelle `File.SetLastWriteTimeUtc(fileInfo.FullName, t)` aufruft, überlässt dem Aufrufer einen veralteten Wert, und dieser Fehler zeigt sich erst, wenn jemand die Eigenschaft erneut liest. Wählen Sie diesen Weg, ergänzen Sie danach `fileInfo.Refresh()`.

Das Gegenteil ist genauso wichtig: Der Setter erreicht keine anderen `FileInfo`-Instanzen, auch nicht die aus `DirectoryInfo.EnumerateFiles`. Diese wurden während der Enumeration befüllt und bleiben eingefroren. Dasselbe Snapshot-Verhalten sorgt dafür, dass `FileInfo.Length` bei wachsenden Dateien falsche Werte liefert, was ich ausführlich in [warum FileInfo.Length unter Windows eine veraltete Größe liefert](/de/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) behandelt habe.

## Verzeichnisse: die reine Windows-Falle in File.SetLastWriteTime

`File.SetLastWriteTime` übergibt immer `asDirectory: false`. Unter Windows entscheidet dieses Flag, ob `OpenHandleToWriteAttributes` dem Aufruf von `CreateFile` das Flag `FILE_FLAG_BACKUP_SEMANTICS` hinzufügt:

```csharp
// dotnet/runtime release/10.0, FileSystem.Windows.cs
int dwFlagsAndAttributes = Interop.Kernel32.FileOperations.FILE_FLAG_OPEN_REPARSE_POINT;
if (asDirectory)
{
    dwFlagsAndAttributes |= Interop.Kernel32.FileOperations.FILE_FLAG_BACKUP_SEMANTICS;
}
```

Die [Dokumentation zu `CreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) sagt ausdrücklich, dass `FILE_FLAG_BACKUP_SEMANTICS` gesetzt sein muss, um ein Handle auf ein Verzeichnis zu erhalten. `File.SetLastWriteTimeUtc(@"C:\data\folder", t)` schlägt unter Windows deshalb mit einem Zugriffsfehler fehl. `DirectoryInfo.LastWriteTimeUtc = t` übergibt `this is DirectoryInfo` und funktioniert, ebenso `Directory.SetLastWriteTimeUtc`.

Unter Linux und macOS beeinflusst das Flag nur, welcher Ausnahmetyp bei einem fehlenden Pfad geworfen wird, derselbe `File`-Aufruf auf einem Verzeichnis gelingt also. Mein Test hat das auf APFS bestätigt. Genau solcher Code besteht CI auf einem Linux-Runner und scheitert dann auf dem Windows-Laptop eines Entwicklers. Wenn Ihr Code sowohl Dateien als auch Ordner erhalten kann, verzweigen Sie anhand von `Directory.Exists` und rufen die passende statische Klasse auf, oder erzeugen Sie den richtigen `FileSystemInfo`-Untertyp.

Eine verwandte Eigenart: `new FileInfo(directoryPath).Exists` ist `false`, dennoch gelingt unter Unix `new FileInfo(directoryPath).LastWriteTimeUtc = t` und setzt den Zeitstempel des Verzeichnisses. Verlassen Sie sich nicht darauf.

## Lokal vs. UTC: wo die beiden Wege bei Randwerten auseinanderlaufen

Bei den Nicht-UTC-Membern sind die beiden APIs nicht mehr symmetrisch. `File.SetLastWriteTime(string, DateTime)` reicht das `DateTime` direkt an einen `DateTimeOffset`-Parameter weiter, es läuft also die implizite Konvertierung von `DateTime` nach `DateTimeOffset`. Der Setter `FileInfo.LastWriteTime` ruft stattdessen `value.ToUniversalTime()` auf. Bei normalen Datumswerten stimmen beide überein, und beide behandeln `DateTimeKind.Unspecified` als lokale Zeit:

```text
File.SetLastWriteTime(Unspecified 12:00)    -> 09:00Z   (treated as local, UTC+3 in June)
File.SetLastWriteTimeUtc(Unspecified 12:00) -> 12:00Z   (treated as UTC)
File.SetLastWriteTime(Utc-kind 03:04:05Z)   -> 03:04:05Z (Kind honoured)
fi.LastWriteTime = Unspecified 12:00        -> 09:00Z
fi.LastWriteTimeUtc = Local-kind 12:00      -> 09:00Z   (Local converted, not reinterpreted)
```

An den Rändern unterscheiden sie sich. In jeder Zeitzone östlich von UTC hat `DateTime.MinValue` kein gültiges UTC-Äquivalent. `ToUniversalTime()` begrenzt stillschweigend auf `DateTime.MinValue`, während die implizite `DateTimeOffset`-Konvertierung das verweigert:

```csharp
// .NET 10.0.10, Europe/Bucharest (UTC+2)
File.SetLastWriteTime(path, DateTime.MinValue);
// ArgumentOutOfRangeException: The UTC time represented when the offset is applied
// must be between year 0 and 10,000. (Parameter 'offset')

new FileInfo(path).LastWriteTime = DateTime.MinValue; // no exception here
```

Westlich von UTC wirft `DateTime.MaxValue` auf dieselbe Weise. Sie würden diese Werte nicht absichtlich verwenden, aber Codepfade, die auf "Standardwert zurücksetzen" laufen, und nicht initialisierte Felder führen sie häufiger herbei, als man erwartet.

Die Konvertierung zu überstehen heißt nicht, dass der Wert speicherbar ist. Windows-`FILETIME` beginnt im Jahr 1601, und `DateTimeOffset.ToFileTime()` wirft für alles Frühere `ArgumentOutOfRangeException: Not a valid Win32 FileTime.`, sodass unter Windows beide APIs für `DateTime.MinValue` werfen. APFS speichert eine vorzeichenbehaftete 64-Bit-Zahl von Nanosekunden seit 1970, daher landet der "erfolgreiche" Schreibvorgang mit `DateTime.MinValue` unter macOS bei `1677-09-21T00:12:43.1452241Z`, dem frühesten Zeitpunkt, den APFS darstellen kann. Beides ist nicht, was Sie gemeint haben. Prüfen Sie den Wertebereich selbst, bevor Sie eine der beiden APIs aufrufen.

Die Sommerzeit ist der andere Grund, bei den `...Utc`-Membern zu bleiben. Eine lokale Uhrzeit in der Stunde der Zeitumstellung im Herbst ist mehrdeutig, und `ToUniversalTime()` wählt ohne Hinweis die Standardzeit-Interpretation. Stammt der Zeitstempel von einer anderen Maschine, aus einer Datenbank oder einem Archiv-Eintrag, war er mit ziemlicher Sicherheit von Anfang an UTC. Behalten Sie das bis zur Platte bei. Derselbe Rat gilt für [`DateTime`-Werte in JSON-Payloads](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

## Die Handle-Überladung, und warum offene Dateien Ihren Zeitstempel rückgängig machen

Nur die statische Klasse hat `File.SetLastWriteTime(SafeFileHandle, DateTime)` und `File.SetLastWriteTimeUtc(SafeFileHandle, DateTime)`, hinzugefügt in .NET 7. Sie rufen `SetFileInformationByHandle` oder `futimens` auf dem Handle auf, das Sie bereits halten, und sparen sich so die Pfadauflösung und das zusätzliche Öffnen.

Der wichtigere Grund, sie zu verwenden, ist die Reihenfolge. Den Zeitstempel zu setzen, während Ihr eigener `FileStream` noch gepufferte Bytes hält, ist ein klassischer Fehler, denn das Betriebssystem erhöht die Änderungszeit erneut, wenn diese Bytes beim `Dispose` geleert werden:

```csharp
// .NET 10.0.10, C# 14
using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);               // sits in FileStream's 4 KB buffer
    File.SetLastWriteTimeUtc(p, target);
    // File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z
}
// File.GetLastWriteTimeUtc(p) here: 2026-10-30T12:04:26Z  <- your value is gone

using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);
    fs.Flush();                            // all writes reach the OS first
    File.SetLastWriteTimeUtc(fs.SafeFileHandle, target);
}
// File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z  <- kept
```

Die Regel lautet "der letzte Schreibzugriff gewinnt": Der Zeitstempel muss das Letzte sein, was die Datei berührt. Leeren, dann per Handle setzen, dann schließen. Den Zeitstempel nach dem `using`-Block per Pfad zu setzen funktioniert ebenfalls, kostet aber ein zweites Öffnen und lässt ein Zeitfenster, in dem ein anderer Prozess die Datei mit der falschen Zeit sehen kann. Das ist relevant, wenn ein Konsument [darauf wartet, dass die Datei fertig geschrieben ist](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) oder Zeitstempel abfragt, wie es der [Snapshot-Diff-Ansatz bei Netzwerkfreigaben](/de/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) tut.

`FileSystemInfo` hat kein Handle-basiertes Gegenstück. Wenn Sie dieses Muster brauchen, sind Sie unabhängig von Ihrer Präferenz auf `File` angewiesen.

## Symlinks, Erstellungszeit und Genauigkeit

Drei Dinge sind auf beiden Wegen gleich, werden aber oft falsch verstanden:

- **Symlinks**: Windows öffnet mit `FILE_FLAG_OPEN_REPARSE_POINT` und Unix ruft `utimensat` mit `AT_SYMLINK_NOFOLLOW` auf, sodass beide APIs den Link selbst stempeln und das Ziel unberührt lassen. Wenn Sie das Ziel wollen, lösen Sie es zuerst mit `FileSystemInfo.ResolveLinkTarget(returnFinalTarget: true)` auf und setzen die Zeit auf dem Ergebnis.
- **Erstellungszeit unter macOS**: Wird eine Änderungszeit vor der Birth Time gesetzt, zieht der Kernel die Birth Time auf denselben Wert zurück. .NET erkennt das unter macOS und stellt die ursprüngliche Erstellungszeit mit `setattrlist` wieder her, sodass `File.GetCreationTimeUtc` nach dem Zurückdatieren von `LastWriteTime` unverändert bleibt. Unter Linux gibt es keine setzbare Birth Time, und .NET meldet den älteren Wert von `ctime` und `mtime` als Erstellungszeit.
- **Genauigkeit**: `DateTime` hat Ticks von 100 ns. NTFS, APFS und ext4 behalten alle (mein Round-Trip von `...07.1234567Z` kam exakt zurück), FAT32 rundet auf 2 Sekunden, und exFAT behält 10 ms. Wenn Sie Zeitstempel über Datenträger hinweg vergleichen, zum Beispiel in einem Backup- oder Sync-Tool, vergleichen Sie mit einer Toleranz statt mit `==`.

Beide APIs werfen für eine fehlende Datei `FileNotFoundException`. Das ist asymmetrisch zu den Gettern, die stattdessen `1601-01-01T00:00:00Z` zurückgeben, ohne zu werfen. Code, der die Zeit liest, entscheidet und dann schreibt, kann daher erleben, dass die Datei zwischen den beiden Aufrufen verschwindet, und eine Ausnahme von einer scheinbar harmlosen Methode bekommen. Wenn die Datei nebenläufig gelöscht werden kann, fangen Sie `FileNotFoundException` rund um den Schreibvorgang ab.

## Der Benchmark, der keine Rolle spielt

Der Vollständigkeit halber: 10.000 Aufrufe jeweils auf einem warmen APFS-Volume (Apple M4, .NET 10.0.10, Release, `Stopwatch` um eine Schleife) kosten 10,72 us pro Aufruf für `File.SetLastWriteTimeUtc(path, t)`, 10,40 us für den `FileInfo`-Setter und 8,60 us für die Handle-Überladung auf einem bereits geöffneten Handle. Die Pfadvarianten sind im Rahmen des Rauschens gleich, weil jede ein Stat, ein `utimensat` und auf der `FileInfo`-Seite ein Zurücksetzen des Caches ausführt. Das Handle spart die Pfadauflösung. Nichts davon sollte Ihre Wahl bestimmen. Wenn Sie Tausende Dateien stempeln, dominiert das Stat in jedem Setzaufruf, und Parallelisierung über die Dateien hilft weit mehr als ein Wechsel der API.

## Die Empfehlung noch einmal zusammengefasst

Nehmen Sie standardmäßig `File.SetLastWriteTimeUtc(path, utc)` und `Directory.SetLastWriteTimeUtc(path, utc)`. Sie sind explizit darin, welche Art von Eintrag Sie ansprechen, können kein zwischengespeichertes Objekt zurücklassen und haben eine Handle-Überladung für den Fall "auf der Datei setzen, die ich gerade geschrieben habe", aus dem die meisten Zeitstempelfehler stammen. Wechseln Sie zu `fileInfo.LastWriteTimeUtc = utc`, wenn das `FileInfo` in Ihrem Code die Arbeitseinheit ist und jemand seine Eigenschaften erneut liest, denn der Setter ist die einzige API, die diese Instanz synchron hält. Meiden Sie die Nicht-UTC-Member beider Klassen, und prüfen Sie, dass der Wert in den Bereich des Zieldateisystems passt, bevor Sie schreiben.

## Weiterführende Lektüre

- [Warum FileInfo.Length unter Windows eine veraltete Größe liefert](/de/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) geht dem gleichen `FileSystemInfo`-Caching aus Sicht der Größe nach.
- [Wie man erkennt, dass eine Datei fertig geschrieben wurde, in .NET](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) behandelt die Konsumentenseite von "der letzte Schreibzugriff gewinnt".
- [FileSystemWatcher vs. Polling auf einer Netzwerkfreigabe](/de/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) setzt auf Zeitstempel, die Sie gerade korrekt zu setzen gelernt haben.
- [Wie man eine Logdatei verfolgt, während ein anderer Prozess hineinschreibt](/de/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) zeigt die `FileShare`-Flags, die in den obigen Tests verwendet wurden.
- [Wie man eine dateibasierte C#-App mit dotnet run ausführt](/de/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), falls Sie `probe.cs` selbst erneut ausführen möchten.

## Quellen

- [`FileSystemInfo.LastWriteTime`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.lastwritetime) und [`File.SetLastWriteTimeUtc`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.setlastwritetimeutc) (Microsoft Learn)
- [`FileSystemInfo.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.cs), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs), [`File.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs) (dotnet/runtime)
- [`FileSystem.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystem.Windows.cs), [`FileStatus.Unix.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileStatus.Unix.cs), [`pal_time.c`](https://github.com/dotnet/runtime/blob/release/10.0/src/native/libs/System.Native/pal_time.c) (dotnet/runtime)
- [`CreateFileW`, `FILE_FLAG_BACKUP_SEMANTICS`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) und [`FILE_BASIC_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info) (Microsoft Learn)
- [`utimensat(2)`](https://man7.org/linux/man-pages/man2/utimensat.2.html) (Linux man pages)
- [File times, resolution per file system](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times) (Microsoft Learn)
