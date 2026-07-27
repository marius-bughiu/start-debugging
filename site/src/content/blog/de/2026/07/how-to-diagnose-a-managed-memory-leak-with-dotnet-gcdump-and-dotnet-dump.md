---
title: "Wie Sie ein Speicherleck im verwalteten Heap mit dotnet-gcdump und dotnet-dump diagnostizieren"
description: "Ein vollständiger Arbeitsablauf, um ein Speicherleck im verwalteten Heap unter .NET 11 zu finden: Wachstum mit dotnet-counters bestätigen, zwei gcdumps aufnehmen und vergleichen, dann einen Dump sammeln und mit dumpheap, gcroot und objsize in dotnet-dump analyze herausfinden, was die Referenz noch hält."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "diagnostics"
  - "memory"
  - "performance"
lang: "de"
translationOf: "2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump"
translatedBy: "claude"
translationDate: 2026-07-27
---

Um ein Speicherleck im verwalteten Heap unter .NET zu diagnostizieren, bestätigen Sie zuerst mit `dotnet-counters monitor`, dass das Wachstum real ist, erfassen dann zwei `dotnet-gcdump collect`-Momentaufnahmen im Abstand von einigen Minuten, um zu sehen, welche Typanzahl steigt, und nehmen anschließend einen `dotnet-dump collect` auf, um innerhalb von `dotnet-dump analyze` mit `dumpheap -stat`, `dumpheap -type <Name>` und `gcroot <address>` die Referenzkette zu finden, die diese Objekte am Leben hält. Der gcdump sagt Ihnen *was* wächst, praktisch ohne Overhead; der Dump sagt Ihnen, *wer es hält*. Sie brauchen beides, in dieser Reihenfolge. Dieser Artikel verwendet `dotnet-gcdump` und `dotnet-dump` 10.0 unter .NET 11 (zum Zeitpunkt des Schreibens Preview 6, GA im November 2026), aber jeder Befehl hier ist seit .NET Core 3.1 stabil.

## Warum die Garbage Collection Sie hier nicht rettet

Ein Speicherleck im verwalteten Heap ist kein Leck im Sinne von C. Nichts bleibt unfreigegeben. Die Garbage Collection arbeitet genau wie vorgesehen: Sie sammelt kein Objekt ein, das von einer Wurzel aus erreichbar ist, und Ihr Code hat versehentlich einige hunderttausend Objekte erreichbar gemacht. Eine Wurzel ist ein statisches Feld, eine lebende lokale Variable oder ein Argument auf dem Stack eines Threads, ein starkes GC-Handle oder die Finalizer-Warteschlange. Alles andere ist von dort aus transitiv erreichbar.

Damit lautet die Diagnosefrage nie "warum lief die GC nicht?". Sie lautet "welche Wurzelkette zeigt noch auf dieses Objekt?". Alle Werkzeuge unten existieren, um genau diese eine Frage zu beantworten. Die klassischen Verursacher in einer ASP.NET Core-Anwendung:

