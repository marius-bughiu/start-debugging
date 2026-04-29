---
title: "Как определить, что запись файла в .NET завершена"
description: "FileSystemWatcher срабатывает на Changed до того, как писатель закончил. Три надёжных паттерна для .NET 11, чтобы узнать, что файл полностью записан: открытие с FileShare.None, дебаунс по стабилизации размера и трюк с переименованием на стороне продьюсера, который полностью устраняет проблему."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "filesystem"
  - "io"
  - "csharp"
lang: "ru"
translationOf: "2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet"
translatedBy: "claude"
translationDate: 2026-04-29
---

`FileSystemWatcher` не сообщает вам, когда файл "готов". Он сообщает, что операционная система зафиксировала изменение. В Windows каждый вызов `WriteFile` порождает событие `Changed`, а `Created` срабатывает в момент появления файла, часто до того, как записан хотя бы один байт. Надёжные паттерны такие: (1) попытаться открыть файл с `FileShare.None` и трактовать `IOException` 0x20 / 0x21 как "ещё пишется", повторяя с экспоненциальной задержкой; (2) опрашивать `FileInfo.Length` и `LastWriteTimeUtc`, пока оба не стабилизируются на двух последовательных замерах; либо (3) договориться с продьюсером, чтобы он писал в `name.tmp`, а потом делал `File.Move` на финальное имя, что атомарно в пределах одного тома. Паттерн 3 единственный корректен без гонок. Паттерны 1 и 2 нужны, когда вы не контролируете продьюсера.

Этот пост ориентирован на .NET 11 (preview 4) и Windows / Linux / macOS. Описанная ниже семантика `FileSystemWatcher` не менялась с .NET Core 3.1 ни на одной платформе, а кооперативный трюк с переименованием одинаков на POSIX и NTFS.

## Почему очевидный подход неверен

Наивный код выглядит так и работает в продакшене в слишком многих местах:

```csharp
// .NET 11 -- BROKEN, do not ship
var watcher = new FileSystemWatcher(@"C:\inbox", "*.csv");
watcher.Created += (_, e) =>
{
    var rows = File.ReadAllLines(e.FullPath); // throws IOException
    Process(rows);
};
watcher.EnableRaisingEvents = true;
```

`Created` срабатывает, когда ОС сообщает о существовании записи в каталоге. Пишущий процесс при этом мог не сбросить даже одного байта. В Windows файл может быть открыт с `FileShare.Read` (тогда ваше чтение вернёт частичный файл) или с `FileShare.None` (тогда чтение бросит `IOException: The process cannot access the file because it is being used by another process`, HRESULT `0x80070020`, win32 error 32). В Linux вы почти всегда получаете частичное чтение, потому что обязательной блокировки по умолчанию нет; вы молча обработаете половину CSV.

`Changed` ещё хуже. В зависимости от того, как пишет продьюсер, можно получить по событию на каждый вызов `WriteFile`, то есть файл размером 1 МБ, записанный блоками по 4 КБ, породит 256 событий. Ни одно из них не говорит, что писатель закончил. Уведомления `WriteFileLastTimeIPromise` не существует, потому что ядро не знает намерений писателя.

Третья проблема: многие копировальные инструменты (Explorer, `robocopy`, rsync) сначала пишут под скрытым временным именем, а затем переименовывают. Вы увидите `Created` для временного файла, потом `Renamed` для финального. В таких случаях реагировать нужно именно на `Renamed`, но значения по умолчанию для `FileSystemWatcher.NotifyFilter` исключают `LastWrite` в .NET 11, а на некоторых платформах исключают `FileName`, поэтому это надо включать явно.

## Паттерн 1: открыть с FileShare.None и применять backoff

Если вы не контролируете продьюсера, ваш единственный канал наблюдения это "могу ли я открыть файл эксклюзивно". Продьюсер удерживает открытый дескриптор во время записи; как только он его закрывает, эксклюзивное открытие проходит. Это работает в Windows, Linux и macOS (Linux предоставляет рекомендательные блокировки через `flock`, но семантика открытия без блокировки для обычного `FileStream` достаточна, потому что мы читаем только для подтверждения, что писателя больше нет).

