---
title: "Scalar vs Swagger UI für OpenAPI-Dokumentation in ASP.NET Core 11"
description: "Scalar liefert 1,02 MiB gzip-komprimiertes JavaScript und einen deutlich besseren Request-Builder. Swagger UI liefert 514 KiB und rendert OpenAPI 3.2, was .NET 11 inzwischen standardmäßig ausgibt. Gemessene Payloads, die 3.2-Lücke, Endpoint-Routing auf beiden Seiten und die Authentifizierungsdetails, die entscheiden."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "de"
translationOf: "2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Wählen Sie **Scalar** (`Scalar.AspNetCore` 2.16.20) für eine neue .NET 11 API, wenn die Leser Ihrer Dokumentation außerhalb Ihres Unternehmens sitzen, denn der Request-Builder, die Codebeispiele in mehreren Sprachen und die Suche sind wirklich besser als alles, was Swagger UI bietet. Wählen Sie **Swagger UI** (`Swashbuckle.AspNetCore.SwaggerUI` 10.2.3, mit swagger-ui 5.32.7 im Paket), wenn Sie die kleinere Payload wollen, wenn Sie sich auf den bereits konfigurierten OAuth2-Redirect-Flow verlassen, oder wenn Sie heute verlässliches Rendering von OpenAPI 3.2 brauchen, denn .NET 11 gibt standardmäßig 3.2 aus und die 3.2-Arbeit bei Scalar ist weiterhin ein offenes Issue. Beide stehen unter MIT-Lizenz, beide sind reine Renderer ohne Einfluss auf Ihr OpenAPI-Dokument, und Microsofts Empfehlung lautet, dass keiner von beiden in der Produktion erreichbar sein sollte.

Alles hier Gemessene lief gegen das .NET SDK 10.0.201 mit den genannten Paketversionen, am 2026-08-15. Die API-Oberfläche ist von .NET 8 bis .NET 11 identisch, weil beide Pakete `net8.0`-, `net9.0`- und `net10.0`-Assemblies ausliefern und eine Framework-Referenz auf `Microsoft.AspNetCore.App` setzen, statt eine Laufzeit festzunageln.

## Der Vergleich, den man zu ziehen glaubt, ist nicht der entscheidende

