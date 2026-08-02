---
title: "Как выполнять ресурсоёмкие вычисления в приложении Blazor WebAssembly с помощью Web Workers в .NET 11"
description: "Полное руководство по выносу ресурсоёмких вычислений с UI-потока Blazor WebAssembly в .NET 11: почему Task.Run не помогает, новый шаблон blazorwebworker, API WebWorkerClient с отменой и таймаутами, ограничения маршалинга JSExport и цена второй среды выполнения на каждый worker."
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
lang: "ru"
translationOf: "2026/08/how-to-run-cpu-bound-work-in-a-blazor-webassembly-app-with-web-workers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Blazor WebAssembly выполняет ваш .NET-код в единственном UI-потоке браузера, поэтому плотный цикл `for` замораживает страницу: нет перерисовок, нет кликов, нет `StateHasChanged`. `Task.Run` вас не спасёт, потому что второго потока, в котором можно было бы выполниться, просто нет. Решение в .NET 11 - это шаблон проекта `blazorwebworker`, который генерирует библиотеку классов, чьи методы выполняются внутри настоящего браузерного Web Worker в отдельном потоке операционной системы. Вы помечаете эти методы атрибутом `[JSExport]`, добавляете ссылку на библиотеку из своего приложения и вызываете их через `WebWorkerClient.InvokeAsync<TResult>`.

Всё изложенное ниже ориентировано на .NET 11 (на момент написания Preview 6, SDK `11.0.100-preview.6`) и C# 14. Шаблон появился в .NET 11 Preview 1 под именем `webworker` и был [переименован в `blazorwebworker`](https://github.com/dotnet/aspnetcore/pull/66070) до релиза; проекты, созданные под старым именем, продолжают работать, изменился только идентификатор шаблона. В финальном клиенте .NET 11 появились две новые возможности: `InvokeVoidAsync`, а также поддержка отмены и таймаута как при создании worker, так и при вызове.

## Шесть шагов от начала до конца

1. Создайте библиотеку классов worker командой `dotnet new blazorwebworker` и добавьте на неё ссылку из приложения Blazor WebAssembly.
2. Напишите ресурсоёмкий код в виде `static` методов, помеченных `[JSExport]`, внутри `static partial class`.
3. Возвращайте только примитивы или строки; всё более сложное сериализуйте в JSON внутри worker.
4. Создавайте `WebWorkerClient` один раз (а не на каждый вызов) и храните его в течение всей жизни компонента или приложения.
5. Вызывайте методы по полному имени, передавая `CancellationToken` и таймаут.
6. Освобождайте клиент, чтобы завершить worker и освободить загруженную им вторую среду выполнения.

Остальная часть статьи объясняет, почему каждый из шагов важен и что ломается, если пропустить любой из них.

## Почему `Task.Run` не выносит работу из UI-потока

Это первое, что все пробуют, и стоит понять, почему именно это не работает, прежде чем браться за workers.

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

Строка `status = "Working..."` никогда не отрисовывается. Вкладка браузера перестаёт отвечать на несколько секунд, а затем оба обновления статуса появляются разом.

Причина в том, что среда выполнения Blazor WebAssembly однопоточна. `Task.Run` ставит работу в пул потоков .NET, но в среде `browser-wasm` этот пул эмулируется на единственном потоке, которым владеет среда выполнения. Делегат не стартует, пока текущий синхронный блок не уступит управление, а когда он стартует, ничто другое не может вклиниться до его возврата. `await Task.Delay(1)` перед циклом пропускает первую отрисовку, но цикл всё равно блокирует всё, что идёт после него.