```csharp
// .NET 11, C# 14
using System.IO;

static async Task<FileStream?> WaitForFileAsync(
    string path,
    TimeSpan timeout,
    CancellationToken ct)
{
    var deadline = DateTime.UtcNow + timeout;
    var delay = TimeSpan.FromMilliseconds(50);

    while (DateTime.UtcNow < deadline)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.None);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            await Task.Delay(delay, ct);
            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 1000));
        }
        catch (UnauthorizedAccessException)
        {
            // ACL problem, not a sharing problem -- do not retry
            throw;
        }
    }
    return null;
}

static bool IsSharingViolation(IOException ex)
{
    // ERROR_SHARING_VIOLATION = 0x20, ERROR_LOCK_VIOLATION = 0x21
    var hr = ex.HResult & 0xFFFF;
    return hr is 0x20 or 0x21;
}
```

Три неочевидных момента:

- **Ловите `IOException`, а не `Exception`**. `UnauthorizedAccessException` (ACL) и `FileNotFoundException` (продьюсер прервался и удалил файл) это другие баги, и повторять их не нужно.
- **Проверяйте `HResult`**. В .NET Core и новее `IOException.HResult` это стандартная win32-ошибка, обёрнутая в `0x8007xxxx` под Windows, и те же числовые коды доступны на POSIX-системах через слой трансляции рантайма. Sharing violation это `0x20`; lock violation это `0x21`. Не сравнивайте по тексту сообщения -- он локализован.
- **Экспоненциальный backoff с верхней границей**. Если продьюсер тормозит (загрузка по сети, медленный USB), опрос каждые 50 мс жжёт CPU впустую. Ограничение в 1 секунду держит воркер тихим, не ухудшая задержку для быстрых записей.

Этот паттерн ломается в одном частном случае: продьюсер открывает файл с `FileShare.Read | FileShare.Write` (некоторые баговые загрузчики так делают). Ваше эксклюзивное открытие пройдёт прямо посреди записи, и вы прочтёте мусор. Если подозреваете такое, комбинируйте паттерн 1 с паттерном 2.

## Паттерн 2: дебаунс по стабилизации размера

Когда нельзя полагаться на блокировки файла (некоторые Linux-продьюсеры, некоторые SMB-шары, дампы с фотоаппаратов), опрашивайте размер и `LastWriteTimeUtc`. Правило: если размер не меняется на двух подряд опросах с разумным интервалом, писатель скорее всего закончил.

```csharp
// .NET 11, C# 14
static async Task<bool> WaitForStableSizeAsync(
    string path,
    TimeSpan pollInterval,
    int requiredStableSamples,
    CancellationToken ct)
{
    var fi = new FileInfo(path);
    long lastSize = -1;
    DateTime lastWrite = default;
    int stable = 0;

    while (stable < requiredStableSamples)
    {
        await Task.Delay(pollInterval, ct);
        fi.Refresh(); // FileInfo caches; Refresh forces a fresh stat call
        if (!fi.Exists) return false;

        if (fi.Length == lastSize && fi.LastWriteTimeUtc == lastWrite)
        {
            stable++;
        }
        else
        {
            stable = 0;
            lastSize = fi.Length;
            lastWrite = fi.LastWriteTimeUtc;
        }
    }
    return true;
}
```

Подбирайте `pollInterval` исходя из того, что знаете о писателе:

- Локальный быстрый диск, маленький файл: 100 мс, 2 замера.
- Сетевая загрузка по линку 100 Мбит: 1 с, 3 замера.
- USB / SD-карта / SMB: 2 с, 3 замера (кеш файловой системы может скрыть кратковременное завершение).

Ловушка это `FileInfo.Refresh()`. Без него `FileInfo.Length` возвращает значение, закешированное при создании `FileInfo`, и ваш цикл крутится бесконечно. Компилятор не предупреждает об этом; распространённый молчаливый баг.

В продакшене комбинируйте с паттерном 1: дождитесь стабилизации размера, затем попробуйте эксклюзивное открытие как финальное подтверждение. Эта комбинация работает и с дисциплинированными, и с распущенными продьюсерами.