Seit .NET 9 enthält `dotnet new webapi` kein Swashbuckle mehr. `Microsoft.AspNetCore.OpenApi` erzeugt das Dokument und ist mit Trimming und Native AOT kompatibel. Die Entscheidung lautet also nicht "Swashbuckle oder Scalar", sondern "welches JavaScript-Bundle rendert das Dokument, das mein Framework ohnehin produziert". Wer für die Generierung noch auf Swashbuckles `SwaggerGen` setzt, trifft eine separate Entscheidung, beschrieben in [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Diese Unterscheidung hat eine praktische Folge. Das Metapaket `Swashbuckle.AspNetCore` zieht `Swashbuckle.AspNetCore.Swagger`, `SwaggerGen` und `Microsoft.Extensions.ApiDescription.Server` mit der Oberfläche herein. Wer nur die Oberfläche will, referenziert direkt `Swashbuckle.AspNetCore.SwaggerUI`, und es kommt nichts weiter mit.

```xml
<!-- .NET 11, C# 14: the UI only, no second document generator -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.2.3" />
</ItemGroup>
```

```xml
<!-- .NET 11, C# 14: the Scalar equivalent, one package, zero NuGet dependencies -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Scalar.AspNetCore" Version="2.16.20" />
</ItemGroup>
```

## Die Matrix

| | Scalar 2.16.20 | Swagger UI 5.32.7 (Swashbuckle 10.2.3) |
| --- | --- | --- |
| Übertragene Bytes beim ersten Laden (gzip) | 1.071.277 | 526.322 |
| Nach dem Entpacken geparstes JavaScript | 3.711 KB | 1.794 KB |
| Registrierung | `app.MapScalarApiReference()` | `app.UseSwaggerUI(...)` oder `app.MapSwaggerUI(...)` |
| Endpoint-Routing | Ja, seit 1.x | Ja, seit 10.2.0 (Mai 2026) |
| OpenAPI 3.2 | Der Parser kommt damit zurecht, vollständige Unterstützung in einem offenen Issue | Grundlegende Unterstützung seit swagger-ui 5.32.0 |
| Codebeispiele | Über 20 Ziele (curl, fetch, axios, Python, Go, Java, PHP, Ruby und mehr) | curl für die gerade abgesendete Anfrage |
| Asset-Caching | `Cache-Control: no-cache` plus ETag, fest im Code | ETag als Standard, `max-age` wenn Sie `CacheLifetime` setzen |
| Gespeicherte Zugangsdaten | `persistAuth` schreibt in den Local Storage | `PersistAuthorization` im Konfigurationsobjekt |
| Try It über Origin-Grenzen | optionale `proxyUrl` | direkter Browser-fetch, CORS ist Ihr Problem |
| Themes | 12 eingebaute Themes, `customCss`, Plugins | `InjectStylesheet`, `InjectJavascript`, das swagger-ui-Plugin-System |
| Lizenz | MIT | MIT |

## Was jede Oberfläche den Browser kostet, gemessen

Beide Pakete betten ihre Assets als gzip-Streams in die Assembly ein und geben diese Bytes direkt an einen Client weiter, der `Accept-Encoding: gzip` ankündigt. Scalars ASP.NET Core Integration prüft `IsGzipAccepted()` und setzt `Content-Encoding` sowie `Vary: Accept-Encoding` aus dem gespeicherten Asset. Die Middleware der Swashbuckle-Oberfläche trägt dieselbe Mechanik (`IsGZipAccepted`, ein `GZipStream` im Dekomprimierungsmodus für den seltenen Client, der ablehnt). Die gespeicherten Ressourcengrößen sind also die Übertragungsgrößen, und Sie können sie aus den Paketen auslesen, ohne etwas auszuführen:

```csharp
// .NET SDK 10.0.201, run as a file-based app: dotnet run res.cs <dll>
using System.Reflection;

var asm = Assembly.LoadFrom(args[0]);
foreach (var name in asm.GetManifestResourceNames())
{
    using var s = asm.GetManifestResourceStream(name);
    Console.WriteLine($"{s?.Length,10}  {name}");
}
```

Scalar liefert drei Assets aus, von denen nur zwei Code sind:

```text
   1070166  ScalarStaticAssets.scalar.js
      1111  ScalarStaticAssets.scalar.aspnetcore.js
       533  ScalarStaticAssets.favicon.svg
```

Swashbuckles `index.html` lädt das Bundle, das Standalone-Preset, das Stylesheet und den eigenen Initializer:

```text
    421507  swagger-ui-bundle.js
     77731  swagger-ui-standalone-preset.js
     26499  swagger-ui.css
       433  index.js
       152  index.css
       739  index.html
```

Das sind 1.071.277 Bytes für Scalar gegenüber 526.322 Bytes für Swagger UI, ein Faktor von 2,0 auf der Leitung. Entpackt sind `scalar.js` 3.708.228 Bytes JavaScript, die der Browser parsen muss, gegenüber 1.793.552 Bytes für Swagger UIs Bundle plus Preset. Die modern wirkende Option ist die schwere, was das Gegenteil dessen ist, was die meisten Artikel nahelegen.

Zwei Einschränkungen, bevor Sie das zu hoch gewichten. Erstens ist das ein Entwicklungswerkzeug: Die Bytes landen über Loopback auf Ihrem Rechner, einmal pro Kaltstart. Zweitens liegt Swashbuckles `swagger-ui.js` (92.466 Bytes) ungenutzt im Paket, die Standardseite lädt es nicht, die Zahl oben ist also das tatsächlich Geladene, nicht das Ausgelieferte. Wenn Sie eine der Oberflächen über ein echtes Netz ausliefern, hilft der [Vergleich der Antwortkomprimierung](/de/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) hier nicht: Beide Pakete haben diese Assets bereits selbst komprimiert, und eine Antwort mit `Content-Encoding: gzip` noch einmal zu komprimieren ist nichts, was die Middleware tun wird.

Das Caching ist der Teil, der täglich stört. `SwaggerUIOptions.CacheLifetime` dokumentiert seinen Standardwert als "0 days (ETags are used to check if resources have been updated)", ab Werk revalidieren also beide Oberflächen. Der Unterschied: Swashbuckle lässt echtes Caching zu, Scalar nicht. Dessen Handler für statische Assets setzt fest `Cache-Control: no-cache` und beantwortet ein passendes `If-None-Match` mit einem 304. Sie zahlen einen Roundtrip pro Asset pro Seitenaufruf, dauerhaft.

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.CacheLifetime = TimeSpan.FromDays(7); // 304s become cache hits
});
```

## Der .NET 11 Haken: Ihr Dokument ist jetzt 3.2

Das ist die Tatsache, die im August 2026 die Entscheidung tragen sollte, und fast niemand hat sie aufgeschrieben. Microsoft Learn ist eindeutig: "Starting in .NET 11, the default OpenAPI version for generated documents is 3.2. In .NET 10, the default is 3.1." Aktualisieren Sie eine API von .NET 10 auf .NET 11, ohne sonst etwas zu ändern, und das Dokument, das Ihre Oberfläche rendern muss, wechselt die Spezifikationsversion.

Auf der Swagger-UI-Seite brachte swagger-ui 5.32.0 (27. Februar 2026) "basic OpenAPI 3.2.0 support", und Swashbuckle 10.2.3 liefert 5.32.7 mit, der Renderer weiß also zumindest, was er vor sich hat. Auf der Scalar-Seite versteht `@scalar/openapi-parser` 3.2, aber das Tracking-Issue [scalar/scalar#6715](https://github.com/scalar/scalar/issues/6715) ist weiterhin offen, mit "set OpenAPI 3.2 as the default version" und dem Rendering tief verschachtelter Tags in der Seitenleiste als offene Punkte, Stand der letzten Aktualisierung vom 30. Juni 2026.

In der Praxis ändert sich ein aus Minimal-API-Endpunkten erzeugtes Dokument zwischen 3.1 und 3.2 nur minimal, die meisten Anwendungen werden gar keinen Unterschied sehen. Falls doch eine Seitenleiste falsch gruppiert oder ein Schema leer rendert, nageln Sie die Version fest, statt einen Bug gegen die Oberfläche zu melden:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    // .NET 11 defaults to OpenApi3_2; pin 3.1 while a renderer catches up
    options.OpenApiVersion = Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1;
});
```

