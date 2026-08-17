---
title: "Как генерировать первичный ключ из последовательности базы данных при вставке в EF Core 11"
description: "Переводим ключ с IDENTITY на последовательность SQL Server в EF Core 11 через UseSequence: точный SQL, который выдаёт EF, почему явные значения ключа вдруг работают без IDENTITY_INSERT, последовательность bigint для колонки int и пропуски, которые нужно закладывать в проект."
pubDate: 2026-08-17
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "primary-keys"
  - "migrations"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-17
---

Короткий ответ: вызовите `UseSequence` на свойстве ключа. EF Core переводит свойство в `ValueGenerated.OnAdd`, добавляет колонке ограничение `DEFAULT (NEXT VALUE FOR [schema].[SequenceName])` в миграции и читает сгенерированное значение обратно через предложение `OUTPUT` во вставке. Это стоит ровно столько же обращений к серверу, сколько и `IDENTITY`, пакетируется точно так же и позволяет вставлять явные значения ключа без `SET IDENTITY_INSERT`. Кусаются здесь две вещи: тип последовательности (EF создаёт последовательность `bigint`, если вы не объявите её сами) и пропуски, которые SQL Server документирует как неизбежные.

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Order>()
    .Property(o => o.Id)
    .UseSequence("OrderNumbers", "shared");
```

SQL в этой статье снят с собственного `ICommandBatchPreparer` EF Core и с `GenerateCreateScript()` на **EF Core 10.0.11 поверх .NET SDK 10.0.201**, поскольку EF Core 11 требует среду выполнения .NET 11, которой на этой машине нет. Здесь это менее существенно, чем обычно: в [заметках о выпуске EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) вообще нет записей о последовательностях или о генерации значений ключа, а `SqlServerPropertyBuilderExtensions.UseSequence` в ветке `main` не менялся. Каждая инструкция ниже - реальный вывод EF, а не перепечатанный мной текст. Поведение, которое требует работающего сервера для наблюдения (пропуски при откате, потеря кеша), приводится со ссылкой на документацию SQL Server и помечено соответствующим образом.

## Зачем уводить ключ с IDENTITY

`IDENTITY` - значение по умолчанию в SQL Server, и для большинства таблиц оно вполне годится. Уйти от него заставляют три ситуации:

- **Двум таблицам нужно черпать из одного пространства номеров.** Заказы и счета, которые никогда не должны делить номер документа, не могут иметь каждый свой `IDENTITY`. Последовательность не привязана к таблице, поэтому тянуть из неё могут обе.
- **Значение нужно до вставки.** `NEXT VALUE FOR` можно вызвать отдельно, поэтому вы можете зарезервировать ключ, построить вокруг него документ и вставить позже. `IDENTITY` выдаёт значение только как побочный эффект вставки.
- **Вы импортируете строки с уже назначенными ключами.** С `IDENTITY` каждая такая вставка требует обрамления `SET IDENTITY_INSERT dbo.Orders ON` - переключателя в области соединения и по одной таблице за раз, которым EF за вас не управляет. С последовательностью колонка обычная, со значением по умолчанию, поэтому явное значение просто проходит.

## Версия в две строки

Объявите последовательность, затем направьте на неё ключ:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.HasSequence<int>("DocumentNumbers", schema: "shared")
        .StartsAt(1000)
        .IncrementsBy(1);

    modelBuilder.Entity<Order>()
        .Property(o => o.Id)
        .UseSequence("DocumentNumbers", "shared");

    modelBuilder.Entity<Invoice>()
        .Property(i => i.Id)
        .UseSequence("DocumentNumbers", "shared");
}
```

`UseSequence` задаёт на свойстве три вещи: стратегию генерации значений `SqlServerValueGenerationStrategy.Sequence`, имя и схему последовательности, а также `ValueGenerated.OnAdd`. Кроме того, он сбрасывает ранее заданную конфигурацию hi-lo или начального значения identity. Дамп модели это подтверждает:

