---
title: "Исправление: The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'"
description: "HasData задаёт начальные данные для сущности с ключом, генерируемым хранилищем, но без явного значения. Дайте каждой строке стабильный Id, отличный от нуля, или используйте UseSeeding."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ru"
translationOf: "2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property"
translatedBy: "claude"
translationDate: 2026-06-25
---

Исправление: вы вызвали `HasData`, чтобы задать начальные данные для сущности, чей первичный ключ генерируется хранилищем (столбец `IDENTITY`), но оставили ключ в значении по умолчанию для CLR (`0` для `int`, `Guid.Empty` для `Guid`). `HasData` строит свой скрипт вставки во время миграции, не обращаясь к базе данных, поэтому он не может полагаться на то, что база данных выдаст ключи. Дайте каждой начальной строке явное, стабильное значение ключа, отличное от нуля (`new Country { Id = 1, ... }`). Если вы действительно хотите, чтобы ключ генерировала база данных, не используйте `HasData` вовсе: используйте вместо него `UseSeeding`/`UseAsyncSeeding`. Это руководство написано для .NET 11, C# 14 и `Microsoft.EntityFrameworkCore` 11.0.0, но текст сообщения и поведение не менялись начиная с EF Core 2.1.

```text
System.InvalidOperationException: The seed entity for entity type 'Country' cannot be added
because a non-zero value is required for property 'Id'. Consider providing a negative value
to avoid collisions with non-seed data.
   at Microsoft.EntityFrameworkCore.Metadata.Internal.EntityType.<>c__DisplayClass...
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateData(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

Это ошибка валидации модели, а не ошибка запроса во время выполнения. Она возникает при первом построении модели EF Core: при первом запросе, первом `SaveChanges`, первом обращении к `context.Model` или, чаще всего, когда вы запускаете `dotnet ef migrations add`. Имя типа в кавычках это сущность, для которой вы задали начальные данные; свойство в кавычках это её первичный ключ. Подсказка "consider providing a negative value" в конце это реальный совет, а не наполнитель, и раздел ниже о коллизиях объясняет почему.

## Почему HasData требует, чтобы ключ был указан явно

`HasData` (документация теперь называет это [model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding), поскольку "seeding" обещал больше, чем делает) принадлежит миграциям. Когда вы добавляете миграцию, EF Core сравнивает начальные строки в вашей текущей модели со строками, которые он записал в последнем снимке модели, и выдаёт вызовы `InsertData`, `UpdateData` или `DeleteData`, чтобы согласовать их. Это сравнение происходит во время разработки, на вашей машине, без подключения к базе данных.

Именно первичный ключ делает сравнение возможным. EF Core использует его, чтобы распознать "это та же строка, что я вставил в прошлой миграции, но Name изменился" в отличие от "это совершенно новая строка". Без стабильного значения ключа ему не с чем сопоставлять между миграциями. Поэтому валидатор модели применяет жёсткое правило: каждая строка `HasData` должна нести явное значение для своего первичного ключа, даже когда этот ключ настроен как генерируемый хранилищем.

Когда ключ генерируется хранилищем, а вы оставляете его в значении по умолчанию для CLR, EF Core не может отличить "разработчик забыл задать ключ" от "разработчик хочет ключ 0". Вместо того чтобы молча вставить строку с `Id = 0` (что грубо конфликтует со столбцами identity), он выбрасывает исключение. [Список ограничений model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) ставит это первым: "Значение первичного ключа должно быть указано, даже если обычно его генерирует база данных. Оно будет использовано для обнаружения изменений данных между миграциями."

## Минимальный репро

Одна сущность с обычным `Id` и одним вызовом `HasData`, который его опускает.

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
public class Country
{
    public int Id { get; set; }      // conventional PK -> store-generated IDENTITY
    public string Name { get; set; } = "";
}

public class AppDbContext : DbContext
{
    public DbSet<Country> Countries => Set<Country>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=SeedRepro;Trusted_Connection=True");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Country>().HasData(
            new Country { Name = "USA" },      // no Id -> Id stays 0 -> throws
            new Country { Name = "Canada" });
    }
}
```

Запустите против этого `dotnet ef migrations add Seed`, и вы получите исключение. Свойства `Id` равны `0`, EF Core трактует `0` как "нет значения" для генерируемого хранилищем ключа `int`, и валидация падает до того, как будет записан какой-либо код миграции.

## Исправление 1: дайте каждой начальной строке явный, стабильный ключ

