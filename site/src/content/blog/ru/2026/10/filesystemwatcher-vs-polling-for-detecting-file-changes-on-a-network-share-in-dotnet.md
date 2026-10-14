---
title: "FileSystemWatcher или опрос для обнаружения изменений файлов на сетевой папке в .NET"
description: "На SMB- или NFS-ресурсе источником истины служит опрос, а FileSystemWatcher в лучшем случае подсказка. FileSystemWatcher пропускает удалённые изменения на Linux и macOS, переполняет 64-килобайтный сетевой буфер и навсегда останавливается при обрыве соединения. Используйте периодическое сравнение снимков, а наблюдателю оставьте только роль триггера для досрочного сканирования. Проверено на .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "csharp"
  - "filesystem"
  - "io"
lang: "ru"
translationOf: "2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-14
---

Если отслеживаемая папка находится на сетевом ресурсе, выигрывает опрос. Периодически делайте снимок каталога и сравнивайте его с предыдущим: это единственный механизм, который видит все изменения на любой ОС, переживает разрывы соединения и поддаётся анализу. `FileSystemWatcher` по-прежнему полезен на клиентах Windows, работающих с SMB, но только как подсказка, которая запускает следующее сканирование раньше срока. Никогда не делайте его единственным способом узнать о появлении файла.

