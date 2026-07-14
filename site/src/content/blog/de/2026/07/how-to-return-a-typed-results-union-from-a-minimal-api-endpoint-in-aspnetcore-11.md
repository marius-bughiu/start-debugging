---
title: "Wie man eine typisierte Results<T1, T2>-Union aus einem Minimal-API-Endpunkt in ASP.NET Core 11 zurückgibt"
description: "Deklarieren Sie den Rückgabetyp des Handlers als Results<Ok<T>, NotFound> und geben Sie TypedResults.Ok / TypedResults.NotFound zurück: Die Union bietet eine Prüfung zur Kompilierzeit, dass der Handler nur zurückgibt, was er deklariert, und beschreibt sich selbst gegenüber OpenAPI, sodass Sie .Produces nie von Hand schreiben. Behandelt asynchrone Handler, das Sechs-Typen-Limit und Tests in ASP.NET Core 11."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "openapi"
lang: "de"
translationOf: "2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-14
---

Wenn ein Minimal-API-Endpunkt mit mehr als einer Form antworten kann, etwa mit einem `200 OK` mit der Entität oder einem `404 Not Found`, wenn sie fehlt, ist die naheliegende Wahl, den Handler mit Rückgabetyp `IResult` zu deklarieren und `Results.Ok(...)` oder `Results.NotFound()` aufzurufen. Das kompiliert, wirft aber die zwei Dinge weg, die `IResult` nicht tragen kann: Der Compiler prüft nicht mehr, dass Sie nur die Ergebnisse zurückgeben, die Sie beabsichtigt haben, und OpenAPI hat keine Ahnung, dass ein `404` überhaupt möglich ist, es sei denn, Sie schreiben `.Produces(404)` von Hand an den Endpunkt. Die Lösung ist der Union-Typ `Results<TResult1, TResult2, ...>` aus `Microsoft.AspNetCore.Http.HttpResults`. Deklarieren Sie den Handler als `Results<Ok<Todo>, NotFound>`, geben Sie die konkreten Werte `TypedResults.Ok(todo)` und `TypedResults.NotFound()` zurück, und die Union beschreibt sich selbst gegenüber OpenAPI, während der Compiler jeden Zweig ablehnt, der etwas zurückgibt, das Sie nicht aufgeführt haben. Alles Folgende zielt auf .NET 11 mit `Microsoft.NET.Sdk.Web` und C# 14 ab; die Union verhält sich seit .NET 7 identisch, sodass derselbe Code unverändert auf .NET 10 GA läuft.

## Warum IResult Ihre OpenAPI-Metadaten verliert

Beginnen Sie mit der Version, die die meisten zuerst schreiben. Der Handler gibt `IResult` zurück, weil das der einzige Typ ist, der zu beiden Zweigen passt:

```csharp
// .NET 11, C# 14 -- Program.cs
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? Results.NotFound()
        : Results.Ok(todo);
});
```

Das funktioniert zur Laufzeit, und das ist der Grund, warum `Results` existiert: Jeder Helper der statischen Klasse `Results` gibt `IResult` zurück, sodass der Compiler bereitwillig `IResult` als Rückgabetyp des Delegate ableitet, selbst wenn die Zweige einen `200` und einen `404` erzeugen. Die Kosten zeigen sich in Ihrem OpenAPI-Dokument. Das Framework untersucht den deklarierten Rückgabetyp, um den Antwortabschnitt der Spezifikation aufzubauen, und alles, was es sieht, ist `IResult`, eine Schnittstelle, die nichts über Statuscodes oder Payloads aussagt. Swagger UI zeigt einen einzelnen undokumentierten `200` und gar keinen `404`. Um eine genaue Spezifikation zu erhalten, müssen Sie den Endpunkt von Hand annotieren:

```csharp
// .NET 11, C# 14 -- the manual annotation IResult forces on you
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null ? Results.NotFound() : Results.Ok(todo);
})
.Produces<Todo>(StatusCodes.Status200OK)
.Produces(StatusCodes.Status404NotFound);
```

