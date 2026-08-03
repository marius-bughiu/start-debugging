---
title: "Как реализовать оптимистичную конкурентность с токеном rowversion в EF Core 11"
description: "Добавляем токен конкурентности rowversion в EF Core 11: настройка через [Timestamp] и IsRowVersion, SQL, который EF действительно генерирует, перехват DbUpdateConcurrencyException, побеждает база vs побеждает клиент vs слияние, отсоединённые API с ETag и пять ловушек, которые молча отключают всю защиту."
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "rowversion"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Короткий ответ: добавьте в сущность свойство `byte[]`, пометьте его атрибутом `[Timestamp]` (или вызовите `.IsRowVersion()` в `OnModelCreating`), и EF Core 11 сопоставит его со столбцом `rowversion` в SQL Server и добавит `AND [RowVersion] = @original` в каждый UPDATE и DELETE, который генерирует для этой сущности. Если строку тем временем изменил кто-то другой, команда затрагивает ноль строк, и `SaveChangesAsync` выбрасывает `DbUpdateConcurrencyException`, которое вы перехватываете и разрешаете. Вся возможность занимает около шести строк конфигурации. Сложность в пяти способах случайно её отключить, не получив никакой ошибки.

В этой статье разбираются настройка, точный SQL и текст исключения, три стратегии разрешения конфликта, отсоединённый цикл веб-API, который большинство руководств пропускает, и ловушки, оставляющие вас с токеном, который ничего не защищает.

Замечание о том, как проверялись детали ниже. EF Core 11 требует среду выполнения .NET 11, а единственный SDK на этой машине -- .NET 10.0.201, поэтому запускаемые эксперименты выполнялись на `Microsoft.EntityFrameworkCore` 10.0.10 против SQLite, плюс генератор DDL провайдера SQL Server (он работает офлайн, без сервера). API токена конкурентности и форма генерируемого SQL не менялись между EF Core 8 и 11: [заметки о выпуске EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) не перечисляют изменений в токенах конкурентности, в обнаружении конфликтов `SaveChanges` или в `DbUpdateConcurrencyException`. Всё специфичное для EF Core 11 отмечено отдельно.

## Что на самом деле представляет собой столбец rowversion

`rowversion` -- это тип данных SQL Server, а не концепция EF Core. Согласно [документации по rowversion](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql), это 8 байт автоматически генерируемых уникальных двоичных данных. Для работы с конкурентностью важны три свойства:

- **Это счётчик, а не часы.** Он не хранит ни даты, ни времени. У каждой базы данных есть единственный счётчик, который увеличивается при любой вставке или обновлении в любой таблице со столбцом `rowversion`. Две строки в разных таблицах никогда не получат одно и то же значение, но вычесть одно значение из другого и получить прошедшее время нельзя.
- **В таблице может быть ровно один такой столбец.** Именно поэтому токен rowversion защищает строку целиком, а не подмножество столбцов.
- **Любой UPDATE увеличивает его, включая холостой.** Документация говорит об этом прямо: присвоение столбцу того значения, которое в нём уже есть, считается обновлением и увеличивает версию. "Сохранение", которое ничего не меняет, всё равно делает недействительными токены всех остальных читателей.

`timestamp` -- устаревший синоним того же типа. В DDL используйте `rowversion`. Что сбивает с толку, атрибут в EF Core по-прежнему называется `[Timestamp]`, потому что он появился до переименования.

## Настройка в четыре шага

1. **Добавьте в сущность свойство `byte[]`.** CLR-тип должен быть именно `byte[]`, чтобы провайдер SQL Server сопоставил его с `rowversion`. Имя любое; обычно выбирают `RowVersion` или `Version`.
2. **Пометьте его как версию строки.** Либо атрибутом `[Timestamp]`, либо через `.Property(p => p.RowVersion).IsRowVersion()` в `OnModelCreating`. Оба варианта равнозначны.
3. **Создайте миграцию и примените её.** EF генерирует `[RowVersion] rowversion NOT NULL`, а SQL Server заполнит каждую существующую строку при её следующем обновлении.
4. **Перехватывайте `DbUpdateConcurrencyException` в каждом месте, где эта сущность сохраняется.** Без этого шага вы лишь заменили молчаливую потерю обновления на ответ 500, что лучше, но ненамного.

