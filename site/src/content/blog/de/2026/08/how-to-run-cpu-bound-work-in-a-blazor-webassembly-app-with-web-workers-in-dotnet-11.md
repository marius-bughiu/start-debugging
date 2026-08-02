---
title: "CPU-intensive Arbeit in einer Blazor WebAssembly App mit Web Workers in .NET 11 ausführen"
description: "Ein vollständiger Leitfaden, um CPU-intensive Arbeit in .NET 11 vom UI-Thread von Blazor WebAssembly zu nehmen: warum Task.Run nicht hilft, die neue blazorwebworker-Vorlage, die WebWorkerClient-API mit Abbruch und Timeouts, die Marshalling-Grenzen von JSExport und die Kosten der zweiten Laufzeit pro Worker."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "performance"
lang: "de"
translationOf: "2026/08/how-to-run-cpu-bound-work-in-a-blazor-webassembly-app-with-web-workers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Blazor WebAssembly führt Ihren .NET-Code auf dem einzigen UI-Thread des Browsers aus, deshalb friert eine enge `for`-Schleife die Seite ein: keine Neuzeichnungen, keine Klicks, kein `StateHasChanged`. `Task.Run` rettet Sie nicht, weil es keinen zweiten Thread gibt, auf dem etwas laufen könnte. Die Lösung in .NET 11 ist die Projektvorlage `blazorwebworker`, die eine Klassenbibliothek erzeugt, deren Methoden in einem echten Browser Web Worker auf einem separaten Betriebssystem-Thread laufen. Sie markieren diese Methoden mit `[JSExport]`, referenzieren die Bibliothek aus Ihrer App und rufen sie über `WebWorkerClient.InvokeAsync<TResult>` auf.

Alles Folgende zielt auf .NET 11 (zum Zeitpunkt des Schreibens Preview 6, SDK `11.0.100-preview.6`) mit C# 14. Die Vorlage erschien in .NET 11 Preview 1 unter dem Namen `webworker` und wurde vor dem Release [in `blazorwebworker` umbenannt](https://github.com/dotnet/aspnetcore/pull/66070); mit dem alten Namen erzeugte Projekte funktionieren weiterhin, nur die Vorlagen-ID hat sich geändert. Zwei Funktionen sind im finalen .NET 11 Client neu: `InvokeVoidAsync` sowie Unterstützung für Abbruch und Timeout sowohl bei der Worker-Erstellung als auch beim Aufruf.

## Die sechs Schritte, von Anfang bis Ende

1. Erstellen Sie mit `dotnet new blazorwebworker` eine Worker-Klassenbibliothek und referenzieren Sie sie aus der Blazor WebAssembly App.
2. Schreiben Sie Ihren CPU-intensiven Code als `static` Methoden mit `[JSExport]` innerhalb einer `static partial class`.
3. Geben Sie nur primitive Typen oder Zeichenfolgen zurück; serialisieren Sie alles Komplexere innerhalb des Workers zu JSON.
4. Erstellen Sie den `WebWorkerClient` einmal (nicht pro Aufruf) und halten Sie ihn für die Lebensdauer der Komponente oder der App.
5. Rufen Sie Methoden über ihren vollqualifizierten Namen auf und übergeben Sie ein `CancellationToken` und ein Timeout.
6. Geben Sie den Client frei, um den Worker zu beenden und die zweite Laufzeit freizugeben, die er geladen hat.

Der Rest dieses Beitrags erklärt, warum jeder Punkt wichtig ist und was bricht, wenn einer übersprungen wird.

## Warum `Task.Run` die Arbeit nicht vom UI-Thread nimmt

Das ist das Erste, was Entwickler versuchen, und es lohnt sich zu verstehen, warum es genau scheitert, bevor man zu Workern greift.

