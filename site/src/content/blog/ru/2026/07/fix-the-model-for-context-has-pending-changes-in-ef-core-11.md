---
title: "Исправление: \"The model for context 'X' has pending changes\" в EF Core 11"
description: "EF Core выбрасывает PendingModelChangesWarning, когда модель расходится с последним снимком миграции. Добавьте миграцию или устраните ложное срабатывание."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "migration"
lang: "ru"
translationOf: "2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-29
---

Выполните `dotnet ef migrations add <Name>`, а затем `dotnet ef database update`. Начиная с EF Core 9.0, `Migrate()`, `MigrateAsync()` и `dotnet ef database update` сравнивают текущую модель со снимком, который записала последняя миграция, и выбрасывают `PendingModelChangesWarning`, если они расходятся. В подавляющем большинстве случаев причина одна: модель изменили, а миграцию не добавили. Если только что сгенерированная миграция пуста или получается одинаковой при каждой повторной генерации, у вас ложное срабатывание: недетерминированные значения в `HasData`, отсутствующий снимок модели, параметры Identity, которые существуют только в стартовом проекте, или снимок, созданный более старой версией EF Core. Статья ориентирована на EF Core 11.0 и .NET 11 (на момент написания preview 6, релиз в ноябре 2026) с C# 14, и всё сказанное без изменений применимо вплоть до EF Core 9.0, где это исключение и появилось.

## Ошибка в контексте

Исключение времени выполнения, выброшенное из вызова `Database.Migrate()` при старте приложения:

```
Microsoft.EntityFrameworkCore.Migrations[20409]
System.InvalidOperationException: An error was generated for warning 'Microsoft.EntityFrameworkCore.Migrations.PendingModelChangesWarning': The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes. This exception can be suppressed or logged by passing event ID 'RelationalEventId.PendingModelChangesWarning' to the 'ConfigureWarnings' method in 'DbContext.OnConfiguring' or 'AddDbContext'.
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.ValidateMigrations(String targetMigration)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.Migrate(DatabaseFacade databaseFacade)
```

Тот же сбой из CLI выглядит короче, а код возврата отличен от нуля:

```
Build started...
Build succeeded.
The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes.
```

Идентификатор события `20409` соответствует `RelationalEventId.PendingModelChangesWarning` (`CoreEventId.RelationalBaseId + 409`), категория журналирования `Microsoft.EntityFrameworkCore.Migrations`. В EF Core 9.0.0 в сообщении не было ссылки `aka.ms`, и это единственное текстовое отличие между 9.0 и 11.0.

## Почему это происходит

Проверка сравнивает две модели: модель времени разработки, которую EF строит из вашего `DbContext` прямо сейчас, и снимок модели, сериализованный в `Migrations/AppDbContextModelSnapshot.cs` при последнем запуске `migrations add`. В базу данных она **не** заглядывает. Это самое полезное, что стоит знать об этой ошибке, потому что полностью актуальная база вас не спасёт, а устаревшая ошибку не вызовет.

Сравнение то же самое, что лежит в основе генерации миграций. Из собственной реализации `Migrator` в EF Core:

```csharp
// efcore/src/EFCore.Relational/Migrations/Internal/Migrator.cs, EF Core 11
public bool HasPendingModelChanges()
    => _migrationsModelDiffer.HasDifferences(
        FinalizeModel(_migrationsAssembly.ModelSnapshot?.Model)?.GetRelationalModel(),
        _designTimeModel.Model.GetRelationalModel());
```

Из этой формы следуют два вывода. Во-первых, сравнение идёт по *реляционной* модели, то есть учитываются типы столбцов, длины, допустимость null, индексы и имена ограничений, а не только классы сущностей. `HasMaxLength(128)` вместо прежних `450` уже является ожидающим изменением, даже если ни одно свойство C# не менялось. Во-вторых, если `ModelSnapshot` равен `null`, исходная модель тоже `null`, и каждая таблица вашей модели читается как отличие.

Мотивация команды EF была простой: молча применять миграции, когда модель уже ушла вперёд, значит получить базу данных, не соответствующую коду, а такой сбой всплывает намного позже как исключение об отсутствующем столбце в продакшене. До EF Core 9.0 `Migrate()` применял имеющиеся миграции и молча возвращал управление.

