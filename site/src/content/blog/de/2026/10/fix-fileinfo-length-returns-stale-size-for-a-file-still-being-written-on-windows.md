---
title: "Fix: FileInfo.Length liefert unter Windows eine veraltete Größe für eine Datei, die noch geschrieben wird"
description: "FileInfo speichert seine Größe zwischen, die Enumeration liest den verzögert aktualisierten NTFS-Verzeichniseintrag, und der Schreiber hält Bytes womöglich noch in eigenen Puffern. Refresh() hilft, besser ist es, die Länge über ein Shared Handle mit RandomAccess.GetLength zu lesen."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "csharp"
  - "filesystem"
lang: "de"
translationOf: "2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows"
translatedBy: "claude"
translationDate: 2026-10-13
---

`FileInfo.Length` liefert aus drei voneinander unabhängigen Gründen falsche Werte, und die Gründe addieren sich. Erstens speichert ein `FileInfo` seine Daten beim ersten Lesen irgendeiner Eigenschaft zwischen und liest sie erst wieder, wenn Sie `Refresh()` aufrufen. Zweitens wird ein `FileInfo`, das aus `DirectoryInfo.EnumerateFiles` oder `GetFiles` unter Windows stammt, aus dem NTFS-Verzeichniseintrag befüllt, und NTFS aktualisiert diese Kopie der Größe erst, wenn der Schreiber sein letztes Handle schließt. Drittens hält der schreibende Prozess die Bytes unter Umständen noch in den eigenen Puffern von `StreamWriter` / `FileStream`, sodass das Betriebssystem sie tatsächlich noch nicht gesehen hat. Die zuverlässige Lösung: nicht mehr den Pfad fragen, sondern ein Handle: `using var h = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); long size = RandomAccess.GetLength(h);`. Wenn Sie den Schreiber kontrollieren, rufen Sie dort Flush auf. Die unten genannten Pufferwerte wurden mit .NET 10.0.10 (SDK 10.0.302) und .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128) gemessen und waren identisch. Die Windows-spezifischen Codepfade stammen aus dem dotnet/runtime-Quellcode auf `main`.

## Das Symptom im Kontext

Es wird keine Exception ausgelöst. Der Fehlerbericht liest sich meist wie einer dieser Fälle:

```
// what people see, .NET 10 / .NET 11 on Windows
size = 0          // the log file is clearly growing in Notepad++
size = 4096       // the writer has logged 6000 characters
size = 1048576    // Explorer says 1 MB, the copy job says 37 MB
```

Das Muster ist immer dasselbe. Eine Überwachungsschleife, ein Upload-Job oder eine Prüfung "warten, bis die Datei nicht mehr wächst" liest `FileInfo.Length`, während ein anderer Prozess (oder ein anderer Thread) die Datei zum Schreiben geöffnet hat. Die Zahl hinkt hinterher, steht manchmal still und springt auf den richtigen Wert, sobald der Schreiber die Datei schließt. Explorer und `dir` zeigen dieselbe eingefrorene Zahl, was viele davon überzeugt, das Problem liege bei Windows und nicht im eigenen Code. Es liegt teils an beidem.

## Warum das passiert

Es gibt drei Ebenen, und jede kann das Problem allein verursachen.

**1. `FileInfo` ist eine Momentaufnahme, keine Live-Ansicht.** `FileSystemInfo` hält eine private `WIN32_FILE_ATTRIBUTE_DATA`-Struktur und ein `_dataInitialized`-Flag. Der erste Eigenschaftszugriff befüllt sie, jeder weitere liefert den zwischengespeicherten Wert. Die [Dokumentation zu `FileInfo.Length`](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) sagt das direkt: Der Wert ist vorab gecacht, wenn die Instanz aus `GetFiles` oder `EnumerateFiles` stammt, und Sie müssen `Refresh` aufrufen, um den aktuellen Wert zu erhalten. Ein feines Detail: Die Befüllung ist verzögert. `new FileInfo(path)` berührt die Platte nicht, der "Zeitpunkt der Momentaufnahme" ist also der Moment, in dem Ihr Code zum ersten Mal `Length`, `Exists` oder einen Zeitstempel liest, und das ist oft viel früher, als man denkt.

