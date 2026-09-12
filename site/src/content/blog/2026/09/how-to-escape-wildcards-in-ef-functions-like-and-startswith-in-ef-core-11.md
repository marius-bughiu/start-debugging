---
title: "How to escape % and _ wildcards in EF.Functions.Like and StartsWith queries in EF Core 11"
description: "StartsWith, EndsWith and Contains already escape % and _ for you in EF Core 11, but EF.Functions.Like does not. Here is the SQL EF generates, a reusable escape helper, and the escapeCharacter overload that makes it work on SQL Server, SQLite and PostgreSQL."
pubDate: 2026-09-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "linq"
---

**Short answer:** in EF Core 11 you do not need to escape anything for `string.StartsWith`, `EndsWith` or `Contains`. EF rewrites the search value into a pattern like `50\%%` and adds `ESCAPE N'\'` itself. `EF.Functions.Like` is different: it passes your pattern through untouched, so a user who types `50%` or `a_b` gets wildcard matches. Escape the user-supplied part yourself (backslash first, then `%`, `_`, and `[` on SQL Server) and call the three-argument overload, `EF.Functions.Like(p.Name, pattern, "\\")`. If you escape but leave out that third argument, SQL Server and SQLite treat your backslashes as literal characters and the query quietly returns nothing.

Everything below was measured on .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`) with `Microsoft.EntityFrameworkCore.SqlServer` and `Microsoft.EntityFrameworkCore.Sqlite` `11.0.0-rc.1.26425.128`. The SQL Server output comes from `ToQueryString()`. The SQLite queries actually ran against an in-memory database, so the row lists are real results.

## Why a percent sign in a search box returns the wrong rows

SQL `LIKE` has its own tiny pattern language. On SQL Server, [the `LIKE` reference](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql) defines four wildcards: `%` (any run of characters), `_` (any single character), `[abc]` (a character set or range) and `[^abc]` (a negated set). SQLite and PostgreSQL only have `%` and `_`. Any of those characters in a search term changes what the query means.

A product search that builds its pattern by string concatenation shows the problem straight away:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite in-memory
var term = "50%";   // what the user typed
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, "%" + term + "%"))
    .Select(p => p.Name)
    .ToListAsync();
```

With the rows `50% off sale`, `500 widgets`, `done 50%` and `done 500` in the table, that query returns **all four**. The pattern is `%50%%`, which means "contains 50", and the percent sign the user typed is gone. An underscore does the same thing: searching for `a_b` with `$"%{term}%"` matched both `a_b adapter` and `axb adapter`. On SQL Server a `[` in the term adds a third wildcard: `[x]` is a character class that matches the single character `x`, so a search for `[x]` becomes `%[x]%` and finds every name that contains an `x`.

This is not SQL injection. The value is still sent as a parameter (`DECLARE @p nvarchar(4000) = N'%50%%'`), so nobody can break out of the string. The problem is that the pattern means something other than what the user asked for, and nothing errors when that happens.

## What EF Core 11 already escapes for you

Before writing an escape helper, check whether you need one. Plain LINQ string methods are handled for you. This is what EF Core 11 RC 1 generates on SQL Server when the search value is a captured variable:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer
var term = "50%";
var q = db.Products.Where(p => p.Name.StartsWith(term));
Console.WriteLine(q.ToQueryString());
```

```sql
DECLARE @term_startswith nvarchar(4000) = N'50\%%';

SELECT [p].[Id], [p].[Name], [p].[Sku]
FROM [Products] AS [p]
WHERE [p].[Name] LIKE @term_startswith ESCAPE N'\'
```

EF evaluated the variable on the client, escaped it, appended the `%` and sent the result as a new parameter named `@term_startswith`. `EndsWith` gives you `N'%50\%'` in `@term_endswith`, and `Contains` gives you `N'%a\_b%'` in `@under_contains`. A constant such as `StartsWith("50%")` is escaped the same way and inlined as `LIKE N'50\%%' ESCAPE N'\'`.

The escaping lives in `SqlServerSqlTranslatingExpressionVisitor`. At the [`v11.0.0-rc.1.26425.128` tag](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs) the set of special characters is one line:

```csharp
// EF Core 11.0.0-rc.1, SqlServerSqlTranslatingExpressionVisitor.cs
private static bool IsLikeWildChar(char c)
    => c is '%' or '_' or '['; // See https://docs.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql
```

`EscapeLikePattern` puts a backslash in front of each of those characters and in front of any backslash already in the value. The SQLite provider has the same code, except its `IsLikeWildChar` is only `%` or `_`, because SQLite has no bracket classes.

Two provider details can catch you out:

- **SQLite does not use `LIKE` for `Contains` at all.** It translates `p.Name.Contains(term)` to `instr("p"."Name", @term) > 0`, so no escaping is needed there. `StartsWith` and `EndsWith` still become `LIKE ... ESCAPE '\'`.
- **Column-to-column comparisons skip `LIKE`.** `p.Name.StartsWith(p.Sku)` becomes `LEFT([p].[Name], LEN([p].[Sku])) = [p].[Sku]` on SQL Server and `substr(...)` on SQLite. Because the pattern is not known until the row is read, there is nothing to escape. A comment in the EF source warns that this form is "less efficient than LIKE (i.e. StartsWith does an index scan instead of seek)".

