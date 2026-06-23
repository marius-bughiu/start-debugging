---
title: "Keyed Services in der Dependency Injection von .NET 11 registrieren und auflösen"
description: "Registrieren Sie mehrere Implementierungen desselben Diensttyps unter einem Schlüssel mit AddKeyedSingleton/Scoped/Transient und lösen Sie sie dann mit [FromKeyedServices], GetRequiredKeyedService oder KeyedService.AnyKey auf. Die Registrierungen mit und ohne Schlüssel sind getrennte Tabellen, und genau das ist die Stolperfalle für fast alle."
pubDate: 2026-06-23
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dependency-injection"
  - "aspnetcore"
lang: "de"
translationOf: "2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection"
translatedBy: "claude"
translationDate: 2026-06-23
---

Der in .NET integrierte Dependency-Injection-Container kann mehrere Implementierungen desselben Diensttyps halten und sie anhand eines Schlüssels unterscheiden. Sie registrieren jede mit `AddKeyedSingleton`, `AddKeyedScoped` oder `AddKeyedTransient` und übergeben einen Schlüssel vom Typ `object` (typisch ist eine Zeichenkette oder ein Enum), und Sie holen eine bestimmte mit `[FromKeyedServices("key")]` an einem Konstruktor- oder Handler-Parameter zurück oder mit `provider.GetRequiredKeyedService<T>("key")`. Die eine Tatsache, über die alle stolpern: Registrierungen mit und ohne Schlüssel liegen in zwei getrennten Tabellen. Ein einfaches `GetService<T>()` wird eine Registrierung mit Schlüssel nie sehen, und `[FromKeyedServices]` wird eine ohne Schlüssel nie sehen. Diese Anleitung ist gegen .NET 11 geschrieben (zum Zeitpunkt des Schreibens Preview 5, allgemeine Verfügbarkeit für November 2026 geplant) sowie `Microsoft.Extensions.DependencyInjection` 11.0.0. Keyed Services kamen in .NET 8, und die API ist seitdem stabil, daher funktionieren alle Muster hier auch unter .NET 8 und .NET 10 unverändert.

## Warum man einem Dienst einen Schlüssel gibt, statt eine neue Schnittstelle zu erstellen

Der alte Weg, zwei Implementierungen von `IPaymentGateway` zu registrieren, war, zwei Interfaces (`IStripeGateway`, `IPayPalGateway`) zu erfinden oder einen Factory-Delegate zu registrieren, der anhand einer Zeichenkette unterschied. Beide lassen den Auswahlmechanismus in Ihr Typsystem durchsickern. Keyed Services lassen das Interface im Singular und verschieben den Diskriminator in die Registrierung, also genau dorthin, wo eine zur Bereitstellungs- oder Konfigurationszeit getroffene Wahl hingehört.

Die kanonischen Fälle:

- **Mehrere Anbieter hinter einem Vertrag.** Zwei Zahlungs-Gateways, drei Benachrichtigungskanäle, ein primärer und ein Fallback-HTTP-Client, jeweils unter einem Schlüssel registriert und je Aufrufstelle ausgewählt.
- **Benannte Caches oder Verbindungen.** Ein kurzlebiger und ein langlebiger Cache, beide in der Form von `IMemoryCache`, mit Schlüssel `"short"` und `"long"`.
- **Strategie-Suche zur Laufzeit.** Ein Dictionary von Strategien, bei dem der Schlüssel aus einer Anfrage berechnet wird, aufgelöst über `IKeyedServiceProvider` statt über ein handgeschriebenes `switch`.

Wenn Sie nur jemals eine Implementierung haben, greifen Sie nicht zu einem Schlüssel. Die Registrierung mit Schlüssel fügt einen Diskriminator hinzu, den Sie dann zwischen der Registrierungsstelle und jeder Auflösungsstelle synchron halten müssen. Verwenden Sie sie, wenn die Vielfalt real ist.