**2. Die Enumeration liest den Verzeichniseintrag, und NTFS aktualisiert ihn verzögert.** Unter Windows ruft `FileSystemEnumerator` `NtQueryDirectoryFile` mit `FileFullDirectoryInformation` auf, und `FileSystemInfo.Init(FILE_FULL_DIR_INFORMATION*)` kopiert `EndOfFile` direkt in die zwischengespeicherte Größe. Diese Zahl stammt aus dem Verzeichnisindex, nicht aus der Datei. Wie Raymond Chen in [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813) erklärt, behandelt NTFS die Größe als Eigenschaft der Datei und repliziert sie nur als Optimierung für Auflistungen in den Verzeichniseintrag. Seit Windows Vista wird diese Replik aktualisiert, wenn das letzte Handle auf das Dateiobjekt geschlossen wird. Ein Schreiber, der ein Log stundenlang offen hält, lässt den Verzeichniseintrag auf der Größe stehen, die die Datei beim Öffnen hatte, oft 0. Genau das melden Explorer, `dir`, `Directory.GetFiles` plus `new FileInfo(...)` auf dem Ergebnis und `FileSystemEntry.Length` in einer eigenen `FileSystemEnumerable`.

**3. Der Schreiber hat die Bytes noch nicht geschrieben.** Ein `StreamWriter` hält Zeichen in einem eigenen Puffer und gibt kodierte Bytes dann an einen `FileStream` weiter, der standardmäßig einen eigenen 4096-Byte-Puffer hat. Bis die Puffer voll sind oder jemand `Flush()` aufruft, hat das Betriebssystem kein einziges Byte erhalten, daher melden alle APIs auf allen Plattformen korrekt die alte Größe. Diese Ebene vergessen die meisten, weil sie von außen genauso aussieht wie die beiden anderen.

Eine vierte Ebene tritt nur auf Netzwerkfreigaben auf: Der SMB-Client-Redirector speichert Dateimetadaten für pfadbasierte Abfragen zwischen. `FileInfoCacheLifetime` und `DirectoryCacheLifetime` stehen auf aktuellen Windows-Versionen beide standardmäßig auf 10 Sekunden (siehe [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server)), sodass ein UNC-Pfad selbst nach einem `Refresh()` eine bis zu 10 Sekunden alte Größe zeigen kann.

## Minimales Reproduktionsbeispiel

Diese dateibasierte App schreibt ohne Flush über einen `StreamWriter` und misst die Größe auf vier Arten: über ein zwischengespeichertes `FileInfo`, dasselbe `FileInfo` nach `Refresh()`, ein frisches Handle via `RandomAccess.GetLength` und ein `FileInfo` aus der Verzeichnisenumeration. Starten Sie sie mit `dotnet run probe.cs`.

```csharp
// .NET 10 / .NET 11, C# 14, file-based app: dotnet run probe.cs
#:property PublishAot=false
using Microsoft.Win32.SafeHandles;

string path = Path.Combine(Path.GetTempPath(), "stale-probe.log");
File.Delete(path);

using var writer = new StreamWriter(new FileStream(path, FileMode.Create,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete));
var cached = new FileInfo(path);
Console.WriteLine($"start: cached={cached.Length}");   // first access: snapshot taken here

writer.Write(new string('a', 1000));
Report("after 1000 chars, no flush");
writer.Write(new string('a', 5000));
Report("after 6000 chars, no flush");
writer.Flush();
Report("after StreamWriter.Flush()");

var fromEnum = new DirectoryInfo(Path.GetTempPath())
    .EnumerateFiles("stale-probe.log").Single();
writer.Write(new string('b', 4000)); writer.Flush();
Console.WriteLine($"enumerated FileInfo (no Refresh) after +4000: {fromEnum.Length}");
fromEnum.Refresh();
Console.WriteLine($"enumerated FileInfo after Refresh: {fromEnum.Length}");

void Report(string label)
{
    long stale = cached.Length;
    cached.Refresh();
    long refreshed = cached.Length;
    using SafeFileHandle h = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    Console.WriteLine($"{label}: cached={stale} refreshed={refreshed} " +
        $"handle={RandomAccess.GetLength(h)} writer.BaseStream.Position={writer.BaseStream.Position}");
}
```

