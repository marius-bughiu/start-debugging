---
title: "Как передавать файл из конечной точки ASP.NET Core без буферизации"
description: "Отдавайте большие файлы из ASP.NET Core 11, не загружая их в память. Три уровня: PhysicalFileResult для файлов на диске, Results.Stream для произвольных потоков и Response.BodyWriter для генерируемого контента -- с кодом для каждого случая."
pubDate: 2026-04-24
tags:
  - "aspnet-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "streaming"
lang: "ru"
translationOf: "2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Используйте `PhysicalFileResult` (или `Results.File(path, contentType)` в Minimal APIs) для файлов, уже находящихся на диске -- Kestrel внутренне вызывает системный вызов `sendfile` операционной системы, поэтому байты файла никогда не попадают в управляемую память. Для потоков, не существующих на диске -- Azure Blob, объект S3, динамически генерируемый архив -- возвращайте `FileStreamResult` или `Results.Stream(factory, contentType)` и открывайте лежащий в основе `Stream` лениво внутри делегата factory. Для полностью генерируемого контента пишите напрямую в `HttpContext.Response.BodyWriter`. Во всех трёх случаях паттерн, который незаметно уничтожает масштабируемость -- это сначала скопировать содержимое в `MemoryStream`: это загружает весь payload в управляемую кучу, как правило в Large Object Heap, прежде чем хоть один байт достигнет клиента.

Эта статья ориентирована на .NET 11 и ASP.NET Core 11 (preview 3). Всё в уровнях 1 и 2 работает начиная с .NET 6; подход с `BodyWriter` стал удобным со стабильными API `System.IO.Pipelines` в .NET 5 и с тех пор не изменился.

## Почему буферизация ответа устроена иначе, чем кажется

Когда говорят "стримить файл", обычно имеют в виду "не читать всё в память". Это верно, но есть вторая часть: не буферизовать и ответ. Middleware кэширования вывода и сжатия ответов в ASP.NET Core могут прозрачно вновь ввести буферизацию. Если вы используете `AddResponseCompression` и не настроили его, небольшие файлы (ниже порога по умолчанию в 256 байт) никогда не сжимаются, но большие файлы полностью буферизуются в `MemoryStream` до записи сжатых байтов. Решение для больших файлов -- либо сжатие на уровне CDN, либо консервативная настройка `MimeTypes` в `ResponseCompressionOptions` с исключением бинарных типов контента из сжатия.

