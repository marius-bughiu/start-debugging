---
title: "So organisieren Sie Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11"
description: "Ein vollständiger Leitfaden zur Strukturierung von Minimal APIs in ASP.NET Core 11 mit MapGroup: Endpunkt-Module pro Ressource als Erweiterungsmethoden, verschachtelte Gruppen, gemeinsame Filter und Authentifizierung, Präfixe mit Routenparametern, OpenAPI-Tags und die überraschenden Regeln zur Filterreihenfolge."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "de"
translationOf: "2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Damit eine Minimal API die Datei `Program.cs` nicht in eine tausend Zeilen lange Wand aus `app.MapGet(...)`-Aufrufen verwandelt, gruppieren Sie zusammengehörige Endpunkte mit `app.MapGroup("/prefix")`. Das gibt einen `RouteGroupBuilder` zurück, der ein Routenpräfix und alle Konventionen (Filter, Authentifizierung, OpenAPI-Tags) teilt, die Sie ihm zuweisen. Das langlebige Muster ist eine Erweiterungsmethode pro Ressource: `public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)` baut intern seine eigene Gruppe, und `Program.cs` schrumpft auf eine Liste von `app.MapTodos();`-Aufrufen. `MapGroup` ist seit ASP.NET Core 7 stabil und in .NET 11 unverändert. Alles Folgende zielt auf .NET 11 mit `Microsoft.NET.Sdk.Web` und C# 14 ab, aber die API ist in .NET 8, 9 und 10 identisch.

## Warum Program.cs verrottet

Minimal APIs kommen mit einer verführerischen Demo: die ganze App in einer Datei. Das ist großartig für ein Beispiel und schrecklich für einen echten Dienst. Sobald Sie eine Handvoll Ressourcen haben, jede mit den fünf CRUD-Verben plus ein paar Unterrouten, sind das in `Program.cs` einige Hundert Zeilen Route Handler, vermischt mit der DI-Registrierung, der Middleware-Verdrahtung und `app.Run()`. Sie scrollen an der Authentifizierungs-Einrichtung vorbei, um das `MapPut` zu finden, das Sie bearbeiten wollten. Drei Handler beginnen alle mit `/api/v1/orders`, und einer davon hat einen Tippfehler im Präfix, den niemand bemerkt, bis ein 404 in Produktion auftritt.

Die Lösung ist nicht "zurück zu den Controllern". Controller lösen die Organisation per Konvention (eine Klasse pro Ressource, Attribute fürs Routing) auf Kosten der reflexionsbasierten MVC-Pipeline. Minimal APIs lösen das mit `MapGroup` plus schlichten C#-Erweiterungsmethoden, und Sie behalten das schlanke, AOT-freundliche Endpunktmodell. Falls Sie sich noch zwischen den beiden Modellen entscheiden, sind die Abwägungen in [Minimal APIs vs Controller in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) dargelegt. Dieser Leitfaden setzt voraus, dass Sie sich für Minimal APIs entschieden haben und möchten, dass sie skalieren.

## MapGroup gibt einen RouteGroupBuilder zurück

`MapGroup` ist eine Erweiterungsmethode auf `IEndpointRouteBuilder`. Sie nimmt ein Routenpräfix entgegen und gibt einen `RouteGroupBuilder` zurück:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

RouteGroupBuilder todos = app.MapGroup("/todos");

todos.MapGet("/", () => "all todos");        // GET  /todos/
todos.MapGet("/{id:int}", (int id) => $"todo {id}"); // GET  /todos/42
todos.MapPost("/", () => "created");          // POST /todos/

