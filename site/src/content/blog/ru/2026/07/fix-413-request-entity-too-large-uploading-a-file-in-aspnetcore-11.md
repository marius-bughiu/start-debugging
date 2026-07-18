---
title: "Исправление: \"413 Request Entity Too Large\" при загрузке файла на endpoint ASP.NET Core"
description: "Kestrel по умолчанию ограничивает тело запроса 30 000 000 байтами и возвращает 413 при превышении. Увеличьте MaxRequestBodySize глобально, для endpoint или в web.config за IIS."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "file-upload"
lang: "ru"
translationOf: "2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

Загрузка возвращает `413 Request Entity Too Large`, потому что Kestrel по умолчанию ограничивает каждое тело запроса 30 000 000 байтами (около 28,6 МиБ), а ваш файл больше. Увеличьте лимит там, где он действительно применяется: задайте `MaxRequestBodySize` в Kestrel глобально, примените `[RequestSizeLimit]` или `[DisableRequestSizeLimit]` на action контроллера, увеличьте `FormOptions.MultipartBodyLengthLimit` для отправки форм, а за IIS увеличьте `maxAllowedContentLength` в `web.config`. Проверено на ASP.NET Core 11 на .NET 11 с C# 14; лимиты и значения по умолчанию идентичны от .NET 8 до .NET 11.

## Ошибка в контексте

Она проявляется двумя способами. Первый - это HTTP-ответ, который видит клиент:

```
HTTP/1.1 413 Request Entity Too Large
Content-Length: 0
Connection: close
Date: Fri, 17 Jul 2026 10:04:11 GMT
```

Второй - это строка журнала, которую Kestrel пишет на сервере и которая точно говорит, какой лимит сработал:

```
Microsoft.AspNetCore.Server.Kestrel.Core.BadHttpRequestException:
Request body too large. The max request body size is 30000000 bytes.
```

Эти `30000000` - подсказка. Если вы ничего не меняли, число в сообщении - это значение фреймворка по умолчанию, и решение в том, чтобы увеличить или убрать лимит на том уровне, которому он принадлежит. Если число другое, значит кто-то уже настроил лимит, и вы в него упираетесь. В любом случае причина одна: тело запроса превысило настроенный максимум, и сервер отклонил соединение, прежде чем ваш handler успел дочитать его.

## Почему это происходит

Загрузку могут заблокировать четыре разных лимита, и они находятся в разных местах. Правильно подобрать решение значит понять, какой из них породил ваш `413`.

- **`MaxRequestBodySize` в Kestrel** по умолчанию ограничивает всё тело запроса 30 000 000 байтами. При превышении Kestrel бросает `BadHttpRequestException` и возвращает `413`. Именно он порождает точное сообщение выше.
- **`FormOptions.MultipartBodyLengthLimit`** по умолчанию ограничивает длину тела multipart-формы 134 217 728 байтами (128 МиБ). При превышении читатель формы бросает `InvalidDataException`, что проявляется как `400 Bad Request`, а не `413`. Эти два постоянно путают.
- **`maxAllowedContentLength` в IIS** (когда вы хостите за IIS) ограничивает запрос на уровне фильтрации запросов IIS, по умолчанию 30 000 000 байтами, ещё до того как запрос доберётся до вашего приложения. IIS возвращает для этого свою собственную ошибку, поэтому увеличение только лимита Kestrel за IIS ничего не даёт.
- **Обратный прокси** (nginx, YARP, API-шлюз, облачный балансировщик нагрузки) может навязать собственный лимит тела и вернуть `413` ещё до того, как Kestrel вообще увидит запрос.

Если запрос работает напрямую против Kestrel, но не работает за прокси или IIS, лимит, который нужно изменить, не в вашем коде на C#. Сначала проверьте самый внешний уровень.

## Минимальное воспроизведение

Наименьший endpoint, воспроизводящий `413` по умолчанию. Никаких своих лимитов, только значения фреймворка по умолчанию:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/upload", async (HttpRequest request) =>
{
    // Reading the body is what trips the limit
    using var reader = new StreamReader(request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});

app.Run();
```

Отправьте что-нибудь больше 30 000 000 байт, и чтение бросит исключение:

```bash
# .NET 11 -- generate a 40 MB file and POST it
head -c 40000000 /dev/urandom > big.bin
curl -i -X POST http://localhost:5000/upload \
  -H "Content-Type: application/octet-stream" \
  --data-binary @big.bin
# -> HTTP/1.1 413 Request Entity Too Large
```

Нагрузка в 40 МБ проходит multipart-лимит в 128 МиБ (она в любом случае не multipart), но превышает потолок тела Kestrel в 30 МБ, поэтому вы получаете `413`, а не `400`.

## Увеличьте лимит там, где он применяется

Пройдитесь по ним в зависимости от того, откуда приходит ваш `413`. Большинству самостоятельно хостящихся приложений Kestrel нужен только первый.

### 1. Увеличьте или уберите глобальный лимит Kestrel

Настройте `KestrelServerOptions.Limits.MaxRequestBodySize` при запуске. Задайте конкретное число байт или `null`, чтобы убрать потолок полностью:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // 200 MB ceiling for the whole app
    options.Limits.MaxRequestBodySize = 200 * 1024 * 1024;
});

var app = builder.Build();
```

