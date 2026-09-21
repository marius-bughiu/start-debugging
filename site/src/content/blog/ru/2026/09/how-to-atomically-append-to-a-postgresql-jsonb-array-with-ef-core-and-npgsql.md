---
title: "Как атомарно добавить элемент в массив jsonb в PostgreSQL с EF Core и Npgsql"
description: "Загрузка сущности, вызов List.Add и сохранение перезаписывают весь документ jsonb и незаметно теряют параллельные добавления. Перенесите добавление в один UPDATE с оператором jsonb ||, через ExecuteSqlAsync или через сопоставленную функцию внутри ExecuteUpdateAsync, и сделайте его идемпотентным с помощью проверки @>."
pubDate: 2026-09-21
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "json"
  - "concurrency"
  - "how-to"
lang: "ru"
translationOf: "2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql"
translatedBy: "claude"
translationDate: 2026-09-21
---

Короткий ответ: не загружайте строку, не делайте `Add` в список и не вызывайте `SaveChangesAsync`. EF Core отправляет весь документ `jsonb` обратно как параметр, поэтому два запроса, добавляющие элементы одновременно, перезаписывают друг друга. Вместо этого отправьте один `UPDATE`, который выполняет добавление внутри PostgreSQL: `SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]') || to_jsonb(@label::text))`. Его можно выполнить через `Database.ExecuteSqlAsync` или остаться в LINQ, сопоставив небольшую функцию через `HasDbFunction` и вызвав её внутри `ExecuteUpdateAsync`, где EF Core 10 сам сгенерирует `jsonb_set`. Добавьте `.Where(t => !t.Data.Labels.Contains(label))`, который Npgsql транслирует в `@>`, и добавление к тому же станет идемпотентным.

Всё описанное ниже запускалось на .NET 10 (SDK 10.0.302) с `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (он подтягивает EF Core 10.0.4) на PostgreSQL 18.4. JSON-столбец сопоставлен так, как рекомендует EF Core 10: сложный тип с `ToJson()`. Весь SQL и все приведённые числа взяты из реальных запусков, а не восстановлены по памяти.

## Двадцать параллельных добавлений, выжили три

Вот модель. У заявки есть столбец `jsonb` с метками и историей событий:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required TicketData Data { get; set; }
}

public class TicketData
{
    public List<string> Labels { get; set; } = [];
    public List<TicketEvent> Events { get; set; } = [];
}

public class TicketEvent
{
    public required string Kind { get; set; }
    public DateTime At { get; set; }
}

public class AppDb : DbContext
{
    public DbSet<Ticket> Tickets => Set<Ticket>();

    protected override void OnModelCreating(ModelBuilder b)
        => b.Entity<Ticket>().ComplexProperty(t => t.Data, d => d.ToJson());
}
```

Npgsql создаёт для этого `"Data" jsonb NOT NULL`. Теперь код, который большинство пишет первым, запущенный из 20 параллельных задач против одной и той же строки, каждая со своим `DbContext`:

```csharp
// .NET 10, EF Core 10.0.4 -- the lost-update version
await using var db = new AppDb();
var t = await db.Tickets.SingleAsync(x => x.Id == id);
t.Data.Labels.Add($"l{i}");
await db.SaveChangesAsync();
```

Строка начинается с одной метки, так что ожидаемый результат 21. У меня получилось **3**, в трёх запусках из трёх. Причина видна в SQL, который отправляет `SaveChangesAsync`:

```sql
UPDATE "Tickets" SET "Data" = @p0
WHERE "Id" = @p1;
-- @p0='{"Labels":["hardware","urgent","via-savechanges"],"Events":[...]}'
```

EF Core не отправляет "добавь этот элемент". Он сериализует весь сложный тип из памяти и заменяет им столбец. Каждая задача прочитала один и тот же исходный документ, добавила свою метку и записала обратно документ, который ничего не знал об остальных 19. Побеждает последний записавший, а база данных понятия не имеет, что что-то пошло не так, потому что с её точки зрения каждый `UPDATE` был совершенно корректной заменой.

