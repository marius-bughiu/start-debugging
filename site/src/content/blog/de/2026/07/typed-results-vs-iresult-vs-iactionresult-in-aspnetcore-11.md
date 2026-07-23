---
title: "Typed Results (Results<>) vs IResult vs IActionResult in ASP.NET Core 11"
description: "Geben Sie in ASP.NET Core 11 Results<T1, TN> mit TypedResults für Minimal APIs und ActionResult<T> für Controllers zurück. Behandeln Sie das nackte IResult und das nackte IActionResult als Notausgänge: Sie kompilieren für jede Antwort, beschreiben OpenAPI aber nichts, sodass Sie in handgeschriebenen ProducesResponseType-Attributen dafür bezahlen."
pubDate: 2026-07-23
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "de"
translationOf: "2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

Wenn Ihr Endpunkt genau eine mögliche Antwort hat, deklarieren Sie diesen einen konkreten Typ und gut ist. Hat er mehrere, lautet die klare Antwort in ASP.NET Core 11: Geben Sie aus einer Minimal API `Results<TResult1, TResultN>` mit `TypedResults` zurück und aus einem Controller `ActionResult<T>`. Beide geben Ihnen eine Prüfung zur Kompilierzeit, dass der Handler nur zurückgibt, was er deklariert, und beide liefern dem OpenAPI-Generator die Antwort-Metadaten kostenlos. Die zwei Interface-Typen, das nackte `IResult` und das nackte `IActionResult`, sind Notausgänge: Sie kompilieren, egal was Sie zurückgeben, was genau der Grund ist, warum sie dem Framework nichts beschreiben und Sie zwingen, `[ProducesResponseType]` oder `.Produces` von Hand zu schreiben, um eine korrekte Spezifikation zu bekommen. Alles Folgende zielt auf .NET 11 mit `Microsoft.NET.Sdk.Web` und C# 14 ab; die `HttpResults`-Typen verhalten sich seit .NET 7 gleich, sodass derselbe Code unverändert auf .NET 10 GA läuft.

Die drei Kandidaten im Titel dieser Reihe bilden zwei verschiedene Welten ab. `IActionResult` ist die Welt der MVC-Controller. `IResult` und seine typisierte Union `Results<>` sind die Minimal-API-Welt, aufgebaut auf dem Namespace `Microsoft.AspNetCore.Http.HttpResults`. Der Kniff, der diesen Vergleich lohnenswert macht, ist, dass die `HttpResults`-Typen seit .NET 7 auch in Controllers funktionieren, sodass Sie bei einer Controller-Action jetzt eine echte Wahl zwischen den MVC-Ergebnistypen und den Minimal-API-Typen haben. Gut zu wählen bedeutet zu verstehen, was jeder Typ trägt und was nicht.

## Die Feature-Matrix

| Funktion | `IActionResult` | `ActionResult<T>` | `IResult` (nackt) | `Results<T1, TN>` |
| --- | --- | --- | --- | --- |
| Primäre Heimat | Controllers | Controllers | Minimal APIs + Controllers | Minimal APIs + Controllers |
| Beschreibt sich selbst gegenüber OpenAPI | Nein | Teilweise (leitet `T` ab) | Nein | Ja |
| Braucht `[ProducesResponseType]` / `.Produces` | Ja, reichlich | Für Statuscodes außerhalb von `T` | Ja | Nein |
| Rückgabeprüfung zur Kompilierzeit | Nein | Nein | Nein | Ja |
| Content Negotiation / Formatter | Ja | Ja | Nein | Nein |
| Implizite Umwandlung aus dem Payload-Typ | Nein (Interface) | Ja (`T` zu `ActionResult<T>`) | Nein | Ja (jedes Union-Argument) |
| Direkt unit-testbares Ergebnis | Cast nötig | Cast nötig | Cast nötig | Konkretes `.Result` |

Lesen Sie die Matrix von oben nach unten und das Muster ist klar. Die beiden Interface-Zeilen sind bei jeder Metadaten- und Sicherheitsspalte "Nein". Die beiden typisierten Zeilen rechtfertigen ihre Ausführlichkeit, indem sie "Nein" in "Ja" verwandeln. Die eine Spalte, in der die Interfaces und `ActionResult<T>` die `HttpResults`-Typen schlagen, ist Content Negotiation, und genau diese Zeile ist der Haken, der gelegentlich die Entscheidung für Sie trifft. Mehr dazu unten.

## Wann Sie Results<> (und TypedResults) wählen sollten

Greifen Sie zur Union, sobald ein **Minimal-API**-Endpunkt mit mehr als einer Form antworten kann.