Diese `.Produces`-Aufrufe sind reine Duplizierung. Sie wiederholen, was der Handler-Rumpf bereits entscheidet, und nichts hält sie synchron. Fügen Sie sechs Monate später einen `400`-Zweig hinzu, und die Spezifikation behauptet weiterhin, der Endpunkt gebe nur `200` oder `404` zurück, weil die Metadaten an einem anderen Ort leben als der Code, der sie erzeugt. Genau diese Abweichung beseitigt die typisierte Union.

## Deklarieren Sie die Union und geben Sie TypedResults zurück

Die statische Klasse `TypedResults` ist der typisierte Zwilling von `Results`. Während `Results.Ok(x)` `IResult` zurückgibt, gibt `TypedResults.Ok(x)` das konkrete `Ok<T>` aus dem Namespace `Microsoft.AspNetCore.Http.HttpResults` zurück, und `TypedResults.NotFound()` gibt ein `NotFound` zurück. Jeder dieser konkreten Typen implementiert `IEndpointMetadataProvider`, sodass jeder weiß, wie er sich gegenüber OpenAPI beschreibt. Der Typ `Results<TResult1, TResult2>` bindet sie zu einem einzigen deklarierten Rückgabetyp zusammen. Die Umstellung des obigen Endpunkts sind drei Schritte:

1. **Deklarieren Sie den Rückgabetyp des Handlers als die Union.** Führen Sie jedes Ergebnis auf, das der Handler erzeugen kann, in beliebiger Reihenfolge: `Results<Ok<Todo>, NotFound>`. Bei einem asynchronen Handler umschließen Sie ihn mit `Task<>`: `async Task<Results<Ok<Todo>, NotFound>>`.
2. **Geben Sie `TypedResults`-Helper zurück, nicht `Results`.** Tauschen Sie `Results.Ok` gegen `TypedResults.Ok` und `Results.NotFound` gegen `TypedResults.NotFound`. Jeder gibt seinen konkreten Implementierungstyp zurück.
3. **Löschen Sie die `.Produces`-Aufrufe.** Die Union trägt die Metadaten jetzt, sodass die manuellen Annotationen redundant sind und entfernt werden sollten, sonst verrotten sie.

Hier ist der Endpunkt nach der Umstellung:

```csharp
// .NET 11, C# 14 -- Program.cs
using Microsoft.AspNetCore.Http.HttpResults;

app.MapGet("/todos/{id}", async Task<Results<Ok<Todo>, NotFound>> (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
});
```

Kein `.Produces`, und das OpenAPI-Dokument führt nun einen `200` mit einem `Todo`-Schema und einen `404` ohne Rumpf auf, direkt aus dem Rückgabetyp erzeugt. Die offizielle Dokumentation nennt den Kompromiss unverblümt: `TypedResults` mit der Union zu verwenden ist wortreicher, als `IResult` zurückzugeben, "but that's the trade-off for having the type information be statically available and thus capable of self-describing to OpenAPI". Wenn Sie den eingebauten OpenAPI-Dokumentgenerator ausführen, der in [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) behandelt wird, fließen diese Metadaten ohne zusätzliche Konfiguration in das generierte JSON.

## Wie die Union tatsächlich kompiliert

Der Teil, der dies ergonomisch statt mühsam macht, ist die implizite Konvertierung. `Results<Ok<Todo>, NotFound>` definiert einen impliziten Konvertierungsoperator von jedem seiner generischen Argumente zur Union selbst. Wenn Ihr Handler `TypedResults.Ok(todo)` zurückgibt, was ein `Ok<Todo>` ist, konvertiert der Compiler es implizit zur Union. Sie konstruieren nie selbst ein `Results<...>` und schreiben nie einen Cast; Sie geben das konkrete Ergebnis zurück, und die Konvertierung ist unsichtbar. Deshalb funktioniert der ternäre Ausdruck im Beispiel: Beide Zweige erzeugen einen Typ, den die Union aufnehmen kann, sodass der gesamte Ausdruck als Union typisiert wird.