app.Run();
```

Jeder `Map{Verb}`-Aufruf auf der Gruppe erbt das Präfix `/todos`, daher sind die Muster, die Sie auf der Gruppe schreiben, relativ. `RouteGroupBuilder` implementiert `IEndpointRouteBuilder`, und genau dieses Detail lässt alles Übrige funktionieren: Alles, was Sie auf `app` aufrufen können (einschließlich `MapGroup` selbst), können Sie auf einer Gruppe aufrufen. So ergibt sich die Verschachtelung von selbst.

Das Präfix wird durch einfache Verkettung kombiniert. `app.MapGroup("/api").MapGroup("/v1").MapGet("/todos", ...)` registriert `GET /api/v1/todos`. Es gibt keine Normalisierungsmagie über das Zusammenfügen der Segmente hinaus, also verdoppeln Sie die Schrägstriche nicht: Ein Gruppenpräfix `/todos/` plus ein Handler-Muster `/{id}` ergibt `/todos//{id}`, was nicht zu dem passt, was Sie erwarten.

## Eine Erweiterungsmethode pro Ressource

Das Muster, das skaliert, ist, jeder Ressource ihre eigene statische Klasse mit einer `Map`-Methode zu geben und diese Methode ihre eigene Gruppe erzeugen zu lassen. Der Rückgabetyp sollte `IEndpointRouteBuilder` (oder `RouteGroupBuilder`) sein, damit Aufrufe verkettet werden können:

```csharp
// .NET 11, C# 14 -- Endpoints/TodoEndpoints.cs
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos")
            .WithTags("Todos");

        group.MapGet("/", GetAll);
        group.MapGet("/{id:int}", GetById).WithName("GetTodoById");
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapDelete("/{id:int}", Delete);

        return routes;
    }

    private static async Task<Ok<List<Todo>>> GetAll(TodoDb db) =>
        TypedResults.Ok(await db.Todos.ToListAsync());

    private static async Task<Results<Ok<Todo>, NotFound>> GetById(int id, TodoDb db) =>
        await db.Todos.FindAsync(id) is { } todo
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static async Task<Created<Todo>> Create(Todo todo, TodoDb db)
    {
        db.Todos.Add(todo);
        await db.SaveChangesAsync();
        return TypedResults.Created($"/todos/{todo.Id}", todo);
    }

    private static async Task<Results<NoContent, NotFound>> Update(int id, Todo input, TodoDb db)
    {
        var todo = await db.Todos.FindAsync(id);
        if (todo is null) return TypedResults.NotFound();
        todo.Title = input.Title;
        todo.Done = input.Done;
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, NotFound>> Delete(int id, TodoDb db)
    {
        var rows = await db.Todos.Where(t => t.Id == id).ExecuteDeleteAsync();
        return rows > 0 ? TypedResults.NoContent() : TypedResults.NotFound();
    }
}
```

Jetzt ist `Program.cs` ein Inhaltsverzeichnis:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<TodoDb>(o => o.UseSqlServer(/* ... */));
builder.Services.AddOpenApi();

var app = builder.Build();

app.MapTodos();
app.MapOrders();
app.MapCustomers();

app.MapOpenApi();
app.Run();
```

Zwei Dinge machen diese Schreibweise angenehm. Erstens sind die Handler benannte `private static`-Methoden statt Lambdas, sodass jeder einen echten Namen in Stack Traces hat und sich trivial isoliert testen lässt. Zweitens erlaubt die Rückgabe von `IEndpointRouteBuilder` aus `MapTodos`, weiter zu verketten, wenn Sie möchten (`app.MapTodos().MapOrders();`), wobei sich ein Aufruf pro Zeile besser liest.

Ein Hinweis zum Rückgabetyp: Wenn die einzige Aufgabe einer Methode darin besteht, eine Gruppe zu bauen, und der *Aufrufer* dieser Gruppe weitere Konventionen zuweisen soll, geben Sie stattdessen `RouteGroupBuilder` zurück. Wenn die Methode Endpunkte registriert und der Aufrufer die Gruppe danach nicht anfassen soll, geben Sie `IEndpointRouteBuilder` zurück. Beide zu vermischen ist die häufigste Quelle der Verwirrung "Warum kompiliert mein `.RequireAuthorization()` nicht".

## Gemeinsame Filter, Authentifizierung und Metadaten in einem Aufruf

Der Vorteil einer Gruppe ist, dass eine auf die Gruppe angewandte Konvention für jeden Endpunkt darunter gilt. Hier verdient sich `MapGroup` seinen Platz gegenüber dem Kopieren von `.RequireAuthorization()` auf zwanzig Handler:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin")
    .RequireAuthorization("AdminPolicy")   // every endpoint requires the policy
    .WithTags("Admin")                     // one OpenAPI tag for the whole group
    .AddEndpointFilter<AuditFilter>();     // runs for every endpoint in the group

admin.MapGet("/users", ListUsers);
admin.MapDelete("/users/{id:int}", DeleteUser);
```

