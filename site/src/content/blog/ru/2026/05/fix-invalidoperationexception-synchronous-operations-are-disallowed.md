---
title: "Исправление: InvalidOperationException: Synchronous operations are disallowed"
description: "Замените вызов Stream.Read или Write на ReadAsync/WriteAsync. В крайнем случае установите AllowSynchronousIO в Kestrel, IIS или поштучно через IHttpBodyControlFeature."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
  - "kestrel"
lang: "ru"
translationOf: "2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed"
translatedBy: "claude"
translationDate: 2026-05-12
---

Исправление: ASP.NET Core 3.0 и более поздние версии по умолчанию запрещают синхронные чтения и записи в `HttpRequest.Body` и `HttpResponse.Body`, поэтому любой код, вызывающий `Stream.Read`, `Stream.Write`, `Stream.Flush`, `StreamReader.ReadToEnd`, `StreamWriter.Write` или `JsonSerializer.Deserialize(stream)`, выбросит `InvalidOperationException: Synchronous operations are disallowed`. Чистое исправление — заменить вызов на его асинхронный эквивалент (`ReadAsync`, `WriteAsync`, `DeserializeAsync`) и ожидать через `await`. Если вы не можете изменить вызывающий код, включите `AllowSynchronousIO = true` в Kestrel или IIS, либо переключите `IHttpBodyControlFeature.AllowSynchronousIO` только для проблемного запроса.

```text
System.InvalidOperationException: Synchronous operations are disallowed. Call ReadAsync or set AllowSynchronousIO to true instead.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpRequestStream.Read(Byte[] buffer, Int32 offset, Int32 count)
   at System.IO.Stream.CopyTo(Stream destination, Int32 bufferSize)
   at Newtonsoft.Json.JsonSerializer.DeserializeInternal(JsonReader reader, Type objectType)
   at MyApp.LegacyHandler.Parse(HttpRequest request)
```

Это руководство написано против ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4) и Kestrel 11.0.0-preview.4. Проверка действует с версии 3.0.0-preview3 (февраль 2019) и применяется к Kestrel, HTTP.sys, IIS in-process и `TestServer`. Текст исключения одинаков во всех версиях; изменились только серверы по умолчанию и удобные API вокруг этой настройки.

## Почему сервер блокирует синхронный ввод-вывод по умолчанию

Каждый заблокированный поток внутри обработчика запроса — это поток, недоступный остальной части приложения. Синхронный `Stream.Read` по медленному клиентскому соединению может удерживать поток из пула потоков в течение нескольких секунд. Под нагрузкой пул исчерпывается, задержка запросов резко растёт, и процесс начинает казаться зависшим, хотя CPU простаивает. Этот паттерн — голодание пула потоков — был причиной длинного шлейфа продакшен-инцидентов в ASP.NET Core 1.x и 2.x, когда приложения зависали под всплесковым трафиком.

Релиз 3.0 переключил `AllowSynchronousIO` с `true` на `false` во всех встроенных серверах. Среда выполнения теперь активно отклоняет синхронные вызовы вместо того, чтобы дать им заблокировать поток тихо. Исключение — это не ошибка, а сервер, сообщающий вам, что вызов заблокировал бы поток на всё время сетевого чтения или записи. Поняв это, "исправление" перестаёт быть "выключить проверку" и становится "перестать блокировать поток".

Объявление команды среды выполнения в [aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644) перечисляет затронутые серверы и рекомендуемый обходной путь через `IHttpBodyControlFeature`.

## Минимальное воспроизведение

```csharp
// ASP.NET Core 11, C# 14, Newtonsoft.Json 13.0.4
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/legacy", (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = reader.ReadToEnd();                      // throws
    return Results.Ok(json.Length);
});

app.Run();
```

`StreamReader.ReadToEnd` под капотом вызывает `Stream.Read`. `HttpRequestStream` Kestrel переопределяет `Read`, чтобы немедленно выбрасывать исключение, когда `AllowSynchronousIO` равно `false`. Та же форма ошибки появляется с любым из этих вызывающих:

- `JsonSerializer.Deserialize<T>(request.Body)` из `System.Text.Json`.
- `JsonSerializer.Create().Deserialize(...)` из `Newtonsoft.Json`, когда ему передают `request.Body`.
- `request.Body.CopyTo(target)` для пересылки тела запроса.
- `response.Body.Write(buffer, 0, count)` из пользовательской middleware.
- `XmlSerializer.Deserialize(request.Body)`.
- Любая сторонняя библиотека, которая внутри вызывает `Stream.Read` или `Stream.Write` на потоке запроса/ответа.

