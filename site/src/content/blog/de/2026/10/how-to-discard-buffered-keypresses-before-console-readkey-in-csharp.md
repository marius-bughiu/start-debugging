---
title: "So verwerfen Sie gepufferte Tastendrücke vor Console.ReadKey in einer C#-Konsolenspielschleife"
description: "Leeren Sie den Konsoleneingabepuffer mit while (Console.KeyAvailable) Console.ReadKey(true), bevor Sie auf eine neue Taste warten, und tun Sie das in einer Spielschleife in jedem Frame, damit sich die Tastenwiederholung nicht aufstaut. Wie der Puffer unter Windows und Unix in .NET 10 funktioniert, warum gehaltene Tasten verzögert wirken, die Echo-Falle unter Unix und FlushConsoleInputBuffer."
pubDate: 2026-10-12
template: how-to
tags:
  - "csharp"
  - "dotnet-10"
  - "console"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-discard-buffered-keypresses-before-console-readkey-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-12
---

**Kurze Antwort:** In .NET gibt es kein `Console.ClearInputBuffer()`, also leeren Sie den Puffer selbst: `while (Console.KeyAvailable) Console.ReadKey(intercept: true);`. Setzen Sie das direkt vor jedes "Beliebige Taste drücken"-`ReadKey`, damit Tasten, die während einer Zwischensequenz oder einer Ladepause getippt wurden, die Eingabeaufforderung nicht überspringen. In einer Spielschleife führen Sie dasselbe Leeren einmal pro Frame aus und werten die letzte Taste (oder jede relevante Taste) aus, statt pro Frame nur eine Taste zu lesen. Sonst staut sich die Auto-Wiederholung gehaltener Tasten auf, und die Spielfigur bewegt sich weiter, nachdem der Spieler losgelassen hat. Sichern Sie das mit `Console.IsInputRedirected` ab, denn sowohl `KeyAvailable` als auch `ReadKey` werfen eine `InvalidOperationException`, wenn stdin eine Pipe oder Datei ist.