```text
Order.Id:   ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
Invoice.Id: ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
```

Обратите внимание, что `DefaultValueSql` заполнил за вас EF. Эту строку вы не писали и не должны писать сами, когда используете `UseSequence`.

## Что порождает миграция

`dotnet ef migrations add Initial` даёт вызов `CreateSequence` плюс `defaultValueSql` на колонке:

```csharp
// .NET 11, EF Core 11 migration output
migrationBuilder.EnsureSchema(name: "shared");

migrationBuilder.CreateSequence<int>(
    name: "DocumentNumbers",
    schema: "shared",
    startValue: 1000L);

migrationBuilder.CreateTable(
    name: "Orders",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false,
            defaultValueSql: "NEXT VALUE FOR [shared].[DocumentNumbers]"),
        Name = table.Column<string>(type: "nvarchar(max)", nullable: false)
    },
    constraints: table =>
    {
        table.PrimaryKey("PK_Orders", x => x.Id);
    });
```

В базе данных это выглядит так:

```sql
-- SQL Server, generated by EF Core
CREATE SEQUENCE [shared].[DocumentNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Orders] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [shared].[DocumentNumbers]),
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Никакого `IDENTITY` на колонке нет. Это обычный `int` с ограничением значения по умолчанию.

## Какой INSERT EF отправляет на самом деле

Именно здесь люди ошибаются, когда рассуждают из общих соображений. Ключ на последовательности **не** стоит дополнительного обращения к серверу. EF опускает колонку во вставке, даёт сработать значению по умолчанию и читает значение обратно в той же инструкции:

```sql
-- one Order, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Добавьте три заказа за один `SaveChangesAsync`, и EF использует ту же форму `MERGE ... OUTPUT`, что и для `IDENTITY`, чтобы возвращённые ключи можно было сопоставить с отслеживаемыми сущностями по позиции:

```sql
-- three Orders in one batch, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
MERGE [Orders] USING (
VALUES (@p0, 0),
(@p1, 1),
(@p2, 2)) AS i ([Name], _Position) ON 1=0
WHEN NOT MATCHED THEN
INSERT ([Name])
VALUES (i.[Name])
OUTPUT INSERTED.[Id], i._Position;
```

Байт в байт то же самое порождает и ключ `IDENTITY`. Переход на последовательность ничего не меняет в стратегии пакетирования EF, так что если вы опасались `SELECT NEXT VALUE FOR` на каждую строку - не стоит. Такое бывает только с `UseHiLo`, а это другая стратегия (о ней ниже). Если хотите увидеть это на своей модели, [журналирование SQL, который генерирует EF Core](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) занимает примерно четыре строки конфигурации.

## Явные значения ключа - главная причина перехода

Задайте ключ сами, и EF заметит, что свойство больше не равно значению CLR по умолчанию, включит колонку во вставку и уберёт предложение `OUTPUT`:

```csharp
// .NET 11, C# 14, EF Core 11
db.Orders.Add(new Order { Id = 5000, Name = "imported" });
await db.SaveChangesAsync();
```

```sql
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p0, @p1);
```

Ключ `IDENTITY` порождает *идентичную* инструкцию, и SQL Server отклоняет её с сообщением `Cannot insert explicit value for identity column in table 'Orders' when IDENTITY_INSERT is set to OFF`, если вы сами не переключите `IDENTITY_INSERT` вокруг вызова. Для колонки на последовательности переключать нечего: у колонки есть значение по умолчанию, и переданное значение просто его перекрывает. В этом и состоит практическая разница, поэтому код импорта и миграции данных после перехода заметно укорачивается.

Две оговорки:

**Ноль не является явным значением.** EF решает, что "пользователь задал ключ", сравнивая со значением CLR по умолчанию. `new Order { Id = 0 }` неотличим от `new Order { }`, поэтому срабатывает последовательность:

