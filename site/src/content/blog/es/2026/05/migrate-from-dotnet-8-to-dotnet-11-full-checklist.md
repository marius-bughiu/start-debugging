---
title: "Migrar de .NET 8 a .NET 11: la lista de verificación completa"
description: "Planifique la migración de .NET 8 con el estado actual de .NET 11 RC3, SDK exacto, compatibilidad, despliegue y rollback."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "es"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Corrección — 2 de noviembre de 2026:** .NET 11 se describía incorrectamente como una versión LTS ya publicada. También se corrigen selección del SDK, paquetes, hosting, serialización, consultas EF, bloqueos y rollback. Las afirmaciones anteriores sobre resultados de migraciones no tenían pruebas registradas.

El soporte de .NET 8 termina el **10 de noviembre de 2026**. La [política actual](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) identifica .NET 10 como LTS y .NET 11 RC3 como versión preliminar go-live. .NET 11 es una línea STS. Para un destino LTS ya publicado, evalúe .NET 10. Si necesita .NET 11, acepte explícitamente su estado actual y planifique la siguiente actualización. Actualizar el SDK no actualiza aplicaciones ya desplegadas.

## 1. Registrar la referencia y elegir el SDK

Registre runtime desplegado, SDK, sistema operativo, dependencias, resultados de pruebas y comportamiento representativo. Una referencia verde ayuda a detectar regresiones, pero no demuestra que cualquier fallo posterior sea causado por la migración.

```bash
dotnet --info
dotnet --list-sdks
dotnet --version
dotnet list package --include-transitive
dotnet test -c Release
```

Ejecute los comandos en el directorio de la solución con el SDK previsto. La [selección del SDK](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) es independiente del framework objetivo. Para evaluar la versión completa RC3 de la [página de descarga](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), utilice este `global.json`:

```json
{
  "sdk": {
    "version": "11.0.100-rc.3.26522.148",
    "rollForward": "disable",
    "allowPrerelease": true
  }
}
```

`disable` exige ese SDK exacto; `latestFeature` permite bandas posteriores. Instale el SDK elegido también en CI. Se comprobó esta versión RC3 contra metadatos publicados, pero no se instaló ni ejecutó para el artículo. Actualícela deliberadamente al cambiar de versión.

## 2. Cambiar el destino y revisar cada dependencia

La estructura mínima de un proyecto web es:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Es una definición para .NET 11, no un proyecto probado aquí en .NET 11. Deje la versión del lenguaje en el valor predeterminado del SDK/TFM salvo una razón concreta. C# 14 corresponde a .NET 10; no es la nueva versión de lenguaje de .NET 11.

**No actualice todos los paquetes `Microsoft.*` a versión 11.** Cada producto tiene su propia línea. Compruebe frameworks, dependencias, proveedores y estado de publicación. Alinee paquetes EF Core, proveedor, paquete de diseño y herramientas según su documentación. Revise `Directory.Packages.props` si usa administración centralizada. Un paquete `net8.0` puede seguir siendo compatible; NuGet no prefiere automáticamente un recurso .NET Standard antiguo porque el destino sea más nuevo.

## 3. Revisar los cambios de cada versión intermedia

Lea las listas de [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/compatibility/9.0), [.NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10.0) y [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11), además de las notas de frameworks y proveedores. La lista de .NET 11 sigue explícitamente en elaboración.

- **BinaryFormatter:** Desde .NET 9, la implementación incorporada lanza una excepción; los tipos de API siguen existiendo. Prefiera otro formato. La [guía de migración](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) explica cómo leer NRBF sin construir tipos serializados arbitrarios. Convertir no exige necesariamente ejecutar la aplicación antigua en .NET 8.
- **Hosting:** `WebHostBuilder`, `IWebHost` y `WebHost` se [marcaron obsoletos en .NET 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/webhostbuilder-deprecated?view=aspnetcore-10.0). Eso no demuestra que se haya eliminado todo código `IWebHostBuilder` o `ConfigureWebHostDefaults`. Prefiera `WebApplication.CreateBuilder` para código nuevo y atienda diagnósticos reales.
- **Consultas EF:** Para SQL Server, EF8 introdujo parámetros JSON para colecciones; [EF10 usa parámetros escalares por defecto](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection). Inspeccione SQL y planes con su proveedor real. Añadir `ToList()` indiscriminadamente puede llevar trabajo a memoria; no es una solución universal.
- **Serialización y compilación:** Pruebe contratos JSON reales, fechas, números, enums y polimorfismo. Investigue diagnósticos concretos, incluidas conversiones span, sin asumir que toda sobrecarga span gana a una de array.
- **Bloqueos:** `System.Threading.Lock` y Monitor son reentrantes. Un `Lock` con tipo estático usa un mecanismo distinto de una referencia convertida a `object`; no los mezcle para el mismo estado protegido. Cambiar bloqueos es opcional.
- **Servicios alojados:** Azure Functions tiene su propia [matriz de soporte](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide#supported-versions). En esta revisión, el máximo destino isolated worker es .NET 10; el soporte in-process termina el 10 de noviembre de 2026. La disponibilidad del SDK no prueba soporte de .NET 11.

## 4. Verificar el artefacto desplegado

Este `Program.cs` completo ofrece un endpoint de humo. No configura autenticación, controladores ni base de datos de producción:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

El ejemplo se compiló, publicó y consultó correctamente en .NET 8.0.33 y 10.0.10. `--self-contained false` requiere un runtime compatible en el host. Para un despliegue autocontenido, elija un RID real y `--self-contained true`; pruebe el resultado en el SO de destino. `/health` no aparece automáticamente en cualquier proyecto.

Pruebe también autenticación, autorización, contratos de lectura/escritura, transacciones, tareas en segundo plano y rollback en staging. Mida una carga acordada. Con trimming o AOT, resuelva advertencias concretas y ejecute el resultado publicado; las anotaciones no hacen compatible cualquier generación dinámica de código con Native AOT.

## 5. Mantener un rollback compatible

Conserve el artefacto anterior y su configuración. Esquema, datos persistidos, mensajes y estado de autenticación determinan si ambas versiones pueden coexistir. La primera escritura no impide automáticamente volver atrás y cambiar SDK no genera una migración de base de datos. Use cambios compatibles y ensaye la reversión del tráfico antes del corte.

**Límites de verificación:** No se ejecutó una migración .NET 11, actualización EF/base de datos, despliegue Azure ni comparación de rendimiento. El ejemplo portable y algunas correcciones se probaron en .NET 8/10; la información específica de versión se contrastó con documentación primaria.

## Otras fuentes primarias

- [System.Threading.Lock](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# 14 span overload resolution](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
