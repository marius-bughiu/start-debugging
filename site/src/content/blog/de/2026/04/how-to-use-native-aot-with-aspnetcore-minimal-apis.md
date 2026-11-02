---
title: "Native AOT mit ASP.NET Core Minimal APIs verwenden"
description: "Eine Minimal API für Native AOT mit generierten JSON-Metadaten konfigurieren. Builder, Zielplattform, Warnungen und Funktionsgrenzen verstehen."
pubDate: 2026-04-27
updatedDate: 2026-11-02
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

Native AOT übersetzt eine Anwendung beim Veröffentlichen in nativen Code. Startzeit, Paketgröße und Speicherbedarf können sich ändern; das Ergebnis hängt von Anwendung und Ziel ab. Nicht jede ASP.NET-Core-Funktion oder Abhängigkeit wird dadurch kompatibel.

**Korrektur — 2. November 2026:** Die frühere Fassung erklärte `CreateSlimBuilder` zur Pflicht, schloss alle SignalR-Server aus, band Codegenerierung an `Program.cs` und übertrieb JSON- sowie Globalisierungsgrenzen. Das Ersatzbeispiel zielt auf .NET 10; eine Ausführung unter .NET 11 wird nicht behauptet.

## Anwendung mit expliziten JSON-Metadaten

Erstellen Sie das Projekt `MyApi` mit dieser Projektdatei:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Dazu diese `Program.cs`:

```csharp
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));

var app = builder.Build();
app.MapGet("/todos", () => TypedResults.Ok(new[] { new Todo(1, "Write docs", false) }));
app.MapPost("/todos", (Todo todo) => TypedResults.Ok(todo));
app.Run();

public record Todo(int Id, string Title, bool IsComplete);

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

`PublishAot` aktiviert die entsprechende AOT-Analyse und Request-Delegate-Generierung im Web-SDK-Projekt. Der JSON-Kontext enthält Metadaten für die verwendeten Wurzeltypen. Weitere Wurzeln und polymorphe Typen müssen passend zum Vertrag registriert werden; `object` erfasst nicht beliebige Laufzeittypen.

Der Request-Delegate-Generator arbeitet über die Quelldateien des Projekts hinweg. Eine Routen-Erweiterungsmethode außerhalb von `Program.cs` ist nicht allein deshalb inkompatibel. Eine separate Bibliothek benötigt passende ASP.NET-Core-Referenzen und Generatorunterstützung; eine einzelne Property genügt nicht für beliebigen Code.

## Für eine konkrete Plattform veröffentlichen

```sh
# Use the RID and native toolchain for your deployment target.
# This command is for an Apple Silicon Mac:
dotnet publish -c Release -r osx-arm64 -o ./publish
./publish/MyApi --urls http://127.0.0.1:5080
# Replace MyApi with your project's executable name.
```

Installieren Sie die erforderliche native Toolchain. Native AOT unterstützt normalerweise keine Veröffentlichung für ein anderes Betriebssystem; verwenden Sie einen passenden Build-Host oder Container. Self-contained bedeutet, dass die verwaltete Runtime nicht separat installiert werden muss, nicht vollständige statische Verknüpfung oder Unabhängigkeit von Systembibliotheken.

Testen Sie die veröffentlichte Binärdatei einschließlich Endpunkten, Serialisierung, Authentifizierung und Fehlern. `dotnet run` nutzt gewöhnlich JIT und ersetzt diesen Test nicht. Prüfen Sie alle Trimming- und AOT-Warnungen. Sie lassen den Publish nicht automatisch scheitern; dafür müssen Warnungen als Fehler konfiguriert werden. `IL2026` betrifft Trimming-Anforderungen, `IL3050` dynamischen Code. Attribute wie `RequiresDynamicCode` geben Anforderungen weiter, reparieren aber keine Inkompatibilität.

## Builder, JSON und Globalisierung

`CreateSlimBuilder` startet mit weniger Funktionen und ist ein geeigneter Ausgangspunkt, keine Pflicht. `CreateBuilder` ist möglich, wenn die ausgewählten Funktionen und Abhängigkeiten kompatibel sind. Der schlanke Builder aktiviert HTTPS und HTTP/3 nicht standardmäßig; ergänzen Sie die nötige Kestrel-Unterstützung oder terminieren Sie TLS an einem vertrauenswürdigen Proxy. Endpunktkonfiguration allein ergänzt keine fehlende Protokollunterstützung.

Ein generierter Resolver schaltet Reflexion nicht automatisch in jedem Ausführungsmodus ab. Native AOT benötigt passende Metadaten; unbekannte JSON-Typen können zur Laufzeit scheitern. `Results.Json(value)` und `ReadFromJsonAsync<T>()` können konfigurierte Optionen und generierte Metadaten verwenden und sind nicht grundsätzlich verboten. Explizite `JsonTypeInfo<T>`-Überladungen machen den Vertrag am Aufruf sichtbar.

`InvariantGlobalization` beeinflusst das Anwendungsverhalten und ist kein Warnungsschalter. Für kulturabhängiges Verhalten müssen Unterstützung und Zielplattform-Abhängigkeiten erhalten bleiben. Aktivieren Sie den Modus nicht bloß zur Warnungsunterdrückung und erwarten Sie keine unveränderte Kultursemantik.

## Funktionen nach Version prüfen

MVC-Controller und Razor Pages sind laut Supportmatrix keine allgemeine Native-AOT-Option. SignalR ist anders: .NET 9 führte Unterstützung für Client- und Serverszenarien ein, mit dokumentierten Einschränkungen und JSON-Quellgenerierung. Eine alte pauschale Ausschlussregel gilt nicht für neuere Ziele.

Datenbankzugriff braucht ebenfalls eine providerspezifische Prüfung. EF-Core-AOT hängt von Version und Abfragepipeline ab; normales Dapper ist nicht automatisch sicher, nur weil es kleiner ist. Veröffentlichen und testen Sie die konkreten Abhängigkeiten.

Zur Organisation kompatibler Handler siehe [Ressourcenmodule mit MapGroup](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Quellen

- [ASP.NET Core Native AOT support](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [.NET Native AOT deployment and prerequisites](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [System.Text.Json source generation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [.NET 9 SignalR Native AOT support and limitations](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-9.0?view=aspnetcore-9.0#signalr-supports-trimming-and-native-aot)