## Keyed Services registrieren

Jede Registrierungsmethode ohne Schlüssel hat ein Pendant mit Schlüssel, das einen `serviceKey` als erstes Argument nimmt. Hier ist die gesamte Oberfläche in einem Block.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

// Two implementations of the same interface, told apart by a string key.
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");

// Lifetimes work exactly as their non-keyed counterparts.
builder.Services.AddKeyedScoped<IReportBuilder, PdfReportBuilder>("pdf");
builder.Services.AddKeyedTransient<IReportBuilder, CsvReportBuilder>("csv");

// A factory overload gives you the key and the provider, useful when the
// implementation needs to read its own key or build from config.
builder.Services.AddKeyedSingleton<IClock>("utc", (sp, key) => new SystemClock(DateTimeKind.Utc));

var app = builder.Build();
```

Der Schlüssel ist ein `object`, verglichen mit `Equals`. Zeichenketten sind die übliche Wahl, weil sie einen Umlauf durch `appsettings.json` überstehen, aber ein Enum ist sauberer, wenn die Menge geschlossen und zur Kompilierzeit bekannt ist:

```csharp
// .NET 11, C# 14 - enum keys avoid stringly-typed lookups
public enum Channel { Email, Sms, Push }

builder.Services.AddKeyedScoped<INotifier, EmailNotifier>(Channel.Email);
builder.Services.AddKeyedScoped<INotifier, SmsNotifier>(Channel.Sms);
builder.Services.AddKeyedScoped<INotifier, PushNotifier>(Channel.Push);
```

Sie können denselben Implementierungstyp unter mehreren Schlüsseln registrieren, und Sie können mehr als eine Implementierung unter **demselben** Schlüssel registrieren. Der zweite Fall wird zu einer `IEnumerable<T>`-Auflösung, die weiter unten behandelt wird.

## Einen Keyed Service auf drei Arten auflösen

### Konstruktorinjektion mit `[FromKeyedServices]`

Das Attribut liegt in `Microsoft.Extensions.DependencyInjection` und markiert einen einzelnen Konstruktorparameter, damit der Container ihn aus der Tabelle mit Schlüssel auflöst. Dies ist die Form, die Sie in gewöhnlichen Diensten und Controllern wollen, weil sie den Konsumenten frei von jeder Referenz auf `IServiceProvider` hält.

```csharp
// .NET 11, C# 14
public sealed class CheckoutService(
    [FromKeyedServices("stripe")] IPaymentGateway gateway)
{
    public Task<string> ChargeAsync(decimal amount) => gateway.ChargeAsync(amount);
}
```

Dasselbe Attribut funktioniert an einem Handler-Parameter einer Minimal API, was die sauberste Art ist, eine Abhängigkeit mit Schlüssel an einen Endpunkt zu binden:

```csharp
// .NET 11, C# 14 - keyed dependency straight into a minimal API handler
app.MapPost("/charge/{provider}",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));
```

Es funktioniert auch an einem Action-Parameter eines MVC-Controllers und an einem Konstruktorparameter eines Controllers, in beiden Fällen ohne zusätzliche Registrierung.

### Imperative Auflösung mit `GetRequiredKeyedService`

Wenn der Schlüssel erst zur Laufzeit bekannt ist (aus einer Anfrage berechnet, aus der Konfiguration gelesen), können Sie kein Attribut zur Kompilierzeit verwenden. Injizieren Sie `IServiceProvider` und rufen Sie die Erweiterungsmethoden mit Schlüssel auf. Der von `Build()` erzeugte Provider implementiert `IKeyedServiceProvider`, daher funktionieren diese immer gegen den Standardcontainer.

```csharp
// .NET 11, C# 14 - the key is decided at runtime
public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string providerKey, decimal amount)
    {
        // Throws InvalidOperationException if nothing is registered under the key.
        var gateway = services.GetRequiredKeyedService<IPaymentGateway>(providerKey);
        return gateway.ChargeAsync(amount);
    }
}
```

Verwenden Sie `GetKeyedService<T>(key)` (ohne "Required"), wenn eine fehlende Registrierung ein normales, nicht außergewöhnliches Ergebnis ist; es gibt `null` zurück, statt zu werfen. Lösen Sie innerhalb eines scoped Konsumenten aus dem scoped Provider auf, damit die scoped Instanz mit Schlüssel korrekt gescoped wird. Wenn Sie innerhalb eines Singletons wie eines `BackgroundService` zu einem Scope greifen, gilt dieselbe `IServiceScopeFactory`-Disziplin wie für jeden [scoped Service innerhalb eines BackgroundService](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): die Tatsache, dass die Registrierung einen Schlüssel hat, ändert die Lebensdauerregeln nicht.

### Alle Implementierungen unter einem Schlüssel auflösen

Registrieren Sie mehr als eine Implementierung unter demselben Schlüssel und lösen Sie sie als Menge auf:

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IValidationRule, NotEmptyRule>("order");
builder.Services.AddKeyedSingleton<IValidationRule, PositiveAmountRule>("order");

public sealed class OrderValidator(
    [FromKeyedServices("order")] IEnumerable<IValidationRule> rules)
{
    public bool IsValid(Order o) => rules.All(r => r.Check(o));
}
```