- **Ein Minimal-API-Endpunkt mit einem `200` und einem `404`, in .NET 11.** Deklarieren Sie `Results<Ok<Todo>, NotFound>`, geben Sie `TypedResults.Ok(todo)` und `TypedResults.NotFound()` zurück und löschen Sie jeden `.Produces`-Aufruf. Die Union trägt die Metadaten jetzt.
- **Jeder Endpunkt, dessen Spezifikation ehrlich bleiben muss.** Weil der Rückgabetyp *der* Vertrag ist, ist das Hinzufügen eines `400`-Zweigs, ohne `BadRequest` zur Union hinzuzufügen, ein Kompilierfehler und keine still veraltete Swagger-Seite.
- **Controllers, in denen Sie dasselbe selbstbeschreibende Verhalten wollen.** Die `HttpResults`-Typen sind bei einer Controller-Action zulässig. `public Results<NotFound, Ok<Product>> GetById(int id)` kompiliert und lässt alle Ihre `[ProducesResponseType]`-Attribute fallen, genau wie in einer Minimal API.

Hier ist die kanonische Minimal-API-Form:

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

Kein `.Produces`, und das generierte OpenAPI-Dokument listet einen `200` mit einem `Todo`-Schema und einen `404` ohne Body auf, beide aus dem Rückgabetyp abgeleitet. Die schrittweise Umstellung, das Sechs-Typen-Limit und der Testgewinn werden ausführlich in [Wie man eine typisierte Results-Union aus einem Minimal-API-Endpunkt zurückgibt](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) behandelt; in diesem Beitrag geht es darum, wann man sie gegenüber den Alternativen wählt, nicht wie man sie verdrahtet.

## Wann Sie ActionResult<T> wählen sollten

Greifen Sie zu `ActionResult<T>`, wenn Sie eine **Controller**-Action mit einem primären Erfolgs-Payload und einem oder mehreren Fehlerzweigen schreiben.

