---
title: "Как задать собственные соглашения об именовании первичных ключей, внешних ключей и индексов в миграциях EF Core 11"
description: "Переименуйте все PK_, FK_, AK_ и IX_, которые генерирует EF Core 11, с помощью одного IModelFinalizingConvention, сохраните приоритет явно заданных имён, уложитесь в ограничение длины идентификатора и избегите перестроения кластеризованного индекса, которое следующая миграция сгенерирует для существующей базы данных."
pubDate: 2026-09-19
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-19
---

Коротко: напишите один класс, реализующий `IModelFinalizingConvention`, обойдите объявленные ключи, внешние ключи и индексы каждого типа сущности и задайте имена через построители соглашений (`key.Builder.HasName(...)`, `fk.Builder.HasConstraintName(...)`, `index.Builder.HasDatabaseName(...)`). Зарегистрируйте его в `ConfigureConventions` вызовом `configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention())`. Поскольку построители записывают имя с источником `Convention`, любое имя, заданное явно через Fluent API или `[Index(Name = ...)]`, по-прежнему имеет приоритет. Для новой базы данных на этом работа закончена. Для существующей следующая миграция удаляет и заново создаёт каждый первичный и внешний ключ только ради переименования, поэтому эту миграцию нужно вручную переписать на переименования.

Всё в этой статье запускалось на .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) с `Microsoft.EntityFrameworkCore.SqlServer` `11.0.0-rc.1.26425.128`. Показанные DDL и SQL миграций являются реальным выводом `Database.GenerateCreateScript()` и `IMigrationsSqlGenerator` для модели SQL Server. Сервер базы данных не использовался, поэтому замеров времени здесь нет, только SQL, который отправил бы EF Core.

## Какие имена EF Core 11 выбирает по умолчанию

Начнём с небольшой модели: `Blog` с уникальным альтернативным ключом `Slug`, `Post`, ссылающийся на `Blog` и необязательно на `Author`, уникальный индекс по `Author.Email`, составной индекс на `Post` и связь многие-ко-многим через skip-навигацию между `Post` и `Tag`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public string Slug { get; set; } = "";
    public List<Post> Posts { get; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
    public int? AuthorId { get; set; }
    public Author? Author { get; set; }
    public List<Tag> Tags { get; } = [];
}

public class Author { public int Id { get; set; } public string Email { get; set; } = ""; }
public class Tag { public int Id { get; set; } public string Name { get; set; } = ""; public List<Post> Posts { get; } = []; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Blog>().HasAlternateKey(b => b.Slug);
        mb.Entity<Author>().HasIndex(a => a.Email).IsUnique();
        mb.Entity<Post>().HasIndex(p => new { p.BlogId, p.Title });
    }
}
```

Сгенерированный DDL для SQL Server использует четыре шаблона:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, default names
CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [AK_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [FK_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [FK_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE UNIQUE INDEX [IX_Authors_Email] ON [Authors] ([Email]);
CREATE INDEX [IX_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
```

Итак, по умолчанию используются `PK_{table}`, `AK_{table}_{columns}`, `FK_{dependent table}_{principal table}_{columns}` и `IX_{table}_{columns}`, причём уникальный индекс получает тот же префикс `IX_`, что и неуникальный. Обратите внимание, что в шаблоне используется имя *таблицы* (`Blogs`, из `DbSet`), а не имя типа CLR. В некоторых разделах документации Microsoft Learn имя первичного ключа по умолчанию описано как `PK_<type name>`, что верно лишь тогда, когда эти два имени случайно совпадают.

Обычно команды хотят это изменить по одной из трёх причин: стандарт DBA (`pk_`, `fk_`, `ux_` для уникальных индексов), база данных PostgreSQL, где всё остальное в нижнем регистре, или существующая схема, созданная другим инструментом, имена из которой EF Core должен принять, а не бороться с ними.

## Разовые имена: HasName, HasConstraintName, HasDatabaseName

Если конкретное имя нужно лишь нескольким объектам, в Fluent API есть свой метод для каждого типа объекта:

