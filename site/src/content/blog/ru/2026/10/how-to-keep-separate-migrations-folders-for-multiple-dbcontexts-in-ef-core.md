---
title: "Как держать отдельные папки миграций для нескольких DbContext в одном проекте EF Core"
description: "Передайте --output-dir один раз для каждого DbContext, и EF Core будет складывать все последующие миграции в эту папку и пространство имён. Почему раскладка по умолчанию получается перекошенной, откуда берётся CS0111 при общей папке, как перенести существующие миграции и когда стоит разделить таблицу истории."
pubDate: 2026-10-26
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "migrations"
  - "dotnet"
lang: "ru"
translationOf: "2026/10/how-to-keep-separate-migrations-folders-for-multiple-dbcontexts-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-26
---

**Короткий ответ:** создавайте первую миграцию каждого контекста со своим `--output-dir`, например `dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog`, и то же самое для `OrdersDbContext` с `Data/Migrations/Orders`. EF Core выводит пространство имён из этой папки (`Shop.Data.Migrations.Catalog`), а каждая следующая команда `migrations add` для того же контекста автоматически кладёт файлы рядом с предыдущей миграцией и снимком, так что передавать `--output-dir` снова не нужно. Не направляйте два контекста в одну папку: одноимённые миграции сольются в один partial-класс, и сборка упадёт с CS0111. Всё ниже запускалось на EF Core 10.0.14 с `dotnet-ef` 10.0.14 на .NET 10 (SDK 10.0.302) поверх SQLite. Я также сверил код скаффолдинга в ветке `release/11.0`: логика папок и пространств имён в EF Core 11 не изменилась.

## Что делает EF Core, если вы ничего не выбираете

Многие вообще не задумываются о раскладке. Они добавляют в проект второй `DbContext`, получают первую ошибку, дописывают `--context` и идут дальше. Стоит посмотреть, что из этого получается, потому что именно это объясняет большинство запутанных структур папок в реальных репозиториях.

Вот конфигурация, которая используется во всём посте: один консольный проект `Shop`, два контекста, оба смотрят на один и тот же файл SQLite.

```csharp
// .NET 10, EF Core 10.0.14
// Data/Contexts.cs
using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public class Product { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Order { public int Id { get; set; } public int ProductId { get; set; } public int Quantity { get; set; } }

public class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
}

public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

```csharp
// .NET 10, EF Core 10.0.14
// Program.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Shop.Data;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db"));
builder.Services.AddDbContext<OrdersDbContext>(o => o.UseSqlite("Data Source=shop.db"));
using var host = builder.Build();
```

Без `--context` инструмент отказывается гадать:

```text
$ dotnet ef migrations add InitialCreate
More than one DbContext was found. Specify which one to use. Use the '-Context' parameter for PowerShell commands and the '--context' parameter for dotnet commands.
```

Добавьте `--context` для каждого и позвольте EF Core выбрать папку:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext
dotnet ef migrations add InitialCreate --context OrdersDbContext
```

Результат получается перекошенным:

```text
Migrations/
  20261026120305_InitialCreate.cs              namespace Shop.Migrations        (Catalog)
  20261026120305_InitialCreate.Designer.cs
  CatalogDbContextModelSnapshot.cs
  OrdersDb/
    20261026120307_InitialCreate.cs            namespace Shop.Migrations.OrdersDb
    20261026120307_InitialCreate.Designer.cs
    OrdersDbContextModelSnapshot.cs
```

Первый контекст, получивший миграцию, занимает `Migrations/`. Второй получает вложенную папку с именем контекста без суффикса `Context`, так что `OrdersDbContext` превращается в `OrdersDb`. Это не баг, а намеренный код в `MigrationsScaffolder`: если вы не передали выходной каталог, а в пространстве имён `Migrations` по умолчанию уже есть миграции, у которых атрибут `[DbContext]` указывает на другой контекст, EF Core переключается на `<RootNamespace>.Migrations.<ContextNameWithoutSuffix>`. Контекст, имя которого не заканчивается на `Context`, получает вместо этого `<Name>Migrations`. Эта логика существует с EF Core 3.1 и остаётся в 11.

Это работает, но зависит от порядка. Клонируйте репозиторий заново, удалите миграции и выполните команды в другом порядке, и папки поменяются местами. А асимметрия (один контекст в корне, другой внутри него) создаёт впечатление, что `Migrations/` принадлежит обоим. Явный выбор стоит один флаг, один раз.

