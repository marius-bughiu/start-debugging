---
title: "MediatR vs einfache Service-Klassen in 2026: Sollte Sie die Lizenzänderung umstimmen?"
description: "Für neuen Code sind einfache Service-Klassen die bessere Standardwahl. Die MediatR-Lizenzänderung vom Juli 2025 ist nur relevant, wenn Sie über der Community-Schwelle von 5 Mio. USD liegen oder das RPL-1.5-Copyleft ablehnen. Behalten Sie MediatR, wenn Pipeline Behaviors tragend sind."
pubDate: 2026-05-23
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

Die Kurzfassung: Für neuen .NET-11-Code in 2026 sollten Sie standardmäßig **einfache Service-Klassen** verwenden und nur dann zu MediatR greifen, wenn Sie sich tatsächlich auf dessen Pipeline Behaviors stützen. Die Lizenzänderung vom Juli 2025 ist ein realer Grund zur Neubewertung, aber nicht die Klippe, als die manche sie dargestellt haben. Wenn Ihr Unternehmen unter 5.000.000 USD jährlichem Bruttoumsatz liegt, können Sie die aktuelle MediatR-Version unter der Community-Edition weiterhin kostenlos nutzen, sodass die Lizenzfrage nur für größere Teams eine Entscheidung erzwingt oder für jeden, der das RPL-1.5-Copyleft der kostenlosen Open-Source-Lizenz nicht akzeptieren möchte. Die technische Frage (brauchen Sie überhaupt einen Mediator?) ist diejenige, die die Wahl tatsächlich treiben sollte, und beim Großteil des Request-Versands ist es die Indirektion, nicht die Bibliothek, die Sie entfernen können.

Im Text referenzierte Versionen: MediatR 12.5.0 ist die letzte Version unter der reinen Apache-2.0-Lizenz; MediatR 13.0 (veröffentlicht am 2025-07-02) und die spätere 14.x-Linie werden unter einem dualen Modell aus Reciprocal Public License 1.5 / kommerzieller Lizenz von Lucky Penny Software ausgeliefert. Der Code zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET-11-SDK und C# 14.

## Was sich im Juli 2025 tatsächlich geändert hat

MediatR und AutoMapper wurden jahrelang von Jimmy Bogard unter einer permissiven Open-Source-Lizenz gepflegt. Am 2025-07-02 übertrug er beide an ein neues Unternehmen, Lucky Penny Software, und änderte das Lizenzmodell. Die Mechanismen, die für Ihre Entscheidung wichtig sind:

- **Alte Versionen bleiben für immer kostenlos.** MediatR 12.x und früher bleiben unter Apache 2.0 (MIT für einige ältere Artefakte) und werden nicht rückwirkend neu lizenziert. Sie können `12.5.0` festpinnen und niemals zahlen. Der Haken ist, dass Sie für diese Linie keine Sicherheitsupdates, keine Fixes und keinen Support erhalten.
- **Neue Versionen sind dual lizenziert.** MediatR 13.0 und später werden unter der Reciprocal Public License 1.5 (RPL-1.5) für Open-Source-Nutzung oder einer kostenpflichtigen kommerziellen Lizenz angeboten.
- **Es gibt eine kostenlose Community-Edition.** Unternehmen und Einzelpersonen unter 5.000.000 USD jährlichem Bruttoumsatz (und die nicht mehr als 10.000.000 USD an externem Kapital erhalten haben), gemeinnützige Organisationen unter demselben Budget, Bildungsnutzung und Nicht-Produktionsumgebungen qualifizieren sich alle dafür, die aktuelle MediatR-Version unter der Community-Stufe der kommerziellen Vereinbarung kostenlos zu nutzen.
- **Die kostenpflichtigen Stufen richten sich nach der Teamgröße.** Standard (1-10 Entwickler), Professional (11-50) und Enterprise (unbegrenzt), monatlich oder jährlich abgerechnet, wobei nur Entwickler mit "programmatischem Zugriff" gezählt werden, die Code schreiben oder kompilieren, der MediatR aufruft.
- **Die Lizenzprüfung protokolliert nur.** Ein abgelaufener oder fehlender Schlüssel erzeugt Log-Warnungen, keinen Laufzeitfehler. Kein Sperren von Funktionen, keine verringerte Leistung, kein Lizenzserver und kein Netzwerkaufruf.

