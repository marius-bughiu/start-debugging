---
title: "Как асинхронно создавать и распаковывать ZIP-файлы с помощью асинхронных API ZipArchive в .NET 11"
description: "Используйте ZipFile.CreateFromDirectoryAsync, ExtractToDirectoryAsync, ZipArchive.CreateAsync и ZipArchiveEntry.OpenAsync без скрытого синхронного ввода-вывода. Замеры на .NET 11 RC 1 и .NET 10.0.12, включая баг .NET 10, который до сих пор блокирует Kestrel."
pubDate: 2026-09-14
template: how-to
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "async"
lang: "ru"
translationOf: "2026/09/how-to-create-and-extract-zip-files-asynchronously-with-ziparchive-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Короткий ответ:** для целых папок вызывайте `await ZipFile.CreateFromDirectoryAsync(dir, zipPathOrStream, ct)` и `await ZipFile.ExtractToDirectoryAsync(zipPathOrStream, dir, ct)`. Если нужен контроль над каждой записью, открывайте архив через `await ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding: null, ct)` вместо конструктора, открывайте записи через `await entry.OpenAsync(ct)` и освобождайте и поток записи, и сам архив через `await using`. Пропустите любой из этих трёх `await`, и `System.IO.Compression` молча откатится к синхронному вводу-выводу. Асинхронные API появились в .NET 10, но .NET 10 (это по-прежнему так в 10.0.12) выполняет синхронную запись при освобождении потока записи, даже под `await using`. Только .NET 11 (замерено на RC 1, `11.0.0-rc.1.26425.128`) асинхронен от начала до конца.

Всё, что описано ниже, запускалось на Apple M4 на двух средах выполнения: .NET 10.0.12 (текущий сервисный релиз, собранный с SDK 10.0.302) и .NET 11 RC 1. Тестовые пробы оборачивают целевой поток в `Stream`, который выбрасывает исключение при каждом синхронном `Read`, `Write` и `Flush`. Это тот же контракт, который Kestrel применяет к телам запросов и ответов, поэтому любой скрытый синхронный вызов проявляется как исключение, а не как заблокированный поток, которого вы никогда не заметите.

## Асинхронный API и почему у него нет асинхронного конструктора

