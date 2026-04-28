---
title: "Как загрузить большой файл потоком в Azure Blob Storage"
description: "Загружайте многогигабайтные файлы в Azure Blob Storage из .NET 11, не помещая их в память. BlockBlobClient.UploadAsync со StorageTransferOptions, MultipartReader для загрузок в ASP.NET Core, и ловушки буферизации, которые отправляют ваш payload на LOH."
pubDate: 2026-04-28
tags:
  - "azure"
  - "dotnet"
  - "dotnet-11"
  - "aspnet-core"
  - "streaming"
lang: "ru"
translationOf: "2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage"
translatedBy: "claude"
translationDate: 2026-04-28
---

Откройте источник как `Stream` и передайте его напрямую в `BlockBlobClient.UploadAsync(Stream, BlobUploadOptions)` с заданными `StorageTransferOptions`. Azure SDK разбивает поток на блоки block-blob, выкладывает их параллельно (staging) и фиксирует список блоков, когда поток заканчивается. Вы никогда не выделяете `byte[]` больше, чем `MaximumTransferSize`, а исходный поток читается один раз, только вперёд. Шаблоны, которые тихо ломают это: копирование тела запроса в `MemoryStream`, "чтобы узнать длину"; вызов `IFormFile.OpenReadStream` после того, как ASP.NET Core уже забуферизовал форму в память; и забывание задать `MaximumConcurrency`, что оставляет вас загружающим по 4 MiB за раз в одном потоке к сервису, который с радостью принял бы двадцать параллельных staging-операций над блоками.

Эта статья ориентирована на `Azure.Storage.Blobs` 12.22+, .NET 11 и ASP.NET Core 11. Используемые здесь ограничения протокола block-blob (4000 MiB на блок, 50 000 блоков, ~190.7 TiB всего на blob) требуют x-ms-version `2019-12-12` или новее, что SDK согласует по умолчанию.

## Стандартный путь загрузки уже как-то стримит

`BlobClient.UploadAsync(Stream)` делает правильную вещь для потока неизвестной длины: читает до `InitialTransferSize` байт, и если поток закончился в этом окне, отправляет один запрос `PUT Blob`. Иначе переключается на загрузку блоками со staging, читая по `MaximumTransferSize` байт и вызывая `PUT Block` параллельно вплоть до `MaximumConcurrency`. Когда исходный поток возвращает 0 байт, отправляется `PUT Block List` для фиксации порядка.

Значения по умолчанию в 12.22: `InitialTransferSize = 256 MiB`, `MaximumTransferSize = 8 MiB`, `MaximumConcurrency = 8`. Оставлять их как есть для больших загрузок плохо по двум причинам. Во-первых, `InitialTransferSize = 256 MiB` означает, что SDK будет буферизовать до 256 MiB внутри, прежде чем решит, использовать ли один PUT, даже если вы передали ему поток в 50 GiB, который очевидно не помещается. Во-вторых, `MaximumConcurrency = 8` нормально для канала 1 Гбит/с к расположенной рядом storage-учётной записи, но является узким местом для загрузок между регионами, где каждый round-trip PUT стоит 80-200 мс.

```csharp
// .NET 11, Azure.Storage.Blobs 12.22
var transferOptions = new StorageTransferOptions
{
    InitialTransferSize = 8 * 1024 * 1024,   // 8 MiB. Always go via block uploads for large files.
    MaximumTransferSize = 8 * 1024 * 1024,   // 8 MiB blocks. Sweet spot for most networks.
    MaximumConcurrency  = 16                  // Parallel PUT Block calls.
};

var uploadOptions = new BlobUploadOptions
{
    TransferOptions = transferOptions,
    HttpHeaders     = new BlobHttpHeaders { ContentType = "application/octet-stream" }
};

await using FileStream source = File.OpenRead(localPath);
await blobClient.UploadAsync(source, uploadOptions, cancellationToken);
```

Размеры блоков от 4 MiB до 16 MiB - оптимальный диапазон для Standard storage-учётных записей. Меньшие блоки тратят round-trip-ы на накладные расходы `PUT Block`; большие блоки делают повторы дорогими, потому что временный 503 заставляет SDK заново отправлять весь блок.

## Лимиты block-blob решают размер блока за вас

У block-blob-ов Azure есть жёсткие лимиты, в которые рано или поздно упрётся подход "просто стримим". Это 50 000 блоков на blob, каждый блок не более 4000 MiB, максимальный размер blob - 190.7 TiB (50 000 x 4000 MiB). Для загрузки в 200 GiB блокам по 4 MiB понадобилось бы 51 200 блоков - на один больше предела. Поэтому:

- До ~195 GiB: подходит любой размер блока от 4 MiB.
- 195 GiB до ~390 GiB: минимум 8 MiB.
- 1 TiB: минимум 21 MiB. Дефолт SDK 8 MiB упадёт посреди загрузки с `BlockCountExceedsLimit`.

SDK не повышает размер блока за вас. Если длина источника известна заранее, посчитайте требуемый размер блока и задайте `MaximumTransferSize` соответственно:

```csharp
// .NET 11
static long PickBlockSize(long contentLength)
{
    const long maxBlocks = 50_000;
    const long minBlock  = 4 * 1024 * 1024;          // 4 MiB
    const long maxBlock  = 4000L * 1024 * 1024;      // 4000 MiB

    long required = (contentLength + maxBlocks - 1) / maxBlocks;
    long rounded  = ((required + minBlock - 1) / minBlock) * minBlock;
    return Math.Clamp(rounded, minBlock, maxBlock);
}
```

Для загрузок неизвестной длины (генерируемый архив, серверный fan-in) по умолчанию используйте блоки 16 MiB. Это даёт запас до ~780 GiB без необходимости поднимать лимит позже.

## ASP.NET Core: стримите тело запроса, а не `IFormFile`

Самый частый способ испортить весь конвейер - `IFormFile`. Когда приходит multipart-загрузка, `FormReader` в ASP.NET Core читает тело целиком в коллекцию формы до того, как запустится ваш action. Всё ниже `FormOptions.MemoryBufferThreshold` (по умолчанию 64 KiB на значение формы, но файловая часть подчиняется `MultipartBodyLengthLimit` 128 MiB) идёт в память; всё выше идёт в `Microsoft.AspNetCore.WebUtilities.FileBufferingReadStream`, то есть во временный файл на диске. В любом случае к моменту запуска вашего обработчика загрузка уже прочитана один раз и куда-то скопирована. `IFormFile.OpenReadStream()` теперь - это `FileStream` поверх той временной копии.

Это убивает три вещи разом. Вы платите за дисковый I/O за буфер, который не нужен. Запрос идёт вдвое дольше, потому что байты проходят с сокета во временный файл, а потом из временного файла в SDK и в Azure. И `MultipartBodyLengthLimit` ставит потолок 128 MiB на каждую загрузку по умолчанию.

Решение - отключить биндинг формы и прочитать multipart-поток самому через `MultipartReader`:

```csharp
// .NET 11, ASP.NET Core 11
[HttpPost("upload")]
[DisableFormValueModelBinding]
[RequestSizeLimit(50L * 1024 * 1024 * 1024)]      // 50 GiB
[RequestFormLimits(MultipartBodyLengthLimit = 50L * 1024 * 1024 * 1024)]
public async Task<IActionResult> Upload(CancellationToken ct)
{
    if (!MediaTypeHeaderValue.TryParse(Request.ContentType, out var mediaType) ||
        !mediaType.MediaType.Equals("multipart/form-data", StringComparison.OrdinalIgnoreCase))
    {
        return BadRequest("Expected multipart/form-data.");
    }

    string boundary = HeaderUtilities.RemoveQuotes(mediaType.Boundary).Value!;
    var reader = new MultipartReader(boundary, Request.Body);

    MultipartSection? section;
    while ((section = await reader.ReadNextSectionAsync(ct)) != null)
    {
        var contentDisposition = section.GetContentDispositionHeader();
        if (contentDisposition is null || !contentDisposition.IsFileDisposition()) continue;

        string fileName = Path.GetFileName(contentDisposition.FileName.Value!);
        var blob = _container.GetBlockBlobClient(fileName);

        var options = new BlobUploadOptions
        {
            TransferOptions = new StorageTransferOptions
            {
                InitialTransferSize = 8 * 1024 * 1024,
                MaximumTransferSize = 16 * 1024 * 1024,
                MaximumConcurrency  = 16
            },
            HttpHeaders = new BlobHttpHeaders
            {
                ContentType = section.ContentType ?? "application/octet-stream"
            }
        };

        await blob.UploadAsync(section.Body, options, ct);
    }

    return Ok();
}
```

