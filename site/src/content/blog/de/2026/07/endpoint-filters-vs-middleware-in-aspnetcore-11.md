---
title: "Endpunkt-Filter vs. Middleware in ASP.NET Core 11: Was sollten Sie verwenden?"
description: "Ein Entscheidungsleitfaden für ASP.NET Core 11: Middleware läuft bei jeder Anfrage, bevor Ihr Handler das Binding durchführt, Endpunkt-Filter laufen nur für den passenden Endpunkt, nach dem Binding, und können die typisierten Argumente sehen. Enthält eine Vergleichstabelle, Szenarien zur Auswahl, die Reihenfolge-Regeln und die Details, die die Wahl erzwingen."
pubDate: 2026-07-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
lang: "de"
translationOf: "2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

Verwenden Sie Middleware, wenn die Logik bei jeder Anfrage laufen muss, vor oder unabhängig davon, welcher Endpunkt passt: Ausnahmebehandlung, CORS, Authentifizierung, Antwortkomprimierung, statische Dateien, weitergeleitete Header. Verwenden Sie einen Endpunkt-Filter, wenn die Logik die gebundenen Handler-Argumente benötigt oder nur für einige Endpunkte gelten soll: Eingabevalidierung, Argument-Normalisierung, Auditierung pro Endpunkt. Der schärfste Test: Wenn Ihr Code das typisierte Modell benötigt, das der Handler gleich empfangen wird, will er einen Filter, weil ein Filter nach dem Modell-Binding läuft und `context.GetArgument<T>(index)` lesen kann. Wenn er laufen muss, egal ob eine Route passt oder nicht, will er Middleware, weil Middleware läuft, bevor das Routing einen Endpunkt auflöst. Alles Folgende ist das Detail hinter dieser Entscheidung. Dieser Artikel zielt auf .NET 11 (Preview 6 zum Zeitpunkt des Schreibens, GA im November 2026) mit `Microsoft.NET.Sdk.Web` und C# 14, aber beide Funktionen sind seit ASP.NET Core 7 stabil, sodass jedes Beispiel hier unverändert unter .NET 8, 9 und 10 läuft.

## Die Vergleichstabelle

Dies ist die Tabelle, für die Sie gekommen sind. Lesen Sie sie von oben nach unten, und die Entscheidung trifft sich meist von selbst.

| Merkmal                                | Endpunkt-Filter                          | Middleware                               |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Läuft für                              | nur den passenden Endpunkt               | jede Anfrage in diesem Pipeline-Zweig    |
| Position relativ zum Routing           | nach Routing und Modell-Binding          | vor, bei oder nach dem Routing (Position) |
| Sieht Handler-Argumente                | ja, typisiert über `GetArgument<T>(index)` | nein, nur den rohen `HttpContext`        |
| Kann gebundene Argumente ändern        | ja, `context.Arguments` ist veränderbar  | nein, das Binding hat noch nicht stattgefunden |
| Kurzschluss-Mechanismus                | ein `IResult` statt `next` zurückgeben   | `next(context)` nicht aufrufen           |
| Gültigkeitsbereich-Kontrolle           | pro Endpunkt oder pro `MapGroup`         | pro App oder pro Zweig via `Map`/`UseWhen` |
| Registrierung                          | `.AddEndpointFilter(...)`                | `app.Use(...)` / `app.UseMiddleware<T>()` |
| Rückgabetyp                            | `ValueTask<object?>`                     | `Task`                                   |
| Läuft, wenn kein Endpunkt passt        | nie                                      | ja, wenn vor der Endpunkt-Ausführung platziert |
| Wiederverwendbar an MVC-Controllern    | ja, auch an Controller-Endpunkten        | ja, pipelineweit                         |

Die Zeilen, die die Wahl tatsächlich entscheiden, sind die ersten drei. Middleware sitzt in der Anfrage-Pipeline, und jede Anfrage, die durch dieses Segment fließt, führt sie aus, sogar eine Anfrage, die einen 404 ergibt, weil kein Endpunkt passte. Ein Endpunkt-Filter ist an einen bestimmten Routen-Handler gebunden und läuft nur, wenn dieser Handler ausgewählt wird, was geschieht, nachdem `UseRouting` die Anfrage abgeglichen hat und nachdem das Framework die Routenwerte, die Query-Zeichenkette und den Anfragetext an die Parameter des Handlers gebunden hat. Dieser Unterschied im Zeitpunkt ist die ganze Geschichte.

## Was Middleware sieht, und wann