## Минимальное воспроизведение

Два файла и один забытый вызов:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public string? Slug { get; set; }   // added after the last migration
}

public class AppDbContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=.;Database=Demo;Trusted_Connection=True;Encrypt=False");
}
```

```csharp
// Program.cs, .NET 11
using var db = new AppDbContext();
db.Database.Migrate();   // throws PendingModelChangesWarning
```

Добавьте `Slug`, пропустите `dotnet ef migrations add AddBlogSlug`, и следующий `Migrate()` выбросит исключение. База данных здесь ни при чём: удалите её, создайте заново или укажите на новый сервер, исключение будет тем же самым.

## Исправление, по убыванию вероятности

**1. Добавьте забытую миграцию.** В подавляющем большинстве случаев это и есть правильное решение:

```bash
dotnet ef migrations add AddBlogSlug
```

Затем примените её через `dotnet ef database update` или дайте `Migrate()` сделать это при следующем запуске. EF Core 11 умеет объединять оба шага в один, что удобно, когда приложение работает в контейнере, который нельзя пересобрать: `dotnet ef database update AddBlogSlug --add` создаёт миграцию, компилирует её через Roslyn и сразу применяет одной командой. Подробнее об этом в материале о [создании и применении миграции за один шаг](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/).

**2. Пересоздайте отсутствующий или отредактированный вручную снимок.** Если кто-то написал класс миграции руками, удалил `AppDbContextModelSnapshot.cs` или разрешил конфликт слияния в нём, взяв одну сторону целиком, снимок больше не описывает модель, которую дают миграции. Один раз выполните `dotnet ef migrations add` штатным инструментом: сгенерированная миграция покажет реальное расхождение, а снимок будет переписан как побочный эффект. Никогда не правьте снимок вручную ради исчезновения ошибки, потому что следующая сгенерированная миграция будет сравниваться именно с тем, что вы там оставили.

**3. Замените недетерминированные значения `HasData` константами.** `Guid.NewGuid()` или `DateTime.UtcNow` внутри объекта начальных данных вычисляются при каждой сборке модели, поэтому модель действительно отличается от снимка при каждом запуске. EF Core распознаёт именно этот случай и дополняет ошибку вторым диагностическим сообщением:

> The model for context '{contextType}' changes each time it is built. This is usually caused by dynamic values used in a 'HasData' call (e.g. `new DateTime()`, `Guid.NewGuid()`). Add a new migration and examine its contents to locate the cause, and replace the dynamic call with a static, hardcoded value.

Решение в том, чтобы зафиксировать значения:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<Blog>().HasData(new Blog
{
    Id = 1,
    Name = "Start Debugging",
    // Not Guid.NewGuid(), not DateTime.UtcNow.
    PublicId = Guid.Parse("9e4f49fe-0786-44c6-9061-53d2aa84fab3"),
    CreatedUtc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
});
```

После исправления модели пересоздайте миграцию, так как предыдущая зафиксировала случайное значение. Если данные действительно должны быть динамическими, им вообще не место в модели: перенесите их в `UseSeeding`/`UseAsyncSeeding`, которые работают вне снимка. Полная процедура описана в статье о [переходе с HasData на UseAsyncSeeding](/ru/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/), а компромиссы разобраны в [HasData vs UseSeeding](/ru/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/).

**4. Дайте инструментам EF ту же конфигурацию, что и приложению.** Классический случай тут ASP.NET Core Identity. Параметры вроде `Stores.SchemaVersion` или `Stores.MaxLengthForKeys` меняют модель, задаются они в DI-контейнере приложения, и инструменты EF их не видят, если запускать инструменты только против проекта с `DbContext`. Тогда снимок описывает не ту модель, которую строит работающее приложение. Либо укажите приложение как стартовый проект:

```bash
dotnet ef migrations add AddBlogSlug --project src/Data --startup-project src/Web
```

