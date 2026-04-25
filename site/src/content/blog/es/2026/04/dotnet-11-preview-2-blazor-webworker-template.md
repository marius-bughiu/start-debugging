---
title: "dotnet new webworker: Web Workers de primera clase para Blazor en .NET 11 Preview 2"
description: "Una nueva plantilla de proyecto en .NET 11 Preview 2 genera la fontanería JS, el WebWorkerClient, y el boilerplate de JSExport necesarios para correr código .NET en un Web Worker del navegador."
pubDate: 2026-04-05
tags:
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "aspnet-core"
lang: "es"
translationOf: "2026/04/dotnet-11-preview-2-blazor-webworker-template"
translatedBy: "claude"
translationDate: 2026-04-25
---

Correr trabajo pesado de CPU en Blazor WebAssembly siempre ha tenido el mismo desagradable efecto secundario: el hilo de UI se atasca, las animaciones se entrecortan, y el usuario sospecha que su navegador se ha colgado. En [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) el equipo entregó una solución apropiada para ese problema en forma de una plantilla de proyecto nuevecita, `dotnet new webworker`, que genera cada pieza de la fontanería que antes tenías que hacer a mano.

## Qué te da realmente la plantilla

La plantilla produce una biblioteca de clases Razor apuntando a `net11.0` que contiene:

1. El bootstrapper de JavaScript que arranca un Web Worker dedicado y lanza el runtime de .NET dentro de él.
2. Un tipo C# `WebWorkerClient` que oculta la capa de interop de `postMessage`.
3. Un método de muestra `[JSExport]` que puedes llamar desde cualquier componente.

El detalle importante es que nada de esto depende de Blazor en sí. La plantilla funciona para aplicaciones `wasmbrowser` independientes, frontends JS personalizados, y Blazor WebAssembly por igual. Lo conectas con una sola llamada:

```bash
dotnet new blazorwasm -n SampleApp
dotnet new webworker -n WebWorker
dotnet sln SampleApp.sln add WebWorker/WebWorker.csproj
dotnet add SampleApp/SampleApp.csproj reference WebWorker/WebWorker.csproj
```

## Definiendo un método worker

Los métodos worker son métodos estáticos planos decorados con `[JSExport]`. El runtime dentro del worker los ve por su nombre completamente calificado.

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

Los métodos `[JSExport]` siguen estando limitados a primitivas y cadenas como tipos de retorno, así que cualquier cosa no trivial necesita un round-trip de JSON. El `WebWorkerClient` deserializa el resultado automáticamente por ti del otro lado.

## Llamándolo desde un componente Blazor

Esta es la parte que solía ser 200 líneas de interop. En .NET 11 son tres:

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

`WebWorkerClient.CreateAsync` arranca el worker, espera a que el runtime de .NET dentro de él esté listo, y devuelve un cliente que invocas por nombre de método completamente calificado. El hilo principal nunca se bloquea, así que tus llamadas a `StateHasChanged` mantienen la UI fluida mientras dos millones de números se factorizan en un hilo de SO en segundo plano.

## Por qué esto importa

Antes de .NET 11, la comunidad Blazor se apoyaba en paquetes de terceros como [Tewr/BlazorWorker](https://github.com/Tewr/BlazorWorker) o rodaba un puente `JSImport`/`JSExport` a medida cada vez. La nueva plantilla elimina esa clase de boilerplate completamente, se entrega como la ruta bendecida desde Microsoft, y se compone con los generadores de fuente JSImport/JSExport existentes. Si has estado posponiendo trabajo en segundo plano en Blazor porque el costo de la fontanería era demasiado alto, Preview 2 es la versión que hace ese costo cero. Las notas de versión completas están en el [anuncio de .NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) y en los [docs actualizados de .NET en Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-10.0).
