---
title: "Asp.Versioning 10.0 por fin se lleva bien con el OpenAPI integrado en .NET 10"
description: "Asp.Versioning 10.0 es la primera versión que apunta a .NET 10 y al nuevo pipeline de Microsoft.AspNetCore.OpenApi. La guía del 23 de abril de Sander ten Brinke muestra cómo registrar un documento OpenAPI por cada versión de la API con WithDocumentPerVersion()."
pubDate: 2026-04-28
tags:
  - "dotnet-10"
  - "aspnetcore"
  - "openapi"
  - "api-versioning"
lang: "es"
translationOf: "2026/04/api-versioning-openapi-dotnet-10"
translatedBy: "claude"
translationDate: 2026-04-28
---

Cuando ASP.NET Core 9 cambió Swashbuckle por el generador integrado [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/overview?view=aspnetcore-10.0), faltó una pieza de pegamento: no había una forma limpia de conectar el nuevo pipeline con `Asp.Versioning` y emitir un documento separado por versión. La solución llegó la semana pasada. La [publicación del 23 de abril en el .NET Blog](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) de Sander ten Brinke es el recorrido oficial de "hazlo así", y se acompaña de los primeros paquetes `Asp.Versioning` que apuntan a .NET 10.

## Los paquetes que cambiaron

Para minimal APIs ahora referencias tres paquetes, todos vigentes a abril de 2026:

- `Asp.Versioning.Http` 10.0.0
- `Asp.Versioning.Mvc.ApiExplorer` 10.0.0
- `Asp.Versioning.OpenApi` 10.0.0-rc.1

Para controladores, cambia `Asp.Versioning.Http` por `Asp.Versioning.Mvc` 10.0.0. El paquete `OpenApi` es el que hace el trabajo real: une el modelo del API explorer que la biblioteca de versionado ya produce con el pipeline de transformadores de documentos que `Microsoft.AspNetCore.OpenApi` espera. Antes de esta versión, tenías que escribir a mano un transformador que leyera `IApiVersionDescriptionProvider` y filtrara las operaciones por documento. Ese código ahora viene de fábrica.

## Un documento por versión, en tres líneas

El registro de servicios no cambia respecto a la historia previa de versionado sin OpenAPI, con una llamada extra a `.AddOpenApi()`:

```csharp
builder.Services.AddApiVersioning()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
    })
    .AddOpenApi();
```

El lado de los endpoint es donde aparece la nueva extensión:

```csharp
app.MapOpenApi().WithDocumentPerVersion();
```

`WithDocumentPerVersion()` enumera lo que devuelva `DescribeApiVersions()` y registra un documento por cada versión. Accedes a `/openapi/v1.json` y `/openapi/v2.json` y obtienes exactamente las operaciones que pertenecen a cada versión, sin IDs de operación compartidos ni esquemas duplicados filtrándose entre documentos. Tanto Scalar (`app.MapScalarApiReference()`) como Swagger UI (`app.UseSwaggerUI()`) descubren los documentos automáticamente a través del mismo proveedor de descripciones de versiones de la API, así que el selector del navegador queda cableado sin esfuerzo.

## Grupos de rutas versionados

Para minimal APIs el lado de las rutas se mantiene compacto. Declaras una API versionada una vez y le cuelgas grupos por versión:

```csharp
var usersApi = app.NewVersionedApi("Users");

var usersV1 = usersApi.MapGroup("api/users").HasApiVersion("1.0");
var usersV2 = usersApi.MapGroup("api/users").HasApiVersion("2.0");

usersV1.MapGet("", () => Results.Ok(new { shape = "v1" }));
usersV2.MapGet("", () => Results.Ok(new { shape = "v2" }));
```

El nombre `Users` se convierte en el grupo de la API; `HasApiVersion` es lo que el API explorer lee para decidir a qué documento OpenAPI pertenece cada endpoint.

## Por qué importa ahora

Si arrancaste una nueva app de ASP.NET Core 9 o 10 y descartaste Swashbuckle por principio, el versionado era lo único que te jalaba de vuelta. Con `Asp.Versioning.OpenApi` 10.0.0-rc.1 esa salida de emergencia se cierra. El sufijo RC es la única razón para esperar: la superficie de la API es la que se libera, y el equipo apunta a GA junto con el tren de servicio de .NET 10. El ejemplo completo vive en [el repositorio de Sander enlazado desde la publicación](https://devblogs.microsoft.com/dotnet/api-versioning-in-dotnet-10-applications/) y vale la pena clonarlo antes de la próxima vez que vayas a escribir un transformador a mano.