Вот сущность в обоих вариантах:

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }

    [Timestamp]
    public byte[] RowVersion { get; set; } = default!;
}
```

```csharp
// Fluent equivalent, no attribute needed on the entity
protected override void OnModelCreating(ModelBuilder modelBuilder)
    => modelBuilder.Entity<Product>()
        .Property(p => p.RowVersion)
        .IsRowVersion();
```

Запуск генератора скрипта создания провайдера SQL Server для этой модели даёт:

```sql
CREATE TABLE [Products] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Price] decimal(18,2) NOT NULL,
    [RowVersion] rowversion NOT NULL,
    CONSTRAINT [PK_Products] PRIMARY KEY ([Id])
);
```

Интересен не DDL, а метаданные модели, которые EF из него выводит. Дамп `IProperty` для этого столбца даёт `colType=rowversion`, `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. Именно последний флаг стоит запомнить: EF Core никогда не запишет значение в этот столбец. Он исключает его из INSERT и UPDATE и считывает новое значение после. Столбцом полностью владеет база данных.

## SQL, который генерирует EF Core, и исключение при неудаче

Как только свойство становится токеном конкурентности, каждый UPDATE, который EF генерирует для сущности, несёт исходное значение в предложении `WHERE` рядом с ключом. На SQLite с токеном, управляемым приложением, форма ровно такая (получена через `LogTo` с фильтром на `RelationalEventId.CommandExecuted`):

```sql
UPDATE "Products" SET "Price" = @p0, "Version" = @p1
WHERE "Id" = @p2 AND "Version" = @p3
RETURNING 1;
```