Это правильное исправление для настоящих справочных данных: небольших фиксированных таблиц-справочников, которые меняются только через миграции (страны, валюты, роли, статусы). Назначьте каждой строке значение ключа вручную и никогда не используйте его повторно и не перенумеровывайте.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = 1, Name = "USA" },
    new Country { Id = 2, Name = "Canada" },
    new Country { Id = 3, Name = "Mexico" });
```

Два правила поддерживают это в рабочем состоянии со временем:

1. **Значения ключей теперь часть истории вашей схемы.** Относитесь к ним как к неизменяемым. Если вы измените строку 2 с `Id = 2` на `Id = 22`, следующая миграция выдаст `DeleteData` для `2` и `InsertData` для `22`, что выбросит старую строку и всё, что ссылалось на неё по внешнему ключу.
2. **Выбирайте значения явно, не давайте им смещаться.** Жёстко заданные константы подходят. Чего делать нельзя, так это вычислять их из чего-то недетерминированного (счётчика цикла, зависящего от порядка коллекции, `DateTime.Now`, вызова `Guid.NewGuid()`), потому что сравнение миграции должно давать одни и те же значения на каждой машине.

Если ключ это `Guid`, применяется то же правило: укажите фиксированный, жёстко заданный `Guid`, а не `Guid.NewGuid()`. Свежесгенерированный GUID при каждой сборке заставляет каждую миграцию думать, что строка изменилась.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - fixed GUIDs, not Guid.NewGuid()
modelBuilder.Entity<Role>().HasData(
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), Name = "Admin" },
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3302"), Name = "User" });
```

## Исправление 2: используйте отрицательные ключи, чтобы обойти коллизии identity

Собственная подсказка исключения, "consider providing a negative value to avoid collisions with non-seed data", решает проблему, с которой вы столкнётесь позже, а не ту, что перед вами. Когда вы задаёте начальные `Id = 1, 2, 3` в столбце `IDENTITY` SQL Server, счётчик identity ничего не знает о ваших начальных строках. Первый реальный `INSERT` после задания начальных данных запускает счётчик с `1`, пытается использовать ключ, который ваши начальные данные уже заняли, и падает с нарушением первичного ключа, либо в дело вступает механика `IDENTITY_INSERT`, и всё запутывается.

Отрицательные ключи для начальных данных обходят это. Реальные строки, созданные пользователем, отсчитываются вверх от `1`; ваши начальные справочные строки живут ниже `0` и никогда не пересекаются.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = -1, Name = "USA" },
    new Country { Id = -2, Name = "Canada" },
    new Country { Id = -3, Name = "Mexico" });
```

Это давняя рекомендация команды EF Core для таблиц-справочников на основе `IDENTITY`, которые также получают вставки во время выполнения. Это излишне для таблицы, для которой *только* задаются начальные данные (чистый справочник, в который приложение никогда не вставляет), где положительные ключи читаются естественнее.

## Исправление 3: перестаньте использовать HasData для этих данных

Если вашей причиной обратиться к `HasData` было "мне просто нужно несколько начальных строк в базе данных", то вам, вероятно, вообще не нужны model managed data. `HasData` создан для статических, детерминированных данных, принадлежащих миграциям, и больше ни для чего. Для данных, которые должны использовать генерируемые базой данных ключи, зависят от других строк или просто являются удобными стартовыми данными, команда EF Core теперь рекомендует [UseSeeding и UseAsyncSeeding](/ru/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), введённые в EF Core 9. Они выполняют реальный `SaveChanges` против живой базы данных, поэтому ключи генерирует база данных, и правило "не ноль" никогда не применяется.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
protected override void OnConfiguring(DbContextOptionsBuilder options)
    => options
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            if (!context.Set<Country>().Any())
            {
                // No Id set: the database generates it on SaveChanges. No error.
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<Country>().AnyAsync(ct))
            {
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                await context.SaveChangesAsync(ct);
            }
        });
```

`UseSeeding` вызывается из `EnsureCreated` и `Migrate`, а также из `dotnet ef database update`, даже когда нет ожидающих миграций. Реализуйте обе перегрузки, синхронную и асинхронную: инструменты EF Core вызывают синхронную, и она молча пропустит задание начальных данных, если существует только асинхронная версия. Поскольку тело задания начальных данных выполняется как код приложения без требования к ключу во время разработки, опускать `Id` здесь как раз правильно: его назначает база данных.

## Варианты, которые дают ту же ошибку

Формулировка сообщения идентична во всех этих случаях, поэтому поисковый трафик попадает сюда для всех них. Причина всегда одна и та же (строке `HasData` не хватает явного значения ключа, генерируемого хранилищем), но поверхность различается.

