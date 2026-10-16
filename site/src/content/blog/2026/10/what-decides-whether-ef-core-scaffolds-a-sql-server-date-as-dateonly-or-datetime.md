---
title: "What Decides Whether EF Core Scaffolds a SQL Server `date` Column as `DateOnly` or `DateTime`?"
description: "The EF Core version of the SQL Server provider in your startup project decides it: EF Core 7 and earlier scaffold date as DateTime, EF Core 8 through 11 scaffold it as DateOnly. Here is the type mapping that makes the call, measured output from EF Core 7, 8, 10, and 11 RC 2, and the two ways to get DateTime back without silently remapping the column to datetime2."
pubDate: 2026-10-16
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "sql-server"
  - "scaffolding"
  - "dateonly"
---

**Short answer:** one thing decides it, the version of `Microsoft.EntityFrameworkCore.SqlServer` (and `Microsoft.EntityFrameworkCore.Design`) that your startup project references when you run `dotnet ef dbcontext scaffold`. The scaffolder asks the provider's type mapping source for the default CLR type of each store type. Up to EF Core 7 that lookup returns `DateTime` for `date` and `TimeSpan` for `time`. From EF Core 8 on, through EF Core 10 and the EF Core 11 release candidates, it returns `DateOnly` and `TimeOnly`. There is no `dotnet ef` switch to change this. If you need `DateTime` back, either override the type mapping at design time through `IDesignTimeServices`, or edit the T4 template. If you use the template fix from the official breaking-change notes as written, your `date` columns end up mapped as `datetime2` at runtime. The rest of this post shows why, and how to fix it.

