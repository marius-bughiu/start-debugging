---
title: "How to bind a complex query-string object with [AsParameters] in a minimal API in ASP.NET Core 11"
description: "Put [AsParameters] on a class or record to bind a whole query-string filter in an ASP.NET Core 11 minimal API. Covers defaults, arrays, enums, nested objects, validation, OpenAPI, and a Native AOT generator bug with positional records."
pubDate: 2026-09-13
template: how-to
tags:
  - "aspnetcore"
  - "minimal-apis"
  - "dotnet-11"
  - "csharp"
  - "how-to"
---

**Short answer:** declare the query keys as properties of a class (or as constructor parameters of a record) and put `[AsParameters]` on the handler parameter: `app.MapGet("/products", ([AsParameters] ProductFilter filter) => ...)`. ASP.NET Core flattens the type into individual parameters, so `?search=lamp&page=2&tags=a&tags=b` binds to `Search`, `Page`, and `Tags` by name, case-insensitively. It only handles flat types: a nested object needs its own `TryParse` or `BindAsync`, and an optional value must be nullable or have a constructor default, because a property initializer like `= 1` does not make a property optional.

Everything below was run against .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1.26425.128`). `[AsParameters]` shipped in .NET 7 and its rules have not changed since, so the same code runs on .NET 8, 9, and 10. The one exception worth knowing about, a source generator bug in the Native AOT path, reproduces on SDK 10.0.302 as well.

## Why `[FromQuery] ProductFilter` does not work

Coming from MVC controllers, the reflex is `[FromQuery] ProductFilter filter`. In a .NET 11 minimal API that does not even compile. Analyzer [ASP0020](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020) reports it as a build error:

```text
error ASP0020: Parameter 'f' of type ProductFilter should define a bool
TryParse(string, IFormatProvider, out ProductFilter) method, or implement IParsable<ProductFilter>
```

Suppress the analyzer and the app fails at startup instead, when the endpoint is built:

```text
InvalidOperationException: f must have a valid TryParse method to support converting from a string.
No public static bool ProductFilter.TryParse(string, out ProductFilter) method found for f.
```

Drop the attribute and it gets more confusing. A complex type with no binding source is inferred as the request body, and `MapGet` refuses inferred bodies:

```text
InvalidOperationException: Body was inferred but the method does not allow inferred body parameters.
```

This is by design. Minimal APIs skip MVC's recursive model binder, and `[FromQuery]` means "one query key, converted with `TryParse`." The [parameter binding docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) say `AsParametersAttribute` "enables simple parameter binding to types and not complex or recursive model binding." What it does is flatten: the request delegate factory treats every member of the type as a separate handler parameter and then applies the normal rules (route, query, header, services, special types) to each member. That mental model explains every behaviour in the rest of this post.

## Bind a query-string filter step by step

1. Create a type with one member per query key.
2. Make every optional member nullable, or give it a default on a record constructor parameter.
3. Put `[AsParameters]` on the handler parameter.
4. Rename or re-source individual members with `[FromQuery(Name = ...)]`, `[FromRoute]`, or `[FromHeader]`.
5. Add DataAnnotations and call `AddValidation()` if you need range checks.

Here is the filter I used:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15, <Nullable>enable</Nullable>
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/products", ([AsParameters] ProductFilter f) => f);

app.Run();

enum SortOrder { Asc, Desc }

class ProductFilter
{
    public string? Search { get; set; }
    public int? Page { get; set; }
    public int? PageSize { get; set; }
    public SortOrder? Sort { get; set; }
    public DateOnly? Since { get; set; }
    public string[] Tags { get; set; } = [];
    [FromQuery(Name = "q")] public string? Keyword { get; set; }
}
```

And the actual responses:

```text
GET /products?search=lamp&page=2&pageSize=10&sort=Desc&since=2026-01-31&tags=a&tags=b&q=kw
200 {"search":"lamp","page":2,"pageSize":10,"sort":1,"since":"2026-01-31","tags":["a","b"],"keyword":"kw"}

GET /products?SEARCH=lamp&PAGE=3
200 {"search":"lamp","page":3,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}

GET /products
200 {"search":null,"page":null,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}
```

The query key is the member name, matched case-insensitively, and `[FromQuery(Name = "q")]` overrides it for one member. Repeated keys fill an array. `DateOnly` parses an ISO `yyyy-MM-dd` string. Any member type with a static `TryParse` (every primitive, `Guid`, `DateTimeOffset`, enums, and your own `IParsable<T>` types) binds from a single key.