Denselben Schalter gibt es für die Generierung zur Buildzeit über die MSBuild-Eigenschaft `OpenApiGenerateDocumentsOptions` mit `--openapi-version OpenApi3_1`. Das Festnageln kostet heute nichts: Nichts in einem von ASP.NET Core erzeugten Dokument hängt bisher an 3.2-Funktionen.

## Middleware oder Endpunkt, inzwischen auf beiden Seiten

Das stärkste architektonische Argument für Scalar war lange, dass `MapScalarApiReference` einen Endpunkt registriert, während `UseSwaggerUI` Middleware registriert, und Middleware die Anfrage beendet, bevor das Endpoint-Routing mitreden kann. Dieses Argument ist im Mai 2026 verfallen. Swashbuckle 10.2.0 ergänzte `MapSwaggerUI` und `MapReDoc` "to support endpoint routing". Beide Oberflächen können jetzt Endpunkt-Metadaten tragen, in der `EndpointDataSource` erscheinen und Routing-Konventionen direkt entgegennehmen:

```csharp
// Program.cs -- .NET 11, C# 14
// Scalar: MapScalarApiReference returns an IEndpointConventionBuilder
app.MapScalarApiReference()
   .RequireAuthorization("ApiDocsPolicy");

// Swashbuckle 10.2.0+: same shape
app.MapSwaggerUI()
   .RequireAuthorization("ApiDocsPolicy");
```

Hinter einem Reverse Proxy ist zu beachten: Scalars HTML-Endpunkt leitet eine Anfrage auf `/scalar` mit einem 301 auf `/scalar/` um, damit die relativen Asset-Pfade auflösen, und Swashbuckles Middleware leitet eine Anfrage auf den blanken Routenpräfix mit einem 301 auf `index.html` um. Ein Integrationstest, der auf dem blanken Pfad einen 200 erwartet, scheitert bei beiden.

## Authorize, und was nach dem Klick passiert

Beide Oberflächen lesen die Sicherheitsschemas aus dem Dokument, keine erfindet sie. Scalars eigene Dokumentation ist deutlich: Ihr OpenAPI-Dokument muss die Schemas bereits enthalten, damit Scalar mit ihnen arbeiten kann. Wenn sie dort nicht stehen, ist die [Anleitung zu Operation- und Schema-Transformern](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) der passende Mechanismus.