`section.Body` - это сетевой поток, читающий прямо из тела запроса. Azure SDK читает из него, нарезает на блоки и загружает. Память ограничена `MaximumTransferSize * MaximumConcurrency` (256 MiB в примере выше). Атрибут `[DisableFormValueModelBinding]` - это маленький пользовательский фильтр, убирающий стандартные form-value-провайдеры фреймворка, чтобы MVC не пытался забиндить тело до запуска вашего action:

```csharp
// .NET 11, ASP.NET Core 11
public class DisableFormValueModelBindingAttribute : Attribute, IResourceFilter
{
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var factories = context.ValueProviderFactories;
        factories.RemoveType<FormValueProviderFactory>();
        factories.RemoveType<FormFileValueProviderFactory>();
        factories.RemoveType<JQueryFormValueProviderFactory>();
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }
}
```

`[RequestSizeLimit]` и `[RequestFormLimits]` оба обязательны: первый - это потолок тела запроса в Kestrel, второй - `FormOptions.MultipartBodyLengthLimit`. Забыв любой из них, вы получите отказ загрузки на 30 MiB или 128 MiB соответственно, причём ошибка не упомянет multipart.

## Аутентификация без SAS

`DefaultAzureCredential` из `Azure.Identity` - правильный дефолт для любого сервиса, работающего в Azure (App Service, AKS, Functions, Container Apps). Контейнеру нужна роль `Storage Blob Data Contributor` на storage-учётной записи. Локально тот же код работает через `az login` или Azure-учётную запись VS Code.

```csharp
// .NET 11, Azure.Identity 1.13+, Azure.Storage.Blobs 12.22+
var serviceUri = new Uri($"https://{accountName}.blob.core.windows.net");
var service    = new BlobServiceClient(serviceUri, new DefaultAzureCredential());
var container  = service.GetBlobContainerClient("uploads");
await container.CreateIfNotExistsAsync(cancellationToken: ct);

var blob = container.GetBlockBlobClient(blobName);
```

Избегайте хранения connection string-ов с ключом учётной записи в настройках приложения. Ключ аутентифицирует на уровне всей storage-учётной записи, то есть утёкший ключ даёт полный доступ к каждому контейнеру и каждому blob, включая удаление. Те же пути загрузки работают с `BlobSasBuilder`, если браузер загружает напрямую, минуя ваш сервер.

## Прогресс, повторы и возобновление

SDK вызывает `IProgress<long>` после каждого блока. Используйте для UI, но не для бухгалтерии: значение - это накопленное число переданных байт, включая байты, которые повторялись.

```csharp
// .NET 11
var progress = new Progress<long>(bytes =>
{
    Console.WriteLine($"{bytes:N0} bytes transferred");
});

var options = new BlobUploadOptions
{
    TransferOptions  = transferOptions,
    ProgressHandler  = progress
};
```

Транспортный уровень повторяет `PUT Block` автоматически с экспоненциальной задержкой (`RetryOptions` по умолчанию: 3 повтора, начальная задержка 0.8 с). Для многочасовой загрузки в нестабильной сети поднимите `RetryOptions.MaxRetries` и `NetworkTimeout` в `BlobClientOptions` до создания клиента:

```csharp
// .NET 11
var clientOptions = new BlobClientOptions
{
    Retry =
    {
        MaxRetries     = 10,
        Delay          = TimeSpan.FromSeconds(2),
        MaxDelay       = TimeSpan.FromSeconds(60),
        Mode           = RetryMode.Exponential,
        NetworkTimeout = TimeSpan.FromMinutes(10)
    }
};

var service = new BlobServiceClient(serviceUri, new DefaultAzureCredential(), clientOptions);
```

`UploadAsync` не возобновляется между перезапусками процесса. Если процесс умирает, staging-блоки, не подтверждённые коммитом, остаются на storage-учётной записи до семи дней, потом собираются мусорщиком. Чтобы возобновить вручную, вызовите `BlockBlobClient.GetBlockListAsync(BlockListTypes.Uncommitted)` для получения списка staging-блоков, продолжите чтение источника с этого смещения и вызовите `CommitBlockListAsync` со склеенным списком. Большинству приложений это не нужно; перезапустить загрузку с байта 0 проще, и параллелизм SDK делает это дешёвым.

## CancellationToken: передавайте везде

`CancellationToken`, который вы передаёте в `UploadAsync`, учитывается на каждом staging-блоке, но только между блоками. Один `PUT Block` не отменяется в полёте; SDK ждёт его завершения (или падения) перед тем, как наблюдать токен. Для блока 16 MiB на канале 1 Гбит/с это ~130 мс - это нормально. На канале 10 Мбит/с это 13 секунд. Если важна быстрая отмена, уменьшите `MaximumTransferSize` до 4 MiB, чтобы наихудший случай блока в полёте был маленьким.

