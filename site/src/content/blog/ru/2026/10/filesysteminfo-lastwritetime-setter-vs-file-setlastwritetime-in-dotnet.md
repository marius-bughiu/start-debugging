---
title: "Сеттер FileSystemInfo.LastWriteTime или File.SetLastWriteTime в .NET"
description: "Оба пути заканчиваются одним и тем же вызовом ОС, поэтому записанная метка времени идентична. Различия кроются вокруг этого вызова: какой кеш сбрасывается, работают ли каталоги в Windows, как преобразуется DateTime не в UTC и можно ли указать открытый дескриптор. Используйте File.SetLastWriteTimeUtc, а для открытого файла передавайте дескриптор. Проверено на .NET 10.0.10."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "filesystem"
  - "io"
lang: "ru"
translationOf: "2026/10/filesysteminfo-lastwritetime-setter-vs-file-setlastwritetime-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-30
---

Используйте `File.SetLastWriteTimeUtc` (или `Directory.SetLastWriteTimeUtc` для папок), а перегрузку с `SafeFileHandle` применяйте, если время задаётся для файла, в который вы ещё пишете. Сеттер `FileInfo.LastWriteTimeUtc` берите только тогда, когда у вас уже есть этот `FileInfo` и вы будете снова читать его свойства, потому что сеттер - единственный API, который заодно обновляет кеш этого экземпляра. Оба пути вызывают один и тот же внутренний `FileSystem.SetLastWriteTime`, поэтому на диск попадают одни и те же биты. Различается всё, что происходит вокруг этого вызова. В любом случае передавайте `DateTime` с `Kind = Utc` в член с суффиксом `...Utc` и никогда не передавайте локальное или неопределённое время в член без него.

