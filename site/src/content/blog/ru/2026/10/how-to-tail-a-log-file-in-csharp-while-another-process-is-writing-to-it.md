---
title: "Как читать хвост файла журнала в C#, пока другой процесс продолжает в него писать"
description: "Откройте журнал с FileShare.ReadWrite | FileShare.Delete, перейдите в конец, опрашивайте файл на появление новых байтов, декодируйте их собственным UTF-8 Decoder вместо StreamReader и явно обрабатывайте усечение и ротацию. Проверенная реализация tail -F для .NET 10 и .NET 11."
pubDate: 2026-10-11
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "file-io"
  - "logging"
  - "async"
lang: "ru"
translationOf: "2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it"
translatedBy: "claude"
translationDate: 2026-10-11
---

Чтобы прочитать файл журнала, который другой процесс всё ещё держит открытым на запись, откройте его через `new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)`. Именно `FileShare.ReadWrite` устраняет `IOException: The process cannot access the file because it is being used by another process`: писатель уже владеет доступом на запись, и ваш режим совместного доступа должен это допускать. `FileShare.Delete` позволяет писателю переименовать или удалить файл при ротации журнала без ошибки. Затем перейдите в конец файла, опрашивайте новые байты по таймеру и выдавайте текст только до последнего `\n`. Не читайте байты через `StreamReader`: на конце файла он сбрасывает свой декодер (flush), что портит любой многобайтовый символ UTF-8, который писатель записал лишь наполовину. Наконец, при каждом достижении конца файла проверяйте усечение (`fs.Length < fs.Position`) и ротацию (путь теперь указывает на другой файл). Всё ниже запускалось на macOS с .NET 10.0.10 (SDK 10.0.302) и .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128); правила совместного доступа в Windows взяты из исходного кода среды выполнения и контракта Win32.

## Почему File.ReadAllText падает на работающем файле журнала

Любое открытие файла в Windows несёт две вещи: нужный вам доступ (`FileAccess`) и доступ, который вы готовы разрешить другим одновременно (`FileShare`). Второе открытие удаётся, только если согласны обе стороны: запрошенный вами доступ должен допускаться режимом совместного доступа каждого существующего дескриптора, а доступ каждого существующего дескриптора должен допускаться вашим режимом.

Библиотеки журналирования почти всегда открывают свой файл так. Вот строка из [`FileSink` в Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs) при `shared: false` (значение по умолчанию):

```csharp
// Serilog.Sinks.File, non-shared mode
System.IO.File.Open(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
```

Писатель держит `FileAccess.Write` и разрешает другим чтение. Теперь посмотрим, что делают удобные API. `File.ReadAllText`, `File.ReadAllLines`, `File.ReadLines` и `new StreamReader(path)` в итоге попадают в один и тот же вспомогательный код в [`StreamReader.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs):

```csharp
// dotnet/runtime, StreamReader path constructor
new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileStream.DefaultBufferSize);
```

`FileShare.Read` означает "никто другой не должен писать, пока я держу файл открытым". Но кто-то уже пишет, поэтому Windows отклоняет открытие с `ERROR_SHARING_VIOLATION` (ошибка win32 32, HResult `0x80070020`), а .NET показывает это как `IOException: The process cannot access the file 'app.log' because it is being used by another process.` Решение не в цикле повторов. Решение в том, чтобы запросить режим совместного доступа, который терпит писателя:

```csharp
// .NET 10 / .NET 11, C# 14
using var fs = new FileStream(
    "app.log",
    FileMode.Open,
    FileAccess.Read,
    FileShare.ReadWrite | FileShare.Delete);
```

Если писатель открыл файл с `FileShare.None`, никакой режим с вашей стороны не поможет. Этот писатель запросил монопольный доступ, и остаётся только ждать, пока он закроет дескриптор.

### Что меняется в Linux и macOS

В Unix нет обязательных режимов совместного доступа, поэтому .NET их эмулирует. Начиная с .NET 6, [`SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs) берёт рекомендательный `flock`: `LOCK_EX` при `FileShare.None` и `LOCK_SH` для всех остальных значений. Два следствия, оба воспроизведены мной на macOS с .NET 10.0.10:

1. `File.ReadAllText` для файла, который писатель на .NET держит с `FileShare.Read`, в Unix успешно отрабатывает. Код, который "работает на моём Mac", всё равно может падать в продакшене на Windows.
2. Писатель на .NET, который пытается открыть файл с `FileShare.None`, пока ваш читатель держит его открытым, получает `IOException` (HResult `0x23` на macOS), потому что ваша разделяемая блокировка мешает его монопольной. Писатели не на .NET в `flock` вообще не участвуют.

Блокировку можно отключить переключателем среды выполнения `System.IO.DisableFileLocking` (переменная окружения `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1`), что нужно некоторым командам на NFS-монтированиях без демона блокировок. Передавать `FileShare.ReadWrite | FileShare.Delete` в Unix всё равно правильно: это фиксирует намерение и ведёт себя одинаково в Windows.

## Две ошибки наивного цикла чтения хвоста

Когда открытие работает, очевидная реализация выглядит как `StreamReader` и цикл вокруг `ReadLine()`. `StreamReader` не запоминает конец файла, поэтому когда писатель дописывает данные, следующий `ReadLine` их вернёт. Это нормально. Две другие вещи нет.

Первая: неполные строки. Если писатель сбросил `"line1\npart"`, а вы дважды вызвали `ReadLine()`, вы получите `"line1"`, а затем `"part"`. Когда писатель позже допишет `"ial2\n"`, вы получите `"ial2"`. Одна строка журнала превратилась в две записи. Я прогнал именно эту последовательность и получил `[line1] [part]`, а после дописывания `[ial2]`.

Вторая, гораздо менее известная: разорванные символы. `StreamReader` передаёт байты UTF-8 `Decoder`, который может удерживать первые байты многобайтового символа, пока не придут остальные. Но когда нижележащий поток возвращает 0 байт, `StreamReader` считает это концом потока и вызывает `_decoder.GetChars(..., flush: true)`. Декодер со сбросом превращает любую неполную последовательность в `U+FFFD`. В растущем файле "конец потока" означает лишь "писатель ещё не дописал". Этот пример записывает `"żółć\n"` двумя порциями, разрывая `ó` после первого байта:

```csharp
// .NET 10 / .NET 11, C# 14
using System.Text;

var path = Path.GetTempFileName();
var bytes = Encoding.UTF8.GetBytes("żółć\n");

using var writer = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
using var reader = new StreamReader(fs, Encoding.UTF8);

var buf = new char[100];
var sb = new StringBuilder();
void Drain() { int n; while ((n = reader.Read(buf, 0, buf.Length)) > 0) sb.Append(buf, 0, n); }

writer.Write(bytes, 0, 3); writer.Flush(); Drain();               // "ż" + first byte of "ó"
writer.Write(bytes, 3, bytes.Length - 3); writer.Flush(); Drain();
Console.WriteLine(sb.ToString()); // prints "ż��łć"
```

Вывод: `ż��łć` и на .NET 10.0.10, и на .NET 11 RC1, как для `Read`, так и для `ReadAsync`. Журналы с нелатинскими именами пользователей, путями к файлам или сообщениями упрутся в это, как только писатель сбросит буфер посреди символа, а буферизованные писатели так и делают, когда граница буфера попадает внутрь символа.

Исправление для обеих проблем одно: читать байты из `FileStream` самостоятельно, декодировать их собственным `Decoder` с `flush: false` и держать текст после последнего перевода строки в буфере, пока не появится остаток строки.

## Реализация tail -F, переживающая ротацию

Вот полный вспомогательный класс. Он отдаёт поток строк как `IAsyncEnumerable<string>`, так что потребители пишут `await foreach` и отменяют операцию токеном.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Runtime.CompilerServices;
using System.Text;

