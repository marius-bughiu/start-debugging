---
title: "Lösung: Reflection-based serialization has been disabled for this application"
description: "Diese InvalidOperationException bedeutet, dass PublishTrimmed oder PublishAot JsonSerializerIsReflectionEnabledByDefault auf false gesetzt hat. Die Lösung ist ein generierter JsonSerializerContext."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "trimming"
  - "native-aot"
lang: "de"
translationOf: "2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application"
translatedBy: "claude"
translationDate: 2026-07-29
---

In Ihrem Projekt steht `PublishTrimmed` oder `PublishAot` auf `true`, und das .NET SDK hat daraufhin `JsonSerializerIsReflectionEnabledByDefault` auf `false` gesetzt. Damit ist der reflexionsbasierte Contract-Resolver abgeschaltet, auf den sich `JsonSerializer.Serialize(obj)` stillschweigend verlässt. Die Lösung besteht darin, dem Serializer eine Contract-Quelle zu geben: Fügen Sie eine `partial class` hinzu, die von `JsonSerializerContext` ableitet, versehen Sie sie mit `[JsonSerializable(typeof(YourType))]` und übergeben Sie `MyContext.Default.YourType` (oder setzen Sie `options.TypeInfoResolver = MyContext.Default`) an jeder Aufrufstelle.

```text
System.InvalidOperationException: Reflection-based serialization has been disabled for this application. Either use the source generator APIs or explicitly configure the 'JsonSerializerOptions.TypeInfoResolver' property.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_JsonSerializerIsReflectionDisabled()
   at System.Text.Json.JsonSerializerOptions.ConfigureForJsonSerializer()
   at System.Text.Json.JsonSerializerOptions.GetTypeInfoForRootType(Type type, Boolean fallBackToNearestAncestorType)
   at System.Text.Json.JsonSerializer.Serialize[TValue](TValue value, JsonSerializerOptions options)
   at MyApp.Program.Main(String[] args)
```

Der exakte Text stammt aus der Ressource `JsonSerializerIsReflectionDisabled` in `System.Text.Json` und ist seit .NET 8 unverändert formuliert. Alles Folgende zielt auf das .NET 11 SDK (`11.0.100`) und C# 14, das Verhalten ist auf `net8.0` und neuer aber identisch, denn dort wurde der Schalter eingeführt.

## Warum in einem Projekt, das Sie nie konfiguriert haben, Reflexion abgeschaltet ist

`System.Text.Json` ermittelt die Form eines Typs auf zwei Wegen: zur Laufzeit per Reflexion (`DefaultJsonTypeInfoResolver`) oder zur Kompilierzeit per Source Generator (`JsonSerializerContext`). Wenn Sie `JsonSerializer.Serialize(obj)` ohne Optionen aufrufen, greift der reflexionsbasierte Resolver.

Reflexion überlebt das Trimming nicht. Der Trimmer entfernt Member, deren Erreichbarkeit er nicht beweisen kann, und Property-Getter, die nur über `PropertyInfo` aufgerufen werden, sind genau das: für die statische Analyse unerreichbar. Vor .NET 8 hat eine getrimmte App munter serialisiert und dabei stillschweigend die Eigenschaften weggelassen, die der Trimmer gelöscht hatte. Stiller Datenverlust ist schlimmer als ein Absturz, deshalb hat .NET 8 den Standard geändert: `PublishTrimmed` auf `true` zu setzen [setzt automatisch `JsonSerializerIsReflectionEnabledByDefault` auf `false`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed), sofern Sie nichts anderes angeben. `PublishAot` impliziert `PublishTrimmed`, also erben Native-AOT-Apps denselben Standard.

Die MSBuild-Eigenschaft ist nicht der Mechanismus, nur der Schalter. Das SDK macht daraus eine Runtime-Host-Konfigurationsoption:

```xml
<!-- Microsoft.NET.Sdk.targets, .NET 11 SDK -->
<RuntimeHostConfigurationOption Include="System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault"
                                Condition="'$(JsonSerializerIsReflectionEnabledByDefault)' != ''"
                                Value="$(JsonSerializerIsReflectionEnabledByDefault)"
                                Trim="true" />
```

Das landet in Ihrer `.runtimeconfig.json` als `AppContext`-Schalter, und `Trim="true"` weist ILLink an, ihn als Link-Time-Konstante zu behandeln, sodass die reflexionsbasierten Codepfade vollständig entfernt werden können. `JsonSerializer.IsReflectionEnabledByDefault` liest diesen Schalter und [ist standardmäßig `true`, wenn er nicht gesetzt ist](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault).

