---
title: "Fix: IConfiguration.Bind befüllt eine Array- oder List<T>-Eigenschaft aus appsettings.json nicht"
description: "Der Binder überspringt stillschweigend Array-Eigenschaften ohne öffentlichen Setter, get-only IReadOnlyList<T>, Felder und init-only-Member unter dem Source Generator, und er hängt an Standardwerte an, statt sie zu ersetzen. Gemessen auf .NET 10.0.12 und 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "dotnet-11"
  - "configuration"
  - "options-pattern"
  - "aspnetcore"
lang: "de"
translationOf: "2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Kurze Antwort:** `ConfigurationBinder` wirft nie eine Ausnahme, wenn er eine Collection nicht binden kann. Er lässt die Eigenschaft einfach unverändert. Die üblichen Gründe: Die Eigenschaft ist ein Array (oder `IReadOnlyList<T>`, `IEnumerable<T>`) ohne öffentlichen Setter, sie ist ein öffentliches Feld statt einer Eigenschaft, der an `GetSection` übergebene Abschnittsname passt nicht zum JSON, oder Sie haben Native AOT oder Trimming aktiviert, wodurch der Binder auf seinen Source Generator umschaltet, und der Generator ignoriert `init`-Accessoren. Geben Sie der Eigenschaft ein öffentliches `get; set;`, binden Sie den richtigen Abschnitt und aktivieren Sie `ErrorOnUnknownConfiguration`, damit die nächste Abweichung laut fehlschlägt. Wenn die Liste gebunden wird, aber *zusätzliche* Einträge enthält, ist das die andere Hälfte dieses Fehlers: Der Binder hängt an das an, was die Eigenschaft bereits enthält, er ersetzt es nie.

Alles Folgende wurde mit einer dateibasierten Testanwendung auf SDK 10.0.302 gegen `Microsoft.Extensions.Configuration.Binder` 10.0.12 gemessen und dann mit 11.0.0-rc.1.26425.128 auf dem .NET 11 RC 1 SDK wiederholt. Jede Zeile war in beiden Versionen identisch. Die relevanten Unterschiede liegen zwischen dem Reflection-Binder und dem quellgenerierten Binder, nicht zwischen .NET 10 und 11.

## Warum der Binder eine Collection stillschweigend überspringt

Der Reflection-Binder in `ConfigurationBinder.cs` entscheidet pro Eigenschaft, ob er sie beschreiben kann. Die Prüfung ist kurz: Er braucht einen öffentlichen Getter, und für alles, was er *ersetzen* statt *verändern* muss, zusätzlich einen öffentlichen Setter (oder `BinderOptions.BindNonPublicProperties = true`). Schlägt die Prüfung fehl, kehrt `BindProperty` wortlos zurück.

Diese Unterscheidung zwischen "ersetzen" und "verändern" erklärt die meisten verwirrenden Fälle:

- Ein **Array** lässt sich nie direkt verändern, weil es eine feste Länge hat. Der Binder baut ein neues Array und braucht einen Setter, um es zu speichern. `string[] Hosts { get; } = [];` bleibt für immer leer.
- Eine **`List<T>` oder `IList<T>`**, die bereits eine Instanz enthält, kann verändert werden. Der Binder ruft `Add` darauf auf, daher wird ein get-only `List<string> Hosts { get; } = new();` problemlos gebunden.
- Ein **`IReadOnlyList<T>`** oder **`IEnumerable<T>`** hat kein `Add`. Mit Setter erzeugt der Binder ein neues Array und weist es zu. Ohne Setter passiert nichts.

Auch Konvertierungsfehler bei Elementen werden verschluckt. In `BindArray` und `BindCollection` wird jedes Element innerhalb eines `try`/`catch` gebunden, das nur dann erneut wirft, wenn `ErrorOnUnknownConfiguration` gesetzt ist. Ein Wert wie `"abc"` in einem `int[]` verschwindet einfach aus dem Ergebnis.

## Die gemessene Matrix

Die Testanwendung bindet `{ "App": { "Hosts": [ "a.example", "b.example" ] } }` in verschiedene Formen einer Options-Klasse, einmal mit dem standardmäßigen Reflection-Binder und einmal mit `EnableConfigurationBindingGenerator=true`:

```csharp
// .NET 10.0.12 / .NET 11 RC 1, Microsoft.Extensions.Configuration.Binder
class GetOnlyArray { public string[] Hosts { get; } = []; }
class GetOnlyList { public List<string> Hosts { get; } = new(); }
class GetOnlyRoList { public IReadOnlyList<string> Hosts { get; } = []; }
class FieldArray { public string[] Hosts = []; }
class PrivateSet { public string[] Hosts { get; private set; } = []; }
class InitOnly { public string[] Hosts { get; init; } = []; }
class Settable { public string[] Hosts { get; set; } = []; }
```

| Form der Eigenschaft | Reflection-Binder | Source Generator |
| --- | --- | --- |
| `string[] { get; }` | `[]` | `[]` |
| `List<string> { get; } = new()` | `[a, b]` | `[a, b]` |
| `IReadOnlyList<string> { get; } = []` | `[]` | `[]` |
| `IList<string> { get; } = new List<string>()` | `[a, b]` | `[a, b]` |
| `string[]` als öffentliches Feld | `[]` | `[]` |
| `string[] { get; private set; }` | `[]` | `[]` |
| dasselbe, `BindNonPublicProperties = true` | `[a, b]` | `NotSupportedException` |
| `string[] { get; init; }` | `[a, b]` | `[]` |
| `string[] { get; set; }` | `[a, b]` | `[a, b]` |
| `record Opts(string[] Hosts)` über `Get<T>()` | `[a, b]` | `[a, b]` |
| `ImmutableArray<string> { get; set; }` | `[]` | `NullReferenceException` |

Drei Zeilen verdienen einen zweiten Blick. `init`-Accessoren funktionieren mit Reflection und werden vom Generator stillschweigend übersprungen. `ImmutableArray<T>` wird nie befüllt. Und der Generator-Build dieser Testanwendung meldete **null** Warnungen, sodass Ihnen zur Kompilierzeit nichts auf eines der beiden Probleme hinweist.

## Schritt für Schritt beheben

1. **Prüfen Sie den Abschnittspfad.** `builder.Configuration.GetSection("App")` muss bis zum Eigenschaftsnamen exakt zum JSON passen (der Abgleich ignoriert Groß- und Kleinschreibung, daran liegt es also nicht). Das Binden der Wurzel statt des Abschnitts, der häufigste Tippfehler, lieferte in der Testanwendung `[]`. Geben Sie aus, was die Konfiguration tatsächlich enthält, bevor Sie dem Binder die Schuld geben:

   ```csharp
   // .NET 10 / 11
   foreach (var kv in builder.Configuration.GetSection("App").AsEnumerable())
       Console.WriteLine($"{kv.Key} = {kv.Value}");
   // Among the output you should see:
   // App:Hosts:0 = a.example
   // App:Hosts:1 = b.example
   ```

   Arrays werden zu indizierten Schlüsseln abgeflacht (`App:Hosts:0`, `App:Hosts:1`). Fehlen diese Zeilen, liegt das Problem an der Datei (nicht ins Ausgabeverzeichnis kopiert, falscher Umgebungsname, falsche Verschachtelung), nicht an der Klasse.

2. **Geben Sie der Collection einen öffentlichen Setter.** Das ist die Lösung für die meisten Meldungen:

   ```csharp
   // .NET 10 / 11
   public sealed class AppOptions
   {
       public string[] Hosts { get; set; } = [];
       public List<EndpointOptions> Endpoints { get; set; } = [];
   }

   public sealed class EndpointOptions
   {
       public string Url { get; set; } = "";
   }
   ```

   Verwenden Sie `get; set;`, nicht `init`, wenn das Projekt möglicherweise mit `PublishAot` oder `PublishTrimmed` veröffentlicht wird (siehe unten). Vermeiden Sie `ImmutableArray<T>` in Options-Klassen. Wenn Sie für Konsumenten eine schreibgeschützte Semantik wollen, stellen Sie `IReadOnlyList<T> { get; set; }` bereit: Der Reflection-Binder weist ihr ein `string[]` zu und der Generator eine `List<T>`, und beide wurden in der Testanwendung korrekt befüllt.