Die praktische Verzweigung lautet also so: Ein kleiner Betrieb unter 5 Mio.? Sie können kostenlos auf der aktuellen MediatR-Version bleiben, und die einzige Reibung ist die Warnung im Log, bis Sie einen Community-Schlüssel registrieren. Größer oder gut finanziert? Sie zahlen entweder, akzeptieren die reziproken Verpflichtungen der RPL-1.5 oder gehen. Diese dritte Gruppe ist genau diejenige, die einen Vergleich "vs einfache Service-Klassen" lesen sollte.

## Die Feature-Matrix auf einen Blick

| Aspekt | MediatR 13+ | Einfache Service-Klassen |
| ------ | ----------- | ------------------------ |
| Request-Versand | Indirektion über `ISender.Send` | Direkter Methodenaufruf an einer injizierten Schnittstelle |
| Querschnittsbelange | `IPipelineBehavior<,>` als First-Class-Konstrukt | Decorator (Scrutor) oder explizite Aufrufe |
| Gehe-zu-Definition vom Aufrufer | Landet bei `Send`, nicht beim Handler | Landet bei der Implementierung |
| Sicherheit der Verdrahtung zur Compile-Zeit | Auflösung zur Laufzeit, kann beim ersten Aufruf fehlschlagen | Konstruktorinjektion, schlägt beim Start fehl |
| Benachrichtigungen / Fan-out | Integriertes `INotification`-Publish | Handgeschriebene Handler-Liste |
| Startkosten | Assembly-Scan zum Registrieren der Handler | Keine über die normale DI-Registrierung hinaus |
| Overhead pro Aufruf | Wrapper-Allokation + Dictionary-Lookup + virtueller Versand | Nahezu null, der JIT kann devirtualisieren |
| Native AOT / Trimming | Erfordert Sorgfalt, reflexionsbasierte Registrierung | Sauber |
| Lizenz (über 5 Mio. Umsatz) | Kommerzieller Kauf oder RPL-1.5 | Keine, Ihr eigener Code |
| Neuer Code in 2026 | Nur wenn Behaviors tragend sind | Die Standardwahl |

Die Zeile, die die meisten Diskussionen entscheidet, ist "Querschnittsbelange". Fast alles andere in dieser Tabelle spricht für einfache Service-Klassen. Der echte, schwer zu ersetzende Wert von MediatR ist die Pipeline: ein einziger Ort, um jeden Request mit Validierung, Logging, Transaktionen und Cache zu umschließen. Wenn Sie diese Pipeline nicht nutzen, zahlen Sie Indirektions- und Lizenzkosten für einen aufgewerteten Service-Locator.

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

Die einfache Version ist kürzer, und entscheidend ist: Gehe-zu-Definition auf `orders.GetByIdAsync` bringt Sie zu der Methode, die ausgeführt wird. Bei `sender.Send(new GetOrderById(id))` landen Sie bei MediatRs `Send` und navigieren zum Handler durch Raten oder über einen Umweg "Implementierungen suchen". In einem kleinen Team ist dieser Unterschied gering. In einer großen Codebasis mit Hunderten von Handlern ist der Verlust der direkten Navigierbarkeit eine reale, tägliche Steuer, die das MediatR-Modell im Tausch dafür auferlegt, den Aufrufer vom Handler-Typ zu entkoppeln. Ob diese Entkopplung Ihnen etwas bringt, hängt davon ab, ob jemals jemand einen Handler austauscht, ohne den Aufrufer anzufassen, was in der Praxis selten ist.

Auch die Registrierung lohnt einen Vergleich. MediatR scannt beim Start Assemblies; einfache Service-Klassen werden explizit registriert, und Sie erhalten beim Start einen Fehler (nicht bei der ersten Anfrage), wenn Sie eine vergessen, was direkt mit der Art von Fehlern hinter [Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) zusammenhängt.

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicit, trim-friendly, fails fast at startup if a dep is missing
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

