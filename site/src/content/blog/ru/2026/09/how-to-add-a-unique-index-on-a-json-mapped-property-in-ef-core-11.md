---
title: "Как добавить уникальный индекс на JSON-сопоставленное свойство в EF Core 11 (SQL Server и SQLite)"
description: "HasIndex(...).IsUnique() на члене ToJson() не обеспечивает уникальность в EF Core 11 RC 1: SQL Server отбрасывает IsUnique, а SQLite индексирует весь документ. Вынесите значение JSON в вычисляемый столбец и поставьте уникальный индекс на него."
pubDate: 2026-09-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "sqlite"
  - "json"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/how-to-add-a-unique-index-on-a-json-mapped-property-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-27
---

Короткий ответ: в EF Core 11 RC 1 не ставьте `IsUnique()` на индекс по члену комплексного свойства `ToJson()`. Он не делает того, что обещает модель. На SQL Server EF генерирует `CREATE JSON INDEX`, у которого нет уникальной формы, и молча отбрасывает `IsUnique()`. На SQLite EF генерирует `CREATE UNIQUE INDEX ... ("Contact")`, то есть индексирует весь JSON-документ целиком, и две строки с одинаковым email проходят без ошибки. Решение, которое работает у обоих провайдеров, - вынести значение JSON в теневое свойство (shadow property), сопоставленное с вычисляемым столбцом (`JSON_VALUE` на SQL Server, `json_extract` на SQLite), поставить `HasIndex(...).IsUnique()` на этот столбец и обращаться к нему через `EF.Property`, чтобы индекс реально использовался.

Всё, что описано ниже, я проверил на `Microsoft.EntityFrameworkCore.SqlServer` и `Microsoft.EntityFrameworkCore.Sqlite` версии 11.0.0-rc.1.26425.128 на .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128), C# 14. Результаты для SQLite я получил на реальной базе данных в памяти. DDL для SQL Server я сгенерировал с помощью `GenerateCreateScript()` и генератора SQL для миграций, но не выполнял его на живом SQL Server 2025. Там, где важно поведение сервера, я ссылаюсь на документацию SQL Server.

## Модель, которая выглядит правильной, но не является таковой

EF Core 11 добавил индексы по свойствам внутри комплексных типов, включая комплексные типы, сопоставленные со столбцом JSON. На странице [Что нового](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) показано, как `HasIndex("Contact.Address.City")` создаёт JSON-индекс SQL Server. Естественно добавить к этому `.IsUnique()` и ожидать ограничение уникальности:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Contact Contact { get; set; } = new();
}

public class Contact
{
    public string Email { get; set; } = "";
    public Address Address { get; set; } = new();
}

public class Address { public string City { get; set; } = ""; }

protected override void OnModelCreating(ModelBuilder mb)
{
    mb.Entity<Customer>().ComplexProperty(c => c.Contact, b => b.ToJson());
    mb.Entity<Customer>().HasIndex("Contact.Email").IsUnique(); // looks fine, is not
}
```

На SQL Server с уровнем совместимости 170 `GenerateCreateScript()` выводит:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE JSON INDEX [IX_Customers_Contact_Email] ON [Customers]([Contact]) FOR (N'$.Email');
```

Нигде нет `UNIQUE`. У [синтаксиса CREATE JSON INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) вообще нет опции уникальности. JSON-индекс - это структура для поиска по предикатам `JSON_VALUE`, `JSON_PATH_EXISTS` и `JSON_CONTAINS`, а не ограничение целостности. На уровне 160 получается тот же `CREATE JSON INDEX` поверх столбца `nvarchar(max)`, который упадёт при применении - эту ловушку я разбирал в статье [нативный json против nvarchar(max) в EF Core 11](/ru/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/). При уровне логирования `Warning` EF не залогировал ничего об отброшенном `IsUnique()`.

