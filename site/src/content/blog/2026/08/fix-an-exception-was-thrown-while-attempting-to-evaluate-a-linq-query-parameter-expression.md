---
title: "Fix: \"An exception was thrown while attempting to evaluate a LINQ query parameter expression\" in EF Core 11"
description: "EF Core throws this when a client-evaluated piece of your query throws while EF evaluates it. Read InnerException, turn on EnableSensitiveDataLogging, and move the null check outside the lambda."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "linq"
---

This is not a translation failure. EF Core 11 throws `An exception was thrown while attempting to evaluate a LINQ query parameter expression` when it has already decided that a subtree of your query is client-evaluable (a "query parameter"), and **your own code threw while EF was evaluating it**. Nine times out of ten the real error is a `NullReferenceException` on a captured object, and it is sitting in `InnerException`. Call `EnableSensitiveDataLogging()` on your `DbContextOptionsBuilder` to make EF print the exact expression it choked on, then move the null check out of the lambda and into the query composition. Everything below was verified against `Microsoft.EntityFrameworkCore` 10.0.11 on .NET 10; the throw site is character-for-character identical in the EF Core 11 previews, so the behaviour carries over unchanged.

## The error in context

There are two variants of this message, and which one you get depends entirely on whether sensitive data logging is on. Without it:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate a LINQ query parameter expression. See the inner exception for more information. To show additional information call 'DbContextOptionsBuilder.EnableSensitiveDataLogging'.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
   at System.Linq.Expressions.Interpreter.Instruction.NullCheck(Object o)
   at System.Linq.Expressions.Interpreter.FuncCallInstruction`2.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.Interpreter.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.LightLambda.Run(Object[] arguments)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.<Evaluate>g__EvaluateCore|74_0(...)
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.Evaluate(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.ProcessEvaluatableRoot(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.VisitBinary(BinaryExpression binary)
```

With `EnableSensitiveDataLogging()` turned on, the message changes to the far more useful variant that names the expression:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate the LINQ query parameter expression 'value(Program+<>c__DisplayClass0_0).filter.MinRating'. See the inner exception for more information.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
```

Note the article: the non-sensitive message says "a LINQ query parameter expression", the sensitive one says "the LINQ query parameter expression '...'". If you searched for one and landed here with the other, you are still in the right place. Both come from the same pair of resource strings, `ExpressionParameterizationException` and `ExpressionParameterizationExceptionSensitive`.

The `<>c__DisplayClass0_0` in that expression is the compiler-generated closure class holding your captured locals. `filter` is the captured variable, `MinRating` is the member access that blew up. That single string is usually enough to find the line.

## Why this happens

Before EF can build SQL, it walks your expression tree and splits it into two kinds of node: things that depend on the query root (`b.Rating`, which becomes a column) and things that do not (`filter.MinRating`, which becomes a SQL parameter). That second category is what EF calls funcletization, and it is handled by `ExpressionTreeFuncletizer`. For each evaluatable subtree, EF compiles a `Func<object>` and invokes it:

```csharp
// Microsoft.EntityFrameworkCore 11, ExpressionTreeFuncletizer.EvaluateCore
try
{
    return Lambda<Func<object>>(Convert(expression, typeof(object)))
        .Compile(preferInterpretation: true)
        .Invoke();
}
catch (Exception exception)
{
    throw new InvalidOperationException(
        _logger.ShouldLogSensitiveData()
            ? CoreStrings.ExpressionParameterizationExceptionSensitive(expression)
            : CoreStrings.ExpressionParameterizationException,
        exception);
}
```

That is the whole mechanism. Any exception your code throws inside a captured expression gets wrapped in this `InvalidOperationException` and rethrown. EF is not complaining about your query, it is reporting that running a piece of it failed.

This matters for how you debug it. The message is generic on purpose, because the expression text can contain user data, which is why the detailed variant is gated behind sensitive data logging. The specific error is always in `InnerException`, and the inner exception's stack trace points into `System.Linq.Expressions.Interpreter` rather than into your code, because EF compiles with `preferInterpretation: true`. Do not go looking for your own frames in that stack. Read the inner exception's type and message instead.

Contrast this with the sibling error, `The LINQ expression could not be translated`, which fires when EF cannot turn a construct into SQL at all. Different stage of the pipeline, different fix.

## Minimal repro

A `DbSet<Blog>`, a nullable filter DTO, and a `Where` that dereferences it:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
}

public class Filter { public int MinRating { get; set; } }

public class AppDb(DbContextOptions<AppDb> o) : DbContext(o)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}
```

