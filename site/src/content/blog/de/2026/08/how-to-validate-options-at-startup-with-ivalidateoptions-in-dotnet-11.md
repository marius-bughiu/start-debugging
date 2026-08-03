---
title: "Optionen beim Start mit IValidateOptions<T> in .NET 11 validieren"
description: "Implementieren Sie IValidateOptions<T>, registrieren Sie es in der Dependency Injection und hängen Sie ValidateOnStart an, damit eine fehlerhafte appsettings.json den Prozess beendet statt die erste Anfrage, die sie berührt. Behandelt die .NET-11-Überladung Validate<TValidator>(), asynchrone Validierung über IAsyncValidateOptions<T> und die drei Stellen, an denen ValidateOnStart stillschweigend nichts tut."
pubDate: 2026-08-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "configuration"
  - "dependency-injection"
lang: "de"
translationOf: "2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

Damit eine Anwendung bei fehlerhafter Konfiguration schon beim Start abbricht, schreiben Sie eine Klasse, die `IValidateOptions<TOptions>` implementiert, registrieren sie als Singleton in der Dependency Injection und hängen `.ValidateOnStart()` an den `OptionsBuilder<TOptions>` dieses Typs. Ohne `ValidateOnStart` laufen Validatoren verzögert beim ersten Zugriff auf `.Value`, was in der Regel die erste Anfrage bedeutet, die die Einstellung berührt, in der Produktion, um 3 Uhr nachts. Mit dem Aufruf zwingt `Host.StartAsync` jeden registrierten Optionstyp dazu, sich zu binden und zu validieren, bevor ein einziger Hosted Service startet, und ein Fehler wirft `OptionsValidationException` aus `host.RunAsync()` heraus. Alles Folgende zielt auf .NET 11 mit `Microsoft.Extensions.Options` 11.0.0 und C# 14. Der Kern aus `IValidateOptions<T>` und `ValidateOnStart` verhält sich so, seit die API von `Microsoft.Extensions.Hosting.dll` nach `Microsoft.Extensions.Options.dll` gewandert ist, läuft also unverändert auf .NET 8 bis .NET 10; die Überladung `Validate<TValidator>()` und die asynchrone Pipeline sind neu in .NET 11 und werden ausdrücklich gekennzeichnet.

## Verzögerte Validierung ist Validierung, von der Sie über einen Kunden erfahren

`ValidateDataAnnotations()` und `Validate(delegate)` hängen Validatoren an die Options-Pipeline, aber diese Pipeline ist bewusst verzögert. `IOptions<T>` ist ein Singleton, dessen `.Value` beim ersten Lesezugriff berechnet wird. Das heißt, diese Registrierung:

```csharp
// .NET 11, C# 14
builder.Services
    .AddOptions<PaymentOptions>()
    .Bind(builder.Configuration.GetSection("Payments"))
    .ValidateDataAnnotations();
```

erzeugt eine Anwendung, die mit einem leeren Abschnitt `Payments` sauber hochfährt, ihren Health Check besteht, Verkehr bedient und dann `OptionsValidationException` wirft, sobald die erste Anfrage den Checkout-Endpunkt erreicht. Die Bereitstellung war erfolgreich. Der Canary war grün. Der Fehler zeigte sich als 500 auf der Karte einer Kundin.

Genau darum geht es bei der Validierung beim Start: daraus einen Absturz beim Hochfahren zu machen, mit dem Orchestrierer bereits umgehen können. Der Container endet mit einem Exit-Code ungleich null, das Rollout stoppt, die vorige Revision bedient weiter. Das ist ein deutlich besserer Fehler als ein teilweise kaputter Prozess.

## Schritte, damit die Start-Validierung tatsächlich greift

