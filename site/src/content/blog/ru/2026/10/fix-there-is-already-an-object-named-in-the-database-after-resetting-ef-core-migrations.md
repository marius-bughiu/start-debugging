---
title: "Исправление: There is already an object named 'X' in the database после сброса миграций EF Core"
description: "После удаления папки Migrations и создания нового InitialCreate EF Core не знает, что ваши таблицы уже существуют. Удалите базу данных для разработки или запишите новую миграцию в __EFMigrationsHistory, не выполняя её."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "dotnet"
lang: "ru"
translationOf: "2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-10-06
---

Вы удалили папку `Migrations`, выполнили `dotnet ef migrations add InitialCreate`, и теперь `dotnet ef database update` падает с `There is already an object named 'Blogs' in the database`. EF Core решает, что выполнять, сравнивая идентификаторы миграций в вашей сборке со строками в `__EFMigrationsHistory`. У нового `InitialCreate` новая метка времени, поэтому EF Core считает его ожидающим и пытается выполнить `CREATE TABLE` для таблиц, которые уже существуют. Если базу данных не жалко, удалите её (`dotnet ef database drop --force`) и обновите заново. Если в ней есть данные, удалите старые строки истории и вставьте одну строку с новым идентификатором миграции, чтобы EF Core считал её применённой, не выполняя её. Всё описанное ниже измерено на EF Core 10.0.12 с `dotnet-ef` 10.0.12 на .NET 10 (SDK 10.0.302); в EF Core 11.0.0-rc.1 логика не изменилась.

## Ошибка в контексте

В SQL Server это ошибка движка 2714, которая приходит как `SqlException` из `dotnet ef database update` или из `Database.Migrate()` при запуске. Экземпляра SQL Server для этой статьи не было, поэтому блок ниже представляет собой запуск на SQLite, в котором DDL и сообщение движка заменены на варианты SQL Server:

```text
Applying migration '20261006110224_InitialCreate'.
Failed executing DbCommand (12ms) [Parameters=[], CommandType='Text', CommandTimeout='30']
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
Microsoft.Data.SqlClient.SqlException (0x80131904): There is already an object named 'Blogs' in the database.
```

Та же первопричина у других провайдеров выглядит иначе. Строка SQLite скопирована из воспроизведения для этой статьи; строки PostgreSQL и MySQL это ошибки движка для той же инструкции `CREATE TABLE`:

```text
SQLite:      SQLite Error 1: 'table "Blogs" already exists'.
PostgreSQL:  42P07: relation "Blogs" already exists
MySQL:       Table 'Blogs' already exists        (error 1050)
SQL Server:  There is already an object named 'Blogs' in the database.   (error 2714)
```

Ключевая строка первая: `Applying migration '..._InitialCreate'`. Если EF Core применяет вашу начальную миграцию к базе данных, в которой уже есть ваша схема, вы на нужной странице.

## Почему EF Core пытается создать уже существующие таблицы

EF Core не анализирует вашу схему, чтобы решить, какие миграции запускать. Он выполняет один запрос, `SELECT MigrationId FROM __EFMigrationsHistory`, и сравнивает результат с миграциями, скомпилированными в сборку. Любая миграция, идентификатора которой нет в таблице, считается ожидающей, а ожидающие миграции выполняют метод `Up()` целиком.

Идентификатор миграции это префикс имени файла: метка времени UTC плюс введённое вами имя, например `20261006110224_InitialCreate`. При сбросе миграций новый `InitialCreate` получает свежую метку времени. Старые строки (`20261006110219_InitialCreate`, `20261006110221_AddPublished`) остаются в таблице истории, но EF Core молча игнорирует строки, которые не соответствуют ни одной миграции в сборке. Никакого предупреждения он не выдаёт. Поэтому с точки зрения EF Core база данных никогда не видела вашу новую миграцию, и первый же `CreateTable` натыкается на уже существующую таблицу.

