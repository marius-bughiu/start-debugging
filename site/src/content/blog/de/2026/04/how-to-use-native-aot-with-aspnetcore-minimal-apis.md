---
title: "Native AOT mit ASP.NET Core Minimal APIs verwenden"
description: "Eine vollständige .NET-11-Anleitung zum Ausliefern einer ASP.NET Core Minimal API mit Native AOT: PublishAot, CreateSlimBuilder, quellgenerierte JSON-Serialisierung, die AddControllers-Einschränkung, IL2026-/IL3050-Warnungen und EnableRequestDelegateGenerator für Bibliotheksprojekte."
pubDate: 2026-04-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "de"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Um eine ASP.NET Core Minimal API mit Native AOT auf .NET 11 auszuliefern, setzen Sie `<PublishAot>true</PublishAot>` in der `.csproj`, bauen Sie den Host mit `WebApplication.CreateSlimBuilder` statt `CreateBuilder` und registrieren Sie einen `JsonSerializerContext`-Source-Generator über `ConfigureHttpJsonOptions`, sodass jeder Anfrage- und Antworttyp ohne Reflection erreichbar ist. Alles, was nicht Minimal API oder gRPC ist, einschließlich `AddControllers`, Razor, SignalR-Hubs und EF-Core-Querytrees über POCO-Graphen, erzeugt beim Publish IL2026- oder IL3050-Warnungen und verhält sich zur Laufzeit unvorhersehbar. Diese Anleitung läuft den vollständigen Weg auf `Microsoft.NET.Sdk.Web` mit .NET 11 SDK und C# 14 ab, einschließlich der Teile, die das neue Projekt-Template vor Ihnen verbirgt, und endet mit einer Checkliste, mit der Sie bestätigen können, dass das veröffentlichte Binary tatsächlich keinen JIT braucht.

## Die zwei Projektflags, die alles ändern

Eine Native-AOT-Minimal-API ist ein normales ASP.NET-Core-Projekt mit zwei zusätzlichen MSBuild-Eigenschaften. Die erste schaltet den Publish-Pfad von CoreCLR auf ILC, den AOT-Compiler. Die zweite weist den Analyzer an, Ihren Build in dem Moment zum Scheitern zu bringen, in dem Sie nach einer API greifen, die Codegenerierung zur Laufzeit erfordert.

```xml
<!-- .NET 11, C# 14 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>

    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

`PublishAot` macht die Schwerstarbeit. Es aktiviert die Native-AOT-Kompilierung während `dotnet publish` und schaltet vor allem auch die Analyse für dynamischen Code im Build und im Editor an, sodass IL2026 (`RequiresUnreferencedCode`) und IL3050 (`RequiresDynamicCode`) bereits in der IDE aufleuchten, bevor Sie überhaupt zum Publish kommen. Microsoft dokumentiert das in der [Native-AOT-Deployment-Übersicht](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/).

`InvariantGlobalization` ist nicht zwingend nötig, aber ich lasse es bei neuen Projekten aktiv. Native AOT bündelt die ICU-Datendatei unter Linux standardmäßig nicht, und ein kulturabhängiger Stringvergleich über einen Anfrage-Payload wirft in Produktion `CultureNotFoundException`, wenn man es vergisst. Liefern Sie Globalisierung explizit aus, wenn Sie sie tatsächlich brauchen.

Das neue Projekt-Template (`dotnet new webapiaot`) fügt außerdem `<StripSymbols>true</StripSymbols>` und `<TrimMode>full</TrimMode>` hinzu. `TrimMode=full` ist durch `PublishAot=true` impliziert, also redundant, aber harmlos zu behalten.

## CreateSlimBuilder ist nicht CreateBuilder mit kleinerem Namen

Die größte Verhaltensänderung zwischen einer normalen Minimal API und einer AOT-Variante ist der Host-Builder. `WebApplication.CreateBuilder` verdrahtet jedes gängige ASP.NET-Core-Feature: HTTPS, HTTP/3, Hosting-Filter, ETW, umgebungsvariablenbasierte Konfigurationsanbieter und einen Standard-JSON-Serializer mit Reflection-Fallback. Vieles davon ist nicht Native-AOT-kompatibel, daher verwendet das AOT-Template `CreateSlimBuilder`, dokumentiert in der Referenz [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0) und in .NET 11 unverändert.

```csharp
// .NET 11, C# 14
// PackageReference: Microsoft.AspNetCore.OpenApi 11.0.0
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