1. **Definieren Sie die Optionsklasse mit einem Abschnittsnamen.** Nur öffentliche les- und schreibbare Eigenschaften, nicht abstrakt, mit öffentlichem parameterlosem Konstruktor. Felder werden nicht gebunden.
2. **Schreiben Sie den Validator als Klasse, die `IValidateOptions<TOptions>` implementiert**, und geben Sie `ValidateOptionsResult.Fail` mit allen Fehlern zurück, nicht nur mit dem ersten.
3. **Registrieren Sie den Validator in der Dependency Injection.** Verwenden Sie `TryAddEnumerable` mit einem Singleton-`ServiceDescriptor`, denn die Pipeline löst `IEnumerable<IValidateOptions<TOptions>>` auf, und ein einfaches, zweimal aufgerufenes `AddSingleton` liefert den Validator doppelt.
4. **Hängen Sie `.ValidateOnStart()` an** den Builder, oder beginnen Sie mit `AddOptionsWithValidateOnStart<TOptions>()`, damit Sie es nicht vergessen können.
5. **Starten Sie den Host.** `ValidateOnStart` tut nichts, bis `Host.StartAsync` ausgeführt wird. Den Host nur zu bauen genügt nicht.

Hier das Ganze von Anfang bis Ende.

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class PaymentOptions
{
    public const string SectionName = "Payments";

    [Required]
    public required string ApiKey { get; set; }

    [Required]
    [Url]
    public required string Endpoint { get; set; }

    [Range(1, 120)]
    public int TimeoutSeconds { get; set; } = 30;

    [Range(0, 10)]
    public int MaxRetries { get; set; } = 3;
}
```

Der Validator. Beachten Sie, dass er Fehler sammelt, statt beim ersten abzubrechen, damit jemand, der eine kaputte `appsettings.json` repariert, die vollständige Liste in einem einzigen Start erhält statt einen Fehler pro Neustart:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
    public ValidateOptionsResult Validate(string? name, PaymentOptions options)
    {
        var builder = new ValidateOptionsResultBuilder();

        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            builder.AddError("ApiKey is missing.", nameof(PaymentOptions.ApiKey));
        }
        else if (!options.ApiKey.StartsWith("pk_", StringComparison.Ordinal))
        {
            builder.AddError(
                "ApiKey must start with 'pk_'. A secret key was probably pasted by mistake.",
                nameof(PaymentOptions.ApiKey));
        }

        if (!Uri.TryCreate(options.Endpoint, UriKind.Absolute, out Uri? endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps)
        {
            builder.AddError(
                "Endpoint must be an absolute https URI.",
                nameof(PaymentOptions.Endpoint));
        }

        // Cross-property rule: nothing in DataAnnotations can express this.
        if (options.TimeoutSeconds * (options.MaxRetries + 1) > 300)
        {
            builder.AddError(
                $"TimeoutSeconds ({options.TimeoutSeconds}) times MaxRetries + 1 "
                + $"({options.MaxRetries + 1}) exceeds the 300s gateway budget.");
        }

        return builder.Build();
    }
}
```

`ValidateOptionsResultBuilder` liegt in `Microsoft.Extensions.Options` und existiert genau dafür, dass Sie keinen `StringBuilder` von Hand bauen. `Build()` gibt `ValidateOptionsResult.Success` zurück, wenn nichts hinzugefügt wurde, es gibt also am Ende keinen Null-Tanz. `AddError` nimmt einen optionalen Eigenschaftsnamen entgegen, der der Meldung vorangestellt wird, und es gibt zusätzlich `AddResult(ValidationResult)` und `AddResults(IEnumerable<ValidationResult>)`, um die Ausgabe von DataAnnotations in denselben Behälter zu überführen.

Registrierung:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection.Extensions;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptionsWithValidateOnStart<PaymentOptions>()
    .Bind(builder.Configuration.GetSection(PaymentOptions.SectionName))
    .ValidateDataAnnotations();

builder.Services.TryAddEnumerable(
    ServiceDescriptor.Singleton<IValidateOptions<PaymentOptions>, ValidatePaymentOptions>());