```csharp
// .NET 11, C# 14 - Blazor WebAssembly. This still freezes the browser.
private async Task Compute()
{
    status = "Working...";
    await Task.Run(() => CountPrimes(5_000_000));
    status = "Done";
}

private static int CountPrimes(int limit)
{
    var count = 0;
    for (var n = 2; n <= limit; n++)
    {
        var isPrime = true;
        for (var d = 2; d * d <= n; d++)
        {
            if (n % d == 0) { isPrime = false; break; }
        }
        if (isPrime) count++;
    }

    return count;
}
```

Die Zeile `status = "Working..."` wird nie gerendert. Der Browser-Tab reagiert für mehrere Sekunden nicht, und danach erscheinen beide Statusaktualisierungen auf einmal.

Der Grund ist, dass die Blazor WebAssembly Laufzeit Single-Threaded ist. `Task.Run` stellt Arbeit in den .NET Thread-Pool ein, aber auf der `browser-wasm`-Laufzeit wird dieser Pool auf dem einen Thread emuliert, den die Laufzeit besitzt. Das Delegate startet nicht, bevor der aktuelle synchrone Block die Kontrolle abgibt, und sobald es startet, kann nichts anderes dazwischenkommen, bis es zurückkehrt. Ein `await Task.Delay(1)` vor der Schleife lässt das erste Rendering durch, aber die Schleife blockiert weiterhin alles danach.

Die naheliegende Anschlussfrage ist, ob man Threads nicht einfach einschalten kann. Die Laufzeit unterstützt `<WasmEnableThreads>true</WasmEnableThreads>`, aber das ist eine Funktion auf Laufzeitebene, und Blazor WebAssembly unterstützt sie nicht. Der Renderer von Blazor verlässt sich auf die historische Single-Thread-Garantie: Render-Batches werden über kopierfreien Shared Memory an JavaScript übergeben, und Ereignisse werden synchron nach .NET zugestellt. Die Multithread-Laufzeit verlagert den gesamten .NET-Code auf einen Hintergrund-"Deputy-Thread", was beide Annahmen bricht. Das Tracking-Issue [dotnet/aspnetcore#54365](https://github.com/dotnet/aspnetcore/issues/54365) ist weiterhin offen. Das Flag in einem Blazor WASM Projekt zu setzen liefert einen Build, der nicht läuft, keine schnellere App.

Die einzige echte Option ist also, eine zweite, unabhängige Kopie der .NET-Laufzeit in einem Web Worker auszuführen und über Nachrichtenaustausch mit ihr zu sprechen. Genau das baut die Vorlage.

## Das Worker-Projekt erstellen

Zwei Befehle und eine Projektreferenz:

```bash
# .NET 11 SDK
dotnet new blazorwasm -n SampleApp
dotnet new blazorwebworker -n WebWorker

cd SampleApp
dotnet add reference ../WebWorker/WebWorker.csproj
```

Die erzeugte Bibliothek sieht so aus:

```
WebWorker/
├── WebWorker.csproj
├── WebWorkerClient.cs
├── WorkerMethods.cs
└── wwwroot/
    ├── dotnet-web-worker-client.js
    └── dotnet-web-worker.js
```

`dotnet-web-worker.js` ist der Einstiegspunkt des Workers. Es ruft `dotnet.create()` auf, um eine WebAssembly-Laufzeit ganz ohne Blazor-Schicht zu starten, dann `getAssemblyExports(assemblyName)`, um einen Handle auf Ihre `[JSExport]`-Methoden zu bekommen, und löst eingehende Methodennamen gegen diesen Objektgraphen auf. `dotnet-web-worker-client.js` läuft auf dem Haupt-Thread, startet den Worker und ordnet Anfragen und Antworten per ID einander zu. `WebWorkerClient.cs` ist der C#-Wrapper über diesen JavaScript-Client. Sie müssen keine der drei Dateien bearbeiten.

Eine Projekteigenschaft ist wichtig, und die Vorlage setzt sie bereits:

```xml
<PropertyGroup>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

`[JSExport]` und `[JSImport]` erzeugen Marshalling-Code, der Zeiger verwendet, deshalb verweigert der Compiler ohne diese Eigenschaft. Wenn Sie später `[JSImport]`-Aufrufe im Projekt der Blazor App selbst hinzufügen, brauchen Sie dieselbe Eigenschaft dort.

## Die Worker-Methoden schreiben

Worker-Methoden sind `static`, mit `[JSExport]` markiert und liegen in einer `static partial class`. Das `partial` ist nicht dekorativ: Der Source Generator für JS-Interop erzeugt die andere Hälfte. `[SupportedOSPlatform("browser")]` unterdrückt die Warnungen des Plattformkompatibilitäts-Analyzers, da diese APIs nur auf der Browser-Laufzeit existieren.

`WebWorker/WorkerMethods.cs`:

```csharp
// .NET 11, C# 14
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;

namespace WebWorker;

[SupportedOSPlatform("browser")]
public static partial class WorkerMethods
{
    [JSExport]
    public static int CountPrimes(int limit)
    {
        var count = 0;
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) count++;
        }

        return count;
    }

    [JSExport]
    public static string Analyze(string csv)
    {
        var rows = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var report = new Report(rows.Length, rows.Length == 0 ? 0 : rows.Max(r => r.Length));
        return JsonSerializer.Serialize(report);
    }
}

