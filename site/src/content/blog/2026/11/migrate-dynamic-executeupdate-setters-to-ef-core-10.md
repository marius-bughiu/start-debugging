---
title: "Migrate Dynamic ExecuteUpdate Setters From EF Core 9 to EF Core 10's UpdateSettersBuilder"
description: "EF Core 10 removed SetPropertyCalls<T> and the expression-tree overload of ExecuteUpdate, so helpers that set a property by name at runtime stop compiling. Here is the EF Core 9 code that breaks, the replacement built on Action<UpdateSettersBuilder<T>>, and the gotchas reproduced on EF Core 10.0.15 and 11.0.0."
pubDate: 2026-11-18
template: migration
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "migration"
  - "expression-trees"
  - "dotnet-11"
---

If you have a helper that calls `ExecuteUpdateAsync` with a property name known only at runtime ("update field X of entity T", a generic PATCH endpoint, an admin grid), it was almost certainly built by hand-assembling an `Expression<Func<SetPropertyCalls<T>, SetPropertyCalls<T>>>`. That code does not compile against EF Core 10 or EF Core 11: `SetPropertyCalls<T>` is gone, and the only `ExecuteUpdateAsync` overload now takes an `Action<UpdateSettersBuilder<T>>`. The fix is to stop building the outer expression tree entirely. Build only the property selector (`e => e.SomeProperty`) as an `Expression<Func<T, TProperty>>`, close one generic method over the property type, and call `builder.SetProperty(selector, value)` inside a normal delegate. Everything below was reproduced on EF Core 9.0.23, 10.0.15 and 11.0.0 with the SQLite provider; the replacement also fixes two bugs the old pattern had: values were inlined as SQL literals instead of parameters, and a boxed `int` could not be assigned to a `long` property.

**Scope and effort:** this is a contained code change in whatever helper builds the setters. No schema change, no migration, no data impact. If your dynamic updates only toggle known properties with `if` statements, you do not need any of this; the [EF Core 10 delegate setters](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) already cover that with plain C#.

## Why the delegate-based setters are worth the rewrite

