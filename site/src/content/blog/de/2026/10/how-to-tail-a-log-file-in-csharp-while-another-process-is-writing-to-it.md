---
title: "Eine Log-Datei in C# mitlesen (tail), während ein anderer Prozess noch hineinschreibt"
description: "Öffnen Sie das Log mit FileShare.ReadWrite | FileShare.Delete, springen Sie ans Ende, fragen Sie per Polling neue Bytes ab, dekodieren Sie diese mit einem eigenen UTF-8-Decoder statt mit StreamReader und behandeln Sie Kürzung und Rotation explizit. Eine getestete tail -F-Implementierung für .NET 10 und .NET 11."
pubDate: 2026-10-11
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "file-io"
  - "logging"
  - "async"
lang: "de"
translationOf: "2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it"
translatedBy: "claude"
translationDate: 2026-10-11
---

Um eine Log-Datei zu lesen, die ein anderer Prozess noch zum Schreiben geöffnet hat, öffnen Sie sie mit `new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)`. `FileShare.ReadWrite` verhindert die `IOException: The process cannot access the file because it is being used by another process`, denn der Schreiber hält bereits Schreibzugriff, und Ihr Share-Modus muss ihn erlauben. `FileShare.Delete` erlaubt dem Schreiber, die Datei bei der Log-Rotation umzubenennen oder zu löschen, ohne dass dies fehlschlägt. Springen Sie danach ans Ende, fragen Sie per Timer neue Bytes ab und geben Sie Text nur bis zum letzten `\n` aus. Lesen Sie die Bytes nicht über `StreamReader`: Am Dateiende leert er seinen Decoder und beschädigt damit jedes UTF-8-Zeichen aus mehreren Bytes, das der Schreiber erst zur Hälfte geschrieben hat. Prüfen Sie schließlich bei jedem Erreichen von EOF auf Kürzung (`fs.Length < fs.Position`) und auf Rotation (der Pfad bezeichnet nun eine andere Datei). Alles Folgende wurde unter macOS mit .NET 10.0.10 (SDK 10.0.302) und .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128) ausgeführt; die Windows-Freigaberegeln stammen aus dem Runtime-Quellcode und dem Win32-Vertrag.

## Warum File.ReadAllText bei einer aktiven Log-Datei eine Ausnahme auslöst

Jedes Öffnen unter Windows trägt zwei Angaben: den gewünschten Zugriff (`FileAccess`) und den Zugriff, den Sie anderen gleichzeitig gestatten (`FileShare`). Ein zweites Öffnen gelingt nur, wenn beide Seiten zustimmen: Ihr angeforderter Zugriff muss vom Share-Modus jedes bestehenden Handles erlaubt sein, und der Zugriff jedes bestehenden Handles muss von Ihrem Share-Modus erlaubt sein.

Logger öffnen ihre Datei fast immer so. Hier ist die Zeile aus [`FileSink` von Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs) bei `shared: false` (dem Standard):

```csharp
// Serilog.Sinks.File, non-shared mode
System.IO.File.Open(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
```

Der Schreiber hält `FileAccess.Write` und erlaubt anderen das Lesen. Nun zu den Komfort-APIs. `File.ReadAllText`, `File.ReadAllLines`, `File.ReadLines` und `new StreamReader(path)` landen alle im selben Helfer in [`StreamReader.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs):

```csharp
// dotnet/runtime, StreamReader path constructor
new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileStream.DefaultBufferSize);
```

`FileShare.Read` bedeutet "niemand sonst darf schreiben, solange ich die Datei geöffnet habe". Aber jemand schreibt bereits, daher verweigert Windows das Öffnen mit `ERROR_SHARING_VIOLATION` (Win32-Fehler 32, HResult `0x80070020`), und .NET meldet dies als `IOException: The process cannot access the file 'app.log' because it is being used by another process.` Die Lösung ist keine Wiederholungsschleife. Die Lösung ist, einen Share-Modus anzufordern, der den Schreiber toleriert:

```csharp
// .NET 10 / .NET 11, C# 14
using var fs = new FileStream(
    "app.log",
    FileMode.Open,
    FileAccess.Read,
    FileShare.ReadWrite | FileShare.Delete);