Трассировка стека — ваш друг: читайте её снизу вверх, чтобы найти синхронный API, попавший в серверный поток.

## Исправление 1: перейти на асинхронный API (рекомендуется)

Это единственное исправление, которое действительно решает основную проблему. Почти у каждого распространённого API есть асинхронная сестра.

```csharp
// ASP.NET Core 11, C# 14
app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = await reader.ReadToEndAsync();
    return Results.Ok(json.Length);
});
```

Для JSON предпочтите потоковый десериализатор `System.Text.Json`, который никогда не материализует весь payload в виде строки:

```csharp
// ASP.NET Core 11, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

app.MapPost("/orders", async (HttpRequest request) =>
{
    var order = await JsonSerializer.DeserializeAsync<Order>(
        request.Body,
        cancellationToken: request.HttpContext.RequestAborted);
    return Results.Ok(order);
});

record Order(string Sku, int Quantity);
```

Если вы читаете модель в minimal API, самое простое исправление — дать связать её фреймворку. Параметры `[FromBody]` в minimal API и MVC десериализуются асинхронно, поэтому проверка синхронного ввода-вывода никогда не срабатывает.

```csharp
app.MapPost("/orders", (Order order) => Results.Ok(order));
```

Для Newtonsoft.Json целью миграции является `System.Text.Json` и его асинхронный десериализатор. Если вы не можете мигрировать, сначала прочитайте тело асинхронно в `MemoryStream`, а затем передайте этот буфер Newtonsoft:

```csharp
// ASP.NET Core 11, Newtonsoft.Json 13.0.4
using Newtonsoft.Json;

app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    ms.Position = 0;

    using var reader = new StreamReader(ms);
    using var jsonReader = new JsonTextReader(reader);
    var serializer = new JsonSerializer();
    var order = serializer.Deserialize<Order>(jsonReader);
    return Results.Ok(order);
});
```