- **The code shrinks.** You no longer chain `Expression.Call` nodes onto a `SetPropertyCalls<T>` parameter or look up the right `SetProperty` overload on it. Only the property selector is an expression tree.
- **Values become SQL parameters.** The EF Core 9 pattern used `Expression.Constant(value)` inside the setters tree, which EF translates as a literal (`SET "Notes" = 'out of stock'`). Every distinct value produces a different SQL string. The EF Core 10 typed `SetProperty(selector, value)` overload is parameterized (`SET "Notes" = @p1`). Both SQL statements are captured below.
- **Type conversion moves into C#.** You convert the incoming `object` to the property type once, with normal .NET rules, before any query is built, instead of fighting `Expression.Constant` type checks.
- **It is the only option.** There is no compatibility shim. The EF Core 10 [breaking-changes page](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes#ExecuteUpdateAsync-lambda) says expression-tree-building code "will no longer compile".

## What breaks when you bump to EF Core 10

| Area | Change | Severity |
| --- | --- | --- |
| `SetPropertyCalls<TSource>` | Type removed; replaced by `UpdateSettersBuilder<TSource>` | high (CS0246) |
| `ExecuteUpdate` / `ExecuteUpdateAsync` | The `Expression<Func<SetPropertyCalls<T>, SetPropertyCalls<T>>>` overload is gone; the only overload takes `Action<UpdateSettersBuilder<T>>` | high (CS1503) |
| Inline fluent lambdas | `s => s.SetProperty(b => b.Views, 8)` still compiles, because it converts to the new `Action` | none |
| Reflection over `SetPropertyCalls<>.SetProperty` | Nothing to reflect over; the method lives on `UpdateSettersBuilder<T>` and its first parameter is now `Expression<Func<T, TProperty>>`, not `Func<T, TProperty>` | high |
| Non-generic `UpdateSettersBuilder.SetProperty(LambdaExpression, ...)` | Public but marked `[EntityFrameworkInternal]` | do not build on it |

One detail the docs gloss over: the breaking-changes page says the new parameter is "a non-expression argument (`Func<...>`)". Reflecting over `Microsoft.EntityFrameworkCore` 10.0.15 shows the real signature:

```text
Task<int> ExecuteUpdateAsync<TSource>(IQueryable<TSource>, Action<UpdateSettersBuilder<TSource>>, CancellationToken)
UpdateSettersBuilder<TSource> SetProperty<TProperty>(Expression<Func<TSource, TProperty>>, TProperty)
UpdateSettersBuilder<TSource> SetProperty<TProperty>(Expression<Func<TSource, TProperty>>, Expression<Func<TSource, TProperty>>)
```

It is an `Action`, not a `Func`. The declaring type did not change: in both 9.0.23 and 10.0.15, `ExecuteUpdateAsync` lives on `EntityFrameworkQueryableExtensions` in the core `Microsoft.EntityFrameworkCore` assembly, so reflection that looks it up by name keeps finding it. That is the problem, as the gotchas below show.

## The EF Core 9 helper that stops compiling

This is the shape most "update by property name" helpers had, condensed from the pattern in the [Stack Overflow question](https://stackoverflow.com/questions/79819339) that prompted this post. It builds `s => s.SetProperty(e => e.A, valueA).SetProperty(e => e.B, valueB)` node by node:

```csharp
// .NET 10.0.10 runtime, Microsoft.EntityFrameworkCore.Sqlite 9.0.23
using System.Linq.Expressions;
using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Query;

public static class DynamicUpdate
{
    public static Task<int> ExecuteUpdateByNameAsync<T>(
        this IQueryable<T> source,
        IReadOnlyDictionary<string, object?> values,
        CancellationToken ct = default)
    {
        var s = Expression.Parameter(typeof(SetPropertyCalls<T>), "s");
        var e = Expression.Parameter(typeof(T), "e");

        // SetProperty<TProperty>(Func<T, TProperty> propertyExpression, TProperty valueExpression)
        MethodInfo setPropertyOpen = typeof(SetPropertyCalls<T>).GetMethods()
            .Single(m => m.Name == nameof(SetPropertyCalls<T>.SetProperty)
                      && m.GetParameters()[1].ParameterType.IsGenericParameter);

        Expression body = s;
        foreach (var (name, value) in values)
        {
            MemberExpression property = Expression.Property(e, name);
            LambdaExpression selector = Expression.Lambda(property, e);
            Expression constant = Expression.Constant(value, property.Type);
            body = Expression.Call(body, setPropertyOpen.MakeGenericMethod(property.Type), selector, constant);
        }

        var setters = Expression.Lambda<Func<SetPropertyCalls<T>, SetPropertyCalls<T>>>(body, s);
        return source.ExecuteUpdateAsync(setters, ct);
    }
}
```

On EF Core 9.0.23 it works, with two flaws visible in the log. Calling it with `["IsActive"] = false, ["Notes"] = "out of stock"` produced literals, not parameters:

```sql
-- EF Core 9.0.23, SQLite. Parameters=[]
UPDATE "Products" AS "p"
SET "Notes" = 'out of stock',
    "IsActive" = 0
WHERE "p"."Stock" = 0
```

And `["Views"] = 5` against a `long Views` property threw `ArgumentException: Argument types do not match`, because `Expression.Constant(5, typeof(long))` refuses a boxed `int`.

Point the same file at `Microsoft.EntityFrameworkCore.Sqlite` 10.0.15 and the build fails with six errors of two kinds:

```text
DynamicUpdate.cs(15,45): error CS0246: The type or namespace name 'SetPropertyCalls<>' could not be found
DynamicUpdate.cs(33,42): error CS1503: Argument 2: cannot convert from
  'Expression<Func<SetPropertyCalls<T>, SetPropertyCalls<T>>>' to 'Action<UpdateSettersBuilder<T>>'
```

## Pre-flight checklist

- Find every reference to `SetPropertyCalls` in the solution (`git grep -n SetPropertyCalls`). Inline lambdas such as `s => s.SetProperty(...)` will keep compiling; only code that names the type or builds expressions around it needs work.
- Find reflection that looks up `ExecuteUpdate` or `ExecuteUpdateAsync` by name (`GetMethod(nameof(...ExecuteUpdateAsync))`). Those calls compile fine and fail at runtime instead.
- Make sure you can see the generated SQL before and after, for example with `LogTo` filtered to `RelationalEventId.CommandExecuted` as in [logging the SQL EF Core generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Have a test that runs the dynamic update against a real provider. An in-memory SQLite connection is enough to catch translation failures; the EF in-memory provider does not support `ExecuteUpdate` at all (10.0.15 throws "The methods 'ExecuteUpdate' and 'ExecuteUpdateAsync' are not supported by the current database provider").

## Migration steps

1. Bump the EF Core packages and confirm the break is where you expect it.
   Update `Microsoft.EntityFrameworkCore.*` to 10.0.x (on .NET 10) or 11.0.x (on .NET 11) and build. Verify: the only errors are CS0246 on `SetPropertyCalls<>` and CS1503 on the `ExecuteUpdateAsync` call inside your helper.

2. Replace the outer expression tree with an `Action<UpdateSettersBuilder<T>>`.
   Resolve each property to a small setter delegate first, then apply them all inside the action. The action runs once per call, in C#, before EF translates anything:

   ```csharp
   // EF Core 10.0.15 / 11.0.0
   public static Task<int> ExecuteUpdateByNameAsync<T>(
       this IQueryable<T> source,
       IReadOnlyDictionary<string, object?> values,
       CancellationToken ct = default)
   {
       // Resolve and convert everything before touching the database.
       var setters = values.Select(kv => CreateSetter<T>(kv.Key, kv.Value)).ToList();

       return source.ExecuteUpdateAsync(b =>
       {
           foreach (var set in setters)
               set(b);
       }, ct);
   }
   ```

   Verify: the method compiles; `CreateSetter` comes in the next step.

3. Close one generic method over the property type, then stay strongly typed.
   `SetProperty<TProperty>` needs a compile-time `TProperty`. Instead of reflecting over `UpdateSettersBuilder<T>` to find the right overload, write your own generic method and close it with `MakeGenericMethod` once per property. Inside it, the selector is a real `Expression<Func<T, TProperty>>` and the call is ordinary C#:

   ```csharp
   // EF Core 10.0.15 / 11.0.0
   static readonly MethodInfo CreateTypedSetterMethod =
       typeof(DynamicUpdate).GetMethod(nameof(CreateTypedSetter), BindingFlags.NonPublic | BindingFlags.Static)!;

   static Action<UpdateSettersBuilder<T>> CreateSetter<T>(string name, object? value)
   {
       PropertyInfo property = typeof(T).GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase)
           ?? throw new ArgumentException($"'{typeof(T).Name}' has no property '{name}'.", nameof(name));

       return (Action<UpdateSettersBuilder<T>>)CreateTypedSetterMethod
           .MakeGenericMethod(typeof(T), property.PropertyType)
           .Invoke(null, BindingFlags.DoNotWrapExceptions, null, [property, value], null)!;
   }

   static Action<UpdateSettersBuilder<T>> CreateTypedSetter<T, TProperty>(PropertyInfo property, object? value)
   {
       var e = Expression.Parameter(typeof(T), "e");
       var selector = Expression.Lambda<Func<T, TProperty>>(Expression.Property(e, property), e);
       TProperty typed = ConvertValue<TProperty>(value, property.Name);

       return b => b.SetProperty(selector, typed);
   }
   ```

   `BindingFlags.DoNotWrapExceptions` matters: without it, a bad value surfaces as `TargetInvocationException: Exception has been thrown by the target of an invocation` instead of your own `ArgumentException`. Verify: a call with a misspelled property name throws `ArgumentException` before any SQL is logged.

4. Convert the incoming value to the property type in C#.
   This is the part the old `Expression.Constant(value, property.Type)` did badly. Handle `null` for nullable targets, values that already have the right type, `JsonElement` from a deserialized PATCH body, and everything else through `Convert.ChangeType`:

   ```csharp
   // EF Core 10.0.15 / 11.0.0, System.Text.Json
   static TProperty ConvertValue<TProperty>(object? value, string name)
   {
       switch (value)
       {
           case null when default(TProperty) is null:
               return default!;
           case null:
               throw new ArgumentException($"'{name}' is {typeof(TProperty).Name} and cannot be set to null.");
           case TProperty typed:
               return typed;
           case JsonElement json:
               return json.Deserialize<TProperty>()!;
           default:
               var target = Nullable.GetUnderlyingType(typeof(TProperty)) ?? typeof(TProperty);
               return (TProperty)Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
       }
   }
   ```

   `default(TProperty) is null` is true for reference types and for `Nullable<T>`, so `null` into `DateTime?` works and `null` into `int` fails fast. Verify: `["Views"] = 5` on a `long` property now succeeds instead of throwing "Argument types do not match".

5. Keep a non-generic entry point if callers only have a `Type`.
   Code that receives an `IQueryable` and a runtime entity type (the original Stack Overflow helper took `Type EntityType`) can forward to the generic method. Close your own method, not EF's, so you never have to reflect over EF's overloads again:

   ```csharp
   // EF Core 10.0.15 / 11.0.0
   public static Task<int> ExecuteUpdateByNameAsync(
       this IQueryable source,
       IReadOnlyDictionary<string, object?> values,
       CancellationToken ct = default)
   {
       var method = typeof(DynamicUpdate).GetMethods()
           .Single(m => m.Name == nameof(ExecuteUpdateByNameAsync) && m.IsGenericMethodDefinition)
           .MakeGenericMethod(source.ElementType);
       return (Task<int>)method.Invoke(null, BindingFlags.DoNotWrapExceptions, null, [source, values, ct], null)!;
   }
   ```

   Verify: `IQueryable untyped = db.Products.Where(p => p.Id == 3); await untyped.ExecuteUpdateByNameAsync(...)` emits a single `UPDATE` with a `WHERE "p"."Id" = 3`.

6. Compare the SQL before and after.
   Run the same call on both versions with logging on. Verify: the `SET` clause uses `@p`, `@p1`, ... parameters instead of literals, and the row counts match.

## Verification on EF Core 10 and EF Core 11

The finished helper (steps 2 to 5 in one static class) was run for this post against an in-memory SQLite database seeded with three `Product` rows, once on .NET 10.0.10 with `Microsoft.EntityFrameworkCore.Sqlite` 10.0.15 and once on .NET 11.0.0 (SDK 11.0.100) with 11.0.0, on macOS arm64. Both versions produced the same SQL. The two-property update from the EF Core 9 example is now parameterized:

```sql
-- EF Core 10.0.15 and 11.0.0, SQLite. Parameters=[@p (DbType = Boolean), @p1 (Size = 12)]
UPDATE "Products" AS "p"
SET "IsActive" = @p,
    "Notes" = @p1
WHERE "p"."Stock" = 0
```

A boxed `int` into a `long` property and `null` into a `DateTime?` property in the same call:

```sql
-- Parameters=[@p (DbType = Int64)]
UPDATE "Products" AS "p"
SET "Views" = @p,
    "DiscontinuedAt" = NULL
```

A PATCH body deserialized as `Dictionary<string, JsonElement>` from `{ "price": 44.5, "notes": "spring sale" }`, matched case-insensitively to `Price` and `Notes`:

```sql
-- Parameters=[@p (DbType = Decimal), @p1 (Size = 11)]
UPDATE "Products" AS "p"
SET "Price" = @p,
    "Notes" = @p1
WHERE "p"."Id" = 1
```

The `null` literal in the second statement is EF's choice for a null value and is the same as what a hand-written `SetProperty(p => p.DiscontinuedAt, (DateTime?)null)` produces. Not tested for this post: SQL Server and PostgreSQL. The helper itself is provider-agnostic, but run your own check there before shipping.

## Why the typed overload parameterizes and your old constant did not

It looks like the same thing: EF's own `UpdateSettersBuilder<TSource>.SetProperty(selector, TProperty value)` also wraps the value in `Expression.Constant`. The [source](https://github.com/dotnet/efcore/blob/v10.0.0/src/EFCore/Query/SetPropertyCalls%60.cs) explains the difference in a comment: the constant "will get parameterized by the funcletizer as any method argument that isn't inside a lambda (just like parameters to Skip/Take)". In the EF Core 9 pattern your constant sat inside the setters lambda, where EF treats a `ConstantExpression` as a literal that belongs to the query shape. Literals mean a new SQL string, and a new query cache entry, for every distinct value. If your old helper ran on hot paths with user-supplied values, the migration removes a cache-pollution problem you may not have known you had.

## Shortcut: EF.Property when the type is known

If the property name is dynamic but you know its CLR type at compile time, you do not need reflection at all. `EF.Property<T>` works as an `ExecuteUpdate` selector:

```csharp
// EF Core 10.0.15 / 11.0.0
string column = "Notes";
await db.Products
    .Where(p => p.Id == 3)
    .ExecuteUpdateAsync(b => b.SetProperty(p => EF.Property<string?>(p, column), "restocked"));
// UPDATE "Products" AS "p" SET "Notes" = @p WHERE "p"."Id" = 3
```

Two caveats from the repro. A misspelled name is not caught until translation, and the error is the generic `InvalidOperationException: The following 'ExecuteUpdate' or 'ExecuteDelete' expression could not be translated`. A wrong type argument is not caught at all: `EF.Property<int>(p, "Views")` on a `long` column ran without complaint on both versions (EF Core 10.0.15 emitted `SET "Views" = CAST(@p AS INTEGER)`, EF Core 11.0.0 emitted `SET "Views" = @p`). That is harmless for `int` into `long` on SQLite and a silent truncation risk the other way round, so prefer the reflection helper when the type comes from data.

## Rollback plan

The change is code-only and reversible: pin the EF Core packages back to 9.0.x and restore the old helper from source control. There is no on-disk state to undo. You cannot keep one helper that compiles against both 9 and 10 without `#if` blocks, because the two versions share no setter type. If you multi-target, keep both implementations behind `#if NET10_0_OR_GREATER`-style symbols keyed on the EF version you reference for each target framework.

## Gotchas reproduced while porting

**The primary key is just another column to ExecuteUpdate.** Passing `["Id"] = 42` through the helper on EF Core 11.0.0 produced `UPDATE "Products" AS "p" SET "Id" = @p WHERE "p"."Id" = 3` and changed the key from 3 to 42 with no error. `SaveChanges` refuses this (see [the property is part of a key and so cannot be modified](/2026/10/fix-the-property-is-part-of-a-key-and-so-cannot-be-modified-in-ef-core/)), `ExecuteUpdate` does not. If the property names come from a client, check them against the EF model, not just the CLR type:

```csharp
// EF Core 11.0.0
using Microsoft.EntityFrameworkCore.Metadata;

IEntityType entityType = db.Model.FindEntityType(typeof(Product))!;
IProperty? property = entityType.FindProperty(name);
if (property is null || property.IsPrimaryKey() || property.IsConcurrencyToken)
    throw new ArgumentException($"'{name}' cannot be updated.");
```

In the repro this returned "primary key" for `Id`, "not mapped" for a `[NotMapped] DisplayName`, and "ok" for `Notes`.

**Unmapped CLR properties fail late.** Without the model check, a `[NotMapped]` property passes `typeof(T).GetProperty` and then fails at translation with the same "could not be translated" `InvalidOperationException` as a misspelled `EF.Property` name. Another reason to validate against `IEntityType` first. For more on reading these messages, see [fixing "The LINQ expression could not be translated"](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

**Do not build on the non-generic `UpdateSettersBuilder`.** Reflection shows a tempting `SetProperty(LambdaExpression, Expression)` on the base class, which would let you skip `MakeGenericMethod`. It is annotated `[EntityFrameworkInternal]`, with the usual warning that it "may be changed or removed without notice in any release". The one generic hop in step 3 costs nothing that matters next to a database round trip.

**Reflection that finds EF's method by name compiles and then breaks.** `typeof(EntityFrameworkQueryableExtensions).GetMethod(nameof(EntityFrameworkQueryableExtensions.ExecuteUpdateAsync))` still resolves on EF Core 10, now to the `Action<UpdateSettersBuilder<TSource>>` overload, so code that invokes it with an old-style expression argument compiles and fails only at runtime. On 10.0.15 that was:

```text
ArgumentException: Object of type 'System.Linq.Expressions.Expression1`1[System.Func`2[...]]'
  cannot be converted to type 'System.Action`1[Microsoft.EntityFrameworkCore.Query.UpdateSettersBuilder`1[Item]]'.
```

Closing your own generic method, as in step 5, avoids depending on EF's overload list at all.

**The tracked entities do not see the change.** As with any `ExecuteUpdate`, entities already loaded into the change tracker keep their old values. The [ExecuteUpdate vs load-and-SaveChanges comparison](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) covers when that matters and how to avoid a later `SaveChanges` overwriting your bulk write.

## Related

- [ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/), including conditional setters with plain `if` statements.
- [ExecuteUpdate vs loading entities and calling SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).
- [Migrating from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/), for the rest of the breaking changes between versions.
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Sources

- [Breaking changes in EF Core 10: ExecuteUpdateAsync now accepts a regular, non-expression lambda](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes#ExecuteUpdateAsync-lambda) and the tracking issue [dotnet/efcore#32018](https://github.com/dotnet/efcore/issues/32018).
- [What's new in EF Core 10](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew).
- `UpdateSettersBuilder<TSource>` source at [v10.0.0](https://github.com/dotnet/efcore/blob/v10.0.0/src/EFCore/Query/SetPropertyCalls%60.cs) and the internal base class in [UpdateSettersBuilder.cs](https://github.com/dotnet/efcore/blob/v10.0.0/src/EFCore/Query/UpdateSettersBuilder.cs).
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete) on Microsoft Learn.
- Stack Overflow: [How to use expression setters in ExecuteUpdate again in EF Core 10](https://stackoverflow.com/questions/79819339).
