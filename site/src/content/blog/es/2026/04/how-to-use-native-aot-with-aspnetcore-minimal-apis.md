---
title: "Cómo usar Native AOT con APIs mínimas de ASP.NET Core"
description: "Configura Minimal APIs para Native AOT con metadatos JSON generados. Builders, herramientas de publicación, advertencias y límites de funciones."
pubDate: 2026-04-27
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "es"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Native AOT compila la aplicación a código nativo al publicarla. Puede cambiar el arranque, tamaño y uso de memoria, pero depende de la aplicación y del destino. No convierte todas las funciones y dependencias de ASP.NET Core en compatibles.

**Corrección — 2 de noviembre de 2026:** la guía anterior exigía `CreateSlimBuilder`, excluía todos los servidores SignalR, vinculaba la generación a `Program.cs` y exageraba restricciones de JSON y globalización. El ejemplo sustituto usa .NET 10; no afirma ejecución en .NET 11.

## Aplicación con metadatos JSON explícitos

Crea el proyecto `MyApi` con este archivo:

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

Usa este `Program.cs`:

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

`PublishAot` activa el análisis AOT y la generación de delegates de petición en este proyecto Web SDK. El contexto JSON aporta metadatos de los tipos raíz utilizados. Registra otras raíces y tipos polimórficos según los contratos; registrar `object` no cubre cualquier tipo posible en ejecución.

El generador procesa los archivos del proyecto. Mover una extensión de rutas fuera de `Program.cs` no causa por sí solo incompatibilidad. Una biblioteca separada necesita referencias ASP.NET Core y soporte del generador adecuados; una propiedad aislada no vuelve compatible cualquier código.

## Publicar para una plataforma concreta

```sh
# Use the RID and native toolchain for your deployment target.
# This command is for an Apple Silicon Mac:
dotnet publish -c Release -r osx-arm64 -o ./publish
./publish/MyApi --urls http://127.0.0.1:5080
# Replace MyApi with your project's executable name.
```

Instala las herramientas nativas necesarias. La publicación Native AOT entre sistemas operativos distintos no está admitida de forma general; usa un host o contenedor adecuado. Autocontenido significa que no hace falta instalar el runtime administrado por separado, no que el ejecutable sea completamente estático o independiente de bibliotecas del sistema.

Ejecuta el binario publicado y prueba endpoints, serialización, autenticación y errores. `dotnet run` normalmente usa JIT y no sustituye esta prueba. Revisa todas las advertencias de trimming y AOT; no hacen fallar la publicación automáticamente salvo que se configuren como errores. `IL2026` trata de requisitos de trimming; `IL3050`, de código dinámico. Atributos como `RequiresDynamicCode` propagan requisitos, no reparan incompatibilidades.

## Builder, JSON y globalización

`CreateSlimBuilder` inicia menos funciones y es una buena base, no una API obligatoria. `CreateBuilder` es posible si las funciones y dependencias elegidas son compatibles. El builder reducido omite HTTPS y HTTP/3 por defecto: agrega el soporte Kestrel requerido o termina TLS en un proxy de confianza. Configurar endpoints no agrega por sí solo protocolos omitidos.

Agregar un resolver generado no desactiva reflexión en todos los modos. Native AOT necesita metadatos adecuados; tipos JSON desconocidos pueden fallar en ejecución. `Results.Json(value)` y `ReadFromJsonAsync<T>()` pueden utilizar opciones configuradas y metadatos generados; no están prohibidos por definición. Las sobrecargas con `JsonTypeInfo<T>` hacen explícito el contrato.

`InvariantGlobalization` cambia el comportamiento, no es un interruptor de advertencias AOT. Si necesitas culturas, conserva su soporte y proporciona las dependencias del destino. No actives el modo invariable solo para silenciar advertencias ni supongas que mantiene toda la semántica cultural.

## Comprobar funciones por versión

Los controladores MVC y Razor Pages no son una opción general de Native AOT en la matriz documentada. SignalR es diferente: .NET 9 introdujo soporte para cliente y servidor, con restricciones y requisitos de generación JSON documentados. No traslades una exclusión antigua a versiones nuevas.

El acceso a datos también requiere revisión por proveedor. EF Core AOT depende de la versión y de las consultas; Dapper ordinario no es automáticamente seguro por ser más pequeño. Publica y ejecuta las dependencias concretas.

Para organizar handlers compatibles, consulta [módulos con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Fuentes

- [ASP.NET Core Native AOT support](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [.NET Native AOT deployment and prerequisites](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [System.Text.Json source generation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [.NET 9 SignalR Native AOT support and limitations](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-9.0?view=aspnetcore-9.0#signalr-supports-trimming-and-native-aot)
