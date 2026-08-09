---
title: "Как переименовать таблицу в миграции EF Core 11 без потери данных"
description: "EF Core генерирует RenameTable, когда вы меняете имя таблицы, но DropTable плюс CreateTable, когда вы переименовываете класс сущности. Здесь разобрано, как различать эти два случая, приём с ToTable, который делает переименование класса бесплатным, и баг переименования столбцов, который молча меняет ваши данные местами."
pubDate: 2026-08-09
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data"
translatedBy: "claude"
translationDate: 2026-08-09
---

Короткий ответ: если вы меняете только *имя таблицы* через `ToTable("Clients")` и не трогаете класс сущности, EF Core генерирует корректный `migrationBuilder.RenameTable(...)`, и данные не теряются. Если вы переименовываете *класс сущности* с `Customer` на `Client`, EF Core генерирует `DropTable("Customers")` плюс `CreateTable("Clients")`, и применение такой миграции удаляет все строки. Решение в том, чтобы никогда не делать оба изменения сразу: зафиксируйте старое имя таблицы через `ToTable("Customers")` в том же коммите, который переименовывает класс, что даёт ноль изменений модели, а затем поменяйте имя таблицы отдельной миграцией.

В этой статье разобран точный вывод генератора миграций для обоих случаев, T-SQL, который каждый из них порождает, перестроение первичного ключа, которое EF Core протаскивает внутрь переименования таблицы, и три подвоха, которые срабатывают уже после того, как миграция применилась без ошибок.

Всё изложенное ниже измерено на EF Core 10.0.10 с .NET SDK 10.0.201, генерация выполнялась против генератора DDL провайдера SQL Server. EF Core 11 требует runtime .NET 11, которого на этой машине нет, поэтому запустить его там я не смог. Поведение `MigrationsModelDiffer` и API `RenameTable` не менялись между EF Core 8, 9, 10 и 11; единственный пункт, специфичный для EF Core 11, команда `dotnet ef database update --add`, отмечен ниже и взят из документации, а не измерен.

## Два переименования, которые EF Core обрабатывает совершенно по-разному

Начнём с модели, где есть `Customer`, ссылающийся на него `Order` и уникальный индекс:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public List<Order> Orders { get; set; } = new();
}

protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<Customer>().Property(c => c.Name).HasMaxLength(200);
    b.Entity<Customer>().HasIndex(c => c.Email).IsUnique();
}
```

Теперь переименуйте класс в `Client`, переименуйте свойство `DbSet<Customer> Customers` в `Clients` и дайте IDE поправить `Order.CustomerId` на `Order.ClientId`. Выполните `dotnet ef migrations add RenameCustomerToClient`, и вы получите вот это:

```csharp
// scaffolded by EF Core 10.0.10 after renaming the entity class
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");

migrationBuilder.DropTable(name: "Customers");   // <- every row, gone

migrationBuilder.RenameColumn(name: "CustomerId", table: "Orders", newName: "ClientId");
migrationBuilder.RenameIndex(name: "IX_Orders_CustomerId", table: "Orders", newName: "IX_Orders_ClientId");

migrationBuilder.CreateTable(
    name: "Clients",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false)
            .Annotation("SqlServer:Identity", "1, 1"),
        Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
        Email = table.Column<string>(type: "nvarchar(450)", nullable: false)
    },
    constraints: table => { table.PrimaryKey("PK_Clients", x => x.Id); });
```

Обратите внимание на асимметрию, потому что в ней вся суть. Таблица `Orders` сохранила имя, поэтому механизм сравнения сопоставил её с прежней версией и корректно выдал `RenameColumn` для столбца внешнего ключа. Таблица `Customers` имя *не* сохранила, поэтому механизм сравнения увидел, что одна таблица исчезла, а другая, никак не связанная, появилась, и выдал drop, а следом create.

EF Core здесь всё же предупреждает. CLI печатает строку, которую легко пролистать:

```
An operation was scaffolded that may result in the loss of data. Please review the migration for accuracy.
```

Теперь выполните второе переименование. Оставьте класс с именем `Customer` и поменяйте только имя таблицы:

```csharp
// EF Core 11, OnModelCreating
b.Entity<Customer>().ToTable("Clients");
```

Сгенерируйте миграцию, и вы получите такую, которая сохраняет все строки, причём без единого предупреждения:

```csharp
// scaffolded by EF Core 10.0.10 after ToTable("Clients")
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");
migrationBuilder.DropPrimaryKey(name: "PK_Customers", table: "Customers");

migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");

