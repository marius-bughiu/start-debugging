---
title: "Исправление: FileInfo.Length возвращает устаревший размер файла, в который ещё идёт запись, в Windows"
description: "FileInfo кеширует размер, перечисление читает лениво обновляемую запись каталога NTFS, а процесс записи может всё ещё держать байты в своих буферах. Используйте Refresh() или, лучше, читайте длину через общий дескриптор с помощью RandomAccess.GetLength."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "csharp"
  - "filesystem"
lang: "ru"
translationOf: "2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows"
translatedBy: "claude"
translationDate: 2026-10-13
---

`FileInfo.Length` врёт по трём независимым причинам, и они накладываются друг на друга. Во-первых, `FileInfo` кеширует данные при первом чтении любого свойства и не перечитывает их, пока вы не вызовете `Refresh()`. Во-вторых, `FileInfo`, полученный из `DirectoryInfo.EnumerateFiles` или `GetFiles` в Windows, заполняется из записи каталога NTFS, а NTFS обновляет эту копию размера только тогда, когда записывающий процесс закрывает свой последний дескриптор. В-третьих, записывающий процесс может всё ещё держать байты в собственных буферах `StreamWriter` / `FileStream`, так что ОС действительно ещё не получила их. Надёжное решение - перестать спрашивать путь и спросить дескриптор: `using var h = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); long size = RandomAccess.GetLength(h);`. Если вы контролируете код записи, вызывайте сброс буфера. Числа по буферизации ниже измерены на .NET 10.0.10 (SDK 10.0.302) и .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128), и они совпали. Специфичные для Windows участки кода приведены по исходникам dotnet/runtime в ветке `main`.

## Симптом на практике

Исключение не возникает. Отчёт об ошибке обычно выглядит примерно так:

```
// what people see, .NET 10 / .NET 11 on Windows
size = 0          // the log file is clearly growing in Notepad++
size = 4096       // the writer has logged 6000 characters
size = 1048576    // Explorer says 1 MB, the copy job says 37 MB
```

Картина всегда одна и та же. Цикл мониторинга, задача выгрузки или проверка "подождать, пока файл перестанет расти" читает `FileInfo.Length`, пока другой процесс (или другой поток) держит файл открытым на запись. Число отстаёт, иногда замирает, и становится правильным сразу после того, как запись закрывает файл. Проводник и `dir` показывают то же замороженное число, из-за чего люди убеждаются, что проблема в Windows, а не в их коде. Отчасти верно и то и другое.

## Почему так происходит

Есть три уровня, и каждый может вызвать проблему сам по себе.

**1. `FileInfo` - это снимок, а не живое представление.** `FileSystemInfo` хранит приватную структуру `WIN32_FILE_ATTRIBUTE_DATA` и флаг `_dataInitialized`. Первое обращение к свойству заполняет её, а все последующие возвращают кешированное значение. В [документации `FileInfo.Length`](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) это сказано прямо: значение предварительно кешируется, если экземпляр получен из `GetFiles` или `EnumerateFiles`, и для получения актуального значения нужно вызвать `Refresh`. Тонкая деталь: заполнение ленивое. Конструирование `new FileInfo(path)` не обращается к диску, поэтому "момент снимка" - это тот момент, когда ваш код впервые прочитал `Length`, `Exists` или любую метку времени, и он часто гораздо раньше, чем вы думаете.

**2. Перечисление читает запись каталога, а NTFS обновляет её лениво.** В Windows `FileSystemEnumerator` вызывает `NtQueryDirectoryFile` с `FileFullDirectoryInformation`, а `FileSystemInfo.Init(FILE_FULL_DIR_INFORMATION*)` копирует `EndOfFile` прямо в кешированный размер. Это число берётся из индекса каталога, а не из файла. Как объясняет Реймонд Чен в статье [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), NTFS считает размер свойством файла и копирует его в запись каталога только как оптимизацию для листингов. Начиная с Windows Vista эта копия обновляется, когда закрывается последний дескриптор объекта файла. Процесс, который держит журнал открытым часами, оставляет запись каталога с тем размером, какой был при открытии файла, а это часто 0. Именно это показывают Проводник, `dir`, `Directory.GetFiles` вместе с `new FileInfo(...)` для результата и `FileSystemEntry.Length` в пользовательском `FileSystemEnumerable`.

