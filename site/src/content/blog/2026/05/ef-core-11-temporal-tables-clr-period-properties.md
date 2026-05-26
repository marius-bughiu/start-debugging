---
title: "EF Core 11 Preview 4: Temporal Table Period Columns Can Finally Be Real Properties"
description: "EF Core 11 Preview 4 drops the long-standing shadow-property restriction on SQL Server temporal tables. PeriodStart and PeriodEnd can now be regular CLR properties, configured with strongly-typed HasPeriodStart and HasPeriodEnd lambdas."
pubDate: 2026-05-26
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "csharp"
  - "dotnet"
---

EF Core has supported SQL Server temporal tables since version 6.0, but with one annoying constraint: the `PeriodStart` and `PeriodEnd` columns had to be modelled as shadow properties. You could query them with `EF.Property<DateTime>(entity, "PeriodStart")`, but you could not put them on your entity class and read them like any other column. That restriction is gone in EF Core 11 Preview 4, released on May 12, 2026 as part of [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/).

The fix lands as [efcore#38110](https://github.com/dotnet/efcore/pull/38110), closing an [issue filed in 2021](https://github.com/dotnet/efcore/issues/26463). It is a small change in line count and a big change in ergonomics.

## What the old shadow-property model looked like

Before Preview 4, a temporal entity could declare only the application columns. The period columns lived in the model but not on the class:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal());
```

Reading the period values meant going through the change tracker:

```csharp
var start = context.Entry(order).Property<DateTime>("PeriodStart").CurrentValue;
var end   = context.Entry(order).Property<DateTime>("PeriodEnd").CurrentValue;
```

Two problems. First, you lose IntelliSense and refactor safety: the column name is a magic string. Second, projecting period values in a LINQ query is awkward because the property does not exist on the CLR type. Mapping a DTO that includes the validity window meant either a raw SQL query or `EF.Property<>` inside the `Select`, both of which fight the type system.

## The Preview 4 model

In Preview 4 you can simply put the period columns on the entity:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}
```

Configure them with the new strongly-typed `HasPeriodStart` and `HasPeriodEnd` overloads that take a lambda:

```csharp
modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal(ttb =>
{
    ttb.HasPeriodStart(o => o.PeriodStart);
    ttb.HasPeriodEnd(o => o.PeriodEnd);
}));
```

Now `PeriodStart` and `PeriodEnd` behave like any other mapped column. You can read them off a materialized entity, project them in `Select`, sort by them, and filter on them in plain LINQ:

```csharp
var openOrders = await context.Orders
    .Where(o => o.PeriodEnd == DateTime.MaxValue)
    .Select(o => new { o.Id, o.Status, o.PeriodStart })
    .ToListAsync();
```

That `PeriodEnd == DateTime.MaxValue` predicate is the canonical "current row" filter for SQL Server temporal tables. Previously you had to write it against the shadow property.

## What this does not change

The temporal table semantics on the database side are identical. SQL Server still maintains the history table, still updates `PeriodStart` and `PeriodEnd` on every write, and still rejects direct writes to the period columns. EF Core continues to mark them as `ValueGeneratedOnAddOrUpdate` and ignore them on insert and update. You can read them, you cannot set them.

Time-travel queries also work the same way:

```csharp
var snapshot = await context.Orders
    .TemporalAsOf(new DateTime(2026, 5, 1))
    .ToListAsync();
```

The only difference is that the returned entities now carry the period values on the CLR object instead of hiding them behind `EF.Property<>`.

## Migration is optional

If you have an existing model with shadow period columns, you do not need to change anything. The old API still works. For any new temporal-mapped entity, putting `PeriodStart` and `PeriodEnd` on the class is now the path of least resistance.

Full Preview 4 EF Core notes: [release-notes/11.0/preview/preview4/efcore.md](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/efcore.md).