3. **Lassen Sie Abweichungen laut fehlschlagen.** `ErrorOnUnknownConfiguration` wirft, wenn die Konfiguration einen Schlüssel ohne passende Eigenschaft enthält, und verhindert außerdem, dass der Binder Konvertierungsfehler bei Elementen verschluckt:

   ```csharp
   // .NET 10 / 11
   builder.Services.AddOptions<AppOptions>()
       .Bind(builder.Configuration.GetSection("App"),
             o => o.ErrorOnUnknownConfiguration = true)
       .ValidateOnStart();
   ```

   Mit `"Host": ["a"]` im JSON (Singular) warf die Testanwendung `InvalidOperationException: 'ErrorOnUnknownConfiguration' was set on the provided BinderOptions, but the following properties were not found on the instance of Settable: 'Host'`. Mit `"Ports": [1, "abc", 3]` warf sie `'ErrorOnUnknownConfiguration' was set and binding has failed`, mit der inneren Ausnahme `Failed to convert configuration value 'abc' at 'App:Ports:1' to type 'System.Int32'`. Ohne die Option lieferte dieselbe Bindung `[1, 3]`.

   Kombinieren Sie das mit Validierung, damit eine leere Liste ein Startfehler statt eines Rätsels in Produktion ist. [Options beim Start mit `IValidateOptions<T>` validieren](/de/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) behandelt die `ValidateOnStart`-Seite im Detail.

4. **Initialisieren Sie Collections nicht mit Standardwerten.** Siehe nächster Abschnitt: An Standardwerte wird angehängt, sie werden nicht ersetzt.

## Der Binder hängt an Standardwerte an, statt sie zu ersetzen

Das ist der Fehler, auf den man direkt nach dem Beheben der leeren Liste stößt. Geben Sie der Eigenschaft einen Standardwert und binden Sie einen Abschnitt mit Werten:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public List<string> Hosts { get; set; } = ["localhost"];
}
// appsettings.json: "App": { "Hosts": [ "a.example", "b.example" ] }
// Result: [ "localhost", "a.example", "b.example" ]
```

Genau das lieferte die Testanwendung für `List<T>`, `string[]`, `IEnumerable<T>`, `IReadOnlyList<T>` und `HashSet<T>` gleichermaßen, und sowohl für `Bind` als auch für `Get<T>()`. `BindArray` beginnt buchstäblich damit, die vorhandenen Elemente in eine neue Liste zu kopieren, bevor die konfigurierten hinzugefügt werden. Zweimaliges Aufrufen von `Bind` auf derselben Instanz, etwa aus einem Change-Token-Callback, ergab `[a, b, a, b]`.

Das ist seit Langem bestehendes, beabsichtigtes Verhalten. Eine Option zum Überschreiben vorhandener Collections wurde 2021 in [dotnet/runtime#62112](https://github.com/dotnet/runtime/issues/62112) vorgeschlagen und ist auf dem Future-Meilenstein weiterhin offen, ebenso wie [dotnet/runtime#118204](https://github.com/dotnet/runtime/issues/118204), warten Sie also nicht auf ein Flag. Wenden Sie Standardwerte *nach* dem Binden an, und nur dann, wenn die Konfiguration nichts geliefert hat:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public string[]? Hosts { get; set; }
}

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection("App"));
builder.Services.PostConfigure<AppOptions>(o => o.Hosts ??= ["localhost"]);
```

In der Testanwendung ergab das `[a, b]`, wenn der Abschnitt existierte, und `[localhost]`, wenn nicht. Die Factory von `IOptionsMonitor<T>` erzeugt bei jedem Neuladen eine frische Instanz, sodass der Post-Configure-Schritt jedes Mal auf einem sauberen Zustand läuft. [IOptions vs. IOptionsSnapshot vs. IOptionsMonitor](/de/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) erklärt, wann jede dieser Instanzen erstellt wird.

## Geschichtete Dateien führen Arrays per Index zusammen