Это не ошибка Npgsql. Это обычная проблема потерянного обновления, и JSON-столбец делает её хуже обычного: со скалярными столбцами два запроса, меняющие *разные* столбцы, не конфликтуют, а здесь любое изменение любой метки или события перезаписывает единственный столбец, в котором хранятся они все.

## Почему добавление внутри базы данных атомарно

Оператор PostgreSQL `jsonb || jsonb` выполняет конкатенацию. Когда слева массив, а справа скаляр или объект, правая часть добавляется как один элемент:

```sql
SELECT '["a"]'::jsonb || to_jsonb('b'::text);     -- ["a", "b"]
SELECT '["a"]'::jsonb || '{"k": 1}'::jsonb;       -- ["a", {"k": 1}]
```

Важен не сам оператор, а то, откуда берётся старое значение. В `SET "Data" = ... "Data" || ...` правый `"Data"` означает текущее значение строки в момент выполнения `UPDATE`. При уровне изоляции по умолчанию `READ COMMITTED`, когда две транзакции обновляют одну строку, вторая блокируется на блокировке строки до фиксации первой, затем перечитывает *новую* версию строки и заново вычисляет по ней и условие `WHERE`, и выражения `SET`. Поэтому каждое добавление опирается на предыдущее. Без цикла повторов, без столбца версии, без лишнего чтения.

## Вариант 1: один UPDATE через ExecuteSqlAsync

Самое прямое решение: написать запрос самому:

```csharp
// .NET 10, EF Core 10.0.4, PostgreSQL 18.4
var label = "urgent";
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]'::jsonb) || to_jsonb({{label}}::text))
    WHERE "Id" = {{id}}
    """);
```

`ExecuteSqlAsync` принимает `FormattableString`, поэтому `{{label}}` и `{{id}}` становятся настоящими параметрами (`@p0`, `@p1`), а не конкатенацией строк. Сырая строка `$$` выбрана намеренно: она позволяет литералу пути jsonb `'{Labels}'` сохранить одинарные фигурные скобки, а `{{...}}` отмечает места подстановки. С теми же 20 параллельными задачами эта версия каждый раз заканчивается 21 меткой.

У каждой из трёх частей этого запроса есть своя причина:

- `jsonb_set(doc, '{Labels}', newArray)` заменяет только ключ `Labels` и сохраняет все остальные ключи документа такими, какие они *прямо сейчас*, включая запись в `Events`, которую другой запрос добавил миллисекунду назад.
- `COALESCE("Data"->'Labels', '[]'::jsonb)` покрывает строки, записанные до появления `Labels`. `NULL || anything` даёт `NULL`, а `jsonb_set` с новым значением `NULL` возвращает `NULL` для всего документа, что на столбце `NOT NULL` приводит к ошибке, а на столбце, допускающем null, к потере данных.
- `::text` у параметра даёт `to_jsonb` конкретный тип. Без него литерал, подставленный вручную, падает с `42804: could not determine polymorphic type because input has type unknown`.

Добавление объекта, например нового события истории, работает так же. Сериализуйте его и приведите к `jsonb`:

```csharp
// .NET 10, EF Core 10.0.4, System.Text.Json
var ev = new TicketEvent { Kind = "escalated", At = DateTime.UtcNow };
var json = JsonSerializer.Serialize(ev);
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Events}', COALESCE("Data"->'Events', '[]'::jsonb) || jsonb_build_array({{json}}::jsonb))
    WHERE "Id" = {{id}}
    """);
```

Результат был `{"Events": [{"At": "2026-09-21T08:00:00Z", "Kind": "escalated"}], ...}`, и при чтении заявки через EF событие материализовалось с `DateTimeKind.Utc`. Используйте в JSON имена свойств EF (здесь `Kind` и `At`, это значение по умолчанию, когда в модели нет `HasJsonPropertyName`), потому что EF читает документ именно по этим ключам.

## Вариант 2: остаться в LINQ с сопоставленной функцией и ExecuteUpdateAsync