`GetKeyedServices<IValidationRule>("order")` ist das imperative Äquivalent und gibt beide Implementierungen in Registrierungsreihenfolge zurück.

## Jeden Schlüssel treffen mit `KeyedService.AnyKey`

Manchmal wollen Sie eine Registrierung, die für *jeden* Schlüssel antwortet, wobei die Implementierung den Schlüssel liest, unter dem sie aufgelöst wurde. Dafür ist `KeyedService.AnyKey` da. Kombinieren Sie es mit einem `[ServiceKey]`-Parameter, damit die Implementierung den tatsächlichen Schlüssel zur Konstruktionszeit erhält.

```csharp
// .NET 11, C# 14 - one registration that serves any key
builder.Services.AddKeyedSingleton<ITenantStore>(
    KeyedService.AnyKey,
    (sp, key) => new TenantStore((string)key!));

public sealed class TenantStore : ITenantStore
{
    public TenantStore(string tenantId) => TenantId = tenantId;
    public string TenantId { get; }
}

// A consumer can ask for any tenant; the key flows into the factory.
var acme = app.Services.GetRequiredKeyedService<ITenantStore>("acme");
var globex = app.Services.GetRequiredKeyedService<ITenantStore>("globex");
```

Das `[ServiceKey]`-Attribut an einem Konstruktorparameter funktioniert auch ohne die Factory-Überladung. Der Container injiziert den Schlüssel, der zum Auflösen der Instanz verwendet wurde:

```csharp
// .NET 11, C# 14 - the implementation discovers its own key
public sealed class TenantStore(
    [ServiceKey] string tenantId,
    AppDbContext db) : ITenantStore
{
    public string TenantId => tenantId;
}

builder.Services.AddKeyedScoped<ITenantStore, TenantStore>(KeyedService.AnyKey);
```

Zwei Regeln gelten für `AnyKey`. Erstens: eine Registrierung mit exaktem Schlüssel gewinnt gegen die `AnyKey`-Registrierung, wenn beide existieren. Zweitens: Sie können nicht mit `KeyedService.AnyKey` als Schlüssel *auflösen*; es ist ein Sentinel nur auf der Registrierungsseite. Der Aufruf `GetRequiredKeyedService<T>(KeyedService.AnyKey)` wirft.

## Die Trennung, die am meisten Verwirrung stiftet

Registrierungen mit und ohne Schlüssel sind zwei getrennte Tabellen im Container. Diese eine Tatsache erklärt fast jeden Fehlerbericht der Art "aber ich habe ihn doch registriert":

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");