Буферизация ответа также происходит внутри фреймворка при возврате `IResult` или `ActionResult` из action контроллера: фреймворк сначала записывает статус и заголовки, затем вызывает `ExecuteAsync` на результате, где и происходит фактическая передача байтов. В .NET 6 `Results.File(path, ...)` вызывал `PhysicalFileResultExecutor.WriteFileAsync`, который делегировал в `IHttpSendFileFeature.SendFileAsync` -- путь без копирования. В .NET 7 рефакторинг ввёл регрессию, при которой `Results.File` оборачивал `FileStream` в `StreamPipeWriter`, обходя `IHttpSendFileFeature` и заставляя ядро ненужно копировать страницы файла в пространство пользователя (отслеживается как [issue #45037](https://github.com/dotnet/aspnetcore/issues/45037)). Эта регрессия была исправлена, но она иллюстрирует, что "правильный" тип результата важен для производительности, а не только для корректности.

## Уровень 1: Файлы, уже находящиеся на диске

Для файлов на диске правильный тип возврата -- `PhysicalFileResult` в MVC-контроллерах или `Results.File(physicalPath, contentType)` в Minimal APIs. Оба принимают строку физического пути вместо `Stream`, что позволяет исполнителю проверить, доступен ли `IHttpSendFileFeature` в текущем транспорте. Kestrel на Linux предоставляет эту возможность и использует `sendfile(2)` -- байты идут из кэша страниц ОС прямо в буфер сокета, никогда не копируясь в процесс .NET. На Windows Kestrel использует `TransmitFile` через порт завершения ввода-вывода с тем же эффектом.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API
app.MapGet("/downloads/{filename}", (string filename, IWebHostEnvironment env) =>
{
    string physicalPath = Path.Combine(env.ContentRootPath, "downloads", filename);

    if (!File.Exists(physicalPath))
        return Results.NotFound();

    return Results.File(
        physicalPath,
        contentType: "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
});
```

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller
[HttpGet("downloads/{filename}")]
public IActionResult Download(string filename)
{
    string physicalPath = Path.Combine(_env.ContentRootPath, "downloads", filename);

    if (!System.IO.File.Exists(physicalPath))
        return NotFound();

    return PhysicalFile(
        physicalPath,
        "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
}
```

Два замечания о пути. Во-первых, не передавайте имена файлов от пользователя напрямую в `Path.Combine` без проверки. Код выше -- это каркас: убедитесь, что разрешённый путь по-прежнему находится в разрешённом каталоге, прежде чем вызывать `File.Exists`. Во-вторых, `IWebHostEnvironment.ContentRootPath` разрешается в рабочий каталог приложения, а не в `wwwroot`. Для публичных статических ресурсов middleware статических файлов с `app.UseStaticFiles()` уже обрабатывает range-запросы и ETag, и вы должны предпочесть его ручной конечной точке для файлов в `wwwroot`.

## Уровень 2: Потоковая передача из произвольного Stream

Объект S3, Azure Blob, столбец `varbinary(max)` базы данных -- все они возвращают `Stream`, у которого нет соответствующего пути на диске, поэтому `PhysicalFileResult` не применим. Правильный тип здесь -- `FileStreamResult` в контроллерах или `Results.Stream` в Minimal APIs.

Критическая деталь -- открывать `Stream` лениво. `Results.Stream` принимает перегрузку factory `Func<Stream>`; используйте её, чтобы поток не открывался до записи заголовков ответа и подтверждения жизнеспособности соединения. Если factory выбрасывает исключение (например, потому что blob больше не существует), фреймворк ещё может вернуть 404, прежде чем заголовки будут зафиксированы.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- потоковая передача из Azure Blob Storage
app.MapGet("/blobs/{blobName}", async (
    string blobName,
    BlobServiceClient blobService,
    CancellationToken ct) =>
{
    var container = blobService.GetBlobContainerClient("exports");
    var blob = container.GetBlobClient(blobName);

    if (!await blob.ExistsAsync(ct))
        return Results.NotFound();

    BlobProperties props = await blob.GetPropertiesAsync(cancellationToken: ct);

    return Results.Stream(
        streamWriterCallback: async responseStream =>
        {
            await blob.DownloadToAsync(responseStream, ct);
        },
        contentType: props.ContentType,
        fileDownloadName: blobName,
        lastModified: props.LastModified,
        enableRangeProcessing: false); // Azure обрабатывает range на источнике; отключаем двойную обработку
});
```

`Results.Stream` имеет две перегрузки: одна принимает `Stream` напрямую, другая -- callback `Func<Stream, Task>` (показан выше). Предпочтительна форма с callback, когда источник -- сетевой поток, так как ввод-вывод откладывается до момента, когда фреймворк готов записать тело ответа. Callback получает `Stream` тела ответа в качестве аргумента; пишите в него исходные данные.

Для контроллеров `FileStreamResult` требует передавать поток напрямую. Открывайте его как можно позже в методе action и используйте `FileOptions.Asynchronous | FileOptions.SequentialScan` при открытии экземпляров `FileStream`, чтобы избежать блокировки пула потоков:

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller -- потоковая передача из локальной файловой системы через FileStreamResult
[HttpGet("exports/{id}")]
public async Task<IActionResult> GetExport(Guid id, CancellationToken ct)
{
    string? path = await _exportService.GetPathAsync(id, ct);

    if (path is null)
        return NotFound();

    var fs = new FileStream(
        path,
        new FileStreamOptions
        {
            Mode    = FileMode.Open,
            Access  = FileAccess.Read,
            Share   = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    return new FileStreamResult(fs, "application/octet-stream")
    {
        FileDownloadName    = $"{id}.bin",
        EnableRangeProcessing = true,
    };
}
```

Фреймворк освобождает `fs` после отправки ответа. Блок `using` вокруг него не нужен.

## Уровень 3: Запись генерируемого контента в pipe ответа

Иногда контент не существует нигде -- он генерируется на лету: отчёт, рендеренный в PDF, CSV, собранный из результатов запросов, ZIP, созданный из выбранных файлов. Наивный подход -- рендерить в `MemoryStream`, а затем возвращать его как `FileStreamResult`. Это работает, но весь payload должен быть в памяти, прежде чем клиент получит первый байт. Для экспорта 200 МБ это 200 МБ на Large Object Heap на каждый параллельный запрос.

Правильный подход -- писать напрямую в `HttpContext.Response.BodyWriter`, который является `PipeWriter`, поддерживаемым пулом буферов по 4 КБ. Фреймворк сбрасывает в сокет инкрементально; использование памяти ограничено окном in-flight, а не размером файла.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- потоковая передача генерируемого CSV-отчёта
app.MapGet("/reports/{year:int}", async (
    int year,
    ReportService reports,
    HttpContext ctx,
    CancellationToken ct) =>
{
    ctx.Response.ContentType = "text/csv";
    ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"report-{year}.csv\"";

    var writer = ctx.Response.BodyWriter;

    await writer.WriteAsync("id,date,amount\n"u8.ToArray(), ct);

    await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
    {
        string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
        await writer.WriteAsync(Encoding.UTF8.GetBytes(line), ct);
    }

    await writer.CompleteAsync();
    return Results.Empty;
});
```

Обратите внимание на использование `"id,date,amount\n"u8.ToArray()` -- UTF-8 строковый литерал, введённый в C# 11, производящий `byte[]` без выделения памяти. Для строк записей `Encoding.UTF8.GetBytes(line)` всё ещё выделяет; чтобы устранить это, запросите буфер напрямую у writer:

```csharp
// .NET 11, C# 14 -- запись без выделения с использованием PipeWriter.GetMemory
await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
{
    string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
    int byteCount = Encoding.UTF8.GetByteCount(line);
    Memory<byte> buffer = writer.GetMemory(byteCount);
    int written = Encoding.UTF8.GetBytes(line, buffer.Span);
    writer.Advance(written);
    await writer.FlushAsync(ct);
}
```

`GetMemory` / `Advance` / `FlushAsync` -- канонический паттерн `PipeWriter`. `FlushAsync` возвращает `FlushResult`, который сообщает, отменил ли нижестоящий потребитель или завершил работу (`FlushResult.IsCompleted`); у корректно ведущего себя клиента это редко бывает правдой во время загрузки, но проверка внутри цикла позволяет выйти досрочно, если клиент отключится.

Поскольку вы пишете тело ответа напрямую, нельзя вернуть код состояния после того, как первый вызов `FlushAsync` зафиксирует заголовки. Устанавливайте `ctx.Response.StatusCode` до записи байтов. Если вызов сервиса может завершиться неудачей таким образом, что должен вернуть 500, проверьте это до обращения к `BodyWriter`.

Для генерации ZIP специально .NET 11 (через `System.IO.Compression`) позволяет создать `ZipArchive`, записывающий в любой записываемый поток. Передайте `StreamWriter`, оборачивающий `ctx.Response.Body` (не `BodyWriter` напрямую, так как `ZipArchive` ожидает `Stream`, а не `PipeWriter`). Подход рассмотрен в статье [C# ZIP files to Stream](/2023/11/c-zip-files-to-stream/), использующей новую перегрузку `CreateFromDirectory` из .NET 8. Аналогично, если экспорт сжат Zstandard, цепочкой подключите поток-компрессор перед телом ответа -- новый встроенный `ZstandardStream` в [поддержке сжатия Zstandard в .NET 11](/2026/04/dotnet-11-zstandard-compression-system-io/) устраняет зависимость от NuGet.

## Range-запросы: возобновляемые загрузки бесплатно

`EnableRangeProcessing = true` в `FileStreamResult` или `Results.File` даёт ASP.NET Core указание разбирать заголовки запроса `Range` и отвечать с `206 Partial Content`. Фреймворк берёт на себя всё: разбор заголовка `Range`, перемотку потока (для перематываемых потоков), установку заголовков ответа `Content-Range` и `Accept-Ranges`, и отправку только запрошенного диапазона байтов.

Для `PhysicalFileResult` обработка range всегда доступна, так как фреймворк управляет файловым дескриптором. Для `FileStreamResult` обработка range работает только если `Stream.CanSeek` равно `true`. Потоки Azure Blob, возвращаемые `BlobClient.OpenReadAsync`, поддерживают перемотку; сырые потоки `HttpResponseMessage.Content` обычно нет. Если перемотка недоступна, установите `EnableRangeProcessing = false` (значение по умолчанию) и либо отдавайте без поддержки range, либо буферизуйте нужный диапазон самостоятельно.

## Распространённые ошибки, незаметно возвращающие буферизацию

**Возврат `byte[]` из action контроллера.** ASP.NET Core оборачивает его в `FileContentResult`, что допустимо для небольших файлов, но ужасно для больших, поскольку массив байтов выделяется ещё до возврата метода action.

**Вызов `stream.ToArray()` или `MemoryStream.GetBuffer()` для исходного потока.** Оба материализуют весь поток. Если вы делаете это перед вызовом `Results.Stream`, вы сводите на нет потоковую передачу.

**Неверная установка `Response.ContentLength`.** Если `ContentLength` установлен, но поток производит меньше байтов (потому что вы прервали раньше), Kestrel зафиксирует ошибку соединения. Если он слишком мал, клиент прекратит читать после `ContentLength` байтов и может посчитать загрузку завершённой, хотя байты ещё остались. Для динамически генерируемого контента с неизвестным размером заранее опустите `ContentLength` и позвольте клиенту использовать chunked-кодирование.

**Забытая отмена.** Экспорт 2 ГБ занимает минуты. Прокладывание `CancellationToken` через цикл сброса `PipeWriter` позволяет серверу немедленно очиститься, когда клиент закрывает соединение. Статья [как отменить долго выполняющуюся задачу в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) содержит паттерны отмены, предотвращающие дедлоки при завершении потока.

**Использование `IAsyncEnumerable<byte[]>` из контроллера.** JSON-форматтер ASP.NET Core попытается сериализовать массивы байтов как Base64-JSON-токены, а не записывать их напрямую. Используйте `IAsyncEnumerable` только на прикладном уровне для передачи данных в более низкоуровневый цикл записи; не возвращайте его напрямую как результат action для бинарного контента.

**Буферизация сжатого вывода.** `AddResponseCompression` с настройками по умолчанию буферизует весь ответ для сжатия, что сводит на нет всё вышесказанное для текстовых типов контента. Исключите тип контента вашей загрузки из сжатия, сжимайте источник перед потоковой передачей (цепочкой подключите `DeflateStream` или `ZstandardStream` перед pipe ответа), или предварительно сжимайте на CDN.

## Выбор правильного уровня

Файл на диске с известным путём: `Results.File(physicalPath, contentType, enableRangeProcessing: true)`.

Blob или внешний поток: `Results.Stream(callback, contentType)` или `FileStreamResult` с перематываемым потоком.

Генерируемый контент: пишите в `ctx.Response.BodyWriter`, устанавливайте заголовки до первого `FlushAsync`, и прокладывайте `CancellationToken` через цикл.

Общий принцип -- держать pipeline открытым и давать данным течь через него. Как только вы буферизуете весь payload, вы переходите от конечной точки с памятью O(1) к конечной точке с памятью O(N), и при параллельной нагрузке эти N-значения накапливаются, пока процесс не упадёт.

По той же причине, по которой потоковая передача важна здесь, она важна и при чтении больших входных данных: статья [как читать большой CSV в .NET 11, не исчерпав память](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) показывает тот же компромисс со стороны приёма данных.

## Источники

- [FileStreamResult на MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.filestreamresult)
- [Results.Stream на MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.results.stream)
- [IHttpSendFileFeature.SendFileAsync на MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpsendfilefeature.sendfileasync)
- [System.IO.Pipelines на MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [dotnet/aspnetcore issue #45037 -- регрессия Results.File в .NET 7](https://github.com/dotnet/aspnetcore/issues/45037)
- [dotnet/aspnetcore issue #55606 -- избыточный ввод-вывод в FileStreamResult](https://github.com/dotnet/aspnetcore/issues/55606)
- [Сжатие ответов в ASP.NET Core на MS Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression)