либо реализуйте `IDesignTimeDbContextFactory<T>` рядом с контекстом, чтобы оба пути строили модель одинаково:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbContextDesignTimeFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var services = new ServiceCollection();
        services.AddDefaultIdentity<ApplicationUser>(options =>
            {
                options.Stores.SchemaVersion = IdentitySchemaVersions.Version2;
                options.Stores.MaxLengthForKeys = 256;
            })
            .AddEntityFrameworkStores<AppDbContext>();

        var optionsBuilder = new DbContextOptionsBuilder<AppDbContext>();
        optionsBuilder.UseApplicationServiceProvider(services.BuildServiceProvider());
        optionsBuilder.UseSqlServer();
        return new AppDbContext(optionsBuilder.Options);
    }
}
```

**5. Пересоздайте снимок, записанный старой версией EF Core.** Генерация снимков улучшается от релиза к релизу, поэтому снимок, созданный EF Core 6, может расходиться с моделью EF Core 11 даже без единого изменения кода. EF Core распознаёт и это, через `RelationalEventId.OldMigrationVersion` (`20414`): "Pending model changes were detected for context '{contextType}', but the model snapshot was created with EF Core version '{efVersion}'." Добавьте пустую миграцию, чтобы переписать снимок на текущей версии, убедитесь, что её `Up` действительно пуст, и оставьте её в проекте. Это рутинный шаг при [переходе с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**6. Подавите предупреждение, но только в двух случаях, где это настоящее ложное срабатывание.** Если ваши миграции генерируются или выбираются динамически через подмену сервисов EF, либо вы убедились, что мигрировать больше нечего, подавите конкретное событие:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<AppDbContext>(options => options
    .UseSqlServer(connectionString)
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));
```

Используйте `w.Log(RelationalEventId.PendingModelChangesWarning)`, если хотите видеть событие в журнале, а не заглушать его полностью. Подавление также остаётся единственным рычагом, когда последняя миграция сгенерирована для одного провайдера, а применяется другим (SQLite локально, SQL Server в продакшене), но Microsoft прямо называет такой сценарий неподдерживаемым и вероятно неработающим в будущем, так что лучше генерировать отдельный набор миграций для каждого провайдера.

## Как понять, какая причина у вас

Начинайте с команды, а не с исключения. `dotnet ef migrations has-pending-model-changes` существует с EF Core 8.0 и завершается с ненулевым кодом, если модель ушла вперёд, что делает её правильным шагом в CI перед развёртыванием:

```bash
dotnet ef migrations has-pending-model-changes
```

Программный эквивалент, `context.Database.HasPendingModelChanges()`, превращает ту же проверку в тест, который падает на пул-реквесте, забывшем миграцию:

```csharp
// .NET 11, EF Core 11.0.0, xUnit v3
[Fact]
public void Model_has_no_pending_changes()
{
    using var context = new AppDbContext();
    Assert.False(context.Database.HasPendingModelChanges());
}
```

Затем сгенерируйте миграцию и прочитайте её. Сгенерированный метод `Up` и есть тот самый diff, только человеческим языком: `AddColumn` подскажет, какое свойство вы забыли, `AlterColumn` с `maxLength: 128` против унаследованного столбца `nvarchar(450)` покажет, что модель и схема базы расходятся по длине, а `InsertData` с новым GUID при каждом запуске указывает на причину 3. Удалите миграцию через `dotnet ef migrations remove`, если она окажется ложной.

Если сгенерированная миграция пуста, а ошибка остаётся, внутреннее сравнение EF видит то, что генератор не выводит. Повторите то, что делает `HasPendingModelChanges`, и выведите операции в сыром виде:

```csharp
// .NET 11, EF Core 11.0.0. Uses EF internals: pin your EF version if you keep this.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

using var context = new AppDbContext();

var differ = context.GetService<IMigrationsModelDiffer>();
var initializer = context.GetService<IModelRuntimeInitializer>();
var snapshot = context.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;

var source = snapshot is null ? null : initializer.Initialize(snapshot).GetRelationalModel();
var target = context.GetService<IDesignTimeModel>().Model.GetRelationalModel();

foreach (var operation in differ.GetDifferences(source, target))
{
    Console.WriteLine(operation.GetType().Name);
}
```