Unterschiedlich ist die Ergonomie danach. Scalar füllt Zugangsdaten aus der serverseitigen Konfiguration vor und kann sie über Neuladungen hinweg behalten:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.20
app.MapScalarApiReference(options =>
{
    options.AddPreferredSecuritySchemes("Bearer")
           .AddHttpAuthentication("Bearer", auth => auth.WithToken(devToken));
    options.PersistentAuthentication = true;
});
```

Das Gegenstück in Swagger UI liegt im Konfigurationsobjekt und, für OAuth2, in der Seite `oauth2-redirect.html`, die Swashbuckle für Sie einbettet (664 Bytes Redirect-Skript, das seit einem Jahrzehnt im Einsatz ist):

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.OAuthClientId("dev-client");
    options.OAuthUsePkce();
    options.EnablePersistAuthorization();
});
```

Die eine Fähigkeit, die Scalar hat und Swagger UI nicht, ist `proxyUrl`. Swagger UIs Try It feuert ein `fetch` vom Origin der Dokumentation ab, eine API auf einem anderen Origin ohne großzügiges CORS erzeugt also einen Browserfehler, der wie ein Serverausfall aussieht. Scalar kann die Anfrage stattdessen über einen Proxy leiten. Wenn Ihre Dokumentation getrennt von der API gehostet wird, entscheidet diese eine Option.

## Die Codebeispiele sind der eigentliche Produktunterschied

Swagger UI zeigt Ihnen den curl-Befehl der gerade ausgeführten Anfrage. Scalar rendert die Anfrage in jedem ihm bekannten Client, bevor Sie irgendetwas senden: Shell (curl, httpie), JavaScript (fetch, axios, jquery), Node, Python, Go, Java, Ruby, PHP und mehr, gesteuert über `hiddenClients` und `defaultHttpClient`. Für eine interne API, deren Leser dieselben Menschen sind, die sie geschrieben haben, ist das Dekoration. Für eine öffentliche API, deren Leser gerade entscheidet, ob Ihr Produkt leicht zu integrieren ist, ist es die ganze Seite.

Scalar liefert außerdem `searchHotKey` (standardmäßig CMD/CTRL+K), zwölf eingebaute Themes, `customCss` und einen Hook unter `/scalar/config.js` für beliebige Client-Konfiguration. Die Anpassung von Swagger UI läuft über `InjectStylesheet`, `InjectJavascript` und das swagger-ui-Plugin-System, das mächtiger und deutlich unangenehmer ist, und das ist die ehrliche Zusammenfassung des gesamten Vergleichs.

## Wann welche Wahl richtig ist

Wählen Sie Scalar, wenn die Dokumentation Teil des Produkts ist, wenn die Leser außerhalb Ihres Teams sitzen, wenn Sie den Request-Builder und die Codebeispiele wollen, oder wenn die Dokumentation auf einem anderen Origin als die API liegt und Sie den Proxy brauchen.

Wählen Sie Swagger UI, wenn Sie die kleinste Payload und echtes `max-age`-Caching wollen, wenn Sie ein bestehendes OAuth2-Setup haben, das funktioniert, wenn jemand im Team von einem swagger-ui-Plugin abhängt, oder wenn Sie den Renderer mit expliziter 3.2-Unterstützung wollen, während .NET 11 standardmäßig 3.2 ausgibt.

Wählen Sie keinen von beiden und nehmen Sie `Swashbuckle.AspNetCore.ReDoc` oder eine Editor-Erweiterung, wenn das Dokument von generierten Clients statt von Menschen konsumiert wird. Es gibt keine Regel, die einer API eine gerenderte Referenz vorschreibt.

Was auch immer Sie wählen, Microsoft Learn formuliert die Sicherheitsposition klar: OpenAPI-Benutzeroberflächen sollten nur in Entwicklungsumgebungen aktiviert sein. Beide Pakete machen daraus einen einzeiligen Umgebungs-Guard, und die schrittweise Fassung dieser Einrichtung, inklusive Absicherung gegen Produktion und Offline-Assets, steht in der [Scalar-Anleitung](/de/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/).