Daraus folgen zwei Dinge, die die meisten verwirrten Fehlerberichte erklären. Erstens gilt der Schalter pro App, nicht pro Bibliothek: Ein NuGet-Paket kann ihn nicht für Sie abschalten, und Sie können ihn nicht für ein einzelnes Assembly einschalten. Zweitens tritt die Exception beim ersten Gebrauch auf, nicht beim Start. `JsonSerializerOptions.Default` wird mit `JsonTypeInfoResolver.Empty` statt mit dem reflexionsbasierten Resolver konstruiert, und `ConfigureForJsonSerializer` wirft die Exception erst, wenn ein Serialisierungs- oder Deserialisierungsaufruf auf einen leeren Resolver trifft. Sie erfahren es also auf dem Codepfad, der einmal pro Woche läuft.

## Die minimale Reproduktion

Drei Zeilen Projektdatei und eine Zeile C#:

```xml
<!-- MyApp.csproj, .NET 11 SDK 11.0.100 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var json = JsonSerializer.Serialize(new { Value = 42 });
// System.InvalidOperationException: Reflection-based serialization has been disabled...
```

Beachten Sie, wo `PublishTrimmed` steht. Da die Eigenschaft bereits beim **Build** in die `runtimeconfig.json` fließt, wirft auch `dotnet run` im Debug-Modus, wenn sie in der Projektdatei steht. Übergeben Sie sie dagegen nur auf der Publish-Kommandozeile (`dotnet publish -p:PublishTrimmed=true`), funktioniert Ihr lokales `dotnet run` weiter und nur das veröffentlichte Artefakt schlägt fehl. Das ist die Variante dieses Fehlers, die in die Produktion gelangt. Die Trimming-Dokumentation empfiehlt die Projektdatei [genau deshalb, damit die Einstellung auch beim `dotnet build` greift](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options).

Um zu bestätigen, dass Sie wirklich das hier vor sich haben und nichts anderes, prüfen Sie die Build-Ausgabe:

```bash
cat bin/Debug/net11.0/MyApp.runtimeconfig.json
```

```json
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "configProperties": {
      "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": false
    }
  }
}
```

Oder prüfen Sie es im Code, was auch bei Native AOT funktioniert, wo es keine runtimeconfig-Datei zum Lesen gibt:

```csharp
// .NET 11, C# 14
Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault); // False
```

## Lösung 1: Einen JsonSerializerContext ausliefern und überall verwenden

Das ist die Lösung, nach der die Fehlermeldung fragt, und die einzige, die Ihnen eine wirklich trimming-sichere App hinterlässt. Deklarieren Sie einen partiellen Kontext, listen Sie jeden Wurzeltyp auf, den Sie serialisieren, und leiten Sie die Aufrufe darüber.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0
using System.Text.Json;
using System.Text.Json.Serialization;

