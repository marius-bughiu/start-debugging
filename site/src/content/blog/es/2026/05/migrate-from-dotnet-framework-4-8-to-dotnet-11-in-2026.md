---
title: "Migrar de .NET Framework 4.8 a .NET 11 en 2026"
description: "Planifique la migración de .NET Framework 4.8 con soporte correcto, límites incrementales ASP.NET, dependencias, configuración y rollback."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "es"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Corrección — 2 de noviembre de 2026:** Se corrigen el estado y soporte de .NET 11, el ciclo de vida de Framework, la configuración, serialización, herramientas y despliegue. Se eliminaron estimaciones de duración, ahorro de memoria y supuestas experiencias sin evidencia.

Pasar de .NET Framework 4.8 a .NET moderno puede exigir otro host y cambios en bibliotecas, despliegue y contratos de datos. No es una actualización del runtime in situ. Identifique primero el motivo y qué parte puede migrar de forma independiente.

En esta revisión, [.NET 11 RC3 es una versión preliminar go-live](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), .NET 11 pertenece a STS y .NET 10 es la opción LTS publicada. [El soporte de Framework sigue al producto Windows subyacente](https://learn.microsoft.com/en-us/lifecycle/faq/dotnet-framework); no existe una única fecha final de Framework 4.8 aplicable a todas las instalaciones de Windows 10. Compruebe el SO real y su versión compatible de Framework.

## Inventariar antes de cambiar proyectos

Compile y pruebe la aplicación existente en su entorno Windows compatible. Mantenga disponibles paquetes de desarrollo/referencia y herramientas durante la migración. Registre autenticación, sesiones, integraciones Windows, bibliotecas nativas, tareas programadas, proveedores y formatos persistidos. La compatibilidad depende de APIs y recursos, no de una regla que invalide todo paquete `net48`.

La [documentación de Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) ya lo marca como obsoleto y remite al agente de modernización de GitHub Copilot. La ayuda automatizada es opcional; revise y pruebe sus cambios. Un antiguo comando de instalación sin versión no garantiza compatibilidad con .NET 11.

Separe la limpieza del formato del proyecto de la migración del runtime cuando sea posible. SDK-style no convierte `System.Web`, hosting WCF, COM ni tareas MSBuild personalizadas. Mantenga una referencia funcional y migre bibliotecas hoja antes de sus consumidores.

## Elegir el límite de migración

| Dependencia existente | Trabajo previsto |
| --- | --- |
| ASP.NET MVC 5 / Web API 2 | Adaptar rutas, filtros, binding, autenticación, sesiones y hosting |
| Web Forms / System.Web | Mantener tras un límite incremental o sustituir UI; ASP.NET Core no ejecuta Web Forms |
| Servidor WCF | Evaluar CoreWCF para funciones/bindings reales o rediseñar el contrato |
| Cliente WCF | Revisar paquetes System.ServiceModel y requisitos de seguridad |
| EF6 | Verificar runtime/proveedor modernos; planificar EF Core por separado |
| WPF / WinForms | Objetivos Windows y comprobación de controles, COM, código nativo y despliegue |
| AppDomains adicionales / Remoting / CAS | Rediseñar carga, comunicación y aislamiento |

La [guía de ASP.NET](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/?view=aspnetcore-10.0) admite migración incremental. Mover rutas detrás de un proxy permite mantener la aplicación antigua funcionando. Una migración parcial es válida cuando autenticación, rutas, propiedad de datos y rollback se gestionan deliberadamente.

[CoreWCF](https://github.com/CoreWCF/CoreWCF) no garantiza equivalencia de todas las funciones o contratos WCF. Pruebe bindings y autenticación reales. [EF6 admite .NET moderno desde 6.3](https://learn.microsoft.com/en-us/ef/ef6/what-is-new/); elija y pruebe una versión/proveedor compatible actual en lugar de tratar 6.5.0 como mínimo universal. EF Core no es un reemplazo directo de EF6.

## Empezar por una parte pequeña y funcional

La base de un proyecto ASP.NET Core para evaluar .NET 11 es:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Use un SDK instalado y seleccionado explícitamente, con paquetes compatibles. La [lista de .NET 8 a 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) muestra el pin RC3 actual. Un proyecto de escritorio necesita su TFM Windows y ajustes correspondientes; no cambie todos a `Microsoft.NET.Sdk.Web`.

Este `Program.cs` completo es una prueba de humo, no una aplicación migrada:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

Se compiló, publicó y consultó en .NET 8 y 10 durante la corrección. Una aplicación MVC debe registrar controladores antes de mapearlos. La autenticación necesita un esquema y servicios reales; añadir `UseAuthentication()` no migra Forms Authentication.

## Mantener la semántica de configuración y datos

Un pequeño `appsettings.json`:

```json
{
  "Migration": {
    "MaxRetries": 3
  }
}
```

El [proveedor JSON de configuración no distingue mayúsculas en claves](https://learn.microsoft.com/en-us/dotnet/core/extensions/configuration-providers). No lo confunda con reglas generales de serialización JSON. Revise precedencia y almacenamiento de secretos. El proveedor XML no reproduce automáticamente todas las secciones de `app.config` ni binding redirects. `System.Configuration.ConfigurationManager` puede ser una opción de compatibilidad para APIs admitidas; eliminar todos sus usos no es obligatorio. `web.config` sigue siendo relevante con IIS.

La implementación incorporada de `BinaryFormatter` lanza excepciones desde .NET 9, aunque el tipo permanece. Use un serializador compatible o evalúe el [lector NRBF](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) para extraer datos sin instanciar tipos arbitrarios codificados. No es obligatorio ejecutar el antiguo deserializador inseguro en Framework 4.8.

`AssemblyLoadContext` permite cargar y descargar cooperativamente ensamblados; no reproduce el aislamiento de seguridad de AppDomain. Referencias, código activo y eventos pueden impedir la descarga. Un ciclo de GC no demuestra éxito. Para código no confiable, use una frontera adecuada de proceso/contenedor y permisos.

Mantenga la validación de certificados. Ante fallos TLS, investigue certificado, hostname, cadena de confianza, configuración SQL y plataforma. No acepte todos los certificados como solución. Pruebe formatos/culturas y contratos concretos en vez de asumir un cambio general de parsing en .NET 11.

## Desplegar y ensayar rollback

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

El comando publica explícitamente una aplicación dependiente del framework. Un despliegue autocontenido requiere `--self-contained true` y un RID adecuado; no es la consecuencia automática de `dotnet publish`. Conserve CI Windows para los proyectos Framework restantes y pruebe el artefacto moderno en la plataforma real.

Pruebe accesos denegados además de solicitudes correctas, sesiones, escrituras, mensajes, tareas e integración de escritorio. Mantenga el despliegue antiguo disponible, use cambios de datos/esquema compatibles y ensaye volver el tráfico. Rollback requiere aplicación y configuración anteriores, no solo reinstalar el redistribuible.

**Límites de verificación:** No se probó una aplicación Windows/Framework, SDK .NET 11, servicio WCF, migración EF ni despliegue productivo. El endpoint portable y las claves JSON se verificaron en .NET 8 y 10. Estime esfuerzo y rendimiento a partir de una parte representativa propia.

## Otras fuentes primarias

- [AssemblyLoadContext](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext)
- [.NET Framework technologies unavailable on .NET](https://learn.microsoft.com/en-us/dotnet/core/porting/net-framework-tech-unavailable)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