Ausgabe, identisch unter .NET 10.0.10 und .NET 11.0.0 RC1 (macOS arm64, APFS):

```
start: cached=0
after 1000 chars, no flush: cached=0 refreshed=0 handle=0 writer.BaseStream.Position=0
after 6000 chars, no flush: cached=0 refreshed=4096 handle=4096 writer.BaseStream.Position=5120
after StreamWriter.Flush(): cached=4096 refreshed=6000 handle=6000 writer.BaseStream.Position=6000
enumerated FileInfo (no Refresh) after +4000: 6000
enumerated FileInfo after Refresh: 10000
```

Zeile für Zeile gelesen:

- Nach 1000 Zeichen ist noch nichts beim Betriebssystem angekommen. Der `StreamWriter` hält alles zurück, daher zeigt sogar das Handle 0. Eine Lösung auf Leserseite kann hier nicht helfen.
- Nach 6000 Zeichen hat der `StreamWriter` 5120 Zeichen (fünf Blöcke zu je 1024 Zeichen) an den `FileStream` übergeben, und der `FileStream` hat einen vollen 4096-Byte-Puffer an das Betriebssystem geschrieben. Jede ehrliche API sagt 4096. Das zwischengespeicherte `FileInfo` sagt weiterhin 0.
- Nach `Flush()` beträgt die echte Größe 6000. Das zwischengespeicherte `FileInfo` sagt 4096, weil der vorherige `Report`-Aufruf es aktualisiert hat und seitdem nichts mehr.
- Das enumerierte `FileInfo` war zum Zeitpunkt der Enumeration eingefroren und brauchte ein `Refresh()`, um die zusätzlichen 4000 Bytes zu sehen.

Unter macOS und Linux sind die Ebenen 1 und 3 die ganze Geschichte, denn `stat` liest den Inode, und es gibt keine separate Verzeichniskopie der Größe. Unter Windows kommt Ebene 2 hinzu: Führen Sie dasselbe Programm dort aus und betrachten Sie den Ordner im Explorer, während es wartet, dann bleibt die Verzeichnisanzeige hinter dem Handle-Wert zurück, bis der Schreiber freigegeben wird. Diese Hälfte habe ich für diesen Beitrag nicht auf einem Windows-Rechner gemessen. Der Mechanismus ist von Raymond Chen dokumentiert, und der genaue Codepfad (`NtQueryDirectoryFile` nach `FileSystemInfo.Init`) ist im am Ende verlinkten Runtime-Quellcode sichtbar.

## Die Lösung im Detail

Wählen Sie die Lösung, die zur Ebene passt, die Sie treffen. In echtem Code treffen Sie meist mehr als eine.

### 1. Empfohlen: Größe aus einem Handle lesen, nicht aus einem Pfad

Eine handlebasierte Abfrage geht an das geöffnete Dateiobjekt, und dort führt NTFS das maßgebliche End-of-File. Es ist die einzige Antwort, die Raymond Chen als korrekt beschreibt (`GetFileSize` auf einem Handle), und sie umgeht sowohl den `FileInfo`-Cache als auch den Verzeichniseintrag. Seit .NET 6 geht das ohne `FileStream`:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Win32.SafeHandles;