## Required vs optional: the property initializer trap

This is the mistake I see most often. It looks like a class with sensible defaults:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
class RequiredFilter
{
    public int Page { get; set; } = 1;
    public bool InStock { get; set; }
    public string Search { get; set; } = "";
}
```

`GET /required` with no query string returns `400`:

```text
BadHttpRequestException: Required parameter "int Page" was not provided from query string.
```

The factory decides whether a member is optional from its nullability and, for constructor parameters, from a declared default value. A property initializer is just code in the constructor, invisible to reflection, so a non-nullable `int`, `bool`, or `string` property is required no matter what you assign to it. The generated OpenAPI document agrees and marks all three as `required: true`.

There are two fixes. Make the members nullable and apply the default in the handler (`f.Page ?? 1`), or switch to a positional record, where constructor defaults do count:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
record ProductQuery(string? Search, int Page = 1, int PageSize = 20,
    SortOrder Sort = SortOrder.Asc, string[]? Tags = null);

app.MapGet("/products-record", ([AsParameters] ProductQuery q) => q);
```

```text
GET /products-record         -> {"search":null,"page":1,"pageSize":20,"sort":0,"tags":[]}
GET /products-record?page=4  -> {"search":null,"page":4,"pageSize":20,"sort":0,"tags":[]}
```

Note that `Tags` came back as `[]`, not `null`, despite the `= null` default: an array with no matching keys binds as an empty array. A `record struct PagingStruct(int Page = 1, int PageSize = 20)` behaves identically and returned `{"page":1,"pageSize":20}`. The docs note that a `struct` "can be more performant" than a `record` class because it avoids an allocation per request; I did not benchmark it, so treat that as the docs' claim.

How the factory picks members is worth knowing. The logic in [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) is: if the type has a single public parameterized constructor, bind its parameters (matched to properties by name). Otherwise, use the parameterless constructor and bind every **writable** property. A get-only property on a class without such a constructor is silently skipped. Two public parameterized constructors fail with `Only a single public parameterized constructor is allowed for type 'TwoCtors'.`, and an abstract type fails with `The abstract type 'AbstractFilter' is not supported.`

## Mix route values, headers, and services in the same type

Because each member goes through the normal binding rules, one `[AsParameters]` type can collect the whole argument list, not just the query string:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
app.MapGet("/tenants/{tenantId:int}/orders", ([AsParameters] OrderRequest r) => new
{
    r.TenantId, r.Region, r.Status, r.Ids, r.UserAgent,
    Logger = r.Logger.GetType().Name,
    Path = r.Http.Request.Path.Value,
    CanCancel = r.Ct.CanBeCanceled
});

enum OrderStatus { Pending, Shipped, Cancelled }

class OrderRequest
{
    [FromRoute(Name = "tenantId")] public int TenantId { get; set; }
    [FromHeader(Name = "X-Region")] public string? Region { get; set; }
    public OrderStatus? Status { get; set; }
    public int[] Ids { get; set; } = [];
    [FromHeader(Name = "User-Agent")] public string? UserAgent { get; set; }
    public ILogger<OrderRequest> Logger { get; set; } = default!;   // from DI
    public HttpContext Http { get; set; } = default!;              // special type
    public CancellationToken Ct { get; set; }                      // RequestAborted
}
```

```text
GET /tenants/42/orders?status=Shipped&ids=1&ids=2   (X-Region: eu-west)
200 {"tenantId":42,"region":"eu-west","status":1,"ids":[1,2],"userAgent":"curl/8.7.1",
     "logger":"Logger`1","path":"/tenants/42/orders","canCancel":true}
