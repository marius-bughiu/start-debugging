---
title: "El dashboard de Aspire 13.6 conserva tus últimas diez ejecuciones en SQLite"
description: "Aspire 13.6.0 hace persistente el dashboard: las instantáneas de recursos y la telemetría se guardan en una base de datos SQLite, el AppHost conserva hasta diez ejecuciones por aplicación y las ejecuciones completadas se pueden consultar en modo de solo lectura. Así funcionan los modos Run, Resume y None y cómo configurar el dashboard independiente."
pubDate: 2026-09-30
tags:
  - "aspire"
  - "dotnet"
  - "opentelemetry"
  - "observability"
lang: "es"
translationOf: "2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs"
translatedBy: "claude"
translationDate: 2026-09-30
---

[Aspire 13.6.0](https://github.com/microsoft/aspire/releases/tag/v13.6.0) se lanzó el 2026-09-29, y el cambio que notarás primero es que el dashboard ya no lo olvida todo cuando detienes el AppHost. Hasta la versión 13.5, el dashboard guardaba la telemetría en memoria: si presionabas Ctrl+C después de reproducir un error, la traza que querías desaparecía. En 13.6 el dashboard almacena las instantáneas de recursos y la telemetría en una base de datos SQLite con control de versiones, y un selector en el encabezado te permite alternar entre la ejecución actual y las anteriores.

## Qué hace el AppHost por defecto

Cuando el dashboard lo inicia un AppHost, usa la persistencia **Run** sin ninguna configuración adicional. Cada `aspire run` se convierte en una entrada independiente, y se conservan hasta diez ejecuciones por aplicación. Las ejecuciones completadas son de solo lectura, así que puedes abrir la ejecución previa a tu corrección y comparar sus recursos, registros estructurados, trazas y métricas con los de la ejecución actual, lado a lado.

No cambia nada en el código de tu AppHost. Es el mismo archivo que tenías ayer:

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithReference(cache);

builder.Build().Run();
```

Por defecto, los datos se guardan en `<ASPIRE_HOME>/dashboard`, particionados por el nombre de la aplicación.

## Búferes más grandes, pero con límite

La misma versión sube a 100 000 cada uno los límites predeterminados de mensajes de registro de consola, registros estructurados y trazas. Siguen siendo búferes circulares, no un archivo histórico: cuando se supera un límite, las entradas más antiguas se descartan. Si necesitas más o menos, se aplican las opciones de configuración existentes, por ejemplo `Dashboard:TelemetryLimits:MaxLogCount`, `Dashboard:TelemetryLimits:MaxTraceCount` y `Dashboard:Frontend:MaxConsoleLogCount`, o las variables de entorno al estilo `DASHBOARD__TELEMETRYLIMITS__MAXLOGCOUNT`.

## Dashboard independiente: None, Run, Resume

El dashboard independiente conserva su comportamiento anterior por defecto: persistencia **None**, con una base de datos temporal que se elimina cuando el dashboard se detiene. Para conservar los datos entre reinicios, usa **Resume** con un nombre de aplicación estable:

```bash
aspire dashboard run --application-name my-app --persistence Resume
```

En un contenedor, monta el directorio de datos en un volumen y pasa los mismos tres valores cada vez:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  -v aspire-dashboard-data:/data \
  -e ASPIRE_DASHBOARD_DATA_DIRECTORY=/data \
  -e ASPIRE_DASHBOARD_APPLICATION_NAME=my-app \
  -e ASPIRE_DASHBOARD_PERSISTENCE_MODE=Resume \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
```

Si el nombre de la aplicación, el directorio o el modo cambian entre reinicios, obtienes una base de datos nueva en lugar de tu historial. El nombre de la aplicación también define el ámbito de los nombres de las cookies de autenticación y antiforgery del dashboard, así que elige uno por aplicación y mantenlo.

## Trata la base de datos como un secreto

Las notas de la versión son directas al respecto: el archivo SQLite puede contener valores sensibles de recursos y telemetría, y no tiene una capa propia de cifrado ni de autorización. En Unix los permisos del archivo se restringen al propietario; en Windows, las ACL no se establecen por ti. Las variables de entorno que inyectas en los recursos, las cadenas de conexión en las instantáneas de recursos y todo lo que tu aplicación registra quedan ahora en disco cuando termina la ejecución. No montes ese volumen en ningún lugar compartido y no incluyas `ASPIRE_HOME` en la imagen de un dev container.

El propio dashboard también cambió por dentro: ahora se distribuye como Native AOT y pasó a Fluent UI v5 con un riel de navegación plegable. Las terminales que pertenecen al AppHost ahora se abren en un panel acoplado del dashboard, lo que amplía el [trabajo de `WithTerminal` de la versión 13.5](/es/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/), y 13.6 añade encima clientes de base de datos opcionales con `WithRepl()`. La lista completa, incluidos los cambios importantes, está en [Novedades de Aspire 13.6](https://aspire.dev/whats-new/aspire-13-6/).