If all you need is "starts with", "ends with" or "contains" on user input, use the string methods and stop there. You only need `EF.Functions.Like` when you want wildcards that you placed yourself, such as `abc%def`, or the user's text in the middle of a larger pattern.

## Why EF.Functions.Like does not escape your input

`EF.Functions.Like(matchExpression, pattern)` is a direct mapping: the [SQL Server function mappings page](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions) lists it as `@matchExpression LIKE @pattern`, with no escaping step. That is deliberate. The pattern is supposed to contain wildcards, and EF has no way to know which `%` characters you meant and which came from the user. A request for EF to escape `Like` input automatically, [dotnet/efcore#19118](https://github.com/dotnet/efcore/issues/19118), was closed as not planned, and EF Core 11 still ships no public escape helper. The overload you need is the one with a third argument:

```csharp
public static bool Like(this DbFunctions _, string? matchExpression, string? pattern, string? escapeCharacter);
```

That overload translates to `@matchExpression LIKE @pattern ESCAPE @escapeCharacter`. So the job splits in two: escape the user's text in C#, then tell the database which escape character you used.

## Escaping user input for EF.Functions.Like step by step

1. **Pick one escape character and use it everywhere.** A backslash matches what EF uses internally, so the SQL you see in logs looks the same for `StartsWith` and `Like`. Any single character works, as long as the escape helper and the `escapeCharacter` argument agree.
2. **Escape the escape character first.** If you escape `%` first and then double every backslash, you double the backslashes you just added. The order has to be escape character, then wildcards.
3. **Escape `%` and `_` on every provider, and `[` on SQL Server.** Escaping `[` does no harm elsewhere: SQLite and PostgreSQL treat an escaped ordinary character as that character, so one helper works on all three.
4. **Add your own wildcards after escaping.** Only the user's text goes through the helper. The `%` characters you add around it stay live.
5. **Always pass `escapeCharacter`.** Without it, SQL Server and SQLite have no escape character at all.

A small static class covers all five:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public static class LikePattern
{
    public const string EscapeCharacter = "\\";

    public static string Escape(string value, char escape = '\\')
    {
        ArgumentNullException.ThrowIfNull(value);
        return value
            .Replace(escape.ToString(), $"{escape}{escape}") // must be first
            .Replace("%", $"{escape}%")
            .Replace("_", $"{escape}_")
            .Replace("[", $"{escape}[");                      // SQL Server bracket classes
    }

    public static string Contains(string value) => $"%{Escape(value)}%";
    public static string StartsWith(string value) => $"{Escape(value)}%";
    public static string EndsWith(string value) => $"%{Escape(value)}";
}
```

Use it like this:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var term = "a_b";
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, LikePattern.Contains(term), LikePattern.EscapeCharacter))
    .Select(p => p.Name)
    .ToListAsync();
```

On SQLite this produces `.param set @Contains '%a\_b%'` and `WHERE "p"."Name" LIKE @Contains ESCAPE '\'`, and it returns only `a_b adapter`. The same code against SQL Server generates `LIKE @Contains ESCAPE N'\'`. Here is how the rest of the test cases came out:

| Search term | Naive `Like` rows (SQLite) | Escaped `Like` rows (SQLite) |
| --- | --- | --- |
| `50%` | `50% off sale`, `500 widgets`, `done 50%`, `done 500` | `50% off sale`, `done 50%` |
| `a_b` | `a_b adapter`, `axb adapter` | `a_b adapter` |

The escaped version also returned only `[x] marked` for `[x]` (pattern `%\[x]%`), and only `C:\temp\logs` for `C:\temp` (pattern `%C:\\temp%`, where the backslash in the path was doubled and did not match `C:tempxlogs`).

You can call the helper inside the lambda. EF's parameter extraction evaluates any subtree that does not touch a column on the client, so `LikePattern.Contains(term)` runs once in .NET and its result becomes a parameter, named after the method (`@Contains`). Nothing about the helper needs to be translatable. If you prefer readable parameter names in your [SQL logs](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), compute the pattern into a local first. `var pattern = LikePattern.Contains(term);` shows up as `@pattern`.

## Forgetting escapeCharacter silently returns zero rows

Once people discover the escape problem, a common next mistake is to escape the term and then call the two-argument overload:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite -- WRONG
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape("a_b") + "%"));
```

```sql
WHERE "p"."Name" LIKE '%a\_b%'
```

With no `ESCAPE` clause, the backslash is an ordinary character, so the database looks for a literal `a\_b` (with `_` still a wildcard) and finds nothing. The [SQLite expression docs](https://www.sqlite.org/lang_expr.html#like) are explicit that there is no default escape character, and the SQL Server reference says the escape character "has no default". The query does not fail, it just returns an empty list, which makes this bug hard to spot in code review.

PostgreSQL is the exception. Its `LIKE` [treats backslash as the default escape character](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE), so the same code happens to work there. That is the worst combination: tests against a local PostgreSQL pass, and production on SQL Server returns nothing. Passing `escapeCharacter` explicitly gives you the same behaviour on all three.

## Choosing a different escape character

Backslash is not special to `LIKE`, it is just a convention. If your data is full of Windows paths or regex fragments, pick something rarer. The helper and the argument have to agree:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite
var term = "!%";
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape(term, '!') + "%", "!"));
// .param set @p '%!!!%%'
// WHERE "p"."Name" LIKE @p ESCAPE '!'
// ROWS: Promo!%
```