То же расхождение возникает в нескольких ситуациях, которые не являются намеренным сбросом:

1. **База данных создана через `EnsureCreated()`**. `EnsureCreated()` строит схему прямо из модели и никогда не создаёт `__EFMigrationsHistory`. Первый `Migrate()` создаёт пустую таблицу истории, считает все миграции ожидающими и падает на первой таблице.
2. **База данных пришла из другого места**: восстановленная резервная копия другого приложения, схема DB-first, скрипт, выполненный DBA. Картина та же: таблицы есть, истории нет.
3. **Таблица истории переехала**. `MigrationsHistoryTable("__MyHistory", "app")` добавили или изменили после развёртывания, либо в SQL Server подключается другой логин, у которого схема по умолчанию не `dbo`. EF Core ищет в новом месте, ничего не находит и начинает с нуля.
4. **Две миграции создают одну и ту же таблицу**. В двух ветках добавили по миграции, создающей `AuditLog`, и обе слили. Первая проходит, вторая выбрасывает 2714.

## Минимальное воспроизведение на EF Core 10

Вот точная последовательность, которую я выполнил, на SQLite, чтобы её можно было повторить на любой машине:

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Post { public int Id { get; set; } public string Title { get; set; } = ""; public int BlogId { get; set; } }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=app.db");
}
```

```bash
# dotnet-ef 10.0.12
dotnet ef migrations add InitialCreate
# add a DateTime Published property to Post
dotnet ef migrations add AddPublished
dotnet ef database update            # applies both, history has 2 rows

rm -rf Migrations                    # the "reset"
dotnet ef migrations add InitialCreate
dotnet ef database update            # SQLite Error 1: 'table "Blogs" already exists'.
```

После сбоя `dotnet ef migrations list` показывает, что именно думает EF Core:

```text
20261006110224_InitialCreate (Pending)
```

Две старые строки по-прежнему лежат в таблице истории. Кроме того, EF Core 10 оборачивает каждую миграцию в собственную транзакцию, поэтому на SQLite и SQL Server упавший `InitialCreate` чисто откатывается и ничего не остаётся применённым наполовину. Исключение составляет MySQL, потому что там DDL фиксируется неявно.

## Решение 1: удалите базу данных, если данные не важны

Для локальной базы данных разработки сброс, который вы на самом деле хотели, звучит как "миграции и база данных начинают заново вместе". [Официальная документация](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations) описывает именно это: удалить папку `Migrations` и удалить базу данных.

```bash
# dotnet-ef 10.0.12
dotnet ef database drop --force
dotnet ef database update
```

Это правильный ответ для базы данных на ноутбуке или одноразового контейнера. Не применяйте его ни к чему общему: он удаляет базу данных вместе с данными.

## Решение 2: запишите новую базовую миграцию, не выполняя её

Если в базе данных есть ценные данные, нужно обратное: сохранить схему и сообщить EF Core, что новый `InitialCreate` уже применён. В документации это называется сжатием (squash) миграций. Встроенной команды для этого в EF Core нет (запрос годами остаётся открытым как [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174)), так что это ручная правка таблицы истории.

1. Сделайте резервную копию базы данных.
2. Убедитесь, что перед сбросом база данных находится на **последней старой миграции**. Если она отстаёт, сначала примените недостающие старые миграции, используя старый код из системы контроля версий. Базовая миграция работает, только если новый `InitialCreate` описывает схему, которая действительно существует.
3. Удалите папку `Migrations` и выполните `dotnet ef migrations add InitialCreate`.
4. Выполните `dotnet ef migrations script 0 InitialCreate` и скопируйте инструкцию `INSERT INTO [__EFMigrationsHistory]` из конца вывода. В ней точный идентификатор миграции и версия продукта.
5. Замените старые строки истории этой единственной строкой.

В SQL Server шаг 5 выглядит так:

```sql
-- SQL Server, EF Core 10.0.12 history table
BEGIN TRANSACTION;

