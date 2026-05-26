---
title: "EF Core 11 Preview 4: столбцы периода во временных таблицах наконец могут быть настоящими свойствами"
description: "EF Core 11 Preview 4 снимает многолетнее ограничение shadow-свойств для временных таблиц SQL Server. PeriodStart и PeriodEnd теперь могут быть обычными CLR-свойствами, настраиваемыми строго типизированными лямбдами HasPeriodStart и HasPeriodEnd."
pubDate: 2026-05-26
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2026/05/ef-core-11-temporal-tables-clr-period-properties"
translatedBy: "claude"
translationDate: 2026-05-26
---

EF Core поддерживает временные таблицы SQL Server с версии 6.0, но с одним досадным ограничением: столбцы `PeriodStart` и `PeriodEnd` приходилось моделировать как shadow-свойства. Их можно было запрашивать через `EF.Property<DateTime>(entity, "PeriodStart")`, но нельзя было разместить в классе сущности и читать как любой другой столбец. Это ограничение снято в EF Core 11 Preview 4, выпущенном 12 мая 2026 года в составе [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/).

Исправление приходит как [efcore#38110](https://github.com/dotnet/efcore/pull/38110) и закрывает [issue, открытое в 2021 году](https://github.com/dotnet/efcore/issues/26463). Это небольшое изменение по строкам кода и большое улучшение эргономики.

## Как выглядела старая модель с shadow-свойствами

До Preview 4 временная сущность могла объявлять только прикладные столбцы. Столбцы периода жили в модели, но не в классе:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal());
```

Чтобы прочитать значения периода, приходилось обращаться к change tracker:

```csharp
var start = context.Entry(order).Property<DateTime>("PeriodStart").CurrentValue;
var end   = context.Entry(order).Property<DateTime>("PeriodEnd").CurrentValue;
```

Две проблемы. Во-первых, теряются IntelliSense и безопасность рефакторинга: имя столбца представляет собой магическую строку. Во-вторых, проецировать значения периода в LINQ-запросе неудобно, поскольку свойство отсутствует на CLR-типе. Маппинг DTO с окном валидности означал либо сырой SQL-запрос, либо `EF.Property<>` внутри `Select`, и оба варианта конфликтуют с системой типов.

## Модель в Preview 4

В Preview 4 столбцы периода можно просто поместить на сущность:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}
```

Настройте их новыми строго типизированными перегрузками `HasPeriodStart` и `HasPeriodEnd`, принимающими лямбду:

```csharp
modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal(ttb =>
{
    ttb.HasPeriodStart(o => o.PeriodStart);
    ttb.HasPeriodEnd(o => o.PeriodEnd);
}));
```

Теперь `PeriodStart` и `PeriodEnd` ведут себя как любой другой смаппированный столбец. Их можно читать на материализованной сущности, проецировать в `Select`, сортировать по ним и фильтровать в обычном LINQ:

```csharp
var openOrders = await context.Orders
    .Where(o => o.PeriodEnd == DateTime.MaxValue)
    .Select(o => new { o.Id, o.Status, o.PeriodStart })
    .ToListAsync();
```

Предикат `PeriodEnd == DateTime.MaxValue` представляет собой канонический фильтр "текущей строки" для временных таблиц SQL Server. Раньше его приходилось писать против shadow-свойства.

## Что не меняется

Семантика временной таблицы на стороне базы данных идентична. SQL Server по-прежнему ведёт таблицу истории, по-прежнему обновляет `PeriodStart` и `PeriodEnd` при каждой записи и по-прежнему отклоняет прямые записи в столбцы периода. EF Core продолжает помечать их как `ValueGeneratedOnAddOrUpdate` и игнорировать при insert и update. Их можно читать, но нельзя задавать.

Запросы путешествия во времени также работают одинаково:

```csharp
var snapshot = await context.Orders
    .TemporalAsOf(new DateTime(2026, 5, 1))
    .ToListAsync();
```

Единственное отличие в том, что возвращаемые сущности теперь несут значения периода прямо на CLR-объекте, а не прячут их за `EF.Property<>`.

## Миграция необязательна

Если у вас уже есть модель с shadow-столбцами периода, менять ничего не нужно. Старый API продолжает работать. Для любой новой временной сущности размещение `PeriodStart` и `PeriodEnd` в классе теперь является путём наименьшего сопротивления.

Полные заметки по EF Core в Preview 4: [release-notes/11.0/preview/preview4/efcore.md](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/efcore.md).