Сырой SQL работает, но жёстко прописывает имена таблиц и столбцов, которыми в остальном управляет EF. В EF Core 10 появилась поддержка `ExecuteUpdateAsync` для свойств внутри сложного типа `ToJson()`, так что естественно попробовать вот это:

```csharp
// Does NOT translate in EF Core 10.0.4 / Npgsql 10.0.3
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => t.Data.Labels.Append("x").ToList()));
```

Это падает с `The LINQ expression '...AsQueryable().Append("x")' could not be translated`, а вариант с `Concat(new[] { "y" }).ToList()` падает с `does not represent a valid value`. Npgsql не транслирует операторы добавления в список для примитивной коллекции JSON в сеттере.

Что *работает*, так это пользовательская функция, возвращаемый тип которой совпадает с типом коллекции. EF разрешает ставить её в правую часть `SetProperty` и сам оборачивает её в `jsonb_set`. Создайте функцию в миграции:

```csharp
// EF Core 10 migration
migrationBuilder.Sql("""
    CREATE OR REPLACE FUNCTION jsonb_append_text(arr jsonb, elem text)
    RETURNS jsonb LANGUAGE sql IMMUTABLE
    AS $$ SELECT COALESCE(NULLIF(arr, 'null'::jsonb), '[]'::jsonb) || to_jsonb(elem) $$;
    """);
```

Затем объявите заглушку на C# и сопоставьте её:

```csharp
// .NET 10, EF Core 10.0.4
public static class JsonbFn
{
    public static List<string> Append(List<string> array, string element)
        => throw new InvalidOperationException("Only usable in EF Core queries.");
}

// in OnModelCreating
b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Append))!)
    .HasName("jsonb_append_text");
```

Теперь место вызова выглядит как обычный типизированный EF:

```csharp
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => JsonbFn.Append(t.Data.Labels, label)));
```

и EF генерирует такой SQL:

```sql
UPDATE "Tickets" AS t
SET "Data" = jsonb_set(t."Data", '{Labels}', COALESCE(to_jsonb(jsonb_append_text(t."Data" -> 'Labels', @label)), 'null'::jsonb))
WHERE t."Id" = @id
```

Двадцать параллельных вызывающих, 21 метка, в каждом запуске. Лишний `to_jsonb(...)` вокруг значения, которое уже является `jsonb`, ничего не делает; EF добавляет его для каждого JSON-свойства, которое устанавливает. `NULLIF(arr, 'null'::jsonb)` в функции покрывает документ, где хранится `"Labels": null`, а не отсутствующий ключ. Без него `'null'::jsonb || '"x"'` незаметно даёт `[null, "x"]`.

### То же самое без миграции: HasTranslation

Если добавлять объекты в базу данных нельзя, можно заставить EF генерировать встроенные функции. `jsonb_insert(array, '{-1}', element, true)` вставляет элемент после последнего, то есть выполняет добавление в конец:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore.Query.SqlExpressions;

b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Push))!)
    .HasTranslation(a =>
    {
        var jsonb = a[0].TypeMapping;
        var arr = new SqlFunctionExpression("COALESCE",
            [
                new SqlFunctionExpression("NULLIF", [a[0], new SqlFragmentExpression("'null'::jsonb")],
                    nullable: true, argumentsPropagateNullability: [false, false], typeof(string), jsonb),
                new SqlFragmentExpression("'[]'::jsonb"),
            ],
            nullable: false, argumentsPropagateNullability: [false, false], typeof(string), jsonb);
        var elem = new SqlFunctionExpression("to_jsonb",
            [new SqlUnaryExpression(ExpressionType.Convert, a[1], typeof(string), a[1].TypeMapping)],
            nullable: true, argumentsPropagateNullability: [true], typeof(string), jsonb);
        return new SqlFunctionExpression("jsonb_insert",
            [arr, new SqlFragmentExpression("'{-1}'"), elem, new SqlFragmentExpression("true")],
            nullable: true, argumentsPropagateNullability: [false, false, true, false],
            typeof(List<string>), jsonb);
    });
