---
title: "MediatR vs einfache Service-Klassen in 2026: Sollte Sie die Lizenzänderung umstimmen?"
description: "MediatR-Dispatch und Pipeline-Behaviors mit direkten Dienstaufrufen vergleichen: DI-Validierung, Lizenzkriterien und Leistungsmessung."
pubDate: 2026-05-23
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "mediatr"
  - "dependency-injection"
  - "architecture"
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/mediatr-vs-plain-service-classes-in-2026"
translatedBy: "claude"
translationDate: 2026-05-23
---

Direkte Dienste passen gut, wenn jede Anfrage ein eindeutiges Ziel hat. MediatR lohnt sich eher, wenn mehrere Anfragetypen dieselben Pipeline-Behaviors nutzen oder Benachrichtigungen an mehrere Empfänger senden. Prüfe die Lizenzbedingungen der verwendeten Version gesondert.

**Korrektur — 2. November 2026:** DI-Validierung und Lizenzvergleich korrigiert sowie unbelegte Zeit- und Allokationsangaben entfernt.

Die Beispiele zielen auf `net11.0` und zeigen die Verträge von MediatR 13/14. Die unten beschriebene DI-Prüfung lief mit .NET 10.

## Was sich im Juli 2025 tatsächlich geändert hat

MediatR 12.5.0 erschien unter Apache 2.0. Der Autor kündigte im Juli 2025 mit Version 13.0.0 RPL-1.5 und kommerzielle Optionen an. Frühere Versionen behalten ihre ursprünglichen Bedingungen.