```csharp
// .NET 11, EF Core 11 - per-object names
mb.Entity<Blog>().HasKey(b => b.Id).HasName("pk_blog");
mb.Entity<Blog>().HasAlternateKey(b => b.Slug).HasName("ak_blog_slug");

mb.Entity<Post>()
    .HasOne(p => p.Blog).WithMany(b => b.Posts)
    .HasForeignKey(p => p.BlogId)
    .HasConstraintName("fk_post_blog");

mb.Entity<Author>().HasIndex(a => a.Email).IsUnique().HasDatabaseName("ux_author_email");
```

Для индексов есть и форма атрибута, `[Index(nameof(Email), IsUnique = true, Name = "ux_author_email")]`. `Name` атрибута становится именем в базе данных.

Это не масштабируется. Каждой новой сущности нужны те же три вызова, про таблицу связи skip-навигации легко забыть, а в тот день, когда кто-то добавит индекс без этого вызова, вы снова получите `IX_`. Именно для этого и существуют соглашения.

## Соглашение финализации модели, которое именует всё

Документация EF Core по [массовой настройке модели](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) описывает два вида пользовательских соглашений. Интерактивные реагируют на каждое изменение модели в момент его возникновения. Соглашения *финализации модели* выполняются один раз, после того как `OnModelCreating` и все встроенные соглашения завершили работу, и видят почти окончательную модель. Имена ограничений зависят от имён таблиц и столбцов, которые могут меняться вплоть до самого конца построения модели, поэтому соглашение финализации и есть правильная точка расширения. Если запускаться раньше, можно назвать индекс по столбцу, который позднее переименует `HasColumnName`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Metadata.Conventions;

public sealed class ConstraintNamingConvention : IModelFinalizingConvention
{
    public void ProcessModelFinalizing(
        IConventionModelBuilder modelBuilder,
        IConventionContext<IConventionModelBuilder> context)
    {
        var maxLength = modelBuilder.Metadata.GetMaxIdentifierLength();

        foreach (var entityType in modelBuilder.Metadata.GetEntityTypes())
        {
            var table = entityType.GetTableName();
            if (table is null) continue; // views, keyless query types, TPC abstract roots
            var store = StoreObjectIdentifier.Table(table, entityType.GetSchema());

            foreach (var key in entityType.GetDeclaredKeys())
            {
                var name = key.IsPrimaryKey()
                    ? $"pk_{table}"
                    : $"ak_{table}_{Columns(key.Properties, store)}";
                key.Builder.HasName(Truncate(name, maxLength));
            }

            foreach (var fk in entityType.GetDeclaredForeignKeys())
            {
                var principalTable = fk.PrincipalEntityType.GetTableName();
                if (principalTable is null) continue;
                var name = $"fk_{table}_{principalTable}_{Columns(fk.Properties, store)}";
                fk.Builder.HasConstraintName(Truncate(name, maxLength));
            }

            foreach (var index in entityType.GetDeclaredIndexes())
            {
                var prefix = index.IsUnique ? "ux" : "ix";
                var name = $"{prefix}_{table}_{Columns(index.Properties, store)}";
                index.Builder.HasDatabaseName(Truncate(name, maxLength));
            }
        }
    }

    static string Columns(IEnumerable<IConventionPropertyBase> props, StoreObjectIdentifier store)
        => string.Join("_", props.Select(p =>
            (p as IConventionProperty)?.GetColumnName(store) ?? p.Name));

    static string Truncate(string name, int maxLength)
    {
        if (name.Length <= maxLength) return name;
        // keep names unique after truncation: prefix + 8 hex chars of a stable hash
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(name)))[..8].ToLowerInvariant();
        return $"{name[..(maxLength - 9)]}_{hash}";
    }
}
```

Зарегистрируйте его в контексте:

```csharp
// .NET 11, EF Core 11
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    => configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention());
```

`Conventions.Add` принимает фабрику, а не экземпляр, чтобы соглашение могло получать службы из внутреннего поставщика служб EF Core. У этого соглашения зависимостей нет, отсюда отброшенный параметр `_`.

Та же модель теперь выдаёт:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, with ConstraintNamingConvention
CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [pk_PostTag] PRIMARY KEY ([PostsId], [TagsId]),
CONSTRAINT [fk_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE INDEX [ix_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
CREATE INDEX [ix_PostTag_TagsId] ON [PostTag] ([TagsId]);
```