Всё сказанное ниже относится к `System.IO.FileSystemWatcher` и `Microsoft.Extensions.FileProviders.Physical` в том виде, в каком они поставляются в .NET 10 (я запускал код на .NET 10.0.10, SDK 10.0.302, C# 14), а также в релиз-кандидатах .NET 11. Соответствующий исходный код существенно не менялся со времён .NET Core 3.1, поэтому совет справедлив и для .NET 8 и 9.

## Сравнение с первого взгляда

| | `FileSystemWatcher` на сетевом ресурсе | Опрос снимка |
| --- | --- | --- |
| Клиент Windows, ресурс SMB 2/3 | Работает, через `ReadDirectoryChangesW`, перенаправленный на сервер | Работает |
| Клиент Linux, монтирование CIFS или NFS | Видит только изменения, сделанные локальной машиной | Работает |
| Клиент macOS, монтирование SMB или NFS | На практике видит только локальные изменения | Работает |
| Задержка | Менее секунды, когда работает | Ваш интервал опроса плюс кеширование метаданных на клиенте (до 10 с в Windows SMB, до 60 с в NFS) |
| Пачка изменений | Буфер ограничен 64 КБ на сетевых путях, при переполнении все подробности теряются | Не влияет, следующее сравнение увидит конечное состояние |
| Обрыв соединения | Событие `Error`, затем `EnableRaisingEvents` становится `false` и остаётся таким | Сканирование завершается ошибкой, вы повторяете на следующем такте |
| Изменения, сделанные пока вы были офлайн | Потеряны | Видны при первом успешном сканировании |
| Стоимость, когда ничего не меняется | Почти нулевая | Один листинг каталога за интервал |
| Говорит, *что* изменилось | Да, в каждом событии | Да, через сравнение снимков |

У каждой строки в столбце наблюдателя есть звёздочка, а в столбце опроса нет ни одной. Эта асимметрия и есть весь аргумент.

## Почему FileSystemWatcher хрупок на сетевом ресурсе

`FileSystemWatcher` это тонкая обёртка над тем, что предоставляет ОС: `ReadDirectoryChangesW` в Windows, `inotify` в Linux, FSEvents в macOS. Каждый из этих механизмов проектировался для локальной файловой системы, где ядро видит каждую запись, потому что любая запись проходит через него. Сетевой ресурс нарушает это допущение.

**В Linux и macOS удалённые записи невидимы.** `inotify` срабатывает, когда локальное ядро выполняет операцию над файлом. Когда другая машина пишет в тот же экспорт NFS или ресурс SMB, ваше ядро эту запись не обрабатывает, поэтому событие не возникает. Вы получаете события о записях собственного процесса и ничего о записях других. Разработчик ядра Linux J. Bruce Fields прямо сказал об этом в [обсуждении на LWN](https://lwn.net/Articles/757833/): клиентскому уведомлению потребовался бы "very chatty" протокол, чтобы узнавать об изменениях других клиентов, а в NFS такого нет. То же верно и для монтирований CIFS. Если ваш потребитель работает в контейнере Linux, а производитель это машина с Windows, складывающая файлы на сетевой ресурс, `FileSystemWatcher` будет молча простаивать вечно.

**В Windows мешает потолок в 64 КБ.** Клиент Windows, работающий с сервером SMB 2 или SMB 3, действительно получает настоящие удалённые уведомления: редиректор отправляет серверу запрос `CHANGE_NOTIFY`, и сервер отвечает, когда что-то меняется. Но [документация по `ReadDirectoryChangesW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) утверждает, что вызов "fails with ERROR_INVALID_PARAMETER when the buffer length is greater than 64 KB and the application is monitoring a directory over the network". [Документация по `FileSystemWatcher`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) повторяет это ограничение. Значение `InternalBufferSize` по умолчанию равно 8 КБ, каждая запись `FILE_NOTIFY_INFORMATION` занимает 12 байт плюс имя файла в UTF-16, так что при именах из 40 символов в 8 КБ помещается около 90 событий, а в 64 КБ около 700. Пакетное задание, которое за секунду кладёт 2000 файлов, переполнит любой из этих буферов.

При переполнении буфера ОС отбрасывает всю пачку целиком. `ReadDirectoryChangesW` возвращает успех с нулём байт, а среда выполнения превращает это в событие `Error` с `InternalBufferOverflowException` ("Too many changes at once in directory"). Вы знаете, что что-то пропустили, но не знаете, что именно.

**В Windows обрыв соединения отключает наблюдатель.** Именно это вызывает инцидент в три часа ночи. Вот соответствующая часть `ReadDirectoryChangesCallback` в [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs):

```csharp
// dotnet/runtime main, System.IO.FileSystem.Watcher (unchanged since .NET Core 3.x)
if (errorCode != 0)
{
    const int ERROR_OPERATION_ABORTED = 995;
    if (errorCode != ERROR_OPERATION_ABORTED)
    {
        EnableRaisingEvents = false;
        OnError(new ErrorEventArgs(new Win32Exception((int)errorCode)));
    }
    return;
}
```

Когда файловый сервер перезагружается, VPN моргает или истекает сессия SMB, ожидающее чтение завершается ошибкой вроде `ERROR_NETNAME_DELETED` (64, "The specified network name is no longer available"). Наблюдатель один раз вызывает `Error`, устанавливает `EnableRaisingEvents = false` и сам больше не возвращается. Если на `Error` никто не подписан, процесс продолжает работать, выглядит здоровым и ничего не обрабатывает. Заметьте также, что начальный сбой, например буфер больше 64 КБ на UNC-пути, проявляется так же: как событие `Error`, а не как исключение из сеттера `EnableRaisingEvents = true`.

## Минимальный пример тихого сбоя

Этот код встречается в большинстве вопросов вида "мой наблюдатель перестал работать":

```csharp
// .NET 10, C# 14 -- the naive version. Do not ship this against a share.
using var watcher = new FileSystemWatcher(@"\\fileserver\drop", "*.csv");
watcher.Created += (_, e) => Process(e.FullPath);
watcher.EnableRaisingEvents = true;

Console.ReadLine();

static void Process(string path) => Console.WriteLine($"Got {path}");
```

Запустите его в Windows, положите файл на ресурс, и он сработает. Перезапустите файловый сервер или выдерните сетевой кабель на минуту, и он навсегда перестанет печатать, без исключения и без записи в журнале. Запустите тот же код в контейнере Linux с `/mnt/drop`, смонтированным по CIFS, и он вообще ничего не напечатает, если только файл не создан изнутри того же контейнера.

## Опрос, сделанный правильно

У опроса плохая репутация, потому что его реализуют плохо: перечисляют каталог, открывают каждый файл и сравнивают содержимое. Хороший опрос это один листинг каталога, который собирает имя, размер и время последней записи для каждой записи и сравнивает их с предыдущим листингом.

Самый дешёвый способ получить это в .NET: `FileSystemEnumerable<T>` из `System.IO.Enumeration`. Он позволяет проецировать каждый `FileSystemEntry` сразу в нужный кортеж, не выделяя `FileInfo` на каждый файл. В Windows `Length` и `LastWriteTimeUtc` берутся из самих данных перечисления каталога (`FindFirstFileEx` и родственные вызовы), так что по SMB весь листинг это несколько обменов `QUERY_DIRECTORY`, а не один обмен на файл. В Linux и macOS `readdir` возвращает только имена, поэтому каждая запись обходится в дополнительный `stat`, который клиент CIFS или NFS обычно обслуживает из своего кеша атрибутов.

Чтобы почувствовать нижнюю границу затрат CPU на сканирование, я замерил метод `TakeSnapshot` из полной реализации ниже на локальных каталогах APFS на Apple M4 (macOS 26.6, .NET 10.0.10, сборка Release, среднее по 20 запускам после 3 прогревочных):

| Файлов в каталоге | Время на сканирование | Выделено на сканирование |
| --- | --- | --- |
| 1,000 | 1.8 ms | 0.29 MB |
| 10,000 | 20.5 ms | 2.83 MB |
| 50,000 | 93.1 ms | 13.39 MB |

По сети эти числа растут вместе с задержкой и размером листинга, но форма остаётся той же: один листинг за интервал. Опрос папки с несколькими тысячами файлов каждые 5-30 секунд никто не заметит. Опрос 500 000 файлов каждую секунду заметят, и ответ здесь в разбиении папки (одна подпапка на день или на производителя), а не в переходе на наблюдатель.

## Гибрид: опрос как истина, наблюдатель как подсказка

Устойчивый в продакшене дизайн объединяет оба подхода:

1. Храните в памяти снимок (`path -> (length, lastWriteUtc)`).
2. Пересканируйте с фиксированным интервалом и сравнивайте со снимком. Это единственный путь кода, который порождает `Created`, `Changed` и `Deleted`.
3. Если удаётся запустить `FileSystemWatcher`, пусть любое его событие досрочно будит цикл сканирования. На клиенте Windows, работающем с SMB, это даёт задержку менее секунды в типичном случае.
4. При любом `Error` наблюдателя (переполнение или разрыв) выбросьте наблюдатель, принудительно выполните пересканирование и попробуйте создать его заново на следующем проходе.
5. Если само сканирование не удалось, потому что ресурс недоступен, сохраните старый снимок и повторите на следующем такте. Сбой доступа не то же самое, что "все файлы удалены".

Вот полная реализация. Она запускается как есть на .NET 10 и .NET 11:

```csharp
// .NET 10 / .NET 11, C# 14
using System.IO.Enumeration;

public enum ShareChangeKind { Created, Changed, Deleted }

public readonly record struct ShareChange(ShareChangeKind Kind, string Path);

public readonly record struct FileStamp(long Length, DateTime LastWriteUtc);

public sealed class ShareWatcher : IAsyncDisposable
{
    private readonly string _root;
    private readonly TimeSpan _reconcileInterval;
    private readonly Action<ShareChange> _onChange;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly CancellationTokenSource _cts = new();
    private Dictionary<string, FileStamp> _snapshot = new(StringComparer.OrdinalIgnoreCase); // SMB is case-insensitive
    private volatile FileSystemWatcher? _watcher; // swapped from the Error callback
    private Task? _loop;

    public ShareWatcher(string root, TimeSpan reconcileInterval, Action<ShareChange> onChange)
    {
        _root = root;
        _reconcileInterval = reconcileInterval;
        _onChange = onChange;
    }

    public void Start()
    {
        // Baseline: whatever exists now is not a change.
        _snapshot = TakeSnapshot(_root) ?? _snapshot;
        TryStartWatcher();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            // Wake on the reconcile timer OR early when the watcher hints at a change.
            try { await _wake.WaitAsync(_reconcileInterval, ct); }
            catch (OperationCanceledException) { return; }

            // Small settle delay so a burst of hints becomes one scan.
            try { await Task.Delay(250, ct); }
            catch (OperationCanceledException) { return; }

            Reconcile();

            if (_watcher is null) TryStartWatcher();
        }
    }

    private void Reconcile()
    {
        var current = TakeSnapshot(_root);
        if (current is null)
        {
            // Share unreachable. Keep the old snapshot: an outage is not "every file was deleted".
            return;
        }

        foreach (var (path, stamp) in current)
        {
            if (!_snapshot.TryGetValue(path, out var old))
                _onChange(new(ShareChangeKind.Created, path));
            else if (old != stamp)
                _onChange(new(ShareChangeKind.Changed, path));
        }

        foreach (var path in _snapshot.Keys)
        {
            if (!current.ContainsKey(path))
                _onChange(new(ShareChangeKind.Deleted, path));
        }

        _snapshot = current;
    }

    private static Dictionary<string, FileStamp>? TakeSnapshot(string root)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        try
        {
            // Length and LastWriteTimeUtc come from the directory listing itself on Windows,
            // so this is one QUERY_DIRECTORY exchange per batch, not one round trip per file.
            // The constructor opens the directory, so it must sit inside the try.
            var entries = new FileSystemEnumerable<KeyValuePair<string, FileStamp>>(
                root,
                (ref FileSystemEntry e) => new(
                    e.ToFullPath(),
                    new FileStamp(e.Length, e.LastWriteTimeUtc.UtcDateTime)),
                options)
            {
                ShouldIncludePredicate = (ref FileSystemEntry e) => !e.IsDirectory,
            };

            var result = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);
            foreach (var (path, stamp) in entries) result[path] = stamp;
            return result;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void TryStartWatcher()
    {
        try
        {
            var w = new FileSystemWatcher(_root)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                IncludeSubdirectories = false,
                InternalBufferSize = 64 * 1024, // hard ceiling for network paths
            };
            w.Created += (_, _) => Hint();
            w.Changed += (_, _) => Hint();
            w.Deleted += (_, _) => Hint();
            w.Renamed += (_, _) => Hint();
            w.Error += (_, e) => OnWatcherError(w, e.GetException());
            w.EnableRaisingEvents = true;
            _watcher = w;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            // Share offline or path gone. Polling keeps running; we retry on the next pass.
            _watcher = null;
        }
    }

    private void OnWatcherError(FileSystemWatcher w, Exception ex)
    {
        // Overflow or a dropped connection: either way, events were lost.
        // Throw the watcher away, force a full rescan, and rebuild on the next pass.
        if (ReferenceEquals(_watcher, w)) _watcher = null;
        w.Dispose();
        Hint();
    }

    private void Hint()
    {
        try { _wake.Release(); }
        catch (SemaphoreFullException) { /* a scan is already pending */ }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null) await _loop;
        _watcher?.Dispose();
        _cts.Dispose();
        _wake.Dispose();
    }
}
```

Использование из воркера или консольного приложения:

```csharp
// .NET 10 / .NET 11, C# 14
await using var watcher = new ShareWatcher(
    @"\\fileserver\drop",
    reconcileInterval: TimeSpan.FromSeconds(15),
    onChange: c => Console.WriteLine($"{c.Kind}: {c.Path}"));