`RequireAuthorization`, `WithTags`, `WithMetadata`, `RequireRateLimiting`, `AddEndpointFilter` und `AddEndpointFilterFactory` sind alle Methoden von `IEndpointConventionBuilder`, und `RouteGroupBuilder` implementiert dieses Interface, sodass sie alle an die Mitglieder weitergereicht werden. Wenn Sie Rate Limiting pro Endpunkt benötigen, partitioniert nach der Route innerhalb einer Gruppe, behandelt der [Leitfaden zum Rate Limiting pro Endpunkt](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/), wie `RequireRateLimiting` mit der Policy einer Gruppe zusammenwirkt.

Eine Feinheit lohnt sich zu verinnerlichen: `AddEndpointFilter` auf einer Gruppe ist **keine** Middleware. Es läuft nicht einmal pro Anfrage an das Präfix. Es wird der Filter-Pipeline jedes Endpunkts einzeln zur Build-Zeit zugewiesen. Der praktische Unterschied: Der Filter läuft nur, wenn ein Endpunkt in der Gruppe tatsächlich übereinstimmt. Eine Anfrage an `/admin/nonexistent`, die einen 404 ergibt, ruft `AuditFilter` nie auf, während eine Middleware auf dem Pfadsegment `/admin` es täte. Wenn Sie echte Middleware brauchen, die auf einen Pfad beschränkt ist, verwenden Sie stattdessen `app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/admin"), ...)`.

## Verschachtelte Gruppen und Routenparameter im Präfix

Da eine Gruppe selbst ein `IEndpointRouteBuilder` ist, verschachteln Sie, indem Sie `MapGroup` auf einer Gruppe aufrufen. Präfixe können Routenparameter und Constraints enthalten, und ein Handler in beliebiger Tiefe kann Parameter binden, die in einem beliebigen übergeordneten Präfix deklariert sind:

```csharp
// .NET 11, C# 14
var orgs = app.MapGroup("/orgs/{orgId:int}");
var projects = orgs.MapGroup("/projects/{projectId:int}");

projects.MapGet("/issues", (int orgId, int projectId) =>
    $"issues for org {orgId}, project {projectId}");
// matches GET /orgs/7/projects/3/issues
```

Der Handler bindet sowohl `orgId` als auch `projectId`, obwohl jeder eine Ebene höher deklariert ist. Das ist die saubere Art, hierarchische Ressourcen zu modellieren: Jede Ebene der URL ist eine Gruppe, und die Blatt-Handler bleiben kurz, weil die gemeinsamen Routenwerte von der Struktur erfasst werden, statt in jedem Muster wiederholt zu werden.

Das Präfix kann auch leer sein. `app.MapGroup("")` fügt kein Pfadsegment hinzu, was der Trick ist, um einer Reihe von Endpunkten eine Konvention oder einen Filter zuzuweisen, ohne ihre URLs zu ändern:

```csharp
// .NET 11, C# 14
var versioned = app.MapGroup("").WithOpenApi();
var v1 = versioned.MapGroup("/v1");
var v2 = versioned.MapGroup("/v2");
```

## Die Regel zur Filterreihenfolge, über die viele stolpern

Wenn Filter auf verschachtelten Gruppen liegen, wird die Reihenfolge ihrer Ausführung durch die Gruppenverschachtelung bestimmt, **die äußerste zuerst**, nicht durch die Reihenfolge, in der Sie die `AddEndpointFilter`-Aufrufe geschrieben haben. Das ist das am wenigsten intuitive Verhalten von Routengruppen, dokumentiert, aber leicht zu übersehen.