public record Report(int RowCount, int WidestRow);
```

Beachten Sie die Form von `Analyze`. `[JSExport]` marshallt einen festen Satz von Typen über die JavaScript-Grenze: primitive Typen, `string`, `byte[]`, `Task<T>` davon und einige JS-spezifische Typen. Beliebige POCOs oder Records werden nicht gemarshallt. Der übliche Ausweg ist, im Worker zu serialisieren und auf der anderen Seite zu deserialisieren, so wie es die Dokumentation empfiehlt und das erzeugte Beispiel es macht. Wenn Ihre Nutzlast eine polymorphe Hierarchie ist, gilt die [Diskriminator-Konfiguration mit `[JsonDerivedType]`](/de/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) hier unverändert, weil beide Enden System.Text.Json sind.

Ebenfalls wissenswert: `byte[]` überquert die Grenze direkt, und der erzeugte Client optimiert `ArrayBuffer`-Übertragungen, sodass große binäre Ergebnisse verschoben statt kopiert werden. Wenn Sie Bild- oder Dateibytes zurückgeben, bevorzugen Sie `byte[]` gegenüber Base64 in einer JSON-Zeichenfolge.

## Den Worker aus einer Komponente aufrufen

`WebWorkerClient.CreateAsync` startet den Worker und wartet, bis die Laufzeit darin bereit meldet. Das ist eine asynchrone Operation mit einem Netzwerkabruf, gehört also in `OnAfterRenderAsync`, nicht in `OnInitializedAsync`.

`Pages/Home.razor.cs`:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using WebWorker;

namespace SampleApp.Pages;

[SupportedOSPlatform("browser")]
public partial class Home : ComponentBase, IAsyncDisposable
{
    private WebWorkerClient? worker;
    private string status = "Booting worker...";

    [Inject] private IJSRuntime JSRuntime { get; set; } = default!;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            worker = await WebWorkerClient.CreateAsync(JSRuntime);
            status = "Ready";
            StateHasChanged();
        }
    }

    private async Task Run()
    {
        if (worker is null) return;

        status = "Working...";

        var count = await worker.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes", [5_000_000]);

        status = $"Found {count} primes";
    }

    public async ValueTask DisposeAsync()
    {
        if (worker is not null)
        {
            await worker.DisposeAsync();
        }
    }
}
```

Jetzt wird `status = "Working..."` sofort gerendert, der Spinner dreht sich, und die Oberfläche bleibt bedienbar, während fünf Millionen Zahlen auf einem anderen Betriebssystem-Thread faktorisiert werden.

Der Methodenname ist eine Zeichenfolge: `AssemblyName.ClassName.MethodName`. Der Worker zerlegt sie und durchläuft das Exports-Objekt, das `getAssemblyExports` zurückgibt, ein Tippfehler ist also ein Laufzeitfehler und kein Compilerfehler. Jeden Aufruf in eine kleine typisierte Methode einer Service-Klasse zu kapseln ist die zehn Zeilen wert, weil es einen einzigen Ort schafft, an dem die magischen Zeichenfolgen leben.