`IMigrationsModelDiffer` является публичным интерфейсом, но служебным сервисом для внутреннего использования, так что относитесь к этому коду как к инструменту отладки, а не как к продакшен-коду.

## Тонкости и варианты

**Откат перестал вызывать ошибку в 9.0.2.** EF Core 9.0.0 и 9.0.1 выбрасывали `PendingModelChangesWarning` даже при явном указании более ранней миграции, из-за чего откат был невозможен без подавления предупреждения. Это исправлено в 9.0.2: проверка теперь выполняется только когда целевая миграция не указана, поэтому `dotnet ef database update AddBlogSlug` и `dotnet ef database update 0` работают и при наличии ожидающих изменений.

**"No migrations were found in assembly" это родственная ошибка EF Core 11, а не та же самая.** `RelationalEventId.MigrationsNotFound` (`20406`) раньше был информационной записью в журнале, а начиная с EF Core 11.0 выбрасывает исключение по умолчанию. Он срабатывает, когда миграций нет вообще, обычно потому что `Migrate()` вызывают по привычке, управляя схемой через DACPAC или написанный вручную SQL. Уберите вызов `Migrate()` или подавите это отдельное событие через `w.Ignore(RelationalEventId.MigrationsNotFound)`.

**Каждому типу `DbContext` нужна своя миграция.** Добавление миграции для `AppDbContext` ничего не даёт `AuditDbContext`. Исключение называет контекст, так что читайте его: `dotnet ef migrations add <Name> --context AuditDbContext`.

**Проектам с несколькими целевыми платформами нужен `--framework`, начиная с EF Core 10.** Если в проекте используется `<TargetFrameworks>`, инструменты завершатся с ошибкой "The project targets multiple frameworks" ещё до сравнения моделей. Передайте `--framework net11.0`.

**`EnsureCreated()` никогда не выбрасывает эту ошибку.** Он вообще не использует миграции, поэтому не читает снимок и не применяет историю миграций. Если в тестах у вас `EnsureCreated()`, а в продакшене `Migrate()`, падает только продакшен-путь.

**Схема базы данных всё равно не проверяется.** Пройденная проверка означает, что модель соответствует последней миграции. Она ничего не говорит о том, была ли миграция применена и не правил ли кто-то столбец руками в продакшене. Закрыть этот пробел позволяет применение изменений схемы отдельным шагом развёртывания, как описано в статье про [применение миграций EF Core 11 через migration bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Похожие статьи

- [Применение миграций EF Core 11 в продакшене через migration bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) - место проверки `has-pending-model-changes` в конвейере развёртывания.
- [Создание и применение миграции одной командой](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) - опция `--add` в EF Core 11.
- [Переход с HasData на UseAsyncSeeding](/ru/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/) - окончательное решение для начальных данных, которые снова и снова вызывают эту ошибку.
- [HasData vs UseSeeding в EF Core 11](/ru/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) - какой механизм начальных данных относится к модели, а какой нет.
- [Переход с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) - остальные ломающие изменения, всплывающие при том же обновлении.

## Источники

- [Ломающие изменения в EF Core 9: исключение при применении миграций, если есть ожидающие изменения модели](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) - авторитетный список причин и способов их устранения, включая пример фабрики времени разработки для Identity.
- [Ломающие изменения в EF Core 11: EF Core по умолчанию выбрасывает исключение, если миграций нет](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes) - изменение в `MigrationsNotFound`.
- [Управление миграциями: проверка ожидающих изменений модели](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) - `has-pending-model-changes` и `HasPendingModelChanges()`.
- [dotnet/efcore#35285: предыстория и разъяснения по ошибке PendingModelChangesWarning в 9.0](https://github.com/dotnet/efcore/issues/35285) - разбор ложных срабатываний самой командой EF.
- [dotnet/efcore#35342](https://github.com/dotnet/efcore/issues/35342) и исправление в 9.0.2 - регрессия с откатом.
- [Migrator.cs в dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) и [RelationalStrings.resx](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Properties/RelationalStrings.resx) - само сравнение и точный текст сообщения.