Middleware ist eine Kette von Komponenten, von denen jede den `HttpContext` und einen `next`-Delegate empfängt. Sie registrieren sie in der `Program.cs` in Reihenfolge, und die Reihenfolge ist das Verhalten: Anfragen fließen von oben nach unten, Antworten fließen von unten nach oben zurück.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.Use(async (context, next) =>
{
    // Runs for EVERY request, including ones that will 404.
    var sw = System.Diagnostics.Stopwatch.StartNew();
    await next(context);
    sw.Stop();
    app.Logger.LogInformation(
        "{Method} {Path} -> {Status} in {Elapsed}ms",
        context.Request.Method, context.Request.Path,
        context.Response.StatusCode, sw.ElapsedMilliseconds);
});

app.MapGet("/hello/{name}", (string name) => $"Hi {name}");

app.Run();
```

Diese Timing-Middleware misst die gesamte Anfrage, einschließlich Routing und jedes 404. Sie hat nur Zugriff auf `context.Request.Path` als Zeichenkette. Sie kann nicht sehen, dass `name` an `"world"` gebunden wurde, denn an dem Punkt, an dem die äußere Middleware läuft, hat das Binding noch nicht stattgefunden. Middleware arbeitet eine Ebene unter dem Typsystem Ihres Handlers.

Die Position relativ zu `UseRouting` ist wichtiger, als die meisten erwarten. Im modernen Minimal-Hosting-Modell fügt `WebApplication` das Routing automatisch ein, aber Sie können `app.UseRouting()` explizit aufrufen, um zu steuern, wo die Trennung geschieht. Middleware, die vor dem Routing registriert wird, läuft, bevor überhaupt ein Endpunkt ausgewählt ist. Middleware, die nach `UseRouting` registriert wird, kann die Metadaten des ausgewählten Endpunkts über `context.GetEndpoint()` lesen, so weiß `UseAuthorization`, welche Richtlinie durchzusetzen ist. Deshalb ist die kanonische Reihenfolge `UseRouting`, dann `UseAuthentication`, dann `UseAuthorization` und dann die Endpunkt-Ausführung: Die Autorisierung benötigt die Endpunkt-Metadaten, die das Routing erzeugt hat.

## Was ein Endpunkt-Filter sieht, und wann

Ein Endpunkt-Filter umschließt die Aufrufung eines einzelnen Routen-Handlers. Er läuft nach dem Routing und nach dem Binding, sodass er das Eine hat, das Middleware nicht bekommen kann: die tatsächlichen, typisierten Argumente, die Ihr Handler gleich empfangen wird.

```csharp
// .NET 11, C# 14
app.MapPost("/orders", (Order order) => Results.Created($"/orders/{order.Id}", order))
    .AddEndpointFilter(async (context, next) =>
    {
        // The Order is already bound. Middleware could never see this.
        var order = context.GetArgument<Order>(0);
        if (order.Quantity < 1)
        {
            return Results.Problem("Quantity must be at least 1.");
        }
        return await next(context);
    });