Die Platzierung in `OnAfterRenderAsync` ist keine Stilfrage. In einer Blazor Web App, deren `.Client`-Projekt serverseitig vorgerendert wird, ist JS-Interop während des Prerender-Durchlaufs nicht verfügbar, und ein Aufruf dort löst den Fehler [JavaScript interop calls cannot be issued at this time](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) aus. `OnAfterRenderAsync` läuft erst, nachdem die Interaktivität hergestellt ist, der Worker wird also genau einmal erzeugt, auf dem Client.

## Abbruch und Timeouts

Das ist die Ergänzung in .NET 11, die den Client produktionstauglich macht. Die vollständige Oberfläche:

```csharp
// .NET 11
public sealed class WebWorkerClient : IAsyncDisposable
{
    public static async Task<WebWorkerClient> CreateAsync(
        IJSRuntime jsRuntime,
        int timeoutMs = 60000,
        string? assemblyName = null,
        CancellationToken cancellationToken = default);

    public async Task<TResult> InvokeAsync<TResult>(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async Task InvokeVoidAsync(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async ValueTask DisposeAsync();
}
```

Sowohl `timeoutMs` als auch das Token schützen das Warten des Haupt-Threads, nicht die Ausführung im Worker. Eine `[JSExport]`-Methode, die eine synchrone Schleife ausführt, kann kein `CancellationToken` beobachten, weil es keine Möglichkeit gibt, sie von außen zu unterbrechen. Was der Abbruch bringt, ist die Möglichkeit, das Warten zu beenden und einen hängenden Worker abzubauen:

```csharp
// .NET 11, C# 14
private CancellationTokenSource? cts;

private async Task RunCancellable()
{
    cts?.Cancel();
    cts?.Dispose();
    cts = new CancellationTokenSource();

    try
    {
        var count = await worker!.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes",
            [5_000_000],
            timeoutMs: 10_000,
            cancellationToken: cts.Token);

        status = $"Found {count} primes";
    }
    catch (OperationCanceledException)
    {
        status = "Cancelled";

        // The worker is still busy. Kill it and start a fresh one.
        await worker.DisposeAsync();
        worker = await WebWorkerClient.CreateAsync(JSRuntime);
    }
}

private void Cancel() => cts?.Cancel();
```

Das Freigeben nach einem Abbruch ist die wichtige Hälfte. Wenn Sie das Warten abbrechen, aber den Client behalten, verbrennt die aufgegebene Berechnung weiter einen Kern, und der nächste `InvokeAsync` reiht sich dahinter ein. `DisposeAsync` ruft `terminate()` auf dem zugrunde liegenden `Worker` auf, was ihn sofort stoppt, egal was er gerade tut. Die allgemeine Form, ein Token durch eine Aufrufkette zu reichen, behandelt der Leitfaden zum [Weitergeben eines CancellationToken durch asynchrone Methoden](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), und [`CancellationTokenSource.CancelAfter`](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) lässt sich mit `timeoutMs` kombinieren, wenn Sie eine clientseitige Frist wollen, die auch Ihre eigene Aufräumlogik auslöst.

Für Arbeit, deren Ergebnis Sie nicht brauchen, überspringt `InvokeVoidAsync` den Rückweg des Ergebnisses:

```csharp
await worker.InvokeVoidAsync("WebWorker.WorkerMethods.WarmCaches", []);
```

## Die Kosten: jeder Worker lädt seine eigene Laufzeit

Das ist der Teil, der überrascht, und er treibt die meisten der obigen Designentscheidungen.

Der Worker teilt sich nicht die Laufzeit des Haupt-Threads. Er startet eine zweite, vollständige .NET WebAssembly Laufzeit: `dotnet.js`, das `.wasm` der Laufzeit und jede Assembly, die Ihre Worker-Bibliothek transitiv referenziert. Der HTTP-Cache des Browsers macht den zweiten Abruf nach dem ersten Laden meist günstig, aber die Instanziierung ist nicht kostenlos, und der Speicher verdoppelt sich tatsächlich, weil die beiden Laufzeiten getrennte Heaps haben.