`!%` became `!!!%`: the literal `!` doubled to `!!`, then the `%` became `!%`. The `escapeCharacter` argument has to be exactly one character. Passing `"ab"` translates fine, but it fails when the query runs, with SQLite's `SqliteException: SQLite Error 1: 'ESCAPE expression must be a single character'`. SQL Server rejects it as well, since its escape character "must evaluate to only one character". Make it a `const`, as `LikePattern.EscapeCharacter` does, so nobody can pass the wrong value.

## Gotchas that are not about escaping

**Case sensitivity comes from the database.** On SQL Server, whether `LIKE` is case-sensitive depends on the column's collation, and escaping has nothing to do with it. SQLite has a trap that shows up in the probe above. `StartsWith` becomes `LIKE`, which SQLite compares case-insensitively for ASCII, while `Contains` becomes `instr`, which is case-sensitive. Searching `50% OFF` with `StartsWith` found `50% off sale`, but `Contains` with the same term found nothing. If you test against SQLite and deploy to SQL Server, be aware that each method follows different case rules.

**A leading `%` kills index seeks.** A parameterized `LIKE @p ESCAPE N'\'` whose value starts with a literal prefix can use an index on SQL Server. `%term%` cannot, whether you escape it or not. For real "search anywhere in the text" requirements on large tables, look at SQL Server full-text search (`EF.Functions.Contains` / `FreeText`) instead of piling more work onto `LIKE`.

**Reusing one variable in two string methods.** EF Core 8.0.0 had a bug where `b.Name.StartsWith(s) || b.Body.Contains(s)` sent the `Contains` pattern to both comparisons ([dotnet/efcore#32432](https://github.com/dotnet/efcore/issues/32432), fixed in 8.0.2). EF Core 11 generates two separate parameters, `@term_startswith = N'50\%%'` and `@term_contains = N'%50\%%'`. If you are still on 8.0.0 or 8.0.1, update the package.

**`StringComparison` overloads do not translate.** `p.Name.StartsWith(term, StringComparison.OrdinalIgnoreCase)` throws `InvalidOperationException: The LINQ expression ... could not be translated` on both providers in RC 1. The [translation failure guide](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) covers the rewrites. For this case, the answer is either the plain overload plus a case-insensitive collation, or `EF.Functions.Collate`.

**Compiled queries are fine.** Both the automatic `StartsWith` escaping and the `LikePattern` helper produce ordinary parameters, so they work with `EF.CompileAsyncQuery`. The escaping happens per execution, not when the query is compiled. See [compiled queries for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) if a search endpoint is one of yours.

**Agents and tools that build filters.** If an LLM tool or MCP server turns free text into `EF.Functions.Like` calls, as in the [EF Core over MCP example](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/), treat the model's arguments like any other user input and run them through the same helper.

## Picking the right tool for each search

- Exact prefix, suffix or substring match on user input: `StartsWith` / `EndsWith` / `Contains`. EF Core 11 escapes it for you.
- A pattern with wildcards you control, around user text: `EF.Functions.Like(col, LikePattern.Contains(term), LikePattern.EscapeCharacter)`.
- A pattern the user writes themselves, on purpose: two-argument `EF.Functions.Like`, but validate the input and think about what a lone `[` does on SQL Server.
- Relevance-ranked text search: full-text search, not `LIKE`.

Before you ship, check the generated SQL once for each provider you target. `ToQueryString()` takes one line, and it would have caught every bug in this post before production did.

### Read next

- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Fix: "The LINQ expression could not be translated" in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [How to store an enum as a string in EF Core 11 with a value converter](/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)

### Sources

- [LIKE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql), Microsoft Learn
- [Function mappings, SQL Server provider](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions), EF Core docs
- [`SqlServerSqlTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), dotnet/efcore
- [dotnet/efcore#19118: Escape provider-specific symbols in user input when using EF.Functions.Like](https://github.com/dotnet/efcore/issues/19118)
- [dotnet/efcore#32432: Incorrect parameter rewriting for StartsWith/EndsWith/Contains](https://github.com/dotnet/efcore/issues/32432)
- [SQLite: the LIKE operator](https://www.sqlite.org/lang_expr.html#like)
- [PostgreSQL: pattern matching with LIKE](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE)