Всё ниже запускалось на .NET 10.0.10 (SDK 10.0.302, C# 14) на macOS 27 с APFS, на машине с локальным часовым поясом `Europe/Bucharest` (UTC+2 на дату теста). Поведение в Windows процитировано из ветки `release/10.0` репозитория dotnet/runtime. Задействованный код почти не менялся с .NET 7, когда появились перегрузки с дескриптором, поэтому те же правила действуют для .NET 8, 9 и превью .NET 11.

## Сравнение вкратце

| | `fileInfo.LastWriteTimeUtc = t` | `File.SetLastWriteTimeUtc(path, t)` |
| --- | --- | --- |
| Вызов ОС (Windows) | `SetFileInformationByHandle(FileBasicInfo)` | тот же |
| Вызов ОС (Unix) | `utimensat(..., AT_SYMLINK_NOFOLLOW)` | тот же |
| Сбрасывает кеш | только этого экземпляра `FileInfo` | ничего (кеша нет) |
| Другие объекты `FileInfo` для того же пути | устарели до `Refresh()` | устарели до `Refresh()` |
| Каталог как цель в Windows | только через `DirectoryInfo` | ошибка, используйте `Directory.SetLastWriteTimeUtc` |
| Принимает открытый `SafeFileHandle` | нет | да, начиная с .NET 7 |
| `DateTime.MinValue` с сеттером локального времени, пояс UTC+ | молча обрезается | выбрасывает `ArgumentOutOfRangeException` |
| Отсутствующий файл | `FileNotFoundException` | `FileNotFoundException` |
| Стоимость вызова (10k вызовов, APFS, M4) | 10.4 мкс | 10.7 мкс (по дескриптору: 8.6 мкс) |

## Что на самом деле делают эти два API

Если убрать публичную поверхность, оба сходятся в одном месте. Вот сторона `FileSystemInfo`, из `FileSystemInfo.cs` и `FileSystemInfo.Windows.cs`:

```csharp
// dotnet/runtime release/10.0, System.Private.CoreLib
public DateTime LastWriteTime
{
    get => LastWriteTimeUtc.ToLocalTime();
    set => LastWriteTimeUtc = value.ToUniversalTime();
}

public DateTime LastWriteTimeUtc
{
    get => LastWriteTimeCore.UtcDateTime;
    set => LastWriteTimeCore = File.GetUtcDateTimeOffset(value);
}

internal DateTimeOffset LastWriteTimeCore   // Windows
{
    set
    {
        FileSystem.SetLastWriteTime(FullPath, value, (this is DirectoryInfo));
        _dataInitialized = -1;   // invalidate this instance's cache
    }
}
```

И сторона `File`:

```csharp
// dotnet/runtime release/10.0, File.cs
public static void SetLastWriteTime(string path, DateTime lastWriteTime)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), lastWriteTime, false);

public static void SetLastWriteTimeUtc(string path, DateTime lastWriteTimeUtc)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), GetUtcDateTimeOffset(lastWriteTimeUtc), false);
```

Этот завершающий `false` - флаг `asDirectory`, и в Windows он важен (подробнее ниже). В Unix сеттер `FileInfo` идёт через собственную структуру `FileStatus`, а `File` использует одноразовый `default(FileStatus)`, но оба вызывают один и тот же `SetAccessOrWriteTimeCore`. Этот метод сначала заново вызывает stat для файла, чтобы записать обратно текущее время доступа без изменений, затем вызывает `utimensat` с `AT_SYMLINK_NOFOLLOW`, а потом сбрасывает кеш состояния. В Windows оба открывают путь с `FILE_WRITE_ATTRIBUTES` и вызывают `SetFileInformationByHandle` со структурой `FILE_BASIC_INFO`, где все поля, кроме `LastWriteTime`, равны нулю, что Windows трактует как "оставить без изменений".

Так что ни о какой "ленивости сеттера `FileInfo`" и об изменении только объекта в памяти речи нет, хотя это распространённое предположение. Сеттер обращается к диску немедленно, как и статический метод.

## Сброс кеша: различие, с которым вы реально столкнётесь

`FileSystemInfo` кеширует всё, что читает. Первое обращение к свойству вызывает stat для файла, а последующие возвращают снимок, пока что-нибудь не вызовет `Refresh()`. Сеттер сбрасывает кеш того экземпляра, на котором вы его вызвали, и больше ничего. Этот пример делает видимыми все три случая:

```csharp
// .NET 10.0.10, C# 14 - run with: dotnet run probe.cs
var path = Path.Combine(Path.GetTempPath(), "a.txt");
File.WriteAllText(path, "hello");
var target = new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc);

var fi1 = new FileInfo(path);
var fi2 = new FileInfo(path);
_ = fi1.LastWriteTimeUtc; _ = fi2.LastWriteTimeUtc; // populate both caches

fi1.LastWriteTimeUtc = target;
Console.WriteLine(fi1.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2026-10-30T12:04:26.3262150Z (stale)
fi2.Refresh();
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z

var fi3 = new FileInfo(path); _ = fi3.Length;          // snapshot now
File.SetLastWriteTimeUtc(path, target.AddYears(1));
Console.WriteLine(fi3.LastWriteTimeUtc.ToString("O")); // 2020-01-02... (stale)
Console.WriteLine(File.GetLastWriteTimeUtc(path).ToString("O")); // 2021-01-02...
```

Это единственная настоящая причина предпочесть сеттер. Если метод получает `FileInfo`, задаёт его метку времени, а затем вызывающий код пишет в журнал `fileInfo.LastWriteTime` или сравнивает его с другим файлом, сеттер сохраняет объект в актуальном состоянии. Вызов `File.SetLastWriteTimeUtc(fileInfo.FullName, t)` на том же месте оставит вызывающему устаревшее значение, и эта ошибка проявится только когда кто-то снова прочитает свойство. Если идёте этим путём, добавьте `fileInfo.Refresh()` после вызова.

Обратное не менее важно: сеттер не затрагивает другие экземпляры `FileInfo`, включая те, что получены из `DirectoryInfo.EnumerateFiles`. Они были заполнены во время перечисления и остаются замороженными. То же поведение снимка заставляет `FileInfo.Length` врать для растущих файлов, о чём я подробно писал в статье [почему FileInfo.Length возвращает устаревший размер в Windows](/ru/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/).

## Каталоги: ловушка File.SetLastWriteTime только для Windows

`File.SetLastWriteTime` всегда передаёт `asDirectory: false`. В Windows этот флаг решает, добавит ли `OpenHandleToWriteAttributes` флаг `FILE_FLAG_BACKUP_SEMANTICS` к вызову `CreateFile`:

```csharp
// dotnet/runtime release/10.0, FileSystem.Windows.cs
int dwFlagsAndAttributes = Interop.Kernel32.FileOperations.FILE_FLAG_OPEN_REPARSE_POINT;
if (asDirectory)
{
    dwFlagsAndAttributes |= Interop.Kernel32.FileOperations.FILE_FLAG_BACKUP_SEMANTICS;
}
```

[Документация `CreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) прямо требует установить `FILE_FLAG_BACKUP_SEMANTICS`, чтобы получить дескриптор каталога, поэтому `File.SetLastWriteTimeUtc(@"C:\data\folder", t)` завершается в Windows ошибкой отказа в доступе. `DirectoryInfo.LastWriteTimeUtc = t` передаёт `this is DirectoryInfo` и работает, как и `Directory.SetLastWriteTimeUtc`.

В Linux и macOS флаг влияет только на тип исключения при отсутствующем пути, поэтому тот же вызов `File` для каталога проходит успешно. Мой тест подтвердил это на APFS. Это ровно тот код, который проходит CI на раннере с Linux, а затем падает на Windows-ноутбуке разработчика. Если ваш код может получить и файл, и папку, ветвитесь по `Directory.Exists` и вызывайте соответствующий статический класс или создавайте правильный подтип `FileSystemInfo`.

Родственная странность: `new FileInfo(directoryPath).Exists` равно `false`, но в Unix `new FileInfo(directoryPath).LastWriteTimeUtc = t` проходит успешно и меняет метку каталога. Не полагайтесь на это.

## Локальное время и UTC: где пути расходятся на граничных значениях

Члены без UTC - то место, где два API перестают быть симметричными. `File.SetLastWriteTime(string, DateTime)` передаёт `DateTime` прямо в параметр `DateTimeOffset`, поэтому выполняется неявное преобразование `DateTime` в `DateTimeOffset`. Сеттер `FileInfo.LastWriteTime` вместо этого вызывает `value.ToUniversalTime()`. Для обычных дат результаты совпадают, и оба трактуют `DateTimeKind.Unspecified` как локальное время:

```text
File.SetLastWriteTime(Unspecified 12:00)    -> 09:00Z   (treated as local, UTC+3 in June)
File.SetLastWriteTimeUtc(Unspecified 12:00) -> 12:00Z   (treated as UTC)
File.SetLastWriteTime(Utc-kind 03:04:05Z)   -> 03:04:05Z (Kind honoured)
fi.LastWriteTime = Unspecified 12:00        -> 09:00Z
fi.LastWriteTimeUtc = Local-kind 12:00      -> 09:00Z   (Local converted, not reinterpreted)
```

На границах поведение разное. В любом часовом поясе к востоку от UTC у `DateTime.MinValue` нет допустимого эквивалента в UTC. `ToUniversalTime()` тихо обрезает значение до `DateTime.MinValue`, а неявное преобразование в `DateTimeOffset` отказывается:

```csharp
// .NET 10.0.10, Europe/Bucharest (UTC+2)
File.SetLastWriteTime(path, DateTime.MinValue);
// ArgumentOutOfRangeException: The UTC time represented when the offset is applied
// must be between year 0 and 10,000. (Parameter 'offset')

new FileInfo(path).LastWriteTime = DateTime.MinValue; // no exception here
```

К западу от UTC так же выбрасывает исключение `DateTime.MaxValue`. Вы не станете использовать эти значения намеренно, но ветки кода "сбросить по умолчанию" и неинициализированные поля подставляют их чаще, чем можно ожидать.

Прохождение преобразования не означает, что значение можно сохранить. `FILETIME` в Windows начинается с 1601 года, а `DateTimeOffset.ToFileTime()` выбрасывает `ArgumentOutOfRangeException: Not a valid Win32 FileTime.` для всего, что раньше, поэтому в Windows оба API выбрасывают исключение для `DateTime.MinValue`. APFS хранит знаковое 64-битное число наносекунд с 1970 года, поэтому в macOS "успешная" запись `DateTime.MinValue` приземляется на `1677-09-21T00:12:43.1452241Z`, самый ранний момент, который может представить APFS. Ни то, ни другое вы не имели в виду. Проверяйте диапазон сами, прежде чем вызывать любой из API.

Переход на летнее время - ещё одна причина держаться за члены `...Utc`. Локальное время в час "осеннего отката" неоднозначно, и `ToUniversalTime()` молча выбирает интерпретацию по стандартному времени. Если метка пришла с другой машины, из базы данных или из записи архива, она почти наверняка с самого начала была в UTC. Держите её в UTC до самого диска. Тот же совет относится к [значениям `DateTime` в JSON](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

## Перегрузка с дескриптором и почему открытые файлы отменяют вашу метку

Только у статического класса есть `File.SetLastWriteTime(SafeFileHandle, DateTime)` и `File.SetLastWriteTimeUtc(SafeFileHandle, DateTime)`, добавленные в .NET 7. Они вызывают `SetFileInformationByHandle` или `futimens` для дескриптора, который у вас уже есть, пропуская поиск по пути и лишнее открытие.

Более важная причина их использовать - порядок операций. Установка метки времени, пока ваш собственный `FileStream` ещё держит буферизованные байты, - классическая ошибка, потому что ОС снова обновляет время изменения, когда эти байты сбрасываются при `Dispose`:

```csharp
// .NET 10.0.10, C# 14
using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);               // sits in FileStream's 4 KB buffer
    File.SetLastWriteTimeUtc(p, target);
    // File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z
}
// File.GetLastWriteTimeUtc(p) here: 2026-10-30T12:04:26Z  <- your value is gone