public static class LogTail
{
    public static async IAsyncEnumerable<string> FollowAsync(
        string path,
        bool fromStart = false,
        TimeSpan? pollInterval = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var interval = pollInterval ?? TimeSpan.FromMilliseconds(250);
        var bytes = new byte[16 * 1024];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        var decoder = Encoding.UTF8.GetDecoder();
        var pending = new StringBuilder();
        FileStream? fs = null;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (fs is null)
                {
                    fs = TryOpen(path);
                    if (fs is null)
                    {
                        await Task.Delay(interval, ct);
                        continue;
                    }
                    if (!fromStart) fs.Seek(0, SeekOrigin.End);
                    fromStart = true; // a rotated-in file is read from the top
                    decoder.Reset();
                    pending.Clear();
                }

                int read = await fs.ReadAsync(bytes, ct);
                if (read > 0)
                {
                    // flush: false keeps a half-written multi-byte character
                    // inside the decoder until the rest of it arrives.
                    int n = decoder.GetChars(bytes, 0, read, chars, 0, flush: false);
                    pending.Append(chars, 0, n);
                    foreach (var line in DrainCompleteLines(pending))
                        yield return line;
                    continue;
                }

                // At EOF. Truncated in place (copytruncate)?
                if (fs.Length < fs.Position)
                {
                    fs.Seek(0, SeekOrigin.Begin);
                    decoder.Reset();
                    pending.Clear();
                    continue;
                }

                // Path now points at a different file (rename-and-recreate)?
                if (WasReplaced(path, fs))
                {
                    await fs.DisposeAsync();
                    fs = null;
                    continue;
                }

                await Task.Delay(interval, ct);
            }
        }
        finally
        {
            if (fs is not null) await fs.DisposeAsync();
        }
    }

    static FileStream? TryOpen(string path)
    {
        try
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 0, FileOptions.Asynchronous);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; } // writer holds FileShare.None right now
    }

    static IEnumerable<string> DrainCompleteLines(StringBuilder pending)
    {
        int start = 0;
        for (int i = 0; i < pending.Length; i++)
        {
            if (pending[i] != '\n') continue;
            int end = i > start && pending[i - 1] == '\r' ? i - 1 : i;
            yield return pending.ToString(start, end - start);
            start = i + 1;
        }
        pending.Remove(0, start);
    }

    static bool WasReplaced(string path, FileStream current)
    {
        // Measure the path through a fresh handle, not FileInfo, and do it
        // before reading the current handle's length.
        using var probe = TryOpen(path);
        if (probe is null) return false; // rotated, new file not created yet
        long pathLength = probe.Length;
        // Same append-only file: pathLength == current.Position (we are at EOF)
        // or current.Length grew past it in the meantime. Anything else means
        // the name now belongs to another file.
        return pathLength < current.Position || pathLength > current.Length;
    }
}
```

Использование из консольного приложения или `BackgroundService` выглядит так:

```csharp
// .NET 10 / .NET 11, C# 14
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