```sql
-- Order { Id = 0, Name = "zero" }
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Если ноль в ваших данных - законный ключ, сделайте свойство в модели допускающим null или используйте значение, отличное от значения CLR по умолчанию.

**Смешивание двух вариантов разрывает пакет.** Добавьте одну сущность с явным ключом и одну без него, и EF выдаст две отдельные инструкции вместо одного `MERGE`, причём сгенерированную строку первой:

```sql
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p1, @p2);
```

Обращение к серверу по-прежнему одно, но выигрыш от пакетирования потерян. При массовом импорте держите вставки с явными ключами в отдельном вызове `SaveChanges`. Если весь вопрос в пропускной способности, перед дальнейшей настройкой стоит посмотреть цифры из [EF Core 11 против Dapper на массовых вставках](/ru/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Последовательность bigint для колонки int

Вот острый край. `UseSequence` спокойно назовёт последовательность, которую вы никогда не объявляли, и EF создаст её за вас с типом SQL Server по умолчанию, то есть `bigint`:

```csharp
// no HasSequence call anywhere in the model
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Docs] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [OrderNumbers]),
    ...
);
```

Никакого `AS int`. [Документация CREATE SEQUENCE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) говорит прямо: "If no data type is provided, the bigint data type is used as the default." Последовательность `bigint`, питающая колонку `int`, прекрасно работает первые 2 147 483 647 значений, а затем начинает выдавать колонке числа, которые она не может хранить. Для большинства таблиц это очень далеко, но всё это время конфигурация остаётся молча ошибочной, и ни один тест её не покажет.

Объявите последовательность с нужным типом, и расхождение исчезнет:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;
```

Практическое правило: никогда не позволяйте `UseSequence` создавать последовательность неявно. Всегда сочетайте его с `HasSequence<T>`, который называет ту же последовательность.

## Именование и одна неверная строка в документации

Вызовите `UseSequence()` без аргументов, и EF назовёт последовательность за вас:

```csharp
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence] ...
```

XML-документация параметра `nameSuffix` утверждает, что это "the name that will suffix the table name". Это не так. Переименуйте таблицу, и имя последовательности не сдвинется:

```csharp
modelBuilder.Entity<Doc>().ToTable("ArchivedDocuments");
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence]
// -> CREATE TABLE [ArchivedDocuments] ([Id] int NOT NULL DEFAULT (NEXT VALUE FOR [DocSequence]), ...)
```

Имя берётся из короткого имени CLR-типа сущности плюс суффикс, который по умолчанию равен `"Sequence"`. Переименуйте класс, и имя вашей последовательности изменится незаметно, а это ровно тот случай, который порождает в миграции неожиданную пару `DropSequence` плюс `CreateSequence`. Именуйте последовательности явно.

Есть и переключатель на уровне модели, дающий каждому ключу свою последовательность:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.UseKeySequences();
// -> CREATE SEQUENCE [DocSequence] ...
// -> CREATE SEQUENCE [NoteSequence] ...
// -> [Docs].[Id]  int    DEFAULT (NEXT VALUE FOR [DocSequence])
// -> [Notes].[Id] bigint DEFAULT (NEXT VALUE FOR [NoteSequence])
```

Та же оговорка про `bigint` действует для каждой создаваемой им последовательности.

## UseSequence против HasDefaultValueSql

[Документация EF Core по последовательностям](https://learn.microsoft.com/en-us/ef/core/modeling/sequences) показывает более старый подход - писать выражение по умолчанию вручную:

```csharp
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>()
    .Property(d => d.Id)
    .HasDefaultValueSql("NEXT VALUE FOR OrderNumbers");