migrationBuilder.AddPrimaryKey(name: "PK_Clients", table: "Clients", column: "Id");
migrationBuilder.AddForeignKey(
    name: "FK_Orders_Clients_CustomerId", table: "Orders", column: "CustomerId",
    principalTable: "Clients", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
```

Вот такая миграция вам и нужна. Вывод в том, что EF Core вообще ничего не угадывает про переименования таблиц: он строит весь diff вокруг имени таблицы. Поменяли имя таблицы, получили переименование. Поменяли идентичность типа сущности, получили drop.

## Процедура, которая делает переименование класса бесплатным

Приём состоит в том, чтобы отделить рефакторинг C# от изменения схемы, чтобы ни один шаг никогда не был неоднозначным.

1. **Зафиксируйте текущее имя таблицы, прежде чем трогать класс.** Добавьте `ToTable` с тем именем, которое база данных уже использует, и не генерируйте ничего:

   ```csharp
   // EF Core 11 - this is a no-op against the existing schema
   b.Entity<Customer>().ToTable("Customers");
   ```

2. **Переименуйте класс, `DbSet` и навигационные свойства.** Пусть IDE сделает это по всему решению. Fluent-конфигурация превращается в `b.Entity<Client>().ToTable("Customers")`.

3. **Убедитесь, что мигрировать нечего.** Именно этот шаг доказывает, что рефакторинг был нейтрален к схеме:

   ```bash
   dotnet ef migrations has-pending-model-changes
   ```

   На EF Core 10.0.10 это печатает `No changes have been made to the model since the last migration.` Класс теперь называется `Client`, `DbSet` называется `Clients`, а база данных этого не заметила. Выкатывайте такой коммит отдельно.

4. **Поменяйте имя таблицы отдельной миграцией.** Обновите фиксацию до `b.Entity<Client>().ToTable("Clients")` и сгенерируйте миграцию. Поскольку на этот раз идентичность типа сущности стабильна, вы получите чистый `RenameTable`, показанный выше.

5. **Прочитайте сгенерированную миграцию перед применением.** Каждый раз. Убедитесь, что в методе `Up` нет ни `DropTable`, ни `DropColumn`, и что метод `Down` откатывает переименование, а не пересоздаёт таблицу.

Держать фиксацию постоянно, а не удалять её после того, как переименование доехало, стоит потому, что иначе имя таблицы по соглашению выводится из имени свойства `DbSet`. Оставьте его неявным, и следующий, кто переименует свойство ради читаемости, снова передвинет вашу таблицу.

## Что переименование на самом деле выполняет в SQL Server

`dotnet ef migrations script` для миграции с `RenameTable` даёт вот это:

```sql
-- EF Core 10.0.10, SQL Server provider
ALTER TABLE [Orders] DROP CONSTRAINT [FK_Orders_Customers_CustomerId];
ALTER TABLE [Customers] DROP CONSTRAINT [PK_Customers];
EXEC sp_rename N'[Customers]', N'Clients', 'OBJECT';
EXEC sp_rename N'[Clients].[IX_Customers_Email]', N'IX_Clients_Email', 'INDEX';
ALTER TABLE [Clients] ADD CONSTRAINT [PK_Clients] PRIMARY KEY ([Id]);
ALTER TABLE [Orders] ADD CONSTRAINT [FK_Orders_Clients_CustomerId]
    FOREIGN KEY ([CustomerId]) REFERENCES [Clients] ([Id]) ON DELETE CASCADE;
```

Само переименование таблицы затрагивает только метаданные и выполняется практически мгновенно независимо от числа строк. Дорого обходится возня с ограничениями вокруг него. EF Core удаляет первичный ключ и добавляет его обратно исключительно ради смены *имени* ограничения с `PK_Customers` на `PK_Clients`. В SQL Server первичный ключ по умолчанию кластерный, поэтому `ADD CONSTRAINT ... PRIMARY KEY` перестраивает весь кластерный индекс. На таблице с десятками миллионов строк это долгая и тяжёлая по журналу операция внутри транзакции миграции, ради косметического переименования ограничения.

`sp_rename` умеет переименовывать ограничения напрямую, так что миграцию можно поправить вручную и пропустить перестроение:

```csharp
// EF Core 11 - replace DropPrimaryKey/AddPrimaryKey on a large SQL Server table
migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Customers]', N'PK_Clients', 'OBJECT';");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Orders_Customers_CustomerId]', N'FK_Orders_Clients_CustomerId', 'OBJECT';");
```

`sp_rename` требует имя, квалифицированное схемой, когда целью является ограничение, отсюда префикс `[dbo].`. Это специфично для провайдера и расходится с тем, что снимок модели ожидает от EF Core, так что прибегайте к этому только тогда, когда перестроение действительно является проблемой. Если пойдёте этим путём, применяйте изменение через проверенный скрипт, а не при старте приложения; [подход с migration bundles](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) подходит для этого по форме.

## Переименование столбца это то место, где EF Core действительно угадывает

Документация Microsoft до сих пор утверждает, что переименование свойства порождает `DropColumn` плюс `AddColumn`. Это перестало быть правдой довольно давно. На EF Core 10.0.10 переименование `Customer.Name` в `Customer.FullName` порождает ровно то, что нужно:

```csharp
migrationBuilder.RenameColumn(name: "Name", table: "Customers", newName: "FullName");
```

Улучшение реальное, но оно опирается на эвристику, которая сопоставляет удалённые столбцы с добавленными, и эта эвристика может сопоставить их неправильно. Возьмите сущность с двумя строковыми свойствами одинаковой конфигурации, `Alpha` и `Bravo`, и переименуйте их в одной миграции в `Zulu` и `Yankee` соответственно. EF Core 10.0.10 порождает вот это:

```csharp
// WRONG: Alpha should become Zulu, Bravo should become Yankee
migrationBuilder.RenameColumn(name: "Bravo", table: "Customers", newName: "Zulu");
migrationBuilder.RenameColumn(name: "Alpha", table: "Customers", newName: "Yankee");
```

Пары перекрещены. Примените это, и данные двух столбцов молча поменяются местами в каждой строке таблицы. Ничего не удаляется, поэтому предупреждение о потере данных не печатается, миграция применяется без ошибок, а повреждение всплывает только тогда, когда на экран посмотрит человек. Я воспроизвёл это на таблице из двух столбцов без каких-либо других изменений модели.

Практическое правило: переименовывайте по одному столбцу за миграцию, когда столбцы одного типа, либо читайте сгенерированные пары `RenameColumn` и правьте их вручную. Это тот же класс тихого повреждения данных, что и [хранение enum по его целочисленному значению](/ru/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), когда схема остаётся корректной, а смысл данных под ней сдвигается.

## Три вещи, которые ломаются уже после успешной миграции

**Представления, хранимые процедуры и триггеры сохраняют старое имя.** `sp_rename` в SQL Server не отслеживает ссылки. Документация говорит об этом прямо: "Changing any part of an object name can break scripts and stored procedures." Представление, которое выбирает из `Customers`, не упадёт в момент переименования; оно упадёт, когда его в следующий раз запросят. Прежде чем генерировать миграцию, перечислите то, что зависит от таблицы:

```sql
SELECT OBJECT_NAME(referencing_id) AS referencing_object
FROM sys.sql_expression_dependencies
WHERE referenced_entity_name = 'Customers';
```

Затем добавьте операции `migrationBuilder.Sql("ALTER VIEW ...")` в ту же миграцию, чтобы переименование и зависящие от него объекты переезжали вместе.

**`dotnet ef database update --add` применяет миграцию раньше, чем вы сможете её прочитать.** EF Core 11 добавил команду в один шаг, которая генерирует миграцию, компилирует её через Roslyn и сразу применяет. Для контейнерных и Aspire-сценариев это по-настоящему полезно, и это ровно тот инструмент, который не подходит для переименования, потому что вся описанная выше процедура безопасности держится на том, чтобы сначала прочитать сгенерированный файл. Для любой миграции, которая затрагивает идентичность существующей таблицы, генерируйте и применяйте двумя отдельными командами. [Возможность миграции в один шаг](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) хороша во всех остальных случаях.

**Переименование не обратно совместимо, поэтому оно ломает поэтапные развёртывания.** Во время поэтапного развёртывания старая сборка всё ещё работает и всё ещё выполняет `SELECT ... FROM Customers`, тогда как новая ожидает `Clients`. Одна миграция, переименовывающая таблицу, кладёт старые экземпляры. Если нужен нулевой простой, переименование превращается в последовательность из нескольких развёртываний: создайте представление с именем `Customers` поверх `Clients` в той же миграции, что и переименование, разверните новую сборку, а затем удалите представление более поздней миграцией, когда ни один экземпляр уже не ссылается на старое имя.

Последняя деталь, которую стоит проверить перед коммитом: метод `Down`. EF Core генерирует корректное обратное действие для `RenameTable`, но если вы вручную переписали `Up` под `sp_rename` для ограничений, в `Down` по-прежнему останутся сгенерированные `DropPrimaryKey` и `AddPrimaryKey`, и откат окажется несимметричным. Если после этого снимок модели и база данных когда-нибудь разойдутся, при следующем старте вы встретите [исключение о незакоммиченных изменениях модели](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), а [логирование SQL, который генерирует EF Core](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), это самый быстрый способ увидеть, какое имя runtime на самом деле запрашивает.

## Связанное

- [Как применять миграции EF Core 11 в продакшене с помощью dotnet ef migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [EF Core 11 позволяет создать и применить миграцию одной командой](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Fix: модель для контекста 'X' содержит незакоммиченные изменения в EF Core 11](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Миграция с EF Core 6 на EF Core 11: ломающие изменения, которые действительно бьют](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Как логировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Источники

- [Managing migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) на Microsoft Learn, включая команду `dotnet ef database update --add`, добавленную в EF Core 11
- Справочник по API [MigrationBuilder.RenameTable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.migrations.migrationbuilder.renametable) для параметров `schema` и `newSchema`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) о переименовании ограничений и оговорках по зависимостям
- [sys.sql_expression_dependencies](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql) для поиска объектов, ссылающихся на таблицу, перед её переименованием