try
{
    await foreach (var line in LogTail.FollowAsync("/var/log/myapp/app.log", ct: cts.Token))
        Console.WriteLine(line);
}
catch (OperationCanceledException) { }
```

Я проверил это на втором процессе, который записывал строки двумя порциями (разрыв внутри двухбайтового символа, со сбросами и паузами по 120 мс между ними), затем переименовывал файл в `app.log.1` и создавал новый, затем усекал новый и продолжал писать. Читатель вывел каждую строку целиком, без символов замены, перешёл на новый файл после переименования и начал сначала после усечения, как на .NET 10.0.10, так и на .NET 11 RC1.

## Зачем нужна каждая часть

По порядку цикл делает пять вещей:

1. **Открывает с `FileShare.ReadWrite | FileShare.Delete`.** `ReadWrite` терпит писателя. `Delete` важен для ротации в Windows: библиотеки журналирования, архивирующие переименованием `app.log` в `app.log.1`, вызывают `MoveFile`, который завершается ошибкой совместного доступа, если у любого открытого дескриптора нет `FILE_SHARE_DELETE`. Без этого ваш читатель ломает ротацию журнала приложения, а это куда худшая ошибка, чем пропущенная строка.
2. **Переходит в конец при первом открытии.** Это семантика `tail -f`: показывать только то, что происходит с этого момента. Передайте `fromStart: true`, чтобы воспроизвести файл целиком. После ротации вспомогательный класс всегда читает новый файл с начала, потому что в нём всё новое.
3. **Опрашивает через `Task.Delay`.** Опрос раз в 250 мс на конце файла это один системный вызов `read`, возвращающий 0, плюс один `open` и `fstat` для проверки ротации. Это пренебрежимо мало. `FileSystemWatcher` выглядит заманчиво, но он не работает на многих сетевых ресурсах и bind-монтированиях контейнеров, его внутренний буфер переполняется при всплесках и теряет события, а уведомления `Changed` для дописывающего писателя объединяются и задерживаются ОС. Используйте его, если вообще используете, как подсказку, сокращающую задержку, а не как единственный триггер.
4. **Декодирует с `flush: false` и буферизует неполные строки.** `DrainCompleteLines` выдаёт только текст, завершённый `\n`, убирает завершающий `\r`, чтобы журналы с CRLF выходили чистыми, и оставляет неполный хвост в `pending`.
5. **Проверяет усечение и ротацию только на конце файла.** Пока есть байты для чтения, остальное не важно. Когда их нет, проверка по дескриптору `fs.Length < fs.Position` ловит `copytruncate`, а `WasReplaced` ловит переименование с повторным созданием.

### Почему ротации нужна отдельная проверка

Когда `logrotate` (или архивация NLog, или ваш собственный код) переименовывает `app.log` и создаёт новый, ваш дескриптор не следует за именем. Дескрипторы указывают на файлы, а не на пути: и в Unix, и в Windows с `FILE_SHARE_DELETE` старый дескриптор продолжает читать переименованный файл, который больше никогда не вырастет. Читатель навсегда застрянет на конце файла, пока приложение спокойно пишет в новый `app.log`.

`WasReplaced` открывает путь заново и сравнивает длины. Для журнала только с дозаписью, если путь всё ещё указывает на читаемый вами файл, его длина равна вашей позиции (вы на конце файла) либо писатель успел что-то дописать, и тогда `current.Length` не меньше, потому что читается позже. Длина пути меньше вашей позиции или больше длины вашего дескриптора означает другой файл. Я измеряю через свежий дескриптор, а не через `FileInfo.Length`, потому что в Windows информация о размере, взятая из записи каталога, может отставать для файла, всё ещё открытого на запись.

У проверки есть одно слепое пятно: новый файл, имеющий ровно ту же длину, что и старый при каждой пробе. Это окно закрывается, как только новый файл вырастет. Если нужна безупречная идентификация, сравнивайте идентификатор файла (`GetFileInformationByHandle` в Windows, `st_dev` плюс `st_ino` из `fstat` в Unix) через P/Invoke. По состоянию на .NET 11 ни то, ни другое не доступно публично.

## Сначала прочитать только последние N строк

`tail -n 50 -f` показывает недавний контекст перед тем, как следить за файлом. Читать файл на 2 ГБ ради его последних 50 строк расточительно, поэтому читайте окно с конца:

```csharp
// .NET 10 / .NET 11, C# 14
public static async Task<IReadOnlyList<string>> ReadLastLinesAsync(
    string path, int count, int maxBytes = 64 * 1024)
{
    await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    long start = Math.Max(0, fs.Length - maxBytes);
    fs.Seek(start, SeekOrigin.Begin);
    using var reader = new StreamReader(fs, Encoding.UTF8);
    var lines = new Queue<string>(count + 1);
    bool skipFirst = start > 0; // we probably landed mid-line
    string? line;
    while ((line = await reader.ReadLineAsync()) is not null)
    {
        if (skipFirst) { skipFirst = false; continue; }
        lines.Enqueue(line);
        if (lines.Count > count) lines.Dequeue();
    }
    return lines.ToArray();
}
```

Здесь `StreamReader` подходит, потому что это однократное чтение: неполные данные есть только в самом начале (пропускается) и, возможно, в последней строке, которую можно показать как есть. Переход в середину файла может попасть внутрь последовательности UTF-8, и это ещё одна причина отбрасывать первую строку. Если в 64 КБ нет `count` строк, удвойте `maxBytes` и повторите. Вызовите метод, выведите результат, затем запустите `FollowAsync` с `fromStart: false`. Несколько строк, записанных между двумя вызовами, могут потеряться; если это важно, пусть `ReadLastLinesAsync` возвращает смещение, на котором остановился, и начинайте слежение с него.

## Подводные камни, в которых читатель не виноват

**Писатель должен сбрасывать буфер.** Вы видите только то, что дошло до ОС. Файловый приёмник Serilog по умолчанию использует `buffered: false`, а файловая цель NLog по умолчанию имеет `autoFlush="true"`, но `StreamWriter` с `AutoFlush = false` держит в памяти до размера своего буфера. Множество сообщений вида "читатель пропускает последние строки" это писатель, который ещё не сбросил буфер.

**`copytruncate` теряет данные по замыслу.** В моём тесте писатель усекал файл через 120 мс после последней записи, и читатель, опрашивая раз в 250 мс, так и не увидел эту строку. Документация самого `logrotate` предупреждает, что строки, записанные между копированием и усечением, теряются. Предпочитайте ротацию переименованием (`create`) с приложением, которое заново открывает свой файл, либо делайте интервал опроса коротким.

**Не открывайте с `FileAccess.ReadWrite`.** Некоторые примеры в интернете так делают, видимо, чтобы "соответствовать" писателю. Вам нужен только доступ на чтение, а в Windows запрос доступа на запись завершается ошибкой, если писатель открыл файл с `FileShare.Read`.

**Кодировка и BOM.** Вспомогательный класс предполагает UTF-8, в котором пишут Serilog, NLog, перенаправление консоли Microsoft.Extensions.Logging и почти все инструменты Unix. Если вы следите за журналами в UTF-16, замените `Decoder`, а если воспроизводите с `fromStart: true` файл, начинающийся с UTF-8 BOM, обрежьте `'\uFEFF'` в первой строке.

**Очень длинные строки.** `pending` растёт, пока не придёт перевод строки. Если писатель может выдавать строки неограниченной длины (бинарный мусор, минифицированный блок JSON), ограничьте `pending.Length` и выдайте или отбросьте накопленное, как только лимит превышен.

**Несколько писателей.** `shared: true` в Serilog и несколько процессов, дописывающих в один файл, работают только потому, что каждая запись атомарно попадает в конец файла. Читателю всё равно, сколько писателей, но перемешивание их неполных записей это проблема писателей, а не ваша.

## Что почитать дальше

- Если вопрос не "что дописали", а "закончилась ли запись в файл", см. [как определить, что запись в файл завершена, в .NET](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/), где разобраны проверка через `FileShare.None` и стабилизация размера.
- `FollowAsync` это асинхронный поток. [Что такое `IAsyncEnumerable` и когда его использовать](/ru/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) объясняет, почему `[EnumeratorCancellation]` стоит на параметре токена.
- Чтобы корректно остановить чтение из размещённой службы, [передавайте `CancellationToken` через цепочку асинхронных вызовов](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- Если нужно раздавать строки нескольким потребителям, поставьте [`Channel<T>` между читателем и обработчиками](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).
- Для стороны записи [структурированное журналирование с Serilog и Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) показывает конфигурацию файлового приёмника, из которого читает эта статья.

## Источники

- [`StreamReader.cs` в dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs): конструктор по пути с `FileShare.Read` и декодирование с `flush: true` на конце потока.
- [`SafeFileHandle.Unix.cs` в dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs): эмуляция `FileShare` через `LOCK_SH` / `LOCK_EX` и переключатель `System.IO.DisableFileLocking`.
- [`FileSink.cs` в serilog-sinks-file](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs): как Serilog открывает свой файл журнала.
- [Перечисление `FileShare` на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare).
- [`Decoder.GetChars` на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.text.decoder.getchars), включая параметр `flush`.
- [dotnet/runtime, issue 48757](https://github.com/dotnet/runtime/issues/48757): блокировка файлов в NFS и `DOTNET_SYSTEM_IO_DISABLEFILELOCKING`.
