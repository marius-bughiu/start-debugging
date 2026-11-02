---
title: "WebApplicationFactory vs Testcontainers para pruebas de integración en ASP.NET Core"
description: "Elige la configuración para pruebas de integración ASP.NET Core según lo que debas verificar: routing HTTP, motor de base de datos o imagen publicada."
pubDate: 2026-08-07
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "es"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

`WebApplicationFactory<TEntryPoint>` inicia la aplicación bajo prueba. Testcontainers inicia dependencias como PostgreSQL o SQL Server. Pueden combinarse. Elige la configuración según el comportamiento que debe observar la aserción.

**Corrección, 2 de noviembre de 2026.** Una restricción de ruta `:int` que no coincide normalmente produce 404. Antes figuraba 400 y se daba a entender que solo una app en contenedor podía usar un socket real. El ejemplo HTTP se comprobó con ASP.NET Core 10.0.10 y SDK 10.0.302. Se retiraron tiempos de fixtures sin un benchmark publicado.

## Elegir el alcance

| Qué debe demostrar la prueba | Configuración | Qué verificar |
| --- | --- | --- |
| Routing, autorización y serialización | Factory con `TestServer` predeterminado y servicios de prueba | Estado, cabeceras y cuerpo |
| Comportamiento del motor de producción | Factory más el mismo motor en Testcontainers | Restricciones, migraciones, traducción de consultas y concurrencia |
| La imagen publicada arranca | Construir y ejecutar la imagen con sus servicios | Dockerfile, punto de entrada, configuración y red |

La factory usa por defecto un servidor HTTP dentro del proceso. Desde .NET 10, `UseKestrel()` permite usar Kestrel y un puerto real. Llámalo antes de inicializar la factory. TLS y HTTP/2 requieren configuración compatible en servidor y cliente. Prueba el contenedor cuando la propia imagen sea el objeto de la prueba.

## Una aserción HTTP sin base de datos

```csharp
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders/{id:int}", (int id) => TypedResults.Ok(id));
app.MapGet("/bound/{id}", (int id) => TypedResults.Ok(id));
app.Run();
```

`GET /orders/7` devuelve 200. `GET /orders/abc` no cumple la restricción y devuelve 404 porque ninguna ruta coincide. `GET /bound/abc` sí coincide, pero enlazar `abc` al parámetro entero falla con 400. Estas pruebas usaron Kestrel en loopback. Para configurar la factory, reemplazar un servicio o probar autenticación, consulta [la guía de WebApplicationFactory](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

## Usar el proveedor apropiado para pruebas de datos

SQLite aplica restricciones como unicidad, pero `VARCHAR(16)` por sí solo no limita la longitud a 16 caracteres. PostgreSQL rechaza un valor con caracteres no blancos que exceden `varchar(16)`. Una prueba válida en SQLite no demuestra esa regla de PostgreSQL. Lo mismo ocurre con SQL específico, migraciones y [concurrencia con rowversion](/es/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

Para un endpoint con SQL Server, inicia el contenedor del motor, aplica las migraciones, configura la conexión de la factory y comprueba el resultado. La [guía de Testcontainers para SQL Server](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) explica la preparación. Las pruebas puramente HTTP pueden prescindir de Docker.

## Mantener fixtures repetibles

Comparte un contenedor solo si los datos permanecen aislados. Usa un esquema o base por grupo, o un reinicio explícito de datos entre pruebas. Al medir, separa la descarga de imagen, arranque, creación del esquema y peticiones. Una imagen local en caché y un worker CI nuevo tienen costes distintos.

## Fuentes

- [ASP.NET Core integration tests](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests?view=aspnetcore-10.0)
- [Route constraints](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing?view=aspnetcore-10.0#route-constraints)
- [WebApplicationFactory.UseKestrel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel?view=aspnetcore-10.0)
- [Testcontainers for .NET](https://dotnet.testcontainers.org/)
- [SQLite VARCHAR limits](https://sqlite.org/faq.html#q9) · [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html)