Неявная таблица связи `PostTag` охватывается без дополнительного кода, потому что это настоящий тип сущности (с общим типом) в модели, и `GetEntityTypes()` его возвращает.

Несколько деталей в этом коде сделаны намеренно.

**Используйте построители соглашений, а не сеттеры.** `key.Builder.HasName(...)` задаёт имя с `ConfigurationSource.Convention`. EF Core отслеживает, откуда пришёл каждый фрагмент конфигурации, и значение с источником convention никогда не переопределяет значение с источником `DataAnnotation` или `Explicit`. В воспроизведении я оставил для уникального индекса явное имя `.HasDatabaseName("UX_Authors_Email_Legacy")` в `OnModelCreating`, и вывод по-прежнему содержит `CREATE UNIQUE INDEX [UX_Authors_Email_Legacy]`, тогда как все остальные индексы получили обработку `ix_`/`ux_`. Если вместо этого вызывать изменяемые сеттеры (`IMutableKey.SetName`) в цикле в конце `OnModelCreating`, этот приоритет теряется, и вы молча перезаписываете имена, которые коллега задал намеренно.

**Используйте имя столбца для объекта хранилища, а не имя свойства.** `GetColumnName(StoreObjectIdentifier)` возвращает то, что действительно находится в таблице, включая переопределения `HasColumnName` и префиксы owned-типов вроде `Where_City`. Если называть индекс по свойству CLR, получаются имена, не совпадающие со столбцами, которые он покрывает.

**`Properties` имеет тип `IConventionPropertyBase` в EF Core 11.** В EF Core 11 RC 1 `IConventionKey.Properties` типизировано как `IReadOnlyList<IConventionPropertyBase>`, поэтому вспомогательный метод, объявленный с `IEnumerable<IConventionProperty>`, не компилируется с ошибкой CS1503. Приведение типа в `Columns` решает это и откатывается к имени члена для всего, что не является обычным скалярным свойством.

## Внедрение: новая база данных против существующей

Соглашение об именовании меняет модель, поэтому `dotnet ef migrations add` видит различия. Самое неприятное кроется в том, что именно содержат эти различия.

1. **Новый проект или ещё не развёрнутая база данных.** Добавьте соглашение до первой миграции. `InitialCreate` содержит новые имена, и больше ничего делать не нужно.
2. **Существующая база данных, небольшие таблицы.** Сгенерируйте миграцию, прочитайте её и примените. EF Core перестраивает ключи, что допустимо, когда таблицы небольшие.
3. **Существующая база данных, большие таблицы.** Сгенерируйте миграцию, затем замените пары удаления и добавления на переименования, прежде чем кто-либо её применит.

Чтобы точно понять, о чём шаг 3, я сравнил модель с именами по умолчанию и модель с именами из соглашения через `IMigrationsModelDiffer`, тот же компонент, который использует `migrations add`. Индексы получаются дешёвыми переименованиями:

```sql
-- EF Core 11.0.0-rc.1: RenameIndexOperation on SQL Server
EXEC sp_rename N'[Posts].[IX_Posts_BlogId_Title]', N'ix_Posts_BlogId_Title', 'INDEX';
EXEC sp_rename N'[PostTag].[IX_PostTag_TagsId]', N'ix_PostTag_TagsId', 'INDEX';
```

С первичными, альтернативными и внешними ключами это не так. Операции миграции `RenamePrimaryKey` или `RenameForeignKey` не существует, поэтому сравнение выдаёт удаление и добавление для каждого из них, 24 операции для этой модели из пяти таблиц:

```sql
-- EF Core 11.0.0-rc.1: what the scaffolded migration does to keys
ALTER TABLE [Posts] DROP CONSTRAINT [FK_Posts_Blogs_BlogId];
ALTER TABLE [Posts] DROP CONSTRAINT [PK_Posts];
ALTER TABLE [Blogs] DROP CONSTRAINT [AK_Blogs_Slug];
ALTER TABLE [Blogs] DROP CONSTRAINT [PK_Blogs];
-- ...
ALTER TABLE [Posts] ADD CONSTRAINT [pk_Posts] PRIMARY KEY ([Id]);
ALTER TABLE [Blogs] ADD CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug]);
ALTER TABLE [Blogs] ADD CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]);
ALTER TABLE [Posts] ADD CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE;
```