```

Hat der Schreiber die Datei mit `FileShare.None` geöffnet, hilft kein Share-Modus auf Ihrer Seite. Dieser Schreiber hat exklusiven Zugriff verlangt, und Sie können nur warten, bis er das Handle schließt.

### Was sich unter Linux und macOS ändert

Unix kennt keine verpflichtenden Share-Modi, daher emuliert .NET sie. Seit .NET 6 setzt [`SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs) ein beratendes `flock`: `LOCK_EX` bei `FileShare.None`, `LOCK_SH` bei jedem anderen Share-Wert. Zwei Folgen, die ich beide unter macOS mit .NET 10.0.10 reproduziert habe:

1. `File.ReadAllText` auf eine Datei, die ein .NET-Schreiber mit `FileShare.Read` hält, gelingt unter Unix. Code, der "auf meinem Mac funktioniert", kann in Produktion unter Windows dennoch eine Ausnahme auslösen.
2. Ein .NET-Schreiber, der die Datei mit `FileShare.None` öffnen will, während Ihr Tailer sie geöffnet hat, scheitert mit `IOException` (HResult `0x23` unter macOS), weil Ihre geteilte Sperre seine exklusive blockiert. Nicht-.NET-Schreiber beteiligen sich überhaupt nicht an `flock`.

Die Sperre lässt sich mit dem Runtime-Schalter `System.IO.DisableFileLocking` abschalten (Umgebungsvariable `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1`), was manche Teams auf NFS-Mounts ohne Lock-Daemon benötigen. `FileShare.ReadWrite | FileShare.Delete` zu übergeben bleibt auch unter Unix richtig: Es dokumentiert die Absicht und verhält sich unter Windows identisch.

## Die zwei Fehler einer naiven Tail-Schleife

Sobald das Öffnen funktioniert, ist die naheliegende Implementierung ein `StreamReader` mit einer Schleife um `ReadLine()`. `StreamReader` merkt sich das Dateiende nicht dauerhaft; hängt der Schreiber weitere Daten an, liefert das nächste `ReadLine` sie also. Das ist in Ordnung. Zwei andere Dinge sind es nicht.

Erstens: unvollständige Zeilen. Hat der Schreiber `"line1\npart"` geschrieben und Sie rufen `ReadLine()` zweimal auf, erhalten Sie `"line1"` und dann `"part"`. Hängt der Schreiber später `"ial2\n"` an, erhalten Sie `"ial2"`. Aus einer Log-Zeile sind nun zwei Datensätze geworden. Ich habe genau diese Abfolge ausgeführt und `[line1] [part]` erhalten, nach dem Anhängen dann `[ial2]`.

Zweitens, und weit weniger bekannt: geteilte Zeichen. `StreamReader` übergibt Bytes an einen UTF-8-`Decoder`, der die ersten Bytes eines Mehrbyte-Zeichens zurückhalten kann, bis der Rest eintrifft. Liefert der zugrunde liegende Stream jedoch 0 Bytes, wertet `StreamReader` das als Ende des Streams und ruft `_decoder.GetChars(..., flush: true)` auf. Ein geleerter Decoder macht aus jeder unvollständigen Sequenz ein `U+FFFD`. In einer wachsenden Datei bedeutet "Ende des Streams" nur "der Schreiber ist noch nicht so weit". Dieses Beispiel schreibt `"żółć\n"` in zwei Teilen und trennt `ó` nach seinem ersten Byte:

```csharp
// .NET 10 / .NET 11, C# 14
using System.Text;

var path = Path.GetTempFileName();
var bytes = Encoding.UTF8.GetBytes("żółć\n");

using var writer = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
using var reader = new StreamReader(fs, Encoding.UTF8);

var buf = new char[100];
var sb = new StringBuilder();
void Drain() { int n; while ((n = reader.Read(buf, 0, buf.Length)) > 0) sb.Append(buf, 0, n); }

writer.Write(bytes, 0, 3); writer.Flush(); Drain();               // "ż" + first byte of "ó"
writer.Write(bytes, 3, bytes.Length - 3); writer.Flush(); Drain();
Console.WriteLine(sb.ToString()); // prints "ż��łć"
```

