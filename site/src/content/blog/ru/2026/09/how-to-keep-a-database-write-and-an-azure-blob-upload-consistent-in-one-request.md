---
title: "Как согласовать запись в базу данных и загрузку в Azure Blob Storage в рамках одного запроса ASP.NET Core"
description: "Транзакции, охватывающей SQL Server и Blob Storage, не существует. Загружайте по имени, которое база данных уже знает, фиксируйте вторым шагом, компенсируйте при сбое, а окно после аварии пусть подчищает фоновая уборка. Плюс перегрузка UploadAsync, которая молча превращает условное создание в перезапись."
pubDate: 2026-09-20
template: how-to
tags:
  - "aspnet-core"
  - "aspnet-core-11"
  - "azure"
  - "blob-storage"
  - "ef-core-11"
  - "consistency"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request"
translatedBy: "claude"
translationDate: 2026-09-20
---

Короткий ответ: никак. Ни одна транзакция не охватывает реляционную базу данных и Azure Blob Storage, поэтому перестаньте пытаться заставить их фиксироваться вместе и вместо этого сделайте сбой переживаемым. Сначала запишите строку в базу данных, в её собственной зафиксированной транзакции, со статусом `Pending` и именем блоба, которое вы собираетесь использовать; загрузите данные ровно под этим именем, с условным созданием; затем во второй транзакции переведите строку в `Ready`. Каждая точка аварии оставляет либо строку без блоба, либо блоб без видимой строки, и то и другое фоновая уборка способна разрешить, и никогда не оставляет строку, указывающую на несуществующий блоб. Компенсирующие удаления в блоке `catch` добавить стоит, но это оптимизация, а не аргумент в пользу корректности.

Этот пост разбирает четыре порядка действий, из которых можно выбирать, что каждый из них оставляет после себя при сбое, и то поведение Azure SDK, которое определяет, будет ли ваш повтор идемпотентным или разрушительным.

Замечание о версиях и проверке. Всё описанное ниже запускалось на .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) с `Azure.Storage.Blobs` 12.29.2 и `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128. Подписки Azure на этой машине нет, поэтому вызовы к хранилищу идут к эмулятору Azurite 3.37.0, который реализует Blob REST API локально. Там, где эмулятор и рабочий сервис правдоподобно могут различаться, я об этом говорю и ссылаюсь на справочник REST. Со стороны базы данных используется SQLite с уникальным индексом вместо того ограничения, которое есть в вашей настоящей схеме.

## Почему здесь нет транзакции, за которую можно ухватиться

Blob Storage это HTTP-сервис. В нём нет двухфазной фиксации, нет XA-менеджера ресурсов и нет точки подключения к транзакции. `TransactionScope` спокойно обернёт вызов `PutBlob`, потом откатится вокруг него, и блоб после этого останется на месте. То же самое с транзакцией EF Core:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1, Azure.Storage.Blobs 12.29.2
await using (var tx = await db.Database.BeginTransactionAsync())
{
    db.Documents.Add(new Document { Name = "tx", BlobName = blobName, Status = "Ready" });
    await db.SaveChangesAsync();
    await container.GetBlobClient(blobName).UploadAsync(content);
    await tx.RollbackAsync();
}
```

Измеренный результат:

```text
##### E DB transaction rollback does not undo the upload
rows=0 blobs=1
```

Строки нет, а блоб есть. В этих двух строках вся проблема. Раз атомарности не получить, вопрос проектирования становится таким: какое несогласованное состояние вы готовы допустить и кто его подчищает.

Порядков всего два, и у каждого свой отдельный режим отказа.

**Сначала блоб, потом строка.** Если запись в базу данных падает, у вас остаётся осиротевший блоб: хранилище, за которое вы платите и на которое ничто не ссылается. Сломанной ссылки никто не видит.

**Сначала строка, потом блоб.** Если загрузка падает, у вас остаётся строка, указывающая на несуществующий блоб. Каждый читатель, который пойдёт по этому указателю, получит 404.

Осиротевшие блобы стоят денег. Висячие указатели стоят корректности. Выбирайте сироту, а затем сделайте так, чтобы найти её было дёшево.

## Наивный вариант и что он оставляет после себя

Обработчик, который все пишут первым, сначала загружает, потом сохраняет:

```csharp
// .NET 11 RC 1. Do not ship this.
app.MapPost("/documents", async (IFormFile file, string name, AppDb db, BlobContainerClient container) =>
{
    var blobName = $"{Guid.NewGuid():N}{Path.GetExtension(file.FileName)}";
    await using var stream = file.OpenReadStream();
    await container.GetBlobClient(blobName).UploadAsync(stream);

    db.Documents.Add(new Document { Name = name, BlobName = blobName, Status = "Ready" });
    await db.SaveChangesAsync();
    return Results.Created($"/documents/{name}", null);
});
```

Дайте ему имя, которое конфликтует с уникальным индексом, и сохранение бросит исключение уже после того, как байты окажутся в контейнере:

```text
##### A naive: upload then SaveChanges fails
SaveChanges threw SqliteException: SQLite Error 19: 'UNIQUE constraint failed: Documents.Name'
rows=1 blobs=1 orphaned=1
```

Очевидная заплатка это компенсирующее удаление, и оно действительно работает, когда сбой это исключение, которое вы ловите:

```csharp
var blob = container.GetBlobClient(blobName);
await blob.UploadAsync(stream);
db.Documents.Add(entity);
try
{
    await db.SaveChangesAsync();
}
catch (DbUpdateException)
{
    db.ChangeTracker.Clear();
    await blob.DeleteIfExistsAsync(DeleteSnapshotsOption.IncludeSnapshots);
    throw;
}
```

```text
##### B compensating delete in catch
compensating DeleteIfExists returned True
rows=1 blobs=0
```

Обратите внимание на `ChangeTracker.Clear()`. После неудачного `SaveChangesAsync` сущности остаются в трекере в состоянии `Added`, поэтому всё, что переиспользует контекст, включая повтор на том же scoped `DbContext`, снова попытается выполнить ту же вставку. Это та же форма сбоя, что описана в [гарантии идемпотентной обработки сообщений через таблицу inbox](/ru/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/).

Компенсацию можно вынести из endpoint полностью, с помощью перехватчика EF Core, и это стоит сделать, если загрузками занимается больше одного обработчика:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
sealed class BlobCompensationInterceptor(BlobContainerClient container, PendingBlobs pending)
    : SaveChangesInterceptor
{
    public override async Task SaveChangesFailedAsync(
        DbContextErrorEventData eventData, CancellationToken ct = default)
    {
        foreach (var name in pending.Names)
            await container.GetBlobClient(name).DeleteIfExistsAsync(cancellationToken: ct);
        pending.Names.Clear();
    }

    public override ValueTask<int> SavedChangesAsync(
        SaveChangesCompletedEventData eventData, int result, CancellationToken ct = default)
    {
        pending.Names.Clear();
        return ValueTask.FromResult(result);
    }
}
```

Зарегистрируйте `PendingBlobs` как scoped, добавляйте имя блоба туда сразу после загрузки, и `SaveChangesFailedAsync` будет срабатывать на любом неудачном сохранении:

```text
##### F SaveChangesFailedAsync interceptor runs the compensating delete
interceptor: SaveChangesFailedAsync fired for DbUpdateException
rows=1 blobs=0
```

Это по-настоящему полезно, и это всё ещё не аргумент в пользу корректности. Компенсирующее удаление выполняется только тогда, когда ваш процесс жив и способен его выполнить. Вытесненный pod между загрузкой и фиксацией, таймаут пула соединений, убивающий запрос, `TaskCanceledException` из-за отключившегося клиента: ни один из этих случаев не даёт вам блока `catch`. При любом реальном развёртывании сироты будут накапливаться, поэтому нужен протокол, который позволит опознать их позже.

## Протокол, который переживает аварию

Записывайте намерение в базу данных до того, как трогаете хранилище, и сделайте имя блоба значением, которое база данных уже хранит:

1. Вставьте строку со `Status = Pending`, сгенерированным `BlobName` и `CreatedUtc`. Зафиксируйте.
2. Загрузите данные ровно под этим именем блоба, с условным созданием, чтобы повтор не мог затереть байты другого запроса.
3. Обновите строку до `Status = Ready`. Зафиксируйте.
4. Читатели фильтруют по `Status == Ready`. Фоновая уборка удаляет строки `Pending` старше таймаута запроса, сначала блоб, потом строку.

```csharp
// .NET 11 RC 1, ASP.NET Core 11, Azure.Storage.Blobs 12.29.2
app.MapPost("/documents", async (
    IFormFile file, string name, AppDb db, BlobContainerClient container, TimeProvider clock, CancellationToken ct) =>
{
    var doc = new Document
    {
        Name = name,
        BlobName = $"{Guid.NewGuid():N}{Path.GetExtension(file.FileName)}",
        Status = DocumentStatus.Pending,
        CreatedUtc = clock.GetUtcNow().UtcDateTime
    };
    db.Documents.Add(doc);
    await db.SaveChangesAsync(ct);                       // 1: intent is durable

    await using var stream = file.OpenReadStream();
    await container.GetBlobClient(doc.BlobName).UploadAsync(
        stream,
        new BlobUploadOptions
        {
            Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
            Tags = new Dictionary<string, string> { ["state"] = "pending" }
        },
        ct);                                             // 2: bytes land, create-only

    doc.Status = DocumentStatus.Ready;
    await db.SaveChangesAsync(ct);                       // 3: now it is visible
    return Results.Created($"/documents/{doc.Id}", null);
});
```

Пройдитесь по точкам аварии. Упадёте после шага 1 и получите строку `Pending` без блоба: читателям не видна, будет убрана позже. Упадёте после шага 2 и получите строку `Pending` и блоб: всё ещё не видна, и фоновая уборка знает имя блоба, потому что строка его хранит. Именно этого свойства у наивного порядка нет. Сироту, созданную вариантом "сначала блоб", можно найти только перечислив весь контейнер и сравнив его с таблицей; сирота, созданная этим протоколом, это строка, которую вы запрашиваете по индексу.

Фоновая уборка ничем не примечательна, и в этом весь смысл:

```csharp
var cutoff = clock.GetUtcNow().UtcDateTime.AddMinutes(-15);
var stale = await db.Documents
    .Where(d => d.Status == DocumentStatus.Pending && d.CreatedUtc < cutoff)
    .ToListAsync(ct);