```

SQL вставки байт в байт совпадает с вариантом `UseSequence`. Различия лежат в модели:

| | `UseSequence` | `HasDefaultValueSql` |
| --- | --- | --- |
| `ValueGenerated` | `OnAdd` | `OnAdd` |
| Стратегия | `Sequence` | `None` |
| SQL по умолчанию | генерирует EF, с разделителями | ваш, выводится дословно |
| Переименование последовательности | обновить один вызов `HasSequence` | обновить ещё и строку, во всех местах |

Строка "выводится дословно" важна. Ваша строка попадает в DDL ровно так, как набрана, без разделителей:

```sql
[Id] int NOT NULL DEFAULT (NEXT VALUE FOR OrderNumbers)
```

Это ломается в тот момент, когда последовательность оказывается в схеме с именем, требующим разделителей, или кто-то добавит пробел. `UseSequence` порождает `NEXT VALUE FOR [shared].[DocumentNumbers]` с уже расставленными скобками. Для ключей предпочитайте `UseSequence`. Оставьте `HasDefaultValueSql` для колонок, не являющихся ключом, которые `UseSequence` не поддерживает.

## Колонки, не являющиеся ключом: номера заказов и счетов

Распространённый вариант - суррогатный ключ `IDENTITY` плюс видимый человеку номер из последовательности. Здесь `HasDefaultValueSql` - правильный инструмент:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("TicketNumbers").StartsAt(500).IncrementsBy(10);

modelBuilder.Entity<Ticket>()
    .Property(t => t.TicketNumber)
    .HasDefaultValueSql("NEXT VALUE FOR TicketNumbers");
```

EF добавляет колонку в список `OUTPUT`, когда вы её не задаёте, и переносит её в список колонок, когда задаёте:

```sql
-- new Ticket { Name = "t1" }
INSERT INTO [Tickets] ([Name])
OUTPUT INSERTED.[Id], INSERTED.[TicketNumber]
VALUES (@p0);

-- new Ticket { Name = "t2", TicketNumber = 42 }
INSERT INTO [Tickets] ([Name], [TicketNumber])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1);
```

То же правило значения CLR по умолчанию: `TicketNumber = 0` читается как незаданное.

## Пропуски гарантированы, проектируйте с их учётом

Если какая-то часть вашей системы считает ключ счётчиком без пропусков, последовательность это сломает, и `IDENTITY` сломал бы точно так же. [Документация CREATE SEQUENCE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) говорит без обиняков: "Sequence numbers are generated outside the scope of the current transaction. They're consumed whether the transaction using the sequence number is committed or rolled back."

Есть и второй источник пропусков. Последовательности по умолчанию идут с `CACHE`, и SQL Server заранее выделяет блок значений в памяти, сохраняя на диск только границу блока. По той же документации, "an unexpected shutdown (such as a power failure) might result in the loss of sequence numbers remaining in the cache." Сбой, таким образом, может сжечь целый блок кеша.

`NO CACHE` сужает окно ценой записи в системную таблицу на каждое значение, и даже тогда документация отмечает: "gaps can still occur if numbers are requested using the NEXT VALUE FOR or sp_sequence_get_range functions, but then the numbers are either not used or are used in uncommitted transactions."

Свободный API EF этого выразить не может. `SequenceBuilder` предоставляет `StartsAt`, `IncrementsBy`, `HasMin`, `HasMax` и `IsCyclic`, и больше ничего. Придётся взять сырой SQL в миграции:

```csharp
// .NET 11, EF Core 11
migrationBuilder.Sql("ALTER SEQUENCE [shared].[DocumentNumbers] NO CACHE;");
```

Делайте так только там, где этого требует регулятор, а не по умолчанию. Если вам нужен по-настоящему непрерывный номер юридического документа, генерируйте его в отдельной транзакционной таблице, а не из последовательности.

## UseSequence против UseHiLo

`UseHiLo` - вторая стратегия на основе последовательностей, и ведёт она себя совершенно иначе:

```csharp
modelBuilder.Entity<HiLoOrder>().Property(h => h.Id).UseHiLo("HiLoOrderSequence");
// -> CREATE SEQUENCE [HiLoOrderSequence] START WITH 1 INCREMENT BY 10 NO CYCLE;
// -> [HiLoOrders].[Id] int NOT NULL   (no default constraint)
```