Die Ausgabe ist `ż��łć` unter .NET 10.0.10 und .NET 11 RC1, sowohl mit `Read` als auch mit `ReadAsync`. Logs voller nicht-ASCII-Benutzernamen, Dateipfade oder Meldungen laufen genau dann in dieses Problem, wenn ein Schreiber mitten im Zeichen flusht, was gepufferte Schreiber immer dann tun, wenn ihre Puffergrenze in ein Zeichen fällt.

Die Lösung für beide Probleme ist dieselbe: Lesen Sie die Bytes selbst aus dem `FileStream`, dekodieren Sie sie mit einem eigenen `Decoder` und `flush: false`, und halten Sie den Text nach dem letzten Zeilenumbruch in einem Puffer, bis der Rest der Zeile eintrifft.

## Eine tail -F-Implementierung, die Rotation übersteht

Hier der vollständige Helfer. Er stellt den Zeilenstrom als `IAsyncEnumerable<string>` bereit, sodass Aufrufer `await foreach` schreiben und per Token abbrechen.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Runtime.CompilerServices;
using System.Text;

public static class LogTail
{
    public static async IAsyncEnumerable<string> FollowAsync(
        string path,
        bool fromStart = false,
        TimeSpan? pollInterval = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var interval = pollInterval ?? TimeSpan.FromMilliseconds(250);
        var bytes = new byte[16 * 1024];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        var decoder = Encoding.UTF8.GetDecoder();
        var pending = new StringBuilder();
        FileStream? fs = null;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (fs is null)
                {
                    fs = TryOpen(path);
                    if (fs is null)
                    {
                        await Task.Delay(interval, ct);
                        continue;
                    }
                    if (!fromStart) fs.Seek(0, SeekOrigin.End);
                    fromStart = true; // a rotated-in file is read from the top
                    decoder.Reset();
                    pending.Clear();
                }

                int read = await fs.ReadAsync(bytes, ct);
                if (read > 0)
                {
                    // flush: false keeps a half-written multi-byte character
                    // inside the decoder until the rest of it arrives.
                    int n = decoder.GetChars(bytes, 0, read, chars, 0, flush: false);
                    pending.Append(chars, 0, n);
                    foreach (var line in DrainCompleteLines(pending))
                        yield return line;
                    continue;
                }

                // At EOF. Truncated in place (copytruncate)?
                if (fs.Length < fs.Position)
                {
                    fs.Seek(0, SeekOrigin.Begin);
                    decoder.Reset();
                    pending.Clear();
                    continue;
                }

                // Path now points at a different file (rename-and-recreate)?
                if (WasReplaced(path, fs))
                {
                    await fs.DisposeAsync();
                    fs = null;
                    continue;
                }

                await Task.Delay(interval, ct);
            }
        }
        finally
        {
            if (fs is not null) await fs.DisposeAsync();
        }
    }

    static FileStream? TryOpen(string path)
    {
        try
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 0, FileOptions.Asynchronous);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; } // writer holds FileShare.None right now
    }

    static IEnumerable<string> DrainCompleteLines(StringBuilder pending)
    {
        int start = 0;
        for (int i = 0; i < pending.Length; i++)
        {
            if (pending[i] != '\n') continue;
            int end = i > start && pending[i - 1] == '\r' ? i - 1 : i;
            yield return pending.ToString(start, end - start);
            start = i + 1;
        }
        pending.Remove(0, start);
    }

    static bool WasReplaced(string path, FileStream current)
    {
        // Measure the path through a fresh handle, not FileInfo, and do it
        // before reading the current handle's length.
        using var probe = TryOpen(path);
        if (probe is null) return false; // rotated, new file not created yet
        long pathLength = probe.Length;
        // Same append-only file: pathLength == current.Position (we are at EOF)
        // or current.Length grew past it in the meantime. Anything else means
        // the name now belongs to another file.
        return pathLength < current.Position || pathLength > current.Length;
    }
}
```

Die Verwendung in einer Konsolen-App oder einem `BackgroundService` sieht so aus:

```csharp
// .NET 10 / .NET 11, C# 14
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

