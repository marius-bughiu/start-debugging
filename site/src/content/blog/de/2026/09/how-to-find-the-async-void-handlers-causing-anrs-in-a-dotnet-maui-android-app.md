---
title: "Die async-void-Handler finden, die ANRs in einer .NET MAUI Android-App verursachen"
description: "Die Play Console meldet eine ANR-Rate über 0,47% und liefert einen nativen Stack Trace voller libcoreclr.so-Frames. So kommen Sie von diesem nutzlosen Trace zu genau dem async-void-Ereignishandler, der den Main-Thread blockiert hat: mit einem Looper-Printer, einem SynchronizationContext-Wrapper, der die Zustandsmaschine benennt, und dotnet-trace über dsrouter."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "maui"
  - "android"
  - "async"
  - "performance"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-09-07
---

Kurze Antwort: Der ANR-Trace von Google Play nennt Ihre C#-Methode nicht, lesen Sie ihn also nicht so, als täte er das. Erfassen Sie jedes `async void` in der Codebasis mit VSTHRD100, grenzen Sie auf die an UI-Ereignisse gebundenen ein und installieren Sie dann zwei Dinge in einem Release-Build: einen `Android.Util.IPrinter` am Haupt-`Looper`, der jede Main-Thread-Nachricht misst, und einen `SynchronizationContext`-Wrapper, der die geboxte asynchrone Zustandsmaschine aus der geposteten Fortsetzung liest, damit die Logzeile `MainPage+<OnSyncClicked>d__7` statt eines anonymen Runnable ausgibt. Der erste erfasst Arbeit vor dem ersten `await`, der zweite Arbeit danach. Zusammen liefern sie einen Methodennamen.

Dieser Beitrag zielt auf .NET 11 (`11.0.100-preview.7`, veröffentlicht am 2026-08-11, GA geplant für 2026-11-10) mit .NET MAUI 11 auf `net11.0-android`, wo CoreCLR die einzige mobile Laufzeit ist. Alles hier funktioniert auch unter .NET 10 mit Mono; Unterschiede sind dort vermerkt, wo sie zählen.

## Warum `async void` überhaupt in ANR-Berichten auftaucht

`async void` blockiert von sich aus keinen Thread. Es verursacht ANRs indirekt, über drei Mechanismen, die alle am selben Punkt enden.

**Das synchrone Präfix läuft auf dem Thread des Aufrufers.** Eine `async`-Methode gibt an der öffnenden Klammer nicht ab. Sie läuft durch, bis sie auf ein `await` über etwas trifft, das noch nicht abgeschlossen ist. In einem Klick-Handler auf dem Android-Main-Thread ist jede Zeile vor diesem ersten echten Suspendierungspunkt Main-Thread-Arbeit, und das Schlüsselwort `async` in der Signatur lässt es anders aussehen.

```csharp
// MainPage.xaml.cs, .NET 11, net11.0-android, MAUI 11
private async void OnSyncClicked(object sender, EventArgs e)
{
    using var db = new SqliteConnection(_dbPath);   // opens the file, ~40 ms cold
    var orders = db.Query<Order>(
        "select * from Orders where Status = 0");    // 3-9 s on a 40k-row table
    await RenderAsync(orders);                       // the first real await, far too late
}
```

Fünf Sekunden davon und der Input-Dispatcher von Android gibt auf. Das `await` in der letzten Zeile nützt Ihnen nichts.

**Es nimmt dem Aufrufer die Möglichkeit zu warten, also fügt jemand eine Blockade ein.** Weil eine `async void`-Methode nichts Erwartbares zurückgibt, ist der Weg des geringsten Widerstands `.Result` oder `.Wait()`, sobald eine zweite Codestelle ihr Ergebnis braucht. Auf einem Thread mit einem `SynchronizationContext`, der Fortsetzungen zu sich selbst zurückleitet, ist das der [klassische asynchrone Deadlock](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/), und unter Android ist der blockierte Thread genau der, den Android misst.

```csharp
private async void OnRefreshClicked(object sender, EventArgs e)
{
    // The handler could not be awaited, so this got "fixed" by blocking.
    var settings = _settings.LoadAsync().Result;   // main thread parked, permanently
    await ReloadAsync(settings);
}
```