public record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WeatherForecast))]
[JsonSerializable(typeof(List<WeatherForecast>))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Wählen Sie dann eine der drei unterstützten Aufrufformen:

```csharp
// .NET 11, C# 14
// 1. Strongly typed, zero options plumbing. Preferred.
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);
WeatherForecast? back = JsonSerializer.Deserialize(json, AppJsonContext.Default.WeatherForecast);

// 2. Through options, when an API forces you to hand it a JsonSerializerOptions.
var options = new JsonSerializerOptions { TypeInfoResolver = AppJsonContext.Default };
json = JsonSerializer.Serialize(forecast, options);

// 3. Non-generic, when the type is only known at runtime.
json = JsonSerializer.Serialize(forecast, typeof(WeatherForecast), AppJsonContext.Default);
```

Setzen Sie Ihre Optionen nach Möglichkeit über `[JsonSourceGenerationOptions]` statt über eine `JsonSerializerOptions`-Instanz. Die generierte `Default`-Eigenschaft ist dann zur Kompilierzeit vorkonfiguriert, und Sie können nicht vergessen, die Namensrichtlinie an einer von sechs Aufrufstellen anzuwenden. Collections brauchen einen eigenen `[JsonSerializable]`-Eintrag (`List<WeatherForecast>` oben), und als `object` deklarierte Member brauchen jeden möglichen Laufzeittyp registriert, weil der Generator sonst nichts hat, woran er sich orientieren könnte.

## Lösung 2: Den Kontext in ASP.NET Core, HttpClient und Blazor einhängen

Die meisten Apps rufen `JsonSerializer` nicht direkt auf. Sie übergeben einen Typ an eine Framework-Methode, die den Aufruf für sie erledigt, und dort muss der Resolver einmalig beim Start eingehängt werden.

Für Minimal APIs, einschließlich der Native-AOT-Vorlage mit `CreateSlimBuilder`:

```csharp
// .NET 11, ASP.NET Core 11
var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});
```

Für MVC- und Web-API-Controller:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(static options =>
    options.JsonSerializerOptions.TypeInfoResolverChain.Add(AppJsonContext.Default));
```

Für `HttpClient` verwenden Sie die Überladungen, die ein `JsonTypeInfo<T>` entgegennehmen, statt derjenigen, die es ableiten:

```csharp
// .NET 11, C# 14
var forecast = await client.GetFromJsonAsync("/weather", AppJsonContext.Default.WeatherForecast);
await client.PostAsJsonAsync("/weather", forecast, AppJsonContext.Default.WeatherForecast);
```

`TypeInfoResolverChain` ist für sich genommen erwähnenswert: Die Optionen fragen jeden Resolver der Reihe nach ab und nehmen das erste Ergebnis ungleich null. So können Sie mehrere Kontexte aus verschiedenen Projekten mit `JsonTypeInfoResolver.Combine(ContextA.Default, ContextB.Default)` zusammensetzen oder einen vor den des Frameworks schieben.

## Lösung 3: Reflexion an der Aufrufstelle wieder aktivieren, ohne MSBuild anzufassen

Die Fehlermeldung bietet einen zweiten Ausweg: "explicitly configure the `JsonSerializerOptions.TypeInfoResolver` property". Der reflexionsbasierte Resolver ist weiterhin ein öffentlicher Typ, und seine Konstruktion prüft den Schalter nicht:

```csharp
// .NET 11, C# 14. Works in a trimmed app. Does NOT work under Native AOT.
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};
string json = JsonSerializer.Serialize(new { Value = 42 }, options);
```

Machen Sie sich klar, was Sie damit kaufen. Die Exception verschwindet, weil Sie Reflexion namentlich angefordert haben, aber der Trimmer hat die vermeintlich ungenutzten Member bereits gelöscht. Sie bekommen eine Serialisierung, die durchläuft und stillschweigend ein unvollständiges Objekt ausgibt, also genau den Fehlermodus, den die Änderung in .NET 8 verhindern sollte. Unter Native AOT ist es schlimmer: `DefaultJsonTypeInfoResolver` ist mit `[RequiresDynamicCode]` annotiert, Sie tauschen die `InvalidOperationException` also gegen eine `PlatformNotSupportedException` oder einen Laufzeitfehler wegen fehlender Metadaten. Behandeln Sie das als Diagnoseschritt (übersteht meine Payload das Trimming?) und nicht als Lösung.

Wirklich nützlich ist der bedingte Resolver, den die Dokumentation für Bibliotheken empfiehlt, die in beiden Welten funktionieren müssen:

```csharp
// .NET 11, C# 14
static JsonSerializerOptions CreateDefaultOptions() => new()
{
    TypeInfoResolver = JsonSerializer.IsReflectionEnabledByDefault
        ? new DefaultJsonTypeInfoResolver()
        : AppJsonContext.Default
};
```

Da `IsReflectionEnabledByDefault` als Link-Time-Konstante ersetzt wird, faltet ILLink den Zweig weg und verankert den reflexionsbasierten Resolver in einem AOT-Build nie.

## Lösung 4: Den Schalter zurückdrehen, und wann das vertretbar ist

Mit einer einzigen Eigenschaft stellen Sie das Verhalten von .NET 7 wieder her:

```xml
<!-- MyApp.csproj, .NET 11 SDK -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <JsonSerializerIsReflectionEnabledByDefault>true</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Tun Sie das, wenn eine Drittanbieter-Abhängigkeit tief in ihrem eigenen Code `JsonSerializer.Serialize` auf ihre eigenen Typen aufruft und keinen `JsonSerializerContext` mitliefert. Sie können deren Aufrufstellen nicht umschreiben, und ein Source Generator in Ihrem Assembly hilft nicht, weil der Resolver an der Optionsinstanz hängen muss, die die Bibliothek erzeugt. Mehrere weit verbreitete Pakete sind darüber gestolpert: Es hat unter anderem Fehlerberichte gegen den Azure App Configuration Provider und gegen den Swagger-UI-Endpunkt von ASP.NET Core ausgelöst.

Zwei Einschränkungen. Erstens holen Sie sich damit den stillen Datenverlust zurück: Der reflexionsbasierte Resolver läuft, aber nur über die Member, die das Trimming überlebt haben. Testen Sie also das tatsächlich veröffentlichte Artefakt gegen echte Payloads, statt einem erfolgreichen `dotnet run` zu vertrauen. Zweitens: Unter Native AOT bringt das Umlegen dieser Eigenschaft die Reflexion nicht zum Laufen, es entfernt nur die Leitplanke, die Ihnen früh die Wahrheit gesagt hat.

## Fallstricke, die zur falschen Lösung führen