Die praktischen Regeln, die daraus folgen:

- **Erstellen Sie den Client einmal und verwenden Sie ihn dauerhaft wieder.** Ein `CreateAsync` pro Klick ist der häufigste Weg, einen Worker langsamer zu machen als den Code, den er ersetzt hat.
- **Für app-weite Nutzung registrieren Sie ihn als Singleton** und initialisieren ihn verzögert, statt ihn pro Komponente zu erzeugen:

  ```csharp
  // .NET 11, C# 14 - Program.cs of the Blazor WebAssembly app
  builder.Services.AddSingleton<WorkerService>();
  ```

  ```csharp
  public sealed class WorkerService(IJSRuntime js) : IAsyncDisposable
  {
      private WebWorkerClient? client;
      private readonly SemaphoreSlim gate = new(1, 1);

      private async Task<WebWorkerClient> GetClientAsync(CancellationToken ct)
      {
          if (client is not null) return client;

          await gate.WaitAsync(ct);
          try
          {
              return client ??= await WebWorkerClient.CreateAsync(js, cancellationToken: ct);
          }
          finally
          {
              gate.Release();
          }
      }

      public async Task<int> CountPrimesAsync(int limit, CancellationToken ct = default)
      {
          var c = await GetClientAsync(ct);
          return await c.InvokeAsync<int>(
              "WebWorker.WorkerMethods.CountPrimes", [limit], cancellationToken: ct);
      }

      public async ValueTask DisposeAsync()
      {
          if (client is not null) await client.DisposeAsync();
          gate.Dispose();
      }
  }
  ```

  Das Semaphor ist wichtig, weil zwei gleichzeitig rendernde Komponenten beide `client is null` sehen und beide `CreateAsync` aufrufen, sodass Sie zwei Laufzeiten bekommen, wo Sie eine wollten.

- **Halten Sie den Abhängigkeitsgraphen der Worker-Bibliothek klein.** Jedes Paket, das Sie aus dem Worker-Projekt referenzieren, ist eine zusätzliche Assembly, die heruntergeladen und in die zweite Laufzeit geladen wird. Legen Sie dort nur den Rechencode ab, nicht Ihre gemeinsame Modellbibliothek mit EF Core und Validierung im Schlepptau.
- **Fassen Sie Aufrufe zusammen.** Jeder Aufruf ist ein `postMessage`-Roundtrip mit einem Serialisierungsschritt an beiden Enden. Zehn Aufrufe in einer Schleife sind messbar schlechter als ein Aufruf mit einem Array-Argument.

## Was die Grenze nicht überquert

Der Worker ist eine wirklich eigenständige Laufzeit, und ihn wie einen Hintergrund-Thread im selben Prozess zu behandeln ist die Quelle der Fehler.

**Kein gemeinsamer Zustand.** Statische Felder in Ihrer Worker-Assembly existieren zweimal: eine Kopie in der Laufzeit des Haupt-Threads, eine im Worker. Aus einer Komponente in ein statisches Feld zu schreiben und es aus einer `[JSExport]`-Methode zu lesen liefert das, was die Kopie des Workers gerade enthält. Aller Zustand muss in den Argumenten und im Rückgabewert reisen.

**Keine Dependency Injection.** Worker-Methoden sind statisch, und die Laufzeit des Workers baut nie einen Service Provider auf. Wenn Ihr Rechencode Konfiguration braucht, übergeben Sie sie als Argumente oder als JSON-Blob.

**Kein DOM, kein `IJSRuntime`, kein `NavigationManager`.** Ein Web Worker hat weder `document` noch `window`. Alles, was die Oberfläche berührt, muss zurück auf dem Haupt-Thread passieren, nachdem `InvokeAsync` zurückgekehrt ist.

