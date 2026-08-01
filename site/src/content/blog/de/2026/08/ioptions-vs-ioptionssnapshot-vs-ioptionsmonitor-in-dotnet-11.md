---
title: "IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> in .NET 11"
description: "Verwenden Sie standardmäßig IOptions<T>. Greifen Sie zu IOptionsMonitor<T>, wenn ein Singleton Konfigurationsänderungen sehen muss, und zu IOptionsSnapshot<T> nur dann, wenn ein Scoped-Consumer einen für eine Anfrage stabilen Wert benötigt. Entscheidend ist die Lebensdauer des Consumers, nicht die Form der Einstellungen."
pubDate: 2026-08-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "de"
translationOf: "2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-01
---

Injizieren Sie `IOptions<T>`, sofern Sie keinen konkreten Grund dagegen haben. Es ist ein Singleton, es bindet Ihre Einstellungsklasse genau einmal für die gesamte Prozesslaufzeit, und es ist von den dreien am günstigsten aufzulösen. Greifen Sie zu `IOptionsMonitor<T>`, wenn ein langlebiger Dienst Konfigurationsänderungen ohne Neustart beobachten muss, und zu `IOptionsSnapshot<T>` in genau einem engen Fall: ein Scoped- oder Transient-Consumer, der einen Wert braucht, der während einer einzelnen Anfrage stabil bleibt, sich zwischen Anfragen aber unterscheiden darf. Entscheidend ist die Lebensdauer der injizierenden Klasse, nicht die Form der injizierten Einstellungen. Alles Folgende zielt auf .NET 11 (getestet gegen Preview 6, SDK `11.0.100-preview.6.26359.118`) und C# 14, mit `Microsoft.Extensions.Options` 11.0.0. Die drei Interfaces verhalten sich seit .NET Core 2.0 so, daher läuft alles unverändert auf .NET 10 GA; wirklich neu ist nur die Validierungsarbeit aus .NET 11 am Ende.

## Die Funktionsmatrix

| Funktion | `IOptions<T>` | `IOptionsSnapshot<T>` | `IOptionsMonitor<T>` |
| --- | --- | --- | --- |
| Konkrete Implementierung | `UnnamedOptionsManager<T>` | `OptionsManager<T>` | `OptionsMonitor<T>` |
| Lebensdauer in der DI | Singleton | **Scoped** | Singleton |
| In ein Singleton injizierbar | Ja | Nein, Captive Dependency | Ja |
| Sieht ein Konfigurations-Reload | Nie | Ja, im nächsten Scope | Ja, sofort |
| Benannte Optionen | Nein | Ja, `Get(name)` | Ja, `Get(name)` |
| Änderungs-Callbacks | Nein | Nein | Ja, `OnChange` |
| Zugriff auf den Wert | `.Value` | `.Value`, `.Get(name)` | `.CurrentValue`, `.Get(name)` |
| Wie oft der Binder läuft | Einmal pro Prozess | Einmal pro Scope, pro Name | Einmal pro Änderung, pro Name |
| Wo die Instanz gecacht wird | Feld im Singleton | `OptionsCache<T>` im Scoped-Manager | Singleton `IOptionsMonitorCache<T>` |

Zwei Zeilen tragen das meiste Gewicht. Die Zeile zur Lebensdauer erzeugt Exceptions beim Start, und die Zeile "Wie oft der Binder läuft" erzeugt überraschende CPU-Last auf einem heißen Pfad. Alles andere folgt aus diesen beiden.

Alle drei registriert `AddOptions()`, das der Host für Sie aufruft. Aus [OptionsServiceCollectionExtensions](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs):

```csharp
// Microsoft.Extensions.Options 11.0.0 -- what AddOptions() actually registers
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptions<>), typeof(UnnamedOptionsManager<>)));
services.TryAdd(ServiceDescriptor.Scoped(typeof(IOptionsSnapshot<>), typeof(OptionsManager<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitor<>), typeof(OptionsMonitor<>)));
services.TryAdd(ServiceDescriptor.Transient(typeof(IOptionsFactory<>), typeof(OptionsFactory<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitorCache<>), typeof(OptionsCache<>)));
```

