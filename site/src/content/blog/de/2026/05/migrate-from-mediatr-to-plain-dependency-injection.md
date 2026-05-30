---
title: "Migration von MediatR zu einfacher Dependency Injection in .NET 11"
description: "Eine Schritt-für-Schritt-Checkliste, um MediatR 12-14 zu entfernen und IRequest-Handler, ISender, Pipeline Behaviors und INotification durch einfache Service-Klassen und Konstruktorinjektion zu ersetzen."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "mediatr"
  - "dependency-injection"
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/migrate-from-mediatr-to-plain-dependency-injection"
translatedBy: "claude"
translationDate: 2026-05-30
---

MediatR aus einer .NET-11-Codebasis zu entfernen ist ein mechanisches Refactoring, keine Neufassung. Für einen typischen Service mit 50-150 Handlern sollten Sie einen halben bis ganzen Tag einplanen: Die meisten Handler kollabieren eins zu eins zu Methoden auf einfachen Service-Klassen, `ISender.Send`-Aufrufe werden zu direkten Interface-Aufrufen, und der einzige Teil, der Design-Überlegungen erfordert, ist die Pipeline. Was bricht, ist alles, was auf der Laufzeitauflösung von Handlern oder dem `IPipelineBehavior<,>`-Wrapping um jede Anfrage beruhte; das wird zu Konstruktorinjektion und Decorators. Es lohnt sich, wenn Sie nur `Send` aufrufen, wenn Sie über der $5,000,000-Umsatzgrenze der Community-Edition von MediatR liegen und keine kommerzielle Lizenz kaufen möchten, oder wenn Sie Native AOT und Trimming-Freundlichkeit wollen. Es lohnt sich nicht, wenn Ihre Pipeline Behaviors über Hunderte von Anfragetypen hinweg tragend sind.

Referenzierte Versionen: Dieser Leitfaden behandelt das Entfernen von MediatR 12.5.0 (die letzte Version unter der Apache-2.0-Lizenz), 13.0 (veröffentlicht am 2025-07-02, die erste Version mit dualem Reciprocal Public License 1.5 / kommerziellem Modell von Lucky Penny Software) und der aktuellen 14.x-Linie. Der Ersatzcode zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET-11-SDK und C# 14, plus Scrutor 6.x für die Decorators. Wenn Sie noch entscheiden, *ob* Sie wechseln sollen, lesen Sie zuerst [MediatR vs einfache Service-Klassen in 2026](/de/2026/05/mediatr-vs-plain-service-classes-in-2026/); dieser Beitrag setzt voraus, dass die Entscheidung gefallen ist.

## Warum Teams MediatR gerade jetzt entfernen

- **Die Lizenz erzwingt oberhalb von $5M eine Entscheidung.** Die kostenlose Open-Source-Nutzung von MediatR 13+ erfolgt unter der RPL-1.5, einer reziproken Copyleft-Lizenz, die die SaaS-Lücke schließen soll. Wenn Sie Closed-Source-Kommerzsoftware oberhalb der Umsatzschwelle der Community-Edition ausliefern, ist diese Lizenz für Sie nicht nutzbar, also heißt es kaufen oder gehen.
- **Gehe-zu-Definition landet beim Handler, nicht bei `Send`.** Direkte Interface-Aufrufe stellen die Navigierbarkeit wieder her, die die Mediator-Indirektion Sie bei jedem Sprung kostet.
- **Der Start wird günstiger und AOT wird einfacher.** Das Entfernen des Assembly-Scans für die Handler-Registrierung spart Millisekunden beim Kaltstart und beseitigt die Reflexion, die mit dem Trimming kämpft, was wichtig ist beim [Reduzieren der Kaltstartzeit einer .NET-11-AWS-Lambda](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).
- **Die Verdrahtung schlägt beim Start fehl, nicht bei der ersten Anfrage.** Die explizite `AddScoped`-Registrierung verwandelt eine fehlende Abhängigkeit in einen Fehler zur Startzeit statt in eine `InvalidOperationException` zur Laufzeit.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| `ISender` / `IMediator`-Injektion | Ersetzt durch das direkt injizierte konkrete Service-Interface | hoch |
| `IRequest<T>` + `IRequestHandler<,>` | Kollabieren zu einem Interface + der Implementierungsmethode | hoch |
| `IPipelineBehavior<,>` | Kein generischer Wrap-Punkt; pro Interface durch Decorators oder Middleware ersetzt | hoch |
| `INotification` + `INotificationHandler<>` | Ersetzt durch ein injiziertes `IEnumerable<IHandler>`-Fan-out oder einen Event-Aggregator | mittel |
| `AddMediatR(...)`-Registrierung | Ersetzt durch explizite `AddScoped`-Aufrufe (oder einen Scrutor-Scan) | mittel |
| `RequestHandlerDelegate<T>` in Behaviors | Kein Äquivalent; die "next"-Kette entfällt | mittel |
| `ISender.CreateStream` (`IStreamRequest`) | Ersetzt durch eine Methode, die `IAsyncEnumerable<T>` zurückgibt | niedrig |
| Unit-Tests, die `ISender` mocken | Auf das Mocken des konkreten Interface umgelenkt | niedrig |

