---
title: "Как прочитать большой CSV в .NET 11 и не словить нехватку памяти"
description: "Стримьте CSV в несколько гигабайт на .NET 11 без OutOfMemoryException. File.ReadLines, CsvHelper, Sylvan и Pipelines в сравнении с кодом и измерениями."
pubDate: 2026-04-24
tags:
  - ".NET 11"
  - "C# 14"
  - "Performance"
  - "CSV"
  - "Streaming"
lang: "ru"
translationOf: "2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory"
translatedBy: "claude"
translationDate: 2026-04-24
---

Если ваш процесс умирает с `OutOfMemoryException` при чтении CSV, исправление почти всегда сводится к одной фразе: перестаньте материализовать файл, начните его стримить. На .NET 11 и C# 14 `File.ReadLines` покрывает 80% случаев, `CsvHelper.GetRecords<T>()` покрывает типизированный парсинг без буферизации, а `Sylvan.Data.Csv` плюс `System.IO.Pipelines` дают вам последний порядок величины, когда файл в диапазоне 5-50 ГБ. Худшее, что можно сделать, - вызвать `File.ReadAllLines` или `File.ReadAllText` на чём-то крупнее нескольких мегабайт, потому что оба грузят всю полезную нагрузку в `string[]`, который должен жить в Large Object Heap, пока GC не убедится, что никто к нему не прикасается.

Эта статья проходит четыре техники в порядке сложности, показывает, что каждая на самом деле аллоцирует, и подсвечивает подводные камни, которые укусят вас, когда CSV содержит многострочные поля в кавычках, BOM или должен отменяться посреди чтения. Используемые версии: .NET 11, C# 14, `CsvHelper 33.x`, `Sylvan.Data.Csv 1.4.x`.

## Почему ваш CSV-ридер аллоцирует гигабайты

CSV в 2 ГБ в UTF-8 превращается в `string` примерно в 4 ГБ в памяти, потому что строки .NET - UTF-16. `File.ReadAllLines` идёт дальше и аллоцирует ещё `string` на каждую строку плюс массив `string[]`, который их держит. На файле в 20 миллионов строк вы получаете 20 миллионов объектов в куче, верхнеуровневый массив на Large Object Heap и паузу GC второго поколения в десятки секунд, когда давление наконец заставит провести сборку. На 32-битных процессах или ограниченных контейнерах процесс просто умирает.

Решение - читать по одной записи за раз и позволить каждой записи стать пригодной для сборки мусора до того, как будет распарсена следующая. Это и есть определение стриминга, и каждая техника ниже - отдельная точка на кривой эргономика-vs-пропускная способность.

## Однострочный апгрейд: `File.ReadLines`

`File.ReadAllLines` возвращает `string[]`. `File.ReadLines` возвращает `IEnumerable<string>` и читает лениво. Замена одного на другое часто решает проблему.

```csharp
// .NET 11, C# 14
using System.Globalization;

int rowCount = 0;
decimal total = 0m;

foreach (string line in File.ReadLines("orders.csv"))
{
    if (rowCount++ == 0) continue; // header

    ReadOnlySpan<char> span = line;
    int firstComma = span.IndexOf(',');
    int secondComma = span[(firstComma + 1)..].IndexOf(',') + firstComma + 1;

    ReadOnlySpan<char> amountSlice = span[(secondComma + 1)..];
    total += decimal.Parse(amountSlice, CultureInfo.InvariantCulture);
}

Console.WriteLine($"{rowCount - 1} rows, total = {total}");
```

Аллокация в установившемся режиме здесь - одна `string` на строку плюс то, что нужно перегрузке `decimal.Parse`. Пиковый working set остаётся плоским в несколько мегабайт независимо от размера файла, потому что энумератор читает через 4 КБ буфер `StreamReader` под капотом.

Две оговорки, которые укусят, если вы полагаетесь на это для реальных данных.

Во-первых, `File.ReadLines` не знает о CSV-кавычках. Ячейка с содержимым `"first line\r\nsecond line"` становится двумя записями. Если ваши данные приходят из Excel, экспортов Salesforce или откуда угодно, где их вводят люди, вы наткнётесь на это в течение недели.