Zu den [Community-Kriterien von Lucky Penny Software](https://luckypennysoftware.com/faq) gehören ein jährlicher Bruttoumsatz oder ein gemeinnütziges Budget unter 5 Millionen US-Dollar und höchstens 10 Millionen US-Dollar externes Kapital. Der Anbieter nennt weitere Bedingungen für staatliche oder staatsnahe Einrichtungen, Hochschulnutzung und Kundenaufträge. Prüfe die Kriterien für Organisation und Verwendungszweck.

## Die Feature-Matrix auf einen Blick

| Aspekt | MediatR 13+ | Einfache Service-Klassen |
| ------ | ----------- | ------------------------ |
| Request-Versand | Indirektion über `ISender.Send` | Direkter Methodenaufruf an einer injizierten Schnittstelle |
| Querschnittsbelange | `IPipelineBehavior<,>` als First-Class-Konstrukt | Decorator (Scrutor) oder explizite Aufrufe |
| DI-Validierung | Abhängig von Registrierungen und Provideroptionen | Abhängig von Registrierungen und Provideroptionen |
| Benachrichtigungen / Fan-out | Integriertes `INotification`-Publish | Handgeschriebene Handler-Liste |

Der zentrale Entwurfsunterschied liegt in der Pipeline: Viele Anfragen können Validierung, Logging, Transaktionen oder Caching gemeinsam nutzen.

## Wie MediatR aussieht und das einfache Äquivalent

Dies ist die kanonische MediatR-Form: ein Request, ein Handler und ein Aufrufer, der über `ISender` versendet.

```csharp
// .NET 11, C# 14, MediatR 13+ - request + handler
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

// In an endpoint:
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);
```

Die einfache Version fasst Request und Handler in einer einzigen Methode eines injizierten Service zusammen. Der Aufrufer hängt direkt von der Schnittstelle ab.

```csharp
// .NET 11, C# 14 - plain service class, no MediatR
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

// In an endpoint:
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

Bei einem Interface-Aufruf führt der Sprung zur Definition zur Interface-Methode. Die IDE kann deren Implementierungen anzeigen. Bei `Send` suche nach dem Handler des Anfragetyps.

`AddScoped` registriert einen Dienst. Beim integrierten Provider kann `ValidateOnBuild` eine fehlende Konstruktorabhängigkeit eines registrierten Dienstes beim Erstellen des Hosts erkennen. Ohne Validierung kann der Build gelingen und erst die Dienstauflösung scheitern. Die [Standardwerte von ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild) hängen von der Umgebung ab. `ValidateScopes` prüft separat die Lebensdauern.

Für diese Korrektur wurde unter .NET 10 ein Scoped-Dienst mit fehlender Konstruktorabhängigkeit registriert. Mit den Standardwerten scheiterte der Development-Host bei `Build()`, der Production-Host erst bei der Auflösung. Eine explizite Einstellung von `ValidateOnBuild` änderte die Fehlerphase.

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicitly register the scoped service
builder.Services.AddScoped<IOrderService, OrderService>();
```

## Das Pipeline Behavior und wie man ohne es lebt

Hier verdient MediatR seinen Platz. Ein Pipeline Behavior umschließt jeden Request, was Ihnen genau einen Ort gibt, um Validierung, Logging, Zeitmessung oder eine Transaktion hinzuzufügen.

```csharp
// .NET 11, C# 14, MediatR 13+ - cross-cutting validation for ALL requests
using MediatR;

public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        foreach (var validator in validators)
            await validator.ValidateAndThrowAsync(request, ct);
        return await next(ct);
    }
}
```

Einmal registriert, läuft dieses Behavior vor jedem Handler. Dies durch kopierte und eingefügte Validierungsaufrufe in jedem einfachen Service zu ersetzen, wäre eine Regression, und es ist das beste Argument, einen Mediator zu behalten. Aber Sie können dieselbe "alles umschließen"-Eigenschaft in einfachem DI mit dem Decorator-Muster erhalten, indem Sie Scrutor (MIT-lizenziert) verwenden, um einen Decorator um eine Schnittstelle zu registrieren:

```csharp
// .NET 11, C# 14, Scrutor 6.x - a decorator gives you the same cross-cutting hook
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

// Registration: decorate the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

Der Kompromiss ist ehrlich: MediatRs Behavior ist generisch über jeden Request mit einer einzigen Registrierung, während ein Decorator pro Schnittstelle gilt. Wenn Sie ein oder zwei Querschnittsbelange und eine Handvoll Service-Schnittstellen haben, gewinnen Decorator an Klarheit. Wenn Sie zehn Behaviors haben, die einheitlich auf zweihundert Request-Typen anzuwenden sind, ist MediatRs generische Pipeline tatsächlich weniger Code, und das ist das Szenario, in dem Bleiben (und Zahlen oder die Qualifikation für Community) vertretbar ist. Für Belange auf Request-Ebene, die in Wirklichkeit HTTP-Belange sind, beachten Sie, dass ein Teil dessen, was Leute in Behaviors stecken, eher in Middleware oder Filter gehört, dieselbe Fläche, die [einen globalen Ausnahmefilter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) abdeckt.

## Was der Versand tatsächlich kostet

`Send` löst einen Handler auf und durchläuft die konfigurierte Pipeline. Ein direkter Aufruf verwendet den injizierten Dienst. Für diese Pfade gibt es hier keinen vergleichbaren Benchmark, daher werden keine Zeiten oder Allokationen pro Aufruf angegeben.

Wenn Dispatch-Kosten die Entscheidung beeinflussen, miss beide Pfade mit gleicher Handler-Arbeit, Lebensdauer, Laufzeit und Behavior-Kette. Miss Registrierung und Kaltstart getrennt. Explizite Registrierung kann den Handler-Scan vermeiden. Prüfe Trimming und Native AOT mit der veröffentlichten Anwendung.

## Das Detail, das für Sie entscheidet

Einige Einschränkungen klären das, bevor architektonischer Geschmack ins Spiel kommt.

Eine auf 12.5.0 festgelegte Anwendung bleibt bei dieser Version und deren Bedingungen. Prüfe vor einer dauerhaften Festlegung den Wartungsbedarf.

**Wenn Sie nur jemals `Send` aufrufen, brauchen Sie keinen Mediator.** Der ehrliche Test: Öffnen Sie Ihre Solution und suchen Sie nach `IPipelineBehavior` und `INotification`. Wenn es null Behaviors gibt und Sie keine Benachrichtigungen veröffentlichen, fungiert MediatR als Indirektionsschicht über Methodenaufrufen, und es zu entfernen ist ein mechanisches Refactoring, das den Code navigierbarer macht, eine Abhängigkeit entfernt und die Lizenzfrage in einem Zug löscht. Das ist derselbe Instinkt zur Bibliotheksrationalisierung, der dahintersteckt, die mitgelieferte Option in [System.Text.Json vs Newtonsoft.Json in 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) zu wählen.

## Die Entscheidung, in einer Zeile

Für den direkten Aufruf eines Dienstes bietet sich explizite Injektion an. Behalte MediatR, wenn mehrere Anfragetypen von der gemeinsamen Pipeline oder Benachrichtigungen profitieren. Nach der Entscheidung für Dienste hilft die [Migrationsanleitung](/de/2026/05/migrate-from-mediatr-to-plain-dependency-injection/).

## Verwandt

- [Minimal APIs vs controllers in ASP.NET Core 11](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json in 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Quellen

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - die Ankündigung der Veröffentlichung vom 2025-07-02, die v13.0-Grenze und das duale RPL-1.5-/kommerzielle Modell.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - die Community-Schwellen von 5.000.000 Umsatz und 10.000.000 Kapital, die Entwicklerzählung nach "programmatischem Zugriff" und die nur protokollierende Lizenzprüfung.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - Bestätigung, dass alte Versionen unter ihrer ursprünglichen Open-Source-Lizenz bleiben.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - die erste dual lizenzierte Version.
- [Scrutor auf GitHub](https://github.com/khellang/Scrutor) - die MIT-lizenzierte `Decorate`-Erweiterung, die verwendet wird, um Pipeline Behaviors durch Decorator zu ersetzen.