## Явная раскладка с --output-dir

Начните с чистого листа и задайте каждому контексту свою папку при первой миграции:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Data/Migrations/Orders
```

```text
Data/
  Contexts.cs
  Migrations/
    Catalog/
      20261026120357_InitialCreate.cs           namespace Shop.Data.Migrations.Catalog
      20261026120357_InitialCreate.Designer.cs
      CatalogDbContextModelSnapshot.cs
    Orders/
      20261026120359_InitialCreate.cs           namespace Shop.Data.Migrations.Orders
      20261026120359_InitialCreate.Designer.cs
      OrdersDbContextModelSnapshot.cs
```

Значение `--output-dir` отсчитывается от каталога проекта, а EF Core превращает сегменты пути в подпространство имён, так что `Data/Migrations/Catalog` становится `Shop.Data.Migrations.Catalog` (корневое пространство имён берётся из `RootNamespace` проекта). Если нужно пространство имён, не повторяющее папку, добавьте `--namespace`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext \
  --output-dir Data/Migrations/Catalog \
  --namespace Shop.Catalog.Migrations
```

В Package Manager Console в Visual Studio те же параметры называются `-Context`, `-OutputDir` и `-Namespace`:

```powershell
# EF Core 10.0.14 PMC tools
Add-Migration InitialCreate -Context CatalogDbContext -OutputDir Data\Migrations\Catalog
Add-Migration InitialCreate -Context OrdersDbContext -OutputDir Data\Migrations\Orders
```

## --output-dir нужно передать только один раз

Об этом умалчивает большинство ответов в интернете, и именно поэтому люди заводят скрипты, где `--output-dir` повторяется вечно. После первой миграции папка закрепляется. Я изменил сущность `Product` и добавил вторую миграцию вообще без выходного каталога:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add AddPrice --context CatalogDbContext
```

```text
Data/Migrations/Catalog/20261026120401_AddPrice.cs
Data/Migrations/Catalog/20261026120401_AddPrice.Designer.cs
```

Это работает благодаря двум правилам в `MigrationsScaffolder`:

1. **Пространство имён**: если выходной каталог не задан, новая миграция использует пространство имён последнего типа миграции этого контекста, а снимок использует пространство имён существующего класса снимка.
2. **Каталог**: `Save` рекурсивно ищет в каталоге проекта файл предыдущей миграции (`<PreviousMigrationId>.cs`) и записывает новые файлы в ту же папку. Снимок находится так же, по имени файла `CatalogDbContextModelSnapshot.cs`.

Значит, источник истины там, где файлы лежат сейчас. Отсюда два практических вывода. Во-первых, не нужно прописывать выходной каталог в скрипте или в `.config/dotnet-ef.json` из EF Core 11 (в котором такого ключа всё равно нет). Во-вторых, миграции можно перенести позже, и EF Core последует за ними, об этом следующий раздел.

Если вы явно передадите `--output-dir` для более поздней миграции, он применится к файлам миграции, но снимок всё равно будет записан туда, где лежит существующий файл снимка. Поэтому направить позднюю миграцию в другое место значит разделить контекст по двум папкам. Избегайте этого.

## Не используйте одну папку для нескольких контекстов

Что если передать один и тот же `--output-dir` для обоих контекстов? EF Core позволит это, с предупреждением:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Migrations
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Migrations
```

```text
The namespace 'Shop.Migrations' contains migrations for a different DbContext. This can result in conflicting migration names. It's recommend to put migrations for different DbContext classes into different namespaces.
Done. To undo this action, use 'ef migrations remove'
```

Предупреждение преуменьшает проблему. Теперь у обоих контекстов есть `partial class InitialCreate` в `Shop.Migrations`. Имена файлов различаются, потому что различаются временные метки, но C# сливает partial-объявления в один класс, и следующая сборка падает:

```text
error CS0111: Type 'InitialCreate' already defines a member called 'Up' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'Down' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'BuildTargetModel' with the same parameter types
error CS0579: Duplicate 'Migration' attribute
```

Собственная проверка EF Core на дубликаты имён (`The name 'InitialCreate' is used by an existing migration.`) смотрит только на миграции того же контекста, поэтому здесь она не поможет. Вы столкнётесь с этим при любом имени, которое случайно выберут обе команды: `InitialCreate`, `AddIndexes`, `Cleanup`. Одна папка и одно пространство имён на контекст делают коллизию невозможной.

