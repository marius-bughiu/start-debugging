---
title: "So binden Sie ein komplexes Query-String-Objekt mit [AsParameters] in einer Minimal API in ASP.NET Core 11"
description: "Setzen Sie [AsParameters] auf eine Klasse oder einen Record, um einen kompletten Query-String-Filter in einer Minimal API in ASP.NET Core 11 zu binden. Behandelt Standardwerte, Arrays, Enums, verschachtelte Objekte, Validierung, OpenAPI und einen Bug im Native-AOT-Generator bei positionellen Records."
pubDate: 2026-09-13
template: how-to
tags:
  - "aspnetcore"
  - "minimal-apis"
  - "dotnet-11"
  - "csharp"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-bind-a-complex-query-string-object-with-asparameters-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Kurze Antwort:** Deklarieren Sie die Query-Schlüssel als Eigenschaften einer Klasse (oder als Konstruktorparameter eines Records) und setzen Sie `[AsParameters]` auf den Handler-Parameter: `app.MapGet("/products", ([AsParameters] ProductFilter filter) => ...)`. ASP.NET Core zerlegt den Typ in einzelne Parameter, sodass `?search=lamp&page=2&tags=a&tags=b` über den Namen und ohne Beachtung der Groß- und Kleinschreibung an `Search`, `Page` und `Tags` gebunden wird. Das funktioniert nur mit flachen Typen: Ein verschachteltes Objekt braucht ein eigenes `TryParse` oder `BindAsync`, und ein optionaler Wert muss nullbar sein oder einen Standardwert im Konstruktor haben, denn ein Eigenschaftsinitialisierer wie `= 1` macht eine Eigenschaft nicht optional.

Alles Folgende lief gegen .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1.26425.128`). `[AsParameters]` kam mit .NET 7, und seine Regeln haben sich seitdem nicht geändert, derselbe Code läuft also auch auf .NET 8, 9 und 10. Die eine Ausnahme, die man kennen sollte, ein Source-Generator-Bug im Native-AOT-Pfad, lässt sich auch mit SDK 10.0.302 reproduzieren.

## Warum `[FromQuery] ProductFilter` nicht funktioniert

Wer von MVC-Controllern kommt, schreibt reflexartig `[FromQuery] ProductFilter filter`. In einer Minimal API unter .NET 11 kompiliert das nicht einmal. Der Analyzer [ASP0020](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020) meldet es als Build-Fehler:

```text
error ASP0020: Parameter 'f' of type ProductFilter should define a bool
TryParse(string, IFormatProvider, out ProductFilter) method, or implement IParsable<ProductFilter>
```

Unterdrücken Sie den Analyzer, scheitert die App stattdessen beim Start, wenn der Endpunkt aufgebaut wird:

```text
InvalidOperationException: f must have a valid TryParse method to support converting from a string.
No public static bool ProductFilter.TryParse(string, out ProductFilter) method found for f.
```

Lassen Sie das Attribut weg, wird es noch verwirrender. Ein komplexer Typ ohne Bindungsquelle wird als Anfragetext abgeleitet, und `MapGet` lehnt abgeleitete Bodys ab:

```text
InvalidOperationException: Body was inferred but the method does not allow inferred body parameters.
```

Das ist so gewollt. Minimal APIs verzichten auf den rekursiven Model Binder von MVC, und `[FromQuery]` bedeutet "ein Query-Schlüssel, konvertiert mit `TryParse`". Die [Dokumentation zur Parameterbindung](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) sagt, dass `AsParametersAttribute` eine einfache Parameterbindung an Typen ermöglicht, nicht aber komplexes oder rekursives Model Binding. Was es tut, ist Zerlegen: Die Request Delegate Factory behandelt jedes Mitglied des Typs als eigenen Handler-Parameter und wendet auf jedes Mitglied die normalen Regeln an (Route, Query, Header, Services, spezielle Typen). Dieses Denkmodell erklärt jedes Verhalten im Rest dieses Beitrags.

## Einen Query-String-Filter Schritt für Schritt binden

1. Legen Sie einen Typ mit einem Mitglied pro Query-Schlüssel an.
2. Machen Sie jedes optionale Mitglied nullbar, oder geben Sie ihm einen Standardwert als Konstruktorparameter eines Records.
3. Setzen Sie `[AsParameters]` auf den Handler-Parameter.
4. Benennen Sie einzelne Mitglieder um oder ändern Sie ihre Quelle mit `[FromQuery(Name = ...)]`, `[FromRoute]` oder `[FromHeader]`.
5. Fügen Sie DataAnnotations hinzu und rufen Sie `AddValidation()` auf, wenn Sie Bereichsprüfungen brauchen.

Hier der Filter, den ich verwendet habe:

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

Und die tatsächlichen Antworten:

```text
GET /products?search=lamp&page=2&pageSize=10&sort=Desc&since=2026-01-31&tags=a&tags=b&q=kw
200 {"search":"lamp","page":2,"pageSize":10,"sort":1,"since":"2026-01-31","tags":["a","b"],"keyword":"kw"}

