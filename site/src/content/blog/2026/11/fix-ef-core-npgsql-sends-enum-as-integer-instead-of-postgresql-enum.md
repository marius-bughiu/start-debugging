---
title: "Fix: column is of type event_type but expression is of type integer (EF Core + Npgsql enum)"
description: "Since EF Core 9 the Npgsql provider ignores MapEnum on your NpgsqlDataSourceBuilder. Call o.MapEnum<T>() inside UseNpgsql, keep the data source MapEnum, and drop HasColumnType."
pubDate: 2026-11-21
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "postgresql"
  - "npgsql"
---

**Short answer:** starting with `Npgsql.EntityFrameworkCore.PostgreSQL` 9.0, the EF provider no longer reads enum mappings from your `NpgsqlDataSourceBuilder`. If you only call `dataSourceBuilder.MapEnum<EventType>()` (plus `HasPostgresEnum` and `HasColumnType("event_type")`), EF Core maps the property as a plain `int` and binds the parameter as `integer`, so PostgreSQL rejects the insert with `42804`. Add `o.MapEnum<EventType>("event_type")` inside `UseNpgsql(dataSource, o => ...)`, keep the `MapEnum` on the data source builder because you built that data source yourself, and remove `HasColumnType`. Do the same in your design-time factory.

The behaviour below was checked on macOS with .NET SDK 10.0.302, EF Core 10.0.15 and `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.4, and again on .NET SDK 11.0.100 with EF Core 11.0.0 and `Npgsql.EntityFrameworkCore.PostgreSQL` 11.0.0 (released 2026-11-20). Both runs printed byte-identical output. No PostgreSQL server was involved: the repro intercepts EF Core right before it would talk to the database and prints the type mapping, the DDL and the exact parameter it would send. The final `42804` error comes from the server, so it is quoted from the original report, not reproduced here.

## The error in context

The report that prompted this post ([Stack Overflow 79917751](https://stackoverflow.com/questions/79917751)) shows an insert like this:

```text
INSERT INTO campaigns (id, created_at, event_type, ...) VALUES (@p0, @p1, @p2, ...)
Parameters: ..., @p2 = '0', ...

Npgsql.PostgresException: 42804: column "event_type" is of type event_type
but expression is of type integer
```

`42804` is PostgreSQL's `datatype_mismatch` SQLSTATE. The column really is of the enum type `event_type` (the migration created it correctly), but the value arrives as an `int4`, and PostgreSQL has no implicit cast from `integer` to an enum. The asker also reports that adding a string value converter only changes the error from `integer` to `text`: a typed `text` parameter does not implicitly cast to an enum either.

## Why EF Core 9+ sends an integer

Before 9.0, the EF provider "automatically picked up" enum mappings registered on `NpgsqlDataSourceBuilder` or on the obsolete `NpgsqlConnection.GlobalTypeMapper`, as the [9.0 release notes](https://www.npgsql.org/efcore/release-notes/9.0.html) put it. That is gone. In 9.0 and later, the EF model only knows about an enum if you register it with EF itself, through `MapEnum` on the `UseNpgsql` options builder.

When EF does not know the enum, it falls back to its default for any CLR enum: an `EnumToNumberConverter` to `int`. `HasColumnType("event_type")` only renames the store type. It does not change the mapping class, the converter, or the parameter type. Here is what the repro prints for the exact setup from the question (data source `MapEnum`, `HasPostgresEnum`, `HasColumnType`, no EF-level `MapEnum`):

```text
mapping: IntTypeMapping, store type 'event_type', converter: EnumToNumberConverter`2
ddl:     CREATE TYPE event_type AS ENUM ('purchase', 'signup', 'offer_trading');
ddl:     event_type event_type NOT NULL,
sql:     INSERT INTO campaigns (id, event_type, name) VALUES (@p0, @p1, @p2);
param @p1: value=2 (Int32), DataTypeName=integer, NpgsqlDbType=Integer
```