Hier kommt auch die Sicherheit zur Kompilierzeit her. Da die Union nur Konvertierungen von den Typen definiert, die Sie aufgeführt haben, ist die Rückgabe von etwas anderem ein Kompilierfehler, keine Laufzeitüberraschung. Fügen Sie einen Zweig hinzu, der `TypedResults.BadRequest()` zurückgibt, ohne `BadRequest` zur Union hinzuzufügen, und der Build schlägt fehl:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();   // error: BadRequest is not in the union
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

Der Compiler teilt Ihnen mit, dass die deklarierten Ergebnisse und die zurückgegebenen Ergebnisse nicht übereinstimmen, sodass der Vertrag des Endpunkts und seine Implementierung niemals still auseinanderdriften können. Beheben Sie es, indem Sie den Typ hinzufügen, den Sie tatsächlich zurückgeben:

```csharp
// .NET 11, C# 14 -- compiles, and OpenAPI now shows 200, 404, and 400
app.MapGet("/orders/{id}", Results<Ok<Order>, NotFound, BadRequest> (int id) =>
{
    if (id < 0)
        return TypedResults.BadRequest();
    return id > 999 ? TypedResults.NotFound() : TypedResults.Ok(new Order(id));
});
```

Beachten Sie, dass der synchrone Handler hier keinen `Task<>`-Wrapper benötigt, aber dennoch den vollständigen Union-Rückgabetyp explizit deklarieren muss. Der Compiler leitet nicht von sich aus einen "besten gemeinsamen Typ" über `Ok<Order>`, `NotFound` und `BadRequest` ab, was genau der Grund ist, warum der Endpunkt, der `IResult` zurückgab, ohne Beanstandung kompilierte und dieser hier verlangt, dass Sie die Union ausschreiben.

## Warum die synchrone Version den Typ deklariert braucht

Es lohnt sich, den Fehler zu verstehen, auf den Sie stoßen, wenn Sie versuchen, die Typinferenz die Arbeit machen zu lassen. Dies kompiliert nicht:

```csharp
// .NET 11, C# 14 -- does NOT compile
app.MapGet("/todos/{id}", async (int id, TodoDb db) =>
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()   // NotFound
        : TypedResults.Ok(todo);    // Ok<Todo>
});
```

`TypedResults.Ok` und `TypedResults.NotFound` geben unterschiedliche konkrete Typen zurück, und der Compiler weigert sich, einen gemeinsamen Typ für den bedingten Ausdruck abzuleiten, sodass das Lambda keinen ableitbaren Rückgabetyp hat. Die `Results`-Version desselben Codes kompilierte nur, weil jeder `Results`-Helper bereits als `IResult` typisiert ist und dem ternären Ausdruck einen offensichtlichen gemeinsamen Typ gibt. Mit `TypedResults` bezahlen Sie die reichhaltigere Typinformation, indem Sie den Rückgabetyp selbst deklarieren, entweder `Results<Ok<Todo>, NotFound>` für einen synchronen Handler oder `Task<Results<Ok<Todo>, NotFound>>` für einen asynchronen. Diese Deklaration ist kein Boilerplate, das Sie überspringen können; sie ist das, was das Framework liest, um Ihre OpenAPI-Spezifikation aufzubauen.

## Der Vorteil beim Testen

Da der Handler jetzt einen konkreten Typ statt `IResult` zurückgibt, können Unit-Tests das genaue Ergebnis prüfen, ohne einen HTTP-Server hochzufahren oder einen Cast durchzuführen. Extrahieren Sie den Handler in eine benannte statische Methode, damit ein Test ihn direkt aufrufen kann:

```csharp
// .NET 11, C# 14 -- TodoEndpoints.cs
public static async Task<Results<Ok<Todo>, NotFound>> GetTodo(int id, TodoDb db)
{
    var todo = await db.Todos.FindAsync(id);
    return todo is null
        ? TypedResults.NotFound()
        : TypedResults.Ok(todo);
}
```

Ein Test prüft dann den konkreten Typ und greift direkt auf dessen typisiertes `Value` zu, ohne Reflection über `IResult` und ohne HTTP-Roundtrip:

```csharp
// .NET 11, C# 14 -- xUnit
[Fact]
public async Task GetTodo_ReturnsOk_WhenFound()
{
    await using var db = new MockDb().CreateDbContext();
    db.Todos.Add(new Todo { Id = 1, Title = "Write the union post" });
    await db.SaveChangesAsync();

    var result = await TodoEndpoints.GetTodo(1, db);

    var ok = Assert.IsType<Ok<Todo>>(result.Result);
    Assert.Equal(1, ok.Value!.Id);
}
```

Die Union stellt das tatsächliche Ergebnis über ihre `Result`-Eigenschaft bereit, und `Ok<Todo>` stellt die Payload über ein stark typisiertes `Value` bereit. Das ist der Vorteil "improve unit testing", den die Dokumentation für `TypedResults` aufführt: Mit `Results` müssten Sie das `IResult` erst in einen konkreten Typ zurückkonvertieren, bevor Sie irgendetwas darüber prüfen könnten. Hier ist der Typ bereits konkret, sodass die Prüfung ein Einzeiler ist. Wenn Ihr Handler klein genug ist, um inline in `MapGet` zu stehen, ist es eine sinnvolle Refaktorierung, ihn allein zur Testbarkeit in eine statische Methode zu extrahieren; der Vergleich [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) beschreibt, wann sich diese Struktur auszahlt.

## Die Sechs-Typen-Grenze und wie Sie darunter bleiben

