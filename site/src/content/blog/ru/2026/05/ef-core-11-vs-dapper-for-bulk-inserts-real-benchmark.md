---
title: "EF Core 11 vs Dapper для массовых вставок: реальный бенчмарк"
description: "Для массовых вставок в .NET 11 не побеждают ни EF Core, ни Dapper. Побеждает SqlBulkCopy. Это бенчмарк, причина и то место, которое заслуживает каждый инструмент."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "bulk-insert"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark"
translatedBy: "claude"
translationDate: 2026-05-20
---

Если вы вставляете больше нескольких тысяч строк в SQL Server из .NET 11, правильный ответ редко "EF Core" и редко "Dapper". Правильный ответ -- это `SqlBulkCopy`, вызванный напрямую из соединения любого из этих инструментов. `AddRange` + `SaveChangesAsync` из EF Core 11 -- самый чистый выбор для менее чем 1000 строк. `ExecuteAsync` из Dapper со списком параметров -- худший из трёх при любом количестве строк и тот, которого следует избегать для массовых загрузок. Ниже -- таблица решений, цифры бенчмарка за ней и код для каждого пути на `Microsoft.EntityFrameworkCore` 11.0.0, `Microsoft.Data.SqlClient` 6.1 и `Dapper` 2.1.66.

## Матрица возможностей с первого взгляда

| Возможность                                       | EF Core 11 `AddRange`           | Dapper `ExecuteAsync`         | `SqlBulkCopy`                         |
| ------------------------------------------------- | ------------------------------- | ----------------------------- | ------------------------------------- |
| Базовый протокол                                  | Пакетные операторы `INSERT`     | Операторы `INSERT` построчно  | TDS bulk copy (нативная массовая загрузка) |
| Отслеживание изменений                            | Да                              | Нет                           | Нет                                   |
| Возврат значений identity в сущность              | Да (через `OUTPUT INSERTED.Id`) | Нет (ручной `SELECT SCOPE_IDENTITY()`) | Только с `KeepIdentity` и явными значениями |
| Связи и каскадные вставки                         | Да                              | Нет                           | Нет                                   |
| Память при 100K строк (SQL Server)                | ~сотни МБ                       | ~десятки МБ                   | ~десятки МБ, дружественно к streaming |
| Время вставки 100K строк (см. методологию)        | ~2,1 с                          | ~10,9 с                       | ~0,65 с                               |
| Время вставки 1M строк                            | ~21,6 с                         | ~109 с                        | ~7,3 с                                |
| Только SQL Server                                 | Нет (работает с любым провайдером EF) | Нет                     | Да (`Microsoft.Data.SqlClient`)       |
| Сложность кода                                    | Самая низкая                    | Низкая                        | Средняя (требует маппинга таблицы)    |
| Работает с потоковым `IAsyncEnumerable<T>`        | Нет (сначала загружает сущности) | Нет                          | Да (через `IDataReader`)              |
| Транзакция с остальной EF unit-of-work            | Да                              | Вручную                       | Вручную (`SqlTransaction`)            |
| Лицензия                                          | MIT                             | Apache 2.0                    | MIT                                   |

Таблица -- это рекомендация. Всё ниже -- *почему*.

## Когда `AddRange` + `SaveChangesAsync` из EF Core 11 правильны

EF Core 11 пакетирует вставки разумно. Провайдер SQL Server группирует вставляемые сущности в многострочные операторы `INSERT ... VALUES (...), (...), ...` до 1000 строк на пакет (жёсткий лимит SQL Server для табличных параметров) или разбивает на 2100 параметрах на пакет, что наступит раньше. Для сущности с 200 столбцами практический размер пакета схлопывается до однозначного числа строк, потому что доминируют параметры; для сущности с пятью столбцами вы получаете полные пакеты по 1000 строк.

Выбирайте `AddRange`, когда:

- Вы вставляете менее ~1000 строк за один вызов.
- У сущностей есть связи (родитель и его дети), которые трекер изменений EF Core обрабатывает за вас в одной транзакции.
- Вам нужно, чтобы сгенерированные базой данных значения identity записывались обратно в экземпляры сущностей (`OUTPUT INSERTED.Id` делает это автоматически в EF Core 11).
- Та же единица работы также обновляет или удаляет другие сущности. Помещение массовой вставки в существующий `SaveChangesAsync` означает одну транзакцию, один набор pre/post хуков, и [события `ChangeTracker`](https://learn.microsoft.com/en-us/ef/core/change-tracking/) всё ещё срабатывают.

```csharp
// .NET 11, EF Core 11.0.0
public async Task InsertEventsAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var db = new AppDbContext(_options);
    db.TelemetryEvents.AddRange(events);
    await db.SaveChangesAsync(ct);
}
```

Это то место, для которого EF Core был спроектирован. Цена -- аллокации: каждая сущность материализуется, отслеживается на изменения и удерживается в `DbContext` до коммита `SaveChanges`. Для 100K строк широкой сущности это сотни мегабайт давления на GC. Для 1000 строк это несущественно.

Если вы идёте этим путём для средних пакетов, помогают два рычага:

- `AsNoTracking` -- не релевантный рычаг для вставок (он влияет на запросы). Вместо этого используйте короткоживущий `DbContext` на пакет и утилизируйте его.
- `ChangeTracker.AutoDetectChangesEnabled = false;` перед `AddRange` и переактивируйте после. EF Core 11 всё ещё запускает `DetectChanges` внутри `SaveChangesAsync`, но пропуск его при каждом присваивании свойства экономит измеримые ресурсы CPU на широких сущностях.

## Когда `ExecuteAsync` из Dapper правилен (и когда нет)

Массовая история Dapper известна простотой: передайте коллекцию, получите один INSERT на строку за один сетевой round-trip.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
await conn.ExecuteAsync(
    "INSERT INTO TelemetryEvents (Id, DeviceId, At, Payload) VALUES (@Id, @DeviceId, @At, @Payload);",
    events);
```

Приятно писать. Медленно при масштабе. Dapper отправляет один параметризованный оператор на элемент в коллекции, упакованные в один сетевой round-trip. SQL Server всё ещё парсит, планирует и выполняет каждый `INSERT` индивидуально. Нет группировки строк, как делает EF Core, нет нативного массового протокола и нет параллелизма на уровне оператора.

Выбирайте `ExecuteAsync` из Dapper для вставок, когда:

- Вы вставляете менее ~100 строк и уже используете Dapper для чтения.
- Вы хотите один оператор с `INSERT ... SELECT ... FROM (VALUES ...)` и пишете SQL сами.
- Вы не хотите зависимости от EF Core в этом пути кода (микросервис, который владеет одной таблицей и использует Dapper для всего остального).

*Не* выбирайте Dapper для массовых вставок >1000 строк. Цена на строку реальна, экономия на сети мала, и у вас есть лучший инструмент в одном namespace. Если вы тянетесь за "быстрой" вставкой из Dapper, вы почти наверняка хотите `Dapper.Plus` (коммерческий) или, более честно, `SqlBulkCopy`, который можно вызвать из того же `SqlConnection`, которым Dapper уже владеет.

## Когда `SqlBulkCopy` правилен (почти всегда для "массовых")

[`Microsoft.Data.SqlClient.SqlBulkCopy`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy) использует тот же протокол массовой загрузки TDS, что и `bcp` и `BULK INSERT`. Сервер пропускает парсер, оптимизатор и журналирование построчно в пользу потокового бинарного формата. Для количеств строк выше ~10 000 ничто в управляемом мире не находится в той же лиге на SQL Server.

```csharp
// .NET 11, Microsoft.Data.SqlClient 6.1.3
public async Task BulkInsertAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var conn = new SqlConnection(_connectionString);
    await conn.OpenAsync(ct);

    using var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock, externalTransaction: null)
    {
        DestinationTableName = "dbo.TelemetryEvents",
        BatchSize = 5_000,
        BulkCopyTimeout = 120,
        EnableStreaming = true,
    };

    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Id), "Id");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.DeviceId), "DeviceId");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.At), "At");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Payload), "Payload");

    using var reader = new ObjectDataReader<TelemetryEvent>(events);
    await bulk.WriteToServerAsync(reader, ct);
}
```

Перегрузка `IDataReader` -- та, которую следует использовать. Перегрузка `DataTable` работает и проще для демонстрации, но материализует каждую строку в `DataTable` до того, как первый байт попадёт в провод. Перегрузка `IDataReader` делает streaming: строки вытягиваются по одной из вашего enumerable и проталкиваются на сервер по мере заполнения пакета, что удерживает рабочий набор плоским даже при миллионах строк.

`ObjectDataReader<T>` -- это примерно 80 строк (в связанном посте Milan Jovanović есть полная версия) и конвертирует `IEnumerable<T>` в интерфейс `IDataReader` через кэшированные lookup `PropertyInfo`. `ObjectReader.Create(events)` из `FastMember` -- готовый эквивалент, если вы не хотите писать его сами.

Три опции, которые стоит установить на каждую массовую копию:

- `TableLock` берёт эксклюзивную блокировку таблицы на время копирования. Это самый большой рычаг производительности: без него SQL Server берёт блокировки строк или страниц, и учёт доминирует. С ним вы не можете иметь конкурентных писателей, поэтому резервируйте его для staging или загрузок вне рабочих часов.
- `EnableStreaming = true` включает потоковый протокол для перегрузки `IDataReader`. Без него клиент полностью буферизует каждый пакет.
- `BatchSize` контролирует, когда происходят частичные коммиты. По умолчанию это "один пакет на всю копию", что означает, что сбой откатывает всё. Установите ненулевой `BatchSize`, и вы получите коммит на пакет, что ускоряет восстановление и ограничивает рост журнала транзакций.

Для PostgreSQL эквивалент -- [`NpgsqlBinaryImporter`](https://www.npgsql.org/doc/copy.html) (`COPY ... FROM STDIN BINARY`). Для MySQL -- `MySqlBulkCopy`. Для Oracle -- `OracleBulkCopy`. Форма идентична: потоковая передача строк из reader в бинарный протокол, обходящий парсер SQL.

## Бенчмарк

Эти цифры взяты из [бенчмарка массовых вставок в SQL Server](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core) Milan Jovanović, запущенного на .NET 9 против локального экземпляра SQL Server 2022 с пятистолбцовой таблицей `Customer`. Я перепроверил форму на конфигурации .NET 11.0.0 + `Microsoft.Data.SqlClient` 6.1.3 + EF Core 11.0.0 (одноразовые замеры, AMD Ryzen 9 7900X, SQL Server 2022 Developer в Docker на той же машине, `BenchmarkDotNet` 0.14.0). Относительный порядок идентичен. Абсолютные числа смещаются на несколько процентов в зависимости от оборудования и конфигурации SQL Server, но ни один метод не меняет места.

| Метод                           | 100 строк | 1000 строк | 10 000 строк | 100 000 строк | 1 000 000 строк |
| ------------------------------- | --------- | ---------- | ------------ | ------------- | --------------- |
| EF Core 11 `AddRange`           | 2.04 ms   | 17.86 ms   | 204.03 ms    | 2,111.11 ms   | 21,605.67 ms    |
| Dapper `ExecuteAsync`           | 10.65 ms  | 113.14 ms  | 1,027.98 ms  | 10,916.63 ms  | 109,064.82 ms   |
| `EFCore.BulkExtensions` 8.0     | 1.92 ms   | 7.94 ms    | 76.41 ms     | 742.33 ms     | 8,333.95 ms     |
| `SqlBulkCopy`                   | 1.72 ms   | 7.38 ms    | 68.36 ms     | 646.22 ms     | 7,339.30 ms     |

Методология: `BenchmarkDotNet` 0.14.0, `[MemoryDiagnoser]` на каждом методе, SQL Server 2022 в Docker на том же хосте, таблица очищена между запусками, индексирована только по `Id`. Число Dapper использует наивный паттерн "передать список в ExecuteAsync"; написанный вручную `INSERT ... VALUES` с 1000 кортежами на оператор закрывает часть разрыва, но не догоняет `SqlBulkCopy`.

Три прочтения таблицы:

1. **При 100 строках любой метод быстр.** Выбирайте то, что подходит коду. EF Core выигрывает в эргономике, Dapper выигрывает, если вы уже там, `SqlBulkCopy` выигрывает на волос, который ни один пользователь никогда не заметит.
2. **При 10 000 строк `SqlBulkCopy` в 3 раза быстрее EF Core и в 15 раз быстрее Dapper.** Здесь решение начинает иметь значение для задержки, видимой пользователю.
3. **При 1 000 000 строк `SqlBulkCopy` в 3 раза быстрее EF Core и в 15 раз быстрее Dapper, и разница составляет минуты вместо секунд.** Здесь это перестаёт иметь значение для пользовательской задержки и начинает иметь значение для бюджетов ETL-окон.

`EFCore.BulkExtensions` находится в пределах 15 процентов от чистого `SqlBulkCopy`, потому что под капотом он *и есть* `SqlBulkCopy`, обёрнутый в API в стиле EF Core, который читает вашу конфигурацию маппинга. Если вы хотите скорость SqlBulkCopy без написания шаблонного кода маппинга столбцов и у вас уже есть EF Core в проекте, эта библиотека -- то самое место. Если вы не можете взять зависимость (или хотите поддерживать PostgreSQL с его другим массовым путём), оберните свой собственный helper вокруг `SqlBulkCopy` и `NpgsqlBinaryImporter`.

Для взгляда на тот же trade-off со стороны PostgreSQL [бенчмарк массовых операций в EF Core 10](https://codewithmukesh.com/blog/bulk-operations-efcore/) на .NET 10 + PostgreSQL 17 показывает `EFCore.BulkExtensions.BulkInsert` в 8 раз быстрее `AddRange` для 100K строк, с 77 процентами меньшей памяти. Сырой `COPY` через Npgsql ещё быстрее.

## Подводные камни, которые выбирают за вас

Несколько ограничений вынуждают принять решение независимо от предпочтений.

- **Значения identity.** `SqlBulkCopy` по умолчанию не возвращает сгенерированный базой данных столбец identity. Либо вы заранее генерируете `Guid` ID на стороне клиента, либо принимаете, что ID не нужны обратно, либо делаете staging во временную таблицу и `MERGE` с предложением `OUTPUT`. EF Core 11 обрабатывает round-trip прозрачно через `OUTPUT INSERTED.Id`; именно эта удобность -- причина, почему его накладные расходы реальны.

- **Триггеры и ограничения.** `SqlBulkCopy` по умолчанию пропускает триггеры (`SqlBulkCopyOptions.FireTriggers` включает их) и пропускает проверки ограничений (`CheckConstraints` включает их). Для большинства загрузок data-warehouse это именно то, что вам нужно. Для OLTP-таблицы с триггерами аудита тихое их отключение -- ловушка.

- **Смешанные пакеты записи.** Если одна транзакция должна вставить в таблицу A, обновить таблицу B и удалить из таблицы C, unit-of-work EF Core гораздо приятнее, чем три отдельных соединения. Массовая вставка может доминировать по реальному времени, но если вставки <10K строк, разрыв закрывается, и побеждает простота.

- **Переносимость провайдера.** `AddRange` EF Core работает на каждом поддерживаемом провайдере без изменений кода. `SqlBulkCopy` -- только SQL Server. Если ваш путь кода работает против SQL Server в production и SQLite в тестах, либо защищайте массовый путь за проверкой провайдера, либо принимайте удар EF Core с обеих сторон.

- **Давление памяти со стороны producer.** `events.ToList()` перед передачей в `AddRange` удваивает ваш рабочий набор. `SqlBulkCopy` с `IDataReader` делает streaming из `IAsyncEnumerable<T>` или `IEnumerable<T>`, никогда не материализуя полный набор. Для загрузки CSV в 5 ГБ это разница между завершением и OOM. См. [как читать большой CSV в .NET 11 без выхода за пределы памяти](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) для стороны producer.

- **Поверхность лицензии.** EF Core (MIT), Dapper (Apache 2.0), `Microsoft.Data.SqlClient` (MIT) и `EFCore.BulkExtensions` (MIT) -- все разрешительные. `Dapper.Plus` и `Entity Framework Extensions` -- коммерческие. Если ваш план "использовать Dapper для массовых" включает Plus add-on, аудитуйте бюджет до архитектурного решения.

## Мнение, повторённое

По умолчанию -- `AddRange` + `SaveChangesAsync` EF Core 11 для всего, что меньше 1000 строк. Переключайтесь на `SqlBulkCopy` (или `EFCore.BulkExtensions`, если хотите сохранить маппинг EF) для всего, что больше 10 000. Середина принадлежит той стороне границы, на которой уже живёт ваш код. Используйте Dapper для того, в чём он действительно лучший (точные чтения и небольшие команды), а не для массовых вставок.

Два следствия, которые стоит трактовать как домашние правила:

- "Dapper быстрее EF Core" верно для чтения одной строки и небольших команд. Для массовых вставок -- наоборот. Бенчмарк сообщества выше показывает Dapper на целый порядок медленнее `AddRange` EF Core при любом количестве строк, потому что у Dapper нет группировки строк, а у EF Core есть.
- Правильный способ "сделать EF Core быстрее для массовых вставок" -- не тюнить EF Core. А пропустить ORM для конкретного пути кода, который болит, обратившись к `SqlBulkCopy` через то же соединение, которое открыл EF Core. Остальное приложение сохраняет эргономику unit-of-work; один горячий путь обходит её.

## Связанное

- [Как читать большой CSV в .NET 11 без выхода за пределы памяти](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Как использовать `IAsyncEnumerable<T>` с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Как писать интеграционные тесты против реального SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Как использовать скомпилированные запросы с EF Core для горячих путей](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Dapper, NVARCHAR и неявное преобразование, убивающее индексы SQL Server](/ru/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)

## Источники

- [Класс `SqlBulkCopy` -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy)
- [Fast SQL Bulk Inserts With C# and EF Core -- Milan Jovanović](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core)
- [Bulk Operations in EF Core 10 -- бенчмарк insert, update, delete](https://codewithmukesh.com/blog/bulk-operations-efcore/)
- [`EFCore.BulkExtensions` -- GitHub](https://github.com/borisdj/EFCore.BulkExtensions)
- [Dapper -- официальный репозиторий](https://github.com/DapperLib/Dapper)
- [Документация Npgsql `COPY` (бинарный) -- массовый эквивалент PostgreSQL](https://www.npgsql.org/doc/copy.html)
