---
title: "So fügen Sie einen Endpoint Filter zu einer Minimal API in ASP.NET Core 11 hinzu"
description: "Eine vollständige, funktionierende Anleitung zu Endpoint Filtern in einer ASP.NET Core 11 Minimal API: AddEndpointFilter mit einem Inline-Delegate, IEndpointFilter-Klassen mit Dependency Injection, GetArgument und die Arguments-Liste, Kurzschluss mit Results.Problem, FIFO/FILO-Reihenfolge über mehrere Filter, Filter auf Gruppenebene mit MapGroup und AddEndpointFilterFactory für signaturabhängige Filter."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "validation"
lang: "de"
translationOf: "2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Um einen Endpoint Filter zu einer Minimal API in ASP.NET Core 11 hinzuzufügen, rufen Sie `.AddEndpointFilter()` auf dem Endpunkt (oder der Routengruppe) auf und übergeben entweder ein Inline-Delegate `async (context, next) => ...` oder eine Klasse, die `IEndpointFilter` implementiert. Der Filter läuft nach dem Model Binding und vor Ihrem Handler, er sieht die gebundenen Argumente über `context.GetArgument<T>(index)`, und er ruft entweder `await next(context)` auf, um fortzufahren, oder gibt einen Wert wie `Results.Problem(...)` zurück, um die Anfrage kurzzuschließen. Das ist das gesamte Modell. Dieser Beitrag führt es von Anfang bis Ende durch: die Inline-Form, die Klassenform mit Dependency Injection, die Reihenfolge beim Stapeln mehrerer Filter, die Anwendung eines Filters auf eine ganze `MapGroup` und die Fluchtluke der Filter-Factory. Er richtet sich an .NET 11 (zum Zeitpunkt der Erstellung Preview 6, GA im November 2026) mit `Microsoft.NET.Sdk.Web` und C# 14, aber Endpoint Filter sind seit ASP.NET Core 7 stabil, sodass jedes Beispiel hier unverändert auf .NET 8, 9 und 10 läuft.

## Was ein Endpoint Filter tatsächlich umschließt

Ein Endpoint Filter ist ein Stück Code, das die Ausführung eines einzelnen Route-Handlers umschließt. Anders als Middleware, die für jede Anfrage läuft, die diesen Punkt der Pipeline durchläuft, egal ob eine Route übereinstimmte oder nicht, läuft ein Filter nur, wenn sein Endpunkt ausgewählt wird. Und anders als Middleware läuft ein Filter nach dem Routing und nach dem Binding der Parameter, sodass das Framework zum Zeitpunkt der Ausführung die Routenwerte bereits geparst, den Anfragekörper gebunden und die Argumente des Handlers aufgelöst hat. Dieser Zeitpunkt ist der gesamte Grund für die Existenz von Filtern: Sie können genau die Argumente inspizieren und sogar mutieren, die Ihr Handler gleich erhalten wird, und Sie können das Ergebnis, das er erzeugt hat, inspizieren oder ersetzen, alles ohne den Handler selbst anzufassen.

Konkret kann ein Filter drei Dinge tun:

- Code vor dem Handler ausführen (Argumente validieren, protokollieren, eine Stoppuhr starten).
- Kurzschließen: ein Ergebnis zurückgeben, statt den Handler überhaupt aufzurufen.
- Code nach dem Handler ausführen, einschließlich der Inspektion oder Ersetzung seines Rückgabewerts.

Das passt sauber auf Validierung, Protokollierung pro Endpunkt, das Formen von Anfragen und leichtgewichtige Querschnittsbelange, die keine eigene Middleware verdienen.

## Schritte zum Hinzufügen eines Endpoint Filters

1. Registrieren Sie Ihre Services und bauen Sie die Anwendung wie gewohnt mit `WebApplication.CreateBuilder(args)`.
2. Mappen Sie einen Endpunkt mit `MapGet`, `MapPost` oder einer `MapGroup`.
3. Verketten Sie `.AddEndpointFilter(...)` an den zurückgegebenen Builder und übergeben Sie ein Inline-Delegate oder einen `IEndpointFilter`-Typ.
4. Lesen Sie im Filter die Argumente mit `context.GetArgument<T>(index)` und entscheiden Sie, ob fortgefahren wird.
5. Rufen Sie `await next(context)` auf, um den Handler auszuführen, oder geben Sie einen Wert zurück (zum Beispiel `Results.Problem(...)`), um kurzzuschließen.

Der Rest dieses Artikels erweitert jeden dieser Punkte zu funktionierendem Code.

## Die Inline-Delegate-Form

Der schnellste Weg, einen Filter hinzuzufügen, ist ein Inline-Delegate. Es nimmt zwei Parameter: den `EndpointFilterInvocationContext` (der `HttpContext` und die gebundenen `Arguments` bereitstellt) und `next`, ein `EndpointFilterDelegate`, das Sie aufrufen, um die Pipeline fortzusetzen.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

