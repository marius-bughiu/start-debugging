---
title: "Asp.Versioning 10.0 spielt endlich gut mit dem integrierten OpenAPI in .NET 10 zusammen"
description: "Asp.Versioning 10.0 ist das erste Release, das auf .NET 10 und die neue Microsoft.AspNetCore.OpenApi-Pipeline abzielt. Sander ten Brinkes Anleitung vom 23. April zeigt, wie Sie pro API-Version ein eigenes OpenAPI-Dokument mit WithDocumentPerVersion() registrieren."
pubDate: 2026-04-28
tags:
  - "dotnet-10"
  - "aspnetcore"
  - "openapi"
  - "api-versioning"
lang: "de"
translationOf: "2026/04/api-versioning-openapi-dotnet-10"
translatedBy: "claude"
translationDate: 2026-04-28
---

Als ASP.NET Core 9 Swashbuckle gegen den eingebauten Generator [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/overview?view=aspnetcore-10.0) tauschte, fehlte ein Stück Klebstoff: Es gab keinen sauberen Weg, die neue Pipeline mit `Asp.Versioning` zu verdrahten und pro Version ein separates Dokument auszugeben. Der Fix ist letzte Woche gelandet. Sander ten Brinkes [Beitrag vom 23. April im .NET Blog](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) ist die offizielle "So macht man das"-Anleitung, und sie passt zu den ersten `Asp.Versioning`-Paketen, die auf .NET 10 abzielen.

## Die Pakete, die sich geändert haben

Für Minimal APIs referenzieren Sie nun drei Pakete, alle aktuell zum Stand April 2026:

- `Asp.Versioning.Http` 10.0.0
- `Asp.Versioning.Mvc.ApiExplorer` 10.0.0
- `Asp.Versioning.OpenApi` 10.0.0-rc.1

Für Controller tauschen Sie `Asp.Versioning.Http` gegen `Asp.Versioning.Mvc` 10.0.0. Das `OpenApi`-Paket ist dasjenige, das die eigentliche Arbeit macht: Es verbindet das API-Explorer-Modell, das die Versionierungsbibliothek ohnehin produziert, mit der Document-Transformer-Pipeline, die `Microsoft.AspNetCore.OpenApi` erwartet. Vor diesem Release mussten Sie selbst einen Transformer schreiben, der `IApiVersionDescriptionProvider` liest und Operationen pro Dokument filtert. Dieser Code ist jetzt eingebaut.

## Ein Dokument pro Version, in drei Zeilen

Die Service-Registrierung ist gegenüber der Versionierungs-Story vor OpenAPI unverändert, nur ein zusätzlicher `.AddOpenApi()`-Aufruf kommt dazu:

```csharp
builder.Services.AddApiVersioning()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
    })
    .AddOpenApi();
```

Auf der Endpunkt-Seite taucht die neue Extension auf:

```csharp
app.MapOpenApi().WithDocumentPerVersion();
```

`WithDocumentPerVersion()` zählt auf, was `DescribeApiVersions()` zurückgibt, und registriert ein Dokument pro Version. Sie rufen `/openapi/v1.json` und `/openapi/v2.json` auf und erhalten genau die Operationen, die zu jeder Version gehören, ohne geteilte Operations-IDs oder duplizierte Schemas, die zwischen Dokumenten überlaufen. Sowohl Scalar (`app.MapScalarApiReference()`) als auch Swagger UI (`app.UseSwaggerUI()`) entdecken die Dokumente automatisch über denselben API-Versions-Beschreibungsprovider, sodass der Auswähler im Browser geschenkt verdrahtet ist.

## Versionierte Routen-Gruppen

Für Minimal APIs bleibt die Routenseite kompakt. Sie deklarieren eine versionierte API einmal und hängen pro Version eine Gruppe daran:

```csharp
var usersApi = app.NewVersionedApi("Users");

var usersV1 = usersApi.MapGroup("api/users").HasApiVersion("1.0");
var usersV2 = usersApi.MapGroup("api/users").HasApiVersion("2.0");

usersV1.MapGet("", () => Results.Ok(new { shape = "v1" }));
usersV2.MapGet("", () => Results.Ok(new { shape = "v2" }));
```

Der Name `Users` wird zur API-Gruppe; `HasApiVersion` ist das, was der API Explorer liest, um zu entscheiden, in welches OpenAPI-Dokument jeder Endpunkt gehört.

## Warum das jetzt zählt

Wenn Sie eine neue ASP.NET-Core-9- oder -10-App gestartet und Swashbuckle aus Prinzip übersprungen haben, war die Versionierung das Einzige, was Sie zurückzog. Mit `Asp.Versioning.OpenApi` 10.0.0-rc.1 schließt sich diese Notluke. Das RC-Suffix ist der einzige Grund zu warten: Die API-Oberfläche ist diejenige, die ausgeliefert wird, und das Team peilt GA zusammen mit dem .NET-10-Servicing-Zug an. Das vollständige Beispiel liegt [in Sanders Repo, das aus dem Beitrag verlinkt ist](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/), und es lohnt sich, es zu klonen, bevor Sie das nächste Mal nach einem handgeschriebenen Transformer greifen.