var sp = builder.Services.BuildServiceProvider();

sp.GetService<IPaymentGateway>();                 // null - no NON-keyed registration
sp.GetKeyedService<IPaymentGateway>("stripe");    // the StripeGateway
sp.GetKeyedService<IPaymentGateway>("paypal");    // null - nothing under that key
```

Ein einfacher Konstruktorparameter `IPaymentGateway gateway` (ohne Attribut) löst nur aus der Tabelle ohne Schlüssel auf und findet keine Registrierung mit Schlüssel. Wenn ein Dienst auf beide Arten erreichbar sein soll, registrieren Sie ihn zweimal, einmal mit Schlüssel und einmal ohne. Die umgekehrte Falle ist ebenso häufig: `[FromKeyedServices("stripe")]` gegen einen mit einfachem `AddSingleton` registrierten Dienst löst zu nichts auf, weil das Attribut nur die Tabelle mit Schlüssel liest.

Diese Trennung ist auch der Grund, warum `GetServices<T>()` (das Enumerable ohne Schlüssel) die Registrierungen mit Schlüssel nicht einschließt. Wenn Sie sich darauf verlassen, "alle Implementierungen" aufzuzählen, entscheiden Sie im Voraus, ob sie einen Schlüssel haben oder nicht, und bleiben Sie konsistent.

## Details, die man vor dem Ausliefern kennen sollte

**`ActivatorUtilities.CreateInstance` berücksichtigt `[FromKeyedServices]`, aber nur für die Typen, die es aktiviert.** Ein vom Container (oder von `ActivatorUtilities`) erstellter Typ bekommt seine Parameter mit Schlüssel gefüllt. Ein Typ, den Sie selbst mit `new` erzeugen, bekommt nichts injiziert, weder mit noch ohne Schlüssel. Das ist wichtig für Factory-Code und für alles außerhalb des DI-Graphen.

**Das `Equals` und das `GetHashCode` des Schlüssels müssen stabil sein.** Zeichenketten und Enums sind in Ordnung. Ein veränderlicher Referenztyp als Schlüssel oder einer mit wertbasierter Gleichheit, die sich mit der Zeit ändert, schlägt stillschweigend beim Treffen fehl. Bevorzugen Sie unveränderliche Schlüssel.

**Die Injektion mit `ServiceKey` erfordert den richtigen Typ.** Wenn Sie unter einem `string`-Schlüssel registrieren und `[ServiceKey] int id` deklarieren, wirft die Konstruktion zur Auflösungszeit. Halten Sie den deklarierten Parametertyp zuweisbar vom Schlüssel, mit dem Sie registriert haben.

**Die Validierung läuft pro Registrierung, nicht pro Schlüssel.** Wenn `ValidateOnBuild` aktiv ist (der Standard in `Development` unter `WebApplication.CreateBuilder`), prüft der Aufrufstellen-Validator den Graphen jeder Registrierung mit Schlüssel genauso wie den einer ohne Schlüssel. Ein scoped Service mit Schlüssel, der von einem Singleton erfasst wird, wirft weiterhin `Cannot consume scoped service from singleton`; ein Schlüssel befreit Sie nicht von den Lebensdauerregeln. Wenn Sie auf einen Auflösungsfehler stoßen, liest sich die Meldung wie im Fall ohne Schlüssel, und der [Fix für unable to resolve service while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) geht durch, wie man sie liest; denken Sie nur daran, dass die Tabelle mit Schlüssel getrennt ist, wenn Sie prüfen, ob die Registrierung existiert.

**Native AOT und Trimming werden unterstützt.** Keyed Services wurden AOT-freundlich konzipiert: die Auflösung verlässt sich nicht auf Reflexion zur Laufzeit über Ihre Typen, daher überleben sie das Trimming ohne zusätzliche `DynamicallyAccessedMembers`-Annotationen. Wenn Sie das Bereitstellungsmodell abwägen, gelten die Kompromisse aus [Native AOT vs ReadyToRun vs JIT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) unverändert mit Registrierungen mit Schlüssel im Graphen.

**Nicht jeder Drittanbieter-Container unterstützt Schlüssel.** Der integrierte Container tut es. Wenn Sie eine ältere Version von Autofac, Lamar oder DryIoc eingebunden haben, bestätigen Sie deren Brücke für Keyed Services, bevor Sie sich auf `[FromKeyedServices]` verlassen; die Funktion ist ein Vertrag von `Microsoft.Extensions.DependencyInjection.Abstractions`, den jeder Container implementieren muss.

## Ein vollständiges, durchgearbeitetes Beispiel

Hier ist die Form von Anfang bis Ende: zwei Gateways mit Schlüssel nach Name, ein Router, der zur Laufzeit eines anhand der Route auswählt, und ein Standard, der direkt in einen Handler injiziert wird.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");
builder.Services.AddScoped<PaymentRouter>();

var app = builder.Build();

// Runtime selection: the provider name comes from the URL.
app.MapPost("/charge/{provider}",
    (string provider, decimal amount, PaymentRouter router)
        => router.ChargeAsync(provider, amount));

// Compile-time selection: this endpoint always uses Stripe.
app.MapPost("/charge-stripe",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));

app.Run();

public interface IPaymentGateway { Task<string> ChargeAsync(decimal amount); }

public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string key, decimal amount)
    {
        var gateway = services.GetKeyedService<IPaymentGateway>(key)
            ?? throw new ArgumentException($"Unknown gateway '{key}'", nameof(key));
        return gateway.ChargeAsync(amount);
    }
}
```