С SQLite ситуация хуже, потому что выглядит так, будто всё сработало:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_Contact_Email" ON "Customers" ("Contact");
```

Индекс назван по `Contact_Email`, но ключом служит весь столбец `"Contact"`. Я добавил двух клиентов с одинаковым email и разными городами, и оба вызова `SaveChanges` завершились успешно. Затем я добавил двух клиентов, у которых весь документ `Contact` был идентичен, и второй завершился ошибкой `SQLite Error 19: 'UNIQUE constraint failed: Customers.Contact'`. То есть на деле вы получаете ограничение "ни у каких двух клиентов не может быть побайтово идентичных документов contact", а такое правило никому не нужно.

Оба поведения зарегистрированы в апстриме: [dotnet/efcore#39065](https://github.com/dotnet/efcore/issues/39065) для SQL Server и [dotnet/efcore#39064](https://github.com/dotnet/efcore/issues/39064) для SQLite. У Npgsql та же проблема индексирования всего столбца для `jsonb` в [npgsql/efcore.pg#3918](https://github.com/npgsql/efcore.pg/issues/3918).

## Почему путь JSON не может быть уникальным ключом напрямую

Уникальному индексу нужен скалярный ключ на каждую строку. JSON-документ - это одно значение в одном столбце. База данных увидит `$.Email` как скаляр только если что-то его извлечёт:

- SQL Server не позволяет ключу индекса быть выражением. Задокументированный паттерн в статье [Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) - это вычисляемый столбец поверх `JSON_VALUE` плюс обычный индекс на B-дереве по нему. `JSON_VALUE` детерминирована, а [CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) допускает `UNIQUE`-индекс на вычисляемом столбце, если он детерминирован и точен.
- SQLite действительно поддерживает индексы по выражениям, а также поддерживает генерируемые столбцы. У EF Core нет API для индекса по выражению, но есть `HasComputedColumnSql`, который SQLite превращает в генерируемый столбец.

Вычисляемый столбец - единственная форма, которую поддерживают оба провайдера и которую EF Core может смоделировать, промигрировать и считать обратно. В этом и заключается решение.

## Решение: вычисляемый столбец с уникальным индексом

1. Добавьте теневое свойство для значения, которое должно быть уникальным, и сопоставьте его с вычисляемым столбцом, извлекающим это значение из JSON-столбца.
2. Поставьте `HasIndex(...).IsUnique()` на это теневое свойство, а не на путь JSON.
3. На SQL Server убедитесь, что EF не добавляет к индексу свой фильтр `IS NOT NULL` по умолчанию (подробности ниже).
4. Добавьте миграцию, перед её применением проверьте существующие дубликаты и обращайтесь к значению через `EF.Property`, чтобы запросы попадали в индекс.

Вот конфигурация модели, написанная один раз для обоих провайдеров:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
protected override void OnModelCreating(ModelBuilder mb)
{
    var customer = mb.Entity<Customer>();
    customer.ComplexProperty(c => c.Contact, b => b.ToJson());

    var emailSql = Database.IsSqlServer()
        ? "CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320))"
        : "json_extract(\"Contact\", '$.Email')";

    customer.Property<string>("ContactEmail")
        .HasMaxLength(320)
        .HasComputedColumnSql(emailSql, stored: false)
        .IsRequired();

    customer.HasIndex("ContactEmail").IsUnique();
}
```

SQL Server, уровень 170 (уровень 160 идентичен, за исключением того, что `[Contact]` имеет тип `nvarchar(max)`):

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)),
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);
```

SQLite:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "ContactEmail" AS (json_extract("Contact", '$.Email')),
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

При такой модели на SQLite второй клиент с `a@x.com` падает на `SaveChanges` с `DbUpdateException`, оборачивающим `SQLite Error 19: 'UNIQUE constraint failed: Customers.ContactEmail'`. `ExecuteUpdate` тоже под защитой: `SetProperty(x => x.Contact.Email, "a@x.com")` для другой строки завершился той же ошибкой, потому что генерируемый столбец пересчитывается из обновлённого документа. После `SaveChanges` EF также считывает вычисленное значение обратно в теневое свойство (`Entry(e).Property("ContactEmail").CurrentValue` вернул `a@x.com`), поскольку вычисляемые столбцы имеют `ValueGenerated.OnAddOrUpdate`.

На SQL Server дубликат проявляется как `SqlException` номер 2601 ("Cannot insert duplicate key row"). Если хотите превратить это в ошибку валидации, перехватывайте `DbUpdateException` и проверяйте внутреннее исключение.

В этом коде важны несколько решений:

- **`CAST` к `nvarchar(320)`.** `JSON_VALUE` возвращает `nvarchar(4000)`, а [страница Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) предупреждает, что ключи индекса длиннее 1700 байт приводят к падению вставок. 320 символов - практический максимум для email-адреса, и это 640 байт в `nvarchar`. Приводите к самому узкому типу, который вмещает ваше значение. Для чисел приводите к `int` или `bigint`.
- **`stored: false`.** Ни одному из провайдеров не требуется физически хранить значение, чтобы его можно было индексировать. На SQL Server непостоянный (non-persisted) вычисляемый столбец можно индексировать, если он детерминирован и точен. На SQLite можно индексировать виртуальный генерируемый столбец, а добавить через `ALTER TABLE` позже можно только виртуальные.
- **`IsRequired()`.** Это не про сам столбец. Это не даёт EF добавить фильтр к индексу - о чём следующий раздел.

## Ловушка с фильтром на SQL Server

Если оставить теневое свойство необязательным, провайдер SQL Server в EF поступает так же, как с любым уникальным индексом на nullable-столбце, и добавляет фильтр:

```sql
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]) WHERE [ContactEmail] IS NOT NULL;
```

Это утверждение не выполнится. [Справочник CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) указывает, что предикат фильтра "can't reference a computed column" (не может ссылаться на вычисляемый столбец). EF генерирует его без единой жалобы, так что вы узнаёте об этом только когда падает `dotnet ef database update`.

Есть два выхода, оба проверены и убирают предложение `WHERE` из сгенерированного SQL:

```csharp
// .NET 11 RC 1, EF Core 11 - either mark the value required...
customer.Property<string>("ContactEmail").IsRequired();