static long GetLiveLength(string path)
{
    // FileShare.ReadWrite: the writer already holds write access, so we must allow it.
    // FileShare.Delete: do not break a writer that renames or deletes during rotation.
    using SafeFileHandle handle = File.OpenHandle(
        path,
        FileMode.Open,
        FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);

    return RandomAccess.GetLength(handle);
}
```

`File.OpenHandle` plus `RandomAccess.GetLength` ist leichtgewichtiger als `new FileStream(...).Length`: keine Pufferallokation, keine Positionsverfolgung, und unter Windows ruft `RandomAccess.GetLength` `GetFileInformationByHandleEx(FileStandardInfo)` auf dem Handle auf und gibt `EndOfFile` zurück. Wenn Sie bereits einen `FileStream` auf der Datei offen haben (etwa weil Sie sie mitlesen), verwenden Sie `stream.Length` auf diesem Stream. Er geht über dieselbe Handle-Abfrage.

Ein weiterer Cache versteckt sich hier. Unter Windows setzt `SafeFileHandle` das Flag `_lengthCanBeCached`, wenn das Handle schreibgeschützt **und** ohne `FileShare.Write` geöffnet wurde, und liefert danach immer die zuerst abgerufene Länge. Das ist korrekt, denn niemand kann in die Datei schreiben, solange Ihr Handle Schreibfreigabe verweigert. Es bedeutet aber, dass `FileShare.Read` nie die richtige Wahl ist, um eine wachsende Datei zu beobachten. Läuft der Schreiber schon, schlägt Ihr Öffnen fehl. Öffnen Sie zuerst, schlägt das Öffnen des Schreibers fehl, was schlimmer ist, weil Sie damit den Produzenten kaputt gemacht haben. Verwenden Sie `FileShare.ReadWrite` (plus `FileShare.Delete`), dann fragt die Runtime bei jedem Aufruf das Betriebssystem.

Der Freigabemodus ist wichtig. Wenn Sie mit dem Standard `FileShare.Read` öffnen, schlägt das Öffnen mit `IOException: The process cannot access the file because it is being used by another process` fehl, weil der Schreiber bereits Schreibzugriff hat und Ihr Freigabemodus diesen nicht erlaubt. Dieser Fehler ist der häufigste Grund, warum Leute den Handle-Ansatz aufgeben und zu `FileInfo` zurückkehren.

Ein erwähnenswerter Nebeneffekt: Wenn Sie Ihr eigenes Handle öffnen und schließen, aktualisiert NTFS beim Schließen ebenfalls den Verzeichniseintrag, laut demselben Old-New-Thing-Beitrag. Nach einem Aufruf von `GetLiveLength` ziehen also auch Explorer und die Enumeration nach, bis der Schreiber wieder anhängt.

### 2. Wenn Sie `FileInfo` verwenden müssen, rufen Sie vor jedem Lesen `Refresh()` auf

Für eine Polling-Schleife behalten Sie ein einziges `FileInfo` und aktualisieren es in jeder Iteration:

```csharp
// .NET 10 / .NET 11, C# 14
var fi = new FileInfo(path);
long last = -1;
while (!ct.IsCancellationRequested)
{
    fi.Refresh();                       // without this, Length never changes
    if (fi.Exists && fi.Length != last)
    {
        Console.WriteLine($"{fi.Length:N0} bytes");
        last = fi.Length;
    }
    await Task.Delay(TimeSpan.FromSeconds(1), ct);
}
```

Unter Windows läuft `Refresh()` auf einem pfadbasiert erzeugten `FileInfo` über `FileSystem.FillAttributeInfo`, das `GetFileAttributesEx` auf dem Pfad aufruft und nur dann auf `FindFirstFile` (ein Lesen des Verzeichniseintrags) zurückfällt, wenn dieser Aufruf mit etwas wie `ERROR_SHARING_VIOLATION` oder `ERROR_ACCESS_DENIED` scheitert. Dieser Fallback existiert für `pagefile.sys` und Dateien, deren Löschung aussteht. Microsoft dokumentiert nicht, ob `GetFileAttributesEx` immer die aktuelle Größe einer geöffneten Datei widerspiegelt. Verstehen Sie `Refresh()` daher als "behebt Ebene 1, behebt wahrscheinlich Ebene 2 auf lokalem NTFS" und nutzen Sie überall, wo Korrektheit zählt, den Handle-Ansatz.

### 3. Größen aus der Enumeration bei möglicherweise geöffneten Dateien nie vertrauen

`Directory.EnumerateFiles`, das Pfade liefert, ist in Ordnung. `DirectoryInfo.EnumerateFiles`, das `FileInfo`-Objekte liefert, und `FileSystemEntry.Length` in einer `FileSystemEnumerable<T>`-Transformation sind gerade deshalb schnell, weil sie die Kopie der Größe im Verzeichniseintrag wiederverwenden. Das ist die Kopie, die NTFS verzögert aktualisiert. Nutzen Sie die Enumeration, um Kandidatendateien zu finden, und fragen Sie dann jede relevante Datei einzeln ab:

```csharp
// .NET 10 / .NET 11, C# 14
foreach (FileInfo fi in new DirectoryInfo(inbox).EnumerateFiles("*.csv"))
{
    long listed = fi.Length;          // directory-entry copy on Windows, may be stale
    long live = GetLiveLength(fi.FullName);
    if (listed != live)
        Console.WriteLine($"{fi.Name}: listing says {listed:N0}, handle says {live:N0}");
}
```

Das Öffnen pro Datei kostet einige Metadaten-Roundtrips, weshalb der Explorer es nicht tut. Bei einem Ordner mit Tausenden Dateien fragen Sie nur die neuen oder kürzlich geänderten ab.

### 4. Wenn Sie den Schreiber kontrollieren: Flush aufrufen (und wissen, was Flush bedeutet)

Keine Technik auf Leserseite kann Bytes sehen, die den Prozess des Schreibers nie verlassen haben. Wenn ein Monitor den Fortschritt sehen soll, muss der Schreiber die Bytes an das Betriebssystem übergeben:

```csharp
// .NET 10 / .NET 11, C# 14
using var log = new StreamWriter(new FileStream(path, FileMode.Append,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
{
    AutoFlush = true    // every Write call pushes through StreamWriter and FileStream to the OS
};
```

`AutoFlush = true` kostet pro `Write` einen Systemaufruf. Für einen Logger mit hohem Volumen rufen Sie stattdessen `Flush()` per Timer oder nach jedem logischen Datensatz auf. `Flush()` (oder `Flush(false)` auf einem `FileStream`) übergibt die Bytes an den Cache des Betriebssystems, und das genügt, damit andere Prozesse die neue Größe sehen. `FileStream.Flush(flushToDisk: true)` erzwingt zusätzlich das Schreiben auf die physische Platte. Das dient der Dauerhaftigkeit, nicht der Sichtbarkeit, und ist deutlich langsamer.

### 5. Auf Netzwerkfreigaben den SMB-Client-Cache berücksichtigen

Ein `Refresh()` auf einem UNC-Pfad kann bis zu `FileInfoCacheLifetime` Sekunden (standardmäßig 10) aus dem Dateiinformations-Cache des SMB-Redirectors beantwortet werden. Ein geöffnetes Handle wie in Lösung 1 sendet eine Öffnungsanfrage an den Server und ist deshalb auch hier die bessere Wahl. Wenn Sie den Code nicht ändern können, lässt sich die Lebensdauer auf dem Client mit `Set-SmbClientConfiguration -FileInfoCacheLifetime 0` senken, das verlangsamt aber jede pfadbasierte Metadatenabfrage auf dem Rechner. Betrachten Sie das als Diagnose, nicht als Lösung.

## Stolperfallen und Verwechslungen

**"Die Datei ist fertig" ist eine andere Frage.** Eine stabile Größe ist kein Beweis, dass der Schreiber fertig ist. Er kann einfach pausieren. Wenn Sie eigentlich wissen müssen, ob Sie die Datei jetzt verarbeiten können, nutzen Sie das Muster "Umbenennen nach Abschluss" oder eine Probe mit exklusivem Öffnen aus [how to detect when a file finishes being written to in .NET](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/).

**Neue Bytes beim Eintreffen zu lesen** ist ebenfalls ein eigenes Problem. Halten Sie dafür einen einzigen `FileStream` mit geteiltem Lesezugriff offen und vergleichen Sie `fs.Length` mit `fs.Position`, wie in [how to tail a log file in C# while another process is writing to it](/de/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) gezeigt. Dieser Beitrag behandelt auch Abschneiden und Rotation, wo eine kleinere Größe "von vorn beginnen" bedeutet, nicht "veraltet".

**`LastWriteTime` ist auf dieselbe Weise veraltet.** Der Zeitstempel des Verzeichniseintrags wird genauso repliziert wie seine Größe, und `FileInfo` speichert ihn in derselben Struktur zwischen. Alles oben Gesagte gilt für `LastWriteTimeUtc`, und NTFS kann Zeitstempelaktualisierungen zusätzlich selbst verzögern. Erkennen Sie Wachstum nicht allein anhand eines Zeitstempels.

**Vorab allokierte Dateien.** Manche Schreiber (Datenbanken, Download-Manager, `FileStream` mit `preallocationSize`, `SetLength`-Aufrufe) erweitern die Datei vorab auf ihre Endgröße und füllen sie später. Das Handle meldet das echte End-of-File, und das ist bereits die Endgröße. Hier sagt "die Größe hat sich nicht geändert" nichts über den Fortschritt. Nutzen Sie das eigene Fortschrittssignal des Schreibers.

**Memory-Mapped-Schreiber.** Ein Schreiber, der die Datei mappt und über die Ansicht schreibt, ändert den Inhalt, ohne die Größe zu ändern, und das End-of-File wurde bei der Erstellung des Mappings festgelegt. Größenbasiertes Polling kann diese Schreibvorgänge überhaupt nicht erkennen.

**`IOException` beim Öffnen des Handles.** Hat der Schreiber die Datei mit `FileShare.None` geöffnet (der Standard bei `File.Create` / `File.OpenWrite`), ist kein anderes Öffnen erlaubt, auch nicht Ihres mit `FileShare.ReadWrite`. Dann können Sie nur die möglicherweise veraltete pfadbasierte Größe lesen oder den Schreiber ändern. Das Abfangen dieser Sharing Violation ist die Grundlage der Probe "wird noch geschrieben" im oben genannten verwandten Beitrag.

## Verwandte Beiträge

- [How to detect when a file finishes being written to in .NET](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) behandelt Stabilitäts-Polling, Proben mit exklusivem Öffnen und den Rename-Trick auf Produzentenseite.
- [How to tail a log file in C# while another process is writing to it](/de/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) ist der handlebasierte Leser in voller Länge, inklusive Rotationsbehandlung.
- [How to read a large CSV in .NET 11 without running out of memory](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) ist nützlich, sobald die Datei vollständig ist und Sie sie verarbeiten müssen.
- [How to run a file-based C# app with dotnet run in .NET 11](/de/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) erklärt die im obigen Probe-Programm verwendeten `#:property`-Direktiven.

## Quellen

- Raymond Chen, [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), The Old New Thing.
- [`FileInfo.Length` property](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) und [`FileSystemInfo.Refresh`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.refresh), Microsoft Learn.
- [`RandomAccess.GetLength`](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.getlength) und [`File.OpenHandle`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.openhandle), Microsoft Learn.
- dotnet/runtime-Quellcode: [`FileSystem.Attributes.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Common/src/System/IO/FileSystem.Attributes.Windows.cs) (`FillAttributeInfo`), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs) (`Init` aus `FILE_FULL_DIR_INFORMATION`), [`FileSystemEnumerator.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/Enumeration/FileSystemEnumerator.Windows.cs) (`NtQueryDirectoryFile`).
- [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server), SMB-Client `FileInfoCacheLifetime` und `DirectoryCacheLifetime`.