`Results<>` ist mit zwei bis sechs generischen Parametern definiert, sodass ein einzelner Endpunkt höchstens sechs unterschiedliche Ergebnistypen deklarieren kann. In der Praxis ist das reichlich: Ein Endpunkt, der `Ok`, `Created`, `NotFound`, `BadRequest`, `Conflict` und `ValidationProblem` zurückgibt, ist bereits an der Grenze und tut wahrscheinlich zu viel. Eine Anhebung der Grenze wurde angefragt (verfolgt als [dotnet/aspnetcore#61706](https://github.com/dotnet/aspnetcore/issues/61706)), aber vorerst ist sechs die Wand.

Wenn Sie tatsächlich daran stoßen, haben Sie zwei sinnvolle Auswege. Der erste besteht darin, verwandte Fehler in einen einzigen Problemtyp zusammenzufassen: Statt `BadRequest`, `Conflict` und `UnprocessableEntity` einzeln aufzuführen, geben Sie `ProblemHttpResult` über `TypedResults.Problem(...)` zurück und kodieren die Unterscheidung im RFC-9457-Payload, was dieselbe Form ist, die die eingebaute Validierung, behandelt in [Validierungsfehlerantworten von Minimal APIs anpassen](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/), bereits ausgibt. Der zweite besteht darin, für diesen einen Endpunkt auf `IResult` zurückzufallen und die `.Produces`-Annotationen von Hand hinzuzufügen, wobei Sie die manuellen Metadaten als Preis für mehr als sechs Zweige akzeptieren. Greifen Sie zu keinem von beiden, bevor Sie sechs tatsächlich überschritten haben; die meisten Endpunkte leben komfortabel bei zwei oder drei.

## Stolperfallen, über die man stürzt

- **`Ok` und `Ok<T>` sind verschiedene Typen.** `TypedResults.Ok()` ohne Argument gibt `Ok` zurück (einen `200` ohne Rumpf); `TypedResults.Ok(value)` gibt `Ok<T>` zurück. Wenn Ihre Union `Ok<Todo>` aufführt, ein Zweig aber das parameterlose `TypedResults.Ok()` aufruft, kompiliert es nicht, weil `Ok` nicht `Ok<Todo>` ist. Führen Sie die genaue Variante auf, die jeder Zweig erzeugt.
- **Der Union-Rückgabetyp muss vollständig ausgeschrieben werden.** Es gibt keine Kurzform und keine Inferenz. `async Task<Results<Ok<Todo>, NotFound>>` ist wortreich, und das ist Absicht: Das Framework liest genau diese Deklaration, um die Spezifikation aufzubauen, sodass eine Abkürzung keine Option ist.
- **Ein vom Handler zurückgegebenes `Problem` umgeht weiterhin `CustomizeProblemDetails`.** `ProblemHttpResult` in die Union aufzunehmen dokumentiert die Antwort, aber ein `ProblemDetails`, das Sie im Handler konstruieren und zurückgeben, wird direkt serialisiert und läuft nicht durch `IProblemDetailsService`. Wenn Sie sich auf einen globalen `CustomizeProblemDetails`-Callback verlassen, um eine `traceId` zu stempeln, wird er für diese nicht ausgelöst; dieser Mechanismus ist im [Beitrag zur IProblemDetailsService-Anpassung](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) beschrieben.
- **Die Reihenfolge in der generischen Liste spielt keine Rolle, ist aber Ihre Dokumentation.** `Results<Ok<Todo>, NotFound>` und `Results<NotFound, Ok<Todo>>` verhalten sich identisch. Wählen Sie eine konsistente Reihenfolge (Erfolg zuerst ist die übliche Konvention), damit ein Leser den Vertrag eines Endpunkts auf einen Blick erfassen kann.
- **Nicht-Status-Metadaten fügen Sie weiterhin explizit hinzu.** Die Union deckt die Antworttypen und Statuscodes ab. Dinge wie `.WithName`, `.WithTags`, `.RequireAuthorization` oder ein benutzerdefiniertes `Produces` für einen nicht standardmäßigen Content-Type sind separate Belange und gehören weiterhin an den Endpoint-Builder, genau wie bei jedem anderen Endpunkt, einschließlich der JWT-Einrichtung in [JWT-Bearer-Authentifizierung in einer Minimal API einrichten](/de/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

Das Denkmodell, das Sie behalten sollten: `IResult` ist die Notausstiegsluke, die alles zurückgibt und nichts dokumentiert, während `Results<T1, TN>` ein deklarierter Vertrag ist, den der Compiler durchsetzt und OpenAPI liest. Greifen Sie zur Union, wann immer ein Endpunkt mehr als eine mögliche Antwort hat, geben Sie aus jedem Zweig den passenden `TypedResults`-Helper zurück, und lassen Sie das Typsystem Ihren Handler, Ihre Tests und Ihre Spezifikation im Einklang halten. Wenn ein Endpunkt wirklich eine einzige Antwortform hat, überspringen Sie die Union und deklarieren diesen einen konkreten Typ direkt, zum Beispiel `Task<Ok<Todo[]>>`; die Union verdient ihre Wortfülle nur, wenn es mehr als einen Zweig zu dokumentieren gibt.

## Related

- [Wie man Validierungsfehlerantworten von Minimal APIs mit IProblemDetailsService in ASP.NET Core 11 anpasst](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) zum Formen des `ProblemHttpResult`, das Sie in die Union aufnehmen.
- [Wie man OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellt](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) für den eingebauten Generator, der diese Metadaten liest.
- [Wie man Request-Bodies in Minimal APIs ohne Controller in ASP.NET Core 11 validiert](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) für das `ValidationProblem`-Ergebnis, das oft zur Union hinzukommt.
- [Wie man Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisiert](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) zum Gruppieren typisierter Endpunkte und Anwenden gemeinsamer Metadaten.
- [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) dazu, wie sich die Rückgabetyp-Konventionen zwischen den beiden Modellen unterscheiden.

## Sources

- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, die `Results<TResult1, TResultN>`-Union, die impliziten Konvertierungsoperatoren, die Prüfung zur Kompilierzeit, die Anforderung des asynchronen `Task<>` und das Unit-Test-Beispiel).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest`, `Results<TResult1, TResult2>` bis zur Überladung mit sechs Parametern).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (das ursprüngliche Design der `Results<>`-Union).
- dotnet/aspnetcore, [Extend Results in TypedResults to support more than 6 types (issue #61706)](https://github.com/dotnet/aspnetcore/issues/61706) (die Sechs-Typen-Grenze und die Anfrage, sie anzuheben).
