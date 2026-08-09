---
title: "OpenAPI-Dokumentation mit Scalar statt Swagger UI in ASP.NET Core 11 bereitstellen"
description: "Ersetzen Sie UseSwaggerUI durch MapScalarApiReference in ASP.NET Core 11: Routing, mehrere Dokumente, vorausgefüllte Authentifizierung, Absicherung in Produktion, Assets ohne CDN und die Scalar-eigenen OpenAPI-Erweiterungen."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "de"
translationOf: "2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

Um Swagger UI in einer ASP.NET Core 11 API durch Scalar zu ersetzen, installieren Sie `Scalar.AspNetCore`, löschen den Aufruf `app.UseSwaggerUI(...)` und ergänzen `app.MapScalarApiReference()` neben Ihrem vorhandenen `app.MapOpenApi()`. Die Oberfläche liegt dann unter `/scalar` und liest das Dokument von `/openapi/v1.json`, also genau von dort, wo `MapOpenApi` es ohnehin bereitstellt. Das ist der Neunzig-Prozent-Fall. Die übrigen zehn Prozent sind alles Weitere: ein Dokument auf einer abweichenden Route, mehr als ein Dokument, ein Authorize-Button, der tatsächlich ein Token anhängt, und das Ganze vom Produktions-Hostnamen fernzuhalten.

Alles hier zielt auf .NET 11 (getestet mit Preview 6, SDK `11.0.100-preview.6.26359.118`) mit `Microsoft.NET.Sdk.Web` und C# 14, unter Verwendung von `Scalar.AspNetCore` 2.16.18, veröffentlicht am 2026-08-07. Die unten gezeigte API-Oberfläche ist unter .NET 8, 9 und 10 identisch, da das Paket `net8.0` und höher adressiert.

## Die sechs Schritte, von Anfang bis Ende

1. Installieren Sie `Scalar.AspNetCore` mit `dotnet add package Scalar.AspNetCore` und ergänzen Sie `using Scalar.AspNetCore;` in `Program.cs`.
2. Entfernen Sie den Middleware-Aufruf `app.UseSwaggerUI(...)` sowie den Paketverweis auf `Swashbuckle.AspNetCore.SwaggerUI`, falls ihn nichts anderes nutzt.
3. Rufen Sie `app.MapScalarApiReference()` innerhalb derselben Umgebungsprüfung auf, die bereits `app.MapOpenApi()` umschließt.
4. Verweisen Sie Scalar mit `WithOpenApiRoutePattern` oder `AddDocument` auf das richtige Dokument, falls Ihr OpenAPI-JSON nicht unter `/openapi/{documentName}.json` liegt.
5. Füllen Sie Zugangsdaten mit `AddPreferredSecuritySchemes` und `AddHttpAuthentication` vor, damit der Authorize-Button in der Entwicklung ein echtes Token sendet.
6. Entscheiden Sie über die Produktionsvariante: entweder Sie lassen den Endpunkt in Produktion ganz weg, oder Sie mappen ihn und hängen `RequireAuthorization()` an den zurückgegebenen Endpunkt-Builder an.

## Was sich tatsächlich ändert, wenn Swagger UI verschwindet

Der folgenreichste Unterschied ist kein optischer. `UseSwaggerUI` registriert Middleware. `MapScalarApiReference` registriert einen Endpunkt. Diese eine Änderung verschiebt die Oberfläche aus der Pipeline in die Routing-Tabelle, und alles Weitere folgt daraus.

Middleware läuft in Registrierungsreihenfolge und beendet die Anfrage, bevor das Endpunkt-Routing überhaupt zu Wort kommt. Genau deshalb hat Swagger UI Ihre Autorisierungsrichtlinien historisch ignoriert, solange Sie keine eigene Middleware darum herum gebaut haben. Ein Endpunkt nimmt am Routing teil wie jeder andere, trägt also Metadaten, erscheint in `EndpointDataSource`, und die Konventionen, die Sie bereits kennen, greifen unmittelbar.