```

This is the use case Microsoft's own sample leads with: collapse a long handler signature (`int id, TodoDb db, ...`) into one type. It pairs well with [grouping endpoints with `MapGroup`](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), where the route prefix already carries a `{tenantId}` value.

## Bad values, case-sensitive enums, and comma-separated lists

A value that fails `TryParse` produces a `400` before your handler runs:

```text
GET /products?page=abc    -> 400 Failed to bind parameter "Nullable<int> Page" from "abc".
GET /products?sort=Desc   -> 200
GET /products?sort=desc   -> 400 Failed to bind parameter "Nullable<SortOrder> Sort" from "desc".
```

The enum result surprises people: binding uses the case-sensitive `Enum.TryParse` overload, so `desc` is rejected while `Desc` works. If your clients send lowercase values, bind a `string?` and call `Enum.TryParse<SortOrder>(value, ignoreCase: true, out var sort)` yourself, or wrap the enum in a small type with its own `TryParse`.

In Development the developer exception page shows the `BadHttpRequestException` text above. Outside Development the client gets a bare `400` and the reason only goes to the debug log, so do not rely on that message as your API contract.

Comma-separated lists are not split:

```text
GET /products?tags=a,b              -> 200 "tags":["a,b"]   (one element)
GET /tenants/42/orders?ids=1,2      -> 400 Failed to bind parameter "int[] Ids" from "1,2".
```

Arrays bind only from repeated keys (`?ids=1&ids=2`). If you have to accept `ids=1,2`, bind a `string?` and split it, or give a custom type a `TryParse` that splits.

## Nested objects need their own parser

Here is the shape people actually want to bind:

```csharp
class Money { public decimal Min { get; set; } public decimal Max { get; set; } }
class NestedFilter { public string? Q { get; set; } public Money? Price { get; set; } }
```

`Price` is a complex type with no binding source, so the factory infers it as the body, and on a `GET` the endpoint fails at startup with the same `Body was inferred but the method does not allow inferred body parameters.` error from earlier. `?price.min=10` style keys, which MVC's model binder understands, mean nothing here. Putting `[AsParameters]` on a nested member does not help either. It throws `NotSupportedException: Nested AsParametersAttribute is not supported and should be used only for handler parameters.`

You have three options, in the order I would reach for them.

**Flatten it.** `decimal? MinPrice` and `decimal? MaxPrice` is boring, gets the best OpenAPI output, and needs no code.

**Parse one key with `IParsable<T>`.** A member whose type has a static `TryParse` binds from a single key:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1), C# 15
using System.Diagnostics.CodeAnalysis;
using System.Globalization;

record PriceRange(decimal Min, decimal Max) : IParsable<PriceRange>
{
    public static bool TryParse(string? s, IFormatProvider? provider,
        [MaybeNullWhen(false)] out PriceRange result)
    {
        result = null;
        if (s?.Split('-', 2) is not [var lo, var hi]) return false;
        if (!decimal.TryParse(lo, NumberStyles.Number, CultureInfo.InvariantCulture, out var min)) return false;
        if (!decimal.TryParse(hi, NumberStyles.Number, CultureInfo.InvariantCulture, out var max)) return false;
        if (min > max) return false;
        result = new PriceRange(min, max);
        return true;
    }

    public static PriceRange Parse(string s, IFormatProvider? provider) =>
        TryParse(s, provider, out var r) ? r : throw new FormatException($"'{s}' is not a price range.");
}
```

`?price=10-50` binds to `{"min":10,"max":50}`, and `?price=50-10` returns `400 Failed to bind parameter "PriceRange Price" from "50-10".`

**Read dotted keys with `BindAsync`.** If the wire format is fixed at `budget.min=5&budget.max=99`, implement `BindAsync(HttpContext, ParameterInfo)`. Inside an `[AsParameters]` type, `parameter.Name` is the property name, so the prefix comes for free:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.Globalization;
using System.Reflection;

record DottedRange(decimal? Min, decimal? Max)
{
    public static ValueTask<DottedRange?> BindAsync(HttpContext context, ParameterInfo parameter)
    {
        var q = context.Request.Query;
        decimal? Read(string key) => decimal.TryParse(q[$"{parameter.Name}.{key}"],
            NumberStyles.Number, CultureInfo.InvariantCulture, out var v) ? v : null;
        var (min, max) = (Read("min"), Read("max"));
        return ValueTask.FromResult(min is null && max is null ? null : new DottedRange(min, max));
    }
}

class RangeFilter
{
    public PriceRange? Price { get; set; }
    public DottedRange? Budget { get; set; }
    public string? Q { get; set; }
}
```

```text
GET /by-range?price=10-50&budget.min=5&budget.max=99&q=chair
200 {"price":{"min":10,"max":50},"budget":{"min":5,"max":99},"q":"chair"}
```

The cost of `BindAsync` is documentation: the built-in OpenAPI generator listed `Price` (as a string) and `Q` for this endpoint and left `Budget` out entirely. If you need it documented, add it with an [operation transformer](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

One more restriction: the `[AsParameters]` parameter itself cannot be nullable. `[AsParameters] ProductFilter? f` fails with `The nullable type 'ProductFilter' is not supported, mark the parameter as non-nullable.`

## Validation and OpenAPI output

Built-in minimal API validation understands `[AsParameters]` members, including record constructor parameters. With `builder.Services.AddValidation()` registered (the same setup as [validating request bodies](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)):

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
using System.ComponentModel.DataAnnotations;

record ValidatedPaging([Range(1, 1000)] int Page = 1, [Range(1, 100)] int PageSize = 20);

app.MapGet("/validated", ([AsParameters] ValidatedPaging p) => p);
```