## Перенос уже существующих миграций

Если в проекте уже перекошенная раскладка по умолчанию или всё лежит в одной папке, можно навести порядок, не трогая базу данных. EF Core находит миграции через рефлексию: любой тип, наследующий `Migration` с атрибутами `[DbContext(typeof(X))]` и `[Migration("<id>")]`, принадлежит контексту `X`. Папка и пространство имён во время выполнения не важны, а идентификатор миграции в таблице истории не меняется.

Шаги для каждого контекста:

1. Переместите файлы миграций контекста (`<id>_<Name>.cs` и `<id>_<Name>.Designer.cs`) и его `<Context>ModelSnapshot.cs` в новую папку. В простом файле `.cs` нет атрибута `[DbContext]`, поэтому ориентируйтесь на идентификатор миграции, а не на поиск по имени контекста, иначе половина каждой миграции останется на месте.
2. Измените строку `namespace` в каждом перенесённом файле, включая снимок, на новое пространство имён.
3. Соберите проект, затем выполните `dotnet ef migrations list --context <Context>` и убедитесь, что те же идентификаторы на месте.
4. Добавьте следующую миграцию без `--output-dir` и проверьте, что она попала в новую папку.

Именно так я поступил с описанным выше сломанным проектом с общей папкой: перенёс три файла `OrdersDbContext` в `Migrations/Orders`, заменил `namespace Shop.Migrations` на `namespace Shop.Migrations.Orders`, и сборка прошла. `migrations list --context OrdersDbContext` по-прежнему показывал `20261026120430_InitialCreate`, а новая миграция `AddPlacedAt` попала в `Migrations/Orders` с пространством имён `Shop.Migrations.Orders` без каких-либо дополнительных флагов.

Делайте перенос одним коммитом без других изменений, чтобы дифф состоял только из переименований и правок одной строки с пространством имён. Ревью кода становится тривиальным, а `git log --follow` продолжает работать.

## Общая таблица __EFMigrationsHistory

Папки касаются только исходного кода. В базе данных оба контекста по умолчанию пишут в одну и ту же таблицу истории, потому что имя таблицы не зависит от контекста. После применения обоих:

```bash
# dotnet-ef 10.0.14
dotnet ef database update --context CatalogDbContext
dotnet ef database update --context OrdersDbContext
```

```text
sqlite> select * from __EFMigrationsHistory;
20261026120357_InitialCreate|10.0.14
20261026120401_AddPrice|10.0.14
20261026120359_InitialCreate|10.0.14
```

Столбца с контекстом нет. Каждый контекст читает все строки и учитывает только те идентификаторы, которые совпадают с его собственными миграциями, поэтому в большинстве случаев всё работает нормально. Формат идентификатора `yyyyMMddHHmmss_Name` имеет разрешение в одну секунду, так что два контекста конфликтуют, только если кто-то создаст миграцию с одним и тем же именем для обоих в одну и ту же секунду, а скрипт, который обходит контексты в цикле, на это способен.

Если нужно разделить историю, например потому, что контексты отображаются на разные схемы или принадлежат разным командам, настройте таблицу для каждого контекста:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db",
    sql => sql.MigrationsHistoryTable("__CatalogMigrationsHistory")));
```

`MigrationsHistoryTable` также принимает схему у провайдеров, которые поддерживают схемы, таких как SQL Server: `sql.MigrationsHistoryTable("__EFMigrationsHistory", "catalog")`.

Вот ловушка: сделать это в базе данных, где миграции уже применены. Новая таблица пуста, поэтому EF Core считает, что ничего не выполнялось, и повторно запускает `InitialCreate`:

```text
$ dotnet ef database update --context CatalogDbContext
SQLite Error 1: 'table "Products" already exists'.
```

Перед обновлением скопируйте строки контекста в новую таблицу. В SQLite:

```sql
-- SQLite, run once per database before deploying the history table change
CREATE TABLE "__CatalogMigrationsHistory" (
    "MigrationId" TEXT NOT NULL CONSTRAINT "PK___CatalogMigrationsHistory" PRIMARY KEY,
    "ProductVersion" TEXT NOT NULL);

INSERT INTO "__CatalogMigrationsHistory"
SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');