watcher.Start();
await Task.Delay(Timeout.Infinite);
```

Я проверил это на локальном каталоге с интервалом сверки 3 секунды: создание файла, дозапись и удаление были зафиксированы примерно через 265 мс после операции (подсказка наблюдателя плюс 250 мс задержки на успокоение). Пока каталог был убран на 4 секунды для имитации сбоя, ничего не сообщалось, а файл, созданный после его возвращения, был обнаружен на следующем проходе. Ничего не было ошибочно показано как удалённое.

Несколько проектных решений, на которые стоит обратить внимание:

- **`SemaphoreSlim(0, 1)` как сигнал пробуждения** объединяет любое число подсказок в одно ожидающее сканирование. Перехват `SemaphoreFullException` это и есть объединение, а не путь обработки ошибки.
- **Задержка на успокоение в 250 мс** превращает пачку подсказок (пакет из 2000 файлов) в одно сканирование вместо 2000.
- **`_onChange` выполняется в цикле сканирования**, по одному вызову за раз. Если обработка медленная, передавайте изменение в `Channel<ShareChange>` и обрабатывайте в отдельном потребителе, чтобы медленный обработчик не задерживал следующее сканирование.
- **Скрытые и системные файлы пропускаются**, что отсекает `Thumbs.db`, `desktop.ini` и файлы `.DS_Store`, которые оставляют клиенты macOS.

## Подводные камни, которые опрос не решает за вас

**Кеши метаданных на клиенте добавляют задержку, которую вы не настраивали.** Клиент SMB в Windows кеширует листинги каталогов и метаданные файлов. Согласно [руководству по настройке файловых серверов](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/), `DirectoryCacheLifetime` и `FileInfoCacheLifetime` по умолчанию равны 10 секундам, а `FileNotFoundCacheLifetime` 5 секундам (всё в `HKLM\System\CurrentControlSet\Services\LanmanWorkstation\Parameters`), а аренды каталогов в SMB 3 меняют картину ещё сильнее. В Linux `mount.cifs` по умолчанию кеширует атрибуты 1 секунду (`actimeo`), а клиент NFS по умолчанию кеширует атрибуты каталогов от 30 до 60 секунд (`acdirmin`/`acdirmax`, см. [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html)). Ваша реальная задержка это интервал опроса плюс время жизни кеша. Если нужно быстрее, настраивайте параметры монтирования, а не интервал опроса.

**"Новый файл" не значит "завершённый файл".** Оба механизма сообщают, что файл появился, а не что писатель закончил с ним работу. Файл размером 2 ГБ, копируемый по сети, появляется в листинге в момент начала копирования. Варианты я подробно разобрал в статье [как определить, что запись файла завершена](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/): самый надёжный из них это запись производителем во временное имя и переименование в конце. С описанным выше гибридом можно также просто считать файл готовым только после того, как его штамп не менялся в течение двух сканирований.

**Копии с сохранением временных меток выглядят неизменными.** `robocopy` с параметром по умолчанию `/COPY:DAT`, `cp -p` и `rsync -t` сохраняют время последней записи источника. Если файл заменён другим того же размера, штамп `(Length, LastWriteUtc)` не меняется. Если это важно, добавьте время создания в Windows или хеш содержимого для небольших файлов либо попросите производителя использовать новое имя для каждой версии.

**Расхождение часов клиента и сервера.** Время последней записи, которое вы читаете, это временная метка сервера. Сравнивайте штампы только с другими штампами с того же ресурса, никогда с `DateTime.UtcNow` на вашей машине. Логика "изменено за последние 5 минут" тихо ломается, когда часы файлового сервера идут неверно.

**Чувствительность к регистру.** Словарь снимка использует `StringComparer.OrdinalIgnoreCase`, потому что ресурсы SMB нечувствительны к регистру. На экспорте NFS с чувствительной к регистру файловой системой переключитесь на `StringComparer.Ordinal`, иначе два файла, отличающиеся только регистром, схлопнутся в одну запись.

**Bind-монтирования контейнеров в Docker Desktop.** То же правило относится к папке хоста, смонтированной в контейнер Linux в Windows или macOS: уведомления об изменениях с хоста ненадёжны, поэтому и здесь единственный безопасный выбор по умолчанию это опрос.

## Перезагрузка конфигурации на сетевом ресурсе: DOTNET_USE_POLLING_FILE_WATCHER

Если интересующее вас "изменение файла" это `appsettings.json` с `reloadOnChange: true` или любой другой потребитель `PhysicalFileProvider`, код выше не нужен. `PhysicalFileProvider` читает переменную окружения `DOTNET_USE_POLLING_FILE_WATCHER` в конструкторе:

```bash
# .NET 8, 9, 10, 11: switches PhysicalFileProvider to polling
export DOTNET_USE_POLLING_FILE_WATCHER=1
```

Со значением `1` или `true` он устанавливает и `UsePollingFileWatcher`, и `UseActivePolling`, вообще не создаёт `FileSystemWatcher` и по таймеру проверяет `LastWriteTimeUtc` каждого наблюдаемого файла. Интервал равен `PhysicalFilesWatcher.DefaultPollingInterval`, жёстко заданному в 4 секунды. Включить это можно и для отдельного провайдера в коде:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

var provider = new PhysicalFileProvider(@"\\fileserver\config")
{
    UsePollingFileWatcher = true,
    UseActivePolling = true,
};

builder.Configuration.AddJsonFile(provider, "appsettings.shared.json",
    optional: false, reloadOnChange: true);
```