```text
GET /validated?pageSize=500
400 {"title":"One or more validation errors occurred.","status":400,
     "errors":{"PageSize":["The field PageSize must be between 1 and 100."]}}
```

`Microsoft.AspNetCore.OpenApi` 11.0.0-rc.1 turns the same type into query parameters with `minimum`, `maximum`, and `default`. On .NET 10, this exact combination (a validation attribute on a primary constructor parameter of an `[AsParameters]` record) made document generation throw `InvalidCastException`; that was [dotnet/aspnetcore#65348](https://github.com/dotnet/aspnetcore/issues/65348), fixed for .NET 11 by [PR #67284](https://github.com/dotnet/aspnetcore/pull/67284). If you are still on .NET 10, put the attributes on a class with properties instead. It also shows the array trap from earlier from the other side. A non-nullable `string[] Tags { get; set; } = []` is documented as `required: true`, even though the runtime happily binds a missing key as an empty array, so generated clients will insist on sending it. Declare optional arrays as `string[]?` and the document marks them optional.

## Native AOT: positional records with nullable reference types do not compile

With `<PublishAot>true</PublishAot>` the build switches on the [Request Delegate Generator](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/aot/request-delegate-generator/rdg), which replaces the runtime factory with source-generated code (the stack covered in [Native AOT with minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)). Most of the startup errors above become build warnings there: `RDG009` for nested `[AsParameters]`, `RDG010` for a nullable parameter, `RDG005` for an abstract type, and `RDG008` for multiple constructors. That is an improvement.

It also has a bug. This endpoint:

```csharp
// .NET 11 RC 1 and SDK 10.0.302, <PublishAot>true</PublishAot> or <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
app.MapGet("/a", ([AsParameters] F f) => f.Page?.ToString() ?? "none");

record F(string? Q, int? Page);
```

fails to build with four copies of:

```text
GeneratedRouteBuilderExtensions.g.cs: error CS8639: The typeof operator cannot be used on a nullable reference type
```

The generator locates the record constructor by emitting `typeof(F).GetConstructor(new[] { typeof(string?), typeof(int?) })`, and `typeof(string?)` is not legal C#. `int?` is fine because it is `Nullable<int>`. I built six variants of the same endpoint with the generator on:

| `[AsParameters]` type | Builds? |
| --- | --- |
| `record F(string? Q, int? Page)` | No, CS8639 |
| `record F(string[]? Tags, int? Page)` | No, CS8639 |
| `record F(string Q = "", int? Page = null)` | Yes |
| `record struct F(string? Q, int? Page)` | Yes |
| `record F { public string? Q { get; init; } ... }` | Yes |
| Same positional record, generator off (plain JIT build) | Yes |

So the trigger is a positional `record` class whose constructor has a nullable reference type parameter. The plain JIT build is fine, which is why this tends to surface only when someone flips on `PublishAot` (the docs say trimming turns the generator on too). Until it is fixed, use a class with settable properties, a record with `init` properties, or a positional `record struct` for `[AsParameters]` types in AOT projects. I could not find a tracking issue for it in dotnet/aspnetcore at the time of writing.

## Read next

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), including where MVC's model binder still wins.
- [C# unions in ASP.NET Core 11](/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/), another case where the query string is the one binding source that does not cooperate.
- [Keyset (cursor) pagination in EF Core 11](/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/), a natural consumer for the paging filter built here.
- [Why a `[FromForm]` dictionary is always null in a minimal API](/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/), the form-binding cousin of the nested-object problem.

## Sources

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) (the `[AsParameters]` section and the binding-source precedence list).
- Microsoft Learn, [`AsParametersAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.asparametersattribute).
- Microsoft Learn, [ASP0020: Complex types referenced by route parameters must be parsable](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020).
- Microsoft Learn, [Request Delegate Generator diagnostics RDG009](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG009) and [RDG010](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG010).
- dotnet/aspnetcore at `v11.0.0-rc.1.26425.128`: [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) (member flattening, nullable check) and [`RequestDelegateFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (nested `[AsParameters]` check).
