---
title: "Как добавить сжатие ответов в API на ASP.NET Core 11"
description: "Полное руководство по сжатию ответов в ASP.NET Core 11: AddResponseCompression и UseResponseCompression, новый встроенный провайдер Zstandard рядом с Brotli и Gzip, уровни сжатия, EnableForHttps и риск CRIME/BREACH, пользовательские MIME-типы, порядок middleware и когда стоит доверить это обратному прокси."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
lang: "ru"
translationOf: "2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api"
translatedBy: "claude"
translationDate: 2026-07-14
---

Чтобы добавить сжатие ответов в API на ASP.NET Core 11, вам нужно ровно две строки: зарегистрируйте middleware через `builder.Services.AddResponseCompression()` и добавьте его в конвейер через `app.UseResponseCompression()`. Это даёт вам Brotli, Gzip и (новое в .NET 11) Zstandard, согласуемые автоматически на основе заголовка `Accept-Encoding` клиента. Загвоздка в том, что по HTTPS оно ничего не делает, пока вы не включите его через `EnableForHttps = true`, а это включение несёт реальный риск безопасности, который нужно понять, прежде чем его переключать. Эта статья охватывает весь путь: настройку из двух строк, добавление Zstandard в .NET 11, уровни сжатия, MIME-типы, проблему с HTTPS и случаи, когда сжатие стоит доверить обратному прокси.

Всё здесь ориентировано на .NET 11 (Preview 5 на момент написания, общая доступность в ноябре 2026 года) с `Microsoft.NET.Sdk.Web` и C# 14. Middleware `Microsoft.AspNetCore.ResponseCompression` стабилен начиная с ASP.NET Core 2.1, поэтому части с Brotli и Gzip работают без изменений на .NET 8, 9 и 10. Провайдер Zstandard -- единственная часть, которая доступна только начиная с .NET 11.

## Две подвижные части

Сжатие ответов живёт в общем фреймворке, поэтому устанавливать пакет NuGet не нужно. Зарегистрируйте сервисы и добавьте middleware:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression();

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/data", () => Enumerable.Range(0, 1000)
    .Select(i => new { Id = i, Name = $"Item {i}", Note = "some repeated text" }));

app.Run();
```

Вот полная процедура от начала до конца:

1. Вызовите `builder.Services.AddResponseCompression()`, чтобы зарегистрировать middleware и его провайдеры по умолчанию (Brotli, Gzip и Zstandard в .NET 11).
2. Вызовите `app.UseResponseCompression()` рано в конвейере, до любого middleware, который пишет тело ответа.
3. Если ваш API обслуживается по HTTPS (почти всегда), установите `EnableForHttps = true` в опциях после прочтения раздела о безопасности ниже.
4. Добавьте любые нестандартные MIME-типы, которые вы обслуживаете (например `image/svg+xml`), в `ResponseCompressionOptions.MimeTypes`.
5. Настройте уровень сжатия для каждого провайдера, если значение по умолчанию (самое быстрое) -- не тот компромисс, который вам нужен.
6. Проверьте с помощью клиента, который отправляет `Accept-Encoding`, и осмотрите заголовки ответа `Content-Encoding` и `Vary`.

Это вся функциональность. Остальная часть статьи -- о том, как выполнить каждый шаг правильно, а не просто заставить его компилироваться.

## Что меняется в .NET 11: Zstandard теперь встроен

Если вы настраивали сжатие ответов в более старой версии .NET, мышечная память говорит «Brotli и Gzip». В .NET 11 этот список вырос. Zstandard (токен кодирования `zstd`, [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878)) теперь полноценный провайдер сжатия, встроенный в стек `System.IO.Compression` без пакета NuGet, без P/Invoke и без сторонней привязки. Когда вы вызываете `AddResponseCompression()` без явных провайдеров, ASP.NET Core 11 регистрирует все три: `BrotliCompressionProvider`, `GzipCompressionProvider` и `ZstandardCompressionProvider`.

Порядок согласования тоже изменился. На .NET 10 и ранее middleware предпочитал Brotli, а затем откатывался к Gzip. На .NET 11 предпочтение таково: сначала Zstandard, затем Brotli, затем Gzip. Поэтому когда современный браузер отправляет `Accept-Encoding: gzip, deflate, br, zstd`, API на ASP.NET Core 11 теперь отвечает `Content-Encoding: zstd`. Причина перестановки в том, что Zstandard попадает в лучшую точку на кривой скорость/степень для динамических ответов API: на своём уровне по умолчанию он сжимает заметно быстрее, чем Brotli при эквивалентной степени, и распаковывает быстрее, чем и Brotli, и Gzip, что важно, когда клиент -- мобильное устройство или другой сервис.

Важное эксплуатационное следствие: после обновления до .NET 11 ваш API начнёт выдавать `zstd` любому клиенту, который его анонсирует, без изменения единой строки. Это нормально для браузеров и современных HTTP-клиентов, но если у вас есть старый внутренний потребитель, который заявлял поддержку `zstd`, но фактически не может его декодировать (редко, но случается с самописными клиентами), вы увидите искажённые тела. Решение -- не отключать сжатие глобально, а ограничить список провайдеров, как показывает следующий раздел.

## Явный выбор провайдеров

В тот момент, когда вы добавляете хотя бы один провайдер вручную, автоматические значения по умолчанию отключаются. Это самая частая ловушка: написать `options.Providers.Add<BrotliCompressionProvider>()`, а затем недоумевать, почему Gzip перестал работать. Когда вы добавляете провайдеры явно, активны только те, что вы перечислили.

Итак, чтобы сохранить все три и включить сжатие по HTTPS:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
```