```csharp
// .NET 10, C# 14, EF Core 10.0.11
Filter? filter = null;                                      // came back null from the request binder
var q = db.Blogs.Where(b => b.Rating >= filter!.MinRating); // no exception yet
var rows = q.ToList();                                      // throws here
```

Two details worth internalising:

- **Composing the query does not throw.** Building the `IQueryable` is free. Funcletization runs when the query is compiled, which happens on the terminal operator. I confirmed this by building the query and never enumerating it: no exception.
- **Every terminal operator throws, including `ToQueryString()`.** `ToList()`, `ToListAsync()`, `Any()`, `Count()`, and `ToQueryString()` all go through the same compilation path. That last one is handy, because it means you can reproduce this with no database connection at all.

Here are the inner exceptions I measured for the most common triggers, all against EF Core 10.0.11 with the SQLite provider:

| What you wrote | `InnerException` |
| --- | --- |
| `b.Rating >= filter!.MinRating` with `filter` null | `NullReferenceException` |
| `b.Rating >= config.MinRating` where the getter throws | your own exception, verbatim |
| `b.Rating == maybe!.Value` with `int? maybe = null` | `InvalidOperationException: Nullable object must have a value.` |
| `b.Rating == empty.First()` on an empty `List<int>` | `InvalidOperationException: Sequence contains no elements` |
| `b.Rating == int.Parse(raw)` with `raw = "not-a-number"` | `FormatException` |
| `b.Rating == map["nope"]` on a `Dictionary<string, int>` | `KeyNotFoundException` |
| `b.Rating >= Bad.Value` where the static initialiser throws | `TargetInvocationException` wrapping the real one |
| `b.Name == s!.Trim()` with `string? s = null` | `NullReferenceException` |

That last-but-one row catches people twice: a failing static field initialiser gives you three levels of nesting. The wrapper, then `TargetInvocationException`, then the exception you actually care about. Read `ex.InnerException.InnerException` before concluding the message is useless.

## Fix, in detail

The fix always has the same shape: make sure the captured expression cannot throw when EF evaluates it. There are four ways to do that, ranked.

### 1. Compose conditionally outside the lambda

This is the right fix for the overwhelmingly common "optional filter" case, and it produces better SQL too, because the predicate disappears entirely when the filter is absent:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
IQueryable<Blog> q = db.Blogs;

if (filter is not null)
{
    q = q.Where(b => b.Rating >= filter.MinRating);
}

var rows = await q.ToListAsync();
```

Verified with `filter` null: no exception, and no dead `WHERE` clause in the generated SQL.

### 2. Hoist the value into a local before the query

If the value is genuinely optional but the predicate is not, project it to a local with a defined fallback. EF then captures an `int`, which cannot throw:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var min = filter?.MinRating ?? int.MinValue;
var rows = await db.Blogs.Where(b => b.Rating >= min).ToListAsync();
```

This is also the fix for `int.Parse`, `Guid.Parse`, and dictionary lookups. Do the parse or the lookup before the query, where you can handle the failure properly, rather than inside a lambda where the failure arrives wrapped three layers deep.

### 3. Short-circuit inside the lambda

If you must keep everything in one expression, a `&&`, `||`, or ternary guard works. The funcletizer treats short-circuiting binary operators and `ConditionalExpression` specially and does not eagerly evaluate the dead branch:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var rows = await db.Blogs
    .Where(b => filter == null || b.Rating >= filter.MinRating)
    .ToListAsync();

// the ternary form behaves identically
var rows2 = await db.Blogs
    .Where(b => filter == null ? true : b.Rating >= filter.MinRating)
    .ToListAsync();