var app = builder.Build();

var todos = app.MapGroup("/todos");
todos.MapGet("/", () => Todo.Sample);
todos.MapGet("/{id:int}", (int id) =>
    Todo.Sample.FirstOrDefault(t => t.Id == id) is { } t
        ? Results.Ok(t)
        : Results.NotFound());

app.Run();

public record Todo(int Id, string Title, bool Done)
{
    public static readonly Todo[] Sample =
    [
        new(1, "Try Native AOT", true),
        new(2, "Profile cold start", false),
    ];
}

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Drei Dinge an dem Beispiel sind wichtig und leicht zu übersehen:

1. `CreateSlimBuilder` registriert standardmäßig kein HTTPS und kein HTTP/3. Der Slim-Builder enthält JSON-Datei-Konfiguration für `appsettings`, User Secrets, Konsolen-Logging und Logging-Konfiguration, lässt aber bewusst Protokolle weg, die typischerweise von einem TLS-Termination-Proxy übernommen werden. Wenn Sie das ohne Nginx, Caddy oder YARP davor laufen lassen, fügen Sie explizit `Kestrel.Endpoints`-Konfiguration hinzu.
2. `MapGroup("/todos")` ist in derselben Datei wie `Program.cs` in Ordnung. Verschieben Sie es in eine andere Datei desselben Projekts, und Sie sehen IL3050, sofern Sie nicht zusätzlich den Request-Delegate-Generator einschalten. Dazu gleich mehr.
3. Der JSON-Context fügt sich an Index `0` der Resolver-Kette ein, hat also Vorrang vor dem reflection-basierten Standard-Resolver. Ohne `Insert(0, ...)` kann der Antwort-Writer von ASP.NET Core für Typen, die Sie nicht registriert haben, weiterhin auf Reflection zurückfallen, was zur Laufzeit im AOT-Modus eine `NotSupportedException` erzeugt.

## JSON: Der einzige Serializer ist der, den Sie generieren

`System.Text.Json` hat zwei Modi. Der Reflection-Modus läuft zur Laufzeit über jede Property, was sowohl mit Trimming als auch mit AOT inkompatibel ist. Der Source-Generation-Modus emittiert zur Compile-Zeit Metadaten für jeden registrierten Typ und ist vollständig AOT-sicher. Native AOT erfordert Source Generation für jeden Typ, den Sie in einen HTTP-Request-Body hinein- oder aus ihm herausreichen. Das ist die größte Quelle für "kompiliert sauber, wirft zur Laufzeit"-Bugs.

