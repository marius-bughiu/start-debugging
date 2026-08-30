---
title: "Fix: 23505: duplicate key value violates unique constraint при конкурентной вставке в EF Core"
description: "Проверка-затем-вставка в вашем обработчике не атомарна. Перехватывайте PostgresException с SqlState 23505 или сверните всё в одну инструкцию INSERT ... ON CONFLICT. EnableRetryOnFailure не поможет."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "postgresql"
  - "npgsql"
  - "concurrency"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert"
translatedBy: "claude"
translationDate: 2026-08-30
---

Ваш обработчик проверяет "существует ли уже такой email", ничего не находит и вставляет. Под нагрузкой два запроса делают это одновременно, оба ничего не находят, и Postgres отклоняет проигравшего на уровне индекса с кодом `23505`. Уникальный индекс тут не баг, а единственное, что этот баг поймало. Исправить можно двумя способами: свернуть чтение и запись в одну инструкцию `INSERT ... ON CONFLICT`, чтобы между ними не оставалось окна, либо оставить наивную вставку и перехватывать `DbUpdateException`, внутреннее исключение которой является `PostgresException` с `SqlState == PostgresErrorCodes.UniqueViolation`, а затем перечитывать строку, записанную победителем. Не хватайтесь за `EnableRetryOnFailure`: детектор временных ошибок Npgsql возвращает `false` для `23505`, поэтому слой отказоустойчивости просто пропустит исключение к вам.

Замечание о проверке фактов. Единственный SDK на этой машине -- .NET 10.0.302, и сервера Postgres на ней нет, поэтому всё приведённое ниже проверялось офлайн на `Npgsql` 10.0.3, `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 и `Microsoft.EntityFrameworkCore` 10.0.4 (значения констант, детектор временных исключений, генерируемый SQL, состояние change tracker), плюс документация PostgreSQL 18 для поведения на стороне сервера. Провайдер Npgsql 11.0 на момент написания всё ещё в предварительной версии, и его [примечания к выпуску 11.0](https://www.npgsql.org/efcore/release-notes/11.0.html) не содержат изменений в сопоставлении ошибок, в пакетировании `SaveChanges` или в детекторе повторов, так что всё это относится и к EF Core 11, и к провайдеру 11.0. Там, где утверждение взято из документации сервера, а не из запуска на этой машине, я это оговариваю.

## Ошибка в контексте

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Npgsql.PostgresException (0x80004005): 23505: duplicate key value violates unique constraint "IX_Users_Email"

DETAIL: Key ("Email")=(ada@example.com) already exists.
   at Npgsql.Internal.NpgsqlConnector.ReadMessageLong(...)
   at Npgsql.NpgsqlDataReader.NextResult(...)
   at Microsoft.EntityFrameworkCore.Update.Internal.BatchExecutor.ExecuteAsync(...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalDatabase.SaveChangesAsync(...)
```

Две вещи в этом блоке стоит прочитать внимательно.

Имя ограничения говорит, с каким именно сбоем вы имеете дело. `IX_Users_Email` -- это уникальный индекс, объявленный вами, значит перед вами состояние гонки на уровне приложения. Если же там `PK_Users`, у вас почти наверняка рассинхронизированная последовательность identity, а это совсем другая проблема, и она разбирается ниже.

Строка `DETAIL:` может отсутствовать полностью. Параметр строки подключения `Include Error Detail` в Npgsql по умолчанию равен `false` (проверено: `new NpgsqlConnectionStringBuilder("Host=h;Database=d").IncludeErrorDetail` возвращает `False` на Npgsql 10.0.3), поскольку текст детали содержит конфликтующее значение ключа, а это часто персональные данные. Добавьте `Include Error Detail=true` в разработке, если вам нужно значение, и оставьте его выключенным в продакшене, если вас не устраивает попадание ключей в журналы.

## Почему это происходит