// ...or keep it optional and remove the filter explicitly
customer.HasIndex("ContactEmail").IsUnique().HasFilter(null);
```

Без фильтра SQL Server считает NULL равными друг другу в уникальном индексе, поэтому email может отсутствовать только у одной строки. Если ваше JSON-свойство действительно необязательно, включите в выражение значение, зависящее от строки, чтобы отсутствующие email никогда не совпадали. Например: `ISNULL(CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)), N'#' + CAST([Id] AS nvarchar(11)))`. Это детерминированное и точное выражение, так что оно остаётся индексируемым. Я не проверял этот вариант на живом сервере. У SQLite такой проблемы нет: NULL в уникальном индексе SQLite всегда считаются различными, и EF не добавляет там никакого фильтра.

## Обращайтесь к столбцу в запросах, иначе индекс не используется

Уникальный индекс обеспечивает правило независимо от того, как вы пишете запросы. А вот использование его для поиска - отдельный вопрос. Обычный LINQ-фильтр по пути JSON не ссылается на ваш вычисляемый столбец:

```csharp
// .NET 11 RC 1, EF Core 11
db.Customers.Where(c => c.Contact.Email == email);
// SQL Server 170: WHERE JSON_VALUE([c].[Contact], '$.Email' RETURNING nvarchar(max)) = N'a@x.com'
// SQLite:         WHERE "c"."Contact" ->> 'Email' = 'a@x.com'
```

SQL Server умеет сопоставлять выражение запроса с эквивалентным вычисляемым столбцом, но только когда выражения совпадают. `JSON_VALUE(... RETURNING nvarchar(max))` - это не то же самое, что `CAST(JSON_VALUE(...) AS nvarchar(320))`. SQLite вообще не сопоставляет выражения генерируемых столбцов. В CLI sqlite3 3.50.6 `EXPLAIN QUERY PLAN` вернул `SCAN c` и для `Contact ->> 'Email'`, и для написанного вручную `json_extract(Contact, '$.Email')`, и только обращение к столбцу дало `SEARCH c USING INDEX IX_Customers_ContactEmail (ContactEmail=?)`.

Поэтому фильтруйте по теневому свойству:

```csharp
// .NET 11 RC 1, EF Core 11 - produces WHERE [c].[ContactEmail] = @email on both providers
var existing = await db.Customers
    .Where(c => EF.Property<string>(c, "ContactEmail") == email)
    .FirstOrDefaultAsync();
```

Если строки `EF.Property` вас смущают, сопоставьте вместо этого настоящее свойство только для чтения (`public string ContactEmail { get; private set; } = "";`) с тем же `HasComputedColumnSql`. EF заполняет его после каждого сохранения, а ваши запросы получают обычную лямбду.

## Добавление индекса в таблицу, где уже есть данные

Миграция, которую генерирует EF, - это два оператора для каждого провайдера:

```sql
-- SQL Server
ALTER TABLE [Customers] ADD [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320));
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);

-- SQLite
ALTER TABLE "Customers" ADD "ContactEmail" AS (json_extract("Contact", '$.Email'));
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

`ALTER TABLE` выполняется успешно, даже если дубликаты уже есть. А вот `CREATE UNIQUE INDEX` - нет. На SQLite с двумя существующими строками `a@x.com` он завершился ошибкой `UNIQUE constraint failed: Customers.ContactEmail (19)`. Сначала найдите нарушителей. EF транслирует группировку по пути JSON без учёта нового столбца:

```csharp
// .NET 11 RC 1, EF Core 11 - run before applying the migration
var duplicates = await db.Customers
    .GroupBy(c => c.Contact.Email)
    .Where(g => g.Count() > 1)
    .Select(g => new { Email = g.Key, Count = g.Count() })
    .ToListAsync();
```