Der Kompromiss ist ehrlich: MediatRs Behavior ist generisch über jeden Request mit einer einzigen Registrierung, während ein Decorator pro Schnittstelle gilt. Wenn Sie ein oder zwei Querschnittsbelange und eine Handvoll Service-Schnittstellen haben, gewinnen Decorator an Klarheit. Wenn Sie zehn Behaviors haben, die einheitlich auf zweihundert Request-Typen anzuwenden sind, ist MediatRs generische Pipeline tatsächlich weniger Code, und das ist das Szenario, in dem Bleiben (und Zahlen oder die Qualifikation für Community) vertretbar ist. Für Belange auf Request-Ebene, die in Wirklichkeit HTTP-Belange sind, beachten Sie, dass ein Teil dessen, was Leute in Behaviors stecken, eher in Middleware oder Filter gehört, dieselbe Fläche, die [einen globalen Ausnahmefilter in ASP.NET Core 11 hinzufügen](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) abdeckt.

## Was der Versand tatsächlich kostet

Leistung ist das schwächste Argument in beide Richtungen, und Sie sollten nicht allein danach entscheiden, aber es lohnt sich zu wissen, wo die Kosten liegen, damit niemand schwammige Behauptungen aufstellt. Ein einfacher Schnittstellenaufruf ist ein einziger virtueller Versand, den der JIT oft devirtualisieren und inlinen kann; er allokiert nichts und kostet in der Größenordnung einer Nanosekunde. Ein MediatR-`Send` leistet mehr Arbeit pro Aufruf: Es schlägt den Request-Typ in einem Handler-Cache nach, konstruiert oder ruft einen `RequestHandlerWrapper` ab, durchläuft die Behavior-Kette über Delegates und löst den Handler aus dem Container auf. Das liegt in der Größenordnung von Dutzenden Nanosekunden plus einer kleinen Allokation pro Send, bevor der Rumpf Ihres Handlers ausgeführt wird.

| Aspekt | MediatR `Send` | Einfacher Schnittstellenaufruf |
| ------ | -------------- | ------------------------------ |
| Typ-zu-Handler-Auflösung | Dictionary-Lookup pro Aufruf | Keine, bei Injektion gebunden |
| Wrapper-/Delegate-Kette | Pro Send allokiert | Keine |
| Devirtualisierung durch den JIT | Nein | Oft ja |
| Assembly-Scan beim Start | Ja, wächst mit der Anzahl der Handler | Keiner |
| Größenordnung pro Aufruf | Dutzende ns + kleine Allokation | ~1 ns, null Allokation |

Die methodische Ehrlichkeit hier: Gegen einen Handler, der eine Datenbank oder das Netzwerk berührt, sind Dutzende Nanosekunden unsichtbar, und Sie sollten Ihre eigenen Objektformen mit BenchmarkDotNet messen, statt einer generischen Zahl zu vertrauen. Die Kosten, die in der Praxis tatsächlich auftauchen, sind der Start. Assemblies zu scannen, um Hunderte von Handlern zu registrieren, fügt dem Kaltstart messbare Millisekunden hinzu, was für Serverless wichtig ist und genau das ist, womit Sie beim [Reduzieren der Kaltstartzeit einer .NET-11-AWS-Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) kämpfen. Die explizite, einfache Registrierung umgeht das vollständig und ist freundlicher zu Trimming und Native AOT, weil es keine reflexive Erkennung gibt, die trim-sicher gehalten werden muss.

## Das Detail, das für Sie entscheidet

Einige Einschränkungen klären das, bevor architektonischer Geschmack ins Spiel kommt.

**Die RPL-1.5 ist die eigentliche entscheidende Kraft, nicht der Preis.** Die kostenlose Open-Source-Option bei MediatR 13+ ist die Reciprocal Public License 1.5, die reziproke Copyleft-Verpflichtungen trägt: Sie ist darauf ausgelegt, die SaaS-Lücke zu schließen, sodass das Bereitstellen eines Netzwerkdienstes, der auf RPL-lizenziertem Code aufbaut, Sie verpflichten kann, Ihren Quellcode verfügbar zu machen. Wenn Sie Closed-Source-Software kommerziell ausliefern und über der Community-Schwelle liegen, ist die kostenlose OSS-Lizenz für Sie nicht wirklich nutzbar, und "MediatR ist immer noch Open Source" ist in Ihrem Fall irreführend. Sie kaufen entweder die kommerzielle Lizenz oder Sie gehen. Für einen dünnen Dispatcher, den Sie ohnehin nicht wirklich genutzt haben, ist das Gehen leicht.