var app = builder.Build();
await app.RunAsync();
```

`AddOptionsWithValidateOnStart<TOptions>()` ist lediglich `AddOptions<TOptions>().ValidateOnStart()` mit unvergesslicher Reihenfolge. Es gibt außerdem eine Überladung mit zwei generischen Parametern, `AddOptionsWithValidateOnStart<TOptions, TValidateOptions>()`, die den Validator für Sie registriert und die beiden obigen Registrierungen zu einem Aufruf zusammenfasst.

`ValidateDataAnnotations()` und ein handgeschriebenes `IValidateOptions<T>` schließen einander nicht aus. Die Attribute kümmern sich um die Form einzelner Eigenschaften, die Klasse um Regeln, die mehrere Eigenschaften umspannen oder einen Dienst benötigen. Alle registrierten Validatoren laufen, und alle ihre Fehler werden gesammelt.

## Was ValidateOnStart tatsächlich registriert

`ValidateOnStart` führt zum Registrierungszeitpunkt nichts aus. Ein Blick in den [Runtime-Quellcode](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) von .NET 11 zeigt drei Dinge:

```csharp
optionsBuilder.Services.TryAddTransient<IStartupValidator, StartupValidator>();
optionsBuilder.Services.TryAddTransient<IAsyncStartupValidator, StartupValidator>();
optionsBuilder.Services.AddOptions<StartupValidatorOptions>()
    .Configure<IOptionsMonitor<TOptions>>((vo, options) =>
    {
        // This adds an action that resolves the options value to force evaluation
        // We don't care about the result as duplicates are not important
        vo._validators[(typeof(TOptions), optionsBuilder.Name)] = () => options.Get(optionsBuilder.Name);
    });
```

Es hängt einen Thunk in ein internes Dictionary auf `StartupValidatorOptions`, verschlüsselt nach `(Type, name)`. Der Thunk ruft `IOptionsMonitor<TOptions>.Get(name)` auf, und genau das zwingt `OptionsFactory<TOptions>.Create` dazu, die Kette aus `IConfigureOptions<T>`, danach die aus `IPostConfigureOptions<T>` und danach jedes `IValidateOptions<T>` abzuarbeiten. Die Validierung ist ein Nebeneffekt des erzwungenen Bindens.

Das `TryAdd` ist wichtig. In früheren Releases war das `AddTransient`, sodass ein `ValidateOnStart` auf zehn Optionstypen zehn Kopien von `StartupValidator` in den Container legte. Der Dictionary-Schlüssel erklärt auch eine alte Stolperfalle: Die Verschlüsselung nach `(Type, name)` sorgt dafür, dass jede benannte Instanz einen eigenen Eintrag bekommt, statt dass der letzte alle anderen überschreibt.

Der Auslöser sitzt in `Host.StartAsync`, nach `IHostLifetime.WaitForStartAsync` und bevor irgendein Hosted Service startet:

```csharp
IStartupValidator? validator = Services.GetService<IStartupValidator>();
validator?.Validate();

IAsyncStartupValidator? asyncValidator = Services.GetService<IAsyncStartupValidator>();
if (asyncValidator is not null)
{
    await asyncValidator.ValidateAsync(cancellationToken).ConfigureAwait(false);
}
```

Zwei Konsequenzen sollten Sie verinnerlichen. Erstens läuft die Validierung vor `IHostedLifecycleService.StartingAsync`, ein `BackgroundService` sieht also nie eine halb gültige Konfiguration. Zweitens sammelt `StartupValidator` die Ausnahmen, wenn mehr als ein Optionstyp fehlschlägt, und wirft sie als `AggregateException` erneut. Sie sehen damit alle kaputten Abschnitte in einer Logzeile, statt sich von Neustart zu Neustart durchzuhangeln.

## Die Überladung Validate<TValidator>() in .NET 11

Vor .NET 11 bedeutete das Verdrahten eines Validators zwei Anweisungen, die zueinander passen mussten: ein `AddSingleton` für den Validator und eine separate `AddOptions`-Kette. .NET 11 ergänzt eine generische Überladung [`OptionsBuilder<TOptions>.Validate<TValidator>()`](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries#options-builder-validation-improvements), die einen Typparameter statt eines Delegate entgegennimmt:

```csharp
// .NET 11 only
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