using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);
    fs.Flush();                            // all writes reach the OS first
    File.SetLastWriteTimeUtc(fs.SafeFileHandle, target);
}
// File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z  <- kept
```

Правило такое: "побеждает последняя запись", то есть метка времени должна быть последним, что затрагивает файл. Сбросьте буфер, задайте время по дескриптору, закройте. Установка после блока `using` по пути тоже работает, но стоит второго открытия и оставляет окно, в котором другой процесс увидит файл с неверным временем. Это важно, если потребитель [ждёт завершения записи файла](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) или опрашивает метки времени, как это делает [подход со сравнением снимков для сетевых папок](/ru/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/).

У `FileSystemInfo` нет эквивалента на основе дескриптора, поэтому если нужен этот шаблон, вы на `File` независимо от предпочтений.

## Символические ссылки, время создания и точность

Три вещи одинаковы на обоих путях, но люди часто в них ошибаются:

- **Символические ссылки**: Windows открывает с `FILE_FLAG_OPEN_REPARSE_POINT`, а Unix вызывает `utimensat` с `AT_SYMLINK_NOFOLLOW`, поэтому оба API меняют саму ссылку и не трогают цель. Если нужна цель, сначала разрешите её через `FileSystemInfo.ResolveLinkTarget(returnFinalTarget: true)` и задайте время результату.
- **Время создания в macOS**: установка времени изменения раньше времени рождения заставляет ядро сдвинуть время рождения назад. .NET обнаруживает это в macOS и восстанавливает исходное время создания через `setattrlist`, поэтому `File.GetCreationTimeUtc` не меняется после того, как вы сдвинули `LastWriteTime` в прошлое. В Linux настраиваемого времени рождения нет, и .NET сообщает в качестве времени создания меньшее из `ctime` и `mtime`.
- **Точность**: у `DateTime` тики по 100 нс. NTFS, APFS и ext4 хранят их все (моя круговая проверка `...07.1234567Z` вернулась точно), FAT32 округляет до 2 секунд, а exFAT хранит 10 мс. Если вы сравниваете метки времени между томами, например в инструменте резервного копирования или синхронизации, сравнивайте с допуском, а не через `==`.

Оба API выбрасывают `FileNotFoundException` для отсутствующего файла. Это асимметрично геттерам, которые вместо исключения возвращают `1601-01-01T00:00:00Z`. Поэтому код, который читает время, принимает решение, а затем пишет, может увидеть исчезновение файла между двумя вызовами и получить исключение от метода, выглядевшего безобидно. Если файл может быть удалён параллельно, перехватывайте `FileNotFoundException` вокруг записи.

## Бенчмарк, который не имеет значения

Для полноты: 10,000 вызовов каждого на прогретом томе APFS (Apple M4, .NET 10.0.10, Release, `Stopwatch` вокруг цикла) стоят 10.72 мкс на вызов для `File.SetLastWriteTimeUtc(path, t)`, 10.40 мкс для сеттера `FileInfo` и 8.60 мкс для перегрузки с дескриптором на уже открытом дескрипторе. Варианты с путём равны в пределах шума, потому что каждый выполняет stat, `utimensat`, а на стороне `FileInfo` ещё и сброс кеша. Дескриптор экономит разрешение пути. Ничто из этого не должно определять ваш выбор. Если вы проставляете метки тысячам файлов, stat внутри каждого вызова доминирует, и распараллеливание по файлам поможет гораздо больше, чем смена API.

## Рекомендация ещё раз

По умолчанию используйте `File.SetLastWriteTimeUtc(path, utc)` и `Directory.SetLastWriteTimeUtc(path, utc)`. Они явно указывают, какой тип записи вы затрагиваете, не могут оставить после себя кешированный объект и имеют перегрузку с дескриптором для случая "задать время файлу, который я только что записал", откуда и берётся большинство ошибок с метками времени. Переключайтесь на `fileInfo.LastWriteTimeUtc = utc`, когда `FileInfo` - рабочая единица вашего кода и кто-то снова прочитает его свойства, потому что сеттер - единственный API, который держит этот экземпляр синхронизированным. Избегайте членов без UTC в обоих API и проверяйте, что значение укладывается в диапазон целевой файловой системы, прежде чем записывать его.

## Что почитать дальше

- [Почему FileInfo.Length возвращает устаревший размер в Windows](/ru/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) разбирает то же кеширование `FileSystemInfo` с точки зрения размера.
- [Как определить, что запись файла завершена, в .NET](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) описывает сторону потребителя для правила "побеждает последняя запись".
- [FileSystemWatcher или опрос в сетевой папке](/ru/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) опирается на метки времени, которые вы только что научились задавать правильно.
- [Как читать конец журнала, пока другой процесс в него пишет](/ru/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) показывает флаги `FileShare`, использованные в примерах выше.
- [Как запустить файловое приложение C# через dotnet run](/ru/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), если хотите сами перезапустить `probe.cs`.

## Источники

- [`FileSystemInfo.LastWriteTime`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.lastwritetime) и [`File.SetLastWriteTimeUtc`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.setlastwritetimeutc) (Microsoft Learn)
- [`FileSystemInfo.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.cs), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs), [`File.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs) (dotnet/runtime)
- [`FileSystem.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystem.Windows.cs), [`FileStatus.Unix.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileStatus.Unix.cs), [`pal_time.c`](https://github.com/dotnet/runtime/blob/release/10.0/src/native/libs/System.Native/pal_time.c) (dotnet/runtime)
- [`CreateFileW`, `FILE_FLAG_BACKUP_SEMANTICS`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) и [`FILE_BASIC_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info) (Microsoft Learn)
- [`utimensat(2)`](https://man7.org/linux/man-pages/man2/utimensat.2.html) (справочные страницы Linux)
- [File times, resolution per file system](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times) (Microsoft Learn)