## Паттерн 3: продьюсер кооперируется -- пишите, потом переименовывайте

Если вы контролируете писателя, обнаруживать ничего не надо. Пишите в `final.csv.tmp`, делайте fsync, закрывайте и переименовывайте в `final.csv`. `FileSystemWatcher` потребителя следит за `Renamed` (или `Created` с финальным расширением) и реагирует. На одном томе NTFS или ext4 `File.Move` атомарен: либо назначение существует с полным содержимым, либо его нет вовсе.

```csharp
// .NET 11, C# 14 -- producer side
static async Task WriteAtomicallyAsync(
    string finalPath,
    Func<Stream, Task> writeBody,
    CancellationToken ct)
{
    var tmpPath = finalPath + ".tmp";

    await using (var fs = new FileStream(
        tmpPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.None,
        bufferSize: 81920,
        useAsync: true))
    {
        await writeBody(fs, ct);
        await fs.FlushAsync(ct);
        // FlushAsync flushes the .NET buffer; FlushToDisk forces fsync.
        // For most use cases FlushAsync + closing the handle is enough,
        // because Windows Cached Manager and the Linux page cache will
        // serialize the rename after the writes. If you must survive a
        // crash mid-write, also call:
        //   fs.Flush(flushToDisk: true);
    }

    // File.Move with overwrite=true uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
    // on Windows and rename(2) on POSIX. Both are atomic on the same volume.
    File.Move(tmpPath, finalPath, overwrite: true);
}
```

Два неочевидных правила:

- **Тот же том**. Атомарное переименование работает только в рамках одной файловой системы. Запись временного файла в `C:\temp\x.tmp` и переименование в `D:\inbox\x.csv` под капотом это копирование с удалением, и потребитель вполне может поймать файл посреди копирования. Всегда размещайте `.tmp` в каталоге назначения.
- **Та же группа расширений**. Если фильтр вашего watcher'а `*.csv`, а продьюсер создаёт `x.csv.tmp`, watcher не сработает на временном файле, что и нужно. Если фильтр `*`, вы получите `Created` для временного файла; в обработчике игнорируйте всё, что заканчивается на `.tmp`.

Это тот же паттерн, которым Git обновляет refs, которым SQLite ведёт свой журнал, и которым пользуются атомарные перезагрузчики конфигурации (nginx, HAProxy). Это не случайно. Если можете изменить продьюсера, делайте так и прекращайте читать.

## Корректное соединение с FileSystemWatcher

Обработчик должен быть лёгким и сбрасывать работу в очередь. `FileSystemWatcher` поднимает события на потоке из пула с маленьким внутренним буфером (по умолчанию 8 КБ под Windows). Если в обработчике блокируетесь, буфер переполняется, и вы получите события `Error` с `InternalBufferOverflowException`, молча теряя события.

```csharp
// .NET 11, C# 14
using System.IO;
using System.Threading.Channels;

var channel = Channel.CreateUnbounded<string>(
    new UnboundedChannelOptions { SingleReader = true });

var watcher = new FileSystemWatcher(@"C:\inbox")
{
    Filter = "*.csv",
    NotifyFilter = NotifyFilters.FileName
                 | NotifyFilters.LastWrite
                 | NotifyFilters.Size,
    InternalBufferSize = 64 * 1024, // 64 KB, max is 64 KB on most platforms
};

watcher.Created += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.Renamed += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.EnableRaisingEvents = true;

// Dedicated consumer
_ = Task.Run(async () =>
{
    await foreach (var path in channel.Reader.ReadAllAsync())
    {
        if (path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
        if (!await WaitForStableSizeAsync(path, TimeSpan.FromMilliseconds(250), 2, default))
            continue;
        await using var fs = await WaitForFileAsync(path, TimeSpan.FromSeconds(30), default);
        if (fs is null) continue;
        await ProcessAsync(fs);
    }
});
```

Три момента в этом коде, на которых спотыкаются:

- **`InternalBufferSize`**. Стандартные 8 КБ слишком малы для любой реальной нагрузки. Поднимайте до максимума платформы (64 КБ под Windows; backend inotify в Linux берёт значение из `/proc/sys/fs/inotify/max_queued_events`). Цена это процессовая память, которой вы не заметите.
- **`NotifyFilter`**. Значение по умолчанию в .NET 11 это `LastWrite | FileName | DirectoryName`, но на macOS backend kqueue игнорирует часть флагов; включайте `Size` явно, чтобы изменения только размера (писатель использует `WriteFile` без обновления метаданных) тоже порождали события.
- **`Channel<T>` развязывает watcher и потребителя**. Если потребитель тратит 5 секунд на обработку файла, а в это окно прилетает 100 событий, channel буферизует их, пока watcher немедленно возвращается. См. [почему Channels обходят BlockingCollection в таких разделениях продьюсер / потребитель](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Когда файл лежит на сетевой шаре

SMB и NFS добавляют свой тайминг. `FileSystemWatcher` на UNC-пути под Windows использует `ReadDirectoryChangesW` против шары, но события объединяются SMB-редиректором. Можно увидеть одно событие `Changed` в минуту даже для непрерывно записываемого файла на 1 ГБ. Паттерны 1 и 2 всё ещё работают, но `pollInterval` стоит выставить в порядке 5-10 секунд; опрос удалённого `FileInfo.Length` каждые 100 мс генерирует round-trip метаданных на каждый опрос и насыщает линк.

NFS хуже: `inotify` не срабатывает на изменения, сделанные на других клиентах, только на изменения локального маунта локальными процессами. Если ваш потребитель на хосте A, а продьюсер на хосте B пишет через NFS, `FileSystemWatcher` не увидит ничего. Решение это только опрос -- `Directory.EnumerateFiles` по таймеру, с применением паттернов 1 и 2 к каждой новой записи. Никакого пути уведомлений ядра, который бы вас выручил, здесь нет.

## Частые краевые случаи

- **Продьюсер усекает и перезаписывает на месте**. `FileSystemWatcher` выдаст одно событие `Changed`, когда новое содержимое будет записано. Проверка стабильного размера из паттерна 2 справляется корректно, потому что размер стабилизируется только после завершения перезаписи. Паттерн 1 может на короткий момент успеть пройти в окне усечения, когда файл пуст; комбинируйте с проверкой минимального ожидаемого размера, если у вас в домене такой есть.
- **Антивирус блокирует файл после создания**. Defender (Windows) и большинство корпоративных AV-продуктов открывают файл для сканирования в момент его появления, удерживая `FileShare.Read` десятки и сотни миллисекунд. Цикл повторов из паттерна 1 поглощает это прозрачно; просто не ставьте таймаут в 100 мс.
- **Файл создаёт процесс, который падает**. Вы увидите `Created`, возможно `Changed`, и потом ничего. Проверка стабильного размера из паттерна 2 после окна опроса вернёт true, потому что записей больше нет. И вы обработаете частичный файл. Сделайте так, чтобы продьюсер кооперировался (паттерн 3), либо используйте файл-сторож (`final.csv.done`), который продьюсер создаёт в конце.
- **Несколько файлов пишутся в связке** (например, `data.csv` плюс `data.idx`). Ждите появления вторичного файла, а не первичного. Продьюсер обязан писать индекс после данных, поэтому появление индекса означает, что данные готовы.

## Связанное чтение

- [Стриминг файла из ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) покрывает сторону чтения, когда вы убедились, что файл готов.
- [Чтение больших CSV без OOM](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) логичное продолжение, если файлы во входной папке большие.
- [Отмена долгих задач без deadlock](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) применима к циклам ожидания выше, когда вы хотите, чтобы они уважали shutdown.
- [Channels вместо BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) правильный транспорт между watcher'ом и worker'ом.

## Источники

- [Документация `FileSystemWatcher`, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) -- раздел заметок по платформам самый полезный.
- [`File.Move(string, string, bool)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.move) -- описывает перегрузку с атомарным переименованием, добавленную в .NET Core 3.0.
- [Документация Win32 `MoveFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa) -- лежащая в основе примитива, которую использует `File.Move(overwrite: true)`.
- [API `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) -- объясняет условия переполнения буфера, которые превращаются в `InternalBufferOverflowException`.