Предпочитайте реальный потолок вместо `null`. Неограниченный размер тела - это вектор отказа в обслуживании: один клиент может передать в ваш процесс гигабайты и исчерпать память или диск. Выберите наибольшую легитимную загрузку, которую вы ожидаете, и добавьте запас, вместо того чтобы отключать защиту.

### 2. Задайте лимит для отдельного endpoint на контроллерах через атрибуты

Если большие загрузки принимает только один endpoint, не увеличивайте глобальный лимит всего приложения. На action контроллера или Razor Page используйте `[RequestSizeLimit(bytes)]`, чтобы задать конкретный потолок, или `[DisableRequestSizeLimit]`, чтобы убрать его только для этого action. Оба атрибута реализуют `IRequestSizeLimitMetadata`, который конвейер MVC читает при каждом запросе:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
[ApiController]
[Route("api/[controller]")]
public sealed class FilesController : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(200 * 1024 * 1024)]   // 200 MB, this action only
    public async Task<IResult> Upload(IFormFile file)
    {
        await using var stream = System.IO.File.Create(
            Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return Results.Ok(new { file.FileName, file.Length });
    }
}
```

Замените `[RequestSizeLimit(...)]` на `[DisableRequestSizeLimit]`, когда action должен принимать сколь угодно большие тела, а у вас предусмотрена другая защита (потоковая передача, проверка квоты).

### 3. Задайте лимит для каждого запроса в minimal API

Minimal API не учитывают `[RequestSizeLimit]` так, как контроллеры, потому что в конвейере нет resource filter MVC, который бы его читал. Задайте лимит императивно через `IHttpMaxRequestBodySizeFeature`, прежде чем что-либо прочитает тело:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload", async (HttpContext context) =>
{
    var sizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (sizeFeature is not null && !sizeFeature.IsReadOnly)
    {
        sizeFeature.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
    }

    using var reader = new StreamReader(context.Request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});
```

Сначала проверьте `IsReadOnly`. Как только сервер начал читать тело, лимит блокируется, и присваивание ему бросает `InvalidOperationException`. Именно поэтому этот приём не работает с параметром `IFormFile` в minimal API: model binding читает multipart-тело до того, как запустится ваш handler, так что к моменту, когда вы можете тронуть feature, она уже только для чтения (это корень issue dotnet/aspnetcore #50871, где большие multipart-загрузки в minimal API молча возвращали `200` с усечённым файлом). Для загрузок в minimal API привяжите `HttpContext` или `HttpRequest`, увеличьте лимит, а затем прочитайте форму сами через `request.ReadFormAsync()`, либо задайте лимит для всей группы небольшим middleware на `MapGroup`.

### 4. Увеличьте лимит multipart-формы для отправки форм

Если ваш `413` на самом деле `400` с `InvalidDataException` о длине multipart-тела, то сработавший лимит - это `FormOptions.MultipartBodyLengthLimit`, а не лимит Kestrel. Увеличьте его глобально через options или для отдельного action контроллера через `[RequestFormLimits]`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- global, in Program.cs
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 200 * 1024 * 1024;   // 200 MB
});
```

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- per action
[HttpPost("upload")]
[RequestSizeLimit(200 * 1024 * 1024)]
[RequestFormLimits(MultipartBodyLengthLimit = 200 * 1024 * 1024)]
public async Task<IResult> Upload(IFormFile file) { /* ... */ }
```

Для большой загрузки обычно нужно увеличить оба: `MaxRequestBodySize` управляет всем запросом, а `MultipartBodyLengthLimit` управляет телом формы внутри него. Задайте им одинаковое значение.

### 5. За IIS увеличьте maxAllowedContentLength в web.config

Когда вы хостите за IIS (in-process или out-of-process), модуль фильтрации запросов IIS навязывает `maxAllowedContentLength`, по умолчанию 30 000 000 байт, до того как запрос достигнет Kestrel. Увеличение лимита Kestrel ничего не даёт, пока вы не увеличите и этот. Добавьте его в `web.config`:

```xml
<!-- web.config -- value is in bytes; 200 MB here -->
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="209715200" />
    </requestFiltering>
  </security>
</system.webServer>
```