The migration is right, the column is right, and the parameter is still a 32-bit integer. That is exactly the combination that produces `42804`. Drop `HasColumnType` from that setup and the migration starts generating `event_type integer NOT NULL` instead, which is why people upgrading from 8.0 sometimes see a migration that "wants to convert my enum columns back to integers" ([efcore.pg #3390](https://github.com/npgsql/efcore.pg/issues/3390)).

## Minimal repro without a PostgreSQL server

You do not need a database to see which parameter EF Core builds. A connection interceptor suppresses the open, and a command interceptor dumps the `NpgsqlParameter` and aborts:

```csharp
// .NET 10 (SDK 10.0.302), EF Core 10.0.15, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.4,
// EFCore.NamingConventions 10.0.1. Same output on .NET 11 / EF Core 11.0.0 / Npgsql EF 11.0.0.
using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;
using Npgsql.NameTranslation;

const string cs = "Host=unused;Database=demo;Username=demo;Password=demo";

var dsb = new NpgsqlDataSourceBuilder(cs);
dsb.MapEnum<EventType>("event_type", nameTranslator: new NpgsqlSnakeCaseNameTranslator());
var dataSource = dsb.Build(); // Build() does not connect

var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseNpgsql(dataSource)                      // the question's setup: no EF-level MapEnum
    .UseSnakeCaseNamingConvention()
    .EnableServiceProviderCaching(false)        // so several configs can be compared in one process
    .AddInterceptors(new FakeOpen(), new Capture())
    .Options;

using var db = new AppDbContext(options);
var mapping = db.Model.FindEntityType(typeof(Campaign))!
    .FindProperty(nameof(Campaign.EventType))!.GetRelationalTypeMapping();
Console.WriteLine($"mapping: {mapping.GetType().Name}, store type '{mapping.StoreType}'");
Console.WriteLine(db.Database.GenerateCreateScript());

db.Campaigns.Add(new Campaign { Id = 1, Name = "x", EventType = EventType.OfferTrading });
try { db.SaveChanges(); } catch (Exception ex) when (ex is Captured || ex.InnerException is Captured) { }

public enum EventType { Purchase, Signup, OfferTrading }

public class Campaign
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public EventType EventType { get; set; }
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Campaign> Campaigns => Set<Campaign>();
    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.HasPostgresEnum<EventType>(name: "event_type", nameTranslator: new NpgsqlSnakeCaseNameTranslator());
        mb.Entity<Campaign>().Property(c => c.Id).ValueGeneratedNever();
        mb.Entity<Campaign>().Property(c => c.EventType).HasColumnType("event_type");
    }
}

class Captured : Exception;

class FakeOpen : DbConnectionInterceptor
{
    public override InterceptionResult ConnectionOpening(DbConnection c, ConnectionEventData e, InterceptionResult r)
        => InterceptionResult.Suppress();
    public override InterceptionResult ConnectionClosing(DbConnection c, ConnectionEventData e, InterceptionResult r)
        => InterceptionResult.Suppress();
}

class Capture : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand cmd, CommandEventData e, InterceptionResult<DbDataReader> r)
    {
        Console.WriteLine(cmd.CommandText);
        foreach (NpgsqlParameter p in cmd.Parameters)
            Console.WriteLine($"{p.ParameterName}: {p.Value} ({p.Value?.GetType().Name}), " +
                              $"DataTypeName={p.DataTypeName}, NpgsqlDbType={p.NpgsqlDbType}");
        throw new Captured();
    }
}
```

`EnableServiceProviderCaching(false)` matters if you compare several configurations in one process. EF caches the built model per internal service provider, and two contexts with identical options share one, so without it the second configuration silently reuses the first one's model.

## The fix, step by step

### 1. Register the enum with EF inside `UseNpgsql`

This is the line that changes the mapping. It works with a connection string or with your own data source:

```csharp
// EF Core 9+ / Npgsql.EntityFrameworkCore.PostgreSQL 9.0+ (checked on 10.0.4 and 11.0.0)
services.AddDbContext<AppDbContext>((sp, options) =>
    options.UseNpgsql(
            sp.GetRequiredService<NpgsqlDataSource>(),
            o => o.MapEnum<EventType>("event_type"))
        .UseSnakeCaseNamingConvention());
```

The signature is `MapEnum<TEnum>(string? enumName = null, string? schema = null, INpgsqlNameTranslator? nameTranslator = null)`. With it in place, the same insert binds the CLR enum itself and tells Npgsql the PostgreSQL type name:

```text
mapping: NpgsqlEnumTypeMapping, store type 'event_type', converter: none
ddl:     CREATE TYPE event_type AS ENUM ('offer_trading', 'purchase', 'signup');
param @p1: value=OfferTrading (EventType), DataTypeName=event_type, NpgsqlDbType=Unknown
```

Note the labels came out snake_cased (`offer_trading`) without passing a name translator, so the EF-side default already matches `NpgsqlSnakeCaseNameTranslator`. Also note the label order. That is a separate trap, covered below.

### 2. Keep `MapEnum` on the data source builder if you build the data source

EF's `MapEnum` configures both layers only when EF owns the data source, which is the case when you pass a connection string. When you pass an external `NpgsqlDataSource`, EF cannot reach into an object that has already been built. The [enum mapping docs](https://www.npgsql.org/efcore/mapping/enum.html) say you "must make sure to map your enum on that data independently of the EF-level setup".

The repro shows why this is easy to miss: with an external data source, configurations "EF `MapEnum` only" and "EF `MapEnum` plus data source `MapEnum`" produce the identical model, DDL and parameter (`value=OfferTrading (EventType), DataTypeName=event_type`). The difference only appears when Npgsql serializes that parameter. A data source that never saw `MapEnum<EventType>` has no converter for writing an `EventType` value. In Npgsql's source that path ends in an `InvalidCastException` of the form `Writing values of '...EventType' is not supported for parameters having DataTypeName 'event_type'` ([AdoSerializerHelpers.cs](https://github.com/npgsql/npgsql/blob/v10.0.0/src/Npgsql/Internal/AdoSerializerHelpers.cs)). Without a server, this repro could not trigger that path, so treat it as the source-level expectation, not an observed run. A single shared helper keeps the two sides from drifting:

```csharp
// Npgsql 10 / Npgsql.EntityFrameworkCore.PostgreSQL 10.0.4 (same API on 11.0.0)
using Npgsql;
using Npgsql.EntityFrameworkCore.PostgreSQL.Infrastructure; // NpgsqlDbContextOptionsBuilder

public static class PgEnums
{
    public static NpgsqlDataSourceBuilder MapAppEnums(this NpgsqlDataSourceBuilder b)
    {
        b.MapEnum<EventType>("event_type");
        return b;
    }

    public static NpgsqlDbContextOptionsBuilder MapAppEnums(this NpgsqlDbContextOptionsBuilder o)
    {
        o.MapEnum<EventType>("event_type");
        return o;
    }
}

// Program.cs
var dataSource = new NpgsqlDataSourceBuilder(connectionString).MapAppEnums().Build();
builder.Services.AddSingleton(dataSource);
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
    options.UseNpgsql(sp.GetRequiredService<NpgsqlDataSource>(), o => o.MapAppEnums()));
```

If the only reason you built your own data source was to call `MapEnum`, or to set other ADO-level options, you can drop it and use `UseNpgsql(connectionString, o => o.MapEnum<EventType>("event_type").ConfigureDataSource(dsb => ...))`. That way the enum is mapped in exactly one place. The provider docs warn against putting *varying* configuration inside `ConfigureDataSource`, because EF cannot detect those differences when it caches data sources ([Npgsql EF getting started](https://www.npgsql.org/efcore/index.html)). Keep an external data source if Dapper or raw `NpgsqlCommand` code shares it with EF.

### 3. Remove `HasColumnType("event_type")`

With `MapEnum` in place, the store type comes from the mapping. `HasColumnType` is harmless next to `MapEnum` (the repro shows the same `NpgsqlEnumTypeMapping` either way), but without `MapEnum` it is actively misleading: it makes the migration look correct while the parameter stays `integer`.

### 4. Use the same configuration in `IDesignTimeDbContextFactory`

`dotnet ef` builds the model from your design-time factory if you have one. If the factory still uses the old setup, `migrations add` compares an `int`-mapped model against your snapshot and generates column type changes nobody asked for. Call the same `MapAppEnums()` helper there. If the factory is not being picked up at all, see [the fix for "Unable to create a DbContext" from dotnet ef](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Gotchas and lookalikes

### `HasPostgresEnum<T>("event_type")` creates a schema, not a type name

The generic overload is `HasPostgresEnum<TEnum>(string? schema = null, string? name = null, INpgsqlNameTranslator? nameTranslator = null)`. The first string is the **schema**. The question's "also tried" variant `HasPostgresEnum<EventType>("event_type")` therefore produces this DDL next to the one `MapEnum` generates:

```text
CREATE TYPE event_type AS ENUM ('offer_trading', 'purchase', 'signup');
IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'event_type') THEN
    CREATE SCHEMA event_type;
CREATE TYPE event_type.event_type AS ENUM ('purchase', 'signup', 'offer_trading');
```

Two enum types and a stray schema. Always pass `name:` explicitly, or drop `HasPostgresEnum` once `MapEnum` is in place. Note that `MapEnum` puts the name first (`enumName`, then `schema`), the opposite of `HasPostgresEnum`.

### `MapEnum` creates labels in alphabetical order

`NpgsqlPostgresModelFinalizingConvention` registers every `MapEnum` enum with `Labels.Values.Order(StringComparer.Ordinal)` ([source at v10.0.4](https://github.com/npgsql/efcore.pg/blob/v10.0.4/src/EFCore.PG/Metadata/Conventions/NpgsqlPostgresModelFinalizingConvention.cs)). So a fresh database gets `('offer_trading', 'purchase', 'signup')`, while the old `HasPostgresEnum<T>()` produced declaration order `('purchase', 'signup', 'offer_trading')`. [PostgreSQL enums are ordered by label creation order](https://www.postgresql.org/docs/current/datatype-enum.html#DATATYPE-ENUM-ORDERING), which means `ORDER BY event_type` and any `<`/`>` comparison that runs in SQL use that order, not the C# integer values. Changing this is tracked as an open issue ([efcore.pg #3398](https://github.com/npgsql/efcore.pg/issues/3398)) and is unchanged in 11.0.0.

For an existing database migrated with the pre-9 setup, the model diff between "old `HasPostgresEnum`" and "new `MapEnum`" is one `AlterDatabaseOperation` that only reorders the labels:

```text
op: AlterDatabaseOperation
  new Npgsql:Enum:event_type = offer_trading,purchase,signup
  old Npgsql:Enum:event_type = purchase,signup,offer_trading
generated SQL commands: 0
```

The SQL generator emits nothing for it on 10.0.4 and 11.0.0 (the `ALTER TYPE ... ADD VALUE ... BEFORE` it used to emit was fixed in [efcore.pg #3424](https://github.com/npgsql/efcore.pg/issues/3424)), so you get an empty migration and a snapshot change that you must commit. If you want the model to keep declaration order, keep `HasPostgresEnum<EventType>(name: "event_type")` alongside `MapEnum`. An explicit `HasPostgresEnum` wins over the convention, and in the repro the diff from the old model to "`MapEnum` plus kept `HasPostgresEnum`" was **zero operations**. A fresh database will then still have declaration order.

### A string converter does not help

`HasConversion<string>()` changes the parameter to `text`, and per the original report PostgreSQL then rejects it with the same `42804`, naming `text` instead of `integer`. Only an `NpgsqlEnumTypeMapping` (from `MapEnum`) makes Npgsql send the value as the enum type. If you do want a `text` column, remove the PostgreSQL enum from the model altogether.

### Same message from a raw `NpgsqlCommand` or Dapper

That path never touches EF. There, only `NpgsqlDataSourceBuilder.MapEnum<T>()` matters, and the parameter value must be the CLR enum itself (or carry `DataTypeName = "event_type"`). Casting to `int` before binding sends an `integer` parameter, which is exactly what EF was doing above.

### "Writing values of ... is not supported"

This is the mirror image of the main error: EF knows the enum (step 1 done) but the external data source does not (step 2 skipped). Add `MapEnum` to the data source builder.

## Related

- [Setting PostgreSQL session parameters on every EF Core connection with Npgsql](/2026/10/how-to-set-postgresql-session-parameters-on-every-ef-core-connection-with-npgsql/) uses the same external `NpgsqlDataSource` plus interceptor setup.
- [Upgrading from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) collects the other breaking changes you hit on the way to 9+.
- [Fixing `dotnet ef` when it cannot create your DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) covers the design-time factory that must carry the same `MapEnum` call.
- [Appending to a jsonb array atomically with EF Core and Npgsql](/2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql/) is another case where the Npgsql type mapping decides what SQL you get.
- [What EF Core writes back into an entity after SaveChangesAsync](/2026/11/what-does-ef-core-write-back-into-an-entity-after-savechangesasync/) uses a similar interceptor-based look at what `SaveChanges` sends.

## Sources

- [Npgsql EF Core provider: Enum type mapping](https://www.npgsql.org/efcore/mapping/enum.html)
- [Npgsql EF Core 9.0 release notes: improved configuration for enums and plugins](https://www.npgsql.org/efcore/release-notes/9.0.html)
- [Npgsql EF Core provider: getting started, `ConfigureDataSource`](https://www.npgsql.org/efcore/index.html)
- [efcore.pg #3390: Enum mapping with v9 and ordering](https://github.com/npgsql/efcore.pg/issues/3390)
- [efcore.pg #3398: order enum labels by .NET value instead of alphabetically](https://github.com/npgsql/efcore.pg/issues/3398)
- [efcore.pg #3424: don't generate a migration for enum label order change](https://github.com/npgsql/efcore.pg/issues/3424)
- [PostgreSQL documentation: enumerated types and ordering](https://www.postgresql.org/docs/current/datatype-enum.html)
- [Stack Overflow 79917751: Npgsql EF Core does not map enum to PostgreSQL enum type](https://stackoverflow.com/questions/79917751)