- **Принадлежащие (owned) сущности и сложные типы.** `OwnsOne(...).HasData(...)` нуждается в ключе *владельца* в каждой начальной строке, передаваемом через анонимный объект: `new { CountryId = 1, ... }`. Опустите его, и вы получите ошибку "не ноль" против свойства ключа владельца.
- **Строки соединительной таблицы многие-ко-многим.** Задание начальных данных для соединительной таблицы через `UsingEntity(...).HasData(...)` требует обоих внешних ключей в каждой строке. Пропущенная или нулевая сторона выбрасывает ту же ошибку. См. [как задать начальные данные для связи многие-ко-многим в EF Core 11](/ru/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) для полной настройки соединительной сущности.
- **Составные ключи.** Каждый столбец составного ключа должен быть задан в каждой начальной строке. Ноль в любой из частей вызывает ошибку для этого свойства.
- **Ключи с преобразованием значений.** Строго типизированный идентификатор (`record struct CountryId(int Value)`), опирающийся на преобразователь значений, всё равно нуждается в значении, отличном от значения по умолчанию. Экземпляр по умолчанию преобразуется в значение хранилища по умолчанию, что считается "нет значения".

Другая, но легко путаемая ошибка это `The seed entity for entity type 'X' cannot be added because there was no value provided for the required property 'Y'`, где `Y` это обязательное свойство, не являющееся ключом, например `Name`. Эта означает, что столбец `[Required]` или `IsRequired()` оставлен null в начальной строке, а не то, что ключ отсутствует. Исправление там это заполнить отсутствующее свойство, не являющееся ключом.

Если модель никогда не строится достаточно далеко, чтобы валидировать начальные данные, потому что EF Core даже не может найти ключ для типа, перед вами другая проблема: см. исправление для [the entity type requires a primary key to be defined](/ru/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/).

## Почему "просто задайте Id = 0 явно" не работает

Заманчивое неисправление это написать `new Country { Id = 0, Name = "USA" }` и предположить, что явность удовлетворит валидатор. Она не удовлетворяет. Для генерируемого хранилищем ключа EF Core сравнивает значение со значением по умолчанию для CLR, а `0` это *и есть* значение по умолчанию для `int`. Валидатор не может отличить ваш намеренный `0` от незаданного поля, поэтому он всё равно выбрасывает исключение. Единственные значения, которые проходят, это значения, отличные от значения по умолчанию: любой `int`, отличный от нуля, любой непустой `Guid`, любой составной, отличный от значения по умолчанию. Если вам действительно нужна строка с ключом `0`, это признак того, что ключ не должен генерироваться хранилищем; пометьте его `ValueGeneratedNever()`, и валидатор перестаёт применять правило "не ноль", потому что ключ теперь целиком ваша ответственность.

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - opt out of store generation, then 0 is allowed
modelBuilder.Entity<Country>(b =>
{
    b.Property(c => c.Id).ValueGeneratedNever();
    b.HasData(new Country { Id = 0, Name = "Unknown" });   // now valid
});
```

Это реальный паттерн для строки-сигнала "неизвестно", но делайте это осознанно: как только ключ становится `ValueGeneratedNever`, каждая будущая вставка в эту таблицу должна предоставлять собственный ключ, включая вставки во время выполнения из вашего приложения.

## Связанное

- [Как задать начальные данные с помощью UseSeeding и UseAsyncSeeding в EF Core 11](/ru/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) охватывает современный путь задания начальных данных во время выполнения, который полностью избегает этой ошибки.
- [Как задать начальные данные для связи многие-ко-многим в EF Core 11](/ru/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) проходит через `HasData` соединительной сущности, где эта ошибка часто всплывает.
- [Исправление: The entity type 'X' requires a primary key to be defined](/ru/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) это вышестоящая ошибка, когда EF Core даже не может обнаружить ключ.
- [Миграция с EF Core 6 на EF Core 11: критические изменения, которые действительно кусаются](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) охватывает, что ещё изменилось, если вы обновляете старую настройку задания начальных данных.

## Источники

- [Документация по data seeding](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) EF Core на Microsoft Learn: раздел "model managed data", его список ограничений ("значение первичного ключа должно быть указано, даже если обычно его генерирует база данных"), и альтернатива `UseSeeding`/`UseAsyncSeeding`.
- [dotnet/efcore #27871, "Warn when seeding with a 0 key"](https://github.com/dotnet/efcore/issues/27871): обсуждение командой случая нулевого ключа за этим исключением.
- [dotnet/EntityFramework.Docs #1528](https://github.com/dotnet/EntityFramework.Docs/issues/1528): обоснование отрицательных начальных ключей для таблиц на основе `IDENTITY`.