DELETE FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');
```

После этого `database update --context CatalogDbContext` ничего не делает, а `migrations list` показывает обе миграции как применённые. Для новой базы данных ничего особенного не нужно: сгенерированный скрипт начинается с `CREATE TABLE IF NOT EXISTS "__CatalogMigrationsHistory"`. Если вы разворачиваете идемпотентным скриптом или пакетом миграций (migration bundle), выполните копирование до него, в каждой среде.

## Когда оба контекста отображаются на одну таблицу

Отдельные папки не мешают двум контекстам генерировать DDL для одной и той же таблицы. Допустим, `OrdersDbContext` нужен доступ на чтение к продуктам, и вы добавляете в него `public DbSet<Product> Products => Set<Product>();`. Следующая миграция для `OrdersDbContext` содержит `CreateTable(name: "Products", ...)`, которая упадёт при развёртывании, потому что `CatalogDbContext` уже создал эту таблицу.

Выберите одного владельца и исключите таблицу из миграций другого контекста:

```csharp
// .NET 10, EF Core 10.0.14
public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.Entity<Product>()
            .ToTable("Products", t => t.ExcludeFromMigrations());
}
```

После этого та же команда `migrations add` дала пустой метод `Up`. Сущность по-прежнему входит в модель, поэтому запросы и отслеживание изменений работают; таблицу игнорируют только миграции. Помните, что изменение схемы `Product` теперь нужно проводить через `CatalogDbContext`, а `OrdersDbContext` подхватит его через общий класс сущности.

## Другие команды тоже требуют --context

Каждая команда миграций работает с одним контекстом, поэтому когда их два, `--context` обязателен для всех, а не только для `add`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations list   --context OrdersDbContext
dotnet ef migrations remove --context OrdersDbContext
dotnet ef migrations script --context OrdersDbContext --idempotent -o orders.sql
dotnet ef migrations bundle --context OrdersDbContext -o efbundle-orders
dotnet ef database update   --context OrdersDbContext
```

`migrations remove` удаляет файлы последней миграции там, где они лежат (ищет в проекте по имени файла), и перезаписывает снимок в его текущей папке, так что и она учитывает вашу раскладку. Во время выполнения вызывайте `Database.MigrateAsync()` по одному разу для каждого контекста, в порядке, который нужен вашей схеме (сначала владелец общих таблиц).

Если надоело набирать `--context`, EF Core 11 умеет читать контекст по умолчанию из `.config/dotnet-ef.json`. Флаги по-прежнему имеют приоритет, так что задайте контекст, с которым вы работаете чаще всего, а для другого передавайте `--context`.

## Отдельный проект миграций для каждого контекста

Для большинства приложений достаточно папок внутри одного проекта. Если контексты развёртываются отдельно или одна команда не должна иметь возможность трогать миграции другой, вынесите миграции каждого контекста в собственную библиотеку классов и укажите EF Core, где их искать:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlServer(catalogConnection,
    sql => sql.MigrationsAssembly("Shop.Migrations.Catalog")));
```

Затем запускайте `dotnet ef migrations add` с `--project Shop.Migrations.Catalog --startup-project Shop --context CatalogDbContext`. Платой становится ещё один проект на контекст и ссылка из стартового проекта на каждый проект миграций, из-за чего они загружаются во время выполнения. Подключение подробно описано в [официальном руководстве по отдельному проекту миграций](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects).

## Связанные материалы

- [Fix: The model for context has pending changes in EF Core 11](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), эта ошибка проявляется и тогда, когда вы добавляете миграцию не для того контекста.
- [Stop retyping --project and --startup-project with .config/dotnet-ef.json](/ru/2026/06/efcore-11-dotnet-ef-json-config-file/) в EF Core 11.
- [How to apply EF Core 11 migrations in production with migration bundles](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), по одному пакету на контекст.
- [Fix: There is already an object named 'X' in the database after resetting migrations](/ru/2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations/), та же механика таблицы истории с другой стороны.
- [Fix: dotnet ef migrations add "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) на случай, когда инструменты времени разработки не могут собрать ни один из контекстов.

## Источники

- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), Microsoft Learn: `--context`, `--output-dir`, `--namespace`.
- [Using a Separate Migrations Project](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Entity types: excluding from migrations](https://learn.microsoft.com/en-us/ef/core/modeling/entity-types#excluding-from-migrations), Microsoft Learn.
- [`MigrationsScaffolder.cs` on release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Migrations/Design/MigrationsScaffolder.cs), описанные выше определение пространства имён по умолчанию, проверка чужих миграций и повторное использование каталога.