foreach (var s in stale)
    await container.GetBlobClient(s.BlobName).DeleteIfExistsAsync(cancellationToken: ct);

db.Documents.RemoveRange(stale);
await db.SaveChangesAsync(ct);
```

```text
##### C pending row -> upload -> mark ready, with a crash before the mark
before sweep: rows=2 pending=1 blobs=2
after sweep:  rows=1 blobs=1 swept=1
```

Ставьте порог длиннее максимальной длительности запроса плюс самой долгой загрузки, которую вы допускаете. Окно в 15 минут щедрое для небольших файлов и совершенно недостаточное, если вы разрешаете многогигабайтные загрузки через [потоковый endpoint](/ru/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).

## Перегрузка UploadAsync, которая превращает безопасное создание в перезапись

`BlobClient.UploadAsync(Stream)` работает только на создание. Это не любезность, описанная в документации, это есть в исходниках: каждая перегрузка без параметра `BlobUploadOptions` передаёт `overwrite: false` вниз, в вызов, который строит условие за вас.

```csharp
// Azure.Storage.Blobs 12.29.2, BlobClient.cs
conditions: overwrite ? null : new BlobRequestConditions { IfNoneMatch = new ETag(Constants.Wildcard) },
```

Перегрузка, принимающая `BlobUploadOptions`, передаёт ваши опции дословно. Она ничего не подставляет. Поэтому в тот момент, когда вы добавляете опции, чтобы задать `StorageTransferOptions`, теги или тип содержимого, условное создание исчезает, если вы не впишете его обратно сами. Измерено, при двух загрузках под одним и тем же именем:

```text
##### I default conditions per UploadAsync overload
UploadAsync(content)                          -> HTTP 409 BlobAlreadyExists
UploadAsync(content, overwrite: false)        -> HTTP 409 BlobAlreadyExists
UploadAsync(content, new BlobUploadOptions()) -> overwrote
UploadAsync(stream)                           -> HTTP 409 BlobAlreadyExists
UploadAsync(stream, new BlobUploadOptions())  -> overwrote
```

Это самый частый способ, которым endpoint загрузки файлов теряет данные. Рефакторинг, добавляющий `MaximumConcurrency` ради производительности, заодно убирает защиту от гонки двух запросов за одно имя, и в диффе об этом ничего не сказано.

Задавайте условие явно каждый раз, когда передаёте опции:

```csharp
new BlobUploadOptions
{
    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
    TransferOptions = new StorageTransferOptions { MaximumConcurrency = 16 }
}
```

С этим условием пять конкурентных писателей в одно имя блоба разрешаются чисто: один выигрывает, четверо получают конфликт, и ничьи байты не заменяются молча.

```text
##### G five concurrent conditional creates of the same blob name
won=1 conflict409=4 other=[] blobs=1
```

Одна оговорка про код состояния. Azurite 3.37.0 отвечает на условное создание поверх существующего блоба кодом `409 BlobAlreadyExists`, и это совпадает с тем, что описывают собственные doc-комментарии Azure SDK ("creates a new block blob or throws if the blob already exists"). Но таблица справочника REST про [условные заголовки в операциях записи](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) указывает `412 Precondition Failed` как ответ на невыполненный `If-None-Match`. Сопоставляйте оба варианта, а не ставьте на один:

```csharp
catch (RequestFailedException e) when (e.Status is 409 or 412)
{
    // Someone already created this blob. For a retry of our own request
    // with the same blob name, that is success, not failure.
}
```

Именно этот `catch` делает endpoint безопасным для повтора. Поскольку имя блоба берётся из строки, записанной на шаге 1, повтор клиента, переиспользующий тот же идентификатор документа, попадает в то же имя, условное создание конфликтует, и вы считаете это уже сделанным.

## Многоблочные загрузки оставляют блоки после себя, когда условие не выполняется

Условное создание проверяется на `Put Block List`, а не на `Put Block`. Для всего, что больше `InitialTransferSize`, SDK сначала выкладывает блоки и фиксирует их в конце, поэтому проигравший писатель уже заплатил за загрузку своих блоков к тому моменту, когда узнаёт о проигрыше:

```text
##### K conditional create on a staged multi-block upload
first staged upload ok, size=12582912
second staged upload -> HTTP 409 BlobAlreadyExists
blocks left uncommitted: 3
```

Эти три незафиксированных блока не видны через `GetBlobsAsync`, и они не бесплатны. Согласно [справочнику Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), незафиксированные блоки собираются сборщиком мусора только если в течение недели с последнего успешного `Put Block` по этому блобу не было успешного `Put Block` или `Put Block List`, и каждый `Put Block` тарифицируется как операция записи. Если в вашем сценарии повторов участвует много крупных конкурентных загрузок в одно имя, посмотрите на счёт за хранилище, прежде чем решать, что это теория.

## Защитите компенсирующее удаление условием по тегу

Опасная инструкция во всём этом это удаление. Фоновая уборка с чуть неверным порогом или компенсирующее удаление, сработавшее на запросе, который на самом деле удался, уничтожает зафиксированный файл. Blob Storage даёт защиту на стороне сервера: `x-ms-if-tags`, который SDK выставляет как `BlobRequestConditions.TagConditions`. Помечайте блоб тегом `state=pending` при загрузке, меняйте его на `committed`, когда переводите строку в `Ready`, и делайте каждое удаление условным по тому, что тег всё ещё говорит `pending`:

```csharp
var guard = new BlobRequestConditions { TagConditions = "\"state\" = 'pending'" };
await container.GetBlobClient(s.BlobName).DeleteIfExistsAsync(conditions: guard, cancellationToken: ct);
```

```text
##### J conditional delete guarded by x-ms-if-tags
delete still-pending     -> deleted=True
delete already-committed -> HTTP 412 ConditionNotMet
remaining: already-committed.txt
```

Сервис отказывает в удалении. Ошибка в вашей фоновой уборке превращается в 412 в журнале, а не в обращение в поддержку. Обратите внимание на права: индексные теги это подресурс, поэтому прав на чтение и запись блоба недостаточно. Нужно разрешение SAS `t` или RBAC-действие `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write`, и тегов не больше 10 на блоб, с ключами длиной от 1 до 128 символов и значениями до 256.

Две вещи, которых схема на тегах вам не даст. `FindBlobsByTags` читает индекс, который обновляется асинхронно, поэтому только что загруженный блоб может какое-то время не появляться в запросе по тегам; [документация Microsoft по индексу блобов](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs) описывает задержки индексации в диапазоне от долей секунды до примерно десяти минут в зависимости от темпа записи. Никогда не принимайте решение о корректности на основе запроса по тегам. И индексные теги блобов поддерживаются только на учётных записях general-purpose v2 и premium block blob; на учётной записи с иерархическим пространством имён это предварительная возможность, которая не интегрируется с управлением жизненным циклом.

## Используйте политику жизненного цикла как подстраховку, а не как основную уборку

Соблазнительно отказаться от фоновой уборки и дать правилу управления жизненным циклом удалять всё, что всё ещё помечено `state=pending`:

```json
{
  "rules": [{
    "name": "delete-abandoned-uploads",
    "enabled": true,
    "type": "Lifecycle",
    "definition": {
      "actions": { "baseBlob": { "delete": { "daysAfterCreationGreaterThan": 1 } } },
      "filters": {
        "blobTypes": [ "blockBlob" ],
        "prefixMatch": [ "documents/" ],
        "blobIndexMatch": [ { "name": "state", "op": "==", "value": "pending" } ]
      }
    }
  }]
}
```

Такое правило иметь стоит, но прочитайте его ограничения, прежде чем на него полагаться. Условия запуска выражаются целыми сутками, поэтому самое узкое окно, которое можно выразить, это одни сутки. Изменение политики может вступать в силу и дожидаться первого запуска до 24 часов. Жизненный цикл поддерживает только проверки на равенство в blob index match, не более 10 условий по тегам и 10 префиксов на правило, а `blobIndexMatch` поддерживается только на учётных записях с плоским пространством имён. Считайте это тем, что ловит пропущенное вашей фоновой уборкой, включая блобы, чьи строки удалило что-то совсем другое.

## Замена файла, который уже есть

Обновления это место, где порядок переворачивается. Когда новая версия заменяет старую, загрузите новый блоб под новым именем, зафиксируйте изменение строки и только потом удалите старый блоб. Удалите первым, и откат оставит строку указывающей на байты, которые вы только что уничтожили.

Для этого пути включите на учётной записи [обратимое удаление блобов](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview). Оно превращает ошибочное удаление в вызов `Undelete Blob` на протяжении срока хранения, и это самая дешёвая страховка, доступная любой системе, которая удаляет данные из хранилища на основании строки в базе данных. Имейте в виду, что действие удаления в политике жизненного цикла не работает на блобе, который уже обратимо удалён, и что удалению с защитой по тегу нужно, чтобы защитный тег всё ещё был на месте.

Если обновление это настоящая проблема конкурентного редактирования, а не проблема согласованности, то со стороны базы данных её решает [токен конкурентности rowversion](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/), а не что-либо в API хранилища.

## Три вещи, которые делать не нужно

Не вызывайте `SaveChangesAsync`, а затем загрузку в рамках того же запроса без состояния `Pending`. Это порядок с висячим указателем, и читатели увидят сломанный документ в тот же миг, когда загрузка упадёт.

Не кладите компенсирующее удаление в `finally`. Оно выполнится и на успешном пути, если не защитить его флагом, а работающая версия это та, которая выполняется только на пути сбоя.

Не выносите загрузку в конвейер запроса, а запись строки в фоновую задачу без долговечной записи, связывающей их. Если очередь задач не в той же транзакции, что и строка, вы просто переместили проблему; ровно для этого случая существует паттерн transactional outbox, и ему нужно то же свойство "одной фиксации", что и таблице inbox.

Форма, которую стоит держать в голове: база данных это источник истины о том, что существует, хранилище это место, где живут байты, и единственный порядок, который никогда не обманывает читателя, это тот, где база данных первой узнаёт имя и последней признаёт, что документ существует.

### Читайте дальше

- [Как загрузить большой файл потоком в Azure Blob Storage](/ru/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/)
- [Как гарантировать идемпотентную обработку сообщений в EF Core 11, когда одно и то же сообщение получают два экземпляра приложения](/ru/2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table/)
- [Как реализовать оптимистичную конкурентность с токеном rowversion в EF Core 11](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Исправление: 413 Request Entity Too Large при загрузке файла в ASP.NET Core 11](/ru/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)
- [Как передавать файл из конечной точки ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

### Источники

- [Specifying conditional headers for Blob service operations](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations), Azure Storage REST API
- [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block), Azure Storage REST API
- [Manage and find Azure Blob data with blob index tags](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-manage-find-blobs), Microsoft Learn
- [Azure Blob Storage lifecycle management overview](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview), Microsoft Learn
- [Lifecycle management policy structure](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-policy-structure), Microsoft Learn
- [Soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview), Microsoft Learn
- [`BlobClient.cs` at tag `Azure.Storage.Blobs_12.29.2`](https://github.com/Azure/azure-sdk-for-net/blob/Azure.Storage.Blobs_12.29.2/sdk/storage/Azure.Storage.Blobs/src/BlobClient.cs), Azure SDK for .NET
- [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction), Azure Architecture Center