```csharp
// .NET 11, C# 14
var outer = app.MapGroup("/outer");
var inner = outer.MapGroup("/inner");

inner.AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("inner group filter");
    return next(ctx);
});

outer.AddEndpointFilter((ctx, next) =>   // added second, runs first
{
    app.Logger.LogInformation("outer group filter");
    return next(ctx);
});

inner.MapGet("/", () => "Hi!").AddEndpointFilter((ctx, next) =>
{
    app.Logger.LogInformation("endpoint filter");
    return next(ctx);
});
```

Eine Anfrage an `/outer/inner/` protokolliert in dieser Reihenfolge:

```text
outer group filter
inner group filter
endpoint filter
```

Der äußere Filter läuft vor dem inneren, obwohl er als zweiter hinzugefügt wurde, weil Filter von der äußersten Gruppe nach innen angewandt werden und die eigenen Filter des Endpunkts zuletzt. Die relative Reihenfolge der `AddEndpointFilter`-Aufrufe spielt nur eine Rolle, wenn sie demselben Builder zugewiesen sind. Über verschiedene Gruppen hinweg gewinnt die Verschachtelung. Wenn Sie einen Authentifizierungs-Filter haben, der vor einem Logging-Filter laufen muss, legen Sie die Authentifizierung auf die äußere Gruppe, nicht nur weiter oben in der Datei.

## Eine Minimal API mit Gruppen versionieren

Ein häufiger Grund, zu verschachtelten Gruppen zu greifen, ist die API-Versionierung pro URL-Segment. Jede Version ist eine Gruppe, und jedes Ressourcen-Modul montiert sich unter dem Versions-Builder, den es erhält:

```csharp
// .NET 11, C# 14
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodos(this IEndpointRouteBuilder routes, int version)
    {
        var group = routes.MapGroup($"/todos").WithTags($"Todos v{version}");
        group.MapGet("/", GetAll);
        // v2-only endpoint
        if (version >= 2) group.MapGet("/search", Search);
        return routes;
    }
}

// Program.cs
var v1 = app.MapGroup("/api/v1");
var v2 = app.MapGroup("/api/v2");

v1.MapTodos(version: 1);
v2.MapTodos(version: 2);
```

Für alles jenseits der handgeschriebenen URL-Versionierung (Media-Type- oder Header-Versionierung, Deprecation-Header, Version Sets) integriert sich das Paket `Asp.Versioning` über `HasApiVersion` auf der Gruppe mit `MapGroup`, aber für den häufigen Fall "v1- und v2-Pfadpräfixe" reicht die einfache Verschachtelung oben und bringt keine zusätzliche Abhängigkeit mit.

## Gruppierung im OpenAPI-Dokument

`WithTags` auf einer Gruppe ist das, was die einklappbaren Abschnitte in Swagger UI oder Scalar erzeugt. Markieren Sie die Gruppe einmal, und jeder Endpunkt landet unter diesem Tag:

```csharp
// .NET 11, C# 14
var todos = app.MapGroup("/todos").WithTags("Todos");
```

Ohne Tag greift der eingebaute OpenAPI-Generator auf das erste Routensegment als Tag zurück, was meist funktioniert, aber es lohnt sich, es explizit zu setzen, damit ein Refactoring des Präfixes nicht stillschweigend Ihre API-Abschnitte umbenennt. Wenn Sie außerdem Authentifizierungsflüsse in der Spezifikation offenlegen, ist die Gruppe der richtige Ort, um die Sicherheitsanforderung zuzuweisen, sodass sie bei jeder Operation erscheint, siehe [OpenAPI-Authentifizierungsflüsse zu Swagger UI in .NET 11 hinzufügen](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) für die Verdrahtung von `WithOpenApi` und den Sicherheitsschemata.

## Stolpersteine, die man vor dem Refactoring kennen sollte

Ein paar scharfe Kanten, in die man leicht gerät, wenn man eine flache Datei zum ersten Mal in Gruppen umstrukturiert:

- **`MapGroup` muss auf einem Builder aufgerufen werden, nicht nach `app.Run()`.** Wie jede Endpunkt-Registrierung muss das geschehen, bevor die App beginnt, Anfragen zu bearbeiten. Eine Gruppe aus einem Request Handler heraus hinzuzufügen bewirkt nichts.
- **Ein Gruppenpräfix ist kein Constraint auf den gesamten Pfad.** `MapGroup("/api")` hindert andere `MapGet("/api/...")`-Aufrufe auf oberster Ebene anderswo nicht am Übereinstimmen. Die Gruppe steuert nur die Endpunkte, die Sie *über sie* registrieren.
- **`RequireAuthorization()` auf einer Gruppe ist additiv, nicht überschreibend.** Wenn eine innere Gruppe oder ein Endpunkt ebenfalls `RequireAuthorization` mit einer anderen Policy aufruft, gelten beide Policys (die Anfrage muss alle erfüllen). Es gibt keine Semantik "die innere gewinnt".
- **`AddEndpointFilterFactory` läuft einmal zur Build-Zeit, pro Endpunkt, nicht pro Anfrage.** Die Factory inspiziert `MethodInfo` und gibt das eigentliche Pro-Anfrage-Delegate zurück. Teure Pro-Anfrage-Logik in den Factory-Rumpf zu legen (statt in das zurückgegebene Delegate) bedeutet, dass sie zur Anfragezeit nie läuft. Das ist dasselbe Factory-Muster, mit dem die Dokumentation einen `DbContext` für eine Gruppe von Endpunkten in einen privaten Abfragemodus versetzt.
- **Native AOT funktioniert mit all dem gut.** Gruppen, Module per Erweiterungsmethode und Filter sind alle Teil der AOT-freundlichen Minimal-API-Oberfläche; nichts davon erzwingt einen Reflexions-Fallback. Wenn Sie getrimmt oder per AOT veröffentlichen, siehe [Native AOT mit ASP.NET Core Minimal APIs verwenden](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) für die Details des Request-Delegate-Generators, die die gruppierten Handler sauber per Source generieren lassen.

Das mitzunehmende mentale Modell: Ein `RouteGroupBuilder` ist nur ein `IEndpointRouteBuilder` mit einem gemerkten Präfix und einem gemerkten Satz von Konventionen. Jeder organisatorische Kniff, Module, Verschachtelung, Versionierung, gemeinsame Authentifizierung, folgt aus dieser einen Tatsache. Beginnen Sie damit, eine `MapXxx`-Erweiterungsmethode pro Ressource zu extrahieren, reduzieren Sie `Program.cs` auf eine Liste von Aufrufen, und greifen Sie nur dann zu verschachtelten Gruppen, wenn die URL-Hierarchie tatsächlich verschachtelt ist.

## Verwandt

- [Minimal APIs vs Controller in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), falls Sie noch zwischen den beiden Endpunktmodellen wählen.
- [Einen globalen Ausnahmefilter in ASP.NET Core 11 hinzufügen](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/), um Ausnahmen über jeden gruppierten Endpunkt an einer Stelle abzufangen.
- [Rate Limiting pro Endpunkt in ASP.NET Core 11 hinzufügen](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/), um `RequireRateLimiting` mit einer Gruppen-Policy zu kombinieren.
- [OpenAPI-Authentifizierungsflüsse zu Swagger UI in .NET 11 hinzufügen](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/), um Sicherheitsschemata dem Tag einer Gruppe zuzuweisen.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), um gruppierte Endpunkte getrimmt und per AOT zu veröffentlichen.

## Quellen

- Microsoft Learn, [Route handlers in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0) (Routengruppen, Verschachtelung, Filterreihenfolge).
- Microsoft Learn, [Filters in Minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0) (`AddEndpointFilter`, `AddEndpointFilterFactory`).
- Microsoft Learn, [Organizing ASP.NET Core Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/organizing-apis?view=aspnetcore-10.0).
- API-Referenz, [EndpointRouteBuilderExtensions.MapGroup](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.endpointroutebuilderextensions.mapgroup).