Die Aufteilung ist beabsichtigt: der Endpunkt `/charge/{provider}` braucht `IServiceProvider`, weil der Schlüssel Daten sind, während `/charge-stripe` das Attribut verwendet, weil der Schlüssel eine Konstante ist. Greifen Sie zu `[FromKeyedServices]`, wann immer der Schlüssel zur Kompilierzeit bekannt ist, und fallen Sie nur dann auf `GetKeyedService`/`GetRequiredKeyedService` zurück, wenn er es wirklich nicht ist.

## Wohin Keyed Services als Nächstes passen

Keyed DI ist das richtige Werkzeug, wenn ein Vertrag mehrere reale Implementierungen hat, die per Konfiguration oder pro Anfrage ausgewählt werden. Es ist das falsche Werkzeug für eine einzelne Implementierung, für Querschnittsbelange, die besser vom Options-Muster behandelt werden, oder für eine Auswahllogik, die komplex genug ist, um eine eigene Factory-Abstraktion zu verdienen. Wenn Sie dazu greifen, halten Sie die Schlüssel unveränderlich, registrieren Sie einmal pro beabsichtigtem Auflösungspfad, und denken Sie daran, dass sich die Tabellen mit und ohne Schlüssel nie gegenseitig sehen.

Für angrenzende Muster: zu entscheiden, woher Endpunkte ihre Abhängigkeiten beziehen, ist Teil der größeren Wahl [Minimal APIs vs Controller](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), und die Registrierung mit Schlüssel passt gut zu [HybridCache in ASP.NET Core 11](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/), wenn Sie benannte Cache-Instanzen hinter einer einzigen Schnittstelle wollen.

## Quellen

- [Dependency injection in .NET - keyed services](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services), MS Learn.
- [`ServiceCollectionServiceExtensions` keyed methods](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicecollectionserviceextensions), .NET-API-Referenz.
- [`FromKeyedServicesAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.fromkeyedservicesattribute) und [`ServiceKeyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicekeyattribute), .NET-API-Referenz.
- [`IKeyedServiceProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.ikeyedserviceprovider) und [`KeyedService.AnyKey`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.keyedservice.anykey), .NET-API-Referenz.