- Eine statische oder Singleton-Sammlung, die nur wächst: ein `ConcurrentDictionary` als Cache ohne Verdrängung, eine `List<T>` mit "letzten Anfragen".
- Ein Ereignis-Abonnement, das nie abbestellt wird. Der Publisher hält ein Delegate, das Delegate hält den Abonnenten, und wenn der Publisher ein Singleton oder statisch ist, lebt jeder Abonnent ewig.
- Ein Scoped Service, der von einem Singleton festgehalten wird und den gesamten Objektgraphen des Scopes mitschleppt. Das zeigt sich meist zuerst als [eine ObjectDisposedException auf einem bereits freigegebenen DbContext](/de/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/), denn dieses Festhalten ist zugleich [ein Lebensdauerfehler beim Auflösen eines Scoped Service aus einem Singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- Ein `Timer` oder eine langlebige `CancellationTokenSource`-Registrierung, deren Callback einen großen Objektgraphen einschließt.

## Schritt 0: Beweisen Sie, dass es überhaupt ein Leck gibt

Sammeln Sie nichts, bevor Sie den verwalteten Heap über die Zeit haben wachsen sehen. Wachstum des Working Sets allein ist kein Leck im verwalteten Heap; es kann native Allokation sein, Fragmentierung, oder schlicht die GC, die dem Betriebssystem keinen Speicher zurückgibt, weil nichts Druck ausübt.

Installieren Sie die Werkzeuge einmalig und ermitteln Sie die PID:

```bash
# Verified with the .NET 11 SDK, July 2026
dotnet tool install --global dotnet-counters
dotnet tool install --global dotnet-gcdump
dotnet tool install --global dotnet-dump

dotnet-counters ps
# 4807  MyApi  /srv/myapi/MyApi
```

Beobachten Sie dann den Heap, nicht den Prozess:

```bash
dotnet-counters monitor --refresh-interval 5 --process-id 4807 \
  --counters System.Runtime[dotnet.gc.last_collection.heap.size,dotnet.process.memory.working_set]
```

Ab .NET 9 ist `System.Runtime` ein `Meter`, und die Zählernamen sind die oben gezeigten im OpenTelemetry-Stil. Unter .NET 8 und älter fällt `dotnet-counters` auf die alten EventCounters zurück, und der gesuchte Wert heißt dort `GC Heap Size (MB)`.

Entscheidend ist `dotnet.gc.last_collection.heap.size`, aufgeschlüsselt nach Generation. Zwei Messwerte sagen Ihnen, womit Sie es zu tun haben:

- **gen2 steigt über die Sammlungen hinweg monoton**: ein echtes Leck im verwalteten Heap. Objekte überleben bis in die älteste Generation und sterben nie. Lesen Sie weiter.
- **gen0/gen1 mit viel Bewegung, gen2 flach, Working Set hoch**: kein Leck. Das ist Allokationsdruck oder Fragmentierung. Greifen Sie stattdessen zu [dotnet-trace mit dem Profil gc-verbose](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/), um den Allokations-Hotspot zu finden.
- **Heap-Größe flach, aber Working Set steigt**: Das Leck ist nativ. gcdump und SOS zeigen Ihnen nichts Brauchbares. Prüfen Sie native Interop-Aufrufe, `SafeHandle`-Lebensdauern oder einen LOH, der zwar committet, aber nicht wieder freigegeben wird.

## Ein minimales Beispiel, das leckt

Dies ist der kleinste ASP.NET Core-Dienst, der auf eine Weise leckt, die beide Werkzeuge finden können. Es ist ein Singleton, das ein Ereignis eines anderen Singletons abonniert und nie abbestellt:

```csharp
// .NET 11, C# 14
public sealed class TelemetryBus
{
    public event EventHandler<string>? MetricRecorded;
    public void Record(string metric) => MetricRecorded?.Invoke(this, metric);
}

public sealed class ReportSession
{
    private readonly byte[] _buffer = new byte[64 * 1024];
    private readonly List<string> _log = [];

    public ReportSession(TelemetryBus bus)
    {
        // Nothing ever removes this handler, so `bus` roots every ReportSession
        // ever created, and each one roots 64 KB plus a growing List<string>.
        bus.MetricRecorded += OnMetric;
    }

    private void OnMetric(object? sender, string metric) => _log.Add(metric);
}

app.MapPost("/reports", (TelemetryBus bus) =>
{
    _ = new ReportSession(bus);   // per-request, never released
    return Results.Accepted();
});
```

`TelemetryBus` ist ein Singleton, seine Aufrufliste ist also für die gesamte Prozesslebensdauer verwurzelt. Jede `ReportSession` ist von diesem Delegate aus erreichbar, also auch jedes `byte[64*1024]`. Lasten Sie `/reports` aus, und der gen2-Heap wächst endlos.

## Der vollständige Ablauf

1. **Bestätigen Sie, dass der verwaltete Heap wächst**, mit `dotnet-counters monitor --counters System.Runtime[dotnet.gc.last_collection.heap.size]`, mit Blick speziell auf gen2.
2. **Erfassen Sie einen Referenz-gcdump** mit `dotnet-gcdump collect --process-id <PID> --output baseline.gcdump`.
3. **Lassen Sie die Anwendung unter Last laufen**, lange genug, damit das Leck eindeutig ist, typischerweise fünf bis fünfzehn Minuten.
4. **Erfassen Sie einen zweiten gcdump** mit `dotnet-gcdump collect --process-id <PID> --output after.gcdump` und vergleichen Sie die Typanzahlen beider Dateien, um den wachsenden Typ zu finden.
5. **Sammeln Sie einen vollständigen Dump** mit `dotnet-dump collect --process-id <PID> --type Heap --output leak.dmp`, sobald Sie wissen, wonach Sie suchen.
6. **Öffnen Sie ihn** mit `dotnet-dump analyze leak.dmp` und bestätigen Sie den Typ mit `dumpheap -stat` oder `dumpheap -type <TypeName> -stat`.
7. **Holen Sie sich die Adresse einer Instanz** aus `dumpheap -type <TypeName>` und führen Sie `gcroot <address>` aus, um die Referenzkette von einer Wurzel bis zu diesem Objekt auszugeben.
8. **Reparieren Sie die Kette**, nicht das Objekt. Der letzte Sprung vor Ihrem Typ in der `gcroot`-Ausgabe ist dasjenige, das die Referenz hält.

## Schritte 2 bis 4: gcdump, der günstige erste Blick

`dotnet-gcdump` schreibt keinen Prozess-Dump. Es erzwingt eine gen2-Sammlung, aktiviert Ereignisse zum Überleben von Heap-Objekten und rekonstruiert den Objektgraphen aus dem [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)-Strom. Das Ergebnis ist eine `.gcdump`-Datei mit Typen, Anzahlen, Größen und Kanten, aber ohne Feldwerte und ohne Thread-Stacks. Sie ist typischerweise einstellig megabytegroß, wo ein vollständiger Dump desselben Prozesses hunderte belegt.

```bash
dotnet-gcdump collect --process-id 4807 --output baseline.gcdump
# Writing gcdump to './baseline.gcdump'...
#     Finished writing 5763432 bytes.

# ... let it run under load ...

dotnet-gcdump collect --process-id 4807 --output after.gcdump
```

Für den Vergleich brauchen Sie keine grafische Oberfläche. Das Verb `report` gibt eine Heap-Statistiktabelle direkt auf stdout aus, was unter Linux funktioniert, wo nichts eine `.gcdump`-Datei öffnen kann:

```bash
dotnet-gcdump report ./after.gcdump
#           Size (Bytes) Count       Type
#         ============== =====       ====
#          1,603,588,000 22,000,000  System.String
#            201,096,000  2,010,000  System.Byte[]
#             25,000,000    250,000  MyApi.Reports.ReportSession
```

Führen Sie `report` gegen beide Dateien aus und vergleichen Sie die Anzahlen. Unter Windows können Sie beide `.gcdump`-Dateien gleichzeitig in Visual Studio öffnen und erhalten eine echte Gegenüberstellung mit Differenzspalte, was den Umweg wert ist, wenn ein Windows-Rechner in Reichweite steht. PerfView liest sie ebenfalls. Derzeit gibt es keine Möglichkeit, eine `.gcdump` unter Linux oder macOS zu öffnen, dort ist `dotnet-gcdump report` also die einzige Option.

`report` akzeptiert auch direkt `--process-id`, sammelt und druckt also in einem Zug, wenn Sie die Datei nicht brauchen:

```bash
dotnet-gcdump report --process-id 4807
```

Am Ende dieses Schritts sollten Sie einen Typnamen haben. Mehr schuldet Ihnen gcdump nicht.

## Schritte 5 bis 7: dotnet-dump, wo Sie die Wurzel finden

Ein gcdump kann Ihnen nicht sagen, welches *Feld* welches *Objekts* die Referenz hält, und er kann keine Thread-Stacks zeigen. Dafür brauchen Sie einen echten Dump und SOS.

```bash
dotnet-dump collect --process-id 4807 --type Heap --output leak.dmp
```

`--type` steht standardmäßig auf `Full` und schließt gemappte Modul-Images ein, was meist deutlich mehr ist als nötig. `Heap` liefert Modullisten, Thread-Listen, alle Stacks, Ausnahme- und Handle-Informationen sowie den gesamten Speicher außer den gemappten Images, und deckt damit alles in diesem Ablauf ab. Nutzen Sie `Mini` nur zur Absturz-Triage; es enthält den GC-Heap nicht.

Öffnen Sie danach die interaktive SOS-Shell:

```bash
dotnet-dump analyze leak.dmp
```

Beginnen Sie mit der statistischen Sicht. Ergänzen Sie `-live`, damit die Markierungsphase der GC genutzt wird, um bereits toten, aber noch nicht eingesammelten Objekten auszuschließen. Das entfernt viel Rauschen:

```console
> dumpheap -stat -live

Statistics:
              MT    Count    TotalSize Class Name
00007f6c1dc014c0      467       416464 System.Byte[]
00007f6c20a67498   250000     16000000 MyApi.Reports.ReportSession
00007f6c1dc00f90   206770     19494060 System.String
```

Nützliche Varianten desselben Befehls:

- `dumpheap -stat -bycount` sortiert nach Instanzanzahl statt nach Gesamtgröße und bringt damit Lecks nach dem Muster "eine Million winziger Objekte" ans Licht, die Byte-Summen verstecken.
- `dumpheap -type MyApi.Reports -stat` filtert über eine Teilzeichenfolge des Typnamens, sodass Sie die Tabelle auf einen Namespace eingrenzen und das Rauschen des Frameworks ausblenden.
- `dumpheap -gen loh -stat` beschränkt auf den Large Object Heap. Akzeptiert `gen0`, `gen1`, `gen2`, `loh`, `poh` und `foh`.
- `dumpheap -min 100000 -stat` ignoriert alles unter 100.000 Bytes.

Holen Sie sich jetzt eine konkrete Adresse und suchen Sie deren Wurzel:

```console
> dumpheap -type MyApi.Reports.ReportSession
         Address               MT     Size
00007f6ad09421f8 00007f6c20a67498       32
...

> gcroot 00007f6ad09421f8

HandleTable:
    00007F6C98BB15F8 (pinned handle)
    -> 00007F6BDFFFF038 System.Object[]
    -> 00007F69D0033570 MyApi.Telemetry.TelemetryBus
    -> 00007F69D0033588 System.EventHandler`1[[System.String, System.Private.CoreLib]]
    -> 00007F69D00335A0 System.Object[]
    -> 00007F6AD0942258 MyApi.Reports.ReportSession

Found 1 root.
```

Lesen Sie diese Kette von unten nach oben. Das leckende Objekt steht unten, die Wurzel oben. Der Sprung unmittelbar über Ihrem Typ ist der Verursacher, und hier ist er unverkennbar: ein `EventHandler<string>`-Multicast-Delegate, dessen Aufrufliste (`System.Object[]`) jede Sitzung hält. Das führt direkt auf die Zeile `bus.MetricRecorded += OnMetric` ohne passendes `-=` zurück.

`gcroot` gibt standardmäßig nur eindeutige Wurzeln aus. Übergeben Sie `-all`, wenn Sie alle Pfade wollen, und `-nostacks`, um die Suche auf Handles und erreichbare Objekte zu beschränken, wenn das Absuchen der Stacks durch veraltete Register Fehltreffer erzeugt.

Zwei weitere Befehle lohnen sich an dieser Stelle. `objsize <address>` meldet die gehaltene Größe eines Objekts einschließlich allem, was es transitiv hält. So wird aus "dieses Ding ist 32 Bytes groß" ein "dieses Ding hält 68 KB am Leben". Und `dumpobj <address>` gibt das Feld-für-Feld-Layout aus, sodass Sie bestätigen können, welche Eigenschaft des Halters auf Sie zeigt:

```console
> dumpobj 00007F69D0033570
Name:        MyApi.Telemetry.TelemetryBus
MethodTable: 00007f6c20a67498
Size:        24(0x18) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007f6c1dc00f90  4000001        8 ...EventHandler`1  0 instance 00007F69D0033588 MetricRecorded
```

## Fallstricke, die einen Nachmittag kosten

**gcdump löst eine vollständige, blockierende gen2-Sammlung aus.** Genau so läuft es den Heap ab. Bei einem Prozess mit großem Heap kann das die Laufzeit für längere Zeit anhalten. Führen Sie es nicht in einer engen Schleife gegen eine latenzkritische Produktionsinstanz aus, und rechnen Sie beim Ausführen mit einer sichtbaren Pausenspitze in Ihren Metriken.

**gcdump kann bei einem sehr großen Heap stillschweigend scheitern.** Der Ereignispuffer gehört der Zielanwendung und wächst auf bis zu 256 MB. Ist der Heap groß genug, dass Ereignisse verworfen werden, erhalten Sie `System.ApplicationException: ETL file shows the start of a heap dump but not its completion`, oder eine `.gcdump`, die klammheimlich nur einen Teil des Heaps enthält. Überspringen Sie in diesem Fall gcdump und gehen Sie direkt zu `dotnet-dump collect`.

**Beide Werkzeuge brauchen denselben Benutzer und dasselbe `TMPDIR`.** Unter Linux und macOS arbeiten `--process-id` und `--name` über einen Unix-Domain-Socket, den die Laufzeit unter `TMPDIR` anlegt. Läuft Ihr Werkzeug als anderer Benutzer oder unter einem anderen `TMPDIR`, läuft der Befehl nach 30 Sekunden schlicht in einen Timeout, ohne brauchbare Fehlermeldung. Führen Sie ihn als derselbe Benutzer wie der Zielprozess oder als root aus.

**In Containern brauchen Sie `ptrace`.** `dotnet-dump collect` benötigt `ptrace`-Berechtigungen, die üblicherweise mit `--cap-add=SYS_PTRACE` erteilt werden. Davon unabhängig zwingt das Sammeln eines Heap- oder Vollständigen Dumps das Betriebssystem, viel virtuellen Speicher des Zielprozesses einzulagern. Das kann einen speicherbegrenzten Container über sein cgroup-Limit treiben und ihn mitten in der Sammlung durch den OOM-Killer beenden. Erhöhen oder entfernen Sie das Limit vorübergehend, wenn Ihre Plattform das zulässt.

**`Free`-Zeilen sind keine Objekte.** Eine hohe `Free`-Anzahl in `dumpheap -stat` bedeutet Fragmentierung, kein Leck. Es ist Platz zwischen lebenden Objekten, den die GC nicht kompaktiert hat, typischerweise auf dem LOH. Anderes Problem, andere Lösung (Pooling, `ArrayPool<T>` oder `GCSettings.LargeObjectHeapCompactionMode`).

**Cache-förmige Lecks können ein Konfigurationsfehler sein, kein Codefehler.** Ist der wachsende Typ ein eigenes DTO in einem `IMemoryCache`, ist das "Leck" meist eine fehlende Größenbegrenzung oder Ablaufrichtlinie und keine entlaufene Referenz. Diese Entscheidung gehört in [den Vergleich von HybridCache, IMemoryCache und IDistributedCache](/de/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) und nicht in einen Debugger.

**Prüfen Sie die Finalizer-Warteschlange, bevor Sie Ihren Code verdächtigen.** `finalizequeue` in der Analyse-Shell listet die zur Finalisierung registrierten Objekte auf. Eine gestaute Warteschlange bedeutet, dass finalisierbare Objekte nach gen2 befördert und einen zusätzlichen Sammelzyklus lang gehalten werden, was in einem Diagramm genau wie ein langsames Leck aussieht. Die Lösung ist dort fast immer deterministisches Freigeben, und genau dafür gibt es [die Implementierung von IAsyncDisposable und await using](/de/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

**Asynchrone Zustandsautomaten verstecken ihre eigenen Wurzeln.** Sind die wachsenden Typen vom Compiler erzeugte Structs der Form `<SomeMethod>d__12`, verwenden Sie `dumpasync -roots` statt `gcroot`. Es versteht Fortsetzungsketten und zeigt Ihnen, welcher wartende Task den Automaten hält, was ein roher `gcroot`-Durchlauf als unlesbaren Haufen von `Task`- und `Action`-Objekten darstellt.

## Was Sie mit der Antwort anfangen

Sobald `gcroot` den Halter benennt, ist die Korrektur gewöhnlicher Code. Bestellen Sie das Ereignis in einem `Dispose` ab. Geben Sie dem Cache eine Größenbegrenzung und eine Ablaufzeit. Halten Sie keinen Scoped Service in einem Singleton fest, sondern [erzeugen Sie im BackgroundService einen Scope pro Arbeitseinheit](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). Wiederholen Sie danach die Schritte 1 bis 4: unter Last laufen lassen, zwei gcdumps aufnehmen und bestätigen, dass die Typanzahl flach bleibt. Ein Leck ist erst behoben, wenn der zweite gcdump das belegt.

Quellen: [dotnet-gcdump-Referenz](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-gcdump), [dotnet-dump-Referenz](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dump), [Tutorial zum Debuggen eines Speicherlecks](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-memory-leak), [SOS-Debugging-Erweiterung](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/sos-debugging-extension) und [dotnet-counters-Referenz](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-counters).
