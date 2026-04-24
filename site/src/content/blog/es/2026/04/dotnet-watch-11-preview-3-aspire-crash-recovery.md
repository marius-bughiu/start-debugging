---
title: "dotnet watch en .NET 11 Preview 3: hosts Aspire, crash recovery, y Ctrl+C más sano"
description: "dotnet watch gana integración con Aspire app host, relanzamiento automático después de crashes, y manejo de Ctrl+C arreglado para apps desktop Windows en .NET 11 Preview 3."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "aspire"
  - "dotnet-watch"
lang: "es"
translationOf: "2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery"
translatedBy: "claude"
translationDate: 2026-04-24
---

`dotnet watch` siempre ha sido el caballo de trabajo silencioso del inner loop de .NET. Recarga tu app cuando los archivos cambian, aplica hot reload donde puede, y se mantiene fuera del camino cuando no puede. .NET 11 Preview 3 (lanzado el 14 de abril de 2026) empuja a la herramienta hacia adelante en tres puntos de dolor específicos: correr apps distribuidas, sobrevivir crashes, y lidiar con Ctrl+C en targets desktop Windows.

## Los app hosts Aspire ahora se ven limpiamente

Hasta Preview 3, correr un app host Aspire bajo `dotnet watch` era torpe. Aspire orquesta múltiples proyectos hijos, y el watcher no entendía ese modelo, así que los cambios de archivo o reconstruían solo el host o forzaban toda la topología a reiniciar desde cero.

Preview 3 cablea `dotnet watch` en el app model de Aspire directamente:

```bash
cd src/MyApp.AppHost
dotnet watch
```

Edita un archivo en `MyApp.ApiService` y el watcher ahora aplica el cambio solo a ese servicio, manteniendo vivo el resto de la topología Aspire. El dashboard se mantiene arriba, los containers dependientes se mantienen corriendo, y pierdes segundos de boot time en cada cambio en lugar de segundos por proyecto.

Para soluciones microservice-heavy esta es la diferencia entre `dotnet watch` siendo un nice-to-have y siendo el modo default de trabajar.

## Relanzamiento automático después de un crash

El segundo titular es crash recovery. Anteriormente, cuando tu app vigilada lanzaba una excepción no manejada y moría, `dotnet watch` se quedaba parqueado en el mensaje de crash y esperaba restart manual. Si tu siguiente keystroke guardaba un fix, nada pasaba hasta que le dieras Ctrl+R.

En Preview 3 ese comportamiento se invierte. Toma un endpoint que explota:

```csharp
app.MapGet("/", () =>
{
    throw new InvalidOperationException("boom");
});
```

Deja a la app crashear una vez, guarda un fix, y `dotnet watch` se relanza automáticamente en el siguiente cambio de archivo relevante. No pierdes el feedback loop solo porque la app decidió salir non-zero. El mismo comportamiento cubre crashes en startup, que solían dejar al watcher atascado antes de que hot reload pudiera siquiera adjuntarse.

Esto compone bien con el manejo "rude edit" watch-wide que ya existe: hot reload todavía intenta primero, hace fallback a un restart en edits no soportados, y ahora hace fallback a un restart después de un crash también. Tres rutas, un outcome consistente: la app vuelve.

## Ctrl+C en apps desktop Windows

El tercer fix es pequeño pero era crónico: Ctrl+C en `dotnet watch` para apps WPF y Windows Forms. Anteriormente podía dejar al proceso desktop huérfano, desconectado del watcher, o colgado dentro de una ventana modal. Preview 3 re-conecta el manejo de señales para que Ctrl+C derribe tanto al watcher como al proceso desktop en orden, sin entradas zombie `dotnet.exe` apilándose en Task Manager.

Si corres un shell WPF bajo `dotnet watch`:

```bash
dotnet watch run --project src/DesktopShell
```

Pega Ctrl+C una vez y tanto el shell como el watcher salen limpiamente. Suena básico, y lo es, pero el comportamiento anterior era la razón principal de que muchos equipos evitaran `dotnet watch` en proyectos desktop enteramente.

## Por qué estos tres juntos importan

Cada cambio por sí solo es modesto. Combinados, mueven `dotnet watch` de un helper por proyecto a un arnés session-wide que puede hospedar una topología Aspire todo el día, absorber el crash ocasional, y limpiarse después de sí mismo cuando terminas. El inner loop se volvió notablemente menos frágil.

Las release notes están en el [Blog de .NET](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) y la sección del SDK vive en [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk).