Очевидный следующий вопрос: нельзя ли просто включить потоки. Среда выполнения действительно поддерживает `<WasmEnableThreads>true</WasmEnableThreads>`, но это возможность уровня среды выполнения, и Blazor WebAssembly её не поддерживает. Рендерер Blazor опирается на историческую гарантию однопоточности: пакеты рендеринга передаются в JavaScript через разделяемую память без копирования, а события доставляются в .NET синхронно. Многопоточная среда выполнения переносит весь .NET-код в фоновый поток "deputy", что ломает оба этих предположения. Отслеживающий issue [dotnet/aspnetcore#54365](https://github.com/dotnet/aspnetcore/issues/54365) до сих пор открыт. Включение флага в проекте Blazor WASM даёт сборку, которая не запускается, а не более быстрое приложение.

Значит, единственный реальный вариант - запустить вторую независимую копию среды выполнения .NET внутри Web Worker и общаться с ней передачей сообщений. Именно это и строит шаблон.

## Создание проекта worker

Две команды и ссылка на проект:

```bash
# .NET 11 SDK
dotnet new blazorwasm -n SampleApp
dotnet new blazorwebworker -n WebWorker

cd SampleApp
dotnet add reference ../WebWorker/WebWorker.csproj
```

Сгенерированная библиотека выглядит так:

```
WebWorker/
├── WebWorker.csproj
├── WebWorkerClient.cs
├── WorkerMethods.cs
└── wwwroot/
    ├── dotnet-web-worker-client.js
    └── dotnet-web-worker.js
```

`dotnet-web-worker.js` - точка входа worker. Он вызывает `dotnet.create()`, чтобы поднять среду выполнения WebAssembly вообще без слоя Blazor, затем `getAssemblyExports(assemblyName)`, чтобы получить дескриптор ваших методов `[JSExport]`, и разрешает приходящие имена методов по этому графу объектов. `dotnet-web-worker-client.js` работает в главном потоке, создаёт worker и сопоставляет запросы с ответами по ID. `WebWorkerClient.cs` - это обёртка на C# над этим JavaScript-клиентом. Редактировать ни один из трёх файлов не нужно.

Одно свойство проекта имеет значение, и шаблон уже его задаёт:

```xml
<PropertyGroup>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

`[JSExport]` и `[JSImport]` генерируют код маршалинга, использующий указатели, поэтому без него компилятор откажется собирать проект. Если позже вы добавите вызовы `[JSImport]` в сам проект приложения Blazor, то же свойство понадобится и там.

## Написание методов worker

Методы worker объявляются `static`, помечаются `[JSExport]` и живут в `static partial class`. `partial` здесь не украшение: генератор исходного кода JS-interop дописывает вторую половину. `[SupportedOSPlatform("browser")]` подавляет предупреждения анализатора совместимости платформ, поскольку эти API существуют только в браузерной среде выполнения.

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

Обратите внимание на форму `Analyze`. `[JSExport]` маршалит через границу JavaScript фиксированный набор типов: примитивы, `string`, `byte[]`, `Task<T>` от них и несколько специфичных для JS типов. Произвольные POCO и record он не маршалит. Стандартный обходной путь - сериализовать внутри worker и десериализовать на другой стороне, именно это рекомендует документация и делает сгенерированный пример. Если ваша полезная нагрузка - полиморфная иерархия, [настройка дискриминатора `[JsonDerivedType]`](/ru/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) применяется здесь без изменений, потому что на обоих концах System.Text.Json.

Ещё полезно знать: `byte[]` пересекает границу напрямую, а сгенерированный клиент оптимизирует передачу `ArrayBuffer`, так что крупные бинарные результаты перемещаются, а не копируются. Если вы возвращаете байты изображения или файла, предпочитайте `byte[]` вместо base64 внутри JSON-строки.

## Вызов worker из компонента

`WebWorkerClient.CreateAsync` поднимает worker и ждёт, пока среда выполнения внутри него сообщит о готовности. Это асинхронная операция с сетевой загрузкой, поэтому её место в `OnAfterRenderAsync`, а не в `OnInitializedAsync`.

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

Теперь `status = "Working..."` отрисовывается сразу, спиннер крутится, а интерфейс остаётся отзывчивым, пока пять миллионов чисел раскладываются на множители в другом потоке операционной системы.

Имя метода - это строка: `AssemblyName.ClassName.MethodName`. Worker разбивает её и обходит объект экспорта, возвращённый `getAssemblyExports`, поэтому опечатка становится ошибкой времени выполнения, а не ошибкой компиляции. Обернуть каждый вызов в небольшой типизированный метод сервисного класса стоит этих десяти строк, потому что это даёт единственное место, где живут магические строки.

Размещение в `OnAfterRenderAsync` - не вопрос стиля. В Blazor Web App, чей проект `.Client` предварительно рендерится на сервере, JS-interop недоступен во время прохода prerender, и вызов оттуда бросает ошибку [JavaScript interop calls cannot be issued at this time](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). `OnAfterRenderAsync` выполняется только после установления интерактивности, поэтому worker создаётся ровно один раз и на клиенте.

## Отмена и таймауты

Это то добавление .NET 11, которое делает клиент пригодным для продакшена. Полная поверхность API:

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

И `timeoutMs`, и токен защищают ожидание главного потока, а не выполнение внутри worker. Метод `[JSExport]`, выполняющий синхронный цикл, не может наблюдать `CancellationToken`, потому что прервать его извне невозможно. Отмена даёт вам возможность перестать ждать и корректно снести зависший worker:

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

Освобождение после отмены - это важная половина. Если вы отменяете ожидание, но сохраняете клиент, брошенное вычисление продолжает жечь ядро, а следующий `InvokeAsync` встаёт в очередь за ним. `DisposeAsync` вызывает `terminate()` на нижележащем `Worker`, что немедленно останавливает его независимо от того, чем он занят. Общая схема проброса токена по цепочке вызовов разобрана в руководстве по [передаче CancellationToken через асинхронные методы](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), а [`CancellationTokenSource.CancelAfter`](/ru/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) сочетается с `timeoutMs`, если вам нужен клиентский дедлайн, который заодно запускает вашу собственную очистку.

Для работы, результат которой вам не нужен, `InvokeVoidAsync` пропускает обратную передачу результата:

```csharp
await worker.InvokeVoidAsync("WebWorker.WorkerMethods.WarmCaches", []);
```

## Цена: каждый worker загружает собственную среду выполнения

Это та часть, которая удивляет, и именно она диктует большинство решений выше.

Worker не разделяет среду выполнения главного потока. Он поднимает вторую полноценную среду выполнения .NET WebAssembly: `dotnet.js`, `.wasm` среды выполнения и каждую сборку, на которую транзитивно ссылается ваша библиотека worker. HTTP-кеш браузера обычно делает вторую загрузку дешёвой после первой, но инстанцирование не бесплатно, а память действительно удваивается, потому что у двух сред выполнения раздельные кучи.

Отсюда следуют практические правила:

- **Создавайте клиент один раз и переиспользуйте его всегда.** `CreateAsync` на каждое нажатие кнопки - самый частый способ сделать worker медленнее того кода, который он заменил.
- **Для использования во всём приложении регистрируйте его как singleton** и инициализируйте лениво, а не создавайте на каждый компонент:

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

  Семафор здесь важен, потому что два компонента, отрисовывающиеся одновременно, оба увидят `client is null` и оба вызовут `CreateAsync`, дав вам две среды выполнения там, где нужна была одна.

- **Держите граф зависимостей библиотеки worker небольшим.** Каждый пакет, на который вы ссылаетесь из проекта worker, - это лишняя сборка, загружаемая во вторую среду выполнения. Кладите туда только вычислительный код, а не общую библиотеку моделей с прицепленными EF Core и валидацией.
- **Группируйте вызовы.** Каждый вызов - это круг `postMessage` с шагом сериализации на обоих концах. Десять вызовов в цикле измеримо хуже одного вызова с аргументом-массивом.

## Что не пересекает границу

Worker - это по-настоящему отдельная среда выполнения, и отношение к нему как к фоновому потоку внутри того же процесса как раз и порождает ошибки.

**Нет общего состояния.** Статические поля вашей сборки worker существуют дважды: одна копия в среде выполнения главного потока, другая в worker. Запись в статическое поле из компонента и чтение его из метода `[JSExport]` вернёт то, что оказалось в копии worker. Всё состояние должно ехать в аргументах и в возвращаемом значении.

**Нет внедрения зависимостей.** Методы worker статические, и среда выполнения worker никогда не строит провайдер сервисов. Если вашему вычислительному коду нужна конфигурация, передавайте её аргументами или как JSON-блоб.

**Нет DOM, нет `IJSRuntime`, нет `NavigationManager`.** У Web Worker нет ни `document`, ни `window`. Всё, что касается интерфейса, должно происходить обратно в главном потоке после возврата `InvokeAsync`.

**Нет колбэков прогресса из коробки.** Сгенерированный клиент моделирует запрос и ответ, а не потоковую передачу. Если вам нужен индикатор прогресса для долгого вычисления, разбейте работу на порции и делайте по вызову на порцию, обновляя интерфейс между вызовами.

## Отладка и trimming, два шероховатых края

Исключения, брошенные внутри метода `[JSExport]`, возвращаются строкой сообщения через `postMessage`, поэтому трассировка стека C#, которую вы получаете в главном потоке, описывает слой interop, а не ваш цикл. Когда метод worker ведёт себя неправильно, быстрее всего обычно временно вызвать тот же статический метод напрямую из компонента, воспроизвести проблему в главном потоке с подключённым отладчиком, а затем вернуть код обратно.

Trimming - вторая вещь, за которой стоит следить. Опубликованные приложения Blazor обрезают код агрессивно, а worker разрешает ваши методы по имени во время выполнения через `getAssemblyExports`. Атрибут `[JSExport]` и есть то, что удерживает эти методы, так что экспортированный метод в безопасности. Всё, до чего он добирается только через рефлексию, - нет. Если вызов worker работает под `dotnet run` и падает после `dotnet publish`, рефлексия плюс trimming - первая гипотеза для проверки, и те же [правила безопасности при обрезке, что действуют для Native AOT](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/), применимы и здесь.

Наконец, честно ответьте себе, нужно ли это вообще. Если вы строите Blazor Web App, а не автономное приложение WebAssembly, сервер обычно выполнит вычисление быстрее, чем клиент успеет поднять вторую среду выполнения, а обычный вызов API - это меньше механики ради того же результата. Компромиссы между моделями хостинга разобраны в сравнении [Blazor Server, WebAssembly и United](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). Web Workers - правильный ответ, когда данные уже на клиенте, когда работа действительно упирается в процессор, а не в ввод-вывод, и когда круг до сервера неприемлем. Во всех остальных случаях сервер по-прежнему остаётся пулом потоков с железом получше.

## Похожие статьи

- [dotnet new webworker: полноценные Web Workers для Blazor в .NET 11 Preview 2](/ru/2026/04/dotnet-11-preview-2-blazor-webworker-template/)
- [Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [Как передавать CancellationToken через асинхронные методы в .NET 11](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time при prerendering в Blazor](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Как сериализовать полиморфную иерархию типов с JsonDerivedType в System.Text.Json](/ru/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Как написать isolate в Dart для ресурсоёмких вычислений](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)

## Источники

- [ASP.NET Core Blazor with .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-with-dotnet-on-web-workers?view=aspnetcore-11.0), Microsoft Learn
- [.NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-11.0), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11: New Blazor Web Worker template](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0), Microsoft Learn
- [.NET Web Worker template update to Blazor Web Worker template (dotnet/aspnetcore #66070)](https://github.com/dotnet/aspnetcore/pull/66070), GitHub
- [Make Blazor WebAssembly work on multithreaded runtime (dotnet/aspnetcore #54365)](https://github.com/dotnet/aspnetcore/issues/54365), GitHub
- [JSExportAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.javascript.jsexportattribute), Microsoft Learn
- [Running background tasks in Blazor with Web Workers](https://andrewlock.net/exploring-the-dotnet-11-preview-1-running-background-tasks-in-blazor-with-web-workers/), Andrew Lock
- [Web Workers API](https://developer.mozilla.org/docs/Web/API/Web_Workers_API), MDN