Во-вторых, энумератор открывает файл и держит хендл, пока вы не освободите энумератор или не итерируете до конца. Если вы выходите из цикла раньше, хендл освобождается при финализации энумератора, что недетерминированно. Оберните использование в явный `IEnumerator<string>` с `using`, если это важно для вашего сценария.

## Асинхронный стриминг с `StreamReader.ReadLineAsync`

Если читаете с сетевой шары, S3-бакета или откуда-то с задержками, синхронный `foreach` блокирует поток на файл. `StreamReader.ReadLineAsync` (перегружен в .NET 7+ для возврата `ValueTask<string?>`) и `IAsyncEnumerable<string>` - правильные примитивы.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var stream = new FileStream(
        path,
        new FileStreamOptions
        {
            Access = FileAccess.Read,
            Mode = FileMode.Open,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    using var reader = new StreamReader(stream);

    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Здесь установлены две релевантные для продакшна настройки. `FileOptions.SequentialScan` говорит ОС использовать агрессивный read-ahead и сбрасывать страницы после того, как вы прошли мимо них, что не даёт page cache забиваться, когда файл больше RAM. `BufferSize = 64 * 1024` в четыре раза больше дефолта и измеримо снижает количество системных вызовов на NVMe-хранилище; идти выше 64 КБ редко помогает.

Если нужно детерминированно соблюдать отмену, скомбинируйте это с `CancellationTokenSource` с таймаутом. Более длинное обсуждение того, как протянуть отмену через async-конвейер без дедлока, см. в [как отменить долго работающую Task в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Типизированный парсинг без буферизации: `GetRecords<T>()` из CsvHelper

Сырые строки годятся для тривиально устроенных данных. Для всего с nullable-колонками, разделителями в кавычках или заголовками, которые нужно сопоставить с POCO, CsvHelper - значение по умолчанию. Ключевой момент: `GetRecords<T>()` возвращает `IEnumerable<T>` и переиспользует один экземпляр записи на всю энумерацию. Если материализовать этот enumerable через `.ToList()`, вы свели на нет смысл всей библиотеки.

```csharp
// .NET 11, C# 14, CsvHelper 33.x
using System.Globalization;
using CsvHelper;
using CsvHelper.Configuration;

public sealed record Order(int Id, string Sku, decimal Amount, DateTime PlacedAt);

static async Task ProcessAsync(string path, CancellationToken ct)
{
    var config = new CsvConfiguration(CultureInfo.InvariantCulture)
    {
        HasHeaderRecord = true,
        MissingFieldFound = null,   // tolerate missing optional columns
        BadDataFound = null,        // silently skip malformed quotes; log these in prod
    };

    using var reader = new StreamReader(path);
    using var csv = new CsvReader(reader, config);

    await foreach (Order order in csv.GetRecordsAsync<Order>(ct))
    {
        // process one record; do NOT cache `order`, it is reused under synchronous mode
    }
}
```

`GetRecordsAsync<T>` возвращает `IAsyncEnumerable<T>` и внутри использует `ReadAsync`, так что медленный диск или сетевой поток не голодает thread pool. Поскольку тип - `record` с явным конструктором, CsvHelper однократно генерирует сеттеры по колонкам через рефлексию и потом переиспользует путь для каждой строки. На файле заказов в 1 ГБ с 12 колонками это парсит примерно 600 К строк в секунду на современном ноутбуке с working set, закреплённым ниже 30 МБ.

Подвох, ловящий тех, кто пришёл из `DataTable`: объект, который вы получаете внутри цикла, - это один и тот же экземпляр на каждой итерации, когда CsvHelper использует путь переиспользования. Если нужно собирать строки в нижестоящую очередь, клонируйте их явно или проецируйте на новую запись через `with`-выражения.

## Максимальная пропускная способность: Sylvan.Data.Csv и `DbDataReader`

CsvHelper удобен. Он не самый быстрый. Когда нужно прокачать 100 МБ/с через одно ядро, `Sylvan.Data.Csv` - это библиотека, отдающая `DbDataReader` поверх CSV почти без аллокаций на ячейку. Она избегает `string` на поле, выставляя `GetFieldSpan` и парся числа прямо из нижележащего буфера `char`.

```csharp
// .NET 11, C# 14, Sylvan.Data.Csv 1.4.x
using Sylvan.Data.Csv;

using var reader = CsvDataReader.Create(
    "orders.csv",
    new CsvDataReaderOptions
    {
        HasHeaders = true,
        BufferSize = 0x10000, // 64 KB
    });

int idOrd     = reader.GetOrdinal("id");
int skuOrd    = reader.GetOrdinal("sku");
int amountOrd = reader.GetOrdinal("amount");

long rows = 0;
decimal total = 0m;

while (reader.Read())
{
    rows++;
    // GetFieldSpan avoids allocating a string for fields you never need as a string
    ReadOnlySpan<char> amountSpan = reader.GetFieldSpan(amountOrd);
    total += decimal.Parse(amountSpan, provider: CultureInfo.InvariantCulture);

    // GetString only when you actually need the managed string
    string sku = reader.GetString(skuOrd);
    _ = sku;
}
```

На том же файле в 1 ГБ это даёт примерно 2,5 М строк/с и аллоцирует менее 1 МБ за весь прогон, в основном на сам буфер. Трюк - в `GetFieldSpan` плюс перегрузках вроде `decimal.Parse(ReadOnlySpan<char>, ...)`, не требующих промежуточной строки. Парсинговые примитивы .NET 11 сделаны вокруг этого паттерна, и комбинация с ридером, выставляющим спаны напрямую, полностью убирает аллокацию на ячейку.

Поскольку `CsvDataReader` наследуется от `DbDataReader`, его также можно скормить прямо в `SqlBulkCopy`, `Execute` из Dapper или `ExecuteSqlRaw` из EF Core - именно так перемещают CSV в 10 ГБ в SQL Server, не материализуя его в управляемой памяти. Если конечное состояние - база данных, парсинговый цикл часто можно пропустить целиком.

## Последние 10%: `System.IO.Pipelines` с UTF-8 парсингом

Когда узким местом становится сама конвертация UTF-16, спускайтесь к парсингу на уровне байтов через `System.IO.Pipelines`. Идея в том, чтобы оставить байты файла как UTF-8 на всём пути, нарезать буфер по `,` и `\n`, и использовать `Utf8Parser.TryParse` или `int.TryParse(ReadOnlySpan<byte>, ...)` (добавлен в .NET 7 и допилен в .NET 11) для парсинга значений без аллокаций.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Buffers.Text;
using System.IO.Pipelines;

static async Task<decimal> SumAmountsAsync(Stream source, CancellationToken ct)
{
    var reader = PipeReader.Create(source);
    decimal total = 0m;
    bool headerSkipped = false;

    while (true)
    {
        ReadResult result = await reader.ReadAsync(ct);
        ReadOnlySequence<byte> buffer = result.Buffer;

        while (TryReadLine(ref buffer, out ReadOnlySequence<byte> line))
        {
            if (!headerSkipped) { headerSkipped = true; continue; }
            total += ParseAmount(line);
        }

        reader.AdvanceTo(buffer.Start, buffer.End);

        if (result.IsCompleted) break;
    }

    await reader.CompleteAsync();
    return total;
}

static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
{
    SequencePosition? position = buffer.PositionOf((byte)'\n');
    if (position is null) { line = default; return false; }

    line = buffer.Slice(0, position.Value);
    buffer = buffer.Slice(buffer.GetPosition(1, position.Value));
    return true;
}

static decimal ParseAmount(ReadOnlySequence<byte> line)
{
    ReadOnlySpan<byte> span = line.IsSingleSegment ? line.FirstSpan : line.ToArray();
    int c1 = span.IndexOf((byte)',');
    int c2 = span[(c1 + 1)..].IndexOf((byte)',') + c1 + 1;
    ReadOnlySpan<byte> amount = span[(c2 + 1)..];

    Utf8Parser.TryParse(amount, out decimal value, out _);
    return value;
}
```

Это многословно, не обрабатывает поля в кавычках, и тянуться к нему стоит, только если вы измерили реальное узкое место. Взамен вы получаете пропускную способность в пределах 10% от того, что способно отдать нижележащее хранилище, потому что управляемый код по сути не делает ничего, кроме охоты за запятыми. Связанный приём, помогающий, когда на горячем пути небольшой набор разделителей или сигнальных байтов, - [`SearchValues<T>`, появившийся в .NET 10](/2026/01/net-10-performance-searchvalues/), векторизующий сканирование любого байта из набора.

## Подводные камни, которые укусят в продакшне

Многострочные поля в кавычках ломают любой подход на основе строк. Корректный CSV-парсер отслеживает состояние «внутри кавычек» через границы строк. `File.ReadLines`, `StreamReader.ReadLine` и самописный пример `Pipelines` выше - все ошибаются. CsvHelper и Sylvan справляются. Если пишете свой парсер ради производительности, вы заодно подписываетесь реализовать RFC 4180.

UTF-8 BOM (`0xEF 0xBB 0xBF`) появляется в начале файлов, создаваемых Excel и многими Windows-инструментами. `StreamReader` его срезает по умолчанию; `PipeReader.Create(FileStream)` - нет. Проверяйте его явно перед первым парсингом поля, иначе первое имя заголовка будет выглядеть как `\uFEFFid`, и поиск по ординалу выбросит исключение.

`File.ReadLines` и поток CsvHelper выше держат файловый хендл открытым на всё время жизни энумератора. Если нужно удалить или переименовать файл, пока вызывающий итерирует (например, наблюдаемая папка inbox), передавайте `FileShare.ReadWrite | FileShare.Delete`, открывая `FileStream` вручную.

Параллельная обработка строк CSV соблазнительна и обычно ошибочна, если только работа на строку не действительно CPU-bound. Парсинг I/O-bound, и сам парсер не thread-safe. Правильный паттерн - парсить на одном потоке и публиковать строки в `Channel<T>`, который раздаёт воркерам. [Гайд по `IAsyncEnumerable<T>` для EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) показывает тот же паттерн «один продюсер, много консьюмеров» для базы данных; форма переносится напрямую.

Если файл сжат, не распаковывайте его на диск заранее. Зацепите поток распаковки в свой парсер:

```csharp
// .NET 11, C# 14
using var file = File.OpenRead("orders.csv.zst");
using var zstd = new ZstandardStream(file, CompressionMode.Decompress);
using var reader = new StreamReader(zstd);
// feed `reader` to CsvReader or parse lines directly
```

Контекст про новую встроенную поддержку Zstandard см. в [нативной поддержке Zstandard в .NET 11](/2026/04/dotnet-11-zstandard-compression-system-io/). До .NET 11 нужен был NuGet-пакет `ZstdNet`; версия из System.IO.Compression значительно быстрее и не тянет P/Invoke-зависимость.

Отмена важнее, чем кажется. Парсинг 20 ГБ CSV - операция на несколько минут. Если вызывающий сдался, вы хотите, чтобы энумератор заметил это на следующей записи и бросил `OperationCanceledException`, а не дочитал до конца. Все async-варианты выше пробрасывают `CancellationToken`; для синхронного цикла `File.ReadLines` проверяйте `ct.ThrowIfCancellationRequested()` внутри тела цикла с разумным интервалом (каждые 1000 строк, не каждую строку).

## Выбор подходящего инструмента

Если ваш CSV меньше 100 МБ и тривиально устроен, используйте `File.ReadLines` плюс `string.Split` или нарезку через `ReadOnlySpan<char>`. Если есть кавычки, nullability или нужны типизированные записи, используйте `GetRecordsAsync<T>` из CsvHelper. Если доминирует пропускная способность и данные хорошо сформированы, используйте `CsvDataReader` из Sylvan и парсите прямо из спанов. Спускайтесь к `System.IO.Pipelines`, только если измерили конкретное узкое место в конвертации UTF-16 и есть бюджет поддерживать собственный парсер.

Общая нить во всех четырёх: никогда не буферизуйте файл целиком. В момент, когда вы вызываете `ToList`, `ReadAllLines` или `ReadAllText`, вы отказались от свойства стриминга, и ваш отпечаток памяти теперь растёт со входом. На файле в 20 ГБ в контейнере на 4 ГБ это заканчивается одним способом.

## Источники

- [File.ReadLines на MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.readlines)
- [FileStreamOptions на MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestreamoptions)
- [Документация CsvHelper](https://joshclose.github.io/CsvHelper/)
- [Sylvan.Data.Csv на GitHub](https://github.com/MarkPflug/Sylvan)
- [System.IO.Pipelines в .NET](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [Utf8Parser на MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.text.utf8parser)