DELETE FROM [__EFMigrationsHistory];

INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
VALUES (N'20261006110224_InitialCreate', N'10.0.12');

COMMIT;
```

Затем убедитесь, что EF Core с этим согласен:

```bash
# dotnet-ef 10.0.12
dotnet ef migrations list                      # 20261006110224_InitialCreate, no "(Pending)"
dotnet ef migrations has-pending-model-changes # "No changes have been made to the model since the last migration."
```

В моём воспроизведении после записи базовой миграции я добавил свойство `Url` в `Blog`, сгенерировал `AddBlogUrl`, и `dotnet ef database update` применил только эту миграцию. Это и есть нужное состояние: в истории одна базовая строка, а новые миграции применяются поверх неё как обычно.

Удалять старые строки строго не обязательно, потому что EF Core игнорирует незнакомые строки. Всё равно удалите их. Если позже кто-то переключится на старый коммит и выполнит `database update` для этой базы данных, устаревшие строки заставят EF Core считать старые миграции применёнными, а такой сбой отлаживать неприятно.

## Базовая миграция в нескольких окружениях

Сжатие легко провести на одной базе данных и легко ошибиться на пяти. Каждому существующему окружению нужна замена строк, а каждому новому нужен полный запуск `InitialCreate`. Надёжнее всего получить и то и другое с помощью проверки, которая переписывает историю только тогда, когда находит старую цепочку, и ничего не делает в остальных случаях.

В виде SQL-скрипта, который выполняется один раз на окружение перед развёртыванием сжатого кода:

```sql
-- SQL Server, run before deploying the squashed migrations
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
           WHERE [MigrationId] = N'20261006110221_AddPublished')
   AND NOT EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
                   WHERE [MigrationId] = N'20261006110224_InitialCreate')
BEGIN
    DELETE FROM [__EFMigrationsHistory];
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261006110224_InitialCreate', N'10.0.12');
END;

COMMIT;
```

Проверка опирается на **последнюю** старую миграцию, а не на первую. База данных, которая так и не дошла до `AddPublished`, не имеет схемы, описанной вашим новым `InitialCreate`, поэтому базовую строку ей записывать нельзя. Сначала её нужно обновить старым кодом.

Если вы применяете миграции из приложения при запуске, та же проверка встаёт перед `Migrate()`. Я проверил её на трёх базах данных: одной в старом состоянии `AddPublished`, той же базе при повторном запуске и совершенно новом пустом файле. Все три закончили с применёнными `InitialCreate, AddBlogUrl` и правильной схемой.

```csharp
// .NET 10, EF Core 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();
BaselineSquashedMigrations(db);
db.Database.Migrate();