Те же оговорки применимы и здесь: сравнивается только время последней записи, поэтому копия с сохранением временных меток для него невидима, а кеширование метаданных SMB может добавить до 10 секунд сверх интервала в 4 секунды. О том, что происходит дальше после срабатывания перезагрузки, рассказано в [сравнении `IOptionsMonitor`](/ru/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/).

## Рекомендация ещё раз

Используйте сравнение снимков опросом как единственный источник истины для любой папки на ресурсе SMB, экспорте NFS или bind-монтировании. Выберите интервал исходя из допустимой задержки, затем прибавьте к нему время жизни кеша метаданных клиента. Если вы работаете в Windows и хотите малую задержку, добавьте `FileSystemWatcher`, который только досрочно будит опрос, ограничьте его `InternalBufferSize` значением 64 КБ и воспринимайте каждое событие `Error` как "пересканировать и пересоздать". Единственный случай, когда допустим голый `FileSystemWatcher`, это локальный диск, и даже там стоит подписаться на `Error`.

## Что почитать дальше

- [Как определить, что запись файла завершена, в .NET](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) покрывает вторую половину проблемы: "появился, но не закончен".
- [Как читать хвост журнала в C#, пока в него пишет другой процесс](/ru/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) использует те же рассуждения "сначала опрос" для одного растущего файла.
- [Почему FileInfo.Length возвращает устаревший размер в Windows](/ru/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) объясняет, почему метаданные листинга каталога могут отставать от реального файла.
- [Thread.Sleep, Task.Delay и SpinWait](/ru/2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp/) объясняет, почему цикл опроса ожидает, а не засыпает.
- [Channels вместо BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) для передачи изменений из цикла сканирования медленному потребителю.

## Источники

- [`FileSystemWatcher` class, remarks on buffer size and network paths](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) (Microsoft Learn)
- [`ReadDirectoryChangesW` function](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) (Microsoft Learn)
- [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs) and [`FileSystemWatcher.Linux.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Linux.cs) (dotnet/runtime)
- [`PhysicalFileProvider.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFileProvider.cs) and [`PhysicalFilesWatcher.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFilesWatcher.cs) (dotnet/runtime)
- [`FileSystemEnumerable<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/system.io.enumeration.filesystemenumerable-1) (Microsoft Learn)
- [Performance tuning for file servers, SMB client cache settings](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/) (Microsoft Learn)
- [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html) and [`mount.cifs(8)`](https://man7.org/linux/man-pages/man8/mount.cifs.8.html) man pages
- [J. Bruce Fields on NFS change notification (LWN comment)](https://lwn.net/Articles/757833/)