## Vorab-Checkliste

- Das .NET-11-SDK ist installiert: Bestätigen Sie mit `dotnet --version` (erwarten Sie `11.x`).
- Sie haben einen sauberen git-Branch und eine grüne Testsuite, *bevor* Sie beginnen. Verifizieren Sie mit `dotnet test` und bestätigen Sie null Fehlschläge.
- Inventarisieren Sie die betroffene Oberfläche. Führen Sie eine Suche aus und notieren Sie die Anzahl, denn sie sagt Ihnen, wie groß die Aufgabe ist:

```bash
# .NET 11 - inventory MediatR usage before touching anything
grep -rn "IRequestHandler\|IRequest<\|: IRequest" src/      # handlers + requests
grep -rn "IPipelineBehavior" src/                            # the hard part
grep -rn "INotification" src/                                # fan-out
grep -rn "ISender\|IMediator\|\.Send(\|\.Publish(" src/      # call sites
```

- Entscheiden Sie *zuerst* über die Ersatzform der Behaviors. Wenn Sie null `IPipelineBehavior`-Treffer haben, ist dies ein reines Suchen-und-Ersetzen. Wenn Sie mehrere haben, planen Sie, ob jeder zu einem Decorator, ASP.NET-Core-Middleware oder einem Endpunkt-Filter wird.
- Fügen Sie Scrutor hinzu, falls Sie Decorators verwenden: `dotnet add package Scrutor` (6.x, MIT-lizenziert).

## Migrationsschritte

1. **Wandeln Sie jede Anfrage und jeden Handler in ein Service-Interface und eine Methode um.**

Eine MediatR-Anfrage ist ein Nachrichtentyp plus ein separater Handler. Ersetzen Sie beide durch ein Interface und eine Implementierung. Gruppieren Sie verwandte Anfragen auf einem einzigen Service, statt ein Interface pro alter Anfrage zu erstellen.

```csharp
// .NET 11, C# 14, MediatR 14.x - BEFORE
using MediatR;

public record GetOrderById(int OrderId) : IRequest<OrderDto>;

public sealed class GetOrderByIdHandler(AppDbContext db)
    : IRequestHandler<GetOrderById, OrderDto>
{
    public async Task<OrderDto> Handle(GetOrderById request, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([request.OrderId], ct)
            ?? throw new OrderNotFoundException(request.OrderId);
        return order.ToDto();
    }
}
```

```csharp
// .NET 11, C# 14 - AFTER: plain service, no MediatR reference
public interface IOrderService
{
    Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct);
}

public sealed class OrderService(AppDbContext db) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([orderId], ct)
            ?? throw new OrderNotFoundException(orderId);
        return order.ToDto();
    }
}
```

**Verifizieren:** Die neue Datei hat kein `using MediatR;` und der Handler-Rumpf ist byte-identisch bis auf die Methodensignatur. Die `record`-Parameter der Anfrage werden in derselben Reihenfolge zu Methodenparametern.

