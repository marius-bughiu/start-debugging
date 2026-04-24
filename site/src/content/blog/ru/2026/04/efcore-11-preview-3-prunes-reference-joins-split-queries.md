---
title: "EF Core 11 вырезает ненужные reference joins в split queries"
description: "EF Core 11 Preview 3 убирает избыточные to-one joins из split queries и роняет ненужные ORDER BY ключи. Один заявленный сценарий стал на 29% быстрее, другой на 22%. Вот как теперь выглядит SQL."
pubDate: 2026-04-18
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "performance"
  - "csharp"
lang: "ru"
translationOf: "2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries"
translatedBy: "claude"
translationDate: 2026-04-24
---

У split queries EF Core всегда была острая грань: когда вы смешивали `Include` reference navigations с `Include` collection navigations, каждая дочерняя query всё равно re-join-ила reference-таблицы, даже если в этих collection queries они были не нужны. EF Core 11 Preview 3 это чинит, вместе со связанной `ORDER BY` over-specification. [Release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) оценивают влияние на benchmark в 29% для распространённого split-query сценария и 22% для single-query случая. Это такой род изменения, который появляется в проде без всякого LINQ-редактирования с вашей стороны.

## Лишний join, который никогда не был нужен

Рассмотрите каноническую форму: блог с to-one `BlogType` и to-many `Posts`, загружаемый с `AsSplitQuery()`:

```csharp
var blogs = context.Blogs
    .Include(b => b.BlogType)
    .Include(b => b.Posts)
    .AsSplitQuery()
    .ToList();
```

Split queries выполняют по одному SQL на каждую included collection плюс root query. Root query легитимно нуждается в join с `BlogType`, чтобы проецировать его колонки. Collection query для `Posts` - нет, потому что проецирует только post-колонки. EF Core 10 и раньше всё равно излучал join:

```sql
-- Before EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id], [b0].[Id]
FROM [Blogs] AS [b]
INNER JOIN [BlogType] AS [b0] ON [b].[BlogTypeId] = [b0].[Id]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id], [b0].[Id]
```

Этот лишний `INNER JOIN [BlogType]` резолвится на каждой строке, потом участвует в sort, безо всяких причин payload. EF Core 11 его выпиливает:

```sql
-- EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]
```

Чем больше reference navigations было упаковано в `Include`, тем больше joins исчезает. Если ваша domain-модель опирается на `Include` мелких lookup-ов (`Country`, `Status`, `Currency`) рядом с настоящей collection, это по сути бесплатная пропускная способность.

## ORDER BY over-specification, тоже ушло

Вторая оптимизация применима и к single queries. Когда вы включаете reference navigation, EF исторически излучал её ключ в clause `ORDER BY`, хотя primary key родителя уже определял её через foreign key:

```csharp
var blogs = context.Blogs
    .Include(b => b.Owner)
    .Include(b => b.Posts)
    .ToList();
```

До EF Core 11:

```sql
ORDER BY [b].[BlogId], [p].[PersonId]
```

В EF Core 11:

```sql
ORDER BY [b].[BlogId]
```

`BlogId` уникален, а `PersonId` был полностью определён через `BlogId` по FK, так что держать его в sort key было чистым расходом. Убрать его укорачивает sort key, что имеет значение, как только таблица становится достаточно большой, чтобы проливаться на диск, или как только planner выбирает merge join над результатом.

## Когда вы это заметите

Самые большие выигрыши увидите на запросах с несколькими мелкими reference includes плюс одним или более collection includes, потому что именно они раньше повторяли одни и те же ненужные joins по каждой дочерней query. Customer-order, invoice-with-lines, blog-with-posts - очевидные кандидаты. Запросы без `AsSplitQuery()` и запросы без reference includes получают упрощение `ORDER BY`, но не join pruning.

API не меняется, включать нечего. Обновитесь до EF Core 11.0.0-preview.3 (таргет .NET 11 Preview 3), запустите тот же LINQ, и сгенерированный SQL окажется плотнее. Benchmark-детали живут в [issue трекинга EF Core](https://github.com/dotnet/efcore/issues/29182).