```csharp
// Program.cs -- .NET 11, C# 14
// Before: Swashbuckle's UI middleware over the built-in OpenAPI document
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "v1"));
}
```

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
// After: an endpoint, not middleware
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Beachten Sie, was im zweiten Block fehlt: Es gibt kein Gegenstück zu `SwaggerEndpoint`. Scalar setzt als Standardroute für das Dokument `/openapi/{documentName}.json`, also exakt die Route, die `MapOpenApi` registriert. Beide passen ohne Konfiguration zusammen. Wenn Sie den Swashbuckle-Generator bereits durch den integrierten ersetzt haben, ist dies das letzte verbliebene Swashbuckle-Paket. Die Generator-Seite dieses Wechsels behandelt [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Eine Verhaltensbesonderheit sollten Sie kennen, bevor Sie einen Fehler melden. Der Aufruf von `/scalar` erzeugt eine Weiterleitung auf `/scalar/`, damit die clientseitigen Asset-Pfade korrekt aufgelöst werden. Wenn Sie eine strikte Redirect-Richtlinie haben, einen Proxy, der abschließende Schrägstriche umschreibt, oder einen Integrationstest, der einen 200 auf `/scalar` erwartet: dieser 301 ist die Ursache.

## Scalar auf ein Dokument abseits der Standardroute verweisen

`MapOpenApi` nimmt ein Routenmuster entgegen, und viele Projekte haben es vor Jahren geändert, um alte Client-Generatoren zufriedenzustellen. Liegt Ihr Dokument unter `/swagger/v1/swagger.json`, oder hat .NET 10 eine YAML-Variante ergänzt, die Sie lieber ausliefern, dann sagen Sie Scalar, wo es suchen soll:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapOpenApi("/swagger/{documentName}/swagger.json");

app.MapScalarApiReference(options =>
{
    options
        .WithTitle("Orders API")
        .WithOpenApiRoutePattern("/swagger/{documentName}/swagger.json");
});
```

`WithOpenApiRoutePattern` akzeptiert auch eine absolute URL. So verweisen Sie einen Dokumentations-Host auf eine Spezifikation, die ein anderer Dienst erzeugt. Die Route kann ebenso auf eine Datei zeigen, die zur Buildzeit von `Microsoft.Extensions.ApiDescription.Server` erzeugt und als statische Datei ausgeliefert wird, falls Sie den Laufzeitgenerator gar nicht ausführen möchten.

Die Route der Oberfläche selbst ist das erste Argument von `MapScalarApiReference`. Es gibt sechs Überladungen: mit oder ohne Routenpräfix, mit oder ohne Options-Delegate, und mit oder ohne `HttpContext` in diesem Delegate.

```csharp
// Program.cs -- .NET 11, C# 14
// Mount the reference at /api-docs and vary options per request
app.MapScalarApiReference("/api-docs", (options, httpContext) =>
{
    options.WithTitle($"Orders API ({httpContext.Request.Host})");
});
```

Die `HttpContext`-Überladung ist wichtiger, als sie aussieht. Sie ist der unterstützte Weg, Optionen aus der eingehenden Anfrage abzuleiten: ein Theme aus einem Cookie wählen, eine Serverliste anhand des Host-Headers bestimmen oder Dokumente ausblenden, die der Aufrufer nicht sehen darf.

Kommen Sie aus einer Scalar-1.x-Codebasis, beachten Sie: `ScalarOptions.EndpointPathPrefix` ist obsolet. Das Routenpräfix ist in jenen ersten Parameter gewandert, und der Standard hat sich von `/scalar/{documentName}` auf schlicht `/scalar` geändert. Die alten Behelfslösungen für Unterpfade, bei denen Sie `OpenApiRoutePattern` für Anwendungen unter einer Path Base manuell umgeschrieben haben, sind nicht mehr nötig und sollten gelöscht werden, denn die relative Auflösung übernimmt jetzt die Bibliothek.

## Mehrere Dokumente und API-Versionen in einer Seitenleiste

Swagger UI drückte das über wiederholte `SwaggerEndpoint`-Aufrufe und ein Dropdown aus. Scalar drückt es als registrierte Dokumente aus:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

// ...

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options
        .AddDocument("v1", "Orders API v1")
        .AddDocument("v2", "Orders API v2 (beta)", isDefault: true);
});
```

Jede `AddDocument`-Überladung nimmt einen Namen, einen optionalen Anzeigetitel und ein optionales Routenmuster entgegen, sodass Dokumente auf unterschiedlichen Pfaden in einer Referenz koexistieren. `AddDocuments(["v1", "v2", "v3"])` ist die knappe Form, wenn die Namen genügen. Wenn Sie mit `Asp.Versioning` ein Dokument pro API-Version erzeugen, landen genau diese Namen hier; die versionsspezifische Verkabelung steht in [API-Versionierung mit OpenAPI in .NET](/de/2026/04/api-versioning-openapi-dotnet-10/).

Dokumentnamen werden exakt so an den Generator weitergereicht, wie Sie sie schreiben, Groß- und Kleinschreibung eingeschlossen. Ein als `V1` registriertes und als `v1` angefordertes Dokument erzeugt eine leere Referenz statt eines Fehlers, weil der Abruf des Dokuments schlicht mit 404 endet und die Oberfläche nichts zu rendern hat. Halten Sie alle Dokumentnamen klein geschrieben, dann tritt das nie auf.

## Den Authorize-Button dazu bringen, ein echtes Token zu senden

Das ist der Teil mit der größten Verwirrung, und die Regel ist einfach: Scalar füllt ausschließlich jene Sicherheitsschemata vor, die Ihr OpenAPI-Dokument bereits deklariert. Es liest nicht Ihre Authentifizierungs-Middleware und kann kein Schema erfinden, das im Dokument nicht beschrieben ist. Fehlt im Dokument der Eintrag `securitySchemes`, hängt keine Client-Konfiguration der Welt einen `Authorization`-Header an. Genau diesen Fehlerfall habe ich ausführlich in [warum Ihr Bearer-Token in Scalar ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) beschrieben, und die Diagnose hat sich nicht geändert.

Angenommen, das Dokument deklariert ein HTTP-Bearer-Schema namens `BearerAuth`, dann wählt dies das Schema vor und füllt ein Entwicklungstoken ein:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("BearerAuth")
        .AddHttpAuthentication("BearerAuth", auth =>
        {
            auth.Token = builder.Configuration["Scalar:DevToken"]!;
        });
});
```

OAuth2-Flows erhalten vollwertige Hilfsmethoden statt der flachen Schlüssel-Wert-Konfiguration von Swagger UI. `AddAuthorizationCodeFlow`, `AddClientCredentialsFlow`, `AddPasswordFlow` und `AddImplicitFlow` nehmen jeweils ein Konfigurations-Delegate entgegen, und PKCE ist eine Eigenschaft statt eines Häkchens, bei dem Sie hoffen, dass die Oberfläche es beachtet:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("OAuth2")
        .AddAuthorizationCodeFlow("OAuth2", flow =>
        {
            flow.ClientId = builder.Configuration["Scalar:ClientId"]!;
            flow.Pkce = Pkce.Sha256;
            flow.SelectedScopes = ["orders.read", "orders.write"];
        });
});
```