2. **Ersetzen Sie `ISender.Send`-Aufrufstellen durch direkte Interface-Aufrufe.**

Jeder Aufrufer, der `ISender` oder `IMediator` injizierte, injiziert nun das spezifische Service-Interface und ruft die Methode auf.

```csharp
// .NET 11, C# 14 - BEFORE
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);

// AFTER
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

**Verifizieren:** Nach diesem Schritt gibt `grep -rn "ISender\|IMediator" src/` nur Zeilen zurück, die Sie bewusst noch nicht migriert haben. Die Anzahl sollte gegen null marschieren.

3. **Registrieren Sie die Services explizit.**

Löschen Sie `AddMediatR(...)` und registrieren Sie jeden Service. Die explizite Registrierung ist trim-sicher und schlägt beim Start schnell fehl, was genau der Fehlermodus hinter [Unable to resolve service for type while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) ist.

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

Wenn Sie eine konventionsbasierte Registrierung ohne das Reflexionsmodell von MediatR wollen, scannt Scrutor nach Interface-Namen:

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

**Verifizieren:** Die Anwendung startet. Führen Sie sie aus und rufen Sie einen migrierten Endpunkt auf; eine fehlende Registrierung wirft nun beim Start, nicht bei der ersten Anfrage. Bestätigen Sie, dass sich keine Scoped-aus-Singleton-Fehler eingeschlichen haben, die Bug-Klasse aus [Cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

4. **Ersetzen Sie Pipeline Behaviors durch Decorators oder Middleware.**

Dies ist der einzige Schritt, der Urteilsvermögen erfordert. Ein `IPipelineBehavior<,>` umhüllte jede Anfrage an einer einzigen Stelle. Sie haben zwei ehrliche Ersätze.

Für Concerns, die wirklich pro Service gelten (Logging, Caching, Wiederholungen), verwenden Sie einen Scrutor-Decorator:

```csharp
// .NET 11, C# 14, Scrutor 6.x - BEFORE was a generic ValidationBehavior<TRequest,TResponse>
public sealed class LoggingOrderService(
    IOrderService inner,
    ILogger<LoggingOrderService> logger) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        logger.LogInformation("Fetching order {OrderId}", orderId);
        return await inner.GetByIdAsync(orderId, ct);
    }
}

// Registration: wrap the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

Für Concerns, die in Wahrheit HTTP-Concerns sind (Request-Logging, Zuordnung von Exceptions zu ProblemDetails, Authentifizierung), verlagern Sie diese vollständig aus der Anwendungsschicht in ASP.NET-Core-Middleware oder einen Endpunkt-Filter. Ein Behavior, das Exceptions abfing und Antworten formte, gehört an denselben Ort wie [ein globaler Exception-Filter in ASP.NET Core 11](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/), nicht in einen Decorator.

Wenn Sie FluentValidation innerhalb eines `ValidationBehavior` verwendet haben, behalten Sie die Validatoren und rufen Sie sie aus einem einzigen Decorator oder einem Endpunkt-Filter einer Minimal-API auf:

```csharp
// .NET 11, C# 14 - a validation decorator replacing ValidationBehavior for one interface
public sealed class ValidatingOrderService(
    IOrderService inner,
    IValidator<CreateOrder> validator) : IOrderService
{
    public async Task<OrderDto> CreateAsync(CreateOrder cmd, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(cmd, ct);
        return await inner.CreateAsync(cmd, ct);
    }

    public Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
        => inner.GetByIdAsync(orderId, ct);
}
```

**Verifizieren:** Schreiben oder behalten Sie einen Test, der bestätigt, dass das übergreifende Concern weiterhin läuft, zum Beispiel dass ein ungültiges Kommando eine `ValidationException` wirft, bevor es die Datenbank berührt. Führen Sie `dotnet test` aus und bestätigen Sie, dass die Behavior-Tests bestehen.

5. **Ersetzen Sie das `INotification`-Fan-out.**

Das `Publish` von MediatR rief jeden `INotificationHandler<T>` auf. Ersetzen Sie es durch ein injiziertes `IEnumerable<T>` eines kleinen Handler-Interface, das Sie definieren, und einen schlanken Publisher.