`appsettings.Development.json` ersetzt kein Array aus `appsettings.json`. Konfigurationsanbieter steuern immer nur Schlüssel bei, und der letzte Anbieter, der einen bestimmten Schlüssel setzt, gewinnt. Ein Array besteht nur aus den Schlüsseln `0`, `1`, `2`. Die Testanwendung schichtete diese beiden Dateien:

```json
// appsettings.json
{ "App": { "Hosts": [ "a", "b", "c" ] } }
```

```json
// appsettings.Development.json
{ "App": { "Hosts": [ "dev1", "dev2" ] } }
```

Das gebundene Ergebnis war `[dev1, dev2, c]`. Index 2 stammt weiterhin aus der Basisdatei. Dasselbe passiert mit Umgebungsvariablen (`App__Hosts__0=env.example` ersetzte nur das erste Element) und Befehlszeilenargumenten (`--App:Hosts:2=cli.example` hängte ein drittes an). Die ASP.NET Core-Dokumentation zur Konfiguration weist darauf hin und empfiehlt, die Indizes über alle Quellen hinweg abzustimmen.

Zwei Dinge, mit denen Sie vielleicht versuchen, das Basis-Array zu leeren, funktionieren nicht:

- Ein leeres Array `"Hosts": []` in der überschreibenden Datei: Das Ergebnis war weiterhin `[a, b]`.
- `"Hosts": null` in der überschreibenden Datei: ebenfalls `[a, b]`.

Was funktioniert: das Array in der Basisdatei gar nicht definieren, das vollständige Array in jeder Umgebungsdatei definieren oder den Wert als einzelnen getrennten String speichern und ihn in `PostConfigure` aufteilen. Ein einfaches `"Hosts": "a.example,b.example"`, direkt in `string[]` gebunden, ergibt `[]`, der Binder teilt Strings nicht für Sie auf.

## Native AOT und Trimming tauschen den Binder unbemerkt aus

Das .NET SDK aktiviert den Source Generator für die Konfigurationsbindung automatisch für getrimmte Apps. Aus `Microsoft.NET.Sdk.FrameworkReferenceResolution.targets` in SDK 10.0.302:

```xml
<PropertyGroup Condition="'$(PublishTrimmed)' == 'true' Or '$(PublishAot)' == 'true'">
  <EnableRequestDelegateGenerator Condition="'$(EnableRequestDelegateGenerator)' == ''">true</EnableRequestDelegateGenerator>
  <EnableConfigurationBindingGenerator Condition="'$(EnableConfigurationBindingGenerator)' == ''">true</EnableConfigurationBindingGenerator>
</PropertyGroup>
```

Der Generator fängt Ihre Aufrufe von `Bind`, `Get<T>` und `Configure<T>` zur Kompilierzeit ab. So erhält Native AOT eine Bindung ohne Reflection, aber es ist eine andere Implementierung, und die Testanwendung fand vier Verhaltensunterschiede:

| Fall | Reflection | Source Generator |
| --- | --- | --- |
| `string[] { get; init; }` | bindet | stillschweigend übersprungen |
| `BindNonPublicProperties = true` | bindet private Setter | `NotSupportedException` |
| `"Ports": [1, "abc", 3]` in `int[]` | `[1, 3]` | `InvalidOperationException: Failed to convert configuration value 'abc'` |
| `"Ports": [1, null, 3]` in `int[]` | `InvalidCastException` | `[1, 3]` |
| `ImmutableArray<string>` | `[]` | `NullReferenceException` |

Eine App, die unter `dotnet run` problemlos bindet, kann also anders binden, nachdem jemand `<PublishAot>true</PublishAot>` zum Projekt hinzugefügt hat. Wenn Sie auf AOT umsteigen, setzen Sie `<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>` explizit auch in Debug, damit Ihre Tests denselben Binder wie die Produktion verwenden. [Native AOT mit ASP.NET Core Minimal APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) behandelt die anderen Generatoren, die gleichzeitig aktiviert werden. Dateibasierte Apps (`dotnet run app.cs`) verwenden standardmäßig `PublishAot=true`, eine so geschriebene schnelle Testanwendung läuft also bereits mit dem Generator, sofern Sie nicht `#:property PublishAot=false` hinzufügen.

