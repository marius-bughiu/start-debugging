---
title: "dotnet new webworker: erstklassige Web Workers für Blazor in .NET 11 Preview 2"
description: "Eine neue Projektvorlage in .NET 11 Preview 2 scaffoldet die JS-Klempnerei, den WebWorkerClient und das JSExport-Boilerplate, das nötig ist, um .NET-Code in einem Browser-Web-Worker auszuführen."
pubDate: 2026-04-05
tags:
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "aspnet-core"
lang: "de"
translationOf: "2026/04/dotnet-11-preview-2-blazor-webworker-template"
translatedBy: "claude"
translationDate: 2026-04-25
---

CPU-intensive Arbeit in Blazor WebAssembly hatte schon immer denselben üblen Nebeneffekt: der UI-Thread stockt, Animationen ruckeln, und der Benutzer vermutet, sein Browser sei abgestürzt. In [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) hat das Team einen ordentlichen Fix für dieses Problem geliefert, in Form einer brandneuen Projektvorlage, `dotnet new webworker`, die jedes Stück Klempnerei scaffoldet, das Sie zuvor selbst zusammenstellen mussten.

## Was die Vorlage Ihnen tatsächlich gibt

Die Vorlage erzeugt eine Razor-Klassenbibliothek, die auf `net11.0` zielt und Folgendes enthält:

1. Den JavaScript-Bootstrapper, der einen dedizierten Web Worker startet und die .NET-Laufzeit darin hochfährt.
2. Einen C#-Typ `WebWorkerClient`, der die `postMessage`-Interop-Schicht versteckt.
3. Eine Beispiel-`[JSExport]`-Methode, die Sie aus jeder Komponente aufrufen können.

Das wichtige Detail ist, dass nichts davon von Blazor selbst abhängt. Die Vorlage funktioniert für eigenständige `wasmbrowser`-Apps, benutzerdefinierte JS-Frontends und Blazor WebAssembly gleichermaßen. Sie verdrahten sie mit einem einzigen Aufruf:

```bash
dotnet new blazorwasm -n SampleApp
dotnet new webworker -n WebWorker
dotnet sln SampleApp.sln add WebWorker/WebWorker.csproj
dotnet add SampleApp/SampleApp.csproj reference WebWorker/WebWorker.csproj
```

## Eine Worker-Methode definieren

Worker-Methoden sind einfache statische Methoden, die mit `[JSExport]` dekoriert sind. Die Laufzeit innerhalb des Workers sieht sie an ihrem voll qualifizierten Namen.

```csharp
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

namespace WebWorker;

public static partial class PrimesWorker
{
    [JSExport]
    public static string ComputePrimes(int limit)
    {
        var primes = new List<int>();
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) primes.Add(n);
        }

        return JsonSerializer.Serialize(new { Count = primes.Count, Last = primes[^1] });
    }
}
```

`[JSExport]`-Methoden sind weiterhin auf Primitive und Strings als Rückgabetypen beschränkt, daher braucht alles Nichttriviale einen JSON-Round-Trip. Der `WebWorkerClient` deserialisiert das Ergebnis auf der anderen Seite automatisch für Sie.

## Aus einer Blazor-Komponente aufrufen

Das ist der Teil, der früher 200 Zeilen Interop war. In .NET 11 sind es drei:

```razor
@inject IJSRuntime JS

<button @onclick="Run">Find primes</button>
<p>@status</p>

@code {
    string status = "";

    async Task Run()
    {
        await using var worker = await WebWorkerClient.CreateAsync(JS);
        var result = await worker.InvokeAsync<PrimeResult>(
            "WebWorker.PrimesWorker.ComputePrimes",
            args: new object[] { 2_000_000 });

        status = $"Found {result.Count}, last was {result.Last}";
    }

    record PrimeResult(int Count, int Last);
}
```

`WebWorkerClient.CreateAsync` startet den Worker, wartet, bis die .NET-Laufzeit darin bereit ist, und gibt einen Client zurück, den Sie über den voll qualifizierten Methodennamen aufrufen. Der Hauptthread blockiert nie, sodass Ihre `StateHasChanged`-Aufrufe die UI flüssig halten, während zwei Millionen Zahlen auf einem OS-Hintergrundthread faktorisiert werden.

## Warum das wichtig ist

Vor .NET 11 verließ sich die Blazor-Community auf Drittanbieter-Pakete wie [Tewr/BlazorWorker](https://github.com/Tewr/BlazorWorker) oder bastelte jedes Mal eine maßgeschneiderte `JSImport`/`JSExport`-Brücke. Die neue Vorlage entfernt diese Klasse von Boilerplate vollständig, wird als der gesegnete Pfad von Microsoft ausgeliefert und komponiert sich mit den bestehenden JSImport/JSExport-Source-Generators. Falls Sie Hintergrundarbeit in Blazor verschoben haben, weil die Klempnereikosten zu hoch waren, ist Preview 2 das Release, das diese Kosten auf null senkt. Vollständige Release Notes im [.NET 11 Preview 2-Announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) und in der aktualisierten [.NET on Web Workers-Doku](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-10.0).