**3. Записывающий процесс ещё не записал байты.** `StreamWriter` держит символы в собственном буфере, затем передаёт закодированные байты в `FileStream`, у которого по умолчанию есть собственный буфер в 4096 байт. Пока буферы не заполнятся или кто-то не вызовет `Flush()`, операционная система не получила ни одного байта, поэтому любой API на любой платформе корректно сообщает старый размер. Этот уровень забывают чаще всего, потому что снаружи он неотличим от двух других.

Четвёртый уровень проявляется только на сетевых ресурсах: клиентский редиректор SMB кеширует метаданные файла для запросов по пути. `FileInfoCacheLifetime` и `DirectoryCacheLifetime` по умолчанию равны 10 секундам в актуальных версиях Windows (см. [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server)), поэтому UNC-путь может показывать размер, устаревший на 10 секунд, даже после `Refresh()`.

## Минимальный пример воспроизведения

Это файловое приложение пишет через `StreamWriter` без сброса и измеряет размер четырьмя способами: кешированный `FileInfo`, тот же `FileInfo` после `Refresh()`, новый дескриптор через `RandomAccess.GetLength` и `FileInfo` из перечисления каталога. Запустите его командой `dotnet run probe.cs`.

```csharp
// .NET 10 / .NET 11, C# 14, file-based app: dotnet run probe.cs
#:property PublishAot=false
using Microsoft.Win32.SafeHandles;

string path = Path.Combine(Path.GetTempPath(), "stale-probe.log");
File.Delete(path);

using var writer = new StreamWriter(new FileStream(path, FileMode.Create,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete));
var cached = new FileInfo(path);
Console.WriteLine($"start: cached={cached.Length}");   // first access: snapshot taken here

writer.Write(new string('a', 1000));
Report("after 1000 chars, no flush");
writer.Write(new string('a', 5000));
Report("after 6000 chars, no flush");
writer.Flush();
Report("after StreamWriter.Flush()");

var fromEnum = new DirectoryInfo(Path.GetTempPath())
    .EnumerateFiles("stale-probe.log").Single();
writer.Write(new string('b', 4000)); writer.Flush();
Console.WriteLine($"enumerated FileInfo (no Refresh) after +4000: {fromEnum.Length}");
fromEnum.Refresh();
Console.WriteLine($"enumerated FileInfo after Refresh: {fromEnum.Length}");

void Report(string label)
{
    long stale = cached.Length;
    cached.Refresh();
    long refreshed = cached.Length;
    using SafeFileHandle h = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    Console.WriteLine($"{label}: cached={stale} refreshed={refreshed} " +
        $"handle={RandomAccess.GetLength(h)} writer.BaseStream.Position={writer.BaseStream.Position}");
}
```

Вывод, одинаковый на .NET 10.0.10 и .NET 11.0.0 RC1 (macOS arm64, APFS):

```
start: cached=0
after 1000 chars, no flush: cached=0 refreshed=0 handle=0 writer.BaseStream.Position=0
after 6000 chars, no flush: cached=0 refreshed=4096 handle=4096 writer.BaseStream.Position=5120
after StreamWriter.Flush(): cached=4096 refreshed=6000 handle=6000 writer.BaseStream.Position=6000
enumerated FileInfo (no Refresh) after +4000: 6000
enumerated FileInfo after Refresh: 10000
```

Разберём построчно:

- После 1000 символов в ОС ничего не попало. `StreamWriter` всё ещё держит всё у себя, поэтому даже дескриптор показывает 0. Никакое решение на стороне читателя здесь не поможет.
- После 6000 символов `StreamWriter` передал в `FileStream` 5120 символов (пять блоков по 1024 символа), а `FileStream` записал в ОС один полный буфер в 4096 байт. Любой честный API говорит 4096. Кешированный `FileInfo` по-прежнему говорит 0.
- После `Flush()` реальный размер равен 6000. Кешированный `FileInfo` говорит 4096, потому что предыдущий вызов `Report` обновил его, а после этого его никто не обновлял.
- Перечисленный `FileInfo` был заморожен на момент перечисления, и ему потребовался `Refresh()`, чтобы увидеть дополнительные 4000 байт.

В macOS и Linux всю картину объясняют уровни 1 и 3, потому что `stat` читает inode, а отдельной копии размера в каталоге нет. В Windows сверху добавляется уровень 2: запустите ту же программу там и посмотрите на папку в Проводнике, пока она ждёт, и листинг каталога будет отставать от значения дескриптора, пока запись не будет закрыта. Эту половину я для данной статьи на Windows не замерял. Механизм описан Реймондом Ченом, а точный путь в коде (`NtQueryDirectoryFile` в `FileSystemInfo.Init`) виден в исходниках среды выполнения, ссылки на которые приведены в конце.

## Решение подробно

Выбирайте решение под тот уровень, с которым вы столкнулись. В реальном коде обычно затронуто несколько уровней сразу.

### 1. Рекомендуется: читайте размер из дескриптора, а не из пути

Запрос по дескриптору обращается к открытому объекту файла, где NTFS хранит достоверный конец файла. Это единственный ответ, который Реймонд Чен называет правильным (`GetFileSize` для дескриптора), и он обходит и кеш `FileInfo`, и запись каталога. Начиная с .NET 6 это можно сделать без `FileStream`:

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Win32.SafeHandles;