**Der nächste Fehler heißt `NoMetadataForType`.** Nachdem Sie einen Kontext hinzugefügt haben, wirft ein Typ, den Sie zu annotieren vergessen haben, `JsonTypeInfo metadata for type 'X' was not provided by TypeInfoResolver of type 'Y'`. Das ist Fortschritt, keine Regression: Der fehlende Typ wird benannt. Ergänzen Sie ein `[JsonSerializable(typeof(X))]` dafür, auch für Collection-Typen und für jeden Subtyp, den Sie polymorph serialisieren. Bei `[JsonDerivedType]` braucht jeder abgeleitete Typ einen eigenen Eintrag, was der Leitfaden zur [polymorphen Serialisierung mit `JsonDerivedType`](/de/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) im Detail behandelt.

**Es gibt keine Warnung zur Kompilierzeit.** Der naheliegende Wunsch, ein Analyzer, der `JsonSerializer.Serialize(x)` bei abgeschaltetem Schalter markiert, wurde als [dotnet/runtime#107440](https://github.com/dotnet/runtime/issues/107440) eingereicht und als nicht geplant geschlossen. Die Trim-Analyse-Warnungen (`IL2026`, `IL3050`) zeigen immerhin auf reflexionsbasierte Serialisierung in Ihrem eigenen Code, behandeln Sie einen sauberen Trim-Analyse-Build also als das, was einer Prüfung zur Kompilierzeit am nächsten kommt. Wie Sie dorthin kommen, behandelt der Beitrag über [trimming-sicheren Code](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**In .NET MAUI tritt es nur im Release oder nur auf dem Gerät auf.** MAUI setzt die Trimming-Eigenschaften für Sie: Android und Mac Catalyst nutzen partielles Trimming für Release-Builds, iOS nutzt es für jeden Gerätebuild unabhängig von der Konfiguration, während Simulator-Builds gar nicht getrimmt werden. "Funktioniert im Simulator, schlägt auf einem echten iPhone fehl" und "funktioniert im Debug, schlägt im Release fehl" sind also derselbe Fehler. Setzen Sie `PublishTrimmed` in einem MAUI-Projekt nicht selbst, das SDK verwaltet die Eigenschaft.

**Eine `PlatformNotSupportedException` ist ein anderer Fehler.** Wenn Ihr Stack Trace `Reflection.Emit` oder das Kompilieren von Expression Trees nennt statt `ConfigureForJsonSerializer`, sehen Sie den fehlenden JIT unter AOT, nicht den JSON-Schalter. Das behandelt der Beitrag über [`PlatformNotSupportedException` unter Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/).

**Der nicht generische `JsonStringEnumConverter` wird unter AOT nicht unterstützt.** Sobald Sie auf Source Generation umgestellt haben, ersetzen Sie ihn durch `JsonStringEnumConverter<TEnum>` am Enum oder setzen Sie `UseStringEnumConverter = true` in `[JsonSourceGenerationOptions]`. Dieselbe Einschränkung gilt für handgeschriebene Converter, was Sie an den Regeln zum [Schreiben eines eigenen `JsonConverter`](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) abgleichen sollten.

**Es bewusst einzuschalten ist eine legitime Entscheidung.** Wenn Sie diesen Fehler in einer nicht getrimmten App haben wollen, damit AOT-Inkompatibilitäten schon während der Entwicklung auf CoreCLR auffallen, setzen Sie `JsonSerializerIsReflectionEnabledByDefault` selbst auf `false`. Das Verhalten ist auf CoreCLR und Native AOT konsistent, und genau das macht die Eigenschaft zu einem guten Frühwarnsystem. Diese eigenständige Nutzung behandelt die ältere Notiz zum [Abschalten der reflexionsbasierten Serialisierung](/de/2023/10/system-text-json-disable-reflection-based-serialization/).

## Verwandte Beiträge

- [Was ist trimming-sicherer Code und wie schreibt man ihn?](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Lösung: PlatformNotSupportedException unter Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [Eine polymorphe Typhierarchie mit JsonDerivedType serialisieren](/de/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Native AOT mit Minimal APIs in ASP.NET Core verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Quellen

- [Breaking change: PublishTrimmed projects fail reflection-based serialization](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed) - MS Learn
- [How to use source generation in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation), einschließlich des Abschnitts "Disable reflection defaults" - MS Learn
- [Eigenschaft JsonSerializer.IsReflectionEnabledByDefault](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault) - MS Learn
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options) - MS Learn
- [Trim a .NET MAUI app](https://learn.microsoft.com/en-us/dotnet/maui/deployment/trimming), für die plattformspezifischen Trimming-Standards - MS Learn
- [System.Text.Json analyzers should warn about using reflection when reflection is disabled](https://github.com/dotnet/runtime/issues/107440) - dotnet/runtime
- [`JsonSerializerOptions.ConfigureForJsonSerializer`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/JsonSerializerOptions.cs) und die String-Ressource `JsonSerializerIsReflectionDisabled` - dotnet/runtime