```

что даёт:

```sql
SET "Data" = jsonb_set(t."Data", '{Labels}', jsonb_insert(COALESCE(NULLIF(t."Data" -> 'Labels', 'null'::jsonb), '[]'::jsonb), '{-1}', to_jsonb(@lbl::text), true))
```

Две детали этой трансляции появились из-за сбоев, а не из соображений стиля. Моя первая версия оборачивала массив напрямую в `COALESCE(a[0], '[]')`, и обработчик допустимости null в EF удалил `COALESCE`, потому что по модели `Labels` является обязательной коллекцией, не допускающей null. Предварительное оборачивание в `NULLIF` делает выражение допускающим null, поэтому `COALESCE` сохраняется, а заодно обрабатывается JSON `null`. Узел `Convert` и есть приведение `::text`. Без него вызов с константой (`JsonbFn.Push(t.Data.Labels, "a")`) подставляет `'a'` без типа и получает ту же ошибку `42804`, что и выше. С захваченной переменной работало в обоих случаях, и это именно тот тип ошибки, который проходит код-ревью.

Путь с функцией в миграции требует меньше кода и проще читается. Используйте `HasTranslation`, только когда добавить функцию в базу данных невозможно.

## Как сделать добавление идемпотентным

Повторные попытки, доставка сообщений по схеме at-least-once и двойные клики по кнопкам превращают "добавить" в "добавить дважды". Поместите проверку в тот же запрос:

```csharp
// .NET 10, EF Core 10.0.4
var n = await db.Tickets
    .Where(t => t.Id == id && !t.Data.Labels.Contains(label))
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Data.Labels, t => JsonbFn.Push(t.Data.Labels, label)));
// n == 1 when the label was added, 0 when it was already there
```

Npgsql транслирует `Contains` для примитивной коллекции JSON в оператор включения:

```sql
WHERE t."Id" = @id AND NOT ((t."Data" -> 'Labels') @> to_jsonb(@l))
```

Поскольку PostgreSQL заново вычисляет условие `WHERE` после ожидания блокировки строки, это работает и при параллельном выполнении, а не только при последовательном. Двадцать параллельных задач, добавлявших `"dup"`, в сумме дали ровно одну затронутую строку и `["hardware", "dup"]`, в каждом запуске. Число затронутых строк также отвечает на вопрос "добавил ли я элемент" без второго запроса. Если вам нужна семантика множества между *разными* строками, например "у двух заявок не может быть одинакового внешнего id", это задача уникального индекса, а не JSON-массива.

## Когда действительно нужен цикл чтение-изменение-запись

Иногда новый элемент зависит от существующих, например "добавить, если последнее событие ещё не `closed`", и такая логика плохо ложится на SQL. Тогда оставьте `SaveChangesAsync`, но сделайте потерянные обновления обнаруживаемыми с помощью токена оптимистичной конкурентности. В PostgreSQL системный столбец `xmin` меняется при каждом обновлении, и Npgsql сопоставляет его со свойством `uint`, помеченным `[Timestamp]`:

```csharp
// .NET 10, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required TicketData Data { get; set; }

    [Timestamp]
    public uint Version { get; set; }   // mapped to xmin, no migration column
}
```

Теперь устаревшая запись выбрасывает `DbUpdateConcurrencyException` вместо того, чтобы незаметно победить, и вы повторяете попытку, перезагрузив данные. С теми же 20 параллельными задачами и циклом перезагрузки и повтора все 21 метка сохранились ценой **167** конфликтов и повторов. Именно поэтому добавление внутри базы данных является рекомендацией по умолчанию. Оптимистичная конкурентность корректна, но при конкуренции за горячую строку она превращается в шторм повторов.

## Подводные камни, о которых стоит знать до продакшена

- **`ExecuteSqlRawAsync` и `SqlQueryRaw` считают фигурные скобки местами подстановки, даже без параметров.** `ExecuteSqlRawAsync("... jsonb_set(\"Data\", '{Labels}', ...)")` выбрасывает `FormatException: Input string was not in a correct format` ещё до того, как что-либо дойдёт до PostgreSQL. Удвойте скобки (`'{{Labels}}'`) или используйте интерполированный `ExecuteSqlAsync` с сырой строкой `$$`, как показано выше.
- **Добавление массива добавляет его элементы, а не сам массив.** `'["a"]' || '["b"]'` даёт `["a", "b"]`. Если добавляемый элемент сам может быть массивом, оберните его: `|| jsonb_build_array(@x::jsonb)`.
- **`to_jsonb` от JSON-строки даёт строку.** `'["a"]' || to_jsonb('{"k":1}'::text)` добавляет *текст* `"{\"k\":1}"`. Сериализованным объектам нужен `::jsonb`, а не `to_jsonb`.
- **`jsonb_set` не создаёт отсутствующих родителей.** `jsonb_set('{}', '{A,B}', '[1]')` возвращает `{}` без изменений. Для вложенного пути убедитесь, что родительский объект существует, или стройте его с помощью `jsonb_set` по одному уровню за раз.
- **Сложные коллекции не могут быть возвращаемым типом сопоставленной функции.** Сопоставление `List<TicketEvent> PushEvent(List<TicketEvent>, string)` падает при построении модели с `The DbFunction 'JsonbFn.PushEvent(...)' has an invalid return type 'List<TicketEvent>'`. Для массивов объектов используйте вариант 1.
- **Порядок определяется порядком фиксации, а не порядком вызовов.** Параллельные добавления попадают в массив в порядке фиксации их транзакций, так что `l11` может оказаться перед `l10`. Если порядок важен, добавляйте метку времени или порядковый номер и сортируйте при чтении.
- **Следите за размером документа.** Каждое добавление перезаписывает на диске всё значение `jsonb` (в PostgreSQL нет обновления JSON на месте, а большие значения уходят в TOAST). Историю, которая растёт без ограничений, стоит хранить в отдельной таблице.
- **Для owned-типов это не работает.** Поддержка `ExecuteUpdate` для JSON в EF Core требует `ComplexProperty(...).ToJson()`. Если вы всё ещё используете `OwnsOne(...).ToJson()`, подходит только вариант 1.

### Что почитать дальше

- [Как сопоставлять JSON-столбцы и выполнять по ним запросы в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) описывает сопоставление `ToJson()`, на котором построена эта статья.
- [Сложные типы и owned-сущности в EF Core 11](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) объясняет, почему `ExecuteUpdate` в JSON работает только для сложных типов.
- [Как использовать ExecuteUpdate и ExecuteDelete для массовой записи в EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) подробнее разбирает обновления на основе множеств, включая их слепые зоны для отслеживания изменений.
- [EF Core ExecuteUpdate против загрузки сущностей и SaveChanges](/ru/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) сравнивает два пути записи в целом.
- [Как реализовать оптимистичную конкурентность с токеном rowversion в EF Core 11](/ru/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) описывает аналог подхода с `xmin` для SQL Server.

### Источники

- [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html), документация PostgreSQL (`||`, `@>`, `jsonb_set`, `jsonb_insert`)
- [Transaction Isolation: Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), документация PostgreSQL
- [JSON Mapping](https://www.npgsql.org/efcore/mapping/json.html), документация провайдера Npgsql EF Core
- [Concurrency Tokens](https://www.npgsql.org/efcore/modeling/concurrency.html), документация провайдера Npgsql EF Core (`xmin`)
- [What's New in EF Core 10: ExecuteUpdate support for relational JSON columns](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#executeupdate-support-for-relational-json-columns), Microsoft Learn
- [User-defined function mapping](https://learn.microsoft.com/en-us/ef/core/querying/user-defined-function-mapping), документация EF Core
- [`NpgsqlQuerySqlGenerator.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Query/Internal/NpgsqlQuerySqlGenerator.cs), npgsql/efcore.pg
