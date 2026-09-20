---
title: "Как гарантировать идемпотентную обработку сообщений в EF Core 11, когда одно и то же сообщение получают два экземпляра приложения"
description: "Проверка на существование в обработчике не та защита, за которую вы её принимаете. Поставьте уникальный индекс на таблицу inbox, пишите маркер в том же SaveChanges, что и бизнес-изменение, и пусть победителя выбирает база данных. Плюс ловушка с ExecuteUpdate, которая молча сводит всё это на нет."
pubDate: 2026-09-20
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "messaging"
  - "idempotency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table"
translatedBy: "claude"
translationDate: 2026-09-20
---

Короткий ответ: перестаньте полагаться на `if (await db.Inbox.AnyAsync(...)) return;`. Оба экземпляра могут выполнить эту проверку до того, как хоть один из них зафиксирует транзакцию, и оба обработают сообщение. Вместо этого поставьте на таблицу inbox уникальный индекс по ключу дедупликации, добавьте строку-маркер в трекер изменений вместе с бизнес-изменением и дайте одному вызову `SaveChangesAsync` зафиксировать либо и то и другое, либо ничего. Экземпляр, проигравший гонку, получит `DbUpdateException`, внутреннее исключение которого это нарушение уникальности, что означает "кто-то уже это сделал", поэтому он подтверждает сообщение и выходит. Идемпотентным обработчик делает база данных, а не ваш `if`.

В статье подробно разобраны сама гонка, исправление из четырёх шагов вместе с SQL, который EF Core 11 действительно формирует, как отличить дубликат сообщения от настоящего нарушения ограничения, двухфазный вариант для побочных эффектов, которые не могут участвовать в транзакции базы данных, и три ошибки, которые молча отключают всю схему.