static void BaselineSquashedMigrations(AppDb db)
{
    const string lastOldMigration = "20261006110221_AddPublished";
    const string newBaseline = "20261006110224_InitialCreate";

    // Returns every row in __EFMigrationsHistory, including IDs that no longer exist in the assembly.
    // Returns an empty list when the history table does not exist yet (fresh database).
    var applied = db.Database.GetAppliedMigrations().ToHashSet();
    if (!applied.Contains(lastOldMigration) || applied.Contains(newBaseline))
        return;

    using var tx = db.Database.BeginTransaction();
    db.Database.ExecuteSql($"DELETE FROM __EFMigrationsHistory");
    db.Database.ExecuteSql(
        $"INSERT INTO __EFMigrationsHistory (MigrationId, ProductVersion) VALUES ({newBaseline}, {"10.0.12"})");
    tx.Commit();
}
```

Имя таблицы здесь без кавычек, чтобы один и тот же код работал в SQL Server и SQLite. В PostgreSQL его нужно заключать в кавычки как `"__EFMigrationsHistory"`, потому что там идентификатор чувствителен к регистру. Запускайте это в одном шаге миграции (job, init container или один экземпляр), а не в каждой реплике. Начиная с EF Core 9 `Migrate()` берёт блокировку миграций, но этот helper выполняется до её получения. Если вы развёртываете с помощью bundle, выполните SQL-вариант перед bundle, как описано в статье о [применении миграций EF Core в продакшене с помощью migration bundles](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/). Удалите helper, когда во всех окружениях будет записана базовая миграция.

## Трюк с пустым Up() и почему я его избегаю

Распространённый ответ на Stack Overflow советует закомментировать тело `Up()` в новом `InitialCreate`, выполнить `database update`, чтобы строка записалась, а затем вернуть тело. Для одной базы данных на одной машине это работает. Но именно так в коммит попадает сломанная миграция: забудьте вернуть тело, и каждое новое окружение получит пустую схему со строкой истории, утверждающей, что всё готово. SQL-вариант делает с базой данных то же самое, не трогая файл миграции, так что забывать нечего.

## Подводные камни и похожие ошибки

**Пользовательский код из старых миграций пропадает.** Любой `migrationBuilder.Sql(...)`, написанный для представлений, хранимых процедур, триггеров или начальных данных, жил в удалённых файлах. Новый `InitialCreate` содержит только то, что знает модель. Перенесите эти блоки в новую миграцию вручную, иначе в новых окружениях не будет объектов, которые есть в продакшене.

**Дрейф схемы делает базовую миграцию ложной.** Если кто-то добавил индекс или столбец прямо в продакшене, нового `InitialCreate` это не коснётся, и базовая строка зафиксирует несовпадающую схему. Перед записью базовой миграции сравните вывод `dotnet ef migrations script 0 InitialCreate` с реальной схемой (schema compare в SSMS, `pg_dump --schema-only` или `sqlite3 .schema`).

**`EnsureCreated()` рядом с `Migrate()`.** Если вы пришли сюда потому, что база данных создана через `EnsureCreated()`, первым делом уберите этот вызов. Он никогда не создаёт таблицу истории, поэтому они не могут сосуществовать. Тот же совет есть в статье о [`CREATE DATABASE permission denied` при `dotnet ef database update`](/ru/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), ещё одном симптоме их смешивания.

**При запуске сначала появляется другая ошибка.** Начиная с EF Core 9 `Migrate()` отказывается работать, если в модели есть изменения, не зафиксированные в миграции. Если вместо этого вы видите `The model for context has pending changes`, сначала исправьте это, как описано в [статье об ожидающих изменениях модели](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), а затем возвращайтесь.

**Миграция, применённая наполовину после таймаута.** Если 2714 появляется на миграции, которая не является начальной, причиной может быть миграция, оборвавшаяся посередине. Этот случай разобран в статье об [исправлении таймаутов SqlException во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), включая восстановление строки истории.

**Скрипты `--idempotent` не спасают.** `dotnet ef migrations script --idempotent` оборачивает каждую миграцию в `IF NOT EXISTS (SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'...')`. Проверяется идентификатор миграции, а не таблица, поэтому новый идентификатор `InitialCreate` всё равно выполняет свой `CREATE TABLE` и падает так же.

**`dotnet ef migrations add` падает ещё раньше.** Если инструмент не может создать ваш контекст во время сброса, это проблема конфигурации времени разработки, разобранная в статье об [исправлении "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Связанные статьи

- [Как применять миграции EF Core 11 в продакшене с помощью dotnet ef migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Исправление: The model for context has pending changes в EF Core 11](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Исправление: SqlException: Timeout expired во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Исправление: CREATE DATABASE permission denied in database 'master'](/ru/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Исправление: dotnet ef migrations add "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)

## Источники

- [Managing Migrations: Resetting all migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying), Microsoft Learn.
- [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174), открытый запрос на функцию сжатия миграций.
- [`HistoryRepository.cs` в ветке release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Relational/Migrations/HistoryRepository.cs), где видны значения по умолчанию для имени и схемы таблицы истории.