**Die Grenze von 5 Mio. Umsatz und 10 Mio. Kapital ist großzügig.** Die meisten kleinen Produktteams, Beratungen und Startups liegen darunter und können die neueste MediatR-Version unter der Community-Edition weiterhin kostenlos nutzen. Wenn das auf Sie zutrifft, ist die Lizenz kein Grund, etwas herauszureißen; registrieren Sie einen Community-Schlüssel, schalten Sie die Warnung stumm und machen Sie weiter. Einen Sprint damit zu verbringen, MediatR zu entfernen, um eine Rechnung zu vermeiden, die Sie nicht schulden, ist der falsche Tausch.

**12.5.0 festzupinnen ist eine reale Option mit realen Kosten.** Apache 2.0 auf der letzten kostenlosen Version läuft nicht ab. Aber Sie frieren auf einer Version ein, die keine Sicherheitspatches erhält, und tragen das Wartungsrisiko selbst. Das ist für eine stabile interne App in Ordnung und für alles, was dem Internet ausgesetzt ist, gefährlich.

**Wenn Sie nur jemals `Send` aufrufen, brauchen Sie keinen Mediator.** Der ehrliche Test: Öffnen Sie Ihre Solution und suchen Sie nach `IPipelineBehavior` und `INotification`. Wenn es null Behaviors gibt und Sie keine Benachrichtigungen veröffentlichen, fungiert MediatR als Indirektionsschicht über Methodenaufrufen, und es zu entfernen ist ein mechanisches Refactoring, das den Code navigierbarer macht, eine Abhängigkeit entfernt und die Lizenzfrage in einem Zug löscht. Das ist derselbe Instinkt zur Bibliotheksrationalisierung, der dahintersteckt, die mitgelieferte Option in [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) zu wählen.

## Die Entscheidung, in einer Zeile

Für neuen .NET-11-Code in 2026 schreiben Sie einfache Service-Klassen und injizieren die Schnittstellen direkt: Sie erhalten Gehe-zu-Definition, eine Start-Verdrahtung, die schnell fehlschlägt, keinen Overhead pro Aufruf, Trimming-Freundlichkeit und null Lizenzrisiko. Behalten Sie MediatR nur, wenn seine Pipeline Behaviors echte, einheitliche Arbeit über viele Request-Typen leisten, und entscheiden Sie in diesem Fall bewusst: Bleiben Sie kostenlos unter der Community-Edition, wenn Sie unter 5 Mio. liegen, zahlen Sie, wenn Sie darüber liegen und die Pipeline die Rechnung rechtfertigt, und pinnen Sie 12.5.0 nur als Übergangslösung fest. Der Fehler besteht darin, "MediatR ist kommerziell geworden" entweder als Nicht-Ereignis oder als Fünf-Alarm-Feuer zu behandeln. Es ist keines von beidem. Es ist ein Anstoß, sich zu fragen, ob Sie den Mediator überhaupt gebraucht haben, und für den Großteil des Request-Versand-Codes war die Antwort schon immer nein.

## Verwandt

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Quellen

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - die Ankündigung der Veröffentlichung vom 2025-07-02, die v13.0-Grenze und das duale RPL-1.5-/kommerzielle Modell.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - die Community-Schwellen von 5.000.000 Umsatz und 10.000.000 Kapital, die Entwicklerzählung nach "programmatischem Zugriff" und die nur protokollierende Lizenzprüfung.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - Bestätigung, dass alte Versionen unter ihrer ursprünglichen Open-Source-Lizenz bleiben.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - die erste dual lizenzierte Version.
- [Scrutor auf GitHub](https://github.com/khellang/Scrutor) - die MIT-lizenzierte `Decorate`-Erweiterung, die verwendet wird, um Pipeline Behaviors durch Decorator zu ersetzen.
</content>