```csharp
// .NET 11, C# 14 - BEFORE: INotification + handlers, AFTER: explicit fan-out
public interface IOrderPlacedHandler
{
    Task HandleAsync(OrderPlaced evt, CancellationToken ct);
}

public sealed class OrderEventPublisher(IEnumerable<IOrderPlacedHandler> handlers)
{
    public async Task PublishAsync(OrderPlaced evt, CancellationToken ct)
    {
        foreach (var handler in handlers)
            await handler.HandleAsync(evt, ct);
    }
}

// Registration - each handler registered against the interface
builder.Services.AddScoped<IOrderPlacedHandler, SendConfirmationEmail>();
builder.Services.AddScoped<IOrderPlacedHandler, UpdateInventory>();
builder.Services.AddScoped<OrderEventPublisher>();
```

Der Container übergibt Ihnen jeden registrierten Handler in `IEnumerable<IOrderPlacedHandler>`, sodass das Hinzufügen eines Handlers eine einzige Registrierungszeile ist, dieselbe Ergonomie, die MediatR Ihnen gab. Wenn Sie viele Event-Typen veröffentlichen, generieren Sie den Publisher mit einem generischen `IEventPublisher<T>` statt einem pro Event.

**Verifizieren:** Bestätigen Sie, dass das Veröffentlichen eines Events alle registrierten Handler aufruft. Ein Test mit zwei Fake-Handlern, die beide einen Aufruf protokollieren, genügt.

6. **Entfernen Sie das Paket und die letzten Referenzen.**

Sobald die Aufrufstellen weg sind, entfernen Sie die Abhängigkeit.

```bash
# .NET 11 - remove the package from every project that referenced it
dotnet remove package MediatR
grep -rn "MediatR" src/ || echo "clean"
```

**Verifizieren:** `grep -rn "MediatR" src/` gibt `clean` aus. Der Build hat kein ungelöstes `using MediatR;` und `dotnet build -c Release` gelingt ohne Warnungen über ein fehlendes Paket.

## Verifizierung: der Smoke-Test nach der Migration

Arbeiten Sie diese Liste von oben nach unten ab und überspringen Sie die Performance-Zeile nicht:

- `dotnet build -c Release` gelingt ohne Warnungen.
- `dotnet test` besteht mit null Fehlschlägen, einschließlich der Behavior- und Fan-out-Tests, die Sie in den Schritten 4 und 5 hinzugefügt haben.
- Die Anwendung startet und jeder zuvor per MediatR verteilte Endpunkt gibt dieselbe Antwort wie zuvor zurück. Eine fehlende Registrierung tritt nun hier zutage, beim Start.
- `grep -rn "MediatR" src/` gibt nichts zurück.
- Keine Lizenzwarnung erscheint in den Logs (die Lizenzprüfung von MediatR 13+ protokollierte eine Warnung bei einem nicht registrierten Schlüssel; sie sollte nun verschwunden sein).
- Der Kaltstart ist gleich oder besser. Wenn die Anwendung serverless ist, messen Sie die Startzeit vorher und nachher; das Entfernen des Assembly-Scans sollte keine Verschlechterung bringen.

## Rollback-Plan

Diese Migration ist pro Commit umkehrbar, aber mühsam im Ganzen rückgängig zu machen, also staffeln Sie sie. Halten Sie jeden der sechs Schritte als separaten Commit und migrieren Sie eine vertikale Scheibe nach der anderen (ein Service-Interface und seine Aufrufer) statt der gesamten Solution auf einmal. MediatR und einfache Services können während des Übergangs koexistieren: Lassen Sie `AddMediatR` für die nicht migrierten Handler registriert, während Sie den Rest umstellen. Wenn eine Scheibe sich falsch verhält, machen Sie die Commits dieser Scheibe rückgängig, und der Rest der Anwendung bleibt unberührt. Hier gibt es keine Daten- oder Schemaänderung, also ist der Rollback rein ein Code-Revert ohne rückgängig zu machende Migration.

## Stolperfallen, die wir trafen