То же самое предупреждение применимо, если вы выставляете `NetworkTimeout` очень большим. `CancellationToken` не прерывает зависший сокет: это делает таймаут. Держите `NetworkTimeout` меньше вашей приемлемой задержки отмены. Шаблон кооперативной отмены такой же, как подробно разобран в [отмене долгоиграющей Task в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/): передавайте токен вниз, давайте `OperationCanceledException` распространяться и убирайте за собой в `finally`.

## Проверка загрузки

Для block-blob-ов MD5 каждого блока проверяется сервисом автоматически, если вы задаёте `TransactionalContentHash`, но SDK задаёт это только для пути с одним PUT, а не для пути со staging-блоками. Чтобы проверять целостность от конца до конца с чанковыми загрузками, задайте хеш всего blob в `BlobHttpHeaders.ContentHash`. Сервис хранит его и возвращает в `Get Blob Properties`, но **не** валидирует при загрузке. Вам надо посчитать его на клиенте и перепроверить при скачивании.

```csharp
// .NET 11
using var sha = SHA256.Create();
await using var hashed = new CryptoStream(source, sha, CryptoStreamMode.Read, leaveOpen: true);

await blob.UploadAsync(hashed, options, ct);

byte[] hash = sha.Hash!;
await blob.SetHttpHeadersAsync(new BlobHttpHeaders { ContentHash = hash }, cancellationToken: ct);
```

Оборачивание источника в `CryptoStream` добавляет затраты на CPU (~600 МБ/с SHA-256 на современном железе), но это единственный способ посчитать хеш без буферизации. Пропустите это, если канал HTTPS и вы доверяете транспортной целостности Azure.

## Что тихо буферизует

Даже с правильным вызовом SDK три шаблона воскресят проблему с памятью, которую вы пытались избежать:

1. `Stream.CopyToAsync(memoryStream)`, "чтобы посмотреть заголовки". Не делайте так для чего-либо больше нескольких MiB. Если нужны первые байты, читайте в `Span<byte>`, выделенный на стеке, и `Stream.Position = 0` только если поток поддерживает seek. Большинство сетевых потоков не поддерживают, в этом случае используйте небольшой `BufferedStream`.
2. Логирование тела запроса. Body-capture-middleware в Serilog/NLog может буферизовать весь payload, чтобы сделать его логируемым. Отключите для маршрутов загрузки.
3. Возврат `IActionResult` после загрузки путём установки заголовков `Response.Body`. Форматтер `ObjectResult` фреймворка может сериализовать status-объект обратно в буферизованный ответ. После стриминговой загрузки возвращайте `Results.Ok()` или `NoContent()`, а не большой объект.

Sanity-проверка "это правда стрим?" - смотреть на working set процесса во время загрузки 5 GiB. С SDK и `StorageTransferOptions`, настроенными как в этой статье, working set должен держаться около `MaximumTransferSize * MaximumConcurrency + ~50 MiB` накладных расходов. Всё, что растёт линейно с размером загрузки, - баг где-то в вашем конвейере.

## Связанное

- [Стриминг файла из endpoint ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) разбирает зеркальную сторону скачивания этой статьи.
- [Чтение большого CSV в .NET 11 без переполнения памяти](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) проходит стриминг с ограниченным буфером для парсинга, который хорошо сочетается с шаблоном загрузки отсюда, когда вы трансформируете данные по дороге в blob storage.
- [Отмена долгоиграющей Task в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) глубже разбирает распространение `CancellationToken`, что важно для любой многоминутной загрузки.
- [Использование `IAsyncEnumerable<T>` с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) для случая стримингового экспорта, когда строки из EF Core напрямую льются в blob.

## Ссылки на источники

- [Release notes Azure.Storage.Blobs 12.22](https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/storage/Azure.Storage.Blobs/CHANGELOG.md)
- [Цели масштабируемости block-blob](https://learn.microsoft.com/en-us/rest/api/storageservices/scalability-targets-for-the-azure-blob-storage-service)
- [REST API Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block)
- [Справочник `StorageTransferOptions`](https://learn.microsoft.com/en-us/dotnet/api/azure.storage.storagetransferoptions)
- [Руководство ASP.NET Core по загрузке больших файлов](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads)