API появился по запросу [dotnet/runtime#1541](https://github.com/dotnet/runtime/issues/1541), созданному ещё во времена corefx, и был реализован в [PR #114421](https://github.com/dotnet/runtime/pull/114421) для .NET 10. [Утверждённый вариант](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236) меньше исходного предложения, и его обоснование объясняет большинство подводных камней:

- Конструктор `ZipArchive` выполняет ввод-вывод (в режиме чтения он читает запись конца центрального каталога), а конструкторы нельзя ожидать. Поэтому существует статическая фабрика `ZipArchive.CreateAsync`.
- Метода `GetEntriesAsync` нет. `CreateAsync` должен прочитать центральный каталог до возврата, поэтому синхронное свойство `Entries` лишь отдаёт то, что уже находится в памяти.
- Нет ни `CreateEntryAsync`, ни `DeleteAsync`, потому что `CreateEntry` и `Delete` не выполняют ввод-вывод.
- `ZipArchive` реализует `IAsyncDisposable`, потому что освобождение архива, открытого для записи, записывает центральный каталог.

Вот как синхронные вызовы соотносятся с асинхронными версиями (все принимают необязательный `CancellationToken`):

| Синхронный | Асинхронный (.NET 10+) |
| --- | --- |
| `new ZipArchive(stream, mode, ...)` | `ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding, ct)` |
| `archive.Dispose()` | `archive.DisposeAsync()` |
| `entry.Open()` | `entry.OpenAsync(ct)` |
| `ZipFile.Open` / `OpenRead` | `ZipFile.OpenAsync` / `OpenReadAsync` |
| `ZipFile.CreateFromDirectory` | `ZipFile.CreateFromDirectoryAsync` (назначение: путь или `Stream`) |
| `ZipFile.ExtractToDirectory` | `ZipFile.ExtractToDirectoryAsync` (источник: путь или `Stream`) |
| `archive.CreateEntryFromFile` | `archive.CreateEntryFromFileAsync` |
| `archive.ExtractToDirectory` | `archive.ExtractToDirectoryAsync` |
| `entry.ExtractToFile` | `entry.ExtractToFileAsync` |

.NET 11 добавляет поверх этого новые перегрузки: `OpenAsync(ReadOnlySpan<char> password, ...)`, `OpenAsync(FileAccess, ...)`, `CreateEntryFromFileAsync` с паролем и `ZipEncryptionMethod`, а также перегрузки с `ZipFileCreationOptions` / `ZipExtractionOptions` для вспомогательных методов работы с каталогами. Все они найдены через рефлексию по `System.IO.Compression` на обеих средах выполнения. Работа с паролями разобрана в [статье о зашифрованных ZIP в .NET 11](/ru/2026/08/dotnet-11-preview-7-password-protected-zip-archives/).

## Шаги к полностью асинхронному коду

1. Используйте вспомогательные методы `ZipFile.*Async` для каталогов, когда контроль над отдельными записями не нужен.
2. В противном случае создавайте архив через `await ZipArchive.CreateAsync(...)` или `await ZipFile.OpenAsync(...)`, но никогда через `new ZipArchive(...)`.
3. Открывайте каждую запись через `await entry.OpenAsync(ct)` или используйте `CreateEntryFromFileAsync` / `ExtractToFileAsync`.
4. Освобождайте каждый поток записи через `await using` до освобождения архива.
5. Освобождайте архив через `await using`.
6. Передавайте один `CancellationToken` через всю цепочку и решите, что должно остаться на диске после отменённой распаковки.

## Упаковка и распаковка целой папки

Когда архив должен повторять структуру каталога, статические вспомогательные методы делают всё сами:

```csharp
// .NET 10+, C# 14 (tested on .NET 11 RC 1 and .NET 10.0.12)
using System.IO.Compression;

using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));

// Folder -> .zip file
await ZipFile.CreateFromDirectoryAsync(
    "out/reports", "reports.zip",
    CompressionLevel.Optimal, includeBaseDirectory: false,
    cancellationToken: cts.Token);

// .zip file -> folder
await ZipFile.ExtractToDirectoryAsync(
    "reports.zip", "in/reports",
    overwriteFiles: true, cancellationToken: cts.Token);
```

У обоих методов есть и перегрузки со `Stream`: так можно упаковать данные прямо в сетевой поток или распаковать загруженный файл без временного файла. [Статья о ZIP-файлах в Stream в .NET 8](/ru/2023/11/c-zip-files-to-stream/) описывала синхронные перегрузки со `Stream`, а асинхронные версии устроены так же, плюс токен.

## Создание архива запись за записью

Как только нужно фильтровать, переименовывать или генерировать содержимое, переходите на уровень `ZipArchive`. Здесь важны все три `await`:

```csharp
// .NET 11 RC 1, C# 14
using System.IO.Compression;
using System.Text;

static async Task WriteExportAsync(Stream destination, IEnumerable<string> files, CancellationToken ct)
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        destination, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    // Files from disk, renamed and filtered
    foreach (string path in files.Where(f => !f.EndsWith(".tmp")))
    {
        await zip.CreateEntryFromFileAsync(
            path, $"data/{Path.GetFileName(path)}", CompressionLevel.Fastest, ct);
    }

    // Generated content
    ZipArchiveEntry manifest = zip.CreateEntry("manifest.txt", CompressionLevel.Optimal);
    await using (Stream s = await manifest.OpenAsync(ct))
    {
        await s.WriteAsync(Encoding.UTF8.GetBytes($"created={DateTime.UtcNow:O}\n"), ct);
    }
}
```

Ограничивайте поток записи собственным блоком `await using`, как показано выше, чтобы он освобождался до создания следующей записи. В режиме `Create` одновременно может быть открыта только одна запись, а освобождение потока записи сбрасывает последний сжатый блок и записывает размеры и CRC записи.

Чтение работает так же. `Entries` - обычное свойство, и в .NET 11 оно больше не выполняет ввод-вывод после `CreateAsync`:

```csharp
// .NET 11 RC 1, C# 14
await using ZipArchive zip = await ZipFile.OpenReadAsync("reports.zip", ct);

foreach (ZipArchiveEntry entry in zip.Entries)
{
    if (entry.FullName.EndsWith('/')) continue; // directory entry

    await using Stream source = await entry.OpenAsync(ct);
    await using FileStream target = new(
        Path.Combine("in", entry.Name), FileMode.Create, FileAccess.Write,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous);
    await source.CopyToAsync(target, ct);
}
```

Если вы сами формируете пути из `entry.FullName`, то берёте на себя и проверку путей, которую за вас выполняет `ExtractToDirectoryAsync`. Вспомогательный метод отклоняет записи, которые оказались бы за пределами целевого каталога, а самописный код делает то, что ему скажет `Path.Combine`.

## Что на самом деле даёт каждый `await`: замеры

Вот матрица проб. "Исключение" означает, что код архива сделал хотя бы один синхронный вызов на потоке, который их запрещает. Потоки не поддерживают перемещение (seek), если в строке не сказано иное, как тело запроса в Kestrel.

| Сценарий | .NET 10.0.12 | .NET 11 RC 1 |
| --- | --- | --- |
| `new ZipArchive` (Create) + `Open()` + `using` | исключение | исключение |
| `CreateAsync` + `OpenAsync` + `await using` везде | **исключение** | работает |
| То же, но `using` для архива | исключение | исключение |
| То же, но `using` для потока записи | исключение | исключение |
| `ZipFile.CreateFromDirectoryAsync(dir, stream)` | **исключение** | работает |
| `new ZipArchive` (Read) | исключение | исключение |
| `CreateAsync` (Read) | работает | работает |
| `CreateAsync` (Read), поток с перемещением | **исключение** | работает |
| `CreateAsync` (Read), с перемещением, синхронный `entry.Open()` | исключение | исключение |
| `ZipFile.ExtractToDirectoryAsync(stream, dir)` | работает | работает |
| `CreateAsync` (Update) на потоке без перемещения | `ArgumentException` | `ArgumentException` |

Два вывода. Во-первых, все строки, которые выбрасывают исключение на .NET 11, это случаи, где вы оставили синхронный вызов: конструктор, `Open()` в режиме чтения или обычный `using`. `Dispose()` должен сбросить сжатые данные и записать центральный каталог, а сделать это асинхронно он не может. Во-вторых, строки, выделенные жирным, это баги .NET 10, а не ваши ошибки.

## Баг .NET 10: `await using` всё равно пишет синхронно

В .NET 10 внутренний `WrappedStream`, который `OpenAsync` возвращает в режиме создания, не переопределяет `DisposeAsync`. Базовый `Stream.DisposeAsync` вызывает `Dispose()`, поэтому вся нижележащая цепочка освобождается синхронно, и `DeflateStream` сбрасывает последний блок синхронным `Write`. Стек из моей пробы на .NET 10.0.12:

```text
at System.IO.Compression.DeflateStream.PurgeBuffers(Boolean disposing)
at System.IO.Compression.DeflateStream.Dispose(Boolean disposing)
at System.IO.Compression.CheckSumAndSizeWriteStream.Dispose(Boolean disposing)
at System.IO.Compression.ZipArchiveEntry.DirectToArchiveWriterStream.Dispose(Boolean disposing)
at System.IO.Compression.WrappedStream.Dispose(Boolean disposing)
```

Баг на стороне чтения похож: на потоке с перемещением `CreateAsync` в .NET 10 читает только запись конца центрального каталога и откладывает сам центральный каталог до первого обращения к `Entries`, которое синхронно выполняет `ReadCentralDirectory()`. Потоки без перемещения избегают этого бага случайно, потому что `CreateAsync` сначала копирует их в `MemoryStream` асинхронными чтениями.

Оба бага описаны в [dotnet/runtime#121624](https://github.com/dotnet/runtime/issues/121624) ("Asynchronous Zip Methods still have synchronous calls") и исправлены в [PR #121938](https://github.com/dotnet/runtime/pull/121938), влитом 2025-12-01 с вехой 11.0.0. Исправление занимает 18 строк: настоящий `DisposeAsync` в `WrappedStream` плюс немедленный `EnsureCentralDirectoryReadAsync` в `CreateAsync` для режима чтения. Бэкпорта в `release/10.0` нет. Сервисные релизы .NET 10 вплоть до 10.0.12 по-прежнему падают, и я воспроизвёл это на 10.0.10 и 10.0.12.

С `FileStream` вы бы этого никогда не заметили, потому что синхронная запись лишь ненадолго блокирует поток из пула потоков. С Kestrel всё иначе.

## Потоковая отдача ZIP из конечной точки ASP.NET Core

Это тот случай, который на самом деле важен большинству: собрать архив прямо в `Response.Body`, без временного файла и без `MemoryStream`.

```csharp
// .NET 11 RC 1, ASP.NET Core 11 minimal API
using System.IO.Compression;

app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    ctx.Response.ContentType = "application/zip";
    ctx.Response.Headers.ContentDisposition = "attachment; filename=\"export.zip\"";

    await using ZipArchive zip = await ZipArchive.CreateAsync(
        ctx.Response.Body, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    foreach (string file in Directory.EnumerateFiles(exportFolder))
        await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
});
```

Я запустил это на папке из 100 файлов (по 64 KB каждый) на обеих средах выполнения:

- **.NET 11 RC 1:** `200`, 3 499 034 байта, и `unzip -l` показывает все 100 файлов.
- **.NET 10.0.10:** `200`, **130 байт**. Ушёл локальный заголовок первой записи, затем `DisposeAsync` наткнулся на синхронную запись, Kestrel записал в журнал `InvalidOperationException: Synchronous operations are disallowed. Call WriteAsync or set AllowSynchronousIO to true instead.`, и соединение было разорвано. `unzip -t` сообщает `invalid compressed data to inflate`.

Второй результат как раз опасен. Код состояния уже был отправлен, поэтому клиент видит успешную загрузку повреждённого файла. Та же конечная точка, написанная через `new ZipArchive(...)`, падает на обеих средах выполнения, но хотя бы падает с `500` до записи каких-либо байтов. Подробнее об этом исключении читайте в статье [об исправлении "Synchronous operations are disallowed"](/ru/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

Если вы застряли на .NET 10, собирайте архив в асинхронном временном файле, а затем копируйте его в ответ:

```csharp
// .NET 10 workaround (verified on 10.0.10): the ZIP code does sync I/O against the temp file, never against Kestrel
app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    await using var tmp = new FileStream(Path.GetTempFileName(), FileMode.Create, FileAccess.ReadWrite,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous | FileOptions.DeleteOnClose);

    await using (ZipArchive zip = await ZipArchive.CreateAsync(tmp, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct))
    {
        foreach (string file in Directory.EnumerateFiles(exportFolder))
            await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
    }

    tmp.Position = 0;
    ctx.Response.ContentType = "application/zip";
    ctx.Response.ContentLength = tmp.Length;
    await tmp.CopyToAsync(ctx.Response.Body, ct);
});
```

На .NET 10.0.10 это вернуло корректный архив размером 3.5 MB, и вдобавок вы получаете настоящий `Content-Length`. Альтернатива, установка `IHttpBodyControlFeature.AllowSynchronousIO = true` для запроса, работает, но блокирует по потоку на каждую загрузку. О том, как не держать большие ответы в куче, читайте в статье [о потоковой отдаче файла из конечной точки ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

## Распаковка загруженного ZIP из тела запроса

Обратное направление работает на обеих средах выполнения, потому что тело запроса не поддерживает перемещение:

```csharp
// .NET 10+ (tested on 10.0.10 and 11 RC 1)
app.MapPost("/import", async (HttpRequest req, CancellationToken ct) =>
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        req.Body, ZipArchiveMode.Read, leaveOpen: false, entryNameEncoding: null, ct);

    long total = 0;
    foreach (ZipArchiveEntry entry in zip.Entries)
    {
        await using Stream s = await entry.OpenAsync(ct);
        var buffer = new byte[81920];
        int read;
        while ((read = await s.ReadAsync(buffer, ct)) > 0) total += read;
    }
    return Results.Ok(new { entries = zip.Entries.Count, bytes = total });
});
```

Отправка архива из 100 файлов вернула `{"entries":100,"bytes":6553600}`, а версия с `new ZipArchive(req.Body, ZipArchiveMode.Read)` вернула `500` с вариантом того же исключения для `ReadAsync`. Есть нюанс: индекс ZIP находится в конце файла, поэтому режим чтения поверх потока без перемещения сначала копирует **весь архив в память**. Моему тестовому архиву на 32 MB потребовалось 253 асинхронных чтения, прежде чем стала доступна первая запись. Для больших загрузок сначала запишите тело во временный файл с `FileOptions.Asynchronous` (и проверьте [ограничения на размер запроса](/ru/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)), а затем откройте его. Только помните, что в .NET 10 источник с перемещением возвращает синхронное чтение `Entries`.

## Подводные камни, о которых стоит знать до релиза

**Отмена оставляет наполовину распакованный каталог.** Я отменил `ExtractToDirectoryAsync` на архиве из 1000 записей через 20 ms. Он выбросил `OperationCanceledException`, оставив на диске 129 файлов, один из них обрезанный (на .NET 10.0.12 было 181 файл). Повторный вызов без `overwriteFiles: true` затем падает с `IOException: The file '.../f539.bin' already exists.` Если частичный результат важен, распаковывайте во временный соседний каталог и перемещайте его на место через `Directory.Move` только после завершения задачи. Как передаётся токен, разобрано в статье [о передаче CancellationToken через асинхронные методы](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Асинхронность не делает код быстрее.** Она освобождает потоки на время ожидания ввода-вывода, и только. Упаковка 1000 файлов (64 MB) и распаковка результата, медиана 7 прогонов со `Stopwatch` на локальном SSD (не прогон BenchmarkDotNet):

| Операция | .NET 11 RC 1 синхронно | .NET 11 RC 1 асинхронно | .NET 10.0.12 синхронно | .NET 10.0.12 асинхронно |
| --- | --- | --- | --- | --- |
| `CreateFromDirectory` | 249 ms | 268 ms | 252 ms | 259 ms |
| `ExtractToDirectory` | 103 ms | 108 ms | 84 ms | 101 ms |

Сжатие нагружает CPU, а асинхронный файловый ввод-вывод на быстром локальном диске добавляет немного накладных расходов. Используйте асинхронные API на серверах и в UI-потоках, где заблокированный поток чего-то стоит. Консольная утилита, которая упаковывает результат сборки, ничего от них не выигрывает.

**Режим Update по-прежнему особый случай.** `ZipArchiveMode.Update` требует поток, поддерживающий чтение, запись и перемещение (`ArgumentException: Update mode requires a stream with read, write, and seek capabilities.`), и загружает записи в память по мере их открытия. Он работает с `CreateAsync` и `await using` на потоке с перемещением, но для больших архивов обычно дешевле записать новый архив.

**Синхронный `Open()` не всегда безвреден.** В .NET 11 синхронный `entry.Open()` в режиме создания в моей пробе сработал, потому что открытие новой записи не выполняет ввод-вывод. В режиме чтения он выбрасывает исключение на потоке без синхронных операций на обеих средах выполнения. Просто используйте `OpenAsync` везде и перестаньте за этим следить.

**Реализуете `IAsyncDisposable` сами?** Баг .NET 10 - хрестоматийный пример обёртки, которая забыла пробросить `DisposeAsync`. В статье [о реализации и использовании IAsyncDisposable](/ru/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) разобрано, как сделать это правильно.

### Читайте также

- [Исправление: InvalidOperationException: Synchronous operations are disallowed в ASP.NET Core](/ru/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)
- [Как потоково отдать файл из конечной точки ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)
- [System.IO.Compression читает и пишет зашифрованные ZIP в .NET 11](/ru/2026/08/dotnet-11-preview-7-password-protected-zip-archives/)
- [Как реализовать и использовать IAsyncDisposable с await using в C#](/ru/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)

### Источники

- [dotnet/runtime#1541: Add async ZipFile APIs](https://github.com/dotnet/runtime/issues/1541) и [утверждённый вариант API](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236)
- [dotnet/runtime PR #114421: Zip async implementation](https://github.com/dotnet/runtime/pull/114421)
- [dotnet/runtime#121624: Asynchronous Zip Methods still have synchronous calls](https://github.com/dotnet/runtime/issues/121624)
- [dotnet/runtime PR #121938: Fix async ZipArchive calling non-async Stream methods](https://github.com/dotnet/runtime/pull/121938)
- [ZipArchive.CreateAsync на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchive.createasync)
- [ZipFile.ExtractToDirectoryAsync на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zipfile.extracttodirectoryasync)