Порядок, в котором вы добавляете провайдеры, -- это порядок предпочтения сервера, когда клиент принимает более одного. Поставьте Zstandard первым, если хотите, чтобы он предпочитался, а Gzip -- последним как универсальный запасной вариант. Если вы хотите принудительно использовать только Gzip (скажем, чтобы соответствовать конфигурации устаревшего CDN), добавьте только `GzipCompressionProvider` и никакой другой, и middleware никогда не выдаст Brotli или Zstandard.

## Уровни сжатия и почему значение по умолчанию -- «самое быстрое»

Каждый провайдер по умолчанию использует `CompressionLevel.Fastest`, а не `Optimal`. Это удивляет тех, кто ожидает наименьшее возможное тело «из коробки». Значение по умолчанию выбрано намеренно: для динамического ответа, вычисляемого на каждый запрос, процессорное время, которое вы тратите на сжатие, находится на горячем пути каждого ответа, поэтому фреймворк отдаёт предпочтение задержке перед последними несколькими процентами размера. `Optimal` и `SmallestSize` могут стоить в несколько раз больше процессорного времени ради однозначного процента дополнительного сжатия и без того небольшого JSON.

Вы задаёте уровень для каждого провайдера через его класс опций:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest;
});

builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.SmallestSize;
});
```

Перечисление `CompressionLevel` имеет четыре значения: `NoCompression`, `Fastest`, `Optimal` и `SmallestSize`. Для интерактивного API оставьте Zstandard и Brotli на `Fastest`. Приберегите `Optimal` или `SmallestSize` для ответов, которые вы сжимаете один раз и отдаёте многократно, что для чистого API обычно означает, что вам выгоднее кешировать сжатые байты самостоятельно, чем платить за оптимальное сжатие на каждом запросе. Если вы также обслуживаете статические ресурсы, учтите, что сжатие статических файлов -- отдельная задача (на этапе сборки или в CDN), а не то, что этот middleware должен делать во время запроса.

У Zstandard есть собственная, более тонкая настройка. Его качество варьируется от 1 до 22, со значением по умолчанию около уровня 3, и вы задаёте его через `ZstandardCompressionProviderOptions`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 6 // 1 to 22; higher = smaller output, slower
    };
});
```

Более высокое качество означает меньшее тело и больше процессорного времени. Уровень 6 -- разумный шаг выше значения по умолчанию, когда ваши ответы большие и повторяющиеся (подумайте об эндпоинтах со списками, возвращающих тысячи похожих объектов) и у вас есть запас по процессору.

## Ловушка безопасности HTTPS, которую нельзя пропустить