В SQL Server первичный ключ по умолчанию является кластеризованным индексом. Его удаление превращает таблицу в кучу и переписывает каждый некластеризованный индекс; повторное добавление снова сортирует и переписывает таблицу, а затем второй раз переписывает некластеризованные индексы. Повторное добавление каждого внешнего ключа проверяет каждую существующую строку. На таблице с десятками миллионов строк это долгая операция, сильно нагружающая журнал транзакций и выполняемая внутри транзакции миграции, и всё ради смены регистра префикса. Тот же шаблон удаления и добавления появляется, когда вы [переименовываете таблицу в миграции EF Core 11](/ru/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/), и решение то же: переименовывать ограничения на месте.

В SQL Server замените сгенерированные вызовы `DropForeignKey`/`DropPrimaryKey`/`DropUniqueConstraint` и соответствующие вызовы `Add*` в `Up` на `sp_rename`, который переименовывает ограничение как изменение метаданных. Переименование первичного ключа или ограничения уникальности через `sp_rename` также переименовывает стоящий за ним индекс.

```csharp
// .NET 11, EF Core 11 - hand-edited Up() for SQL Server
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Blogs]', N'pk_Blogs', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[AK_Blogs_Slug]', N'ak_Blogs_Slug', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Posts]', N'pk_Posts', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Posts_Blogs_BlogId]', N'fk_Posts_Blogs_BlogId', 'OBJECT';");
    // ...one line per key and foreign key

    // the scaffolded index renames are already fine, keep them
    migrationBuilder.RenameIndex(
        name: "IX_Posts_BlogId_Title", table: "Posts", newName: "ix_Posts_BlogId_Title");
}
```

В PostgreSQL эквивалентом является `ALTER TABLE "Posts" RENAME CONSTRAINT "PK_Posts" TO "pk_Posts";`, что также переименовывает индекс, стоящий за первичным ключом или ограничением уникальности. Для обычных индексов Npgsql уже генерирует `ALTER INDEX ... RENAME TO`.

Запишите обратные вызовы `sp_rename` и в `Down`. Сгенерированный `Down` по-прежнему содержит пары удаления и добавления, и если оставить его так, откат выполнит то самое перестроение, которого вы только что избежали. Снимок модели эта ручная правка не затрагивает: он в любом случае записывает новые имена, поэтому следующий `migrations add` выдаёт пустую разницу. Если это не так, вы пропустили какое-то ограничение, и проверка при запуске сообщит вам об этом через [исключение о незафиксированных изменениях модели](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/). Применяйте отредактированную миграцию через проверенный скрипт или [migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), а не через `Database.Migrate()` при запуске приложения.

## Подводные камни: общие таблицы, ограничения длины и пакет snake_case

**Формируйте имя от таблицы, а не от типа сущности.** Owned-тип, хранящийся в таблице владельца, разделение таблиц (table splitting) и TPH помещают несколько типов сущностей в одну таблицу, и у каждого из них есть собственные метаданные первичного ключа. Они должны сходиться в имени ограничения. В воспроизведении я переключил шаблон первичного ключа на `pk_{entityType.ClrType.Name}` в модели с owned-типом `Address` внутри `Media`, и проверка модели сразу же завершилась ошибкой:

```text
InvalidOperationException: The table 'Media' cannot be used for entity type 'Media' since it is being used
for entity type 'Address' and the name 'pk_Media' of the primary key {'Id'} does not match the name
'pk_Address' of the primary key {'MediaId'}.
```

Формирование имени из `GetTableName()` обходит эту проблему, потому что каждый тип сущности в общей таблице разрешается в одну и ту же таблицу. То же воспроизведение с `pk_{table}` выдало одно ограничение `pk_Media`, а внешние ключи TPH, объявленные на производных типах `Photo` и `Clip`, получились как `fk_Media_Author_PhotographerId` и `fk_Media_Author_EditorId` на общей таблице. [Руководство по отображению TPH](/ru/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) объясняет, почему столбцы производных типов там оказываются допускающими null.