**Es ist wiedereintrittsfähig.** Nichts hindert einen zweiten Tap daran, einen zweiten Aufruf zu starten, während der erste suspendiert ist. Zwei überlappende Läufe konkurrieren um dasselbe `SemaphoreSlim` oder dieselbe `SQLiteConnection`, und diese Konkurrenz zeigt sich als Main-Thread-Stillstand, der sich nur bei schnellem Doppeltippen reproduzieren lässt. Wer die vollständige Behandlung der Frage sucht, wann das Konstrukt legitim ist, findet sie unter [async void vs async Task in C#: wann welches korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Was Android tatsächlich misst

Das genaue Budget zu kennen zeigt, welche Handler eine Untersuchung wert sind. Laut der [Android-ANR-Dokumentation](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs):

| Auslöser | Zeitlimit |
| --- | --- |
| Input-Dispatch (Berührung, Taste) | 5 Sekunden |
| Broadcast Receiver mit gesetztem `FLAG_RECEIVER_FOREGROUND` | 10 s unter Android 13 und älter, 10-20 s unter Android 14+ |
| Broadcast Receiver mit Hintergrundpriorität | 60 s unter Android 13 und älter, 60-120 s unter Android 14+ |
| `onCreate` / `onStartCommand` / `onBind` eines Vordergrunddienstes | 20 Sekunden |
| Hintergrunddienst | 200 Sekunden |

Input-Dispatch trifft MAUI-Apps am härtesten, und es ist das, was Nutzer sehen, denn die App war per Definition im Vordergrund und wurde berührt. Den Einsatz legt Play fest: Die vom Nutzer wahrgenommene ANR-Rate ist ein zentrales Qualitätsmerkmal mit einem Schwellenwert für schlechtes Verhalten von 0,47% insgesamt, ausgewertet über ein gleitendes 28-Tage-Fenster. Wer ihn überschreitet, wird auf allen Geräten schlechter gefunden ([technische Qualitätsanforderungen der Play Console](https://support.google.com/googleplay/android-developer/answer/17492799)).

## Warum der Trace von Play nicht ausreicht

Holen Sie den ANR-Datensatz und sehen Sie sich den Main-Thread an. Auf einem erreichbaren Gerät:

```sh
# Everything in the device's dropbox, newest last
adb shell dumpsys dropbox --print data_app_anr | tail -300

# Or the full set, which is what you want for a device that has been running a while
adb bugreport anr.zip
unzip -o anr.zip -d anr && ls anr/FS/data/anr/
```

Der Kopf nennt den Auslöser:

```
ANR in com.example.orders (com.example.orders/crc64e1fb321c08285b90.MainActivity)
PID: 14882
Reason: Input dispatching timed out (Waited 5003ms for MotionEvent)
```

Den Main-Thread-Stack dumpt jedoch ART, das Java-Frames symbolisiert. Ihr Handler ist kein Java-Frame. In einer Android-App auf CoreCLR erhalten Sie etwas dieser Form:

```
"main" prio=5 tid=1 Native
  #00 pc 00000000000a1b3c  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+28)
  #01 pc 00000000004f21d8  /data/app/.../lib/arm64/libcoreclr.so (???)
  #02 pc 00000000004e0a44  /data/app/.../lib/arm64/libcoreclr.so (???)
  at crc64e1fb321c08285b90.MainActivity.n_onCreate(Native method)
  at android.os.Handler.dispatchMessage(Handler.java:106)
  at android.os.Looper.loop(Looper.java:294)
```

Mehr bekommen Sie nicht: namenlose native Frames innerhalb von `libcoreclr.so` (`libmonosgen-2.0.so`, wenn Sie unter .NET 10 noch auf Mono sind). Nutzlos ist das nicht. Es sortiert das Problem in eine von drei Kategorien:

- Frames in `syscall`, `futex_wait` oder `pthread_cond_wait` unterhalb der Laufzeit: Der Main-Thread ist **blockiert**, also ein Lock, ein `.Result`, ein `.Wait()` oder ein `SemaphoreSlim.Wait()`.
- Frames, die ohne Syscall darüber in `libcoreclr.so` rotieren: Der Main-Thread **führt verwalteten Code aus**, also CPU-gebundene Arbeit in einem Handler.
- `android.os.MessageQueue.nativePollOnce` ganz oben: Der Main-Thread war zum Zeitpunkt des Dumps **untätig**. Der ANR liegt woanders, oder der Dump kam zu spät. Android dokumentiert das ausdrücklich, und Handler-Jagd bei dieser Signatur ist vergeudete Mühe.

Es gibt eine vierte Form, die man vorab erkennen sollte: ein Stack, der direkt nach einem Kaltstart in `coreclr_initialize` steht. Das ist nicht Ihr Code, sondern die CoreCLR-Startregression aus [dotnet/android#10588](https://github.com/dotnet/android/issues/10588), bei der eine große App, die unter Mono in einer Sekunde startete, unter CoreCLR rund sechs braucht und damit das Budget des Betriebssystems sprengt. Solche Fälle gruppieren sich in den Vitals separat unter `handleBindApplication`. Trifft diese Form zu, liegt die Lösung in der Startarbeit aus [eine MAUI Android-App von Mono zu CoreCLR migrieren](/de/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/), nicht in der Handler-Triage.

## Der Triage-Ablauf in fünf Schritten

1. **Erfassen Sie jede `async void`-Deklaration und jedes solche Delegate in der Solution.** Fügen Sie `Microsoft.VisualStudio.Threading.Analyzers` hinzu und schalten Sie VSTHRD100 (async-void-Methoden) und VSTHRD101 (async-void-Delegates und -Lambdas) als Build-Warnungen ein. Das liefert die vollständige Kandidatenmenge in einem Build, samt der `async`-Lambdas an `EventHandler`, die eine Textsuche verfehlt.
2. **Sortieren Sie die Kandidaten danach, ob sie auf dem Main-Thread laufen können.** Nur Handler, die von einem UI-Ereignis, einem `Loaded`/`Appearing`-Lebenszyklus-Callback oder einem `MainThread.BeginInvokeOnMainThread`-Rumpf erreichbar sind, können einen Input-Dispatch-ANR erzeugen. Alles andere ist ein Korrektheitsproblem, kein ANR.
3. **Instrumentieren Sie den Haupt-`Looper` in einem Release-Build**, sodass jede Main-Thread-Nachricht oberhalb eines Schwellwerts mit ihrer Dauer protokolliert wird. Das erfasst das synchrone Präfix, das den `SynchronizationContext` nie berührt und deshalb für alle anderen Techniken hier unsichtbar ist.
4. **Umhüllen Sie den `SynchronizationContext` des Main-Threads**, sodass langsame fortgesetzte Continuations den Namen der zugehörigen asynchronen Zustandsmaschine protokollieren. Dieser Schritt macht aus einer Dauer einen Methodennamen.
5. **Bestätigen Sie mit `dotnet-trace` über `dotnet-dsrouter`** und lesen Sie den Flame Graph des Main-Threads, damit die Korrektur gemessen und nicht vermutet wird.

## Schritt 1 und 2: der statische Durchgang

```xml
<!-- MyApp.csproj, .NET 11 -->
<ItemGroup>
  <PackageReference Include="Microsoft.VisualStudio.Threading.Analyzers" Version="17.14.15">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

```ini
# .editorconfig
dotnet_diagnostic.VSTHRD100.severity = warning   # Avoid async void methods
dotnet_diagnostic.VSTHRD101.severity = warning   # Avoid unsupported async delegates
```

Dann die Liste ausgeben:

```sh
dotnet build -c Release -f net11.0-android -warnaserror:none \
  | grep -E 'VSTHRD10[01]' | sort -u
```

Rechnen Sie mit Rauschen. VSTHRD100 schlägt auch bei legitimen Ereignishandlern an, was die alte Beschwerde in [microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510) ist: Der Analyzer kann nicht wissen, dass eine Methode mit der Signatur `(object, EventArgs)` `void` sein muss. Unterdrücken Sie die Meldung nicht einfach. Schritt 1 dient der Inventur, und in Schritt 2 filtern Sie von Hand auf die Handler, die auf dem Main-Thread laufen können. In einer typischen mittelgroßen MAUI-App schrumpft eine 60-Einträge-Liste von VSTHRD100 auf 8 bis 10 echte Kandidaten.

`AsyncFixer03` aus dem AsyncFixer-Paket meldet dieselbe Fire-and-Forget-Form, falls Sie die vs-threading-Abhängigkeit vermeiden wollen. Beides funktioniert; führen Sie nicht beide aus, sonst triagieren Sie jeden Befund doppelt.

## Schritt 3: jede Main-Thread-Nachricht messen

`Looper.setMessageLogging` schreibt je eine Zeile zu Beginn und am Ende jeder Nachrichtenzustellung. Die Differenz der Zeitstempel ergibt die exakte Dauer jeder Main-Thread-Arbeitseinheit, einschließlich des synchronen Präfixes eines Handlers.

```csharp
// Platforms/Android/MainThreadWatchdog.cs, .NET 11, net11.0-android
using Android.OS;
using Android.Util;

sealed class MainThreadWatchdog(long thresholdMs) : Java.Lang.Object, IPrinter
{
    private long _startedAt;
    private string? _current;

    public void Println(string? message)
    {
        if (string.IsNullOrEmpty(message))
            return;

        // Looper emits ">>>>> Dispatching to <handler> <callback>: <what>"
        // then "<<<<< Finished to <handler> <callback>".
        if (message[0] == '>')
        {
            _current = message;
            _startedAt = SystemClock.UptimeMillis();
            return;
        }

        var elapsed = SystemClock.UptimeMillis() - _startedAt;
        if (elapsed >= thresholdMs)
            Log.Warn("anr-hunt", $"main thread busy {elapsed} ms: {_current}");
        _current = null;
    }
}
```

Installieren Sie ihn früh und nur in einem Build, den Sie danach wegwerfen:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(thresholdMs: 300));
#endif
}
```

Dann unter echter Nutzung beobachten:

```sh
adb logcat -s anr-hunt:W
```

Ein Schwellwert von 300 ms ist absichtlich aggressiv. Ein Input-Dispatch-ANR braucht 5000 ms, aber ein Handler, der auf Ihrem Entwicklungsgerät 400 ms kostet, kostet auf einem vier Jahre alten Gerät mit kaltem Page Cache mehrere Sekunden, und aus solchen Geräten stammt Ihre Vitals-Zahl.

Was Sie bekommen, ist eine Dauer und eine Looper-Zielzeichenkette. Was Sie nicht bekommen, ist ein C#-Methodenname: Eine von der Laufzeit gepostete Continuation kommt als generischer `Java.Lang.IRunnable`-Wrapper an, sodass das Feld `<callback>` als undurchsichtiger `crc64...`-Typ erscheint. Dafür ist Schritt 4 da.

## Schritt 4: die Zustandsmaschine benennen

`Task` postet seine Continuations über `SynchronizationContext.Post`, und auf dem Android-Main-Thread ist das der Kontext, der zurück an den Haupt-`Handler` marshallt. Umhüllen Sie ihn, und Sie können den geposteten Zustand prüfen, bevor Sie ihn weiterreichen.

Die Feinheit: Das `SendOrPostCallback`-Delegate ist nicht Ihre Methode. Die Laufzeit nutzt einen einzigen gemeinsamen statischen Callback und übergibt die eigentliche Continuation in `state`, als `Action`, deren Ziel die geboxte asynchrone Zustandsmaschine ist. Diese Box ist ein generischer Typ, dessen Typargument das vom Compiler erzeugte Struct Ihrer Methode ist, und ihr Name enthält den ursprünglichen Methodennamen.

```csharp
// Platforms/Android/AnrHuntingSyncContext.cs, .NET 11
using System.Diagnostics;
using Android.Util;

sealed class AnrHuntingSyncContext(SynchronizationContext inner, long thresholdMs)
    : SynchronizationContext
{
    public override void Post(SendOrPostCallback d, object? state)
    {
        var origin = Describe(d, state);
        inner.Post(_ =>
        {
            var sw = Stopwatch.StartNew();
            d(state);
            if (sw.ElapsedMilliseconds >= thresholdMs)
                Log.Warn("anr-hunt", $"continuation {sw.ElapsedMilliseconds} ms: {origin}");
        }, null);
    }

    public override SynchronizationContext CreateCopy() =>
        new AnrHuntingSyncContext(inner.CreateCopy(), thresholdMs);

    // Best effort. Reads the boxed state machine the runtime passes as `state`;
    // this is an implementation detail, so fall back to the delegate's method.
    private static string Describe(SendOrPostCallback d, object? state)
    {
        if (state is Action a && a.Target is { } box)
        {
            var t = box.GetType();
            if (t.IsGenericType)
                // AsyncStateMachineBox`1[MyApp.MainPage+<OnSyncClicked>d__7]
                return t.GetGenericArguments()[0].FullName ?? t.Name;
            return t.FullName ?? t.Name;
        }
        return $"{d.Method.DeclaringType?.FullName}.{d.Method.Name}";
    }
}
```

Installieren Sie ihn auf dem Main-Thread, nachdem MAUI seinen eigenen Kontext eingerichtet hat:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(300));
    SynchronizationContext.SetSynchronizationContext(
        new AnrHuntingSyncContext(SynchronizationContext.Current!, thresholdMs: 300));
#endif
}
```

Die gesuchte Logzeile sieht so aus, und sie ist der ganze Zweck der Übung:

```
W anr-hunt: continuation 4412 ms: MyApp.MainPage+<OnSyncClicked>d__7
```

Drei Einschränkungen, die alle zählen:

- Nur Continuations, deren `await` den Kontext **nach** der Installation erfasst hat, laufen durch den Wrapper. Installieren Sie ihn in `OnCreate`, bevor die erste Seite gebaut wird.
- `MainThread.BeginInvokeOnMainThread` und der `IDispatcher` von MAUI posten direkt an den Android-`Handler`, nicht über den `SynchronizationContext`, und umgehen diesen Wrapper daher vollständig. Der Looper-Printer aus Schritt 3 sieht sie weiterhin, und deshalb setzen Sie beide ein.
- Code, der mit [`ConfigureAwait(false)`](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/) wartet, erfasst den Kontext gar nicht, und seine Continuation bleibt hier korrekterweise unsichtbar. Genau das ist gewünscht: Sie wird nicht auf dem Main-Thread fortgesetzt.

## Schritt 5: mit `dotnet-trace` bestätigen

Sobald Sie einen Verdächtigen haben, messen Sie ihn. Unter CoreCLR in .NET 11 ist die Diagnosekomponente in die Laufzeit eingebaut, `EnableDiagnostics` ist also nicht nötig (unter .NET 10 mit Mono schon, und es legt `libmono-component-diagnostics_tracing.so` ins Paket).

```sh
# .NET 11, dotnet-trace and dotnet-dsrouter 9.0.652701 or newer
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-dsrouter

# Physical Android device. Use 10.0.2.2 instead of 127.0.0.1 on an emulator.
dotnet build -t:Run -c Release -f net11.0-android \
  -p:DiagnosticAddress=127.0.0.1 -p:DiagnosticPort=9000 \
  -p:DiagnosticSuspend=false -p:DiagnosticListenMode=connect

dotnet-trace collect --dsrouter android --format speedscope
```

Navigieren Sie zum Bildschirm, tippen Sie den Button an, drücken Sie Enter zum Stoppen und öffnen Sie die `.speedscope.json` auf [speedscope.app](https://speedscope.app/). Wählen Sie den Main-Thread, wechseln Sie in die Sandwich-Ansicht und sortieren Sie nach Eigenzeit. Der gesuchte Frame ist `MainPage.OnSyncClicked` mit einem breiten, zusammenhängenden Block und direkt darunter das, was die Zeit tatsächlich kostet.

Profilieren Sie ausschließlich `Release`-Builds. Debug-Builds laufen unter Android für Hot Reload im Interpreter (`UseInterpreter=true`), und deren Zeiten sind Fiktion.

## Die Korrekturen in der Reihenfolge, in der Sie sie versuchen sollten

Steht der Handler fest, ist die Reparatur fast immer eine von vier Sachen.

**Machen Sie aus dem Handler eine dünne Hülle über einer `Task`-zurückgebenden Methode.** Die Ereignissignatur erzwingt `void`, aber nichts erzwingt einen langen Rumpf.

```csharp
// The only line allowed to be async void.
private void OnSyncClicked(object sender, EventArgs e) => _ = SyncAsync();

private async Task SyncAsync()
{
    _syncButton.IsEnabled = false;                    // re-entrancy guard
    try
    {
        var orders = await Task.Run(() => _repo.LoadPendingOrders());
        await RenderAsync(orders);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "sync failed");           // an async void body cannot do this
    }
    finally
    {
        _syncButton.IsEnabled = true;
    }
}
```

**Verlagern Sie das synchrone Präfix auf den Thread Pool.** `Task.Run` ist hier genau deshalb das richtige Werkzeug, weil die Arbeit CPU-gebunden oder blockierend IO-gebunden ist und derzeit auf dem UI-Thread läuft. Für diesen Fall existiert `Task.Run`.

**Löschen Sie den blockierenden Aufruf.** Enthält der Handler `.Result`, `.Wait()` oder `GetAwaiter().GetResult()`, nützt die ganze obige Instrumentierung nichts, solange das nicht weg ist. Die mechanische Variante behandelt [von blockierenden .Result/.Wait()-Aufrufen zu durchgehend asynchronem Code migrieren](/de/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/).

**Binden Sie an ein Command statt an ein Ereignis.** `AsyncRelayCommand` aus dem MVVM Community Toolkit gibt eine `Task` zurück, die das Framework beobachtet. Das entfernt das `async void` vollständig aus Ihrem Code und liefert `IsRunning` gratis als Wiedereintrittsschutz.

## Fallstricke, die einen Nachmittag kosten

**Ein Fire-and-Forget-Discard `_ =` schluckt weiterhin Ausnahmen.** Die obige Hülle protokolliert innerhalb von `SyncAsync`, und genau das macht sie sicher. Ein nacktes `_ = SomethingAsync()` ohne `try` darin birgt dieselbe Gefahr unbeobachteter Ausnahmen wie `async void`, nur leiser, und der Compiler warnt nicht, weil der Discard [CS4014](/de/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) unterdrückt.

**`StrictMode` findet das nicht.** `StrictMode.ThreadPolicy` mit `DetectAll()` erkennt Datenträger- und Netzwerkzugriffe auf dem Main-Thread, was eine nützliche benachbarte Prüfung ist, aber es ist blind für CPU-gebundene verwaltete Arbeit und für einen Thread, der auf einem verwalteten Lock blockiert. Beides sind ANR-Ursachen.

**Ihr ANR-Cluster ist vielleicht gar kein Handler.** Prüfen Sie den obersten Frame des Clusters in den Vitals, bevor Sie einen Tag darauf verwenden. `handleBindApplication` bedeutet langsamer Start. `nativePollOnce` bedeutet, der Main-Thread war untätig. Nur die Formen "beschäftigt" oder "blockiert" zeigen auf einen Handler.

**Liefern Sie die Instrumentierung nirgendwohin aus.** Der `Looper`-Printer alloziert eine Zeichenkette pro Nachricht, und der `SynchronizationContext`-Wrapper fügt pro geposteter Continuation einen `Stopwatch` und einen Closure hinzu. Beides ist günstig genug für eine Debugging-Sitzung auf einem Release-Build und beides ist in Produktion inakzeptabel. Kapseln Sie es hinter einer per MSBuild definierten Konstante (`<DefineConstants>$(DefineConstants);ANR_HUNT</DefineConstants>` in einer eigenen Build-Konfiguration), damit der Code nicht versehentlich in den Play Store gelangt.

**Achten Sie auf das API-Level.** Die Budgets für Broadcast Receiver wurden unter Android 14 enger, und ein Receiver, der bequem unter 10 Sekunden lag, kann unter CPU-Druck nun in das 10-20-Sekunden-Fenster gedrängt werden. Nach einem kürzlichen Retargeting gleichen Sie das mit [den Änderungen auf API-Level 36](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) ab.

Das Muster hinter allem: `async void` ist nicht der Fehler. Es ist das Konstrukt, das den Fehler unsichtbar macht. Es entfernt den Rückgabewert, mit dem ein Aufrufer hätte warten können, den Ausnahmepfad, der Ihnen das Scheitern gemeldet hätte, und die Compiler-Warnung, die es markiert hätte. Die Zustandsmaschine zu benennen ist der Weg, diese Sichtbarkeit zurückzuholen.

## Verwandte Beiträge

- [async void vs async Task in C#: wann welches korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Lösung: Deadlock beim Aufruf von .Result oder .Wait() auf einer async-Methode in C#](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Eine .NET MAUI Android-App in .NET 11 von Mono zu CoreCLR migrieren](/de/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)
- [ConfigureAwait(false) vs. Standard in .NET 11: spielt es noch eine Rolle?](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Von blockierenden .Result/.Wait()-Aufrufen zu durchgehend asynchronem Code in einer alten C#-Codebasis migrieren](/de/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)

## Quellen

- [Diagnose and fix ANRs, Android Developers](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs)
- [ANRs, Android-Dokumentation zur App-Qualität](https://developer.android.com/topic/performance/vitals/anr)
- [Technische Qualitätsanforderungen der Play Console](https://support.google.com/googleplay/android-developer/answer/17492799)
- [Performance-Profiling in .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/profiling)
- [Dokumentation zu dotnet-dsrouter, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter)
- [Tracing .NET for Android applications, dotnet/android](https://github.com/dotnet/android/blob/main/Documentation/guides/tracing.md)
- [Dokumentation der Analyzer VSTHRD100 und VSTHRD101, microsoft/vs-threading](https://github.com/microsoft/vs-threading/blob/main/docfx/analyzers/index.md)
- [VSTHRD100 False Positive bei Ereignishandlern, microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510)
- [CoreCLR ANR while running large app, dotnet/android#10588](https://github.com/dotnet/android/issues/10588)
- [Bug-Reports erfassen und lesen, Android-Studio-Dokumentation](https://developer.android.com/studio/debug/bug-report)