Der Validatortyp muss `IValidateOptions<TOptions>` implementieren und bereits im Container registriert sein, und darum geht es: Der Validator wird aus der Dependency Injection aufgelöst und kann daher Konstruktorabhängigkeiten wie `IHostEnvironment`, einen `TimeProvider` oder einen `HttpClient` annehmen. Das war zuvor umständlich, weil die Delegate-Überladungen von `Validate` nur die Optionsinstanz liefern, während bis zu fünf injizierte Dienste ausschließlich auf der `Configure`-Seite verfügbar waren.

Lassen Sie das `AddSingleton` nicht weg. Die Überladung löst den Typ auf, sie registriert ihn nicht.

## Asynchrone Validierung mit IAsyncValidateOptions<T>

Die interessante Neuerung in .NET 11 ist, dass die Start-Validierung jetzt E/A ausführen darf. Manche Konfiguration ist nur auf eine Weise falsch, die Sie ohne Nachfrage nicht sehen: eine Verbindungszeichenfolge, die sich parsen lässt, aber auf eine nicht vorhandene Datenbank zeigt, eine OIDC-Authority, deren Discovery-Dokument 404 liefert, ein Blob-Container, den die verwaltete Identität nicht lesen darf. Vor .NET 11 blieben nur zwei ehrliche Möglichkeiten: einen Thread innerhalb von `Validate` blockieren oder aufgeben und beim ersten Zugriff prüfen.

`IAsyncValidateOptions<TOptions>` ist der asynchrone Zwilling von `IValidateOptions<TOptions>`:

```csharp
namespace Microsoft.Extensions.Options;

public interface IAsyncValidateOptions<in TOptions> where TOptions : class
{
    Task<ValidateOptionsResult> ValidateAsync(
        string? name, TOptions options, CancellationToken cancellationToken = default);
}
```

Eine Implementierung, die nachweist, dass der Zahlungsendpunkt tatsächlich erreichbar ist:

```csharp
// .NET 11 only
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentEndpointAsync(IHttpClientFactory httpClientFactory)
    : IAsyncValidateOptions<PaymentOptions>
{
    public async Task<ValidateOptionsResult> ValidateAsync(
        string? name, PaymentOptions options, CancellationToken cancellationToken = default)
    {
        using HttpClient client = httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(5);

        try
        {
            using HttpResponseMessage response = await client.GetAsync(
                new Uri(new Uri(options.Endpoint), "/.well-known/health"), cancellationToken);

            return response.IsSuccessStatusCode
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(
                    $"Payment endpoint {options.Endpoint} returned {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return ValidateOptionsResult.Fail(
                $"Payment endpoint {options.Endpoint} is unreachable: {ex.Message}");
        }
    }
}
```

Registrieren Sie ihn genauso wie den synchronen, mit `TryAddEnumerable` gegen `IAsyncValidateOptions<PaymentOptions>`, und behalten Sie den Aufruf von `ValidateOnStart()` bei. Die Registrierung in `OptionsBuilderExtensions` materialisiert alle registrierten `IAsyncValidateOptions<TOptions>` in ein zweites Dictionary namens `_asyncValidators` und installiert das asynchrone Delegate nur, wenn mindestens eines existiert. Ist keines registriert, ändert sich nichts, und es entstehen keine asynchronen Kosten.

Zwei Verhaltensweisen sollten Sie einplanen. Asynchrone Validatoren laufen nur beim Start: Die asynchrone Pipeline hängt an `IAsyncStartupValidator`, nicht an `IOptionsFactory`, ein späterer verzögerter Zugriff auf `.Value` löst sie also nie aus. Und Stufe 2 läuft nur, wenn Stufe 1 erfolgreich war, was Absicht ist. Es gibt keinen Grund, fünf Sekunden in Netzwerkabfragen zu stecken, wenn die Endpunkt-URL bereits ihr `[Url]`-Attribut verletzt hat.

