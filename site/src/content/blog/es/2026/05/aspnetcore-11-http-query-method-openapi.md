---
title: "ASP.NET Core en .NET 11 Preview 4 le ensena a OpenAPI el metodo HTTP QUERY"
description: ".NET 11 Preview 4 hace que la generacion de OpenAPI en ASP.NET Core reconozca HTTP QUERY como una operacion de primera clase en OpenAPI 3.2, con un respaldo elegante para documentos 3.0 y 3.1."
pubDate: 2026-05-24
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "http"
  - "minimal-apis"
lang: "es"
translationOf: "2026/05/aspnetcore-11-http-query-method-openapi"
translatedBy: "claude"
translationDate: 2026-05-24
---

[.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), publicado el 2026-05-12, incluyo un cambio pequeno pero con vision de futuro en ASP.NET Core: la generacion de documentos OpenAPI ahora reconoce `QUERY` como un tipo de operacion HTTP conocido. Si nunca has oido hablar del metodo QUERY, ese es justamente el punto de este articulo. Es un metodo estandar propuesto que resuelve una tension real que lleva anos molestando a los endpoint de busqueda.

## Por que un nuevo verbo para buscar

Una solicitud de busqueda quiere dos cosas que los verbos existentes no pueden darle juntas. Quiere ser segura e idempotente, como `GET`, para que las cachés y los proxies la traten con sensatez y un reintento nunca mute nada. Y quiere llevar un cuerpo de solicitud estructurado, como `POST`, porque un filtro serio (clausulas booleanas anidadas, limites geograficos, un vector mas predicados sobre metadatos) no cabe limpiamente en una cadena de consulta y choca con los limites de longitud de la URL.

Los equipos han tapado esto durante una decada enviando `POST /search` con un cuerpo JSON y fingiendo en silencio que es idempotente. Eso funciona, pero le miente a cada caché e intermediario del camino. El metodo `QUERY` de la IETF es la version honesta: semantica de `GET` (segura, idempotente, almacenable en caché) mas un cuerpo de solicitud. Preview 4 no inventa el metodo, le ensena al pipeline de OpenAPI a describirlo correctamente.

## Mapear un endpoint QUERY

El enrutamiento ya admitia verbos arbitrarios, asi que no hay ningun atributo nuevo que aprender. Mapeas un endpoint QUERY con la sobrecarga existente de `MapMethods`:

```csharp
app.MapMethods("/search", ["QUERY"], (SearchRequest request) =>
    SearchService.Run(request));
```

La parte nueva es lo que sale del generador de documentos OpenAPI. QUERY solo se convirtio en un concepto de primera clase en OpenAPI 3.2, asi que tienes que optar por esa version de la especificacion:

```csharp
builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_2;
});
```

Con 3.2 seleccionado, el endpoint anterior se emite como una operacion `query` correcta en el path item. Si todavia estas fijado a OpenAPI 3.0 o 3.1, que son anteriores al metodo, el generador no descarta el endpoint en silencio. Recurre a una extension `x-oai-additionalOperations` para que las herramientas que entienden la extension aun puedan ver la operacion, y las que no, al menos no se atraganten.

## Conviene saberlo antes de llevarlo a produccion

QUERY sigue siendo un metodo propuesto, asi que el soporte entre navegadores, clientes HTTP, CDN y proxies corporativos es desigual. Este cambio se trata de documentar con precision un endpoint, no de prometer que cada intermediario lo enrutara. Para APIs de busqueda internas de servicio a servicio donde controlas ambos extremos, encaja limpiamente hoy. Para APIs publicas, tratalo como preparacion para el futuro y manten una ruta `POST` hasta que el ecosistema se ponga al dia.

El trabajo aterrizo en [dotnet/aspnetcore #65714](https://github.com/dotnet/aspnetcore/pull/65714). Es una linea silenciosa en una preview silenciosa, pero es el tipo de fontaneria que decide si QUERY de verdad llega o se queda como un borrador para siempre.