```

All three variants (`filter != null && ...`, `filter == null || ...`, and the ternary) returned cleanly in my repro with `filter` null. Rank this third anyway, for two reasons: it ships a `WHERE` clause that is always true to the database when the filter is absent, and it leans on funcletizer behaviour that has changed between major versions. Issue [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883) is exactly this shape, a conditional mixing a client-side condition with a database-side one, and it regressed to an `unbound variable` inner error during the EF Core 9 cycle before being patched.

### 4. Fix the thing that throws

If the culprit is a property getter that throws because a service is not initialised yet (the classic being a tenant resolver reading an ambient scope that is empty), none of the above helps. The query is fine; your composition root is broken. Make the getter return a value, or fail earlier with a message that says something useful.

## Gotchas and variants

**Query filters do not get wrapped.** If your `HasQueryFilter` lambda reads a field on the `DbContext` and that read throws, you get your raw exception, not this one. I set up a context with `HasQueryFilter(b => b.TenantId == _tenant.Current)` where `_tenant.Current` throws, and `db.Blogs.ToList()` surfaced `InvalidOperationException: no tenant in scope` directly. The reason is in the funcletizer: expressions that touch the context go down the context-accessor path, which returns a deferred `Lambda` instead of invoking it inside that `try` block. So if you are debugging a multi-tenant setup and you do see the parameterization wrapper, the offending capture is in an ordinary `Where`, not in the filter. Calling `IgnoreQueryFilters()` makes the query succeed and is a quick way to confirm which of the two you have.

**A null collection in `Contains` does not throw. It silently returns nothing.** This is the most dangerous variant on the page, because it looks like a fix:

```csharp
// .NET 10, C# 14, EF Core 10.0.11, SQLite provider
List<string>? names = null;
var rows = db.Blogs.Where(b => names!.Contains(b.Name)).ToList();
// rows.Count == 0, no exception
// SELECT "b"."Id", "b"."Name", "b"."Rating" FROM "Blogs" AS "b" WHERE 0
```

EF translates a null parameterized collection to an always-false predicate, exactly as it does for an empty one. You do not get an error, you get zero rows, and the bug ships. If a null list means "no filter" in your domain, say so explicitly with a `names is null ||` guard, or compose conditionally as in fix 1.

**`EF.Constant` does not save you.** Wrapping the capture as `EF.Constant(filter!.MinRating)` still throws. The dereference happens while evaluating the argument, before EF ever sees the marker method.

**A raw `NullReferenceException` instead of the wrapper means the throw was in your code, not EF's.** `db.Blogs.Take(filter!.MinRating)` throws a plain `NullReferenceException`, because `Take` accepts an `int`: the C# compiler evaluates that argument at the call site and it never becomes part of an expression tree. Same for `Skip`, and for anything you interpolate into a string before passing it in. Only lambdas get the wrapper.

**Chaining does not help.** Splitting into `db.Blogs.Where(b => b.Id == 0).Where(b => b.Rating >= filter!.MinRating)` still throws. Funcletization runs over the whole composed tree at compile time, not per operator, so an earlier filter cannot short-circuit a later capture.

**It throws on every execution, not just the first.** The compiled query cache keys on query shape, and funcletization runs before the cache lookup in order to extract the parameter values. There is no "it worked once and then started failing" here.

## Related

- The other EF Core query-time exception people confuse this with is covered in [why EF Core says the LINQ expression could not be translated](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), which is about constructs EF cannot turn into SQL at all.
- When the inner exception is `Sequence contains no elements`, the underlying LINQ operator behaviour is worth a read in [what actually throws on First and Single](/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- Turning on the sensitive variant of this message is one line of the broader setup described in [how to see the SQL EF Core generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- If you hit this while wiring up multi-tenancy, [named query filters for soft delete and multi-tenancy](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) covers getting the tenant id onto the context without a throwing getter.
- Parameterization also drives cache behaviour, which matters when you are chasing query performance with [compiled queries on hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Sources

- [CoreStrings.ExpressionParameterizationException](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.corestrings.expressionparameterizationexception) on MS Learn, for the exact resource string.
- [ExpressionTreeFuncletizer.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs) in dotnet/efcore, where the wrapping try/catch lives.
- [Client vs. server evaluation](https://learn.microsoft.com/en-us/ef/core/querying/client-eval) in the EF Core docs, for how EF splits a query tree.
- [DbContextOptionsBuilder.EnableSensitiveDataLogging](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablesensitivedatalogging), which switches on the message variant that names the expression.
- [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883), the EF Core 9 regression where a mixed client and database conditional produced this exception with an `unbound variable` inner error.
- [Finbuckle.MultiTenant discussion #792](https://github.com/Finbuckle/Finbuckle.MultiTenant/discussions/792), a representative report of this error in a multi-tenant context.