GET /products?SEARCH=lamp&PAGE=3
200 {"search":"lamp","page":3,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}

GET /products
200 {"search":null,"page":null,"pageSize":null,"sort":null,"since":null,"tags":[],"keyword":null}
```

Der Query-Schlüssel ist der Mitgliedsname, abgeglichen ohne Beachtung der Groß- und Kleinschreibung, und `[FromQuery(Name = "q")]` überschreibt ihn für ein einzelnes Mitglied. Wiederholte Schlüssel füllen ein Array. `DateOnly` parst einen ISO-String im Format `yyyy-MM-dd`. Jeder Mitgliedstyp mit einem statischen `TryParse` (alle primitiven Typen, `Guid`, `DateTimeOffset`, Enums und Ihre eigenen `IParsable<T>`-Typen) wird aus einem einzelnen Schlüssel gebunden.

## Pflicht oder optional: die Falle mit dem Eigenschaftsinitialisierer

Das ist der Fehler, den ich am häufigsten sehe. Es sieht aus wie eine Klasse mit sinnvollen Standardwerten:

```csharp
// ASP.NET Core 11 (.NET 11 RC 1)
class RequiredFilter
{
    public int Page { get; set; } = 1;
    public bool InStock { get; set; }
    public string Search { get; set; } = "";
}
```

`GET /required` ohne Query-String liefert `400`:

```text
BadHttpRequestException: Required parameter "int Page" was not provided from query string.
```

Die Factory entscheidet anhand der Nullbarkeit und bei Konstruktorparametern anhand eines deklarierten Standardwerts, ob ein Mitglied optional ist. Ein Eigenschaftsinitialisierer ist nur Code im Konstruktor und für Reflection unsichtbar, daher ist eine nicht nullbare Eigenschaft vom Typ `int`, `bool` oder `string` verpflichtend, egal was Sie ihr zuweisen. Das generierte OpenAPI-Dokument sieht das genauso und markiert alle drei als `required: true`.

Es gibt zwei Lösungen. Machen Sie die Mitglieder nullbar und wenden Sie den Standardwert im Handler an (`f.Page ?? 1`), oder wechseln Sie zu einem positionellen Record, bei dem Standardwerte im Konstruktor zählen:

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

Beachten Sie, dass `Tags` trotz des Standardwerts `= null` als `[]` zurückkam und nicht als `null`: Ein Array ohne passende Schlüssel wird als leeres Array gebunden. Ein `record struct PagingStruct(int Page = 1, int PageSize = 20)` verhält sich identisch und lieferte `{"page":1,"pageSize":20}`. Laut Dokumentation kann ein `struct` performanter sein als eine `record`-Klasse, weil er eine Allokation pro Anfrage vermeidet. Ich habe das nicht gemessen, betrachten Sie es also als Aussage der Dokumentation.

Wie die Factory die Mitglieder auswählt, sollte man kennen. Die Logik in [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) lautet: Hat der Typ genau einen öffentlichen parametrisierten Konstruktor, werden dessen Parameter gebunden (über den Namen den Eigenschaften zugeordnet). Andernfalls wird der parameterlose Konstruktor verwendet und jede **beschreibbare** Eigenschaft gebunden. Eine Get-only-Eigenschaft auf einer Klasse ohne einen solchen Konstruktor wird stillschweigend übersprungen. Zwei öffentliche parametrisierte Konstruktoren scheitern mit `Only a single public parameterized constructor is allowed for type 'TwoCtors'.`, und ein abstrakter Typ scheitert mit `The abstract type 'AbstractFilter' is not supported.`

## Routenwerte, Header und Services im selben Typ kombinieren

Weil jedes Mitglied die normalen Bindungsregeln durchläuft, kann ein einziger `[AsParameters]`-Typ die gesamte Argumentliste sammeln, nicht nur den Query-String:

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

Genau mit diesem Anwendungsfall beginnt Microsofts eigenes Beispiel: eine lange Handler-Signatur (`int id, TodoDb db, ...`) in einem Typ zusammenfassen. Das passt gut zum [Gruppieren von Endpunkten mit `MapGroup`](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), wo das Routenpräfix bereits einen `{tenantId}`-Wert trägt.

## Ungültige Werte, Enums mit Groß- und Kleinschreibung und kommagetrennte Listen

Ein Wert, bei dem `TryParse` fehlschlägt, erzeugt ein `400`, bevor Ihr Handler läuft:

```text
GET /products?page=abc    -> 400 Failed to bind parameter "Nullable<int> Page" from "abc".
GET /products?sort=Desc   -> 200
GET /products?sort=desc   -> 400 Failed to bind parameter "Nullable<SortOrder> Sort" from "desc".
```

Das Ergebnis beim Enum überrascht viele: Die Bindung verwendet die Überladung von `Enum.TryParse`, die Groß- und Kleinschreibung beachtet, daher wird `desc` abgelehnt, während `Desc` funktioniert. Wenn Ihre Clients Werte in Kleinbuchstaben senden, binden Sie einen `string?` und rufen `Enum.TryParse<SortOrder>(value, ignoreCase: true, out var sort)` selbst auf, oder kapseln Sie das Enum in einem kleinen Typ mit eigenem `TryParse`.

In der Development-Umgebung zeigt die Developer Exception Page den obigen `BadHttpRequestException`-Text. Außerhalb von Development bekommt der Client ein nacktes `400`, und der Grund landet nur im Debug-Log. Verlassen Sie sich also nicht auf diese Meldung als API-Vertrag.

Kommagetrennte Listen werden nicht aufgeteilt:

```text
GET /products?tags=a,b              -> 200 "tags":["a,b"]   (one element)
GET /tenants/42/orders?ids=1,2      -> 400 Failed to bind parameter "int[] Ids" from "1,2".
```

Arrays werden nur aus wiederholten Schlüsseln gebunden (`?ids=1&ids=2`). Wenn Sie `ids=1,2` akzeptieren müssen, binden Sie einen `string?` und teilen ihn auf, oder geben Sie einem eigenen Typ ein `TryParse`, das aufteilt.

## Verschachtelte Objekte brauchen einen eigenen Parser

Das ist die Form, die man eigentlich binden möchte:

```csharp
class Money { public decimal Min { get; set; } public decimal Max { get; set; } }
class NestedFilter { public string? Q { get; set; } public Money? Price { get; set; } }
```

`Price` ist ein komplexer Typ ohne Bindungsquelle, also leitet die Factory ihn als Body ab, und bei einem `GET` scheitert der Endpunkt beim Start mit demselben Fehler `Body was inferred but the method does not allow inferred body parameters.` wie oben. Schlüssel im Stil von `?price.min=10`, die der Model Binder von MVC versteht, bedeuten hier nichts. `[AsParameters]` auf ein verschachteltes Mitglied zu setzen, hilft auch nicht. Das wirft `NotSupportedException: Nested AsParametersAttribute is not supported and should be used only for handler parameters.`

Sie haben drei Optionen, in der Reihenfolge, in der ich zu ihnen greifen würde.

**Flach machen.** `decimal? MinPrice` und `decimal? MaxPrice` ist langweilig, liefert die beste OpenAPI-Ausgabe und braucht keinen Code.

**Einen Schlüssel mit `IParsable<T>` parsen.** Ein Mitglied, dessen Typ ein statisches `TryParse` hat, wird aus einem einzelnen Schlüssel gebunden:

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

`?price=10-50` wird an `{"min":10,"max":50}` gebunden, und `?price=50-10` liefert `400 Failed to bind parameter "PriceRange Price" from "50-10".`

**Schlüssel mit Punkt über `BindAsync` lesen.** Wenn das Übertragungsformat auf `budget.min=5&budget.max=99` festgelegt ist, implementieren Sie `BindAsync(HttpContext, ParameterInfo)`. Innerhalb eines `[AsParameters]`-Typs ist `parameter.Name` der Eigenschaftsname, das Präfix gibt es also gratis dazu:

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

Der Preis von `BindAsync` ist die Dokumentation: Der eingebaute OpenAPI-Generator führte für diesen Endpunkt `Price` (als String) und `Q` auf und ließ `Budget` komplett weg. Wenn Sie es dokumentiert brauchen, fügen Sie es mit einem [Operation Transformer](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) hinzu.

Noch eine Einschränkung: Der `[AsParameters]`-Parameter selbst darf nicht nullbar sein. `[AsParameters] ProductFilter? f` scheitert mit `The nullable type 'ProductFilter' is not supported, mark the parameter as non-nullable.`

## Validierung und OpenAPI-Ausgabe

Die eingebaute Validierung für Minimal APIs versteht `[AsParameters]`-Mitglieder, einschließlich Konstruktorparametern von Records. Mit registriertem `builder.Services.AddValidation()` (dasselbe Setup wie beim [Validieren von Anfragetexten](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)):

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

`Microsoft.AspNetCore.OpenApi` 11.0.0-rc.1 macht aus demselben Typ Query-Parameter mit `minimum`, `maximum` und `default`. Unter .NET 10 ließ genau diese Kombination (ein Validierungsattribut auf einem Primärkonstruktorparameter eines `[AsParameters]`-Records) die Dokumentgenerierung mit `InvalidCastException` abbrechen. Das war [dotnet/aspnetcore#65348](https://github.com/dotnet/aspnetcore/issues/65348), behoben für .NET 11 durch [PR #67284](https://github.com/dotnet/aspnetcore/pull/67284). Wenn Sie noch auf .NET 10 sind, setzen Sie die Attribute stattdessen auf eine Klasse mit Eigenschaften. Die Ausgabe zeigt außerdem die Array-Falle von vorhin von der anderen Seite. Ein nicht nullbares `string[] Tags { get; set; } = []` wird als `required: true` dokumentiert, obwohl die Laufzeit einen fehlenden Schlüssel problemlos als leeres Array bindet, sodass generierte Clients darauf bestehen, ihn zu senden. Deklarieren Sie optionale Arrays als `string[]?`, dann markiert das Dokument sie als optional.

## Native AOT: positionelle Records mit nullbaren Referenztypen kompilieren nicht

Mit `<PublishAot>true</PublishAot>` schaltet der Build den [Request Delegate Generator](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/aot/request-delegate-generator/rdg) ein, der die Factory zur Laufzeit durch per Source Generator erzeugten Code ersetzt (der Stack, der in [Native AOT mit Minimal APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) behandelt wird). Die meisten der oben genannten Startfehler werden dort zu Build-Warnungen: `RDG009` für verschachteltes `[AsParameters]`, `RDG010` für einen nullbaren Parameter, `RDG005` für einen abstrakten Typ und `RDG008` für mehrere Konstruktoren. Das ist eine Verbesserung.

Er hat aber auch einen Bug. Dieser Endpunkt:

```csharp
// .NET 11 RC 1 and SDK 10.0.302, <PublishAot>true</PublishAot> or <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
app.MapGet("/a", ([AsParameters] F f) => f.Page?.ToString() ?? "none");