Колонка не получает значения по умолчанию. EF один раз обращается к последовательности, чтобы зарезервировать блок из десяти значений, а затем раздаёт ключи из этого блока на клиенте. Значит, ключи известны ещё до вставки (полезно, когда вы строите граф объектов в памяти), ценой отдельного обращения к серверу при исчерпании каждого блока и куда более крупных пропусков всякий раз, когда `DbContext` освобождается посреди блока. `UseSequence` оставляет генерацию на сервере, `UseHiLo` переносит её на клиент. Выбирайте `UseSequence`, если вам специально не нужен ключ на руках до `SaveChanges`.

## Перевод существующей таблицы с IDENTITY

`ALTER TABLE ... ALTER COLUMN` не может ни добавить, ни удалить свойство `IDENTITY`. [Документированное ограничение](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) позволяет только сменить тип существующей identity-колонки на другой тип, поддерживающий свойство identity. Миграции на месте, таким образом, не существует; колонку придётся заменить. Шаги:

1. Считайте текущую верхнюю границу запросом `SELECT ISNULL(MAX(Id), 0) FROM dbo.Orders` и добавьте запас на строки, вставленные между чтением и переключением.
2. Добавьте `modelBuilder.HasSequence<int>("DocumentNumbers", "shared").StartsAt(<high-water mark + margin>)` и `UseSequence("DocumentNumbers", "shared")` на ключе, затем сгенерируйте миграцию.
3. Замените сгенерированное тело на SQL, который создаёт последовательность, строит новую таблицу, где у `Id` стоит значение по умолчанию из последовательности, переносит строки через `INSERT INTO ... SELECT`, удаляет старую таблицу и переименовывает новую. Внешние ключи, указывающие на таблицу, придётся удалить и создать заново вокруг подмены.
4. Выполните миграцию внутри транзакции и проверьте после этого, что `SELECT current_value FROM sys.sequences WHERE name = 'DocumentNumbers'` выше самого большого существующего ключа.

Две детали, которые стоит знать. Заполнение через `HasData` в эту модель не укладывается, потому что EF требует литеральных значений ключа в данных заполнения и не даёт неявно заполнить ключ, генерируемый хранилищем; отсюда и берётся [сущность заполнения не может быть добавлена, так как требуется ненулевое значение](/ru/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/). С последовательностью вы можете просто передать ключи, поскольку явные значения допустимы. И если вы всё равно пишете вручную правленый SQL миграции для подмены таблиц, действует та же осторожность, что и при [переименовании таблицы в миграции EF Core 11 без потери данных](/ru/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/): сгенерированный вывод для структурных изменений - это отправная точка, а не ответ.

Последнее, что стоит проверить после всего этого: запустите `dotnet ef migrations add` ещё раз и убедитесь, что получается пустая миграция. Последовательность, тип которой в модели не совпадает с типом в базе данных, или неявно названная последовательность, которая переехала при переименовании класса, всплывает призрачной парой `DropSequence` плюс `CreateSequence` при каждой генерации. Колонки `rowversion` дают такой же класс призрачных расхождений по той же причине, а разбор в [оптимистичном параллелизме с токеном rowversion в EF Core 11](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) показывает, как читать аннотации, а не DDL, когда вы такое отслеживаете.

## Источники

- [Последовательности, документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/sequences)
- [Генерация значений в SQL Server, документация EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/value-generation)
- [CREATE SEQUENCE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql)
- [ALTER TABLE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql)
- [Что нового в EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Исходный код `SqlServerPropertyBuilderExtensions.UseSequence`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerPropertyBuilderExtensions.cs)
- [Исходный код `SqlServerModelBuilderExtensions.UseKeySequences`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerModelBuilderExtensions.cs)
