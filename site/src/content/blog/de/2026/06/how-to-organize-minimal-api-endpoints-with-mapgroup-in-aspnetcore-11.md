---
title: "Minimal-API-Endpunkte mit MapGroup organisieren"
description: "Minimal APIs mit Ressourcen-Erweiterungsmethoden und MapGroup strukturieren: verschachtelte Routen, Metadaten, Filter, Authentifizierung und Tests."
pubDate: 2026-06-07
updatedDate: 2026-11-02
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

`MapGroup` bündelt ein Routenpräfix und Endpunktkonventionen. Die API existiert seit ASP.NET Core 7. Eine Erweiterungsmethode pro Ressource kann die Registrierung aus `Program.cs` auslagern, ohne Controller einzuführen.

**Korrektur — 2. November 2026:** Die frühere Fassung beschrieb das Zusammenfügen von Schrägstrichen fälschlich als reine Verkettung und stellte alle `WebApplication`-APIs als Gruppen-APIs dar. Das Ersatzbeispiel verwendet SDK 10.0.302 und ist kein .NET-11-Laufzeittest.

## Ein vollständiges Ressourcenmodul

```csharp
// Program.cs in a Microsoft.NET.Sdk.Web project targeting net10.0.
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<TodoStore>();
var app = builder.Build();

app.MapGroup("/api").MapTodos();
app.Run();

public static class TodoEndpoints
{
    public static RouteGroupBuilder MapTodos(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/todos/").WithTags("Todos");
        group.MapGet("/{id:int}", GetTodo).WithName("GetTodo");
        group.MapPut("/{id:int}", PutTodo);
        return group;
    }

    private static Results<Ok<Todo>, NotFound> GetTodo(int id, TodoStore store) =>
        store.Items.TryGetValue(id, out var todo)
            ? TypedResults.Ok(todo)
            : TypedResults.NotFound();

    private static NoContent PutTodo(int id, Todo todo, TodoStore store)
    {
        store.Items[id] = todo;
        return TypedResults.NoContent();
    }
}

public sealed class TodoStore
{
    public ConcurrentDictionary<int, Todo> Items { get; } = new(
        new[] { new KeyValuePair<int, Todo>(1, new Todo("Write docs", false)) });
}

public record Todo(string Title, bool IsComplete);
```

Die Anwendung stellt `GET /api/todos/1` und `PUT /api/todos/{id}` bereit. Der Demonstrationsspeicher überlebt keinen Prozessneustart. Die Routenkomposition von SDK 10 verbindet `/todos/` und `/{id:int}`, ohne `/todos//{id:int}` zu erzeugen. Einheitliche Schreibweise ist hilfreich; eine reine String-Verkettung erklärt das Routingverhalten jedoch nicht.

Die Endpunktklasse darf in eine andere Datei desselben Projekts verschoben werden. Die Datei allein bestimmt nicht, ob die Request-Delegate-Generierung läuft. Private Handler lassen sich nicht direkt aus einer anderen Test-Assembly aufrufen. Testen Sie über HTTP oder lagern Sie Geschäftslogik in eigenständig testbare Dienste aus.

## Möglichkeiten einer Gruppe

`RouteGroupBuilder` implementiert `IEndpointRouteBuilder` und `IEndpointConventionBuilder`. Damit sind verschachtelte Routen und Konventionen wie `WithTags`, `RequireAuthorization` sowie Endpunktfilter möglich. Nicht die gesamte `WebApplication`-API ist verfügbar: Middleware mit `Use...` und die Host-Lebensdauer gehören zur Anwendung.

Explizite Tags steuern die OpenAPI-Gruppierung, erzeugen oder veröffentlichen aber kein Dokument. Dazu ist versionsgerechtes OpenAPI-Setup nötig. Endpunktnamen müssen anwendungsweit eindeutig sein.

Verschachtelte Präfixe werden kombiniert; Parameter einer äußeren Gruppe können an innere Handler gebunden werden. Äußere Filter umschließen innere und Endpunktfilter. Code vor `await next(context)` läuft zum Handler hin, Code danach in umgekehrter Reihenfolge zurück. Die Registrierungsreihenfolge innerhalb einer Gruppe bleibt relevant.

## Richtlinien bewusst konfigurieren

`RequireAuthorization("policy")` ergänzt Metadaten. Es erstellt weder die Richtlinie noch einen Authentifizierungshandler oder Zugangsdaten. Registrieren Sie Dienste und passende Middleware. Ein Präfix `/v1` allein ist ebenfalls keine vollständige API-Versionierungsstrategie.

Für Eingabeprüfungen siehe [integrierte Validierung und FluentValidation](/de/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/). Native AOT hängt zusätzlich von Handlern, Serialisierung und Abhängigkeiten ab; beachten Sie [den AOT-Leitfaden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/).

## Quellen

- [ASP.NET Core route handlers and route groups](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers?view=aspnetcore-10.0#route-groups)
- [Endpoint filters](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters?view=aspnetcore-10.0)
- [RoutePatternFactory.Combine source, .NET 10](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Routing/src/Patterns/RoutePatternFactory.cs)
- [Minimal API security](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security?view=aspnetcore-10.0)