string ColorName(string color) => $"Color specified: {color}";

app.MapGet("/color/{color}", ColorName)
    .AddEndpointFilter(async (context, next) =>
    {
        var color = context.GetArgument<string>(0);

        if (color == "Red")
        {
            // Short-circuit: the handler never runs.
            return Results.Problem("Red is not allowed.");
        }

        // Continue to the next filter, or the handler if this is the last one.
        return await next(context);
    });

app.Run();
```

`context.GetArgument<string>(0)` zieht das erste an `ColorName` übergebene Argument heraus, nämlich `color`. Der Index ist positionsbasiert: Er entspricht der Reihenfolge, in der die Parameter in der Deklaration des Handlers erscheinen, nicht der Reihenfolge der Segmente des Routen-Templates. Wenn Sie lieber keine Positionen zählen möchten, ist `context.Arguments` eine `IList<object?>`, über die Sie iterieren können, und `GetArguments()` gibt dieselbe Liste zurück.

Der Rückgabetyp eines Filters ist `ValueTask<object?>`. Die Rückgabe von `Results.Problem(...)` (oder irgendeinem `IResult`) schließt kurz, und dieses Ergebnis wird in die Antwort geschrieben. Die Rückgabe von `await next(context)` führt den Handler aus und reicht dessen Ergebnis die Kette hinauf. Da der Rückgabewert durch jeden Filter zurückfließt, können Sie ihn auf dem Weg nach draußen auch transformieren.

## Die IEndpointFilter-Klassenform, mit Dependency Injection

Inline-Delegates sind perfekt für einmalige Logik, aber ein Filter, den Sie über Endpunkte hinweg wiederverwenden möchten, gehört in eine Klasse. Implementieren Sie `IEndpointFilter`, das eine einzige Methode hat:

```csharp
// .NET 11, C# 14
public class ValidationFilter<T> : IEndpointFilter where T : class
{
    private readonly ILogger<ValidationFilter<T>> _logger;

    public ValidationFilter(ILogger<ValidationFilter<T>> logger)
    {
        _logger = logger;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var model = context.Arguments.OfType<T>().FirstOrDefault();

        if (model is null)
        {
            return Results.Problem($"No {typeof(T).Name} argument found.");
        }

        var errors = Validate(model);
        if (errors.Count > 0)
        {
            _logger.LogWarning("Validation failed for {Type}", typeof(T).Name);
            return Results.ValidationProblem(errors);
        }

        return await next(context);
    }