У модуля in-process-хостинга есть второй, отдельный лимит, который можно задать в коде через `IISServerOptions`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- in-process IIS hosting
builder.Services.Configure<IISServerOptions>(options =>
{
    options.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
});
```

За IIS вам может понадобиться согласовать все три: `maxAllowedContentLength` в `web.config`, `IISServerOptions.MaxRequestBodySize` и `MaxRequestBodySize` в Kestrel. Запрос отклоняется по наименьшему из них.

### 6. Увеличьте потолок на обратном прокси

Если перед приложением стоит прокси, у него свой лимит, и он возвращает `413` ещё до того, как задействуется ваше приложение. В nginx директива называется `client_max_body_size` (по умолчанию 1 МиБ, что намного меньше значения Kestrel по умолчанию и часто становится сюрпризом):

```nginx
# nginx.conf -- allow 200 MB uploads through the proxy
client_max_body_size 200M;
```

Для YARP, API-шлюза или облачного балансировщика нагрузки найдите эквивалентную настройку размера запроса в конфигурации этого уровня. Увеличение лимитов на стороне приложения не поможет, пока прокси не пропустит тело.

## Подводные камни и варианты

- **`413` - это не `400`.** `413 Request Entity Too Large` приходит от `MaxRequestBodySize` в Kestrel. `400 Bad Request` с `InvalidDataException: Multipart body length limit ... exceeded` приходит от `FormOptions.MultipartBodyLengthLimit`. Это разные лимиты с разными значениями по умолчанию (30 МБ против 128 МиБ). Читайте тип исключения, а не только код статуса.
- **HttpSys возвращает `500`, а не `413`.** Если вы хостите на `HttpSys` вместо Kestrel, превышение `HttpSysOptions.MaxRequestBodySize` даёт `500 Internal Server Error`, а не `413`. Та же коренная причина, другая поверхность.
- **Байты, а не мебибайты.** Значение по умолчанию - `30000000` (тридцать миллионов) байт, то есть около 28,6 МиБ, а не 30 МиБ. Если вы вычисляете лимит из "мегабайт", решите, что вы имеете в виду - `1024 * 1024` или `1000 * 1000`, и будьте последовательны, чтобы файл в 30 МБ не проваливался на лимите в "30 МБ".
- **Не тянитесь к `null` в продакшене.** Полное удаление лимита превращает каждый endpoint загрузки в мишень для исчерпания памяти или диска. Сочетайте щедрый лимит с потоковой передачей, чтобы никогда не буферизовать файл целиком. См. [как передать файл из endpoint ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) и [как загрузить большой файл потоком в Azure Blob Storage](/ru/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).
- **У Blazor Server и SignalR свой лимит.** Большая загрузка по каналу SignalR или Blazor Server ограничена `HubOptions.MaximumReceiveMessageSize` (по умолчанию 32 КБ), а не `MaxRequestBodySize`. Это другое решение в другом месте.
- **Клиент может закрыть соединение первым.** `413` часто приходит с `Connection: close`, и некоторые HTTP-клиенты сообщают об этом как об ошибке сокета, а не как о чистом `413`. Логируйте серверную `BadHttpRequestException`, чтобы подтвердить настоящую причину, а не доверять строке ошибки клиента.

Ментальная модель: загрузка проходит через стек ворот размера (прокси, IIS, размер тела Kestrel, размер multipart-формы) и отклоняется первыми же воротами, которые она превышает. Найдите уровень, породивший ваш `413`, увеличьте этот лимит до реального, ограниченного значения и сочетайте его с потоковой передачей, чтобы больший лимит не стал большей уязвимостью.

## Связанное

- [Как передать файл из endpoint ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) - как отдавать большие файлы, не загружая их в память.
- [Как загрузить большой файл потоком в Azure Blob Storage](/ru/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) - как отправлять большие загрузки напрямую в blob storage.
- [Исправление: "415 Unsupported Media Type" от endpoint минимального API в ASP.NET Core 11](/ru/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) - для родственной ошибки, когда Content-Type запроса неверный.
- [Как настроить ответы об ошибках валидации minimal API через IProblemDetailsService в ASP.NET Core 11](/ru/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) - как превратить голый код статуса в полезное тело ошибки.
- [Как добавить сжатие ответов в API на ASP.NET Core 11](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) - как исходящий аналог входящих лимитов тела.

## Источники

- ASP.NET Announcements, [New default 30 MB (~28.6 MiB) max request body size limit](https://github.com/aspnet/Announcements/issues/267) (значение по умолчанию 30 000 000 байт в Kestrel и HttpSys, `413` в Kestrel и `500` в HttpSys, `MaxRequestBodySize`, `IHttpMaxRequestBodySizeFeature`, `[RequestSizeLimit]` / `[DisableRequestSizeLimit]`, поведение за IIS).
- Microsoft Learn, [Upload files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads?view=aspnetcore-10.0) (значение по умолчанию 134 217 728 байт для `FormOptions.MultipartBodyLengthLimit`, `[RequestFormLimits]`, `IISServerOptions.MaxRequestBodySize`, `maxAllowedContentLength` в `web.config`).
- Microsoft Learn, [IRequestSizeLimitMetadata.MaxRequestBodySize](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.metadata.irequestsizelimitmetadata.maxrequestbodysize?view=aspnetcore-10.0) (интерфейс metadata, который реализуют атрибуты лимита размера).
- dotnet/aspnetcore, [Minimal API endpoints accepting IFormFile terminating with HTTP 200 for large files](https://github.com/dotnet/aspnetcore/issues/50871) (почему `IHttpMaxRequestBodySizeFeature` нельзя задать после того, как multipart-тело привязано в minimal API).