## Weitere wissenswerte Fälle

- **Lückenhafte Indizes werden verdichtet.** Die Schlüssel `App:Hosts:0` und `App:Hosts:5` wurden zu `[a, f]` gebunden, einem Array mit zwei Elementen, nicht mit sechs Elementen und Lücken. Das Dokumentationsbeispiel zum fehlenden Index 3 zeigt dasselbe.
- **Objektschlüssel funktionieren wie Indizes.** `"Hosts": { "x": "a", "y": "b" }` wurde zu `[a, b]` gebunden. Deshalb schlägt ein JSON-Objekt, wo Sie ein Array gemeint haben, nicht fehl.
- **Null-String-Elemente bleiben erhalten.** `["a", null, "c"]` in `string[]` ergab `[a, null, c]` bei beiden Bindern, obwohl die ASP.NET Core-Dokumentation sagt, dass der Binder keine `null`-Einträge erzeugen kann. Verlassen Sie sich auf keines der beiden Verhalten; filtern Sie Nullwerte in `PostConfigure` oder in der Validierung.
- **Konstruktorbindung funktioniert für Collections.** `record AppOptions(string[] Hosts)` und Elementtypen mit nur einem parametrisierten Konstruktor (`class Endpoint(string url)`) wurden mit `Get<T>()` in beiden Modi korrekt gebunden.
- **`Get<string[]>()` direkt auf dem Array-Abschnitt** (`GetSection("App:Hosts").Get<string[]>()`) ist ein schneller Weg, die Daten unabhängig von Ihrer Options-Klasse zu prüfen.

## So testen Sie Ihre eigene Options-Klasse

Behalten Sie einen Unit-Test, der Ihre echte `appsettings.json` in Ihren echten Options-Typ bindet, mit derselben Generator-Einstellung wie in Produktion:

```csharp
// .NET 10 / 11, xUnit
[Fact]
public void AppOptions_binds_hosts()
{
    var config = new ConfigurationBuilder()
        .AddJsonFile("appsettings.json")
        .Build();

    var options = config.GetSection("App")
        .Get<AppOptions>(o => o.ErrorOnUnknownConfiguration = true);

    Assert.NotNull(options);
    Assert.Equal(new[] { "a.example", "b.example" }, options.Hosts);
}
```

Für eine End-to-End-Abdeckung einschließlich umgebungsspezifischer Dateien und Umgebungsvariablen können Sie mit [Integrationstests mit WebApplicationFactory](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) `IOptions<AppOptions>` aus dem echten Host auflösen.

## Verwandte Artikel

- [Options beim Start mit IValidateOptions<T> in .NET 11 validieren](/de/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) macht aus einer leeren Liste einen Startfehler.
- [IOptions<T> vs. IOptionsSnapshot<T> vs. IOptionsMonitor<T> in .NET 11](/de/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) dazu, wann gebundene Instanzen erstellt und neu aufgebaut werden.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) zu den anderen Source Generatoren, die AOT aktiviert.
- [Integrationstests mit WebApplicationFactory<T> in ASP.NET Core 11 schreiben](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/), um die Konfiguration gegen den echten Host zu testen.

## Quellen

- [Konfiguration in ASP.NET Core: ein Array binden](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/#bind-an-array), Microsoft Learn
- [Source Generator für die Konfigurationsbindung](https://learn.microsoft.com/dotnet/core/extensions/configuration-generator), Microsoft Learn
- [`ConfigurationBinder.cs` bei v10.0.12](https://github.com/dotnet/runtime/blob/v10.0.12/src/libraries/Microsoft.Extensions.Configuration.Binder/src/ConfigurationBinder.cs), dotnet/runtime
- [dotnet/runtime#62112: allow optional overwriting of existing mutable collection instances](https://github.com/dotnet/runtime/issues/62112)
- [dotnet/runtime#118204: default configuration array merging is confusing and error-prone](https://github.com/dotnet/runtime/issues/118204)
- [`Microsoft.Extensions.Configuration.Binder` auf NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Configuration.Binder), getestete Versionen 10.0.12 und 11.0.0-rc.1.26425.128