**Die Reihenfolge von `IPipelineBehavior` bildet sich nicht sauber auf Decorators ab.** MediatR führt Behaviors in der Registrierungsreihenfolge um einen einzigen Handler aus. Scrutor-Decorators verschachteln sich in der Reihenfolge, in der Sie `Decorate` aufrufen, und der *zuletzt* registrierte Decorator ist der *äußerste* Wrapper. Wenn Sie die Reihenfolge falsch wählen, läuft Ihr Logging-Decorator innerhalb Ihres Validierungs-Decorators statt darum herum. Schreiben Sie einen Reihenfolgetest pro dekoriertem Interface.

**Ein `ISender` innerhalb eines Handlers, der einen anderen Handler aufruft, wird zu einem direkten Service-Aufruf, und das kann einen Zyklus offenlegen.** Die Indirektion von MediatR verbarg Handler-zu-Handler-Abhängigkeiten. Wenn `OrderService` `ICustomerService` injiziert und `CustomerService` `IOrderService` injiziert, wirft der Container beim Start mit einer zirkulären Abhängigkeit. Das ist die Migration, die ein Designproblem ans Licht bringt, das MediatR maskierte; brechen Sie den Zyklus, indem Sie die gemeinsame Logik in einen dritten Service extrahieren.

**Streaming-Anfragen brauchen `IAsyncEnumerable<T>`, nicht `Task<T>`.** Wenn Sie `IStreamRequest<T>` und `CreateStream` verwendet haben, gibt die Ersatzmethode `IAsyncEnumerable<T>` zurück und verwendet `yield return`. Kollabieren Sie sie nicht zu einem `Task<List<T>>`; das ändert die Streaming-Semantik und kann bei großen Ergebnissen den Speicher sprengen, dieselbe Falle, die in [Lesen einer großen CSV in .NET 11 ohne Speichermangel](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) beschrieben wird.

**Tests, die `ISender` mockten, bestehen stillschweigend gegen nichts.** Ein Test, der `sender.Send(...)` so einrichtete, dass er einen Wert zurückgibt, wird einen Compile-Fehler werfen, sobald `ISender` weg ist, was gut ist. Aber ein Test, der einen echten `IMediator` injizierte und das Verhalten darüber bestätigte, muss auf das konkrete Interface umgelenkt werden. Führen Sie die gesamte Suite erneut aus, vertrauen Sie nicht allein einem grünen Build.

Dies ist die Art von Abhängigkeitsrationalisierung, die sich auf dieselbe Weise auszahlt wie die Wahl des integrierten Serializers in [System.Text.Json vs Newtonsoft.Json in 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/): eine Drittanbieter-Bibliothek weniger auf dem heißen Pfad, eine Lizenzfrage weniger, und Code, durch den sich ein neuer Teamkollege navigieren kann, ohne zuerst eine Dispatch-Konvention zu lernen.

## Verwandt

- [MediatR vs einfache Service-Klassen in 2026: Sollte der Lizenzwechsel Sie bewegen?](/de/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Migration von Newtonsoft.Json zu System.Text.Json in einer großen Codebasis](/de/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Minimal APIs vs Controller in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Quellen

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - die Relizenzierung vom 2025-07-02, die v13.0-Grenze und das duale RPL-1.5 / kommerzielle Modell.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - die Community-Edition-Schwellen von $5,000,000 Umsatz und $10,000,000 Kapital und die nur protokollierende Lizenzprüfung.
- [LuckyPennySoftware/MediatR auf GitHub](https://github.com/LuckyPennySoftware/MediatR) - der aktuelle 14.x-Quellcode, die ersetzten `IPipelineBehavior`- und `INotification`-Verträge.
- [Scrutor auf GitHub](https://github.com/khellang/Scrutor) - die MIT-lizenzierten `Decorate`- und `Scan`-Erweiterungen, die zum Ersetzen von Behaviors und zur konventionsbasierten Registrierung von Services verwendet werden.
- [Dependency Injection in .NET - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection) - die Service-Lifetimes und die `IEnumerable<T>`-Auflösung, die für das Notification-Fan-out verwendet werden.