Der minimal lebensfähige `JsonSerializerContext`:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
[JsonSerializable(typeof(List<Todo>))]
[JsonSerializable(typeof(ProblemDetails))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Jeder Typ, der über die Leitung geht, muss in dieser Klasse stehen, einschließlich der `T[]`- und `List<T>`-Formen, die Sie tatsächlich aus Minimal-API-Endpunkten zurückgeben. Der Antwort-Writer von ASP.NET Core wickelt `IEnumerable<T>` im AOT-Modus nicht für Sie aus. Wenn Sie `Enumerable.Range(...).Select(...)` zurückgeben, registrieren Sie `IEnumerable<Todo>` mit oder materialisieren Sie zuerst in ein Array.

Drei Fallen, die selbst sorgfältige Autoren beißen:

- **`Results.Json(value)` versus `return value`**: Einen Wert direkt zurückzugeben funktioniert, weil das Framework den statischen Rückgabetyp kennt. Ihn in `Results.Json(value)` zu verpacken, ohne `JsonTypeInfo<T>` mitzugeben, fällt auf den Default-Serializer zurück und kann zur Laufzeit im AOT-Modus werfen. Verwenden Sie die Überladung von `Results.Json`, die `JsonTypeInfo<T>` aus Ihrem generierten Context entgegennimmt, oder geben Sie den Wert einfach zurück.
- **Polymorphismus**: `[JsonDerivedType(typeof(Cat))]` funktioniert unter AOT, aber der Basistyp und jeder abgeleitete Typ müssen im Context stehen. Plain-`object`-Rückgaben verlangen eine Registrierung `JsonSerializable(typeof(object))`, was dann jede Form erzwingt, die er sehen kann, also bevorzugen Sie konkrete Typen.
- **`IFormFile` und `HttpContext.Request.ReadFromJsonAsync`**: Form-Parameter-Binding für Primitive funktioniert unter AOT, aber `ReadFromJsonAsync<T>()` ohne Context wirft. Geben Sie `AppJsonContext.Default.T` immer als zweites Argument mit.

Andrew Locks [Tour durch den Minimal-API-Source-Generator](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/) und Martin Costellos Walkthrough zu [JSON-Source-Generatoren mit Minimal APIs](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/) decken das ursprüngliche .NET-8-Design ab, das .NET 11 unverändert übernimmt.

## Bibliotheksprojekte brauchen EnableRequestDelegateGenerator

Der Minimal-API-Source-Generator verwandelt jeden `MapGet(...)`, `MapPost(...)` und so weiter zur Compile-Zeit in ein streng typisiertes `RequestDelegate`. Wenn `PublishAot=true` gesetzt ist, aktiviert das SDK diesen Generator automatisch für das Webprojekt. Es aktiviert ihn **nicht** für Bibliotheksprojekte, die Sie referenzieren, auch wenn diese Bibliotheken über Erweiterungsmethoden selbst `MapGet` aufrufen.

Das Symptom sind IL3050-Warnungen beim Publish, die auf Ihre Bibliothek zeigen und sich beklagen, dass `MapGet` Reflection auf einem Delegate ausführt. Der Fix ist eine MSBuild-Eigenschaft in der Bibliothek:

```xml
<!-- Library project that defines endpoint extension methods -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <IsAotCompatible>true</IsAotCompatible>
    <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
  </PropertyGroup>
</Project>
```

`IsAotCompatible=true` schaltet alle vier Trim- und AOT-Analyzer ein, und `EnableRequestDelegateGenerator=true` lenkt die `Map*`-Aufrufe der Bibliothek auf den generierten Pfad. Ohne Letzteres kann die Bibliothek als AOT-kompatibel markiert sein und trotzdem IL3050 emittieren, weil der Analyzer die `Delegate.DynamicInvoke`-artigen Aufrufstellen in `RouteHandlerBuilder` so sieht. Das dotnet/aspnetcore-Team verfolgt die rauen Kanten in [Issue #58678](https://github.com/dotnet/aspnetcore/issues/58678).

Wenn die Bibliothek sowohl in AOT- als auch in Nicht-AOT-Projekten wiederverwendbar sein soll, lassen Sie die Eigenschaft drin. Der Generator fällt in regulären CoreCLR-Builds anmutig auf den Laufzeitpfad zurück.

## Was Sie aufgeben müssen

Native AOT ist kein Schalter, den Sie an einem fertigen MVC-Monolithen umlegen. Die Liste der nicht unterstützten Subsysteme ist kurz, aber tragend.

- **MVC-Controller**: `AddControllers()` ist das kanonische Beispiel. Die API ist nicht trim-sicher und wird von Native AOT nicht unterstützt. Das dotnet/aspnetcore-Team verfolgt die langfristige Unterstützung in [Issue #53667](https://github.com/dotnet/aspnetcore/issues/53667), aber Stand .NET 11 gibt es keinen AOT-Pfad für `[ApiController]`-dekorierte Klassen. Entweder schreiben Sie die Endpunkte als Minimal APIs um, oder Sie liefern kein AOT aus. Modelle und Filter lehnen sich für sicheres Trimmen durch ILC zu stark auf Reflection und Laufzeit-Modelbinding.
- **Razor Pages und MVC-Views**: gleicher Grund. Beide hängen von Laufzeit-View-Kompilierung ab. Sie kompilieren unter `PublishAot=true`, wenn Sie sie nicht verwenden, aber `AddRazorPages()` zu registrieren lässt IL2026 aufleuchten.
- **SignalR-Server-Hubs**: unter AOT in .NET 11 nicht unterstützt. Die Client-Pakete haben AOT-freundliche Modi, der Hub-Host nicht.
- **EF Core**: Die Laufzeit funktioniert, aber Query-Übersetzung, die auf Reflection über POCO-Property-Graphen angewiesen ist, kann IL2026 erzeugen, sofern Sie nicht auf Compiled Queries und quellgenerierte Konfiguration setzen. Für die meisten AOT-Services ist der richtige Schritt Dapper plus eine handgeschriebene `SqlClient`-Konfiguration, oder EF Core nur für einfachen Zugriff im Stil von `DbSet<T>.Find()`.
- **Reflection-lastige DI-Muster**: Alles, was `IEnumerable<IPlugin>` aus einer gescannten Assembly auflöst, ist unter Trimming brüchig. Registrieren Sie konkrete Typen explizit, oder verwenden Sie einen quellgenerierten DI-Container.
- **`AddOpenApi()`**: Die OpenAPI-Integration aus .NET 9 ist AOT-kompatibel, aber Versionen von `Swashbuckle.AspNetCore` vor dem AOT-bewussten Refactor emittieren weiterhin IL2026. Wenn Sie OpenAPI in einer AOT-Minimal-API brauchen, verwenden Sie das eingebaute Paket [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi) und sparen sich Swashbuckle.

Das Thinktecture-Team hat eine [lesbare Übersicht der unterstützten und nicht unterstützten Szenarien](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/) veröffentlicht, auf die ich beim Onboarding eines Teams in Native AOT zurückgreife.

## IL2026 und IL3050 wie ein Profi lesen

Die zwei Warnungen, mit denen Sie kämpfen werden, sind leicht zu verwechseln:

- **IL2026** bedeutet, der Aufruf erfordert nicht referenzierten Code. Die Implementierung liest Mitglieder per Reflection, die der Trimmer sonst entfernen würde. Häufige Ursache: einen Laufzeit-`Type` an eine Serializer-Überladung übergeben, `GetProperties()` aufrufen oder `Activator.CreateInstance(Type)` verwenden.
- **IL3050** bedeutet, der Aufruf erfordert dynamische Codegenerierung. Selbst mit allen erhaltenen Mitgliedern braucht die Implementierung `Reflection.Emit` oder einen vergleichbaren JIT-Codegen-Schritt, den es in AOT nicht gibt. Häufige Ursache: `JsonSerializer.Serialize(object)`-Überladungen, `MakeGenericType` auf einem noch nicht instanziierten Generic, Expression-Tree-Compile.

Beide werden vom `IsAotCompatible`-Analyzer aufgefangen, aber nur IL2026 wird vom reinen Trimming-Analyzer angezeigt. Ich führe während der Entwicklung immer einen einmaligen Publish nach `bin\publish` von der Kommandozeile aus, um beide auf einmal sichtbar zu machen:

```bash
dotnet publish -c Release -r linux-x64 -o ./publish
```

Eine zweite Falle: dotnet/sdk [Discussion #51966](https://github.com/dotnet/sdk/discussions/51966) verfolgt ein wiederkehrendes Problem, bei dem Visual Studio 2026 und `dotnet build` IL2026 / IL3050 in manchen Konfigurationen verschlucken, `dotnet format` sie aber zeigt. Wenn Ihr Team Visual Studio nutzt, ergänzen Sie einen CI-Schritt, der `dotnet publish` gegen die AOT-Laufzeit ausführt, sodass eine übersehene Warnung die Pipeline scheitern lässt.

Wenn Sie eine Reflection nutzende API nicht vermeiden können, lässt sich die Warnung an der Aufrufstelle mit den Attributen `[RequiresUnreferencedCode]` und `[RequiresDynamicCode]` an der umhüllenden Methode unterdrücken, wodurch sich die Anforderung nach oben fortpflanzt. Tun Sie das nur, wenn Sie wissen, dass die konsumierenden Codepfade nicht auf der AOT-Publish-Oberfläche liegen. Eine Unterdrückung innerhalb eines Endpunkt-Handlers ist fast immer falsch.

## Verifizieren, dass das Binary tatsächlich funktioniert

Ein sauberer Publish beweist nicht, dass die App unter AOT startet. Drei Prüfungen, die ich durchführe, bevor ich Sieg verkünde:

```bash
# 1. The output is a single static binary, not a CoreCLR loader.
ls -lh ./publish
file ./publish/MyApi
# Expected on Linux: "ELF 64-bit LSB pie executable ... statically linked"

# 2. The runtime never loads the JIT.
LD_DEBUG=libs ./publish/MyApi 2>&1 | grep -E "libcoreclr|libclrjit"
# Expected: empty output. If libclrjit.so loads, you accidentally shipped a runtime fallback.

# 3. A real request round-trips with the source generator.
./publish/MyApi &
curl -s http://localhost:5000/todos | head -c 200
```

Die dritte Prüfung ist die wichtige. Der klassische Fehlerfall ist "kompiliert, publisht, startet, gibt bei der ersten Anfrage 500 zurück", weil ein Rückgabetyp im JSON-Context fehlt. Klopfen Sie jeden Endpunkt mindestens einmal mit einem repräsentativen Payload ab, bevor Sie ausliefern.

Für Container-Deployments ist Build mit `--self-contained true` unter `PublishAot=true` impliziert. Die Ausgabe `./publish/MyApi` plus zugehörige `.dbg`-Datei ist die gesamte Deploy-Einheit. Eine typische Minimal API in .NET 11 landet bei 8-12 MB stripped, gegenüber 80-90 MB eines self-contained CoreCLR-Publish.

## Verwandte Anleitungen auf Start Debugging

- Der Native-AOT-Hebel sitzt in einer breiteren Cold-Start-Geschichte: [das .NET-11-AWS-Lambda-Cold-Start-Playbook](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) läuft den AOT-auf-`provided.al2023`-Pfad mit demselben Source-Generator-Setup ab.
- Für OpenAPI auf einer AOT-Minimal-API behandelt die [Anleitung zur OpenAPI-Client-Generierung](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) den Round Trip von Minimal-API-Metadaten zu einem typisierten `HttpClient`.
- AOT-Projekte verbieten reflection-basiertes JSON, daher ist [einen eigenen `JsonConverter` in System.Text.Json schreiben](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) der richtige Einstieg, wenn eine eingebaute Konvertierung nicht ausreicht.
- Eine saubere Exception-Geschichte zählt unter AOT mehr, wo reflection-basierte Diagnostik nicht zur Verfügung steht: [einen globalen Exception-Filter in ASP.NET Core 11 ergänzen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) zeigt den `IExceptionHandler`-Pfad, der vollständig AOT-kompatibel ist.

## Quellen

- [ASP.NET Core support for Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [Native AOT deployment overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [Source generation in System.Text.Json (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [aspnetcore#58678 - Map* AOT warnings outside Program.cs](https://github.com/dotnet/aspnetcore/issues/58678)
- [aspnetcore#53667 - Native AOT support for MVC](https://github.com/dotnet/aspnetcore/issues/53667)
- [Andrew Lock - Exploring the new minimal API source generator](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/)
- [Martin Costello - Using JSON source generators with minimal APIs](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/)
- [Thinktecture - Native AOT with ASP.NET Core, an overview](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/)
