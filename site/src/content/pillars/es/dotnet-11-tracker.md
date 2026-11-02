---
title: "El tracker de .NET 11"
description: "Estado de .NET 11 RC3, soporte, cambios del runtime y comprobaciones de migración, con guías de pruebas de integración, EF Core y logging de peticiones."
tagline: "Un marcador para todo el ciclo de .NET 11."
pubDate: 2026-04-18
updatedDate: 2026-11-02
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
lang: "es"
translationOf: "dotnet-11-tracker"
---

A 2 de noviembre de 2026, **.NET 11 RC3** es la candidata vigente. Microsoft la publicó el 25 de octubre como [actualización de seguridad fuera de ciclo](https://devblogs.microsoft.com/dotnet/dotnet-october-2026-oob-security-updates/). Su [política de soporte](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) indica el estado go-live y el período de soporte. .NET 11 es una versión STS (Standard Term Support). Al migrar desde .NET 8 LTS, ten en cuenta esa diferencia al planear la siguiente actualización.

**Corrección, 2 de noviembre de 2026.** La versión inglesa anterior presentaba RC2 como la más reciente y llamaba LTS a LTS al paso de .NET 8 a 11. El índice ahora usa etiquetas específicas de .NET 11 para que un artículo sobre otra versión no aparezca solo por llevar una etiqueta general de .NET.

## Novedades del release y el runtime

Para RC2, consulta [lectura incremental de CBOR](/es/2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally/). RC1 incluye [imágenes de contenedor reproducibles](/es/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/), [señales de procesos](/es/2026/09/dotnet-11-rc-1-process-signal-exit-status/) y [renovación de autenticación en SignalR](/es/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/). Para el runtime, revisa [desvirtualización de métodos genéricos](/es/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/), [convenciones de llamada de structs](/es/2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet/) y [compatibilidad de CPU](/es/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/).

## Planear y validar la actualización

Empieza con la [lista de migración desde .NET 8](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) o la [guía para .NET Framework 4.8](/es/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/). En soluciones con varios proyectos, revisa la [selección del SDK](/es/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/) y la [gestión central de paquetes](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/). Si cambias de runner, consulta [Microsoft.Testing.Platform](/es/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), [código de salida 5](/es/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/) y [fallback a VSTest](/es/2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform/).

Usa [WebApplicationFactory y Testcontainers](/es/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) para decidir qué comportamiento HTTP y de base de datos debe cubrir la prueba. Para cambios en datos guardados, la [conversión de enum a string](/es/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/) explica por qué las cadenas numéricas y los nombres pueden dar resultados de consulta diferentes. Para seguir peticiones autenticadas, consulta [ID de usuario en los logs](/es/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/).

## Índice temático

El índice cronológico selecciona etiquetas de versión de .NET 11. Para una referencia específica, continúa con [EF Core 11](/es/pillars/efcore-11-cheat-sheet/) o [C# 14](/es/pillars/csharp-14-features/).