I measured everything below on macOS with SDK 10.0.302 against `Microsoft.EntityFrameworkCore.SqlServer` 7.0.20, 8.0.32, 10.0.13, and 11.0.0-rc.2.26504.105 (on SDK 11.0.100-rc.1). There is no SQL Server on this machine, so I built the `DatabaseModel` that the scaffolder normally reads from `INFORMATION_SCHEMA` myself and fed it through the real SQL Server design-time services. The code generation path (scaffolding model factory, C# generator, T4 templates) is the same one `dotnet ef dbcontext scaffold` runs after it has read the schema.

## The type mapping source makes the call, not the tool

When you scaffold, EF Core reads each column's store type (`date`, `datetime2`, `nvarchar(50)`, and so on) and has to choose a CLR type. It does not have a separate table of scaffolding rules for this. It calls `IScaffoldingTypeMapper.FindMapping(storeType, ...)`, which asks the provider's `IRelationalTypeMappingSource` for the default mapping of that store type. Whatever CLR type the provider registers first for `date` is what lands in your entity.

In EF Core 8 the SQL Server provider gained built-in `DateOnly` and `TimeOnly` support ([dotnet/efcore#24507](https://github.com/dotnet/efcore/issues/24507)) and made them the default mappings for `date` and `time`. The [EF Core 8 breaking changes page](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only) lists this as a medium-impact change that only affects database-first users who re-scaffold.

Here is a probe that asks the mapper directly:

```csharp
// .NET 10, EF Core 10.0.13 (same code compiles against 7.0.20, 8.0.32, 11.0.0-rc.2)
// Reference Microsoft.EntityFrameworkCore.Design with IncludeAssets="all" so the code can see its types.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Scaffolding.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Design.Internal;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
new SqlServerDesignTimeServices().ConfigureDesignTimeServices(services);
services.AddEntityFrameworkDesignTimeServices();
var mapper = services.BuildServiceProvider().GetRequiredService<IScaffoldingTypeMapper>();

foreach (var storeType in new[] { "date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset" })
    Console.WriteLine($"{storeType,-15} -> {mapper.FindMapping(storeType, keyOrIndex: false, rowVersion: false)?.ClrType.Name}");
```

The results, one column per provider version:

| Store type | EF Core 7.0.20 | EF Core 8.0.32 | EF Core 10.0.13 | EF Core 11.0 RC 2 |
| --- | --- | --- | --- | --- |
| `date` | `DateTime` | `DateOnly` | `DateOnly` | `DateOnly` |
| `time` | `TimeSpan` | `TimeOnly` | `TimeOnly` | `TimeOnly` |
| `datetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetime2` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `smalldatetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetimeoffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` |

So these are the facts that decide it:

- **The provider package version in the startup project.** `dotnet ef` loads `Microsoft.EntityFrameworkCore.Design` and the provider from your project's build output, not from the tool package, so the mapping comes from the project's EF Core version. Pinning an older `dotnet-ef` tool does not bring `DateTime` back. It only gets you the "tools version is older than that of the runtime" warning, or worse.
- **The store type, not the data.** `date` and `time` changed. `datetime`, `datetime2`, and `smalldatetime` scaffold to `DateTime` in every version, because none of them is date-only.
- **The provider.** This is a per-provider decision. Npgsql's design-time services (I checked 10.0.3) also map PostgreSQL `date` to `DateOnly` and `time` to `TimeOnly`.

Nothing else matters: not the SQL Server version, not the database compatibility level, not `--use-database-names`, not `--data-annotations`.

## What the scaffolded code looks like before and after

I scaffolded a table with an `int` key, a `date NOT NULL`, a nullable `date`, a `time`, and a `datetime2`. EF Core 7.0.20 writes this:

```csharp
// Scaffolded by EF Core 7.0.20
public partial class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime? ShippedOn { get; set; }
    public TimeSpan CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
    entity.Property(e => e.OrderDate).HasColumnType("date");
    entity.Property(e => e.ShippedOn).HasColumnType("date");
});
```

EF Core 8.0.32, 10.0.13, and 11.0 RC 2 write this, identical across the three:

```csharp
// Scaffolded by EF Core 8.0.32 / 10.0.13 / 11.0.0-rc.2
public partial class Order
{
    public int Id { get; set; }
    public DateOnly OrderDate { get; set; }
    public DateOnly? ShippedOn { get; set; }
    public TimeOnly CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
});
```

Look at what disappeared from `OnModelCreating`. In EF Core 7, `DateTime` maps to `datetime2` by convention, so the scaffolder had to write `HasColumnType("date")` to keep the column a `date`. In EF Core 8+, `DateOnly` maps to `date` by convention, so the scaffolder treats `HasColumnType("date")` as redundant and drops it. The column type is no longer anywhere in the generated code. It is implied by the CLR type. That detail is why the obvious way back to `DateTime` is broken.

## The template fix from the docs drops the column type

The breaking-change page suggests a mitigation: run `dotnet new ef-templates`, open `CodeTemplates/EFCore/EntityType.t4`, and swap the CLR type when the column is `date` or `time`:

```csharp
// EntityType.t4 snippet from the EF Core 8 breaking-changes page
var clrType = property.GetColumnType() switch
{
    "date" when property.ClrType == typeof(DateOnly) => typeof(DateTime),
    "date" when property.ClrType == typeof(DateOnly?) => typeof(DateTime?),
    "time" when property.ClrType == typeof(TimeOnly) => typeof(TimeSpan),
    "time" when property.ClrType == typeof(TimeOnly?) => typeof(TimeSpan?),
    _ => property.ClrType
};
```

I applied that edit to the EF Core 10.0.13 templates (`Microsoft.EntityFrameworkCore.Templates` 10.0.13) and scaffolded again. The entity now says `DateTime OrderDate`. But `DbContext.t4` still renders the fluent API from the model, where the property is `DateOnly`, so it still leaves out `HasColumnType("date")`. You get a `DateTime` property with no column type anywhere.

At runtime EF Core then applies the `DateTime` convention, which is `datetime2`. Here is a context that matches what the template produced, next to one with the column type restored:

```csharp
// .NET 10, EF Core 10.0.13
var day = new DateTime(2026, 10, 16);
foreach (DbContext db in new DbContext[] { new ImplicitContext(), new ExplicitContext() })
{
    var p = db.Model.FindEntityType(typeof(Order))!.FindProperty(nameof(Order.OrderDate))!;
    Console.WriteLine($"{db.GetType().Name}: {p.GetColumnType()}");
    Console.WriteLine(db.Set<Order>().Where(o => o.OrderDate == day).ToQueryString());
}

public class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
}

public class ImplicitContext() : ShopContext(false); // what the docs' template produces
public class ExplicitContext() : ShopContext(true);  // with HasColumnType("date")

public abstract class ShopContext(bool explicitType) : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlServer("Server=.;Database=Shop");
    protected override void OnModelCreating(ModelBuilder b) => b.Entity<Order>(e =>
    {
        e.Property(x => x.Id).ValueGeneratedNever();
        if (explicitType) e.Property(x => x.OrderDate).HasColumnType("date");
    });
}
```

Output:

```text
ImplicitContext: datetime2
DECLARE @day datetime2 = '2026-10-16T00:00:00.0000000';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
ExplicitContext: date
DECLARE @day date = '2026-10-16';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
```

Without the column type, every parameter compared against that column goes over the wire as `datetime2`. `datetime2` has higher [data type precedence](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql) than `date`, so SQL Server converts the column to `datetime2` for the comparison. A `DateTime` with a time portion then never equals a stored date, where a `date` parameter would have dropped the time first. If the project also uses migrations, `GenerateCreateScript()` now emits `[OrderDate] datetime2 NOT NULL`, and the next `migrations add` that touches the table wants to alter the column. The `time` half of the snippet is harmless, because `TimeSpan` maps to `time` by convention anyway.

The fix is one more block in the same template, right after the `switch`, so the swapped property carries its store type with it:

```csharp
// CodeTemplates/EFCore/EntityType.t4, EF Core 10.0.13 templates, after the clrType switch
        usings.AddRange(code.GetRequiredUsings(clrType));

        if (clrType != property.ClrType)
        {
            // Keep the store type: DateTime/TimeSpan would otherwise map to datetime2/time by convention.
            usings.Add("System.ComponentModel.DataAnnotations.Schema");
#>
    [Column(TypeName = "<#= property.GetColumnType() #>")]
<#
        }
```

Then replace `property.ClrType` with `clrType` in the `needsNullable`, `needsInitializer`, and property lines, as the docs show. Re-scaffolded, the entity comes out as:

```csharp
// Scaffolded by EF Core 10.0.13 with the patched EntityType.t4
using System.ComponentModel.DataAnnotations.Schema;

public partial class Order
{
    public int Id { get; set; }

    [Column(TypeName = "date")]
    public DateTime OrderDate { get; set; }

    [Column(TypeName = "date")]
    public DateTime? ShippedOn { get; set; }

    [Column(TypeName = "time")]
    public TimeSpan CutoffTime { get; set; }

    public DateTime CreatedAt { get; set; }
}
```

The attribute is emitted whether or not you pass `--data-annotations`, because it is written by your template code, not by the annotation code generator. That is what you want here, since the fluent side will never write it.

## The cleaner revert: override the type mapping at design time

The template approach patches the output after EF has already decided the property is `DateOnly`. A more robust option is to change the decision itself, which makes EF Core 8+ behave exactly like EF Core 7 for `date` and `time`, fluent API included. `dotnet ef` discovers any `IDesignTimeServices` implementation in the startup project and runs it **after** the provider's and EF's own registrations (see `DesignTimeServicesBuilder.CreateServiceCollection`), so a later `AddSingleton` wins:

```csharp
// .NET 10, EF Core 10.0.13 / 11.0. Lives in the startup project; only used by dotnet ef.
#pragma warning disable EF1001 // SqlServerTypeMappingSource is an internal API
using System.Data;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.SqlServer.Infrastructure.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;

public sealed class ShopDesignTimeServices : IDesignTimeServices
{
    public void ConfigureDesignTimeServices(IServiceCollection services)
        => services.AddSingleton<IRelationalTypeMappingSource, DateTimeScaffoldingTypeMappingSource>();
}

public sealed class DateTimeScaffoldingTypeMappingSource(
    TypeMappingSourceDependencies dependencies,
    RelationalTypeMappingSourceDependencies relationalDependencies,
    ISqlServerSingletonOptions sqlServerSingletonOptions)
    : SqlServerTypeMappingSource(dependencies, relationalDependencies, sqlServerSingletonOptions)
{
    protected override RelationalTypeMapping? FindMapping(in RelationalTypeMappingInfo mappingInfo)
        => mappingInfo.StoreTypeNameBase switch
        {
            "date" => new SqlServerDateTimeTypeMapping("date", DbType.Date),
            "time" => new SqlServerTimeSpanTypeMapping("time"),
            _ => base.FindMapping(mappingInfo)
        };
}
```

With this registered, EF Core 10.0.13 scaffolds the same table to the EF Core 7 output byte for byte: `DateTime OrderDate`, `DateTime? ShippedOn`, `TimeSpan CutoffTime`, and `HasColumnType("date")` back in `OnModelCreating`. Because the comparison now happens between `DateTime` and its `datetime2` default, the code generator knows the explicit column type is needed. A `time(0)` column also comes out right, as `HasColumnType("time(0)")`, where stock EF Core 10 writes `TimeOnly` with `HasPrecision(0)`.

Three things to know about this route:

- `SqlServerTypeMappingSource` lives in an `Internal` namespace, hence the `EF1001` suppression. Its constructor took two parameters in EF Core 8 and 9 and gained `ISqlServerSingletonOptions` in EF Core 10, so expect to touch this class on major upgrades.
- It only affects design time. Your `DbContext` at runtime never sees this service, because `IDesignTimeServices` is only invoked by the tooling.
- Use `AddSingleton`, not `TryAddSingleton`. The provider has already registered its type mapping source, so a `TryAdd` silently does nothing. The same trap shows up when you [replace the pluralizer for `dbcontext scaffold`](/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/).

If you scaffold through EF Core Power Tools or its `efcpt` CLI, this is already built in: its reverse engineering engine ships a `SqlServerTypeMappingSource` override doing exactly the above, toggled by `type-mappings` / `use-DateOnly-TimeOnly` in `efcpt-config.json`. The published config schema lists that setting with a default of `false`, so check your config file rather than assuming which type you will get.

## Should you revert at all?

Usually not. For a column that holds a calendar day, `DateOnly` is the honest type. A `DateTime` mapped to `date` carries a time and a `Kind` that the database throws away, and that mismatch is behind a lot of off-by-one-day bugs when values cross time zones or JSON boundaries. EF Core 8+ translates the common `DateOnly` members on SQL Server, `System.Text.Json` serializes it as `"2026-10-16"` out of the box, and Dapper [handles `DateOnly` natively again since 2.1.86](/2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support/).

Revert when you cannot move consumers in the same release: a shared DTO assembly, a reporting layer that does `DateTime` arithmetic everywhere, or a team that re-scaffolds weekly and cannot absorb a few hundred compile errors at once. In that case pick one of the two fixes above and make it part of the repo, so the next person who re-scaffolds gets the same types.

## Gotchas that show up after a re-scaffold

- **Half-migrated models.** If you scaffold only some tables with `--table`, the new entities get `DateOnly` and the old hand-maintained ones keep `DateTime`. Both work, since EF Core 8+ maps `DateTime` with `HasColumnType("date")` fine, but joins and comparisons across them now need conversions in C#. Decide on one type per column, not per scaffold date.
- **Code-first models are unaffected.** The default for an existing `DateTime` property is still `datetime2`, and an explicit `HasColumnType("date")` still works. Nothing changes at runtime when you upgrade the package. Only freshly generated code changes. If a migration suddenly wants to alter a column after an upgrade, look for a missing column type like the one above, then read [why EF Core reports pending model changes](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/).
- **`datetime` stays `DateTime`.** Only `date` and `time` changed. A legacy `datetime` column (3.33 ms precision) still scaffolds as `DateTime` with `HasColumnType("datetime")`, in every version.
- **Upgrading from EF Core 6 or 7 with the ErikEJ package.** If you used `ErikEJ.EntityFrameworkCore.SqlServer.DateOnlyTimeOnly` and `UseDateOnlyTimeOnly()` to get `DateOnly` before EF Core 8, remove both on upgrade. The support is built in now. The rest of that jump is covered in [the EF Core 6 to 11 breaking changes walkthrough](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Check the SQL, not the C#.** The `datetime2` remap above compiles, runs, and returns plausible results for midnight values. The only way to see it is the parameter type, so [log the SQL EF Core generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) or call `ToQueryString()` once after any scaffolding customization.

## Related

- [How to add custom pluralization to `dotnet ef dbcontext scaffold` with `IPluralizer`](/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/), the other `IDesignTimeServices` hook you will want in the same class.
- [Migrate EF Core 6 to EF Core 11: the breaking changes that bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix "The JSON value could not be converted to System.DateTime"](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/), including when a wire value should be a `DateOnly`.
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Sources

- [Breaking changes in EF Core 8.0: SQL Server `date` and `time` now scaffold to `DateOnly` and `TimeOnly`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only), Microsoft Learn.
- [dotnet/efcore#24507: DateOnly and TimeOnly support for SQL Server](https://github.com/dotnet/efcore/issues/24507)
- [Custom reverse engineering templates (T4)](https://learn.microsoft.com/en-us/ef/core/managing-schemas/scaffolding/templates), Microsoft Learn.
- [Design-time services](https://learn.microsoft.com/en-us/ef/core/cli/services), Microsoft Learn.
- [`DesignTimeServicesBuilder.cs` on the release/10.0 branch](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Design/Internal/DesignTimeServicesBuilder.cs), dotnet/efcore.
- [Data type precedence (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql), Microsoft Learn.
- [EF Core Power Tools `SqlServerTypeMappingSource`](https://github.com/ErikEJ/EFCorePowerTools/blob/master/src/Core/RevEng.Core.80/SqlServerTypeMappingSource.cs) and [efcpt config schema](https://github.com/ErikEJ/EFCorePowerTools/blob/master/samples/efcpt-schema.json), ErikEJ/EFCorePowerTools.