Die passende Arbeit an DataAnnotations kam zeitgleich: `AsyncValidationAttribute` mit überschreibbarem `IsValidAsync`, `IAsyncValidatableObject` am Modell sowie `Validator.ValidateObjectAsync` / `TryValidateObjectAsync` / `ValidatePropertyAsync` / `ValidateValueAsync`. Greifen Sie dazu, wenn Sie die Regel als Attribut an der Eigenschaft statt als eigene Klasse ausdrücken möchten.

## Den handgeschriebenen Validator mit [OptionsValidator] überspringen

Wenn alle Ihre Regeln DataAnnotations-Attribute sind, schreiben Sie die Methode `Validate` gar nicht erst. Der Source Generator für Optionsvalidierung schreibt zur Kompilierzeit eine `IValidateOptions<T>`-Implementierung für Sie:

```csharp
// .NET 8 and later
using Microsoft.Extensions.Options;

[OptionsValidator]
public sealed partial class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
}
```

Eine leere partielle Klasse plus das Attribut, und der Generator erzeugt ein `Validate(string?, PaymentOptions)`, das pro Eigenschaft `Validator.TryValidateValue` mit vorab angelegten statischen Attributinstanzen aufruft und in einen `ValidateOptionsResultBuilder` sammelt. Keine Reflexion über den Optionstyp zur Laufzeit, weshalb genau das die richtige Form für Native AOT ist. Der Generator ist standardmäßig aktiv, sobald das Projekt `Microsoft.Extensions.Options` 8.0 oder neuer referenziert, und `ValidateDataAnnotations()` wird überflüssig, sobald Sie ihn verwenden. Er ersetzt im generierten Code außerdem `RangeAttribute`, `MinLengthAttribute`, `MaxLengthAttribute` und `LengthAttribute` durch reflexionsfreie Entsprechungen. Wer mehr Hintergrund dazu möchte, was ein Generator mit dem Build macht, findet ihn in der Erläuterung zu [Source Generatoren und wann man sie braucht](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/), und die Notizen zu [trimmsicherem Code](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) erklären, warum reflexionsfreie Validierung zählt.

Standardmäßig ist die DataAnnotations-Validierung nicht rekursiv. Ein verschachteltes Optionsobjekt oder eine `List<T>` von Unteroptionen wird nur validiert, wenn Sie es angeben, mit `[ValidateObjectMembers]` beziehungsweise `[ValidateEnumeratedItems]`. Beide funktionieren mit dem Generator.

## Wo ValidateOnStart stillschweigend nichts tut

Der Fehlerfall, den im Review niemand bemerkt, ist ein registriertes, aber nie ausgeführtes `ValidateOnStart`. Drei Fälle:

**Sie starten den Host nie.** Ein Test oder Werkzeug, das `builder.Build()` aufruft und Dienste ohne `StartAsync` aus `host.Services` auflöst, überspringt die Validierung vollständig. Wenn Sie eine Prüfung in einem Integrationstest wollen, lösen Sie die Optionen explizit mit `GetRequiredService<IOptions<T>>().Value` innerhalb eines `try` auf, oder rufen Sie direkt `host.Services.GetService<IStartupValidator>()?.Validate()` auf.

**Der Host ist nicht der von `Microsoft.Extensions.Hosting`.** Die oben zitierte Aufrufstelle liegt in `Host.StartAsync`. Laufzeiten, die ihren eigenen Host bauen, allen voran das In-Process-Modell von Azure Functions, erreichen sie nie, und genau das ist [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034). Das Isolated-Worker-Modell ist ein normaler generischer Host und funktioniert. Prüfen Sie bei allem Ungewöhnlichen mit einem absichtlich kaputten Abschnitt, statt es anzunehmen.