```

Der Rückgabetyp des Filters ist `ValueTask<object?>`. Die Rückgabe eines beliebigen `IResult` (wie `Results.Problem`) erzeugt einen Kurzschluss und schreibt dieses Ergebnis in die Antwort, ohne den Handler jemals aufzurufen. Die Rückgabe von `await next(context)` führt den Handler aus und gibt sein Ergebnis die Kette hinauf zurück, sodass ein Filter die Antwort auch auf dem Weg nach außen transformieren kann. Da der Filter die gebundene `Order` sieht, lebt die Validierung natürlich hier. Eine Middleware-Komponente, die dieselbe Aufgabe versucht, müsste den Anfragetext selbst erneut lesen und erneut deserialisieren und damit die Arbeit duplizieren, die das Framework bereits erledigt hat. Die vollständigen Mechanismen von `AddEndpointFilter`, die klassenbasierte `IEndpointFilter`-Form und die Filter-Reihenfolge werden in [Wie Sie einer Minimal API einen Endpunkt-Filter hinzufügen](/de/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/) behandelt; dieser Artikel handelt davon, wann Sie ihn überhaupt der Middleware vorziehen.

## Wann Sie Middleware wählen

- **Das Anliegen ist global und routenunabhängig.** Ausnahmebehandlung (`UseExceptionHandler`), HTTPS-Umleitung, HSTS, CORS, Antwortkomprimierung, statische Dateien und die Verarbeitung weitergeleiteter Header müssen bei jeder Anfrage laufen, egal welcher Endpunkt (falls überhaupt einer) passt. Ein Filter kann "für alles laufen" nicht ausdrücken, weil ein Filter an Endpunkte gebunden ist und ein 404 keinen Endpunkt hat. Die Antwortkomprimierung gehört insbesondere in die Pipeline, wie in [Antwortkomprimierung zu einer ASP.NET Core 11 API hinzufügen](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) behandelt.
- **Sie müssen vor dem Routing laufen.** Den Pfad umzuschreiben, ein Präfix zu entfernen oder eine Anfrage abzulehnen, bevor der Router sie überhaupt ansieht, ist von Natur aus eine Middleware-Aufgabe. Endpunkt-Filter laufen, nachdem die Route passt, sodass sie zu spät kommen, um das Routing zu beeinflussen.
- **Sie fangen Ausnahmen in der gesamten App ab.** `UseExceptionHandler` und Entwickler-Ausnahmeseiten umschließen die gesamte nachgelagerte Pipeline. Ein Filter umschließt nur seinen einen Endpunkt, sodass eine während des Routings oder in anderer Middleware geworfene Ausnahme ihn nie erreicht. Die globale Fehlerbehandlung ist ein Pipeline-Anliegen, weshalb auch eine [Einrichtung eines globalen Ausnahme-Filters](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) auf App-Ebene statt pro Endpunkt registriert wird.
- **Die Logik muss Anfragen sehen, die einen 404 ergeben.** Metriken, Anfrageprotokollierung und Ratenbegrenzung müssen häufig Anfragen zählen oder drosseln, die nie einem Endpunkt entsprechen. Middleware sieht diese; Filter nicht.

## Wann Sie einen Endpunkt-Filter wählen

- **Sie benötigen die gebundenen Argumente.** Ein `Product` zu validieren, zu prüfen, ob ein `page`-Query-Parameter im Bereich liegt, oder eine Zeichenkette zu normalisieren, erfordern alle den typisierten Wert. `context.GetArgument<T>(index)` und die veränderbare Liste `context.Arguments` geben Ihnen genau das, und es gibt kein Äquivalent in der Middleware.
- **Das Anliegen gilt für einige Endpunkte, nicht für alle.** Ein Filter wird an einen einzelnen Endpunkt oder, via `MapGroup`, an eine Gruppe davon angehängt. Wenn Ihre Validierung nur für `POST /products` und `PUT /products/{id}` sinnvoll ist, begrenzt ein Gruppen-Filter sie präzise, ohne die globale Pipeline zu verschmutzen. Dies fügt sich mit den ressourcenbezogenen Modulen zusammen, die in [Minimal-API-Endpunkte mit MapGroup organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) beschrieben werden.
- **Sie wollen das Ergebnis des Handlers prüfen oder umschreiben.** Da der Rückgabewert des Filters die Kette zurückfließt, kann er ein erfolgreiches Ergebnis in einen Umschlag packen, Cache-Hinweise hinzufügen oder ein Domänenergebnis in ein `IResult` übersetzen. Middleware kann nur den rohen Antwort-Stream manipulieren, was weit umständlicher ist, sobald der Handler mit dem Schreiben begonnen hat.
- **Sie wollen dieselbe Logik in Minimal APIs und Controllern.** `AddEndpointFilter` funktioniert auch am Endpunkt-Konventions-Builder eines Controllers, sodass ein einzelner Filter-Delegate sowohl einen Minimal-Endpunkt als auch eine MVC-Aktion schützen kann, die sich eine Route teilen.

## Der einzige Ort, an dem die Leistung wirklich in die Entscheidung eingeht

Es ist verlockend, zu einem Filter zu greifen, "weil Middleware für alles läuft und das Verschwendung ist". Widerstehen Sie der Versuchung, es als Durchsatz-Wettbewerb zu rahmen. Beide Funktionen sind dünn: Ein Filter ist ein Delegate, der `ValueTask<object?>` zurückgibt, und eine Middleware-Komponente ist ein Delegate, der `Task` zurückgibt, und der Aufwand pro Aufruf beider ist neben jedem echten Handler, der eine Datenbank berührt oder JSON serialisiert, vernachlässigbar. Der bedeutende Unterschied ist nicht der Aufwand pro Aufruf, sondern wie viele Aufrufe geschehen. Eine früh in der Pipeline platzierte Middleware-Komponente wird bei jeder Anfrage ausgeführt, sodass teure Arbeit dort (eine Datenbankabfrage, eine große Speicherzuweisung) von jedem 404 und jedem Health-Check-Ping bezahlt wird. Dieselbe Arbeit in einem Endpunkt-Filter läuft nur, wenn dieser Endpunkt ausgewählt wird. Die Leistungsregel lautet also nicht "Filter sind schneller", sondern "begrenzen Sie die Arbeit dorthin, wo sie benötigt wird". Wenn ein übergreifendes Anliegen wirklich für jede Route gilt, ist Middleware der richtige und nicht langsamere Ort dafür. Wenn es für eine Handvoll Endpunkte gilt, vermeidet ein Filter, es bei den Tausenden von Anfragen auszuführen, die diese Endpunkte nie berühren. Das ist eine Gültigkeitsbereich-Entscheidung, verkleidet als Leistungsentscheidung, und das ist die ehrliche Version der Behauptung.

## Die Details, die für Sie entscheiden

Ein paar harte Einschränkungen setzen die Vorliebe vollständig außer Kraft.

**Ein Filter kann niemals vor dem Routing laufen.** Wenn Ihre Anforderung lautet "die Anfrage ablehnen, bevor der Router sie sieht" oder "die URL umschreiben", ist ein Filter physisch dazu nicht in der Lage, weil er innerhalb der Endpunkt-Ausführung lebt, die dem Routing nachgelagert ist. Das erzwingt Middleware.

**Middleware kann das gebundene Modell nicht sehen, ohne die Arbeit zu wiederholen.** Wenn Ihre Anforderung lautet "den deserialisierten Anfragetext validieren", müsste die Middleware den Text selbst puffern und deserialisieren, und dann deserialisiert das Framework ihn erneut für den Handler. Dieses doppelte Binding ist ein starkes Signal, dass Sie einen Filter wollten. Das erzwingt einen Filter.

**Ausnahmen entkommen dem Gültigkeitsbereich eines Filters.** Ein Filter umschließt nur seinen Endpunkt, sodass er nicht Ihr app-weites Sicherheitsnetz sein kann. Wenn Sie Ihre einzige Ausnahmebehandlung in einen Filter legen, segelt eine in anderer Middleware oder während des Routings geworfene Ausnahme daran vorbei und trifft den Standard-500-Handler. Die globale Fehlerbehandlung erzwingt Middleware.

**Die Reihenfolge-Modelle unterscheiden sich, und ihr Mischen verwirrt die Leute.** Middleware verschachtelt sich nach der Registrierungsreihenfolge in der `Program.cs`. Filter verschachteln sich nach der Reihenfolge, in der Sie die `.AddEndpointFilter`-Aufrufe verketten: Der zuerst registrierte führt seinen Code vor `next` zuerst und seinen Code nach `next` zuletzt aus. Wenn Sie beide stapeln, läuft die gesamte Filter-Kette eines Endpunkts innerhalb des innersten Punktes der Middleware-Pipeline, nachdem `UseRouting`, `UseAuthentication` und `UseAuthorization` ausgeführt wurden. Die Autorisierung läuft also immer vor jedem Endpunkt-Filter, was meist gewünscht ist, aber es bedeutet, dass ein Filter der falsche Ort ist, um ein Authentifizierungsschema zu implementieren. Die Authentifizierung erzwingt Middleware.

**Das Terminal-Verhalten ist entgegengesetzt.** Eine Middleware-Komponente, die `next` nicht aufruft, erzeugt einen Kurzschluss, indem sie einfach nicht fortfährt. Ein Filter erzeugt einen Kurzschluss, indem er ein `IResult` zurückgibt. Wenn Sie einen Filter schreiben und vergessen, auf dem Kurzschluss-Pfad etwas zurückzugeben, erhalten Sie einen Kompilierungsfehler oder ein null-Ergebnis statt einer stillschweigend verschluckten Anfrage, was ein kleiner, aber echter ergonomischer Vorteil für Filter ist.

## Die Empfehlung, erneut formuliert

Standardmäßig gilt: übergreifende Anliegen, die bei jeder Anfrage oder vor dem Routing laufen müssen, sind Middleware. Anliegen, die die typisierten Handler-Argumente benötigen oder für eine Teilmenge von Endpunkten gelten, sind Endpunkt-Filter. Authentifizierung, CORS, Ausnahmebehandlung, Komprimierung und statische Dateien sind Middleware und werden es immer sein. Validierung, Argument-Normalisierung, Auditierung pro Endpunkt und Ergebnis-Formung sind Endpunkt-Filter. Der Graubereich-Fall ist die Autorisierungslogik pro Endpunkt: Wenn sie nur Claims aus `HttpContext.User` benötigt, funktioniert beides, aber bevorzugen Sie einen Filter, damit die Richtlinie neben dem Endpunkt lebt, den sie schützt; wenn sie die gebundenen Argumente benötigt, um die Entscheidung zu treffen (Zugriffsprüfungen auf Zeilenebene für eine gebundene Entitäts-Id), muss sie ein Filter sein. Wenn Sie sich wirklich nicht entscheiden können, stellen Sie die eine Frage, die fast jeden Fall löst: Muss dieser Code die Argumente sehen, die mein Handler empfangen wird? Ja bedeutet Filter. Nein, und er muss unabhängig von der Route laufen, bedeutet Middleware.

## Verwandt

- [Wie Sie einer Minimal API einen Endpunkt-Filter in ASP.NET Core 11 hinzufügen](/de/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/)
- [Wie Sie Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11 organisieren](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Wie Sie einen globalen Ausnahme-Filter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)
- [Wie Sie Antwortkomprimierung zu einer ASP.NET Core 11 API hinzufügen](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Minimal APIs vs. Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Quellen

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [ASP.NET Core Middleware (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/)
- [ASP.NET Core Middleware order (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/#middleware-order)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