static long GetLiveLength(string path)
{
    // FileShare.ReadWrite: the writer already holds write access, so we must allow it.
    // FileShare.Delete: do not break a writer that renames or deletes during rotation.
    using SafeFileHandle handle = File.OpenHandle(
        path,
        FileMode.Open,
        FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);

    return RandomAccess.GetLength(handle);
}
```

`File.OpenHandle` вместе с `RandomAccess.GetLength` легче, чем `new FileStream(...).Length`: нет выделения буфера, нет отслеживания позиции, а в Windows `RandomAccess.GetLength` вызывает для дескриптора `GetFileInformationByHandleEx(FileStandardInfo)` и возвращает `EndOfFile`. Если у вас уже открыт `FileStream` для этого файла (например, вы читаете его "хвост"), используйте `stream.Length` у этого потока. Он идёт через тот же запрос к дескриптору.

Здесь прячется ещё один кеш. В Windows `SafeFileHandle` устанавливает `_lengthCanBeCached`, если дескриптор открыт только на чтение **и** без `FileShare.Write`, и с этого момента возвращает первую полученную длину. Это корректно, потому что никто не может писать в файл, пока ваш дескриптор не разрешает совместную запись. Но из этого следует, что `FileShare.Read` никогда не подходит для наблюдения за растущим файлом. Если запись уже идёт, ваше открытие завершится ошибкой. Если вы откроете первым, ошибкой завершится открытие у записывающего процесса, что хуже, потому что вы сломали источник данных. Используйте `FileShare.ReadWrite` (плюс `FileShare.Delete`), и среда выполнения будет запрашивать ОС при каждом вызове.

Режим совместного доступа имеет значение. Если открыть с `FileShare.Read` по умолчанию, открытие завершится ошибкой `IOException: The process cannot access the file because it is being used by another process`, потому что у записывающего процесса уже есть доступ на запись, а ваш режим совместного доступа его не разрешает. Эта ошибка - самая частая причина, по которой люди отказываются от подхода с дескриптором и возвращаются к `FileInfo`.

Полезный побочный эффект: открытие и закрытие вашего собственного дескриптора тоже заставляет NTFS обновить запись каталога при закрытии этого дескриптора, согласно той же статье Old New Thing. Поэтому после вызова `GetLiveLength` Проводник и перечисление тоже нагоняют актуальное значение, пока запись снова не допишет данные.

### 2. Если без `FileInfo` не обойтись, вызывайте `Refresh()` перед каждым чтением

Для цикла опроса держите один `FileInfo` и обновляйте его на каждой итерации:

```csharp
// .NET 10 / .NET 11, C# 14
var fi = new FileInfo(path);
long last = -1;
while (!ct.IsCancellationRequested)
{
    fi.Refresh();                       // without this, Length never changes
    if (fi.Exists && fi.Length != last)
    {
        Console.WriteLine($"{fi.Length:N0} bytes");
        last = fi.Length;
    }
    await Task.Delay(TimeSpan.FromSeconds(1), ct);
}
```

В Windows `Refresh()` для `FileInfo`, созданного из пути, идёт через `FileSystem.FillAttributeInfo`, который вызывает `GetFileAttributesEx` для пути и переключается на `FindFirstFile` (чтение записи каталога) только тогда, когда этот вызов завершается с ошибкой вроде `ERROR_SHARING_VIOLATION` или `ERROR_ACCESS_DENIED`. Этот запасной путь существует для `pagefile.sys` и файлов, ожидающих удаления. Microsoft не документирует, всегда ли `GetFileAttributesEx` отражает актуальный размер открытого файла, поэтому считайте `Refresh()` средством, которое "исправляет уровень 1 и, вероятно, уровень 2 на локальном NTFS", а там, где важна корректность, используйте подход с дескриптором.

### 3. Не доверяйте размерам из перечисления для файлов, которые могут быть открыты

`Directory.EnumerateFiles`, возвращающий пути, использовать можно. А `DirectoryInfo.EnumerateFiles`, возвращающий объекты `FileInfo`, и `FileSystemEntry.Length` внутри преобразования `FileSystemEnumerable<T>` быстры именно потому, что переиспользуют копию размера из записи каталога. Это та самая копия, которую NTFS обновляет лениво. Используйте перечисление, чтобы найти файлы-кандидаты, а затем опрашивайте каждый нужный файл отдельно:

```csharp
// .NET 10 / .NET 11, C# 14
foreach (FileInfo fi in new DirectoryInfo(inbox).EnumerateFiles("*.csv"))
{
    long listed = fi.Length;          // directory-entry copy on Windows, may be stale
    long live = GetLiveLength(fi.FullName);
    if (listed != live)
        Console.WriteLine($"{fi.Name}: listing says {listed:N0}, handle says {live:N0}");
}
```

Открытие каждого файла стоит нескольких обращений за метаданными, поэтому Проводник так не делает. Для папки с тысячами файлов опрашивайте только новые или недавно изменённые.

### 4. Если вы контролируете запись, сбрасывайте буфер (и понимайте, что значит сброс)

Никакой приём на стороне читателя не увидит байты, которые так и не покинули процесс записи. Если монитору нужно видеть прогресс, запись должна передать байты в ОС:

```csharp
// .NET 10 / .NET 11, C# 14
using var log = new StreamWriter(new FileStream(path, FileMode.Append,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
{
    AutoFlush = true    // every Write call pushes through StreamWriter and FileStream to the OS
};
```

`AutoFlush = true` стоит один системный вызов на каждый `Write`. Для журнала с большим объёмом вызывайте `Flush()` по таймеру или после каждой логической записи. `Flush()` (или `Flush(false)` у `FileStream`) передаёт байты в кеш ОС, чего достаточно, чтобы другие процессы увидели новый размер. `FileStream.Flush(flushToDisk: true)` дополнительно принудительно сбрасывает их на физический диск. Это нужно для надёжности хранения, а не для видимости, и работает гораздо медленнее.

### 5. На сетевых ресурсах учитывайте кеш клиента SMB

`Refresh()` для UNC-пути может быть обслужен из кеша информации о файлах редиректора SMB на срок до `FileInfoCacheLifetime` секунд (по умолчанию 10). Открытие дескриптора, как в решении 1, отправляет серверу запрос на открытие, поэтому и здесь это лучший выбор. Если вы не можете изменить код, можно уменьшить это время на клиенте командой `Set-SmbClientConfiguration -FileInfoCacheLifetime 0`, но это замедляет все запросы метаданных по пути на машине. Считайте это диагностикой, а не решением.

## Подводные камни и похожие случаи

**"Файл готов" - это другой вопрос.** Стабильный размер не доказывает, что запись завершена. Она может быть просто приостановлена. Если вам на самом деле нужно "можно ли обрабатывать этот файл сейчас", используйте шаблон переименования по завершении или проверку эксклюзивным открытием из статьи [как определить, что запись в файл завершена, в .NET](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/).

**Чтение новых байтов по мере их появления** - тоже отдельная задача. Для неё держите один `FileStream` с общим доступом на чтение и сравнивайте `fs.Length` с `fs.Position`, как показано в статье [как читать "хвост" журнала на C#, пока в него пишет другой процесс](/ru/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/). Там же разобраны усечение и ротация, когда меньший размер означает "начать заново", а не "устарело".

**`LastWriteTime` устаревает теми же способами.** Метка времени записи каталога реплицируется так же, как и размер, а `FileInfo` кеширует её в той же структуре. Всё сказанное выше относится и к `LastWriteTimeUtc`, а NTFS может дополнительно откладывать обновление меток времени сама. Не используйте только метку времени для обнаружения роста.

**Предварительно выделенные файлы.** Некоторые процессы записи (базы данных, менеджеры загрузок, `FileStream` с `preallocationSize`, вызовы `SetLength`) сразу увеличивают файл до конечного размера и заполняют его позже. Дескриптор сообщает истинный конец файла, который уже равен конечному размеру. В этом случае "размер не изменился" ничего не говорит о прогрессе. Используйте собственный сигнал прогресса от записывающей стороны.

**Записывающие процессы с отображением в память.** Процесс, который отображает файл и пишет через представление, меняет содержимое, не меняя размер, а конец файла был зафиксирован при создании отображения. Опрос по размеру такие записи обнаружить не может вообще.

**`IOException` при открытии дескриптора.** Если запись открыла файл с `FileShare.None` (значение по умолчанию для `File.Create` / `File.OpenWrite`), никакие другие открытия не разрешены, даже ваше с `FileShare.ReadWrite`. Тогда вам остаётся либо читать, возможно, устаревший размер по пути, либо менять процесс записи. Перехват этого нарушения совместного доступа лежит в основе проверки "запись ещё идёт" в связанной статье выше.

## Связанные материалы

- [Как определить, что запись в файл завершена, в .NET](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) описывает опрос стабильности, проверки эксклюзивным открытием и приём с переименованием на стороне записи.
- [Как читать "хвост" журнала на C#, пока в него пишет другой процесс](/ru/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) - это полноценный читатель на основе дескриптора с обработкой ротации.
- [Как прочитать большой CSV в .NET 11, не исчерпав память](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) пригодится, когда файл полностью записан и его нужно обработать.
- [Как запустить файловое приложение на C# через dotnet run в .NET 11](/ru/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) объясняет директивы `#:property`, использованные в примере выше.

## Источники

- Raymond Chen, [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), The Old New Thing.
- [Свойство `FileInfo.Length`](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) и [`FileSystemInfo.Refresh`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.refresh), Microsoft Learn.
- [`RandomAccess.GetLength`](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.getlength) и [`File.OpenHandle`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.openhandle), Microsoft Learn.
- Исходники dotnet/runtime: [`FileSystem.Attributes.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Common/src/System/IO/FileSystem.Attributes.Windows.cs) (`FillAttributeInfo`), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs) (`Init` из `FILE_FULL_DIR_INFORMATION`), [`FileSystemEnumerator.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/Enumeration/FileSystemEnumerator.Windows.cs) (`NtQueryDirectoryFile`).
- [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server), параметры клиента SMB `FileInfoCacheLifetime` и `DirectoryCacheLifetime`.
