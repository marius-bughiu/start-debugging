---
title: "Dapper 2.1.86 brings back DateOnly and TimeOnly, two years after pulling them"
description: "Dapper 2.1.86 re-enables built-in DateOnly and TimeOnly mapping for parameters, members, and scalars, with the column-offset and silent default(T) bugs fixed. What changed, what I measured, and what it means for your custom type handlers."
pubDate: 2026-09-14
tags:
  - "dapper"
  - "dotnet"
  - "csharp"
---

Dapper 2.1.86 landed on NuGet on 2026-09-12, and the headline item is one line in the [release notes](https://github.com/DapperLib/Dapper/releases/tag/2.1.86): "Re-enable DateOnly/TimeOnly support, fixing the defects that got it disabled". If you have been carrying a `SqlMapper.TypeHandler<DateOnly>` around since .NET 6, this is the release that lets you delete it.

## How DateOnly support shipped, broke, and disappeared

Native `DateOnly`/`TimeOnly` mapping first arrived in 2.1.37 via [#2051](https://github.com/DapperLib/Dapper/pull/2051) in March 2024. Within weeks, users on 2.1.44 hit [#2072](https://github.com/DapperLib/Dapper/issues/2072): a `datetime` column mapped to a `DateOnly` property failed with `Error parsing column 1 (FromDate=Ed - String)`, which looked like an off-by-one because the error reported the wrong column's value. In April 2024 the feature was compiled out ([#2080](https://github.com/DapperLib/Dapper/pull/2080)), and every release from 2.1.66 through 2.1.79 shipped without it.

[PR #2228](https://github.com/DapperLib/Dapper/pull/2228) fixes the root causes rather than the symptoms:

- A column whose reported type needs a conversion (a `datetime` into `DateOnly`) no longer goes through `GetFieldValue<T>`. That was the #2072 crash.
- The member, scalar, and `Parse<T>` paths now convert `DateOnly`/`TimeOnly` to and from `DateTime`/`TimeSpan` in both directions. This matters because providers disagree: Npgsql 10 boxes a `date` column as `DateOnly`, while SqlClient and Npgsql 9 box `DateTime` ([#2226](https://github.com/DapperLib/Dapper/issues/2226)).
- `QuerySingle<DateOnly>` no longer returns `default(T)` without an error ([#2227](https://github.com/DapperLib/Dapper/issues/2227)).

## Before and after, measured

I ran the same file-based app against 2.1.79 and 2.1.86 on .NET SDK 10.0.302 with `Microsoft.Data.Sqlite` 10.0.12:

```csharp
#:package Dapper@2.1.86
#:package Microsoft.Data.Sqlite@10.0.12
#:property PublishAot=false
using Dapper;
using Microsoft.Data.Sqlite;

using var c = new SqliteConnection("Data Source=:memory:");
c.Open();

c.ExecuteScalar<string>("select @d", new { d = new DateOnly(2026, 9, 14) });
c.ExecuteScalar<string>("select @t", new { t = new TimeOnly(9, 30) });
c.QuerySingle<DateOnly>("select '2026-09-14'");
c.QuerySingle<Row>("select 'x' as Name, '2026-09-14' as Due");

public class Row { public string Name { get; set; } = ""; public DateOnly Due { get; set; } }
```

| Call | 2.1.79 | 2.1.86 |
| --- | --- | --- |
| `DateOnly` parameter | `NotSupportedException`: cannot be used as a parameter value | `2026-09-14` |
| `TimeOnly` parameter | `NotSupportedException` | `09:30:00` |
| `QuerySingle<DateOnly>` | `0001-01-01`, no error | `2026-09-14` |
| `DateOnly` member | `DataException`: Error parsing column 1 | `2026-09-14` |

The scalar row is the one to worry about if you are still on an older version: wrong data, no exception.

## What happens to your existing type handler

The standard workaround was a `SqlMapper.TypeHandler<DateOnly>` registered at startup. With that same handler registered on 2.1.86, my probe showed the built-in mapping taking over for parameters and `DateOnly` members: the handler's `SetValue` and `Parse` were never called. Only the scalar `QuerySingle<DateOnly>` path still called `Parse`. On 2.1.79 the same handler ran on all three paths.

If your handler only converted between `DateOnly` and `DateTime`, you lose nothing. If it did anything custom, such as writing dates as `yyyyMMdd` strings or integers, it is now skipped on the parameter path, and the database receives whatever the provider does with a raw `DateOnly`. Test before you upgrade.

## Scope

The support is compiled for the `net8.0` and `net10.0` targets in the package. The `netstandard2.0` and `net461` builds do not have it, and the test suite explicitly does not expect it to work with the legacy `System.Data.SqlClient`. Use `Microsoft.Data.SqlClient`.

The same release also retires the MyGet and AppVeyor feeds: Dapper now publishes to nuget.org only, via Trusted Publishing (OIDC). If a `nuget.config` still points at the old MyGet feed for pre-release builds, remove it.