**Keine Fortschritts-Callbacks ab Werk.** Der erzeugte Client modelliert Anfrage und Antwort, kein Streaming. Wenn Sie einen Fortschrittsbalken für eine lange Berechnung brauchen, teilen Sie die Arbeit in Stücke und machen einen Aufruf pro Stück, wobei Sie die Oberfläche zwischen den Aufrufen aktualisieren.

## Debugging und Trimming, die zwei rauen Kanten

Ausnahmen, die in einer `[JSExport]`-Methode geworfen werden, kommen als Nachrichtenzeichenfolge über `postMessage` zurück, der C# Stack Trace auf dem Haupt-Thread beschreibt also die Interop-Schicht und nicht Ihre Schleife. Wenn sich eine Worker-Methode falsch verhält, ist der schnellste Weg meist, dieselbe statische Methode vorübergehend direkt aus der Komponente aufzurufen, sie mit angehängtem Debugger auf dem Haupt-Thread zu reproduzieren und sie dann zurückzuverschieben.

Trimming ist die zweite Sache, auf die zu achten ist. Veröffentlichte Blazor Apps trimmen aggressiv, und der Worker löst Ihre Methoden zur Laufzeit über `getAssemblyExports` namentlich auf. Das Attribut `[JSExport]` hält diese Methoden verwurzelt, eine exportierte Methode ist also sicher. Alles, was sie nur über Reflexion erreicht, ist es nicht. Wenn ein Worker-Aufruf unter `dotnet run` funktioniert und nach `dotnet publish` fehlschlägt, ist Reflexion plus Trimming die erste zu prüfende Hypothese, und dieselben [Trim-Sicherheitsregeln, die für Native AOT gelten](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/), gelten auch hier.

Seien Sie schließlich ehrlich dazu, ob Sie das überhaupt brauchen. Wenn Sie eine Blazor Web App statt einer eigenständigen WebAssembly App bauen, kann der Server die Berechnung meist schneller erledigen, als der Client eine zweite Laufzeit hochfährt, und ein einfacher API-Aufruf ist weniger Maschinerie für dasselbe Ergebnis. Die Abwägungen zwischen den Hosting-Modellen legt der Vergleich von [Blazor Server, WebAssembly und United](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) dar. Web Workers sind die richtige Antwort, wenn die Daten bereits auf dem Client liegen, wenn die Arbeit wirklich CPU-gebunden statt IO-gebunden ist und wenn ein Roundtrip zum Server nicht akzeptabel ist. Für alles andere bleibt der Server ein Thread-Pool mit besserer Hardware.

## Verwandte Beiträge

- [dotnet new webworker: erstklassige Web Workers für Blazor in .NET 11 Preview 2](/de/2026/04/dotnet-11-preview-2-blazor-webworker-template/)
- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Ein CancellationToken durch asynchrone Methoden in .NET 11 weitergeben](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time beim Blazor Prerendering](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Eine polymorphe Typhierarchie mit JsonDerivedType in System.Text.Json serialisieren](/de/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Ein Dart Isolate für CPU-intensive Arbeit schreiben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)

## Quellen

- [ASP.NET Core Blazor with .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-with-dotnet-on-web-workers?view=aspnetcore-11.0), Microsoft Learn
- [.NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-11.0), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11: New Blazor Web Worker template](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0), Microsoft Learn
- [.NET Web Worker template update to Blazor Web Worker template (dotnet/aspnetcore #66070)](https://github.com/dotnet/aspnetcore/pull/66070), GitHub
- [Make Blazor WebAssembly work on multithreaded runtime (dotnet/aspnetcore #54365)](https://github.com/dotnet/aspnetcore/issues/54365), GitHub
- [JSExportAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.javascript.jsexportattribute), Microsoft Learn
- [Running background tasks in Blazor with Web Workers](https://andrewlock.net/exploring-the-dotnet-11-preview-1-running-background-tasks-in-blazor-with-web-workers/), Andrew Lock
- [Web Workers API](https://developer.mozilla.org/docs/Web/API/Web_Workers_API), MDN