**Соблюдайте ограничение длины идентификатора и сохраняйте уникальность усечённых имён.** `IConventionModel.GetMaxIdentifierLength()` возвращает ограничение провайдера: 128 для SQL Server и 32767 для SQLite в моём воспроизведении. PostgreSQL усекает идентификаторы до 63 байт. Составной индекс по длинным именам столбцов легко выходит за 63, и если просто обрезать строку, два индекса, различающиеся только в конце, схлопнутся в одно имя. Тогда EF Core не проходит проверку, потому что два индекса одной таблицы отображаются на одно имя с разными столбцами. Вспомогательный метод `Truncate` сохраняет префикс и добавляет восемь шестнадцатеричных символов SHA-256 от полного имени. При ограничении в 40 символов `ix_customer_order_line_items_warehouse_location_id_created_at` и `..._updated_at` превратились в `ix_customer_order_line_items_wa_0e2c7d55` и `ix_customer_order_line_items_wa_a5c1910c`. Используйте стабильный хеш, а не `string.GetHashCode()`, который в .NET рандомизируется для каждого процесса и давал бы другое имя, а значит и новую миграцию, при каждой сборке.

**Соглашения финализации выполняются в порядке добавления.** Если у вас есть ещё и соглашение, переименовывающее таблицы или столбцы (например, в snake_case), добавляйте его в `ConfigureConventions` *до* соглашения об именовании ограничений. Иначе имена ограничений будут вычислены из старых имён таблиц.

**`EFCore.NamingConventions` пока не является пакетом для EF Core 11.** Популярный пакет сообщества, который переводит всё в snake_case, включая имена ключей и индексов, на сегодня находится на версии 10.0.1, и его nuspec фиксирует `Microsoft.EntityFrameworkCore.Relational` в диапазоне `[10.0.1, 11.0.0)`. Ссылка на него рядом с EF Core 11 даёт предупреждение NuGet NU1608 "outside of dependency constraint" и пакет, который никогда не тестировался с API метаданных 11.0, а оно, как показывает изменение `IConventionPropertyBase`, действительно поменялось. У соглашения на 60 строк, которое принадлежит вам, такой проблемы нет.

**Сгенерированные (database-first) модели всё это игнорируют.** `dotnet ef dbcontext scaffold` читает реальные имена из базы данных и записывает явные вызовы `HasName`/`HasDatabaseName`, а явная конфигурация сильнее соглашения. Это правильное поведение, но не ждите, что соглашение "исправит" модель, полученную обратным проектированием.

**Проверяйте результат, а не код.** `Database.GenerateCreateScript()` на контексте с фиктивной строкой подключения выводит полный DDL, не обращаясь к серверу, а `dotnet ef migrations script` показывает, что выполнит ожидающая миграция. Оба способа быстрее, чем чтение снимка модели. Со стороны среды выполнения [журналирование SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), показывает имена ограничений в любом `DbUpdateException`, который на них ссылается.

## Связанные материалы

- [Как переименовать таблицу в миграции EF Core 11 без потери данных](/ru/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)
- [Исправление: the model for context 'X' has pending changes в EF Core 11](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Как применять миграции EF Core 11 в продакшене с помощью migrations bundles](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Как настроить отображение наследования table-per-hierarchy (TPH) в EF Core 11](/ru/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)
- [Complex types против owned-сущностей в EF Core 11](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)

## Источники

- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) на Microsoft Learn: `ConfigureConventions`, `IModelFinalizingConvention`, источники конфигурации и построители соглашений
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys) и [Indexes and constraints](https://learn.microsoft.com/en-us/ef/core/modeling/indexes) на Microsoft Learn для `HasName` и `HasDatabaseName`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) для переименования ограничений на месте в SQL Server
- [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) (`RENAME CONSTRAINT`) и [длина идентификатора](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) в документации PostgreSQL
- [EFCore.NamingConventions на NuGet](https://www.nuget.org/packages/EFCore.NamingConventions), диапазоны зависимостей версии 10.0.1