**Sie haben den Validator registriert, aber nicht den Builder.** `services.Configure<T>(section)` plus eine Validatorregistrierung ergibt nur verzögerte Validierung. `Configure<T>` erzeugt keinen `OptionsBuilder<T>`, es gibt also nichts, woran sich `ValidateOnStart` anhängen ließe. Sie brauchen `AddOptions<T>().Bind(section)` oder `AddOptionsWithValidateOnStart<T>().Bind(section)`.

Ein weiterer Punkt, der nicht stillschweigend, aber leicht misszuverstehen ist: Validatoren laufen pro benannter Instanz. Wenn Sie drei benannte `PaymentOptions` haben und nur `AddOptions<PaymentOptions>("primary").ValidateOnStart()` aufrufen, werden die anderen beiden verzögert validiert. Jeder Name braucht seine eigene Kette. Wenn Sie mehrere Varianten derselben Einstellungsklasse verdrahten, passt das auf der Konsumentenseite gut zu [Keyed Services in der .NET-11-Dependency-Injection](/de/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/).

## Was mit der Ausnahme zu tun ist

`OptionsValidationException` trägt `OptionsType`, `OptionsName` und `Failures` als `IEnumerable<string>`. Die `Message` besteht aus den mit `;` verbundenen Fehlern, was im Containerlog in Ordnung und im Terminal unlesbar ist. Ist die Anwendung eine CLI oder ein an Entwicklerinnen und Entwickler gerichteter Dienst, ist es eine kleine Freundlichkeit, sie oben in `Main` zu fangen und einen Fehler pro Zeile auszugeben:

```csharp
// .NET 11, C# 14
try
{
    await app.RunAsync();
}
catch (OptionsValidationException ex)
{
    Console.Error.WriteLine($"Invalid configuration for {ex.OptionsType.Name}:");
    foreach (string failure in ex.Failures)
    {
        Console.Error.WriteLine($"  - {failure}");
    }
    return 78; // EX_CONFIG
}
```

Umschließen Sie das zusätzlich mit einem `catch (AggregateException agg)`, wenn Sie mehr als einen Optionstyp validieren, denn so meldet `StartupValidator` mehrere Fehler.

Start-Validierung ist die günstigste Zuverlässigkeitsarbeit, die in einer .NET-Anwendung verfügbar ist. Es ist ein Methodenaufruf auf einem Builder, den Sie ohnehin haben, und er verwandelt eine ganze Kategorie von Produktionsvorfällen, die fehlkonfigurierte Bereitstellung, in einen Startfehler, mit dem Ihr Rollout-Prozess bereits umgehen kann.

## Verwandte Beiträge

- [IOptions&lt;T&gt; vs IOptionsSnapshot&lt;T&gt; vs IOptionsMonitor&lt;T&gt; in .NET 11](/de/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) wählt den richtigen Zugriff, bevor Sie ihn validieren.
- [Fix: Cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) behandelt den Captive-Dependency-Fehler, auf den Sie stoßen, wenn ein Validator eine Scoped-Abhängigkeit annimmt.
- [Fix: No connection string named 'DefaultConnection' could be found](/de/2026/05/fix-no-connection-string-named-defaultconnection/) ist der klassische Fehler verzögerter Konfiguration, den die Start-Validierung verhindert.
- [Was ist ein Source Generator und wann brauche ich einen?](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) erklärt, was `[OptionsValidator]` zur Kompilierzeit tut.
- [Was ist der IHostedService-Vertrag und wann verwende ich ihn?](/de/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) zeigt, was unmittelbar nach bestandener Validierung läuft.

## Quellen

- [Options pattern in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options) auf MS Learn, für `ValidateOnStart`, `AddOptionsWithValidateOnStart` und die Attribute zur rekursiven Validierung.
- [Compile-time options validation source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/options-validation-generator) für `[OptionsValidator]` und die generierte Ausgabe.
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries) für die Überladung `Validate<TValidator>()` und die asynchrone DataAnnotations-Validierung.
- [`OptionsBuilderExtensions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) und [`IAsyncValidateOptions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/IAsyncValidateOptions.cs) in dotnet/runtime.
- [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034), `ValidateOnStart()` does not work in Azure Functions.