Приведите эти строки в порядок, затем примените миграцию. Для продакшн-раскаток генерируйте SQL и проверяйте его, а не позволяйте приложению мигрировать себя само; это описано в статье [про workflow migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/). Если в вашей команде действуют правила именования индексов, вычисляемый столбец именуется так же, как любое другое свойство, поэтому правила из статьи [про пользовательские соглашения об именовании ключей и индексов в EF Core 11](/ru/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) применяются к `IX_Customers_ContactEmail` без особых исключений.

## Нюансы, которые стоит знать перед релизом

**Чувствительность к регистру отличается между провайдерами.** На SQLite я вставил `a@x.com` и `A@X.com`, и оба были приняты, потому что SQLite по умолчанию сравнивает с параметрами сортировки (collation) `BINARY`. На SQL Server уникальность следует collation исходного столбца, а для большинства баз данных это регистронезависимое сравнение, так что такая же пара привела бы к конфликту. Если правило звучит как "один аккаунт на email", нормализуйте значения: храните email в нижнем регистре или используйте `lower(json_extract("Contact", '$.Email'))` на SQLite, чтобы оба провайдера были согласованы. Это особенно больно бьёт при смешении провайдеров между тестами и продакшном - одна из причин, почему [WebApplicationFactory против Testcontainers](/ru/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) важно для тестов бизнес-правил данных.

**Имя JSON-свойства - часть SQL.** `$.Email` должно совпадать с тем, что EF записывает в документ. Если вы переименуете CLR-свойство или настроите `HasJsonPropertyName("email")`, обновите SQL вычисляемого столбца в той же миграции. EF не сделает это за вас, потому что путь - это непрозрачная строка. Несовпадение не приводит к ошибке: каждая строка получает NULL, и ваше "уникальное" правило перестаёт что-либо обеспечивать.

**Комплексные коллекции этот подход не решает.** Уникальному индексу нужно ровно одно значение на строку. Для правила "SKU должен быть уникальным среди `Items[]`" нужна дочерняя таблица, а не JSON-столбец. EF Core 11 умеет индексировать `Items[].Sku` для поиска на SQL Server, но это JSON-индекс, а не ограничение целостности.

**Не рассчитывайте на будущий `IsUnique()`.** Исправление для SQL Server, [dotnet/efcore#39090](https://github.com/dotnet/efcore/pull/39090), было влито в `release/11.0` 2026-09-26, уже после выхода RC 1. Оно не делает JSON-индексы уникальными. Оно приводит к тому, что модель не проходит валидацию с ошибкой `JSON index '{index}' on entity type '{entityType}' was configured with the '{option}' option, which is not supported on JSON indexes.` Это улучшение, поскольку молчаливое отбрасывание превращается в громкую ошибку, но ответом по-прежнему остаётся вычисляемый столбец. Проблема в SQLite на момент написания этой статьи всё ещё была открыта.

**Вычисляемому столбцу нужны обычные SET-опции SQL Server.** Индексы на вычисляемых столбцах требуют для сессий, изменяющих таблицу, настроек вроде `QUOTED_IDENTIFIER ON` и `ANSI_NULLS ON`. Настройки SqlClient по умолчанию их удовлетворяют, но устаревший скрипт или инструмент, который их отключает, получит ошибки при записи в `Customers`.

Если вы ещё не определились со схемой сопоставления JSON, статья [как сопоставлять и запрашивать JSON-столбцы в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) разбирает `ComplexProperty(...).ToJson()` от начала до конца. Всё изложенное здесь предполагает именно такое сопоставление.

## Источники

- [Что нового в EF Core 11: ключи и индексы на свойствах комплексных типов, JSON-индексы](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [Index JSON data (вычисляемые столбцы поверх JSON_VALUE)](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data)
- [CREATE INDEX (Transact-SQL): правила для фильтрованных индексов и вычисляемых столбцов](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)
- [Генерируемые столбцы SQLite](https://www.sqlite.org/gencol.html)
- [dotnet/efcore#39065: IsUnique() на индексе по JSON-сопоставленному члену молча отбрасывается](https://github.com/dotnet/efcore/issues/39065)
- [dotnet/efcore#39064: индекс SQLite по JSON-сопоставленному члену индексирует весь столбец](https://github.com/dotnet/efcore/issues/39064)
- [dotnet/efcore#39090: валидация неподдерживаемых опций JSON-индекса SQL Server](https://github.com/dotnet/efcore/pull/39090)
- [npgsql/efcore.pg#3918: индекс по JSON-сопоставленному члену индексирует весь столбец jsonb](https://github.com/npgsql/efcore.pg/issues/3918)
