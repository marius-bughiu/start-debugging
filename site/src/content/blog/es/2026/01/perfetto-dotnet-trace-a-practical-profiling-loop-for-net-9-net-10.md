---
title: "Perfetto + dotnet-trace: un ciclo práctico de profiling para .NET 9/.NET 10"
description: "Un ciclo práctico de profiling para .NET 9 y .NET 10: captura trazas con dotnet-trace, visualízalas en Perfetto e itera sobre problemas de CPU, GC e hilos del thread pool."
pubDate: 2026-01-21
updatedDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
  - "performance"
lang: "es"
translationOf: "2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
La forma más rápida de salir del atasco con un "va lento" en .NET es dejar de adivinar y empezar a mirar una línea de tiempo. Un artículo que circula esta semana muestra un flujo limpio: capturar trazas con `dotnet-trace` y luego inspeccionarlas en Perfetto (el mismo ecosistema de visor de trazas que muchos conocen del mundo Android y Chromium): [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/).

## Por qué vale la pena sumar Perfetto a tu caja de herramientas

Si ya usas `dotnet-counters` o un profiler, Perfetto no es un reemplazo. Es un complemento:

-   Obtienes una línea de tiempo visual que vuelve mucho más fácil razonar sobre problemas de concurrencia (picos del thread pool, síntomas de contención de locks, cascadas async).
-   Puedes compartir un archivo de traza con otro ingeniero sin pedirle que instale tu IDE o tu profiler comercial.

Para apps en .NET 9 y .NET 10 esto es especialmente útil cuando intentas validar que un cambio "pequeño" no introdujo accidentalmente asignaciones extra, hilos extra o un nuevo cuello de botella de sincronización.

## El ciclo de captura (primero reproducir, luego trazar)

El truco es tratar el tracing como un ciclo, no como una acción única:

-   Haz que la lentitud sea reproducible (mismo endpoint, misma carga, mismo dataset).
-   Captura entre 10 y 30 segundos alrededor de la ventana de interés.
-   Inspecciona, formula una hipótesis, cambia una sola cosa, repite.

Esta es la secuencia mínima de captura usando la herramienta global:

```bash
dotnet tool install --global dotnet-trace

# Find the PID of the target process (pick one)
dotnet-trace ps

# Capture an EventPipe trace (default providers are usually a good starting point)
dotnet-trace collect --process-id 12345 --duration 00:00:15 --output app.nettrace
```

Terminarás con `app.nettrace`. A partir de ahí, sigue los pasos de conversión/apertura del artículo original (la ruta exacta para "abrir en Perfetto" depende de qué Perfetto UI uses y qué paso de conversión elijas).

## Qué buscar al abrir la traza

Empieza por preguntas que puedas responder en minutos:

-   **Uso de CPU**: ¿Estás CPU-bound (métodos calientes) o esperando (bloqueo, sleep, I/O)?
-   **Comportamiento del thread pool**: ¿Ves ráfagas de worker threads que se correlacionen con picos de latencia?
-   **Correlación con GC**: ¿Las ventanas de pausa coinciden con la solicitud lenta o solo con actividad de fondo?

Una vez que encuentres una ventana sospechosa, vuelve al código y aplica un cambio quirúrgico (por ejemplo: reducir asignaciones, evitar sync-over-async, quitar un lock del hot path de la solicitud o agrupar llamadas costosas).

## Un patrón pragmático: trazar en Release sin perder símbolos

Si puedes, ejecuta el camino lento en Release (más cerca de producción), pero conserva información suficiente para razonar sobre los frames. En proyectos SDK-style, los PDB se generan por defecto; para una sesión de profiling normalmente quieres rutas de salida predecibles:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Configuration>Release</Configuration>
    <DebugType>portable</DebugType>
  </PropertyGroup>
</Project>
```

Mantenlo aburrido: entrada estable, configuración estable, trazas cortas, repetir.

Si quieres los pasos detallados de Perfetto y capturas de pantalla, el artículo original es la mejor referencia para tener abierta mientras corres el ciclo: [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/).
