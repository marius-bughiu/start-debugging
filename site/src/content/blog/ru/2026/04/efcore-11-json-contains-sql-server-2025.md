---
title: "EF Core 11 транслирует Contains в JSON_CONTAINS на SQL Server 2025"
description: "EF Core 11 автоматически транслирует LINQ Contains по JSON-коллекциям в новую функцию JSON_CONTAINS из SQL Server 2025 и добавляет EF.Functions.JsonContains для запросов с путём и режимом, способных задействовать JSON-индекс."
pubDate: 2026-04-20
tags:
  - "dotnet-11"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "linq"
lang: "ru"
translationOf: "2026/04/efcore-11-json-contains-sql-server-2025"
translatedBy: "claude"
translationDate: 2026-04-24
---

SQL Server 2025 получил нативную функцию [`JSON_CONTAINS`](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql), а EF Core 11 - тот релиз, который к ней подключается. Меняются две вещи для всех, кто хранит коллекции как JSON-колонки: `Contains` по JSON-коллекциям теперь получает прямую трансляцию вместо старого join через `OPENJSON`, и появился новый `EF.Functions.JsonContains()` для случаев, где нужен JSON-путь или конкретный режим поиска. Работа входит в [EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).

## Включение уровня совместимости SQL Server 2025

Новая трансляция включается, только когда провайдер знает, что общается с SQL Server 2025. Делаете это через `UseCompatibilityLevel(170)` на опциях провайдера:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

Уровень совместимости 170 - это то, что отчитывает SQL Server 2025; более низкие уровни продолжат использовать старую трансляцию, поэтому безопасно не указывать его, пока вы реально не обновили базу.

## Как теперь выглядит Contains

Возьмём классическую форму «теги как JSON-массив»:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Tags { get; set; } = new();
}

modelBuilder.Entity<Blog>()
    .Property(b => b.Tags)
    .HasColumnType("json"); // SQL Server 2025 native JSON type
```

На EF Core 10 или против более старого SQL Server этот запрос:

```csharp
var posts = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

даст трансляцию через `OPENJSON`, читающуюся как коррелированный подзапрос:

```sql
WHERE N'ef-core' IN (
    SELECT [t].[value]
    FROM OPENJSON([b].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)
```

EF Core 11 на уровне совместимости 170 эмитит вместо этого:

```sql
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

Причина важности не только в красоте SQL. `JSON_CONTAINS` - единственный предикат в SQL Server 2025, способный использовать [JSON-индекс](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql). Если у вас есть `CREATE JSON INDEX IX_Tags ON Blogs(Tags)`, путь через `OPENJSON` его никогда не затронет, а трансляция EF 11 - затронет.

Есть подвох, отмеченный в release notes: `JSON_CONTAINS` обрабатывает NULL не так, как LINQ-овский `Contains`, поэтому EF выбирает новую трансляцию только когда хотя бы одна сторона доказуемо не-nullable (не-null константа или не-nullable колонка). Если обе стороны могут быть null, EF откатывается на `OPENJSON`, сохраняя прежнее поведение.

## Когда нужен путь или режим поиска

`Contains` покрывает случай «есть ли этот скаляр в массиве». Для всего остального EF Core 11 выставляет `EF.Functions.JsonContains(container, value, path?, mode?)`. Классический пример - поиск значения по конкретному пути внутри структурированного JSON-документа:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string JsonData { get; set; } = "{}"; // { "Rating": 8, ... }
}

var ratedEights = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

Транслируется в:

```sql
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Можно использовать со скалярными string-колонками, с комплексными типами, замапленными в JSON, и с owned-типами, замапленными через `OwnsOne(... b.ToJson())`. Сравнение с `= 1` принципиально: `JSON_CONTAINS` возвращает `bit`, и EF это сохраняет, чтобы составные предикаты вида `WHERE ... AND JSON_CONTAINS(...) = 1` оставались SARGable против JSON-индекса.

Сочетайте это с [`EF.Functions.JsonPathExists`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) для проверок «а свойство вообще есть?», и вы покроете большую часть поверхности запросов по JSON-колонкам без скатывания к сырым SQL. Полный список изменений транслятора EF Core 11 - в документе [What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