Синхронный `Deserialize` Newtonsoft теперь работает с `MemoryStream`, а не с потоком запроса Kestrel, поэтому проверка проходит. Этот паттерн также подходит для оборачивания только-синхронных сторонних парсеров. Для долгосрочного планирования смотрите подход [миграции с Newtonsoft.Json на System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Исправление 2: включить AllowSynchronousIO на уровне всего сервера

Если вы застряли с библиотекой, у которой вообще нет асинхронного API, вы можете повторно включить синхронный ввод-вывод на сервере. Это глобальный обходной путь, и его следует сопровождать отслеживаемым планом по удалению. Конфигурация зависит от того, какой сервер вы запускаете.

**Kestrel:**

```csharp
// ASP.NET Core 11
builder.WebHost.ConfigureKestrel(options =>
{
    options.AllowSynchronousIO = true;
});
```

**IIS in-process:**

```csharp
// ASP.NET Core 11
builder.Services.Configure<IISServerOptions>(options =>
{
    options.AllowSynchronousIO = true;
});
```

**HTTP.sys:**

```csharp
// ASP.NET Core 11
builder.WebHost.UseHttpSys(options =>
{
    options.AllowSynchronousIO = true;
});
```

Официальная документация Kestrel подтверждает, что свойство находится на `KestrelServerOptions` и по умолчанию равно `false`; см. [Configure options for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io). Включение его везде заставляет проверку исчезнуть, но также возвращает риск голодания потоков, ради предотвращения которого значение по умолчанию было добавлено. Относитесь к флагу как к ярлыку, который говорит "я ещё не закончил миграцию на async", а не как к постоянной конфигурации.

## Исправление 3: включить синхронный ввод-вывод для одного запроса

Если только один endpoint имеет синхронную зависимость, не переключайте серверный флаг целиком. Используйте `IHttpBodyControlFeature`, чтобы включить его только для этого запроса, в идеале внутри middleware, привязанной к конкретному маршруту.

```csharp
// ASP.NET Core 11
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/legacy/export", (HttpContext ctx) =>
{
    var feature = ctx.Features.Get<IHttpBodyControlFeature>();
    if (feature is not null)
    {
        feature.AllowSynchronousIO = true;
    }

    using var writer = new StreamWriter(ctx.Response.Body);
    writer.Write("<huge legacy XML payload>");
    return Results.Empty;
});
```

Фичу нужно включить до первого вызова, который иначе выбросил бы исключение. Если вы сначала прочитали тело, а потом установили флаг, чтение уже провалилось. В MVC эквивалент — фильтр, выполняющийся в `OnActionExecuting` и переключающий фичу до того, как model binder прочитает тело.

Такой подход поштучно сохраняет остальную часть приложения под защитой настройки по умолчанию. Это правильный ответ, когда у вас один legacy endpoint в окружении современных асинхронных.

## Подводные камни и похожие случаи

**Иногда исключение скрывает другую жалобу.** Ответ с `Response.Body.Write(...)` после `await Response.WriteAsync(...)` может выбрасывать то же исключение, даже если разработчик считал, что всё асинхронно; проблема обычно в скрытом вызове `Flush` внутри логгера или в `JsonSerializer`, который не принимает токен отмены. Читайте всю трассировку стека, а не только верхний кадр.

**`HttpRequest.ReadFormAsync` — безопасная форма для данных формы.** Распространённый путь к этой ошибке — `request.Form["..."]`, синхронный аксессор, внутри вызывающий `Read`. Перейдите на `await request.ReadFormAsync()` и затем обращайтесь к получившейся `IFormCollection`.

**Middleware логирования, вызывающая `Response.Body.Seek` или `CopyTo`.** Пользовательская middleware для перехвата ответа почти всегда срабатывает на этой проверке. Замените `CopyTo` на `CopyToAsync` и поменяйте любые блокирующие чтения на потоке-обёртке на их асинхронные перегрузки.

**Проверка не срабатывает под TestServer в некоторых сценариях.** `TestServer` не всегда настраивает такую же `IHttpBodyControlFeature`, как Kestrel. Код, работающий в тестах, может выбрасывать в проде. Прогоните дымовой тест против Kestrel локально, прежде чем выкатывать.

**Установка `AllowSynchronousIO = true` не заглушает все ошибки, связанные с async.** Она меняет только проверку синхронного ввода-вывода. `TaskCanceledException` от отключения клиента — другая проблема; см. статью о [TaskCanceledException: A task was canceled в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) для этого семейства ошибок.

**JSON-специфичные двойники.** `JsonException: The JSON value could not be converted to System.DateTime` — это ошибка формата при десериализации, а не ошибка ввода-вывода, хотя обе всплывают внутри обработчика запроса. Если ваш кадр стека заканчивается в `System.Text.Json`, смотрите [руководство по десериализации DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

**`DisposeAsync` имеет значение.** Вызов синхронного `Dispose` на потоке, который вам отдал сервер, может неявно вызвать `Flush`, то есть запись. Используйте `await using` для любого потока, который вы получаете из `HttpContext`.

```csharp
// ASP.NET Core 11
await using var writer = new StreamWriter(response.Body);
await writer.WriteAsync("done");
```

Паттерн `await using` — одна из тех мелких привычек, которые окупаются в первый же раз, когда они спасают запрос от этого исключения.

## Связанное

- [Как стримить файл из endpoint ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) рассматривает асинхронные паттерны, которые среда выполнения ожидает при записи больших ответов.
- [Как загрузить большой файл стримингом в Azure Blob Storage](/ru/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) — соответствующее руководство по записи.
- [Как покрыть юнит-тестами код, использующий HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) показывает асинхронную тестовую обвязку, которую вы хотите иметь вокруг любого обработчика, трогающего тела request или response.
- [Исправление: A second operation was started on this context instance before a previous operation completed](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/) — родственник этой ошибки из EF Core: ещё один случай, когда среда выполнения ловит ошибку sync-over-async.
- [Исправление: TaskCanceledException: A task was canceled в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) — для родственного семейства клиентских таймаутов.

## Источники

- [Configure options for the ASP.NET Core Kestrel web server, Synchronous I/O](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io) (MS Learn, .NET 10 / 11)
- [Announcement: AllowSynchronousIO disabled in all servers, dotnet/aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644)
- [ASP.NET Core breaking changes for versions 3.0 and 3.1](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnetcore)
- [Справочник API `KestrelServerOptions.AllowSynchronousIO`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.server.kestrel.core.kestrelserveroptions.allowsynchronousio)
- [Интерфейс `IHttpBodyControlFeature`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpbodycontrolfeature)