Замечание о версиях и проверке. EF Core 11 требует среды выполнения .NET 11 и выходит вместе с .NET 11 в ноябре 2026, согласно [странице релизов EF Core](https://learn.microsoft.com/en-us/ef/core/what-is-new/). Всё приведённое ниже выполнялось на `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 на SDK .NET 11 RC 1. Ни SQL Server, ни PostgreSQL на этой машине нет, поэтому запуски с конкурентным доступом сделаны на провайдере SQLite с двумя подключениями к одному файлу базы данных, а вывод для SQL Server получен офлайн через `GenerateCreateScript()` и перехватчик, подавляющий подключение. Там, где утверждение опирается на серверное поведение, которое я не мог выполнить, я это оговариваю и ссылаюсь на документацию поставщика.

## Почему проверка на существование не является защитой

At-least-once это гарантия доставки, которую вы получаете от Azure Service Bus, RabbitMQ, Kafka и SQS. Страница Microsoft [о паттерне Idempotent Consumer](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer) перечисляет три пути, которыми до вас доходит дубликат: производитель повторил отправку, подтверждение которой было потеряно; брокер доставил сообщение повторно после истечения вашей блокировки; или ваш процесс упал между записью в базу данных и подтверждением.

Ничего экзотического в этом нет. Перезапуск пода при поэтапном развёртывании порождает все три случая. А поскольку реплик у вас несколько, повторная доставка приходит не на тот же экземпляр: она достаётся любому свободному потребителю, который в этот самый момент может обрабатывать исходную копию.

Вот обработчик, который почти все пишут первым:

```csharp
// EF Core 11.0.0-rc.1, .NET 11. This is the version that does not work.
public async Task Handle(CreditRequested msg, CancellationToken ct)
{
    if (await db.Inbox.AnyAsync(m => m.MessageId == msg.MessageId && m.Consumer == "credit", ct))
        return;

    db.Credits.Add(new Credit { Amount = msg.Amount });
    db.Inbox.Add(new InboxMessage
    {
        MessageId = msg.MessageId,
        Consumer = "credit",
        ReceivedUtc = DateTime.UtcNow
    });

    await db.SaveChangesAsync(ct);
}
```

Два экземпляра, один идентификатор сообщения, промежуток в 50 ms между проверкой и сохранением и таблица inbox с обычным неуникальным индексом:

```text
### 1. check-then-insert, no unique index, two concurrent consumers
  B: committed
  A: committed
  credits applied = 2, total = 200.0
  inbox rows = 2
```

Оба читателя увидели пустой inbox, оба записали маркер, оба зачислили сумму на счёт. Теперь таблица маркеров откровенно врёт: она утверждает, что сообщение обработано, причём дважды.

## Исправление в четыре шага

1. Поставьте на таблицу inbox уникальный индекс по идентификатору сообщения вместе с идентификатором потребителя, чтобы база данных могла отклонить второго писателя.
2. Добавьте строку-маркер и бизнес-изменение в один и тот же `DbContext` и зафиксируйте их одним вызовом `SaveChangesAsync`, чтобы они попали в базу вместе или не попали вовсе.
3. Перехватывайте `DbUpdateException`, внутреннее исключение которого это нарушение уникальности именно по этому индексу, и трактуйте его как "другой экземпляр уже обработал это сообщение".
4. Подтверждайте сообщение и на пути с фиксацией, и на пути с перехваченным дубликатом, а возвращайте его брокеру только при необработанном исключении.

### 1. Поставьте на таблицу inbox уникальный индекс по ключу дедупликации

Ключ это идентичность сообщения плюс идентичность потребителя. Часть с потребителем важна, когда на один канал подписаны несколько независимых обработчиков: при ключе только по сообщению первый же обработчик, записавший маркер, подавит все остальные.

```csharp
// EF Core 11.0.0-rc.1
public class InboxMessage
{
    public long Id { get; set; }               // surrogate, keeps the clustered index sequential
    public Guid MessageId { get; set; }
    public string Consumer { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime? ProcessedUtc { get; set; }
}

protected override void OnModelCreating(ModelBuilder b)
{
    var inbox = b.Entity<InboxMessage>();
    inbox.HasKey(m => m.Id);
    inbox.Property(m => m.Consumer).HasMaxLength(200).IsRequired();
    inbox.HasIndex(m => new { m.MessageId, m.Consumer }).IsUnique();
}
```

`GenerateCreateScript()` на провайдере SQL Server даёт вот что:

```sql
CREATE TABLE [Inbox] (
    [Id] bigint NOT NULL IDENTITY,
    [MessageId] uniqueidentifier NOT NULL,
    [Consumer] nvarchar(200) NOT NULL,
    [ReceivedUtc] datetime2 NOT NULL,
    [ProcessedUtc] datetime2 NULL,
    CONSTRAINT [PK_Inbox] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Inbox_MessageId_Consumer] ON [Inbox] ([MessageId], [Consumer]);
```

Не поддавайтесь соблазну сделать `MessageId` первичным ключом. В SQL Server первичный ключ по умолчанию кластеризованный, а кластеризованный индекс по случайному `uniqueidentifier` фрагментирует таблицу при каждой вставке. Ключ `bigint IDENTITY` с уникальностью, вынесенной в отдельный индекс, удерживает вставки в конце кучи. Ровно такую форму [MassTransit](https://masstransit.massient.com/documentation/configuration/middleware/outbox) использует для собственной сущности `InboxState`: поле `long Id`, описанное в исходном коде как "Primary key for table, to have ordered clustered index", и пара для дедупликации, объявленная через `HasAlternateKey(p => new { p.MessageId, p.ConsumerId })`.

### 2. Пишите маркер в том же SaveChanges, что и бизнес-изменение

Не до него и не после. [Документация EF Core по транзакциям](https://learn.microsoft.com/en-us/ef/core/saving/transactions) говорит прямо: "все изменения в рамках одного вызова `SaveChanges` применяются в транзакции. Если какое-либо из изменений не удаётся, транзакция откатывается и ни одно из изменений не применяется к базе данных".

Я проверил это с помощью `DbTransactionInterceptor`. Один `SaveChangesAsync`, который обновляет счёт и вставляет маркер, порождает на SQLite `BEGIN, COMMIT` вокруг такой пары инструкций:

```sql
UPDATE "Accounts" SET "Balance" = @p0
WHERE "Id" = @p1
RETURNING 1;

INSERT INTO "Inbox" ("Consumer", "MessageId", "ProcessedUtc", "ReceivedUtc")
VALUES (@p0, @p1, @p2, @p3)
RETURNING "Id";
```

На SQL Server то же сохранение отправляет:

```sql
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Inbox] ([Consumer], [MessageId], [ProcessedUtc], [ReceivedUtc])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1, @p2, @p3);
```

Чтобы доказать принцип "всё или ничего", а не принимать его на веру, я добавил в то же сохранение заведомо обречённую вставку. Маркер в базу так и не попал:

```text
### 3. marker + business write in one SaveChanges: all or nothing
  SaveChanges threw SqliteException
  inbox rows after failure = 0 (marker rolled back with the business write)
```

Одна оговорка, о которой стоит знать: значение по умолчанию `AutoTransactionBehavior.WhenNeeded` означает, что EF открывает явную транзакцию только тогда, когда сохранению требуется больше одной инструкции. Это правильное значение по умолчанию, но оно означает, что атомарность, на которую вы полагаетесь, возникает из решения EF о том, что транзакция нужна. Если вы поставите `AutoTransactionBehavior.Never`, документация предупреждает, что "более ранние команды могли быть уже зафиксированы, оставив в базе данных частичные изменения". Не ставьте это в обработчике сообщений.

### 3. Перехватите нарушение уникальности и трактуйте его как "уже обработано"

Дешёвую проверку на существование в начале оставьте. Это быстрый путь для обычного случая, когда повторная доставка приходит спустя минуты, и он экономит откаченную транзакцию. Просто это не гарантия корректности. Гарантия это блок catch:

```csharp
// EF Core 11.0.0-rc.1, SQL Server + PostgreSQL
try
{
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    // another instance committed this message first; its transaction already
    // applied the business change, so there is nothing left to do
    return;
}

static bool IsInboxDuplicate(DbUpdateException ex) => ex.InnerException switch
{
    SqlException s => (s.Number == 2601 || s.Number == 2627)
                      && s.Message.Contains("IX_Inbox_MessageId_Consumer", StringComparison.Ordinal),
    PostgresException p => p.SqlState == PostgresErrorCodes.UniqueViolation
                           && p.ConstraintName == "IX_Inbox_MessageId_Consumer",
    _ => false
};
```

Запуск исправленного обработчика в той же гонке двух экземпляров:

```text
### 2. same handler, unique index on (MessageId, Consumer)
  A: committed
  B: DbUpdateException / SqliteException code=19 ext=2067
         inner message: SQLite Error 19: 'UNIQUE constraint failed: Inbox.MessageId, Inbox.Consumer'.
  credits applied = 1, total = 100.0
  inbox rows = 1
```

Одно зачисление, один маркер, и проигравший узнал об этом чисто.

### 4. Подтверждайте сообщение на обоих путях

И фиксация, и перехваченный дубликат это конечные исходы: завершайте сообщение. Возвращать его брокеру должно только необработанное исключение, чтобы брокер доставил его повторно. Если сделать наоборот и возвращать сообщение при дубликате, получится сообщение, которое ходит туда-сюда, пока не попадёт в очередь недоставленных.

## Что делает база данных, пока оба экземпляра вставляют строку

Интересен не тот случай, который показывает мой запуск на SQLite, где проигравший падает сразу. Интересен тот, где две вставки перекрываются: экземпляр A вставил маркер, но ещё не зафиксировал транзакцию, а экземпляр B пытается вставить ту же пару.

Документация PostgreSQL о [проверках уникальности индекса](https://www.postgresql.org/docs/18/index-unique-checks.html) описывает ровно то, что происходит: "Если конфликтующая строка вставлена ещё не зафиксированной транзакцией, потенциальный вставляющий должен подождать и посмотреть, зафиксируется ли та транзакция. Если она откатится, конфликта нет. Если она зафиксируется, не удалив конфликтующую строку, налицо нарушение уникальности".

Эта блокировка и есть нужное поведение, а не проблема, которую надо убрать настройками. B не узнаёт свою судьбу, пока транзакция A не разрешится. Если A фиксируется, B получает `23505` и может безопасно пропустить сообщение, зная, что бизнес-изменение сохранено надёжно. Если A откатывается, потому что обработчик выбросил исключение или под умер посреди транзакции, вставка B проходит и B обрабатывает сообщение, чего вы и хотите. SQL Server ведёт себя так же при уровне изоляции read committed по умолчанию, удерживая B на блокировке ключа индекса, пока A не разрешится. Запустить здесь ни тот, ни другой сервер я не мог, поэтому эти два предложения стоит воспринимать как документированное поведение, а не как измеренное мной.

## Как отличить дубликат сообщения от настоящей ошибки

Проверка `IsInboxDuplicate` выше сопоставляет имя индекса, и это сделано намеренно. Обработчик сообщений, пишущий бизнес-строки, обычно пишет в таблицы, у которых есть собственные ограничения уникальности: номер заказа, адрес электронной почты, ключ идемпотентности платежа. Если ваш блок catch проглатывает любое нарушение уникальности, настоящая ошибка в данных при бизнес-записи будет сообщена брокеру как "уже обработано", и сообщение исчезнет.

Насколько провайдер вам помогает, зависит от провайдера. Я прошёлся рефлексией по типам исключений:

```text
### 10. does the provider exception name the constraint?
  SqliteException: SqliteErrorCode, SqliteExtendedErrorCode, SqlState
  SqlException: Errors, Number, SqlState
```

Щедрее всех Npgsql. `PostgresException` предоставляет `SqlState`, `TableName`, `ColumnName` и `ConstraintName` (проверено на Npgsql 10.0.3), так что ограничение можно сопоставить по имени без разбора строк. `SqlException` даёт вам `Number` и больше ничего структурированного, поэтому имя индекса приходится искать в тексте сообщения. `SqliteException` даёт `SqliteErrorCode` 19 и `SqliteExtendedErrorCode` 2067, а список столбцов есть только в сообщении.

О двух номерах ошибок SQL Server: 2601 это "Cannot insert duplicate key row in object '%.\*ls' with unique index '%.\*ls'", а 2627 это "Violation of %ls constraint '%.\*ls'. Cannot insert duplicate key in object '%.\*ls'", согласно [справочнику ошибок репликации](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)) от Microsoft. Какой из них вы получите, зависит от того, как вы объявили уникальность. `HasIndex(...).IsUnique()` формирует `CREATE UNIQUE INDEX`, а `HasAlternateKey(...)` формирует табличное ограничение:

```sql
CONSTRAINT [AK_Inbox_MessageId_Consumer] UNIQUE ([MessageId], [Consumer])
```

Перехватывайте оба номера и сопоставляйте имя, и тогда вам не важно, какой из вариантов породила ваша модель.

## Три способа молча всё сломать

**`ExecuteUpdate` и `ExecuteDelete` не являются частью сохранения.** Они немедленно выполняют собственную инструкцию, вне какой бы то ни было транзакции, которую `SaveChanges` откроет позже. У обработчика, который зачисляет сумму на счёт через `ExecuteUpdateAsync`, а затем добавляет маркер в inbox, атомарности нет вообще:

```text
### 9. ExecuteUpdate commits on its own, before SaveChanges runs
  marker rejected as duplicate
  balance = 100 (the credit stuck even though the marker was rejected)
```

Обнаружение дубликата сработало идеально, а деньги всё равно ушли. Если вам нужна производительность массового обновления, откройте явную транзакцию через `BeginTransactionAsync`, выполните внутри неё `ExecuteUpdateAsync` и `SaveChangesAsync` и зафиксируйте её один раз.

**Повтор на том же `DbContext` повторяет ту же обречённую вставку.** После неудачного сохранения трекер изменений держит каждую сущность в том состоянии, в котором она была до сохранения:

```text
### 4. change-tracker state after a duplicate-key failure
  InboxMessage  state = Added
  Account       state = Modified
  retry on same context: threw again (SqliteException)
```

Любой повтор должен начинаться с нового scope и нового контекста. На практике это значит, что повтор живёт на уровне насоса сообщений, а не внутри обработчика.

**Стратегия выполнения с повторами плюс явная транзакция дают исключение.** Как только вы берётесь за `BeginTransactionAsync`, чтобы решить проблему с `ExecuteUpdate` выше, `EnableRetryOnFailure` начинает возражать. Этому сбою посвящена отдельная статья: [настроенная стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). Решение это `ExecuteAsync` на стратегии, оборачивающий всю транзакцию целиком, чтобы повтор проигрывал её заново.

## Побочные эффекты, которые не могут участвовать в транзакции

Отправку письма, списание с карты или запись в блоб-хранилище нельзя откатить вместе с вашей транзакцией базы данных. Работающий приём это двухфазная заявка: вставить маркер и зафиксировать, затем выполнить внешнюю работу, затем записать результат.

```csharp
// EF Core 11.0.0-rc.1
db.Inbox.Add(new InboxMessage { MessageId = msg.MessageId, Consumer = "email", ReceivedUtc = DateTime.UtcNow });
try
{
    await db.SaveChangesAsync(ct);          // phase 1: claim the message
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    return;                                  // someone else owns this one
}

await emailer.SendAsync(msg, ct);            // the side effect, outside any transaction

await db.Inbox
    .Where(m => m.MessageId == msg.MessageId && m.Consumer == "email")
    .ExecuteUpdateAsync(s => s.SetProperty(m => m.ProcessedUtc, DateTime.UtcNow), ct);
```

Два конкурирующих экземпляра, один внешний вызов:

```text
### 7. two-phase claim: insert marker, commit, then call the API
  A: won the claim, called the API, marked processed (rows=1)
  B: lost the claim, skipping the API call
  external API calls = 1
```

Обратите внимание, что это даёт, а что нет. Дублирующий вызов такой подход убирает. Падение между фиксацией и отправкой он не переживает: у вас остаётся занятая строка, у которой `ProcessedUtc` равен null, и никакой возможности узнать, ушло письмо или нет. Рекомендация Microsoft состоит в том, что запись в работе "сигнализирует, что предыдущая попытка могла быть выполнена частично", и что устаревшие записи нужно сверять или направлять на ручной разбор. Практический ответ это сделать идемпотентным и нижележащий вызов, передавая тот же `MessageId` в качестве ключа идемпотентности провайдера, а затем дать фоновой задаче повторять заявки старше заданного порога.

## Выбор ключа и очистка

Ключ дедупликации должен быть стабильным при повторных доставках. Подходят `MessageId` из Azure Service Bus и пара `source` плюс `id` из CloudEvents. `CorrelationId` не подходит, потому что он идентифицирует переписку и его разделяют несколько сообщений. Не подходят и счётчики попыток доставки или метки времени получения. В Kafka, где брокер не назначает идентификатор сообщения, тройка из топика, партиции и смещения стабильна для конкретной записи; заголовок, выставленный производителем, лучше, если он у вас есть.

Таблица inbox растёт бесконечно, если её не подчищать, а слишком ранняя очистка снова открывает окно. Держите строку дольше, чем брокер ещё способен повторно доставить оригинал: это таймаут блокировки или видимости, умноженный на максимальное число доставок, плюс время жизни сообщения, плюс запас на сообщения, которые оператор через недели переотправит из очереди недоставленных. Достаточно ночного `ExecuteDeleteAsync` по условию `ReceivedUtc < cutoff`, и это один из редких случаев, когда выполнение `ExecuteDelete` вне транзакции это именно то, что нужно.

Всё это не бесплатно в сопровождении, поэтому от приёма стоит отказаться, когда операция идемпотентна сама по себе. Upsert по бизнес-идентификатору или запись, которая выставляет абсолютное значение вместо применения дельты, не требуют inbox вообще. Если вы уже на MassTransit, `AddInboxStateEntity()` и соседние методы дают ту же механику с настраиваемым `DuplicateDetectionWindow` и службой доставки, на `MassTransit.EntityFrameworkCore` 9.2.2.

Самостоятельная реализация это таблица, индекс, один блок catch и задача очистки. Ошибаются люди никогда не в таблице. Ошибаются в вере, что работу делал тот `if` в начале обработчика.

### Читайте дальше

- [Fix: 23505: duplicate key value violates unique constraint при конкурентной вставке в EF Core](/ru/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/)
- [Как реализовать оптимистичную конкурентность с токеном rowversion в EF Core 11](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Как использовать пессимистичную блокировку с UPDLOCK и SELECT ... FOR UPDATE в EF Core 11](/ru/2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11/)
- [Исправление: настроенная стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [BackgroundService vs IHostedService vs Hangfire для фоновых задач в .NET 11](/ru/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)

### Источники

- [Паттерн Idempotent Consumer](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer), Azure Architecture Center
- [Транзакции в EF Core](https://learn.microsoft.com/en-us/ef/core/saving/transactions), документация EF Core
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), документация EF Core
- [PostgreSQL 18: Unique Index Checks](https://www.postgresql.org/docs/18/index-unique-checks.html)
- [Ошибки 2601 и 2627 в справочнике ошибок репликации](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)), Microsoft Learn
- [Настройка Transactional Outbox](https://masstransit.massient.com/documentation/configuration/middleware/outbox), документация MassTransit
- [`InboxState.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Persistence/MassTransit.EntityFrameworkCoreIntegration/EntityFrameworkCoreIntegration/InboxState.cs), MassTransit