Zwei Dinge bleiben festzuhalten. Erstens wird alles, was Sie hier übergeben, in die Seite serialisiert, die der Browser herunterlädt. Ein so konfiguriertes Client Secret ist damit öffentlich. Die Scalar-Dokumentation sagt selbst, dass vorausgefüllte Authentifizierungsdaten niemals in Produktion verwendet werden sollten, und das ist keine Formelhaftigkeit: Behandeln Sie diese Werte, als hätten Sie sie in eine öffentliche HTML-Datei eingefügt, denn genau das haben Sie getan. Zweitens speichert `EnablePersistentAuthentication()` die Eingaben des Benutzers über Neuladevorgänge hinweg im Browser-Speicher. Auf einem Laptop ist das wirklich praktisch, auf einem geteilten Rechner wirklich falsch.

Wenn Sie parallel die Serverseite aufbauen: [JWT-Bearer-Authentifizierung in einer Minimal API](/de/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) behandelt die Token-Validierung, und die Schema-Deklaration selbst ist ein Dokument-Transformer, beschrieben in [OpenAPI mit Operation- und Schema-Transformern anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Die Referenz aus der Produktion heraushalten, ohne sie zu verlieren

Microsofts Empfehlung ist eindeutig: OpenAPI-Benutzeroberflächen, Scalar eingeschlossen, gehören ausschließlich in Entwicklungsumgebungen. Die Standardprüfung aus der Vorlage erledigt das:

```csharp
// Program.cs -- .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Teams, die die Referenz auf einem internen Staging-Host wollen, haben eine bessere Option als eine Umgebungsprüfung, und die existiert genau deshalb, weil Scalar ein Endpunkt ist. `MapScalarApiReference` gibt einen `IEndpointConventionBuilder` zurück, sodass sämtliche Routing-Konventionen greifen:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference()
   .RequireAuthorization("InternalOnly")
   .ExcludeFromDescription();

app.MapOpenApi()
   .RequireAuthorization("InternalOnly");
```

Sichern Sie beides ab. Die Oberfläche zu schützen und `/openapi/v1.json` anonym zu lassen, schützt gar nichts: Das Dokument ist die Informationspreisgabe, die Oberfläche nur ein Renderer dafür. `ExcludeFromDescription()` hält den Dokumentations-Endpunkt aus der Dokumentation heraus, was eher ordentlich als wichtig ist.

## Assets, Offline-Hosting und die Schriftarten, die nach Hause telefonieren

Scalar bündelt sein JavaScript und CSS im NuGet-Paket und liefert beides von Ihrem eigenen Origin aus. Eine abgeschottete oder offline betriebene Umgebung funktioniert damit ohne jede Konfiguration. Für sehr frühe 1.x-Versionen galt das noch nicht, daher hält sich hartnäckig die Annahme, Scalar benötige ein CDN.

Die verbleibende externe Anfrage ist die Standard-Webschriftart. Ein Aufruf schaltet sie ab:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options.DisableDefaultFonts();
});
```

`WithBundleUrl("https://cdn.jsdelivr.net/npm/@scalar/api-reference")` geht in die Gegenrichtung und lädt das Bundle von einem CDN, falls Sie der neuesten Oberfläche ohne Paket-Update folgen möchten. Bei einer strikten Content Security Policy bedeutet `DisableDefaultFonts` zusammen mit den gebündelten Assets, dass die Referenz nichts über `'self'` und das eingebettete Konfigurationsskript hinaus braucht.

Optionen lassen sich auch aus der Konfiguration binden statt im Code zu setzen. Das ist der sauberste Weg, umgebungsspezifische Einstellungen aus `Program.cs` herauszuhalten:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOptions<ScalarOptions>().BindConfiguration("Scalar");
```