Beachten Sie, dass `IOptionsFactory<T>` transient ist und die eigentliche Arbeit macht: Es führt jedes registrierte `IConfigureOptions<T>` der Reihe nach aus, danach jedes `IPostConfigureOptions<T>`, dann die Validierung. Die drei Zugriffs-Interfaces unterscheiden sich nur darin, wie aggressiv sie die Ausgabe der Factory cachen. Das ist die ganze Geschichte, und deshalb geht es bei der Wahl um Lebensdauer.

Die Einstellungsklasse und die Registrierung sind für alle drei identisch:

```csharp
// .NET 11, C# 14
public sealed class PaymentOptions
{
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
}

// Program.cs
builder.Services.Configure<PaymentOptions>(
    builder.Configuration.GetSection("Payment"));
```

## Wann IOptions die richtige Wahl ist

Machen Sie es zum Standard. Sie verzichten auf Reload-Unterstützung, und in den meisten Diensten ist das kein echter Verlust.

- **Alles, was beim Start gelesen wird.** Verbindungszeichenfolgen, eine Basis-URL, ein Queue-Name, ein Feature Flag, das Sie per erneuter Bereitstellung ändern würden. `IOptions<T>` ist ein Singleton, daher funktioniert die Injektion in ein Singleton, in einen Scoped-Dienst und in einen Transient-Dienst gleichermaßen. Wenn beim Verdrahten von Einstellungen ein `Cannot consume scoped service`-Fehler auftritt, ist `IOptions<T>` meist die Lösung und nicht die Ursache. Siehe [warum diese Exception auftritt und wie Sie sie auflösen](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Heiße Pfade.** `UnnamedOptionsManager<T>` cacht die gebundene Instanz in einem Feld. Nach dem ersten Zugriff ist `.Value` ein Feldzugriff. Es gibt keine Wörterbuchsuche, keinen Namensvergleich und keine Allokation.
- **Das Erfassen im Konstruktor ist sicher.** Da sich der Wert nie ändern kann, ist `options.Value` im Konstruktor korrekt und kein latenter Fehler.

```csharp
// .NET 11, C# 14
public sealed class PaymentClient(IOptions<PaymentOptions> options)
{
    // Safe: the value is fixed for the life of the process.
    private readonly PaymentOptions _settings = options.Value;

    public TimeSpan Timeout => TimeSpan.FromSeconds(_settings.TimeoutSeconds);
}
```

`IOptions<T>` kostet genau eine Sache: Es unterstützt keine benannten Optionen, daher ist `Configure<Features>("Personalize", ...)` für es unsichtbar. Wenn Sie zwei Konfigurationen derselben Klasse brauchen, haben Sie `IOptions<T>` bereits ausgeschlossen. Das ist auch der Moment zu prüfen, ob [Keyed Services in der Dependency Injection von .NET 11](/de/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) besser passen als benannte Optionen für das, was Sie tatsächlich modellieren.

## Wann IOptionsSnapshot die richtige Wahl ist

Greifen Sie dazu, wenn ein **Scoped**-Consumer einen Wert braucht, der innerhalb einer Arbeitseinheit konsistent bleibt, sich zwischen Arbeitseinheiten aber ändern darf.

- **Ein Wert pro Anfrage, der sich nicht mitten in der Anfrage verschieben darf.** Ein Controller und drei von ihm aufgerufene Dienste lösen dieselbe Scoped-Instanz von `OptionsManager<T>` auf, daher sehen alle vier dieselbe `PaymentOptions`-Instanz, selbst wenn `appsettings.json` mitten in der Anfrage neu geschrieben wird. `IOptionsMonitor<T>` gibt diese Garantie nicht: Zwei `CurrentValue`-Lesevorgänge in derselben Anfrage können zwei verschiedene Instanzen liefern.
- **Benannte Optionen in einem Scoped-Consumer.** `Get(name)` wird unterstützt, und die `OptionsCache<T>` pro Scope sorgt dafür, dass das zweite `Get("Personalize")` in der Anfrage ein Cache-Treffer ist.

```csharp
// .NET 11, C# 14 -- scoped service, values stable for this request
public sealed class CheckoutService(IOptionsSnapshot<PaymentOptions> snapshot)
{
    private readonly PaymentOptions _settings = snapshot.Value;

    public string Key => _settings.ApiKey;
}
```

Zwei harte Grenzen. Erstens ist `IOptionsSnapshot<T>` als `Scoped` registriert, daher schlägt die Injektion in ein Singleton fehl, auch in einen `IHostedService` oder `BackgroundService`, denn das sind Singletons. Der Host aktiviert `ValidateScopes` und `ValidateOnBuild` in der Umgebung Development, dort bekommen Sie also beim Start ein klares `Cannot consume scoped service`; außerhalb von Development sind diese Prüfungen standardmäßig aus, und derselbe Code löst eine Captive Dependency auf, die sich stillschweigend nie aktualisiert. Aktivieren Sie die Scope-Validierung überall, wenn der Fehler laut sein soll. Der Umweg besteht darin, [einen Scope innerhalb des BackgroundService zu erstellen](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) und von dort aufzulösen, aber wenn Sie nur frische Werte wollten, ist `IOptionsMonitor<T>` die einfachere Antwort. Zweitens gibt es in einer Konsolenanwendung oder einem reinen `IHost` keinen umgebenden Scope, sofern Sie keinen anlegen, daher bedeutet `IOptionsSnapshot<T>` außerhalb eines Web-Hosts fast immer, dass Sie eigentlich `IOptionsMonitor<T>` wollten.

## Wann IOptionsMonitor die richtige Wahl ist

Greifen Sie dazu, wenn ein **Singleton** Änderungen sehen muss oder wenn Sie einen Callback brauchen.

- **Ein Singleton, das für einen neuen Wert nicht neu gestartet werden darf.** Ein Rate Limiter, eine Cache-Richtlinie, ein Sampling-Prozentsatz, ein Log-Level.
- **Sie müssen reagieren, nicht nur lesen.** `OnChange` ist die einzige Push-Benachrichtigung der drei.
- **Selektive Invalidierung.** `IOptionsMonitorCache<T>.TryRemove(name)` erzwingt, dass eine einzelne benannte Instanz beim nächsten Zugriff neu gebaut wird, nützlich, wenn Ihr eigener Code und nicht ein Datei-Watcher weiß, dass der Wert veraltet ist.

`OptionsMonitor<T>` abonniert jede registrierte `IOptionsChangeTokenSource<T>`. Wenn eine auslöst, führt `InvokeChanged` `_cache.TryRemove(name)` aus, baut sofort mit `TOptions options = Get(name)` neu und ruft dann die Listener mit der neuen Instanz auf. `CurrentValue` ist eine dünne Hülle um `Get(Options.DefaultName)`, was `_cache.GetOrAdd(localName, () => localFactory.Create(localName))` ist.

```csharp
// .NET 11, C# 14 -- singleton, always current
public sealed class RateLimiter : IDisposable
{
    private readonly IDisposable? _subscription;
    private volatile PaymentOptions _current;

    public RateLimiter(IOptionsMonitor<PaymentOptions> monitor)
    {
        _current = monitor.CurrentValue;
        _subscription = monitor.OnChange(updated => _current = updated);
    }

    public int TimeoutSeconds => _current.TimeoutSeconds;

    public void Dispose() => _subscription?.Dispose();
}
```

Dieses `IDisposable` ist wichtig. `OnChange` gibt ein `ChangeTrackerDisposable` zurück, dessen `Dispose` `_monitor._onChange -= OnChange` ausführt. Registrieren Sie einen Callback aus einem Scoped- oder Transient-Dienst und werfen Sie den Rückgabewert weg, dann hängt jede Anfrage einen Listener an das Multicast-Delegate eines Singletons, der nie wieder entfernt wird. Das Ergebnis ist ein langsames Speicherleck plus ein Callback-Sturm, und das ist einer der häufigsten Wege, wie ein `IOptionsMonitor<T>` schiefgeht.

Änderungsbenachrichtigungen gibt es nur für dateisystembasierte Konfigurationsanbieter wie `Microsoft.Extensions.Configuration.Json`, `.Ini`, `.Xml`, `.KeyPerFile` und `.UserSecrets`, und nur dann, wenn der Anbieter mit `reloadOnChange: true` hinzugefügt wurde. Ein Anbieter für Umgebungsvariablen oder Kommandozeile löst nie aus, daher degradiert `IOptionsMonitor<T>` über diesen Quellen stillschweigend zu einem etwas teureren `IOptions<T>`.

## Die Messung, auf die es ankommt, ist eine Zählung und keine Nanosekundenzahl

Ich veröffentliche hier bewusst keine ns/op-Zahlen, denn die Auflösungskosten aller drei werden davon dominiert, was Ihre eigenen `IConfigureOptions<T>`-Delegates und Validatoren tun. Die Zahlen meiner Maschine würden Ihnen also nichts über Ihre sagen. Portabel ist die Zahl **wie oft Ihr Binder läuft**, und die messen Sie in etwa fünfzehn Zeilen.

```csharp
// .NET 11 Preview 6, C# 14 -- counts how often the options are actually built
public sealed class CountingConfigure : IConfigureOptions<PaymentOptions>
{
    public static int Count;
    public void Configure(PaymentOptions options) => Interlocked.Increment(ref Count);
}

builder.Services.AddSingleton<IConfigureOptions<PaymentOptions>, CountingConfigure>();

app.MapGet("/probe", (
    IOptions<PaymentOptions> o,
    IOptionsSnapshot<PaymentOptions> s,
    IOptionsMonitor<PaymentOptions> m) =>
{
    _ = o.Value; _ = s.Value; _ = m.CurrentValue;
    return CountingConfigure.Count;
});
```

Rufen Sie `/probe` wiederholt auf, und der Zähler steigt pro Anfrage um genau eins, und dieses eine ist das `IOptionsSnapshot<T>`. `IOptions<T>` trägt nur bei der ersten Anfrage bei, `IOptionsMonitor<T>` bei der ersten Anfrage und danach einmal pro Reload, und `IOptionsSnapshot<T>` bei jeder einzelnen Anfrage, weil ein neuer Scope einen neuen `OptionsManager<T>` mit leerer `OptionsCache<T>` bedeutet. Fügen Sie dieser Registrierung `.ValidateDataAnnotations()` hinzu, laufen auch die Validatoren bei jeder Anfrage erneut. Bei einem Endpunkt mit 5.000 Anfragen pro Sekunde sind das 5.000 Rebinds und 5.000 Validierungsdurchläufe pro Sekunde für einen Wert, der sich so gut wie nie ändert. Das ist der konkrete Grund, warum `IOptionsSnapshot<T>` nicht Ihr Standard sein sollte, und es ist eine Behauptung, die Sie in Ihrer eigenen Anwendung prüfen können, statt sie einem Diagramm zu glauben.

## Die Stolpersteine, die die Entscheidung abnehmen

**`OnChange` löst für Konfiguration aus, die Sie nicht interessiert.** Callbacks hängen am Change Token des Konfigurations-Roots, nicht an Ihrem Abschnitt. Jeder Schreibvorgang irgendwo in `IConfiguration` ruft jeden `IOptionsMonitor<T>`-Listener der Anwendung auf. Das .NET-Team hat das als [dotnet/runtime#109445](https://github.com/dotnet/runtime/issues/109445) erfasst und als nicht geplant geschlossen, das Verhalten ist also dauerhaft: Solange sich irgendein Teil der Konfiguration ändert, können alle `IOptionsMonitor`-Instanzen ihre Callbacks auslösen. Wenn Ihr Callback eine teure Ressource neu baut, cachen Sie den vorherigen Wert und vergleichen Sie, bevor Sie handeln.

**`OnChange` löst außerdem mehr als einmal pro Speichern aus.** Editoren schreiben Dateien in mehreren Operationen, und das darunterliegende `IFileProvider.Watch` meldet jede davon, daher erzeugt ein einzelnes `Ctrl+S` häufig zwei Callbacks und manchmal mehr. Das ist [dotnet/aspnetcore#2542](https://github.com/dotnet/aspnetcore/issues/2542) und ein Artefakt des Datei-Watchers, kein Fehler im Options-Stack. Machen Sie Ihren Callback idempotent oder entprellen Sie ihn.

**Die Dateiüberwachung ist auf Docker-Volumes und Netzwerkfreigaben unzuverlässig.** Setzen Sie `DOTNET_USE_POLLING_FILE_WATCHER=1`, um stattdessen zu pollen. Das Poll-Intervall beträgt vier Sekunden und ist nicht konfigurierbar, was eine echte Einschränkung ist, wenn Sie mit schnellerer Verbreitung gerechnet haben.

**`IOptions<T>` bedeutet wirklich für immer.** Der Wert wird beim ersten Lesen von `.Value` gebunden und für die gesamte Prozesslaufzeit gecacht. Wenn das mentale Modell Ihres Teams lautet "das Einstellungsobjekt aktualisiert sich", wird `IOptions<T>` in einem Incident kaputt wirken, wenn ein Konfigurations-Push nichts bewirkt. Entscheiden Sie das pro Einstellungsklasse und halten Sie es schriftlich fest.

**Optionen mit Scoped-Diensten zu konfigurieren ist unabhängig vom Accessor eine Falle.** `IConfigureOptions<T>` wird für `IOptions<T>` über den Root-Provider aufgelöst, daher wird eine in Ihr Konfigurations-Delegate injizierte Scoped-Abhängigkeit zu einer Captive Dependency. Lösen Sie stattdessen einen `IServiceProvider` auf und erstellen Sie innerhalb von `Configure` einen Scope, und denken Sie daran, dass dieser Scope nicht der Scope der Anfrage ist.

## Was .NET 11 ergänzt

Zwei erwähnenswerte Dinge, beide in der Validierungsschicht und nicht in der Zugriffsschicht.

`OptionsBuilder<TOptions>` erhält eine generische `Validate`-Überladung, die einen Typparameter statt eines Delegates entgegennimmt. Der Typ muss `IValidateOptions<TOptions>` implementieren und in der DI registriert sein, was die Optionsvalidierung auf das übliche DI-Muster ausrichtet:

```csharp
// .NET 11, C# 14
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

`System.ComponentModel.DataAnnotations` hat in .NET 11 ebenfalls asynchrone Validierung gelernt, über `AsyncValidationAttribute`, `IAsyncValidatableObject` und `Validator.ValidateObjectAsync`. `Microsoft.Extensions.Options` greift das über einen neuen `IAsyncStartupValidator` auf, sodass eine Option, deren Gültigkeit von einem Netzwerkaufruf abhängt, die Anwendung beim Start scheitern lassen kann statt erst bei der ersten Nutzung. Keine der beiden Änderungen beeinflusst, welchen Accessor Sie injizieren sollten; beide machen `ValidateOnStart` zu einem stärkeren Standard, als es in .NET 10 war.

## Die Empfehlung, noch einmal

Beginnen Sie jede Einstellungsklasse mit `IOptions<T>`. Wechseln Sie zu `IOptionsMonitor<T>`, wenn ein bestimmtes Singleton einen dokumentierten Bedarf hat, Änderungen zu beobachten, und geben Sie das `OnChange`-Abonnement frei. Verwenden Sie `IOptionsSnapshot<T>` nur, wenn ein Scoped-Consumer Stabilität pro Anfrage für einen Wert braucht, der sich tatsächlich ändert, und akzeptieren Sie, dass Sie dafür bei jeder Anfrage ein vollständiges Rebind plus Revalidierung bezahlen. Wenn Sie zu `IOptionsSnapshot<T>` greifen, weil dadurch ein Compilerfehler verschwunden ist, haben Sie ein Lebensdauerproblem mit einem Leistungsproblem gelöst.

## Verwandte Artikel

- [Fix: Cannot consume scoped service 'X' from singleton 'Y'](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Scoped-Dienste in einem BackgroundService in ASP.NET Core 11 verwenden](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [Keyed Services in der Dependency Injection von .NET 11 registrieren und auflösen](/de/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [Fix: No connection string named 'DefaultConnection' could be found](/de/2026/05/fix-no-connection-string-named-defaultconnection/)
- [Integrationstests mit WebApplicationFactory in ASP.NET Core 11 schreiben](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)

## Quellen

- [Optionsmuster in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options), Microsoft Learn
- [Neuerungen in den .NET 11-Bibliotheken](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), Microsoft Learn
- [OptionsServiceCollectionExtensions.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs), dotnet/runtime
- [IOptionsMonitor OnChange löst aus, sobald sich irgendetwas in IConfiguration ändert](https://github.com/dotnet/runtime/issues/109445), dotnet/runtime Issue 109445
- [OptionsMonitor.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsMonitor.cs), dotnet/runtime
- [ChangeToken.OnChange löst zweimal aus, wenn auf Konfigurationsänderungen gelauscht wird](https://github.com/dotnet/aspnetcore/issues/2542), dotnet/aspnetcore Issue 2542
- [Die Gefahren und Stolpersteine von Scoped-Diensten beim Konfigurieren von Optionen](https://andrewlock.net/the-dangers-and-gotchas-of-using-scoped-services-when-configuring-options-in-asp-net-core/), Andrew Lock
