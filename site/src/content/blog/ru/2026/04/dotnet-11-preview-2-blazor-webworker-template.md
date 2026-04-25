---
title: "dotnet new webworker: первоклассные Web Workers для Blazor в .NET 11 Preview 2"
description: "Новый шаблон проекта в .NET 11 Preview 2 генерирует JS-сантехнику, WebWorkerClient и шаблонный JSExport-код, необходимый для запуска .NET-кода в Web Worker браузера."
pubDate: 2026-04-05
tags:
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "aspnet-core"
lang: "ru"
translationOf: "2026/04/dotnet-11-preview-2-blazor-webworker-template"
translatedBy: "claude"
translationDate: 2026-04-25
---

Запуск тяжёлой по CPU работы в Blazor WebAssembly всегда имел один и тот же неприятный побочный эффект: поток UI зависает, анимации дёргаются, и пользователь подозревает, что его браузер упал. В [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) команда выпустила правильное исправление этой проблемы в виде совершенно нового шаблона проекта `dotnet new webworker`, который генерирует каждую часть сантехники, которую раньше приходилось писать руками.

## Что шаблон вам реально даёт

Шаблон создаёт Razor class library, нацеленную на `net11.0`, которая содержит:

1. JavaScript-загрузчик, который запускает выделенный Web Worker и поднимает в нём среду выполнения .NET.
2. C#-тип `WebWorkerClient`, скрывающий слой interop через `postMessage`.
3. Образец метода `[JSExport]`, который вы можете вызвать из любого компонента.

Важная деталь -- ничто из этого не зависит от самого Blazor. Шаблон работает для standalone-приложений `wasmbrowser`, кастомных JS-фронтендов и Blazor WebAssembly одинаково. Вы подключаете его одним вызовом:

```bash
dotnet new blazorwasm -n SampleApp
dotnet new webworker -n WebWorker
dotnet sln SampleApp.sln add WebWorker/WebWorker.csproj
dotnet add SampleApp/SampleApp.csproj reference WebWorker/WebWorker.csproj
```

## Определение worker-метода

Worker-методы -- это обычные статические методы, помеченные `[JSExport]`. Среда выполнения внутри worker видит их по полностью квалифицированному имени.

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

Методы `[JSExport]` всё ещё ограничены примитивами и строками в качестве типов возврата, поэтому всё нетривиальное требует JSON-round-trip. `WebWorkerClient` автоматически десериализует результат на другой стороне.

## Вызов из компонента Blazor

Это та часть, что раньше была 200 строками interop. В .NET 11 их три:

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

`WebWorkerClient.CreateAsync` загружает worker, ждёт, пока .NET runtime внутри него готов, и возвращает клиента, которого вы вызываете по полностью квалифицированному имени метода. Главный поток никогда не блокируется, поэтому ваши вызовы `StateHasChanged` сохраняют UI плавным, пока два миллиона чисел факторизуются на фоновом потоке ОС.

## Почему это важно

До .NET 11 сообщество Blazor полагалось на сторонние пакеты вроде [Tewr/BlazorWorker](https://github.com/Tewr/BlazorWorker) или каждый раз накатывало кастомный `JSImport`/`JSExport` мост. Новый шаблон полностью устраняет этот класс шаблонного кода, поставляется как благословлённый путь от Microsoft и компонуется с существующими JSImport/JSExport генераторами исходного кода. Если вы откладывали фоновую работу в Blazor, потому что стоимость сантехники была слишком высокой, Preview 2 -- это релиз, который делает эту стоимость нулевой. Полные заметки о выпуске в [анонсе .NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) и обновлённой [документации .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-10.0).