`EnableForHttps` по умолчанию `false`, и это значение по умолчанию -- решение в пользу безопасности, а не недосмотр. Сжатие ответа, тело которого смешивает секрет (токен сессии, токен CSRF, номер счёта) с вводом, на который влияет злоумышленник, поверх TLS открывает дверь для атак [CRIME](https://en.wikipedia.org/wiki/CRIME) и [BREACH](https://en.wikipedia.org/wiki/BREACH). Эти атаки по побочному каналу выводят секрет, наблюдая, как меняется размер сжатого ответа по мере того, как злоумышленник варьирует контролируемый им ввод. Степень сжатия утекает информацию о содержимом, а поверх HTTPS размер зашифрованного тела всё равно наблюдаем.

Для типичного JSON API, который не возвращает секреты для каждого пользователя, отражённые рядом со значениями запроса под контролем злоумышленника, включение сжатия по HTTPS -- нормальная и разумная вещь, и почти все так делают. Но вы должны принять это решение осознанно:

- Если ваши ответы никогда не встраивают секретный токен в тело рядом с отражённым вводом пользователя, включение сжатия по HTTPS низкорисково.
- Если могут (HTML-страница с токеном защиты от подделки, эндпоинт, который возвращает поисковый термин рядом с идентификатором сессии), примите меры до включения: используйте токены защиты от подделки (стандартная мера в ASP.NET Core), избегайте отражения недоверенного ввода в ответы, несущие секреты, и рассмотрите возможность оставить сжатие выключенным для этих конкретных эндпоинтов.

Флаг `EnableForHttps` глобальный. Если вам нужно сжатие для эндпоинтов с публичными данными, но не для чувствительного, самое чистое разделение -- выполнять чувствительные эндпоинты без сжатия, сегментируя конвейер, или обслуживать их с `Content-Type`, который вы намеренно оставляете вне списка сжимаемых MIME.

Ещё одна тонкость: даже с `EnableForHttps = false` вы всё равно можете увидеть заголовок `Content-Encoding` в продакшене. IIS, IIS Express и Azure App Service могут применять Gzip на уровне веб-сервера независимо от вашего приложения. Если появляется сжатый ответ, который вы не настраивали, проверьте заголовок ответа `Server`, прежде чем предполагать, что middleware ведёт себя неправильно.

## MIME-типы: что на самом деле сжимается

Middleware сжимает только ответы, чей `Content-Type` соответствует его списку. Значения по умолчанию покрывают обычные полезные нагрузки API и веба: `application/json`, `application/javascript`, `application/xml`, `text/css`, `text/html`, `text/json`, `text/plain` и `text/xml`. Для JSON API вы получаете сжатие без всякой настройки, потому что `application/json` есть в списке.

Чтобы сжать что-то за пределами значений по умолчанию, добавьте это к `ResponseCompressionOptions.MimeTypes`. Подстановочные знаки вроде `text/*` не поддерживаются, поэтому перечислите каждый тип:

```csharp
// .NET 11, C# 14
using System.Linq;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
        new[] { "image/svg+xml", "application/manifest+json" });
});
```

Не добавляйте уже сжатые форматы, такие как PNG, JPEG, WebP или ZIP. Они сжаты нативно, и прогон их через Brotli или Zstandard жжёт процессор ради тела того же размера или чуть больше. То же касается очень маленьких ответов: ниже примерно 150-1000 байт накладные расходы на сжатие могут сделать вывод больше входных данных, поэтому крошечные ответы не стоят сжатия независимо от типа.

## Порядок: UseResponseCompression идёт рано

Порядок middleware решает, работает ли сжатие вообще. `app.UseResponseCompression()` должен выполняться до любого middleware, который пишет в тело ответа, потому что сжатие работает, оборачивая поток ответа. Если другой middleware уже начал запись, обёртка сжатия никогда не увидит эти байты. На практике поместите его ближе к началу конвейера:

```csharp
// .NET 11, C# 14
var app = builder.Build();

app.UseResponseCompression();   // first, so it wraps everything below
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Когда сжатие применяется, middleware также автоматически делает правильные вещи с заголовками кеширования: удаляет `Content-Length` (длина тела изменилась), убирает `Content-MD5` (хеш больше недействителен) и добавляет `Vary: Accept-Encoding`, чтобы кеши хранили сжатые и несжатые варианты раздельно. Вы не управляете этим вручную.

## Когда вообще пропустить middleware

Middleware сжатия ответов -- правильный инструмент, когда вы хостите напрямую на Kestrel или HTTP.sys без чего-либо впереди, потому что ни один из этих серверов не предлагает встроенного сжатия. Но если ваш API стоит за IIS, Nginx, Apache или CDN, обратный прокси обычно может сжимать быстрее, чем управляемый middleware, и делать это в одном месте проще для понимания. Собственная рекомендация Microsoft -- предпочитать серверное сжатие, когда оно доступно.

Две ловушки, за которыми надо следить, когда в деле прокси:

- Nginx удаляет заголовок `Accept-Encoding`, когда проксирует запрос выше, что незаметно мешает middleware ASP.NET Core сжимать. Если вы держите middleware за Nginx, либо настройте Nginx на сохранение заголовка, либо позвольте Nginx делать сжатие и уберите middleware.
- Двойное сжатие -- впустую потраченная работа и может испортить ответы. Если прокси уже сжимает, не запускайте вдобавок middleware для тех же типов контента. Выберите один слой.

Для minimal API, обслуживаемого прямо из Kestrel в контейнере без прокси-сайдкара, middleware -- именно то, что нужно, и настройки из двух строк в начале этой статьи достаточно. Для всего, что стоит за зрелым прокси или CDN, сначала измерьте: возможно, вы уже получаете сжатие, которое не настраивали.

## Пользовательские провайдеры, вкратце

Если вам нужна кодировка, которую фреймворк не поставляет, реализуйте `ICompressionProvider`. Свойство `EncodingName` -- это токен, который middleware сопоставляет с `Accept-Encoding`, а `CreateStream` возвращает вашу сжимающую обёртку:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

public sealed class CustomCompressionProvider : ICompressionProvider
{
    public string EncodingName => "mycustomcompression";
    public bool SupportsFlush => true;

    public Stream CreateStream(Stream outputStream)
    {
        // Wrap outputStream in your compression stream here.
        return outputStream;
    }
}
```

Зарегистрируйте его как любой другой провайдер через `options.Providers.Add<CustomCompressionProvider>()`. На практике, с теперь встроенным Zstandard, потребность в пользовательских провайдерах почти испарилась. Между Zstandard, Brotli и Gzip .NET 11 покрывает каждую кодировку, которую запросит реальный HTTP-клиент, что и есть весь смысл изменения в .NET 11: быстрый, современный вариант теперь включён по умолчанию, и вам больше не нужно выходить за пределы фреймворка, чтобы его получить.

## Похожие статьи

- [Как передавать файл из эндпоинта ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) объясняет, почему middleware сжатия и потоковая передача могут конфликтовать.
- [Как добавить выходное кеширование в minimal API на ASP.NET Core 11](/ru/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) хорошо сочетается со сжатием для эндпоинтов с интенсивным чтением.
- [Как организовать эндпоинты minimal API с помощью MapGroup в ASP.NET Core 11](/ru/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) помогает, когда вам нужно сжатие для одних групп маршрутов, но не для других.
- [Как вернуть типизированное объединение Results из эндпоинта minimal API в ASP.NET Core 11](/ru/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) охватывает типы ответов, которые проходят через этот middleware.
- [Как использовать Native AOT с minimal API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) стоит прочитать, если вас волнует стоимость сжатия по процессору при холодных стартах.

## Источники

- [Response compression in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionOptions.EnableForHttps (API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.responsecompression.responsecompressionoptions.enableforhttps)
- [CompressionLevel enum (API reference)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.compressionlevel)
- [RFC 8878: Zstandard Compression](https://datatracker.ietf.org/doc/html/rfc8878)
- [CRIME attack (Wikipedia)](https://en.wikipedia.org/wiki/CRIME) и [BREACH attack (Wikipedia)](https://en.wikipedia.org/wiki/BREACH)