На SQL Server команда должна ещё и прочитать заново сгенерированный `rowversion`, поскольку столбец имеет `ValueGenerated.OnAddOrUpdate`. Форма, задокументированная в [руководстве по конкурентности для Razor Pages](https://learn.microsoft.com/en-us/aspnet/core/data/ef-rp/concurrency), сочетает защищённый UPDATE с SELECT, обусловленным `@@ROWCOUNT`:

```sql
SET NOCOUNT ON;
UPDATE [Products] SET [Price] = @p0
WHERE [Id] = @p1 AND [RowVersion] = @p2;
SELECT [RowVersion]
FROM [Products]
WHERE @@ROWCOUNT = 1 AND [Id] = @p1;
```

Точная форма команды менялась между версиями EF Core и между провайдерами и будет меняться дальше. Стабильна семантика, и именно её стоит проверять в тесте: токен присутствует в `WHERE`, а результат в ноль строк превращается в исключение.

Если кто-то изменил строку после того, как вы её загрузили, предикат ничего не находит, возвращается ноль строк, и EF выбрасывает исключение. Сообщение стоит запомнить, потому что именно его вы будете искать в журналах:

```text
The database operation was expected to affect 1 row(s), but actually affected
0 row(s); data may have been modified or deleted since entities were loaded.
```

Два момента, которые часто понимают неверно. Во-первых, исключение бросается при обновлениях *и* удалениях, но практически никогда при вставках. Дублирующая вставка вместо этого даёт специфичное для провайдера исключение о нарушении уникальности. Во-вторых, "затронуто 0 строк" не различает "кто-то изменил" и "кто-то удалил". Это придётся выяснять при разрешении конфликта.

Если приведённый выше SQL не похож на то, что отправляет ваше приложение, быстрее всего выяснить, что оно отправляет *на самом деле*, можно, [записав в журнал SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), и прочитав предложение `WHERE` напрямую. Отсутствующее `AND [RowVersion] = ...` означает, что токен не настроен на том пути, на который вы рассчитываете.

## Разрешение конфликта: три стратегии, один цикл

`DbUpdateConcurrencyException` предоставляет `Entries` -- список объектов `EntityEntry`, чьи команды вернули неверное число строк. Каждая запись даёт три набора значений:

- `CurrentValues`: то, что вы пытались записать.
- `OriginalValues`: то, что вы прочитали до своих правок. Здесь и живёт устаревший токен.
- `GetDatabaseValuesAsync()`: то, что находится в базе данных прямо сейчас, запрошенное заново.

Каждая стратегия разрешения -- это правило комбинирования этих трёх наборов, за которым следует обновление `OriginalValues`, чтобы предложение `WHERE` повторной попытки использовало актуальный токен.

**Побеждает база данных** -- самый простой вариант и правильное значение по умолчанию для всего, на что смотрит человек: отбросить попытку, перезагрузить, сообщить пользователю. `entry.ReloadAsync()` делает это одним вызовом.

**Побеждает клиент** перезаписывает всё, что успело попасть в базу. Корректно только когда ваша запись авторитетна (административное переопределение, повтор канонического события), и является настоящей ошибкой во всех остальных случаях:

```csharp
// .NET 11, C# 14, EF Core 11
catch (DbUpdateConcurrencyException ex)
{
    foreach (var entry in ex.Entries)
    {
        var databaseValues = await entry.GetDatabaseValuesAsync();
        if (databaseValues is null)
        {
            // The row is gone. There is nothing to overwrite.
            throw new InvalidOperationException("Product was deleted by another user.");
        }

        // Keep CurrentValues as-is, but adopt the database's token so the
        // retried UPDATE targets the row as it exists now.
        entry.OriginalValues.SetValues(databaseValues);
    }

    await context.SaveChangesAsync();
}
```

**Слияние** -- вариант, который стоит писать, когда у сущности есть независимые поля. Возьмите значение из базы для каждого свойства, которое вы не трогали, оставьте своё для изменённых, и эскалируйте только при настоящем пересечении:

```csharp
// .NET 11, C# 14, EF Core 11
var saved = false;
while (!saved)
{
    try
    {
        await context.SaveChangesAsync();
        saved = true;
    }
    catch (DbUpdateConcurrencyException ex)
    {
        foreach (var entry in ex.Entries)
        {
            if (entry.Entity is not Product)
            {
                throw new NotSupportedException(
                    $"No conflict policy for {entry.Metadata.Name}.");
            }

            var proposed = entry.CurrentValues;
            var database = await entry.GetDatabaseValuesAsync()
                ?? throw new InvalidOperationException("Row was deleted.");
            var original = entry.OriginalValues;

            foreach (var property in proposed.Properties)
            {
                // Skip the token itself: it is byte[], so Equals compares
                // references, and it is refreshed wholesale below anyway.
                if (property.IsConcurrencyToken) continue;

                var mine = proposed[property];
                var theirs = database[property];
                var wasLoaded = original[property];

                // I did not touch this column: take theirs.
                if (Equals(mine, wasLoaded))
                {
                    proposed[property] = theirs;
                }
                // Both of us changed it to different values: real conflict.
                else if (!Equals(theirs, wasLoaded) && !Equals(mine, theirs))
                {
                    throw new InvalidOperationException(
                        $"Conflicting edits to {property.Name}.");
                }
            }

            entry.OriginalValues.SetValues(database);
        }
    }
}
```

Цикл `while (!saved)` -- это форма, которую рекомендует [документация EF Core по конкурентности](https://learn.microsoft.com/en-us/ef/core/saving/concurrency), и это действительно цикл: ваша повторная попытка может проиграть гонку второй раз. В продакшене ограничьте число попыток, потому что неограниченный повтор против горячей строки -- это livelock.

Одно взаимодействие, за которым стоит следить: если вы включили `EnableRetryOnFailure`, повтор происходит внутри `SqlServerRetryingExecutionStrategy`, и оборачивание этого цикла в ручной `BeginTransaction` завершится ошибкой, описанной в статье [стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). Вместо этого используйте `strategy.ExecuteAsync(...)` вокруг всей единицы работы.

## Отсоединённый цикл, где обычно всё и ломается

Приведённый выше пример с одним контекстом -- не то, что делает ваш API. Ваш API загружает товар в одном запросе, отдаёт его браузеру и получает правку через десять минут в совершенно другом `DbContext`. Токен должен пережить это путешествие.

`byte[]` сериализуется в base64 в `System.Text.Json`, поэтому передача через DTO работает без специальной обработки. Идиоматичная форма для HTTP -- это ETag: возвращайте токен в base64 как заголовок ответа `ETag` при GET, требуйте его как `If-Match` при PUT и отвечайте `412 Precondition Failed`, когда он не совпадает.

На стороне записи ключевая строка -- явное присваивание `OriginalValue`. EF не знает, как выглядела строка, когда её прочитал клиент, поэтому сказать об этом должны вы:

```csharp
// .NET 11, C# 14, EF Core 11
app.MapPut("/products/{id:int}", async (
    int id, ProductDto dto, [FromHeader(Name = "If-Match")] string? ifMatch,
    AppDbContext db) =>
{
    if (string.IsNullOrEmpty(ifMatch)) return Results.BadRequest("If-Match required.");

    var product = await db.Products.FindAsync(id);
    if (product is null) return Results.NotFound();

    product.Name = dto.Name;
    product.Price = dto.Price;

    // Overwrite the token EF loaded with the one the client actually saw.
    db.Entry(product).Property(p => p.RowVersion).OriginalValue =
        Convert.FromBase64String(ifMatch.Trim('"'));

    try
    {
        await db.SaveChangesAsync();
        return Results.Ok(new { eTag = Convert.ToBase64String(product.RowVersion) });
    }
    catch (DbUpdateConcurrencyException)
    {
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);
    }
});
```

Обратите внимание, что здесь строка намеренно запрашивается заранее. Запрос можно пропустить, применив `Attach` вместе с `EntityState.Modified`, это на один обход меньше, но тогда записывается каждый столбец, изменился он или нет. Я проверил, что оба пути ведут себя одинаково по отношению к токену: в воспроизведении на SQLite присваивание `OriginalValue` присоединённой и ни разу не запрошенной сущности дало то же самое защищённое токеном предложение `WHERE`, что и путь с предварительным запросом, и сохранение прошло чисто.

## Пять способов молча отключить токен конкурентности

**Забыть перенести исходный токен.** Если отсоединённая сущность приходит со значением токена по умолчанию или пустым и вы вызываете `context.Update(entity)`, EF берёт значение *на объекте* как исходное. Сгенерированный SQL превращается в `WHERE "Id" = @p3 AND "Version" = @p4` с полностью нулевым `@p4`, который не совпадает ни с чем, и абсолютно каждое сохранение выбрасывает `DbUpdateConcurrencyException`. Именно это я воспроизвёл на EF Core 10.0.10. Такой отказ шумный, и это удача, потому что противоположная ошибка молчалива.

**Использовать провайдер без rowversion.** Здесь ошибки нет вообще. На SQLite `[Timestamp]` на `byte[]` даёт столбец `BLOB NULL`, помеченный как `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. EF, следовательно, никогда его не пишет, SQLite никогда его не генерирует, и значение навсегда остаётся `null`. Сгенерированный UPDATE вырождается в:

```sql
UPDATE "Products" SET "Price" = @p0
WHERE "Id" = @p1 AND "RowVersion" IS NULL
RETURNING "RowVersion";
```

`IS NULL` совпадает каждый раз. Вы получаете столбец в форме токена, нулевую защиту и ни одного предупреждения. Проверено на EF Core 10.0.10 с `Microsoft.EntityFrameworkCore.Sqlite`. Если ваши интеграционные тесты идут на SQLite, а продакшен работает на SQL Server, ваши тесты конкурентности проходят по неверной причине.

Решение для провайдеров без нативного самообновляющегося столбца -- токен, управляемый приложением: `Guid` с атрибутом `[ConcurrencyCheck]` (или `.IsConcurrencyToken()`), который вы сами присваиваете при каждом сохранении. PostgreSQL -- исключение, которому не нужно ни то ни другое: Npgsql сопоставляет свойство `uint` с атрибутом `[Timestamp]` или настроенное через `.IsRowVersion()` с системным столбцом `xmin`, который движок обновляет автоматически.

**Поставить `[Timestamp]` на неверный CLR-тип.** EF Core не проверяет это при построении модели. Я поставил `[Timestamp]` на `long`, и провайдер SQL Server бодро сгенерировал `[RowVersion] bigint NOT NULL` с `IsConcurrencyToken=True` и `ValueGenerated=OnAddOrUpdate`. SQL Server не сопровождает обычные столбцы `bigint`, а EF велено их не писать, так что это значение никогда ничем не изменяется. Только `byte[]` сопоставляется с настоящим типом `rowversion`.

**Писать через `ExecuteUpdate` или `ExecuteDelete`.** Они полностью обходят отслеживание изменений, а вместе с ним и проверку конкурентности. Генерируемый SQL содержит только ваш предикат:

```sql
UPDATE "Products" AS "p"
SET "Price" = ef_add("p"."Price", '1.0')
WHERE "p"."Name" = 'B'
```

Ни токена, ни исключения, одна затронутая строка. Если нужна оптимистичная конкурентность на массовом пути, придётся сделать её вручную: поместить токен в `Where` и сравнить возвращённое число затронутых строк с ожидаемым. Этот компромисс, и когда какой путь записи верен, разбирается в статье [ExecuteUpdate против загрузки сущностей и SaveChanges](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

**Сравнивать токены через `==` в C#.** `byte[]` использует сравнение по ссылке. Два массива с одинаковыми байтами не равны. Используйте `SequenceEqual` или сравнивайте строки base64 всякий раз, когда проверяете токен в коде приложения. Сам EF сравнивает на стороне SQL, так что это бьёт только по вашей собственной логике проверки.

## Когда токен уровня строки слишком груб

`rowversion` защищает строку целиком. Два пользователя, редактирующие действительно независимые поля одной записи (один исправляет опечатку в описании, другой корректирует остаток на складе), сталкиваются, хотя реального конфликта нет. На горячей записи это поток ложных 412.

Два выхода. Используйте стратегию слияния выше, чтобы ложные конфликты разрешались автоматически и наверх всплывали только настоящие пересечения. Либо перейдите на токен, управляемый приложением, который вы пересоздаёте только при изменении важных для вас свойств, что можно централизовать в перехватчике `SaveChanges` того рода, что описан в статье [перехватчики EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/). Цена второго варианта в том, что решение "имеет ли это изменение значение?" теперь навсегда ваше, для каждого добавляемого свойства.

Альтернатива более высокого уровня -- уровень изоляции транзакции. Snapshot в SQL Server или repeatable read в PostgreSQL поднимут ошибку сериализации, когда запись вашей транзакции конфликтует с уже зафиксированной, вообще без токена в модели. Это проще и становится неверным инструментом ровно в тот момент, когда в процессе участвует человек, потому что транзакции пришлось бы оставаться открытой всё время его раздумий. Токены конкурентности существуют именно для того, чтобы "транзакция" могла охватить обход HTTP и перерыв на кофе.

## Похожие статьи

- [ExecuteUpdate против загрузки сущностей и SaveChanges в EF Core](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Как записать в журнал SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Как использовать перехватчики EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Fix: стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: экземпляр типа сущности не может отслеживаться, потому что уже отслеживается другой экземпляр с тем же значением ключа](/ru/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Источники

- [Handling concurrency conflicts](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) на Microsoft Learn -- семантика токена, три набора значений и цикл повторов.
- [rowversion (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql) -- 8-байтовый счётчик, правило "один на таблицу", поведение при холостом UPDATE и объявление `timestamp` устаревшим.
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities) -- `Update` против `Attach` и `CurrentValues.SetValues`.
- [What's new in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) -- подтверждает, что EF11 требует среду выполнения .NET 11, и не перечисляет изменений в токенах конкурентности.
- [Npgsql concurrency tokens](https://www.npgsql.org/efcore/modeling/concurrency.html) -- сопоставление с `xmin` в PostgreSQL.