Alles Folgende wurde unter .NET 10 (SDK 10.0.302, Laufzeit 10.0.10) auf macOS ausgeführt, wobei die App über ein echtes Pseudo-Terminal gesteuert wurde, sodass die Tastenanschläge denselben Weg nehmen wie bei einem tippenden Menschen. Das Windows-Verhalten ist aus dem Quellcode von `System.Console` am [Tag `v10.0.0`](https://github.com/dotnet/runtime/tree/v10.0.0/src/libraries/System.Console/src/System) abgeleitet. Der relevante Code (`KeyAvailable`, `ReadKey` und das native Terminal-Setup unter Unix) ist auf `main` unverändert, die Antwort gilt also auch für die .NET-11-Release-Candidates.

## Wo die "gepufferten" Tasten tatsächlich liegen

Ein Tastendruck geht nicht direkt an Ihren `ReadKey`-Aufruf. Das Betriebssystem stellt ihn in eine Warteschlange, in der er liegt, bis jemand ihn liest, unabhängig davon, was Ihr Programm gerade tat, als die Taste gedrückt wurde. Deshalb überspringt ein Spieler, der während eines zweisekündigen `Thread.Sleep`-"Intros" auf Enter hämmert, die nächsten drei Eingabeaufforderungen.

Die Warteschlange liegt auf jeder Plattform an einer anderen Stelle, was für die Wahl des richtigen Leerens wichtig ist:

- **Windows.** Der Konsolenhost hält eine Warteschlange von `INPUT_RECORD`-Strukturen: Taste-gedrückt- und Taste-losgelassen-Ereignisse, Mausereignisse, Fenstergrößenänderungen, Fokusereignisse. `Console.KeyAvailable` ruft `PeekConsoleInput` auf, und wenn der Eintrag am Kopf kein Taste-gedrückt-Ereignis ist, das `ReadKey` zurückgeben würde, liest und verwirft es ihn und schaut erneut nach. `Console.ReadKey` ruft in derselben Schleife `ReadConsoleInput` auf. Ein weiteres Detail: Hat ein Tasteneintrag einen Wiederholungszähler größer als 1, speichert .NET ihn in einem privaten statischen Feld (`_cachedInputRecord`) und gibt aus diesem Cache pro Wiederholung ein `ConsoleKeyInfo` aus.
- **Linux und macOS.** Die Bytes treffen auf dem Dateideskriptor des Terminals ein. Der `StdInReader` von .NET liest sie blockweise in einen eigenen `char[]`-Puffer und parst Escape-Sequenzen (`ESC [ A` für die Pfeiltaste nach oben und so weiter) zu `ConsoleKeyInfo`-Werten. `Console.KeyAvailable` liefert `true`, wenn dieser verwaltete Puffer noch ungeparste Zeichen enthält oder wenn `poll()` auf stdin meldet, dass der Kernel weitere Bytes bereithält.

Auf beiden Plattformen gibt es also eine Schicht, die dem Betriebssystem gehört, und eine, die .NET gehört. Ein Flush, der nur die Schicht des Betriebssystems leert, kann Tasten in der Schicht von .NET zurücklassen. Das Leeren über `ReadKey` räumt beide, deshalb ist es die portable Antwort.

## Ein minimales Beispiel, wie Type-ahead eine Eingabeaufforderung überspringt

```csharp
// .NET 10, C# 14 -- save as typeahead.cs and run with: dotnet run typeahead.cs
Console.WriteLine("Loading level (type some keys now)...");
Thread.Sleep(3000);                       // stands in for a cutscene, a save, a slow load

Console.WriteLine("Press any key to start.");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"Started by: {key.Key}");
```

Tippen Sie während der dreisekündigen Pause `abc` und eine Pfeiltaste. Das Programm gibt "Press any key to start." aus und meldet sofort `Started by: A`, weil die erste gepufferte Taste `ReadKey` erfüllt hat, noch bevor die Eingabeaufforderung sichtbar war. Wenn Sie dies als dateibasierte App verwenden, erklärt die [Anleitung zu `dotnet run file.cs`](/de/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), wie solche Einzeldatei-Programme kompiliert und zwischengespeichert werden.

## Die portable Lösung: mit KeyAvailable und ReadKey leeren

1. Prüfen Sie `Console.IsInputRedirected` und überspringen Sie das Leeren, wenn der Wert `true` ist.
2. Schleifen Sie mit `while (Console.KeyAvailable)` und rufen Sie darin `Console.ReadKey(intercept: true)` auf, das Ergebnis wird verworfen.
3. Erst danach zeigen Sie die Eingabeaufforderung an und rufen `ReadKey` für die Taste auf, die Sie tatsächlich wollen.

```csharp
// .NET 10, C# 14
static class ConsoleInput
{
    /// <summary>Discards every key that is already waiting. Returns how many were dropped.</summary>
    public static int DiscardPendingKeys()
    {
        if (Console.IsInputRedirected) return 0;

        int discarded = 0;
        while (Console.KeyAvailable)
        {
            Console.ReadKey(intercept: true);
            discarded++;
        }
        return discarded;
    }

    /// <summary>Waits for a key pressed after this call, ignoring type-ahead.</summary>
    public static ConsoleKeyInfo ReadFreshKey(bool intercept = true)
    {
        DiscardPendingKeys();
        return Console.ReadKey(intercept);
    }
}
```

Die Eingabeaufforderung aus dem Beispiel sieht dann so aus:

```csharp
// .NET 10, C# 14
Console.WriteLine("Press any key to start.");
var key = ConsoleInput.ReadFreshKey();
Console.WriteLine($"Started by: {key.Key}");
```

Ich habe das Leeren mit diesem Testprogramm überprüft und dabei während des Sleeps `abc`, Pfeil nach oben und Pfeil nach unten sowie einige Sekunden später ein `z` in ein Pseudo-Terminal eingespeist:

```csharp
// .NET 10, C# 14
Console.WriteLine("busy for 3s, type ahead now...");
Thread.Sleep(3000);
int discarded = 0;
while (Console.KeyAvailable)
{
    var k = Console.ReadKey(intercept: true);
    discarded++;
    Console.WriteLine($"discarded: Key={k.Key} Char={(int)k.KeyChar}");
}
Console.WriteLine($"discarded {discarded} keys; press a key");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"got: {key.Key}");
```

```text
discarded: Key=A Char=97
discarded: Key=B Char=98
discarded: Key=C Char=99
discarded: Key=UpArrow Char=0
discarded: Key=DownArrow Char=0
discarded 5 keys; press a key
got: Z
```

Zwei Details sind erwähnenswert. Die Pfeiltasten kamen jeweils als ein einziges `ConsoleKeyInfo` heraus, nicht als drei einzelne Zeichen, weil `ReadKey` den Parser für Escape-Sequenzen durchläuft. Ein Flush auf Byte-Ebene (rohes Lesen von stdin oder ein Aufruf von `tcflush`) kann eine Escape-Sequenz in der Mitte durchtrennen und `[A` zurücklassen, das dann als zwei druckbare Tasten gelesen wird. Und `intercept: true` ist wichtig: Mit `false` wird jede verworfene Taste auf dem Bildschirm ausgegeben, also genau der Müll, den Sie verbergen wollten.

## Warum gehaltene Tasten die Spielfigur nach dem Loslassen weiterbewegen

Derselbe Puffer macht auch in einer Echtzeitschleife Ärger, nur unauffälliger. Hält ein Spieler eine Pfeiltaste, erzeugt das Terminal oder der Konsolenhost nach einer anfänglichen Verzögerung Auto-Wiederholungs-Tastendrücke, üblicherweise etwa 30 pro Sekunde. Eine typische Anfängerschleife liest höchstens eine Taste pro Frame:

```csharp
// .NET 10, C# 14 -- one key per frame: input lags behind
while (running)
{
    if (Console.KeyAvailable)
        Handle(Console.ReadKey(intercept: true).Key);

    Update();
    Draw();
    Thread.Sleep(100);   // ~10 fps
}
```

Treffen Tasten schneller ein als Frames, wächst der Rückstau, solange die Taste gehalten wird, und wird nach dem Loslassen mit einer Taste pro Frame abgebaut. Ich habe es gemessen: eine Schleife mit 10 Frames pro Sekunde, gespeist mit 30 Rechtspfeil-Sequenzen im Abstand von 33 ms (eine Sekunde simulierte Auto-Wiederholung, beginnend etwa eine Sekunde nach dem Start).

```csharp
// .NET 10, C# 14
bool drainAll = args.Length > 0 && args[0] == "drain";
_ = Console.KeyAvailable;
var sw = System.Diagnostics.Stopwatch.StartNew();
int x = 0; long lastMove = 0;
while (sw.ElapsedMilliseconds < 4000)
{
    if (drainAll)
    {
        ConsoleKey? last = null;
        while (Console.KeyAvailable) last = Console.ReadKey(intercept: true).Key;
        if (last == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    else if (Console.KeyAvailable)
    {
        if (Console.ReadKey(intercept: true).Key == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    Thread.Sleep(100); // 10 fps
}
Console.WriteLine($"{(drainAll ? "drain" : "one-per-frame")}: x={x}, last move at {lastMove} ms");
```

```text
one-per-frame: x=30, last move at 3739 ms
drain: x=13, last move at 2268 ms
```

Mit einer Taste pro Frame bewegte sich die Figur 30 Felder weit und war noch etwa 1,5 Sekunden nach dem "Loslassen" der Taste in Bewegung. Mit vollständigem Leeren pro Frame endete die Bewegung innerhalb eines Frames nach der letzten Wiederholung. Die geleerte Variante bewegt sich pro Frame ein Feld, solange die Taste gehalten wird, und genau das will ein Spiel meistens: eine Geschwindigkeit, die an die Framerate gekoppelt ist und nicht an die Wiederholrate des Betriebssystems.

Das allgemeine Muster: Leeren Sie in jedem Frame in einen kleinen Eingabezustand pro Frame und lassen Sie `Update` diesen Zustand lesen:

```csharp
// .NET 10, C# 14
sealed class FrameInput
{
    private readonly HashSet<ConsoleKey> _pressed = new();

    public bool WasPressed(ConsoleKey key) => _pressed.Contains(key);

    public void Poll()
    {
        _pressed.Clear();
        if (Console.IsInputRedirected) return;

        while (Console.KeyAvailable)
            _pressed.Add(Console.ReadKey(intercept: true).Key);
    }
}

// game loop
var input = new FrameInput();
while (running)
{
    input.Poll();
    if (input.WasPressed(ConsoleKey.Escape)) break;
    if (input.WasPressed(ConsoleKey.LeftArrow))  player.X--;
    if (input.WasPressed(ConsoleKey.RightArrow)) player.X++;
    if (input.WasPressed(ConsoleKey.Spacebar))   player.Jump();

    Draw();
    Thread.Sleep(16);
}
```

Eine Menge statt "letzte Taste gewinnt" sorgt dafür, dass ein Sprung, der im selben Frame wie ein Richtungswechsel gedrückt wird, nicht verloren geht. Brauchen Sie Modifikatoren, speichern Sie stattdessen das ganze `ConsoleKeyInfo` oder ein Paar `(ConsoleKey, ConsoleModifiers)`.

Was die Konsole Ihnen nicht verraten kann, ist, ob eine Taste *gerade gehalten wird*. `ReadKey` liefert nur Taste-gedrückt-Ereignisse (unter Windows werden Taste-losgelassen-Einträge übersprungen, außer einem Alt-Loslassen mit einem zusammengesetzten Zeichen, ebenso das alleinige Drücken von Shift, Strg und Alt; unter Unix senden Terminals gar kein Taste-losgelassen). "Gehalten" wird in einem Konsolenspiel aus eintreffenden Wiederholungsereignissen abgeleitet, weshalb vor einer kontinuierlichen Bewegung immer die anfängliche Wiederholverzögerung des Betriebssystems liegt. Brauchen Sie den echten Tastenzustand unter Windows, ist `GetAsyncKeyState` per P/Invoke der übliche Ausweg, und ab diesem Punkt lohnt sich ein echtes Spiele-Framework.

## Die Echo-Falle unter Unix: Type-ahead erscheint auf dem Bildschirm

Unter Linux und macOS gibt es ein zweites Symptom, das das Leeren nicht behebt. In meinem ersten Testlauf sah die Ausgabe tatsächlich so aus:

```text
busy for 3s, type ahead now...
abc^[[A^[[Bdiscarded: Key=A Char=97
```

Die Tasten wurden korrekt verworfen, aber das Terminal hatte sie bereits ausgegeben, während das Programm schlief. Der Grund steht in `pal_console.c`: .NET schaltet das Terminal beim ersten Konsolen-*Lesezugriff* in den nicht-kanonischen Modus ohne Echo (`ECHO`, `ICANON` und `IEXTEN` gelöscht), und dazu zählt auch `Console.KeyAvailable`, das `SystemNative_StdinReady` aufruft. Vor diesem ersten Lesezugriff befindet sich das Terminal noch im Standardmodus (cooked) und gibt alles per Echo aus. Einmal konfiguriert, belässt .NET das Terminal in diesem Modus bis zum Prozessende, wenn die ursprünglichen Einstellungen wiederhergestellt werden.

Die Lösung ist, die Eingabeseite einmal beim Start zu berühren:

```csharp
// .NET 10, C# 14 -- first line of Main, before any long-running work
if (!Console.IsInputRedirected)
    _ = Console.KeyAvailable;   // puts the terminal in no-echo, non-canonical mode
```

Mit dieser Zeile als erster erzeugte derselbe dreisekündige Sleep mit hineingetippten Tasten eine saubere Ausgabe: Die Tasten blieben im Puffer, nichts wurde ausgegeben, und das spätere Leeren entfernte sie. Unter Windows tritt das Problem nicht auf, weil das Type-ahead einer Konsolen-App als Eingabeeinträge vorliegt und erst ausgegeben wird, wenn etwas im Zeilenmodus liest.

## Nur Windows: FlushConsoleInputBuffer

Win32 hat einen direkten Aufruf, [`FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), der die Warteschlange der Eingabeeinträge der Konsole in einem Schritt leert. Er ist verlockend, weil er O(1) ist und auch Maus- und Größenänderungseinträge löscht:

```csharp
// .NET 10, C# 14 -- needs <AllowUnsafeBlocks>true</AllowUnsafeBlocks> for LibraryImport
using System.Runtime.InteropServices;

static partial class WinConsole
{
    private const int StdInputHandle = -10;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint GetStdHandle(int nStdHandle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool FlushConsoleInputBuffer(nint hConsoleInput);

    public static bool TryFlush()
    {
        if (!OperatingSystem.IsWindows() || Console.IsInputRedirected) return false;
        return FlushConsoleInputBuffer(GetStdHandle(StdInputHandle));
    }
}
```

Ich habe dies unter .NET 10 kompiliert (als dateibasierte App mit `#:property AllowUnsafeBlocks=true`), konnte es aber nur unter macOS ausführen, wo `TryFlush` `false` zurückgibt, ohne `kernel32` aufzurufen. Ich würde danach dennoch das verwaltete Leeren aufrufen, aus einem im Quellcode sichtbaren Grund: `FlushConsoleInputBuffer` erreicht das private `_cachedInputRecord` von .NET nicht. Hatte der letzte von `ReadKey` gelesene Eintrag einen Wiederholungszähler über 1, werden die übrigen Wiederholungen aus diesem Feld bedient, und `KeyAvailable` liefert dafür `true`, noch bevor es die Konsole fragt. `DiscardPendingKeys()` leert auch den Cache. Wenn `LibraryImport` und quellgenerierte Marshalling-Mechanismen für Sie neu sind, führt der [Beitrag zu Polars.NET](/de/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/) darin ein, und der [Beitrag zu Sitzungssperr- und Entsperrereignissen unter Windows](/de/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/) nutzt dasselbe `LibraryImport`-Muster gegen `wtsapi32.dll`, einschließlich der Einrichtung von `AllowUnsafeBlocks`.

## Fallstricke und Sonderfälle

**Umgeleitete Eingabe wirft Ausnahmen.** Ist stdin eine Pipe (`echo abc | dotnet run game.cs`), werfen beide Aufrufe. Die exakten Meldungen unter .NET 10:

```text
KeyAvailable threw InvalidOperationException: Cannot see if a key has been pressed when either application does not have a console or when console input has been redirected from a file. Try Console.In.Peek.
ReadKey threw InvalidOperationException: Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.
```

Das trifft Sie in CI, in `dotnet test`-Läufen, die den Konsolencode ausführen, und in manchen "Ausführen"-Konsolen von IDEs, die stdin umleiten. Jeder Helfer oben kehrt bei `Console.IsInputRedirected` frühzeitig zurück.

**Leeren Sie nicht mit Console.In.** `Console.In.Read()` und `Console.In.Peek()` sind unter Unix zeilenorientiert: Sie lesen eine ganze Zeile in einen separaten Stapel im `StdInReader`, bevor sie zurückkehren, blockieren also bis Enter und ziehen Tasten an einen Ort, den `KeyAvailable` nicht prüft. `ReadLine` und `ReadKey` in einem Programm zu mischen ist in Ordnung, das Leeren über die `TextReader`-API nicht.

**Leeren ist kein Entprellen.** Drückt der Benutzer 5 ms nach Ihrem Leeren eine Taste, ist das eine neue Taste, und `ReadKey` gibt sie zurück. Das ist korrekt, aber wenn es Ihnen um versehentliche Doppelklicks in einem Menü geht, fügen Sie vor dem Leeren eine kleine Verzögerung ein, zum Beispiel `Thread.Sleep(150)` direkt nach der Aktion, die die Eingabeaufforderung ausgelöst hat.

**Pollen Sie KeyAvailable nicht in einer Busy-Schleife.** `while (!Console.KeyAvailable) { }` verbrennt einen Kern. Schlafen Sie in einer Frame-Schleife oder warten Sie auf den nächsten Frame. Wollen Sie "auf eine Taste warten, aber nach N Sekunden aufgeben", fragen Sie `KeyAvailable` mit einem kurzen `Task.Delay` und einer Frist ab oder verpacken Sie das in einen Token von [`CancellationTokenSource.CancelAfter`](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/). `Console.ReadKey` selbst lässt sich nicht abbrechen, sobald es blockiert, der einzige Weg zum Aufgeben ist also, es nie aufzurufen, bis `KeyAvailable` meldet, dass etwas zu lesen ist. Reichen Sie den Token in der Aufrufkette genauso weiter wie bei jeder [asynchronen Methode, die Abbruch berücksichtigen soll](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Strg+C ist standardmäßig keine Taste.** Solange Sie nicht `Console.TreatControlCAsInput = true` setzen, löst Strg+C `Console.CancelKeyPress` aus und gelangt nie in den Puffer, sodass Ihr Leeren es weder sieht noch verschluckt. Setzen Sie es für ein Spiel auf `true`, denken Sie daran, dass Ihr Leeren nun ein während einer Pause gedrücktes Strg+C stillschweigend frisst.

**Mehrthread-Lesezugriffe.** Unter Windows nimmt `ReadKey` eine Sperre, unter Unix gehen `KeyAvailable` und `ReadKey` durch einen synchronisierten Reader. Dadurch sind sie von verschiedenen Threads aus sicher aufrufbar, aber nicht sinnvoll: Ein Hintergrund-Eingabethread und ein Leeren im Hauptthread stehlen sich gegenseitig Tasten. Bestimmen Sie einen Thread, dem die Konsoleneingabe gehört.

### Weiterlesen

- [So führen Sie eine dateibasierte C#-App mit dotnet run in .NET 11 aus](/de/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)
- [So setzen Sie ein Zeitlimit für eine asynchrone Operation mit CancellationTokenSource.CancelAfter in C#](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [So reichen Sie ein CancellationToken durch asynchrone Methoden in .NET 11 weiter](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [So erkennen Sie Sitzungssperre, Entsperrung, Anmeldung und Abmeldung unter Windows in einer C#-App](/de/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/)

## Quellen

- [`Console.KeyAvailable` property](https://learn.microsoft.com/en-us/dotnet/api/system.console.keyavailable), Microsoft Learn.
- [`Console.ReadKey` method](https://learn.microsoft.com/en-us/dotnet/api/system.console.readkey), Microsoft Learn.
- [`FlushConsoleInputBuffer` function](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), Windows Console docs.
- [`ConsolePal.Windows.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/ConsolePal.Windows.cs) at `v10.0.0` (`KeyAvailable`, `ReadKey`, `_cachedInputRecord`).
- [`StdInReader.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/StdInReader.cs) and [`SyncTextReader.Unix.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/SyncTextReader.Unix.cs) at `v10.0.0` (Unix buffering and `KeyAvailable`).
- [`pal_console.c`](https://github.com/dotnet/runtime/blob/v10.0.0/src/native/libs/System.Native/pal_console.c) at `v10.0.0` (terminal echo and canonical mode).