Основная причина, и та, что совпадает с "воспроизводится только под нагрузкой": проверка, за которой следует вставка, -- это две инструкции с промежутком между ними. Ничто внутри транзакции `READ COMMITTED` не мешает другой сессии вставить строку в этот промежуток. Документация PostgreSQL о [проверках уникальности индексов](https://www.postgresql.org/docs/current/index-unique-checks.html) описывает поведение сервера, когда другая сессия ещё не зафиксировала транзакцию: "If a conflicting row has been inserted by an as-yet-uncommitted transaction, the would-be inserter must wait to see if that transaction commits." Если она откатится, конфликта нет и ваша вставка проходит; если зафиксируется, вы получаете `23505`. Именно поэтому ошибка приходит всплесками и никогда не воспроизводится на ноутбуке разработчика с одним запросом в полёте.

Ещё две причины дают тот же SQLSTATE, и их стоит исключить до того, как вы напишете хоть строку кода для работы с конкурентностью:

- **Рассинхронизированная последовательность.** После `pg_restore`, `COPY` или импорта данных с явными первичными ключами последовательность identity всё ещё указывает на 1, тогда как таблица уже содержит строки вплоть до 40 000. Тогда каждая вставка конфликтует по `PK_<Table>`. Решение -- `SELECT setval(pg_get_serial_sequence('"Users"', 'Id'), (SELECT MAX("Id") FROM "Users"));`, а не цикл повторов.
- **Повторный `SaveChanges` на том же `DbContext`.** Неудачный `SaveChangesAsync` ничего не отсоединяет. Я проверил это напрямую: после исключения `ChangeTracker.Entries()` по-прежнему сообщает о конфликтующей сущности в состоянии `Added`, `DbUpdateException.Entries` содержит ровно одну запись, а повторный вызов `SaveChangesAsync` на том же контексте бросает то же самое исключение. Любой повтор должен начинаться со свежего контекста.

## Минимальное воспроизведение

```csharp
// .NET SDK 10.0.302, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class User
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<User>().HasIndex(u => u.Email).IsUnique();
```

Эта модель порождает у провайдера Npgsql ровно такой DDL (`db.Database.GenerateCreateScript()`, запущено офлайн):

```sql
CREATE TABLE "Users" (
    "Id" integer GENERATED BY DEFAULT AS IDENTITY,
    "Email" text NOT NULL,
    "Name" text NOT NULL,
    CONSTRAINT "PK_Users" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX "IX_Users_Email" ON "Users" ("Email");
```

А вот обработчик, который проигрывает гонку:

```csharp
// Racy: the gap between AnyAsync and SaveChangesAsync is unguarded.
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    if (await db.Users.AnyAsync(u => u.Email == email, ct))
        throw new EmailTakenException(email);

    var user = new User { Email = email, Name = name };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);   // 23505 when a second request got here first
    return user;
}
```

Обернуть эти три инструкции в транзакцию не помогает. Транзакция даёт атомарность, а не взаимное исключение, и `READ COMMITTED` -- это уровень по умолчанию. Повышение уровня изоляции тоже не помогает: в части сценариев оно меняет получаемый SQLSTATE, но конфликт не исчезает. Страница PostgreSQL об [обработке сбоев сериализации](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) прямо разбирает этот шаблон, отмечая, что сбой уникального ключа после проверки уже сохранённых ключей "is effectively a serialization failure, but the server will not detect it as such because it cannot see the connection between the inserted value and the previous reads."

## Решение 1: одна инструкция с ON CONFLICT

Это то решение, к которому стоит обращаться первым. `INSERT ... ON CONFLICT` -- одна инструкция, поэтому окна для чужой вставки нет, а разрешение конфликта происходит внутри серверного пути вставки в индекс.

Тонкость в том, чтобы получить строку обратно. `ON CONFLICT DO NOTHING` при конфликте не возвращает ничего: [документация INSERT](https://www.postgresql.org/docs/current/sql-insert.html) утверждает, что `RETURNING` возвращает только успешно вставленные или обновлённые строки. Поэтому get-or-create, которому нужен id, использует `DO UPDATE` с самоприсваиванием, которое затрагивает строку и тем самым делает её подходящей для `RETURNING`:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3. Same code compiles unchanged on EF Core 11.
public async Task<int> GetOrCreateUserIdAsync(string email, string name, CancellationToken ct)
{
    var ids = await db.Database.SqlQuery<int>($"""
        INSERT INTO "Users" ("Email", "Name")
        VALUES ({email}, {name})
        ON CONFLICT ("Email") DO UPDATE SET "Email" = EXCLUDED."Email"
        RETURNING "Id" AS "Value"
        """).ToListAsync(ct);

    return ids.Single();
}
```

Четыре детали этого фрагмента несущие:

1. **`AS "Value"`.** `SqlQuery<T>` для скалярного типа читает столбец с именем `Value`. Без псевдонима вы получите ошибку времени выполнения об отсутствующем столбце, а не ошибку компиляции.
2. **Интерполированные вставки -- это параметры, а не конкатенация.** `ToQueryString()` для этого запроса выдаёт `VALUES (@p0, @p1)`, значения сообщаются отдельно, так что обычная тревога об инъекции здесь неуместна.
3. **`ToListAsync`, и никогда `FirstOrDefaultAsync`.** EF Core разбирает сырой SQL и отказывается компоновать поверх инструкции, которая не является `SELECT`. Добавление любого оператора LINQ бросает `InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable SQL and with a query composing over it.` Я наткнулся ровно на это, в `NpgsqlQuerySqlGenerator`, когда проверял генерируемый SQL. Сначала материализуйте список, потом выбирайте.
4. **`EXCLUDED` -- это предлагаемая строка.** `SET "Email" = EXCLUDED."Email"` -- намеренно бесполезная запись, единственная цель которой сделать конфликтующую строку подходящей для `RETURNING`.

Если id вам действительно не нужен, предпочтите `ON CONFLICT ("Email") DO NOTHING` и избегайте усиления записи. Вариант с самоприсваиванием пишет новую версию строки, увеличивает `xmax` и запускает все триггеры `BEFORE UPDATE` при каждой попытке дубликата.

Ещё одно ограничение, о котором документация говорит явно: `ON CONFLICT DO UPDATE` не затронет одну и ту же существующую строку дважды в пределах одной инструкции и вызовет нарушение кардинальности (`21000`), если ваш список `VALUES` содержит один и тот же ключ дважды. Удаляйте дубликаты из пакета на стороне C# перед отправкой.

## Решение 2: оптимистичная вставка, перехват 23505, повторное чтение

Когда вставка спрятана внутри более крупной единицы работы и переписывать её на сыром SQL непрактично, пусть индекс станет вашей блокировкой, а вы обработаете проигрыш:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    var user = new User { Email = email, Name = name };
    db.Users.Add(user);

    try
    {
        await db.SaveChangesAsync(ct);
        return user;
    }
    catch (DbUpdateException ex)
        when (ex.InnerException is PostgresException
              {
                  SqlState: PostgresErrorCodes.UniqueViolation,
                  ConstraintName: "IX_Users_Email"
              })
    {
        // Someone else won. This context is poisoned: the entity is still Added.
        await using var fresh = await factory.CreateDbContextAsync(ct);
        return await fresh.Users.SingleAsync(u => u.Email == email, ct);
    }
}
```

`PostgresErrorCodes.UniqueViolation` -- это строка `"23505"` (проверено на Npgsql 10.0.3), и константа лучше магической строки. Фильтруйте ещё и по `ConstraintName`. Блок catch с одним лишь `SqlState: "23505"` с радостью проглотит коллизию первичного ключа, вызванную рассинхронизированной последовательностью, и превратит сигнал о повреждении данных в тихий неверный ответ.

Свежий контекст важен, и именно поэтому этот шаблон сочетается с `IDbContextFactory<T>`, а не со scoped-`DbContext`. Если вы внедрите scoped-контекст и повторите на нём, вы заново отправите ту же сущность в состоянии `Added` и получите то же исключение -- это поведение я подтвердил выше на change tracker. То же самое верно, если вы [получаете DbContext из singleton-сервиса](/ru/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/).

## Почему EnableRetryOnFailure здесь бесполезен

Об это спотыкаются те, кто уже добавил отказоустойчивость подключения и полагает, что она покрывает этот случай. Не покрывает. Я вызвал собственный детектор провайдера напрямую через рефлексию на `Npgsql.EntityFrameworkCore.PostgreSQL.Storage.Internal.NpgsqlTransientExceptionDetector` из провайдера 10.0.3:

```text
ShouldRetryOn(23505) = False     unique_violation
ShouldRetryOn(23503) = False     foreign_key_violation
ShouldRetryOn(40001) = True      serialization_failure
ShouldRetryOn(40P01) = True      deadlock_detected
ShouldRetryOn(53300) = True      too_many_connections
ShouldRetryOn(57P03) = True      cannot_connect_now
ShouldRetryOn(08006) = True      connection_failure
```

`PostgresException.IsTransient` с этим согласуется: `False` для `23505`, `True` для `40001` и `40P01`. Такая классификация верна. Слепой повтор настоящего дубликата просто провалился бы снова, и так до бесконечности. Но это означает, что повтор должен быть вашим, на том уровне, где вы можете решить, что дубликат означает для этой операции. Если вы добавляете собственную стратегию выполнения вокруг ручной транзакции, помните об ошибке [стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/), с которой вы по пути столкнётесь.

## Решение 3: рекомендательная блокировка, когда get-or-create охватывает несколько инструкций

Иногда операцию действительно нельзя уместить в одну инструкцию: нужно создать арендатора, затем строку схемы, затем строку настроек по умолчанию, и сделать это может только один вызывающий. Сериализуйте по ключу, а не по таблице:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
await using var tx = await db.Database.BeginTransactionAsync(ct);

// Held until the transaction commits or rolls back. No explicit unlock.
await db.Database.ExecuteSqlAsync(
    $"SELECT pg_advisory_xact_lock(hashtext({email}))", ct);

var existing = await db.Users.SingleOrDefaultAsync(u => u.Email == email, ct);
if (existing is not null) { await tx.CommitAsync(ct); return existing; }

db.Users.Add(new User { Email = email, Name = name });
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

`pg_advisory_xact_lock` освобождается автоматически в конце транзакции, и это именно то свойство, которое вам нужно: ни один блок `finally` не сможет её утечь. Две оговорки. `hashtext` возвращает 32-битное значение, поэтому разные ключи могут столкнуться и без необходимости сериализоваться друг с другом -- это вопрос производительности и никогда не вопрос корректности. И работает это только если блокировку берут все писатели. Уникальный индекс всё равно оставьте: он страховка для той ветки кода, которая забудет.

## Варианты, которые выглядят так же, но таковыми не являются

**Вставка проходит поодиночке и падает в пакете.** EF Core объединяет несколько ожидающих вставок в один сетевой обмен внутри одной транзакции, поэтому единственный дубликат в любом месте пакета откатывает все добавленные вами строки. `DbUpdateException.Entries` говорит, какую сущность сервер отклонил; остальные не тронуты, но и не сохранены. Если вы вставляете тысячи строк, это одна из причин перейти на другой путь записи, который я измерял в [EF Core 11 против Dapper для массовых вставок](/ru/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

**Идентификаторы продолжают перескакивать после каждого сбоя.** Это ожидаемо и не исправляется. [Документация по функциям последовательностей](https://www.postgresql.org/docs/current/functions-sequence.html) однозначна: "the value obtained by `nextval` is not reclaimed for re-use if the calling transaction later aborts." Она также отдельно упоминает `ON CONFLICT`, поскольку кортеж вместе с вызовом `nextval` вычисляется до обнаружения конфликта. Каждая попытка дубликата сжигает один id. Если ваши ключи видны пользователю и пропуски неприемлемы, ответ -- другая стратегия ключей, а не последовательность без пропусков; см. [генерацию первичного ключа из последовательности базы данных](/ru/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/).

**Дубликаты в столбце, допускающем null, которые вы считали невозможными.** Обычный уникальный индекс считает значения `NULL` различными, поэтому `NULL` там может быть у сколь угодно многих строк. Если вам действительно нужна максимум одна такая строка, PostgreSQL 15 и новее поддерживает `CREATE UNIQUE INDEX ... ON "Users" ("ExternalId") NULLS NOT DISTINCT`. Учтите, что провайдер Npgsql 11.0 поднимает минимальную целевую версию по умолчанию до PostgreSQL 16, так что это доступно на любом сервере, на который текущий провайдер нацелен по умолчанию.

**`ON CONFLICT` падает с "there is no unique or exclusion constraint matching the ON CONFLICT specification".** Цель конфликта -- это вывод индекса, а не список столбцов. Если ваш уникальный индекс частичный (`WHERE "DeletedAt" IS NULL`), предикат нужно повторить: `ON CONFLICT ("Email") WHERE "DeletedAt" IS NULL DO NOTHING`. Либо назовите ограничение напрямую через `ON CONFLICT ON CONSTRAINT "IX_Users_Email"`, что полностью обходит вывод.

**Это конкурентное обновление, а не конкурентная вставка.** Если два вызывающих изменяют существующую строку, а не создают новую, `23505` -- неподходящий инструмент, и вам нужен токен конкурентности. Это другой механизм с другим исключением, разобранный в [оптимистичной конкурентности с токеном rowversion](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Как доказать это тестом

Состояние гонки, которое проявляется только под продакшен-нагрузкой, невозможно покрыть регрессионным тестом на однопоточном in-memory провайдере. Нужен настоящий сервер и два подключения. Поднимите контейнер с Postgres, получите два контекста из `IDbContextFactory<T>` и запустите обе вставки от одного барьера `TaskCompletionSource`, чтобы они состязались на индексе в один и тот же момент. Если обработчик корректен, обе задачи вернут один и тот же id и ни одна не бросит исключение. Компромиссы такой схемы по сравнению с подменённым хранилищем разобраны в [WebApplicationFactory против Testcontainers](/ru/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/).

Привычка, которую стоит выработать, меньше всего этого кода. Перехватив `DbUpdateException`, посмотрите на `SqlState` и `ConstraintName` прежде чем решать, что она означает. `23505` на уникальном индексе, который вы спроектировали, -- это ваша модель данных, делающая свою работу и сообщающая, что вызывающий проиграл гонку. `23505` на первичном ключе -- обычно сообщение базы данных о том, что что-то не так с самой таблицей.

## Похожие материалы

- [Как реализовать оптимистичную конкурентность с токеном rowversion в EF Core 11](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Как сгенерировать первичный ключ из последовательности базы данных при вставке в EF Core 11](/ru/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/)
- [Fix: The configured execution strategy does not support user-initiated transactions](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Как использовать IDbContextFactory из singleton-сервиса в Blazor](/ru/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/)
- [EF Core 11 против Dapper для массовых вставок: настоящий бенчмарк](/ru/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Источники

- [PostgreSQL 18: Index Uniqueness Checks](https://www.postgresql.org/docs/current/index-unique-checks.html)
- [PostgreSQL 18: Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
- [PostgreSQL 18: INSERT, включая ON CONFLICT и вывод уникальных индексов](https://www.postgresql.org/docs/current/sql-insert.html)
- [PostgreSQL 18: Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html)
- [PostgreSQL Error Codes: Class 23 Integrity Constraint Violation](https://www.postgresql.org/docs/current/errcodes-appendix.html)
- [Примечания к выпуску 11.0 провайдера Npgsql для EF Core](https://www.npgsql.org/efcore/release-notes/11.0.html)
- [EF Core: Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency)