Alles, was im Delegate von `MapScalarApiReference` gesetzt wird, überschreibt die gebundenen Werte.

## Scalar-eigene Metadaten: Stabilität, verborgene Endpunkte, Codebeispiele

Die Funktionen ohne Swagger-UI-Gegenstück liegen in einem Begleitpaket, `Scalar.AspNetCore.Microsoft` (2.16.18, adressiert `net9.0` und `net10.0`, abhängig von `Microsoft.AspNetCore.OpenApi` und `Microsoft.OpenApi` 2.7.5 oder höher). Es registriert Dokument-Transformer, die Scalars Vendor-Erweiterungen in das erzeugte Dokument schreiben. Wenn Sie noch den Swashbuckle-Generator verwenden, erledigt `Scalar.AspNetCore.Swashbuckle` dieselbe Aufgabe über Filter.

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore.Microsoft 2.16.18
builder.Services.AddOpenApi(options => options.AddScalarTransformers());

// ...

app.MapGet("/orders", GetOrders).Stable();
app.MapGet("/orders/forecast", GetForecast).Experimental();
app.MapGet("/internal/metrics", GetMetrics).ExcludeFromApiReference();
```

`ExcludeFromApiReference()` verdient eine eigene Erwähnung. Es blendet die Operation in der gerenderten Referenz aus, belässt sie aber im OpenAPI-Dokument und voll routbar. Das unterscheidet sich von `ExcludeFromDescription()`, das sie ganz aus dem Dokument entfernt. Entscheiden Sie danach, ob Ihre Client-Generatoren den Endpunkt weiterhin sehen müssen. `CodeSample()` hängt einen handgeschriebenen Ausschnitt für ein bestimmtes `ScalarTarget` an, und `WithBadge()` setzt ein farbiges Label neben eine Operation; beides gibt es als Attribute auf Controller-Aktionen, falls Sie keine Minimal APIs verwenden.

## Stolperfallen, die einen Nachmittag kosten

**Das Paket hat kein Target Framework `net11.0`.** Ab 2.16.18 endet die TFM-Liste bei `net10.0`, und ein `net11.0`-Projekt bezieht die `net10.0`-Assets über die normalen Kompatibilitätsregeln. Das ist während des Preview-Zeitfensters in Ordnung und zu erwarten. Scheitert Ihr Build aber an einer internen Richtlinie, die exakte TFM-Übereinstimmung verlangt, ist das die Erklärung.

**Eine leere Referenz bedeutet fast immer ein fehlendes Dokument, keine kaputte Oberfläche.** Öffnen Sie `/openapi/v1.json` direkt. Ergibt das einen 404, ist `MapOpenApi` nicht gemappt, steckt hinter einer anderen Umgebungsprüfung als die Oberfläche, oder liegt auf einer Route, die Scalar nie mitgeteilt wurde. In all diesen Fällen rendert die Referenz eine leere Hülle statt eines Fehlers.

**Dokumentgenerierung zur Buildzeit speist die Oberfläche nicht.** `OpenApiGenerateDocuments` in Ihrer `.csproj` schreibt beim Build eine JSON-Datei; ausgeliefert wird zur Laufzeit dadurch nichts. Wenn Sie `MapOpenApi` entfernen, weil Sie nun zur Buildzeit generieren, liefern Sie die erzeugte Datei als statische Datei aus und richten `WithOpenApiRoutePattern` darauf.

**`launchUrl` steht weiterhin auf `swagger`.** Nach dem Entfernen der Swagger-UI-Middleware öffnet `Properties/launchSettings.json` bei jedem `dotnet run` weiterhin einen 404, bis Sie `"launchUrl": "swagger"` in `"launchUrl": "scalar"` ändern.

**Native AOT ändert hier nichts.** Der integrierte Generator ist AOT-kompatibel und Scalar liefert statische Assets aus, das Gespann übersteht `PublishAot` also unbeschadet. Was unter AOT üblicherweise bricht, ist ein selbst geschriebener, reflexionsbasierter Transformer, nicht die Referenz-Oberfläche.

Swagger UI ist nicht veraltet, und `Swashbuckle.AspNetCore.SwaggerUI` funktioniert weiterhin einwandfrei über einem von `Microsoft.AspNetCore.OpenApi` erzeugten Dokument. Der Grund für den Wechsel ist, dass Scalar ein Endpunkt statt Middleware ist, seine Assets im Paket mitliefert und Authentifizierung über eine typisierte API statt über eine Sammlung von Zeichenketten vorausfüllt. Wenn Ihnen nichts davon wichtig ist, ist Bleiben eine vertretbare Antwort.

## Verwandte Artikel

- [OpenAPI ohne Swashbuckle in ASP.NET Core 11 bereitstellen](/de/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Scalar in ASP.NET Core: warum Ihr Bearer-Token ignoriert wird](/de/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Von Swashbuckle zum integrierten OpenAPI-Generator in .NET 11 migrieren](/de/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Das OpenAPI-Dokument mit Operation- und Schema-Transformern anpassen](/de/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [OpenAPI-Authentifizierungsflows zu Swagger UI in .NET 11 hinzufügen](/de/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)

## Quellen

- [Die generierten OpenAPI-Dokumente verwenden](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0) auf Microsoft Learn
- [Dokumentation zur Scalar-Integration in ASP.NET Core](https://scalar.com/products/api-references/integrations/aspnetcore/integration)
- [Scalar OpenAPI-Erweiterungen für .NET](https://scalar.com/products/api-references/integrations/aspnetcore/openapi-extensions)
- [Migrationsleitfaden für Scalar.AspNetCore 2.0.0](https://github.com/scalar/scalar/issues/4362)
- [Scalar.AspNetCore auf NuGet](https://www.nuget.org/packages/Scalar.AspNetCore)