try
{
    await foreach (var line in LogTail.FollowAsync("/var/log/myapp/app.log", ct: cts.Token))
        Console.WriteLine(line);
}
catch (OperationCanceledException) { }
```

Ich habe ihn gegen einen zweiten Prozess getestet, der Zeilen in zwei Teilen schrieb (getrennt innerhalb eines Zwei-Byte-Zeichens, mit Flushes und 120 ms Pause dazwischen), dann die Datei in `app.log.1` umbenannte und eine neue anlegte, diese anschließend kürzte und weiterschrieb. Der Tailer gab jede Zeile unversehrt aus, ohne Ersatzzeichen, folgte der Umbenennung zur neuen Datei und begann nach der Kürzung wieder von vorn, sowohl unter .NET 10.0.10 als auch unter .NET 11 RC1.

## Wofür jedes Teil gut ist

Der Reihe nach tut die Schleife fünf Dinge:

1. **Öffnet mit `FileShare.ReadWrite | FileShare.Delete`.** `ReadWrite` toleriert den Schreiber. `Delete` ist unter Windows für die Rotation wichtig: Logger, die archivieren, indem sie `app.log` in `app.log.1` umbenennen, rufen `MoveFile` auf, und das scheitert mit einer Sharing Violation, wenn irgendein offenes Handle `FILE_SHARE_DELETE` nicht erlaubt. Ohne diesen Wert bricht Ihr Tailer die Log-Rotation der Anwendung, was ein weit schlimmerer Fehler ist als eine verpasste Zeile.
2. **Springt beim ersten Öffnen ans Ende.** Das entspricht der Semantik von `tail -f`: Es zeigt, was ab jetzt geschieht. Übergeben Sie `fromStart: true`, um die ganze Datei abzuspielen. Nach einer Rotation liest der Helfer die neue Datei immer von Anfang an, weil alles darin neu ist.
3. **Fragt per `Task.Delay` ab.** Ein Poll alle 250 ms am EOF ist ein `read`-Syscall, der 0 liefert, plus ein `open` und `fstat` für die Rotationsprüfung. Das ist vernachlässigbar. `FileSystemWatcher` wirkt verlockend, funktioniert aber auf vielen Netzwerkfreigaben und Container-Bind-Mounts nicht, sein interner Puffer läuft bei Lastspitzen über und verliert Ereignisse, und die `Changed`-Benachrichtigungen eines anhängenden Schreibers werden vom Betriebssystem zusammengefasst und verzögert. Nutzen Sie ihn, wenn überhaupt, als Hinweis, der die Wartezeit verkürzt, nie als einzigen Auslöser.
4. **Dekodiert mit `flush: false` und puffert unvollständige Zeilen.** `DrainCompleteLines` liefert nur Text, der mit `\n` abgeschlossen ist, entfernt ein abschließendes `\r`, damit CRLF-Logs sauber ausgegeben werden, und lässt den unvollständigen Rest in `pending`.
5. **Prüft Kürzung und Rotation nur am EOF.** Solange Bytes zu lesen sind, spielt nichts anderes eine Rolle. Gibt es keine mehr, erkennt das Handle-basierte `fs.Length < fs.Position` ein `copytruncate`, und `WasReplaced` erkennt Umbenennen-und-neu-Anlegen.

### Warum die Rotation eine eigene Prüfung braucht

Wenn `logrotate` (oder die Archivierung von NLog oder Ihr eigener Code) `app.log` umbenennt und eine frische Datei anlegt, folgt Ihr Handle dem Namen nicht. Handles zeigen auf Dateien, nicht auf Pfade: Sowohl unter Unix als auch unter Windows mit `FILE_SHARE_DELETE` liest das alte Handle weiter die umbenannte Datei, die nie wieder wachsen wird. Der Tailer würde ewig am EOF stehen, während die Anwendung munter in die neue `app.log` schreibt.

`WasReplaced` öffnet den Pfad erneut und vergleicht Längen. Bei einem reinen Anhänge-Log gilt: Bezeichnet der Pfad noch die Datei, die Sie lesen, ist seine Länge gleich Ihrer Position (Sie stehen am EOF), oder der Schreiber hat inzwischen angehängt; dann ist `current.Length` mindestens ebenso groß, weil es danach gelesen wird. Eine Pfadlänge unter Ihrer Position oder über der Länge Ihres Handles bedeutet eine andere Datei. Ich messe über ein frisches Handle statt über `FileInfo.Length`, weil unter Windows Größenangaben aus dem Verzeichniseintrag einer noch zum Schreiben geöffneten Datei hinterherhinken können.

Die Prüfung hat einen blinden Fleck: eine neue Datei, die bei jeder Prüfung exakt dieselbe Länge wie die alte hat. Dieses Fenster schließt sich, sobald die neue Datei wächst. Wenn Sie lückenlose Identität brauchen, vergleichen Sie die Datei-ID (`GetFileInformationByHandle` unter Windows, `st_dev` plus `st_ino` aus `fstat` unter Unix) per P/Invoke. .NET stellt beides ab .NET 11 nicht öffentlich bereit.

## Zuerst nur die letzten N Zeilen lesen

`tail -n 50 -f` zeigt vor dem Mitlesen den jüngsten Kontext. Eine 2 GB große Datei zu lesen, um ihre letzten 50 Zeilen zu finden, ist verschwenderisch; lesen Sie stattdessen ein Fenster vom Ende:

```csharp
// .NET 10 / .NET 11, C# 14
public static async Task<IReadOnlyList<string>> ReadLastLinesAsync(
    string path, int count, int maxBytes = 64 * 1024)
{
    await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    long start = Math.Max(0, fs.Length - maxBytes);
    fs.Seek(start, SeekOrigin.Begin);
    using var reader = new StreamReader(fs, Encoding.UTF8);
    var lines = new Queue<string>(count + 1);
    bool skipFirst = start > 0; // we probably landed mid-line
    string? line;
    while ((line = await reader.ReadLineAsync()) is not null)
    {
        if (skipFirst) { skipFirst = false; continue; }
        lines.Enqueue(line);
        if (lines.Count > count) lines.Dequeue();
    }
    return lines.ToArray();
}
```

Hier ist `StreamReader` unproblematisch, weil es sich um ein einmaliges Lesen handelt: Unvollständige Daten gibt es nur ganz am Anfang (wird übersprungen) und möglicherweise in der letzten Zeile, die Sie unverändert anzeigen können. Ein Sprung in die Dateimitte kann mitten in einer UTF-8-Sequenz landen, was ein weiterer Grund ist, die erste Zeile zu verwerfen. Enthalten 64 KB nicht `count` Zeilen, verdoppeln Sie `maxBytes` und versuchen es erneut. Rufen Sie die Methode auf, geben Sie das Ergebnis aus und starten Sie dann `FollowAsync` mit `fromStart: false`. Einige zwischen den beiden Aufrufen geschriebene Zeilen können verloren gehen; falls das stört, lassen Sie `ReadLastLinesAsync` den Offset zurückgeben, an dem es aufgehört hat, und folgen Sie ab dort.

## Stolperfallen, für die der Leser nichts kann

**Der Schreiber muss flushen.** Sie sehen nur, was das Betriebssystem erreicht hat. Der Datei-Sink von Serilog hat standardmäßig `buffered: false`, und das Datei-Target von NLog hat standardmäßig `autoFlush="true"`, aber ein `StreamWriter` mit `AutoFlush = false` hält bis zur Puffergröße im Speicher. Viele Meldungen der Art "der Tailer verpasst die letzten Zeilen" gehen auf einen Schreiber zurück, der noch nicht geflusht hat.

**`copytruncate` verliert Daten, per Design.** In meinem Test kürzte der Schreiber die Datei 120 ms nach seinem letzten Schreibvorgang, und der Tailer, der alle 250 ms abfragt, sah diese Zeile nie. Die Dokumentation von `logrotate` warnt selbst, dass zwischen Kopieren und Kürzen geschriebene Zeilen verloren gehen. Bevorzugen Sie eine umbenennungsbasierte Rotation (`create`) mit einer Anwendung, die ihre Datei neu öffnet, oder halten Sie das Poll-Intervall kurz.

**Öffnen Sie nicht mit `FileAccess.ReadWrite`.** Manche Snippets im Netz tun das, vermutlich um dem Schreiber zu "entsprechen". Sie brauchen nur Lesezugriff, und unter Windows scheitert die Anforderung von Schreibzugriff, wenn der Schreiber mit `FileShare.Read` geöffnet hat.

**Kodierung und BOMs.** Der Helfer setzt UTF-8 voraus, was Serilog, NLog, die Konsolenumleitung von Microsoft.Extensions.Logging und fast jedes Unix-Werkzeug schreiben. Wenn Sie UTF-16-Logs verfolgen, tauschen Sie den `Decoder` aus, und wenn Sie mit `fromStart: true` eine Datei abspielen, die mit einem UTF-8-BOM beginnt, entfernen Sie `'\uFEFF'` aus der ersten Zeile.

**Sehr lange Zeilen.** `pending` wächst, bis ein Zeilenumbruch eintrifft. Kann ein Schreiber unbegrenzt lange Zeilen ausgeben (Binärmüll, ein minifizierter JSON-Blob), begrenzen Sie `pending.Length` und geben Sie den bisherigen Inhalt aus oder verwerfen Sie ihn, sobald die Grenze überschritten ist.

**Mehrere Schreiber.** Serilogs `shared: true` und mehrere Prozesse, die an eine Datei anhängen, funktionieren nur, weil jeder Schreibvorgang atomar am Dateiende erfolgt. Dem Tailer ist die Zahl der Schreiber gleichgültig, aber die Verschränkung ihrer Teilschreibvorgänge ist das Problem der Schreiber, nicht Ihres.

## Weiterführende Artikel

- Lautet die Frage nicht "was wurde angehängt", sondern "ist diese Datei fertig", siehe [wie man erkennt, dass eine Datei fertig geschrieben ist, in .NET](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/); der Artikel behandelt das Testen mit `FileShare.None` und die Größenstabilisierung.
- `FollowAsync` ist ein asynchroner Stream. [Was `IAsyncEnumerable` ist und wann man es einsetzt](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) erklärt, warum `[EnumeratorCancellation]` am Token-Parameter steht.
- Um den Tail aus einem gehosteten Dienst sauber zu beenden, [reichen Sie den `CancellationToken` durch die asynchrone Aufrufkette weiter](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- Wenn Sie Zeilen auf mehrere Verbraucher verteilen wollen, setzen Sie einen [`Channel<T>` zwischen Tailer und Verarbeiter](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).
- Für die Schreiberseite zeigt [strukturiertes Logging mit Serilog und Seq in .NET 11](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) die Datei-Sink-Konfiguration, aus der dieser Artikel liest.

## Quellen

- [`StreamReader.cs` in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs): der Pfad-Konstruktor mit `FileShare.Read` und die Dekodierung mit `flush: true` am Stream-Ende.
- [`SafeFileHandle.Unix.cs` in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs): `LOCK_SH`-/`LOCK_EX`-Emulation von `FileShare` und der Schalter `System.IO.DisableFileLocking`.
- [`FileSink.cs` in serilog-sinks-file](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs): wie Serilog seine Log-Datei öffnet.
- [`FileShare`-Enum auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare).
- [`Decoder.GetChars` auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.text.decoder.getchars), einschließlich des Parameters `flush`.
- [dotnet/runtime Issue 48757](https://github.com/dotnet/runtime/issues/48757): Dateisperren auf NFS und `DOTNET_SYSTEM_IO_DISABLEFILELOCKING`.