## Die Details, die für Sie entscheiden

- **Das Metapaket.** `Swashbuckle.AspNetCore` 10.2.3 zieht `SwaggerGen` und `Microsoft.Extensions.ApiDescription.Server` mit. Wer auf den eingebauten Generator migriert ist, hat jetzt zwei Generatoren, und einer davon ist veraltet. Referenzieren Sie `Swashbuckle.AspNetCore.SwaggerUI` allein. Der vollständige Entfernungspfad steht in [Migration von Swashbuckle zum eingebauten OpenAPI-Generator](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).
- **Keines der Pakete zielt auf `net11.0`.** Beide liefern `net8.0`-, `net9.0`- und `net10.0`-Assemblies mit einer Framework-Referenz. Das `net10.0`-Asset läuft per Roll-Forward auf .NET 11, was in Ordnung ist, aber bedeutet, dass Sie auf einen `net11.0`-spezifischen Fix in keinem der Projekte warten können.
- **Scalars Assets werden nie gecacht.** `Cache-Control: no-cache` ist über Optionen nicht konfigurierbar. Auf einer langsamen Verbindung zu einer geteilten Entwicklungsumgebung zahlen Sie eine Revalidierung pro Asset pro Aufruf.
- **Der abschließende Schrägstrich.** Beide Oberflächen antworten auf dem blanken Pfad mit 301. Strenge Proxys und Integrationstests merken das.
- **Der Versions-Header von Swagger UI.** Swashbuckle hängt `x-swagger-ui-version` an Asset-Antworten an, was nützlich ist, um zu prüfen, was tatsächlich ausgeliefert wurde, und was manche Scanner als Informationspreisgabe melden. Ein weiterer Grund für den Umgebungs-Guard.

Zwischen zwei MIT-lizenzierten Renderern desselben Dokuments ist das eine umkehrbare Entscheidung: Eine Zeile in `Program.cs` und eine Paketreferenz bringen Sie in etwa fünf Minuten in jede Richtung. Entscheiden Sie nach dem Leser, nicht nach dem Framework.

## Verwandte Artikel

- [OpenAPI-Dokumentation mit Scalar statt Swagger UI in ASP.NET Core 11 ausliefern](/de/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) ist die vollständige Einrichtung: Routing, mehrere Dokumente, Authentifizierung und Absicherung gegen Produktion.
- [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) deckt die Generator-Hälfte dieser Trennung ab.
- [Von Swashbuckle zur eingebauten OpenAPI-Dokumenterzeugung in .NET 11 migrieren](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) ist die Checkliste zum Entfernen.
- [Das OpenAPI-Dokument mit AddOperationTransformer und AddSchemaTransformer anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) zeigt, wie Sicherheitsschemas überhaupt erst ins Dokument kommen.
- [Zstandard vs Brotli vs Gzip bei der Antwortkomprimierung in .NET 11](/de/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) erklärt, warum vorkomprimierte statische Assets die Komprimierungs-Middleware vollständig umgehen.

## Quellen

- [Use the generated OpenAPI documents (Microsoft Learn, ASP.NET Core 11)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-11.0)
- [Generate OpenAPI documents, default version 3.2 in .NET 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-11.0)
- [OpenApiSpecVersion enum, including OpenApi3_2 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.openapi.openapispecversion)
- [Swashbuckle.AspNetCore v10.2.0 release notes, MapSwaggerUI and MapReDoc](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.2.0)
- [Swashbuckle.AspNetCore.SwaggerUI 10.2.3 on NuGet](https://www.nuget.org/packages/Swashbuckle.AspNetCore.SwaggerUI/10.2.3)
- [swagger-ui v5.32.0 release, basic OpenAPI 3.2.0 support](https://github.com/swagger-api/swagger-ui/releases/tag/v5.32.0)
- [Scalar.AspNetCore 2.16.20 on NuGet](https://www.nuget.org/packages/Scalar.AspNetCore/2.16.20)
- [Scalar .NET integration documentation](https://scalar.com/scalar/scalar-api-references/net-integration)
- [Scalar API reference configuration options](https://scalar.com/scalar/scalar-api-references/configuration)
- [OpenAPI 3.2 support tracking issue (scalar/scalar#6715)](https://github.com/scalar/scalar/issues/6715)