    private static Dictionary<string, string[]> Validate(T model) => new();
}
```

Registrieren Sie ihn mit der generischen Überladung:

```csharp
// .NET 11, C# 14
app.MapPost("/products", (Product product) => Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilter<ValidationFilter<Product>>();
```

Zwei Dinge sind wichtig, wie diese Klasse konstruiert wird. Erstens werden die Konstruktorabhängigkeiten des Filters (`ILogger<T>` oben) aus dem DI-Container aufgelöst, sodass Sie Logger, Options oder jeden registrierten Service injizieren können. Zweitens, und das überrascht viele: Der Filtertyp selbst wird nicht als Service aufgelöst. Sie registrieren `ValidationFilter<Product>` nicht in `builder.Services`. Das Framework aktiviert ihn für Sie und befriedigt seinen Konstruktor aus DI, aber er ist kein vom Container verwalteter Singleton- oder Scoped-Service. Wenn Sie `builder.Services.AddScoped<ValidationFilter<Product>>()` versuchen, in der Erwartung, dass `AddEndpointFilter<T>()` ihn aus dem Container zieht, wird diese Registrierung schlicht ignoriert.

Die Verwendung von `Results.ValidationProblem` erzeugt hier einen Problem-Details-Körper gemäß RFC 9457 mit einem Fehlerverzeichnis im `422`-Stil. Wenn Sie diese Form zentral statt pro Filter steuern möchten, ist genau dafür eine [IProblemDetailsService-Konfiguration](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) gedacht.

## Wenn Sie Filter stapeln, ist die Reihenfolge FIFO hinein und FILO hinaus

Sie können mehr als einen Filter an einen Endpunkt anhängen, und die Reihenfolge ist der verwirrendste Teil des Features, bis Sie es einmal gesehen haben. Die Regel: Code vor `next` läuft in der Reihenfolge, in der Sie die Filter registriert haben (first in, first out); Code nach `next` läuft in umgekehrter Reihenfolge (first in, last out). Er verschachtelt sich wie ein Stapel.

```csharp
// .NET 11, C# 14
app.MapGet("/demo", () =>
    {
        app.Logger.LogInformation("        Handler");
        return "done";
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("Before A");
        var result = await next(context);
        app.Logger.LogInformation("After A");
        return result;
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("    Before B");
        var result = await next(context);
        app.Logger.LogInformation("    After B");
        return result;
    });
```

Das protokolliert:

```dotnetcli
Before A
    Before B
        Handler
    After B
After A
```

Der zuerst hinzugefügte Filter ist also die äußerste Umhüllung. Wenn Sie möchten, dass eine authentifizierungsartige Schranke vor einem Protokollierungsfilter läuft, fügen Sie die Schranke zuerst hinzu. Wenn ein Filter kurzschließt, indem er zurückkehrt, ohne `next` aufzurufen, wird jeder danach registrierte Filter übersprungen, und die davor registrierten führen ihren Code nach `next` weiterhin aus, weil ihr `await next(context)` das Kurzschluss-Ergebnis zurückgibt. Deshalb kann ein früher Validierungsfilter eine Anfrage sicher ablehnen: Alles flussabwärts, einschließlich des Handlers, läuft niemals.

## Argumente mutieren, bevor der Handler sie sieht

Da ein Filter nach dem Binding läuft, kann er die Argumente an Ort und Stelle ändern, und der Handler erhält die geänderten Werte. Die `Arguments`-Liste ist veränderbar. Das ist wirklich nützlich für die Normalisierung: Strings trimmen, einen Code in Großbuchstaben umwandeln, eine Seitengröße begrenzen.

```csharp
// .NET 11, C# 14
app.MapGet("/search", (string q, int pageSize) => new { q, pageSize })
    .AddEndpointFilter(async (context, next) =>
    {
        // Normalize the query and clamp the page size before the handler runs.
        if (context.Arguments[0] is string q)
        {
            context.Arguments[0] = q.Trim();
        }
        if (context.Arguments[1] is int size)
        {
            context.Arguments[1] = Math.Clamp(size, 1, 100);
        }

        return await next(context);
    });
```

Behalten Sie einen Vorbehalt im Kopf: Das Mutieren per Positionsindex koppelt den Filter an die Parameterreihenfolge des Handlers. Ein generischer, wiederverwendbarer Filter fährt besser, wenn er nach Typ abgleicht (`context.Arguments.OfType<T>()`) oder direkt aus dem `HttpContext` liest, was den klassenbasierten `ValidationFilter<T>` oben endpunktunabhängig macht.

## Einen Filter auf eine ganze Routengruppe anwenden

Das Wiederholen von `.AddEndpointFilter<...>()` an jedem Endpunkt ist Lärm. Da `MapGroup` einen `RouteGroupBuilder` zurückgibt, der die Konventionen an seine Kinder weiterträgt, läuft ein zur Gruppe hinzugefügter Filter für jeden Endpunkt darin. Das lässt sich mit den ressourcenbezogenen Endpunktmodulen aus [Minimal-API-Endpunkte mit MapGroup organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) kombinieren:

```csharp
// .NET 11, C# 14
var products = app.MapGroup("/products")
    .AddEndpointFilter<ValidationFilter<Product>>();

products.MapPost("/", (Product p) => Results.Created($"/products/{p.Id}", p));
products.MapPut("/{id:int}", (int id, Product p) => Results.NoContent());
```

Gruppenfilter und Endpunktfilter kombinieren sich, und die Reihenfolge folgt derselben Verschachtelungsregel, mit den Filtern der Gruppe außen. Ein Filter auf der Gruppe umschließt einen zu einem einzelnen Endpunkt darin hinzugefügten Filter. Sie können auch Gruppen verschachteln, und jede Ebene fügt eine weitere Schicht hinzu.

Wenn Sie möchten, dass ein Filter auf die gesamte Anwendung statt auf eine benannte Gruppe angewendet wird, fügen Sie ihn zu einer Gruppe hinzu, die die Wurzel abdeckt: `app.MapGroup("").AddEndpointFilter(...)`. Es gibt keine separate Registrierung eines "globalen Filters", aber eine Wurzelgruppe ist das idiomatische Äquivalent, und sie hält Filter auf geroutete Endpunkte beschränkt, statt sie in Middleware zu verwandeln.

## Die Factory-Form für signaturabhängige Filter

`AddEndpointFilterFactory` ist die fortgeschrittene Tür. Statt einer Filterinstanz geben Sie eine Factory an, die beim Start einmal pro Endpunkt läuft, einen `EndpointFilterFactoryContext` mit dem `MethodInfo` des Handlers erhält und das eigentliche Filter-Delegate zurückgibt. So können Sie die Signatur des Handlers inspizieren und einen spezialisierten Filter bauen oder Reflexionsergebnisse cachen, sodass sie einmal statt pro Anfrage berechnet werden.

```csharp
// .NET 11, C# 14 -- only attach the validation logic when the handler takes a Product first
app.MapPost("/products", (Product product) =>
        Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilterFactory((factoryContext, next) =>
    {
        var parameters = factoryContext.MethodInfo.GetParameters();
        var isProductFirst = parameters.Length >= 1
            && parameters[0].ParameterType == typeof(Product);

        if (!isProductFirst)
        {
            // Pass-through: no per-request cost for endpoints that do not match.
            return context => next(context);
        }

        return async context =>
        {
            var product = context.GetArgument<Product>(0);
            if (string.IsNullOrWhiteSpace(product.Name))
            {
                return Results.Problem("Name is required.");
            }
            return await next(context);
        };
    });
```

Der Gewinn hier ist, dass die `MethodInfo`-Inspektion einmal zur Build-Zeit stattfindet, nicht bei jeder Anfrage, und Endpunkte, deren Signatur nicht übereinstimmt, zahlen nichts über ein Durchreiche-Delegate hinaus. Greifen Sie nur dann zur Factory, wenn ein einfacher Filter nicht ausdrücken kann, was Sie brauchen; für den häufigen Fall validieren-und-fortfahren ist die Klassenform einfacher und liest sich besser.

## Filter sind keine Middleware und keine Action Filter

Zwei Vergleiche klären den größten Teil der verbleibenden Verwirrung. Gegenüber Middleware: Ein Endpoint Filter läuft nur für seinen Endpunkt und nur nach dem Binding, sodass er typisierte Argumente sehen kann; Middleware läuft für einen ganzen Zweig der Pipeline und sieht nur den rohen `HttpContext`. Wenn Ihre Logik das gebundene Modell braucht, will sie einen Filter. Wenn sie vor dem Routing oder über viele nicht verwandte Endpunkte hinweg laufen muss, will sie Middleware. Gegenüber MVC-Action-Filtern (`IActionFilter`, `IAsyncActionFilter`): Endpoint Filter sind das Minimal-API-Äquivalent, aber sie sind ein anderer Typ in einem anderen Namespace. Sie können einen MVC-Action-Filter nicht an einem Minimal-API-Endpunkt wiederverwenden. Die einzige Brücke, die Microsoft bereitstellt, ist, dass `AddEndpointFilter` auch auf dem `ControllerActionEndpointConventionBuilder` eines Controllers funktioniert, sodass ein einzelnes Endpoint-Filter-Delegate über Minimal-API-Endpunkte und Controller-Actions hinweg geteilt werden kann, wenn Sie beide routen.

Noch eine praktische Anmerkung: Da ein Filter mit einem `IResult` kurzschließen kann, passt er natürlich zu typisierten Ergebnissen. Wenn Ihr Handler eine [typisierte Results-Union](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) zurückgibt, fügt sich ein Filter, der `Results.Problem` zurückgibt, weiterhin sauber ein, da der Rückgabetyp des Filters `object?` ist und jedes `IResult` in die Antwort geschrieben wird. Und für wirklich aufwendige Validierung wägen Sie einen Filter gegen die [integrierte Anfragenvalidierung](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) ab, die ASP.NET Core 11 aus Data Annotations ohne jeden Filter ausführen kann.

## Die Form zum Merken

Das Hinzufügen eines Endpoint Filters läuft auf `.AddEndpointFilter(...)` an einem Endpunkt oder einer `MapGroup` hinaus, ein Inline-Delegate für Einzelfälle oder eine `IEndpointFilter`-Klasse für die Wiederverwendung, `context.GetArgument<T>(index)` (oder `context.Arguments`) zum Lesen der gebundenen Werte und `await next(context)` zum Fortfahren gegenüber der Rückgabe eines `IResult` zum Kurzschließen. Denken Sie daran, dass die Konstruktorabhängigkeiten aus DI kommen, der Filtertyp selbst aber kein registrierter Service ist, dass gestapelte Filter FIFO hinein und FILO hinaus verschachteln, dass Gruppenfilter Endpunktfilter umschließen und dass `AddEndpointFilterFactory` für den seltenen Fall existiert, in dem Sie die Signatur des Handlers inspizieren müssen. Das ist die gesamte Oberfläche, und jede Zeile oben läuft von .NET 8 bis .NET 11 unverändert.

## Verwandt

- [So organisieren Sie Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [So validieren Sie Anfragekörper in Minimal APIs ohne Controller in ASP.NET Core 11](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)
- [So passen Sie Minimal-API-Validierungsfehlerantworten mit IProblemDetailsService in ASP.NET Core 11 an](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [So geben Sie eine typisierte Results-Union aus einem Minimal-API-Endpunkt in ASP.NET Core 11 zurück](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Minimal APIs vs. Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Quellen

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
- [EndpointFilterInvocationContext (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterinvocationcontext)
- [RouteHandlerBuilderExtensions.AddEndpointFilter (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterextensions)