- **Ein Controller-`GET`, der ein `Product` oder ein `404` zurückgibt.** `ActionResult<Product>` erlaubt Ihnen, direkt `return product;` zu schreiben (eine implizite Umwandlung verpackt es in ein `ObjectResult`) und `return NotFound();` bei einem Fehltreffer.
- **Sie möchten, dass der Erfolgstyp in die Spezifikation abgeleitet wird, ohne ihn zu wiederholen.** Mit `ActionResult<T>` braucht `[ProducesResponseType(200)]` kein `Type = typeof(Product)` mehr; das Framework liest `T`. Die Dokumentation sagt es klar: "The action's expected return type is inferred from the `T` in `ActionResult<T>`."
- **Sie brauchen Content Negotiation.** MVC-Ergebnistypen fließen durch die konfigurierten Formatter, sodass ein Client, der `Accept: application/xml` sendet, XML erhält, wenn Sie den Formatter registriert haben. Die `HttpResults`-Typen tun das überhaupt nicht.

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public ActionResult<Product> GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? NotFound() : product;   // implicit cast T -> ActionResult<T>
}
```

Der Grund, warum `ActionResult<T>` existiert und `IActionResult` es nicht ersetzen kann, ist eine C#-Regel, keine Framework-Entscheidung: C# erlaubt keine impliziten Umwandlungsoperatoren auf Interfaces. `ActionResult<T>` ist ein konkreter generischer Typ, sodass es die implizite Umwandlung aus `T` definieren kann, die Ihnen erlaubt, `return product;` zu schreiben. `IActionResult` ist ein Interface, kann es also nie. Das ist die gesamte ergonomische Lücke zwischen den beiden.

## Wann das nackte IActionResult oder IResult tatsächlich richtig ist

Kein Interface ist falsch, sie sind nur eng. Nutzen Sie sie bewusst, nicht als Standard.

- **`IActionResult`, wenn die Action wirklich unabhängige Ergebnistypen zurückgibt** und Sie akzeptieren, für jeden `[ProducesResponseType]` zu schreiben. Es bleibt die ehrliche Wahl für eine Action, die aus drei Zweigen eine Datei, eine Weiterleitung und einen JSON-Body zurückgeben könnte, wo es kein einzelnes `T` gibt.
- **`IResult`, wenn Sie einen Minimal-API-Zweig mit einer einzigen Form haben** und keine einarmige Union ausbuchstabieren möchten. Ein nacktes `IResult` aus einem Handler zurückzugeben, der immer nur einen Status produziert, ist in Ordnung; Sie fügen einfach `.Produces` hinzu, wenn Ihnen das Dokument wichtig ist.
- **Einen Handler zwischen einer Minimal API und einem Controller teilen.** Die `HttpResults`-Typen sind die eine Ergebnisfamilie, die in beiden Hosting-Modellen kompiliert, sodass eine geteilte statische Methode, die `IResult` oder eine `Results<>`-Union zurückgibt, der Weg ist, es einmal zu schreiben. Diese Portabilität ist der dokumentierte Grund, warum die Typen außerhalb von Minimal APIs existieren.

Die nackte `IResult`-Variante in einem Controller sieht so aus, und beachten Sie, dass die Attribute wieder da sind:

```csharp
// .NET 11, C# 14 -- ProductsController.cs
[HttpGet("{id}")]
[ProducesResponseType<Product>(StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public IResult GetById(int id)
{
    var product = _db.Products.Find(id);
    return product is null ? Results.NotFound() : Results.Ok(product);
}
```

Jeder `Results.*`-Helper gibt `IResult` zurück, sodass der Compiler `IResult` für beide Zweige ableitet und sich nie beschwert, und der ApiExplorer sieht ein Interface, das nichts über Statuscodes aussagt. Deshalb sind die zwei `[ProducesResponseType]`-Zeilen hier zwingend und in der `Results<>`-Variante abwesend: Die Metadaten haben keinen anderen Ursprung.

## Der Haken, der die Entscheidung für Sie trifft: Content Negotiation

Wenn Ihre API `Accept`-Header respektieren und XML, CSV oder ein anderes Format als das vom Ergebnis fest codierte zurückgeben muss, ist die `HttpResults`-Familie außen vor, und diese Entscheidung überschreibt alles Vorherige. Die Dokumentation ist eindeutig, dass die `HttpResults`-Typen die "***not*** leverage the configured Formatters," und legt die Konsequenz dar: "Some features like `Content negotiation` aren't available" und "The produced `Content-Type` is decided by the `HttpResults` implementation." `TypedResults.Ok(product)` serialisiert JSON, egal was der Client verlangt hat. Eine interne, ausschließlich JSON-basierte API darf also `Results<>` in einem Controller nutzen und die selbstbeschreibenden Metadaten genießen, aber eine öffentliche API mit einem registrierten XML-Formatter muss für die Endpunkte, die verhandeln, bei `ActionResult<T>` / `IActionResult` bleiben. Das ist eine Fähigkeitsgrenze, keine Vorliebe, weshalb sie an den Anfang Ihrer Entscheidung gehört und nicht ans Ende.

Die zweite erzwingende Funktion ist Ihr Hosting-Modell. Wenn der Endpunkt in einer Minimal API lebt, sind `IActionResult` und `ActionResult<T>` gar nicht verfügbar; es sind MVC-Typen, die von der Controller-Pipeline abhängen. Die Wahl dort besteht immer nur zwischen `IResult` und `Results<>`, und `Results<>` gewinnt für jeden Endpunkt mit mehreren Antworten. Der vollständige Kompromiss zwischen den beiden Hosting-Modellen wird in [Minimal APIs vs Controllers in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) dargelegt.

## Warum die typisierten Varianten nicht zufällig kompilieren

Es gibt einen Reibungspunkt, auf den Leute bei `Results<>` stoßen, und es lohnt sich, ihn zu benennen, damit er nicht wie ein Bug wirkt. Die Typinferenz baut die Union nicht für Sie auf. Das kompiliert nicht:

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

`TypedResults.NotFound()` und `TypedResults.Ok(todo)` sind verschiedene konkrete Typen, sodass der Compiler keinen gemeinsamen Typ für den ternären Ausdruck finden kann und das Lambda keinen ableitbaren Rückgabetyp hat. Die nackte `IResult`-Variante kompilierte nur, weil jeder `Results.*`-Helper bereits `IResult` ist, was den Zweigen einen offensichtlichen gemeinsamen Typ gibt. Mit `TypedResults` bezahlen Sie für die reichhaltigeren Metadaten, indem Sie den Rückgabetyp selbst deklarieren: `Results<Ok<Todo>, NotFound>` für einen synchronen Handler oder `Task<Results<Ok<Todo>, NotFound>>` für einen asynchronen. Diese Deklaration ist kein Boilerplate, das Sie kürzen können. Sie ist genau die Zeichenfolge, die das Framework liest, um die Spezifikation zu bauen, was der ganze Sinn ist.

Dieselbe Logik erklärt, warum `ActionResult<IEnumerable<Product>>` funktioniert, aber `ActionResult<T>` kein Interface umschließen kann, das Sie direkt zurückgeben: Die implizite Umwandlung ist aus `T` definiert, und C# verbietet implizite Umwandlungen auf Interfaces, sodass die Rückgabe einer `IEnumerable`-Instanz einen expliziten `Ok(...)`-Wrapper braucht. Kleine Regel, gelegentlich überraschend.

## Die Empfehlung, mit dem vollen Bild neu formuliert

- **Neue Minimal API, mehrere Antworten: `Results<T1, TN>` mit `TypedResults`.** Prüfung zur Kompilierzeit plus eine selbstbeschreibende OpenAPI-Spezifikation, kein `.Produces`. Das ist der Standard und sollte Ihr Reflex sein.
- **Neue Minimal API, eine einzige Antwort: der eine konkrete Typ**, zum Beispiel `Task<Ok<Todo[]>>`. Lassen Sie die Union weg, wenn es nichts zu unterscheiden gibt.
- **Controller, nur JSON, Metadaten kostenlos gewünscht: `Results<T1, TN>` im Controller** funktioniert und lässt Ihre Attribute fallen. Andernfalls **`ActionResult<T>`** für die klassische Controller-Ergonomie.
- **Jeder Endpunkt, der Inhalte verhandeln muss (XML, CSV, benutzerdefinierte Medientypen): `ActionResult<T>` oder `IActionResult`.** Die `HttpResults`-Typen können keine Content Negotiation, Punkt.
- **Nacktes `IResult` / nacktes `IActionResult`: nur Notausgänge.** Greifen Sie zu ihnen für wirklich heterogene Antworten, Zweige mit einer einzigen Form, die Sie nicht ausschreiben möchten, oder über Hosting-Modelle geteilten Code, und akzeptieren Sie die handgeschriebenen Metadaten, die damit kommen.

Das mentale Modell, das Sie behalten sollten: Ein Interface-Rückgabetyp akzeptiert alles und dokumentiert nichts, sodass das Framework Sie zwingt, den Vertrag in Attributen erneut aufzustellen. Ein typisierter Rückgabetyp, `Results<>` oder `ActionResult<T>`, *ist* der Vertrag, sodass der Compiler ihn erzwingt und der OpenAPI-Generator ihn liest. Wählen Sie den typisierten, es sei denn, eine konkrete Fähigkeit, fast immer Content Negotiation, erzwingt das Interface. Für die Zweige, die einen Validierungsfehler zurückgeben, hält das Einspeisen eines `ProblemHttpResult` in die Union die Form konsistent mit der eingebauten Pipeline, die in [Wie man die Fehlerantworten der Minimal-API-Validierung mit IProblemDetailsService anpasst](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) beschrieben wird.

## Verwandt

- [Wie man eine typisierte Results-Union aus einem Minimal-API-Endpunkt in ASP.NET Core 11 zurückgibt](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) für die schrittweise Umstellung, das Sechs-Typen-Limit und Tests.
- [Minimal APIs vs Controllers in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) für die Hosting-Modell-Wahl, die einschränkt, welche Rückgabetypen Ihnen überhaupt zur Verfügung stehen.
- [Wie man OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellt](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) für den eingebauten Generator, der diese Metadaten liest.
- [Wie man die Fehlerantworten der Minimal-API-Validierung mit IProblemDetailsService in ASP.NET Core 11 anpasst](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) für das `ProblemHttpResult`, das oft der Union beitritt.
- [Wie man Request-Bodies in Minimal APIs ohne Controllers in ASP.NET Core 11 validiert](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) für die Frage, wo `ValidationProblem` in die Antwortmenge passt.

## Quellen

- Microsoft Learn, [Controller action return types in ASP.NET Core web API](https://learn.microsoft.com/en-us/aspnet/core/web-api/action-return-types?view=aspnetcore-11.0) (`IActionResult`, `ActionResult<T>` und seine Vorteile bei der impliziten Umwandlung, die Einschränkung der impliziten Umwandlung bei Interfaces und die `HttpResults`-Typen in Controllers einschließlich des Content-Negotiation-Vorbehalts).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-11.0) (`TypedResults` vs `Results`, die `Results<TResult1, TResultN>`-Union, implizite Umwandlungsoperatoren, Prüfung zur Kompilierzeit und selbstbeschreibende Metadaten).
- Microsoft Learn, [Microsoft.AspNetCore.Http.HttpResults namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresults) (`Ok<T>`, `NotFound`, `BadRequest` und die `Results<>`-Overloads).
- dotnet/aspnetcore, [Introduce way for route handler delegates to return union results (issue #40672)](https://github.com/dotnet/aspnetcore/issues/40672) (das ursprüngliche Design der `Results<>`-Union).
</content>
</invoke>