record F(string? Q, int? Page);
```

lässt sich nicht kompilieren und liefert vier Kopien von:

```text
GeneratedRouteBuilderExtensions.g.cs: error CS8639: The typeof operator cannot be used on a nullable reference type
```

Der Generator sucht den Record-Konstruktor, indem er `typeof(F).GetConstructor(new[] { typeof(string?), typeof(int?) })` ausgibt, und `typeof(string?)` ist kein gültiges C#. `int?` ist in Ordnung, weil es `Nullable<int>` ist. Ich habe sechs Varianten desselben Endpunkts mit eingeschaltetem Generator gebaut:

| `[AsParameters]`-Typ | Kompiliert? |
| --- | --- |
| `record F(string? Q, int? Page)` | Nein, CS8639 |
| `record F(string[]? Tags, int? Page)` | Nein, CS8639 |
| `record F(string Q = "", int? Page = null)` | Ja |
| `record struct F(string? Q, int? Page)` | Ja |
| `record F { public string? Q { get; init; } ... }` | Ja |
| Derselbe positionelle Record, Generator aus (normaler JIT-Build) | Ja |

Der Auslöser ist also eine positionelle `record`-Klasse, deren Konstruktor einen Parameter mit nullbarem Referenztyp hat. Der normale JIT-Build ist in Ordnung, weshalb das meist erst auffällt, wenn jemand `PublishAot` einschaltet (laut Dokumentation schaltet auch Trimming den Generator ein). Bis das behoben ist, verwenden Sie für `[AsParameters]`-Typen in AOT-Projekten eine Klasse mit setzbaren Eigenschaften, einen Record mit `init`-Eigenschaften oder einen positionellen `record struct`. Zum Zeitpunkt des Schreibens konnte ich in dotnet/aspnetcore kein Tracking-Issue dafür finden.

## Weiterlesen

- [Minimal APIs vs. Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), einschließlich der Stellen, an denen der Model Binder von MVC weiterhin gewinnt.
- [C#-Unions in ASP.NET Core 11](/de/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/), ein weiterer Fall, in dem der Query-String die eine Bindungsquelle ist, die nicht mitspielt.
- [Keyset-Paginierung (Cursor) in EF Core 11](/de/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/), ein natürlicher Abnehmer für den hier gebauten Paging-Filter.
- [Warum ein `[FromForm]`-Dictionary in einer Minimal API immer null ist](/de/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/), der Verwandte des Problems mit verschachtelten Objekten bei der Formularbindung.

## Quellen

- Microsoft Learn, [Parameterbindung in Minimal-API-Anwendungen](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) (der Abschnitt zu `[AsParameters]` und die Rangfolge der Bindungsquellen).
- Microsoft Learn, [API-Referenz zu `AsParametersAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.asparametersattribute).
- Microsoft Learn, [ASP0020: Complex types referenced by route parameters must be parsable](https://learn.microsoft.com/aspnet/core/diagnostics/asp0020).
- Microsoft Learn, [Request-Delegate-Generator-Diagnose RDG009](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG009) und [RDG010](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG010).
- dotnet/aspnetcore bei `v11.0.0-rc.1.26425.128`: [`PropertyAsParameterInfo.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Shared/PropertyAsParameterInfo.cs) (Zerlegen der Mitglieder, Nullable-Prüfung) und [`RequestDelegateFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (Prüfung auf verschachteltes `[AsParameters]`).
